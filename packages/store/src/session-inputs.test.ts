import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { ObservableEventStore } from "./observable-event-store.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

const sessionId = "session_inputs" as SessionId;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chili-inputs-"));
  const path = join(root, "store.sqlite");
  const store = new SqliteEventStore(path);
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await store.append({ id: "created", type: "session.created", sessionId, time: Date.now() as TimestampMs, payload: { sessionId, cwd: root } });
  return { root, path, store };
}

function accept(store: SqliteEventStore | ObservableEventStore, submissionId = "submission_1", payload = '{"text":"first"}', mode: "queue" | "steer" = "queue") {
  return store.mutateSessionInputs({ kind: "accept", sessionId, submissionId, inputId: `input_${submissionId}`, mode, payload, text: "first", source: "local" });
}

function claim(store: SqliteEventStore, claimId = "claim_1", leaseDurationMs = 60_000) {
  return store.mutateSessionInputs({ kind: "claim", sessionId, claimId, executionRef: `execution_${claimId}`, leaseDurationMs });
}

test("accepted input survives a lost response and identical retries publish only once", async () => {
  const { path, store } = await fixture();
  const observed: string[] = [];
  const events = new ObservableEventStore(store);
  events.subscribe((event) => { observed.push(event.id); });
  const first = accept(events);
  expect(first.input?.state).toBe("pending");
  expect(accept(events).duplicate).toBe(true);
  expect(observed).toHaveLength(1);
  const reopened = new SqliteEventStore(path);
  try {
    expect(accept(reopened).input?.inputId).toBe(first.input?.inputId);
    expect(reopened.sessionInputQueue(sessionId).pendingCount).toBe(1);
    expect(await reopened.messages(sessionId)).toHaveLength(0);
  } finally { reopened.close(); }
});

test("same submission ID rejects changed payload, mode, or authorization", async () => {
  const { store } = await fixture();
  accept(store);
  expect(() => accept(store, "submission_1", '{"text":"changed"}')).toThrow("different input");
  expect(() => accept(store, "submission_1", '{"text":"first"}', "steer")).toThrow("different input");
  expect(() => store.mutateSessionInputs({ kind: "accept", sessionId, submissionId: "submission_1", inputId: "other", mode: "queue", payload: '{"text":"first"}', text: "first", source: "remote:1" })).toThrow("different input");
  expect(store.sessionInputQueue(sessionId).pendingCount).toBe(1);
});

test("pause and claim are atomic across connections; resume is explicit", async () => {
  const { path, store } = await fixture();
  const peer = new SqliteEventStore(path);
  try {
    accept(store);
    store.mutateSessionInputs({ kind: "pause", sessionId });
    expect(claim(peer).input).toBeUndefined();
    peer.mutateSessionInputs({ kind: "resume", sessionId });
    expect(claim(peer).input?.state).toBe("claimed");
    accept(store, "submission_2");
    expect(claim(store, "competing").input).toBeUndefined();
    store.mutateSessionInputs({ kind: "pause", sessionId });
    peer.mutateSessionInputs({ kind: "settle", sessionId, inputId: "input_submission_1", claimId: "claim_1", outcome: "cancelled" });
    peer.releaseSessionRun({ sessionId, claimId: "claim_1" });
    expect(claim(store, "next").input).toBeUndefined();
    expect(store.sessionInputQueue(sessionId).pendingCount).toBe(1);
  } finally { peer.close(); }
});

test("message and image parts materialize together and cannot be appended twice", async () => {
  const { path, store } = await fixture();
  accept(store);
  claim(store);
  const raw = new Database(path);
  try {
    raw.exec(`create trigger fail_input_part before insert on events when new.type = 'message.part_added' begin select raise(abort, 'fixture failure'); end`);
    const promote = { kind: "promote" as const, sessionId, inputId: "input_submission_1", claimId: "claim_1", text: "whole message", images: [{ data: "AA==", mimeType: "image/png" }] };
    expect(() => store.mutateSessionInputs(promote)).toThrow("fixture failure");
    expect(await store.messages(sessionId)).toHaveLength(0);
    raw.exec("drop trigger fail_input_part");
    store.mutateSessionInputs(promote);
    expect(store.mutateSessionInputs(promote).events).toHaveLength(0);
    const messages = await store.messages(sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.parts).toHaveLength(2);
    expect(messages[0]!.parts[0]).toMatchObject({ type: "text", text: "whole message" });
  } finally { raw.close(); }
});

test("a rolled-back claim leaves neither a database claim nor an in-memory owner", async () => {
  const { path, store } = await fixture();
  accept(store);
  const raw = new Database(path);
  try {
    raw.exec(`create trigger fail_claim_event before insert on events when new.type = 'session.input_queue_changed' begin select raise(abort, 'claim fixture'); end`);
    expect(() => claim(store)).toThrow("claim fixture");
    expect(store.sessionInputQueue(sessionId).items[0]!.state).toBe("pending");
    expect(raw.query("select * from session_run_claims").all()).toHaveLength(0);
    raw.exec("drop trigger fail_claim_event");
    expect(claim(store).input?.state).toBe("claimed");
  } finally { raw.close(); }
});

test("expired claimed input is interrupted, pending input stays paused, and live claims are untouched", async () => {
  const { path, store } = await fixture();
  accept(store);
  claim(store, "claim_1");
  accept(store, "submission_2");
  const peer = new SqliteEventStore(path);
  try {
    expect(peer.mutateSessionInputs({ kind: "recover", sessionId }).events).toHaveLength(0);
    const stale = new Database(path);
    stale.query("update session_run_claims set lease_expires_at = 0 where session_id = ?").run(sessionId);
    stale.close();
    const recovered = peer.mutateSessionInputs({ kind: "recover", sessionId });
    expect(recovered.queue).toMatchObject({ paused: true, pendingCount: 1, interruptedCount: 1 });
    expect(peer.sessionInput(sessionId, "submission_1")?.outcome).toBe("interrupted");
    expect(recovered.events).toContainEqual(expect.objectContaining({ type: "session.status_changed", payload: { sessionId, status: "failed", reason: "input_execution_interrupted" } }));
    expect(peer.mutateSessionInputs({ kind: "recover", sessionId }).events).toHaveLength(0);
    expect(claim(peer, "new").input).toBeUndefined();
    peer.mutateSessionInputs({ kind: "resume", sessionId });
    expect(claim(peer, "new").input?.submissionId).toBe("submission_2");
    expect(() => store.mutateSessionInputs({ kind: "settle", sessionId, inputId: "input_submission_1", claimId: "claim_1", outcome: "completed" })).toThrow();
  } finally { peer.close(); }
});

test("cancellation checks the exact pending revision and revoked sources cannot race admission", async () => {
  const { store } = await fixture();
  const first = accept(store).input!;
  expect(() => store.mutateSessionInputs({ kind: "cancel", sessionId, inputId: first.inputId, expectedRevision: 9 })).toThrow();
  store.mutateSessionInputs({ kind: "cancel", sessionId, inputId: first.inputId, expectedRevision: first.revision });
  store.mutateSessionInputs({ kind: "cancel-source", sessionId, source: "remote:revoked" });
  expect(() => store.mutateSessionInputs({ kind: "accept", sessionId, inputId: "remote", submissionId: "remote", mode: "queue", payload: "{}", text: "x", source: "remote:revoked" })).toThrow("revoked");
  expect(store.sessionInputQueue(sessionId).pendingCount).toBe(0);
});

test("old writers cannot bypass durable pause by acquiring a legacy claim", async () => {
  const { path, store } = await fixture();
  accept(store);
  store.mutateSessionInputs({ kind: "pause", sessionId });
  const oldWriter = new Database(path);
  try {
    expect(() => oldWriter.query("insert into session_run_claims(session_id, claim_id, claimed_at, heartbeat_at, lease_expires_at) values (?, 'old', 0, 0, ?)").run(sessionId, Date.now() + 60_000)).toThrow("Incompatible Chili writer");
  } finally { oldWriter.close(); }
});

for (const phase of ["accepted", "claimed", "promoted"] as const) {
  test(`SIGKILL after ${phase} preserves receipt and requires explicit recovery`, async () => {
    const { path, store } = await fixture();
    const script = `
      import { SqliteEventStore } from ${JSON.stringify(join(import.meta.dir, "sqlite-event-store.ts"))};
      const store = new SqliteEventStore(${JSON.stringify(path)});
      const sessionId = ${JSON.stringify(sessionId)};
      store.mutateSessionInputs({ kind: "accept", sessionId, submissionId: "crash", inputId: "crash", mode: "queue", payload: '{"text":"durable"}', text: "durable", source: "local" });
      if (${JSON.stringify(phase)} !== "accepted") store.mutateSessionInputs({ kind: "claim", sessionId, claimId: "crash-claim", executionRef: "crash-run", leaseDurationMs: 100 });
      if (${JSON.stringify(phase)} === "promoted") store.mutateSessionInputs({ kind: "promote", sessionId, inputId: "crash", claimId: "crash-claim", text: "durable" });
      process.stdout.write("committed");
      setInterval(() => {}, 1000);
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      const marker = await reader.read();
      expect(new TextDecoder().decode(marker.value)).toBe("committed");
      reader.releaseLock();
      child.kill("SIGKILL");
      await child.exited;
      await Bun.sleep(120);
      const recovered = store.mutateSessionInputs({ kind: "recover", sessionId });
      expect(recovered.queue.paused).toBe(true);
      expect(recovered.queue.pendingCount).toBe(phase === "accepted" ? 1 : 0);
      const receipt = store.mutateSessionInputs({ kind: "accept", sessionId, submissionId: "crash", inputId: "retry", mode: "queue", payload: '{"text":"durable"}', text: "durable", source: "local" });
      expect(receipt.duplicate).toBe(true);
      expect(receipt.input?.inputId).toBe("crash");
      expect(receipt.input?.outcome).toBe(phase === "accepted" ? undefined : "interrupted");
      expect(await store.messages(sessionId)).toHaveLength(phase === "promoted" ? 1 : 0);
      expect(claim(store, "after-restart").input).toBeUndefined();
    } finally {
      child.kill();
      await child.exited;
    }
  });
}

test("recovery closes the abandoned turn and marks unknown tool effects without replay", async () => {
  const { store } = await fixture();
  accept(store);
  claim(store);
  const turnId = "unknown_turn" as TurnId;
  const callId = "unknown_tool" as ToolCallId;
  await store.append({ id: "started_turn", type: "turn.started", sessionId, time: Date.now() as TimestampMs, payload: { turnId } });
  await store.append({ id: "started_tool", type: "tool.call_started", sessionId, time: Date.now() as TimestampMs, payload: { turnId, callId, toolName: "write_file", input: { path: "result.txt" } } });
  store.releaseSessionRun({ sessionId, claimId: "claim_1" });
  const recovered = store.mutateSessionInputs({ kind: "recover", sessionId });
  expect(recovered.events).toContainEqual(expect.objectContaining({ type: "turn.completed", payload: { turnId, status: "failed" } }));
  const finished = recovered.events.find((event) => event.type === "tool.call_finished");
  expect(finished?.payload).toMatchObject({ callId, status: "failed", synthetic: true });
  expect(finished && "error" in finished.payload && finished.payload.error).toContain("unknown");
  expect(store.mutateSessionInputs({ kind: "recover", sessionId }).events).toHaveLength(0);
  expect((await store.events({ sessionId, type: "tool.call_started" }))).toHaveLength(1);
});
