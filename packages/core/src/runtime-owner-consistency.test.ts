import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ExecutionIdentity, MessageId, SessionId, SnapshotId, TimestampMs, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type { AgentRunner, RunTurnInput, RunTurnResult } from "./runner.js";
import { RuntimeBusyError, RuntimeForeignOwnerError, RuntimeService } from "./runtime-service.js";
import { SnapshotRecoveryService } from "./recovery.js";

const sessionId = "owner_session" as SessionId;
const snapshotId = "owner_snapshot" as SnapshotId;
const time = () => Date.now() as TimestampMs;
const id = () => crypto.randomUUID();

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "chili-owner-contract-"));
  const first = new SqliteEventStore(join(cwd, "events.sqlite"));
  const second = new SqliteEventStore(join(cwd, "events.sqlite"));
  await first.append({ id: id(), type: "session.created", sessionId, time: time(), payload: { sessionId, cwd } });
  await first.append({ id: id(), type: "snapshot.created", sessionId, time: time(), payload: { snapshotId, paths: ["file.ts"], reason: "test" } });
  return { cwd, first, second, async close() {
    await Promise.all([first.flushInputMirrors(), second.flushInputMirrors()]);
    first.close(); second.close();
    await rm(cwd, { recursive: true, force: true });
  } };
}

function runner(store: SqliteEventStore, runTurn: AgentRunner["runTurn"]): AgentRunner {
  return {
    async createSession(input) {
      const session = input.sessionId ?? id() as SessionId;
      await store.append({ id: id(), type: "session.created", sessionId: session, time: time(), payload: { sessionId: session, cwd: input.cwd, ...(input.identity ? { identity: input.identity } : {}) } });
      return session;
    },
    async appendUserMessage(input) {
      const messageId = id() as MessageId;
      await store.appendMany([
        { id: id(), type: "message.created", sessionId: input.sessionId, time: time(), payload: { messageId, role: "user", ...(input.turnId ? { turnId: input.turnId } : {}) } },
        { id: id(), type: "message.part_added", sessionId: input.sessionId, time: time(), payload: { messageId, part: { id: id() as never, messageId, sessionId: input.sessionId, type: "text", text: input.text } } },
      ]);
      return messageId;
    },
    runTurn,
  };
}

async function answer(store: SqliteEventStore, input: RunTurnInput, text: string): Promise<RunTurnResult> {
  const messageId = id() as MessageId;
  await store.appendMany([
    { id: id(), type: "message.created", sessionId: input.sessionId, time: time(), payload: { messageId, role: "assistant" } },
    { id: id(), type: "message.part_added", sessionId: input.sessionId, time: time(), payload: { messageId, part: { id: id() as never, messageId, sessionId: input.sessionId, type: "text", text } } },
  ]);
  return { status: "completed", turnId: input.turnId ?? id() as TurnId, assistantMessageId: messageId, finishReason: "stop" };
}

test("foreign Stop, Steer and admission reject without changing the owning run or queue", async () => {
  const f = await fixture();
  const started = gate();
  let signal: AbortSignal | undefined;
  const run = runner(f.first, async (input) => {
    signal = input.signal;
    started.resolve();
    return new Promise((resolve) => input.signal!.addEventListener("abort", () => resolve({ status: "cancelled", turnId: input.turnId!, error: new Error("stopped") }), { once: true }));
  });
  const owner = new RuntimeService({ store: f.first, runtime: run, cwd: f.cwd });
  let foreignResourceStops = 0;
  const peer = new RuntimeService({ store: f.second, runtime: run, cwd: f.cwd, stopSessionResources: async () => { foreignResourceStops++; return true; } });
  try {
    owner.submitPromptAsync({ sessionId, text: "work", submissionId: "original" });
    await started.promise;
    const queued = owner.submitPromptAsync({ sessionId, text: "next", submissionId: "queued", mode: "queue", inputSource: "test_source" });
    const revision = owner.inputQueue(sessionId).revision;
    for (const reference of [undefined, owner.inputQueue(sessionId).executionRef]) {
      await expect(peer.interrupt(sessionId, "stop", reference)).rejects.toBeInstanceOf(RuntimeForeignOwnerError);
      await expect(peer.interrupt(sessionId, "steer", reference)).rejects.toBeInstanceOf(RuntimeForeignOwnerError);
    }
    for (const mode of ["start", "queue", "steer"] as const) {
      expect(() => peer.submitPromptAsync({ sessionId, text: "foreign", submissionId: mode, mode })).toThrow(RuntimeForeignOwnerError);
    }
    expect(() => peer.cancelInput({ sessionId, inputId: queued.input!.inputId, expectedRevision: revision })).toThrow(RuntimeForeignOwnerError);
    expect(() => peer.cancelInputsFromSource(sessionId, "test_source")).toThrow(RuntimeForeignOwnerError);
    await expect(peer.resumeInputs(sessionId)).rejects.toBeInstanceOf(RuntimeForeignOwnerError);
    await expect(peer.recoverInputs()).rejects.toBeInstanceOf(RuntimeForeignOwnerError);
    expect(owner.inputQueue(sessionId)).toMatchObject({ paused: false, revision, pendingCount: 1 });
    expect(signal?.aborted).toBe(false);
    expect(foreignResourceStops).toBe(0);
    expect(await owner.interrupt(sessionId)).toBe(true);
    expect(signal?.aborted).toBe(true);
  } finally {
    await Promise.all([owner.shutdown(), peer.shutdown()]);
    await f.close();
  }
});

test("revert and prompts exclude one another across store connections for the whole filesystem operation", async () => {
  const f = await fixture();
  const restore = gate();
  const restoring = gate();
  const run = runner(f.first, async (input) => answer(f.first, input, "done"));
  const owner = new RuntimeService({ store: f.first, runtime: run, cwd: f.cwd });
  const peer = new RuntimeService({ store: f.second, runtime: runner(f.second, async (input) => answer(f.second, input, "done")), cwd: f.cwd });
  let mutations = 0;
  const recovery = new SnapshotRecoveryService({ store: f.second, snapshotProvider: {
    async create() { return undefined; },
    async revert() {
      mutations++;
      restoring.resolve();
      await restore.promise;
      return { snapshotId, paths: ["file.ts"], restored: ["file.ts"], removed: [] };
    },
  } });
  try {
    await owner.withSessionOperation(sessionId, async () => {
      await expect(recovery.revert({ sessionId, snapshotId })).rejects.toBeInstanceOf(RuntimeBusyError);
      expect(mutations).toBe(0);
    });
    const pending = recovery.revert({ sessionId, snapshotId });
    await restoring.promise;
    expect(f.first.sessionRunClaim(sessionId)).toBeDefined();
    await expect(owner.submitPrompt({ sessionId, text: "race restore" })).rejects.toBeInstanceOf(RuntimeBusyError);
    await expect(peer.archiveSession(sessionId)).rejects.toBeInstanceOf(RuntimeBusyError);
    restore.resolve();
    await pending;
    expect(f.first.sessionRunClaim(sessionId)).toBeUndefined();
    expect((await owner.submitPrompt({ sessionId, text: "after restore" })).status).toBe("completed");
    expect(mutations).toBe(1);
  } finally {
    restore.resolve();
    await Promise.all([owner.shutdown(), peer.shutdown()]);
    await f.close();
  }
});

test("historical execution identity does not block local session operations or bind legacy work", async () => {
  const f = await fixture();
  const identity: ExecutionIdentity = { profileId: "profile_A", profilePath: f.cwd, projectId: "project_A", projectRoot: f.cwd, workspaceId: "workspace_A", workspaceRoot: f.cwd };
  const currentIdentity: ExecutionIdentity = { ...identity, profileId: "profile_B", projectId: "project_B", workspaceId: "workspace_B" };
  const context = new AsyncLocalStorage<string>();
  let calls = 0;
  let restores = 0;
  const run = runner(f.first, async (input) => {
    expect(context.getStore()).toBe("current_owner");
    calls++;
    return answer(f.first, input, "Verified the parser and regression test.");
  });
  const service = new RuntimeService({ store: f.first, runtime: run, cwd: f.cwd,
    executionIdentityResolver: () => currentIdentity,
    executionContext: (operation) => context.run("current_owner", operation),
  });
  const recovery = new SnapshotRecoveryService({ store: f.first, sessionOperations: service, snapshotProvider: {
    async create() { return undefined; },
    async revert() { expect(context.getStore()).toBe("current_owner"); restores++; return { snapshotId, paths: [], restored: [], removed: [] }; },
  } });
  try {
    // Legacy sessions continue without acquiring a permanent environment binding.
    expect((await service.submitPrompt({ sessionId, text: "legacy task" })).status).toBe("completed");
    expect(await f.first.events({ sessionId, type: "session.identity_bound" })).toHaveLength(0);

    const historicalSessionId = "historical_identity_session" as SessionId;
    await f.first.appendMany([
      { id: id(), type: "session.created", sessionId: historicalSessionId, time: time(), payload: { sessionId: historicalSessionId, cwd: f.cwd, identity } },
      { id: id(), type: "snapshot.created", sessionId: historicalSessionId, time: time(), payload: { snapshotId, paths: ["file.ts"], reason: "test" } },
    ]);
    // Creation metadata alone does not restrict execution in the same local store.
    expect((await service.submitPrompt({ sessionId: historicalSessionId, text: "continue with current environment" })).status).toBe("completed");
    await f.first.append({ id: id(), type: "session.identity_bound", sessionId: historicalSessionId, time: time(), payload: { sessionId: historicalSessionId, identity } });
    // Existing binding events remain readable history, without restricting operations.
    expect((await service.submitPrompt({ sessionId: historicalSessionId, text: "continue after historical binding" })).status).toBe("completed");
    await service.interrupt(historicalSessionId);
    expect(f.first.sessionInputQueue(historicalSessionId).paused).toBe(true);
    await service.resumeInputs(historicalSessionId);
    expect(f.first.sessionInputQueue(historicalSessionId).paused).toBe(false);
    await recovery.revert({ sessionId: historicalSessionId, snapshotId });
    expect(restores).toBe(1);
    expect(calls).toBe(3);
    expect((await f.first.events({ sessionId: historicalSessionId, type: "session.identity_bound" })).map((event) => event.payload)).toEqual([{ sessionId: historicalSessionId, identity }]);
    const created = await service.createSession({ cwd: f.cwd });
    expect((await f.first.events({ sessionId: created.sessionId, type: "session.created" }))[0]?.payload).toMatchObject({ identity: currentIdentity });
  } finally {
    await service.shutdown();
    await f.close();
  }
});

test("Stop cancels snapshot recovery through its execution owner and publishes a terminal state", async () => {
  const f = await fixture();
  const started = gate();
  const service = new RuntimeService({ store: f.first, runtime: runner(f.first, async (input) => answer(f.first, input, "done")), cwd: f.cwd });
  const recovery = new SnapshotRecoveryService({ store: f.first, sessionOperations: service, snapshotProvider: {
    async create() { return undefined; },
    async revert(_snapshotId, options) {
      started.resolve();
      await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
      throw new Error("must be aborted");
    },
  } });
  try {
    const outcome = recovery.revert({ sessionId, snapshotId });
    const rejected = outcome.then(() => undefined, (error: unknown) => error);
    await started.promise;
    expect(await service.interrupt(sessionId, "cancel_restore")).toBe(true);
    expect(await rejected).toMatchObject({ message: "cancel_restore" });
    expect(f.first.sessionRunClaim(sessionId)).toBeUndefined();
    expect((await f.first.events({ sessionId, type: "snapshot.reverted" })).at(-1)?.payload).toMatchObject({ status: "failed" });
    expect((await f.first.events({ sessionId, type: "session.status_changed" })).at(-1)?.payload).toMatchObject({ status: "cancelled" });
  } finally {
    await service.shutdown();
    await f.close();
  }
});
