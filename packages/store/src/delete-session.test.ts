import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, SessionId, TimestampMs } from "@chili/protocol";
import { HostOwnerClaim } from "./host-owner.js";
import { ObservableEventStore } from "./observable-event-store.js";
import {
  HostSessionOwnerConflictError, SessionAccessError, SessionCreationClaimConflictError,
  SessionRunClaimConflictError, SessionStateConflictError, SqliteEventStore,
  type SqliteEventStoreOptions,
} from "./sqlite-event-store.js";
import type { EventStore } from "./types.js";

const rootId = "delete_root" as SessionId;
const childId = "delete_child" as SessionId;
const grandchildId = "delete_grandchild" as SessionId;
const keepId = "keep_root" as SessionId;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function fixture(options?: SqliteEventStoreOptions) {
  const cwd = await mkdtemp(join(tmpdir(), "chili-delete-session-"));
  const path = join(cwd, "events.sqlite");
  const store = new SqliteEventStore(path, options);
  const db = (store as unknown as { db: Database }).db;
  cleanup.push(async () => { await store.flushInputMirrors(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, path, store, db };
}

function event(type: RuntimeEvent["type"], sessionId: SessionId, payload: unknown): RuntimeEvent {
  return { id: crypto.randomUUID(), type, sessionId, time: Date.now() as TimestampMs, payload } as RuntimeEvent;
}

async function create(store: SqliteEventStore, sessionId: SessionId, cwd: string, parentSessionId?: SessionId, parentPath = "/root") {
  await store.append(event("session.created", sessionId, { sessionId, cwd,
    ...(parentSessionId ? { agent: { parentSessionId, name: sessionId, path: `${parentPath}/${sessionId}`, policy: {} } } : {}) }));
}

async function populate(store: SqliteEventStore, sessionId: SessionId) {
  store.mutateSessionInputs({ kind: "accept", sessionId, submissionId: sessionId, inputId: `input_${sessionId}`,
    mode: "queue", payload: JSON.stringify({ text: "private prompt" }), text: "private prompt", source: "local" },
  sessionId === childId || sessionId === grandchildId ? { sessionAccess: "child" } : undefined);
  await store.appendMany([
    event("message.created", sessionId, { messageId: `message_${sessionId}`, role: "assistant" }),
    event("message.part_added", sessionId, { messageId: `message_${sessionId}`, part: {
      id: `part_${sessionId}`, messageId: `message_${sessionId}`, sessionId, type: "text", text: "private response",
    } }),
    event("tool.call_started", sessionId, { callId: `call_${sessionId}`, toolName: "read", input: { path: "README.md" } }),
    event("approval.requested", sessionId, { approvalId: `approval_${sessionId}`, callId: `call_${sessionId}`, permission: "read", patterns: ["README.md"] }),
  ]);
}

test("deletion removes archived roots, descendants and durable projections after reopen while retaining project files", async () => {
  const { store, cwd, path, db } = await fixture();
  await writeFile(join(cwd, "project.txt"), "keep the user's project");
  await create(store, rootId, cwd);
  await create(store, childId, cwd, rootId);
  await create(store, grandchildId, cwd, childId, `/root/${childId}`);
  await create(store, keepId, cwd);
  for (const id of [rootId, childId, grandchildId, keepId]) await populate(store, id);
  db.query("insert into session_input_revocations values (?, ?)").run(childId, "remote:stale");
  db.query("insert into session_host_owners values (?, ?)").run(rootId, "stale-owner");
  await store.append(event("session.archived", rootId, { sessionId: rootId }));
  expect(new Set(await store.deleteSession(rootId))).toEqual(new Set([rootId, childId, grandchildId]));
  for (const table of ["events", "message_parts", "messages", "tool_calls", "approvals", "session_inputs", "session_dispatch", "session_input_revocations", "session_creation_claims", "session_run_claims"]) {
    expect(db.query<{ count: number }, [string]>(`select count(*) as count from ${table} where session_id != ?`).get(keepId)?.count).toBe(0);
  }
  expect(db.query<{ count: number }, []>("select count(*) as count from session_host_owners").get()?.count).toBe(0);
  expect((await store.sessions()).map((session) => session.id)).toEqual([keepId]);
  expect((await store.messages(keepId))[0]?.parts[0]).toMatchObject({ text: "private response" });
  expect(await readFile(join(cwd, "project.txt"), "utf8")).toBe("keep the user's project");
  const reopened = new SqliteEventStore(path);
  try {
    expect(await reopened.events({ sessionId: rootId })).toEqual([]);
    expect(await reopened.messages(childId)).toEqual([]);
    expect(await reopened.pendingApprovals(grandchildId)).toEqual([]);
    expect((await reopened.sessions()).map((session) => session.id)).toEqual([keepId]);
    await expect(reopened.deleteSession(rootId)).rejects.toBeInstanceOf(SessionStateConflictError);
  } finally { reopened.close(); }
});

test("deletion enforces root versus child access and leaves the rest of the tree intact", async () => {
  const { store, cwd } = await fixture();
  await create(store, rootId, cwd);
  await create(store, childId, cwd, rootId);
  await create(store, grandchildId, cwd, childId, `/root/${childId}`);
  await expect(store.deleteSession(childId)).rejects.toBeInstanceOf(SessionAccessError);
  await expect(store.deleteSession(rootId, { sessionAccess: "child" })).rejects.toBeInstanceOf(SessionAccessError);
  expect(new Set(await store.deleteSession(childId, { sessionAccess: "child" }))).toEqual(new Set([childId, grandchildId]));
  expect((await store.sessions()).map((session) => session.id)).toEqual([rootId]);
});

test("live child claims block the complete deletion atomically and expired claims continue fencing stale writes", async () => {
  const { store, cwd, db } = await fixture();
  await create(store, rootId, cwd);
  await create(store, childId, cwd, rootId);
  expect(store.claimSessionRun({ sessionId: childId, sessionAccess: "child", claimId: "running", time: Date.now(), leaseDurationMs: 60_000 }).status).toBe("claimed");
  await expect(store.deleteSession(rootId)).rejects.toBeInstanceOf(SessionRunClaimConflictError);
  expect(await store.sessions()).toHaveLength(2);
  expect(await store.events()).toHaveLength(2);
  db.query("update session_run_claims set lease_expires_at = 0").run();
  await store.deleteSession(rootId);
  await expect(store.append(event("session.created", childId, { sessionId: childId, cwd }))).rejects.toBeInstanceOf(SessionRunClaimConflictError);
  expect(await store.events()).toEqual([]);
});

test("creation claims block deletion until expired and retain the stale creation fence", async () => {
  const { store, cwd, db } = await fixture();
  expect(store.claimSessionCreation({ sessionId: rootId, claimId: "creating", cwd, time: Date.now(), leaseDurationMs: 60_000 }).status).toBe("claimed");
  await create(store, rootId, cwd);
  await expect(store.deleteSession(rootId)).rejects.toBeInstanceOf(SessionCreationClaimConflictError);
  db.query("update session_creation_claims set lease_expires_at = 0").run();
  await store.deleteSession(rootId);
  await expect(create(store, rootId, cwd)).rejects.toBeInstanceOf(SessionCreationClaimConflictError);
  expect(await store.sessions()).toEqual([]);
});

test("deletion respects another live Host's ownership and releases only the removed root ownership", async () => {
  const { store: initial, cwd, path } = await fixture();
  initial.close();
  const firstHost = new HostOwnerClaim(path);
  const secondHost = new HostOwnerClaim(path);
  const first = new SqliteEventStore(path, { hostOwnerToken: firstHost.token });
  const second = new SqliteEventStore(path, { hostOwnerToken: secondHost.token });
  try {
    await create(first, rootId, cwd);
    await create(first, keepId, cwd);
    await expect(second.deleteSession(rootId)).rejects.toBeInstanceOf(HostSessionOwnerConflictError);
    expect(await first.sessions()).toHaveLength(2);
    await first.deleteSession(rootId);
    expect(() => second.acquireSessionOwnership(keepId)).toThrow(HostSessionOwnerConflictError);
    await expect(create(second, rootId, cwd)).rejects.toBeInstanceOf(SessionStateConflictError);
    expect(second.canRecoverSession(rootId)).toBe(false);
  } finally { first.close(); second.close(); firstHost.release(); secondHost.release(); }
});

test("deletion waits for prior append and input mirrors and reports cleanup failures after its commit", async () => {
  const mirrored: string[] = [];
  const failures: unknown[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { store, cwd } = await fixture({ mirror: {
    write: async (entry) => { await pending; mirrored.push(entry.type); },
    deleteSessions: async (sessions) => { mirrored.push(`delete:${sessions[0]?.cwd}`); throw new Error("export unavailable"); },
  }, onSessionDeleteCleanupError: (error) => { failures.push(error); } });
  const appended = create(store, rootId, cwd);
  store.mutateSessionInputs({ kind: "accept", sessionId: rootId, submissionId: "queued", inputId: "queued",
    mode: "queue", payload: "{}", text: "queued", source: "local" });
  const removed = store.deleteSession(rootId);
  expect(await store.sessions()).toEqual([]);
  release();
  await appended;
  expect(await removed).toEqual([rootId]);
  expect(mirrored).toEqual(["session.created", "session.input_queue_changed", `delete:${cwd}`]);
  expect(failures).toHaveLength(1);
});

test("observable wrappers preserve optional deletion and clear live parts for every removed session", async () => {
  const { store: base, cwd } = await fixture();
  const store = new ObservableEventStore(new ObservableEventStore(base));
  expect(new ObservableEventStore({} as EventStore).deleteSession).toBeUndefined();
  await create(base, rootId, cwd);
  await create(base, childId, cwd, rootId);
  await create(base, keepId, cwd);
  for (const id of [rootId, childId, keepId]) await store.append(event("message.part_stream_delta", id,
    { messageId: `message_${id}`, partId: `part_${id}`, partType: "text", delta: "live", offset: 0 }));
  expect(store.activeMessageParts()).toHaveLength(3);
  await store.deleteSession!(rootId);
  expect(store.activeMessageParts().map((entry) => entry.sessionId)).toEqual([keepId]);
});

test("deleted IDs reject late unfenced appends and recreation across store connections", async () => {
  const { store, cwd, path } = await fixture();
  await create(store, rootId, cwd);
  const peer = new SqliteEventStore(path);
  try {
    await store.deleteSession(rootId);
    await expect(peer.append(event("session.renamed", rootId, { sessionId: rootId, title: "late rename" }))).rejects.toBeInstanceOf(SessionStateConflictError);
    await expect(peer.append(event("message.created", rootId, { messageId: "late_message", role: "assistant" }))).rejects.toBeInstanceOf(SessionStateConflictError);
    await expect(create(peer, rootId, cwd)).rejects.toBeInstanceOf(SessionStateConflictError);
    expect(peer.claimSessionCreation({ sessionId: rootId, claimId: "late_creation", cwd, time: Date.now(), leaseDurationMs: 60_000 }).status).toBe("already_exists");
    expect(await peer.events()).toEqual([]);
    expect(await peer.sessions()).toEqual([]);
  } finally { peer.close(); }
});
