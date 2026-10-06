import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageId, SessionId, TimestampMs } from "@chili/protocol";
import { ObservableEventStore } from "./observable-event-store.js";
import { SqliteEventStore } from "./sqlite-event-store.js";
import type { CreateChildSessionInput } from "./types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const rootId = "session_root" as SessionId;
const childId = "session_child" as SessionId;
const trusted = { sessionAccess: "child" as const };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chili-agents-"));
  const path = join(root, "store.sqlite");
  const store = new SqliteEventStore(path);
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await store.append({ id: "created", type: "session.created", sessionId: rootId, time: Date.now() as TimestampMs, payload: { sessionId: rootId, cwd: root } });
  expect(store.claimSessionRun({ sessionId: rootId, claimId: "parent_claim", sessionAccess: "root", time: Date.now(), leaseDurationMs: 60_000 }).status).toBe("claimed");
  const input: CreateChildSessionInput = {
    sessionId: childId, parentSessionId: rootId, name: "research", cwd: root,
    policy: { allowedTools: ["read", "code_mode"], writeScope: [], executeScope: [] },
    initialInput: { submissionId: "initial", inputId: "input_initial", mode: "start", payload: JSON.stringify({ sessionId: childId, text: "Read the source" }), text: "Read the source", source: `agent:${rootId}` },
    maxChildren: 1, maxDepth: 1, runClaim: { sessionId: rootId, claimId: "parent_claim" },
  };
  return { path, store, input };
}

test("Agent creation commits identity and its first durable input exactly once", async () => {
  const { store, input } = await fixture();
  const observable = new ObservableEventStore(store);
  const observed: string[] = [];
  observable.subscribe((event) => observed.push(event.type));
  const created = await observable.createChildSession(input);
  expect(created.session.agent).toEqual({ parentSessionId: rootId, name: "research", path: "/root/research", policy: input.policy });
  expect(created.input.inputId).toBe("input_initial");
  expect(created.input.state).toBe("pending");
  expect(observed).toEqual(["session.created", "session.input_queue_changed"]);
  expect((await observable.createChildSession(input)).duplicate).toBe(true);
  expect(observed).toHaveLength(2);
  expect((await observable.childSessions(rootId)).map((session) => session.id)).toEqual([childId]);
  expect((await store.sessions()).find((session) => session.id === childId)?.agent?.policy).toEqual(input.policy);
  await expect(store.createChildSession({ ...input, policy: {} })).rejects.toThrow("different creation");
  await expect(store.createChildSession({ ...input, initialInput: { ...input.initialInput, payload: "changed" } })).rejects.toThrow("different initial input");
});

test("creation limit includes idle and archived children but exact retries do not consume another slot", async () => {
  const { store, input } = await fixture();
  await store.createChildSession(input);
  await store.append({ id: "archive", type: "session.archived", sessionId: childId, time: Date.now() as TimestampMs, payload: { sessionId: childId } });
  await expect(store.createChildSession({ ...input, sessionId: "session_second" as SessionId, name: "second" })).rejects.toThrow("maxChildren: 1");
  expect((await store.createChildSession(input)).duplicate).toBe(true);
});

test("creation checks durable parent ownership and stored ancestry", async () => {
  const { path, store, input } = await fixture();
  const peer = new SqliteEventStore(path);
  try { await expect(peer.createChildSession(input)).rejects.toThrow(); } finally { peer.close(); }
  await expect(store.createChildSession({ ...input, runClaim: { sessionId: rootId, claimId: "stale" } })).rejects.toThrow();
  await expect(store.createChildSession({ ...input, maxDepth: 0 })).rejects.toThrow("maxDepth 0");
  await store.createChildSession(input);
  const claimed = store.mutateSessionInputs({ kind: "claim", sessionId: childId, claimId: "child_claim", executionRef: "child_execution", leaseDurationMs: 60_000 }, trusted);
  expect(claimed.input?.state).toBe("claimed");
  await expect(store.createChildSession({ ...input, sessionId: "session_grandchild" as SessionId, parentSessionId: childId, name: "nested", runClaim: { sessionId: childId, claimId: "child_claim" } })).rejects.toThrow("depth 2");
});

test("failed initial admission rolls back child identity and its capacity slot", async () => {
  const { path, store, input } = await fixture();
  const db = new Database(path);
  try {
    db.exec("create trigger reject_agent_input before insert on events when new.type = 'session.input_queue_changed' begin select raise(abort, 'admission fixture'); end");
    await expect(store.createChildSession(input)).rejects.toThrow("admission fixture");
    expect(await store.session(childId)).toBeUndefined();
    expect(store.sessionInputById(childId, input.initialInput.inputId)).toBeUndefined();
    db.exec("drop trigger reject_agent_input");
    expect((await store.createChildSession(input)).input.state).toBe("pending");
  } finally { db.close(); }
});

test("only trusted queue operations execute new Agent Sessions; payload does not grant authority", async () => {
  const { store, input } = await fixture();
  await store.createChildSession(input);
  const claim = { kind: "claim" as const, sessionId: childId, claimId: "child_claim", executionRef: "child_execution", leaseDurationMs: 60_000 };
  expect(() => store.mutateSessionInputs(claim)).toThrow();
  expect(store.mutateSessionInputs(claim, trusted).input?.state).toBe("claimed");
  expect(() => store.mutateSessionInputs({ kind: "accept", sessionId: childId, submissionId: "spoof", inputId: "spoof", mode: "queue", payload: '{"sessionAccess":true}', text: "spoof", source: "local" })).toThrow();
});

test("legacy task child sessions stay read-only even for the trusted new queue", async () => {
  const { path, store, input } = await fixture();
  await store.append({ id: "legacy_child", type: "session.created", sessionId: childId, time: Date.now() as TimestampMs, payload: { sessionId: childId, cwd: input.cwd } });
  const db = new Database(path);
  try {
    db.query("insert into events (seq, id, type, time, session_id, payload_json) values ((select coalesce(max(seq), 0) + 1 from events), ?, ?, ?, ?, ?)")
      .run("legacy_task", "agent.task_created", Date.now(), rootId, JSON.stringify({ taskId: "legacy_task", parentSessionId: rootId, childSessionId: childId, parentPath: "/root", path: "/root/legacy", taskName: "legacy", cwd: input.cwd, prompt: "old pending action" }));
  } finally { db.close(); }
  expect(await store.session(childId)).toMatchObject({ readOnly: true });
  expect((await store.session(childId))?.agent).toBeUndefined();
  expect(() => store.mutateSessionInputs({ ...input.initialInput, kind: "accept", sessionId: childId }, trusted)).toThrow();
  expect(store.claimSessionRun({ sessionId: childId, claimId: "legacy_claim", sessionAccess: "child", time: Date.now(), leaseDurationMs: 60_000 }).status).toBe("forbidden");
  expect(store.sessionInputQueue(childId).pendingCount).toBe(0);
  expect(await store.events({ type: "agent.task_created" })).toHaveLength(0);
});

test("result pointers belong to this input execution, survive restart, and resume keeps the input identity", async () => {
  const { path, store, input } = await fixture();
  await store.createChildSession(input);
  const assistant = async (id: string, sessionId = childId) => store.append({ id: `event_${id}`, type: "message.created", sessionId, time: Date.now() as TimestampMs, payload: { messageId: id as MessageId, role: "assistant" } });
  await assistant("old_result");
  let claimed = store.mutateSessionInputs({ kind: "claim", sessionId: childId, claimId: "child_claim", executionRef: "child_execution", leaseDurationMs: 60_000 }, trusted).input!;
  const settle = { kind: "settle" as const, sessionId: childId, inputId: claimed.inputId, claimId: "child_claim", outcome: "cancelled" as const };
  expect(() => store.mutateSessionInputs({ ...settle, resultMessageId: "old_result" as MessageId }, trusted)).toThrow("does not belong");
  await assistant("other_session_result", rootId);
  expect(() => store.mutateSessionInputs({ ...settle, resultMessageId: "other_session_result" as MessageId }, trusted)).toThrow("does not belong");
  await assistant("first_result");
  store.mutateSessionInputs({ ...settle, resultMessageId: "first_result" as MessageId }, trusted);
  store.releaseSessionRun({ sessionId: childId, claimId: "child_claim" });
  store.mutateSessionInputs({ kind: "accept", sessionId: childId, inputId: "later", submissionId: "later", mode: "queue", payload: "later", text: "later", source: "local" }, trusted);
  const ended = store.sessionInputById(childId, claimed.inputId)!;
  const queue = store.sessionInputQueue(childId);
  const resumed = store.mutateSessionInputs({ kind: "resume", sessionId: childId, inputId: ended.inputId, expectedRevision: queue.revision, expectedInputRevision: ended.revision }, trusted);
  expect(resumed.input).toMatchObject({ inputId: ended.inputId, submissionId: "initial", sequence: ended.sequence, state: "pending", resumed: true });
  expect(resumed.input?.resultMessageId).toBeUndefined();
  const firstTurn = claimed.turnId;
  claimed = store.mutateSessionInputs({ kind: "claim", sessionId: childId, claimId: "resumed_claim", executionRef: "child_execution", leaseDurationMs: 60_000 }, trusted).input!;
  expect(claimed.inputId).toBe(ended.inputId);
  expect(claimed.turnId).not.toBe(firstTurn);
  expect(() => store.mutateSessionInputs({ ...settle, claimId: "resumed_claim", resultMessageId: "first_result" as MessageId }, trusted)).toThrow("does not belong");
  await assistant("resumed_result");
  store.mutateSessionInputs({ ...settle, claimId: "resumed_claim", outcome: "completed", resultMessageId: "resumed_result" as MessageId }, trusted);
  store.releaseSessionRun({ sessionId: childId, claimId: "resumed_claim" });
  const reopened = new SqliteEventStore(path);
  try { expect(reopened.sessionInputById(childId, ended.inputId)).toMatchObject({ outcome: "completed", resultMessageId: "resumed_result" }); } finally { reopened.close(); }
  expect(() => store.mutateSessionInputs({ kind: "resume", sessionId: childId, inputId: ended.inputId }, trusted)).toThrow("cannot be resumed");
});
