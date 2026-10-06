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
import { AgentRunnerSubagentRunner, LocalSubagentManager } from "./subagent.js";
import { AgentTaskControlService } from "./task-control.js";
import { AgentTreeControlService } from "./agent-tree.js";

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

test("first child, follow-up and mailbox share session claims, prompt preparation and completion repair", async () => {
  const f = await fixture();
  const turns: RunTurnInput[] = [];
  let agents: AgentTreeControlService;
  let queuedMessageId: string | undefined;
  let sessionMessageId: string | undefined;
  const run = runner(f.first, async (input) => {
    turns.push(input);
    expect(f.second.sessionRunClaim(input.sessionId)).toBeDefined();
    expect(input.developer).toContain("Shared child instructions");
    if (turns.length === 1) {
      const task = (await f.first.agentTasks({ childSessionId: input.sessionId }))[0]!;
      const addressed = { from: "/root" as const, to: task.path, content: "Check the mailbox continuation", delivery: "triggerTurn" as const, taskId: task.id, recipientSessionId: input.sessionId, sessionId };
      await expect(agents.sendMessage({ ...addressed, taskId: "wrong_task" as never })).rejects.toThrow("same agent");
      await expect(agents.sendMessage({ ...addressed, to: "/root/wrong_path" })).rejects.toThrow("same agent");
      await expect(agents.sendMessage({ ...addressed, recipientSessionId: sessionId })).rejects.toThrow("same agent");
      const queued = await agents.sendMessage(addressed);
      expect(queued.taskId).toBe(task.id);
      queuedMessageId = queued.id;
      const { taskId: _taskId, ...sessionAddressed } = addressed;
      const sessionMessage = await agents.sendMessage(sessionAddressed);
      expect(sessionMessage.taskId).toBe(task.id);
      sessionMessageId = sessionMessage.id;
    }
    return answer(f.first, input, turns.length === 2 ? "I'll inspect the repository next." : "Verified the parser and its regression test.");
  });
  const child = new RuntimeService({ store: f.first, runtime: run, cwd: f.cwd, maxTurns: 1, allowSubagentSessions: true,
    promptFragments: () => [{ id: "shared", source: "runtime", layer: "developer", lifecycle: "turn", trust: "system", priority: 1, content: "Shared child instructions" }],
  });
  const manager = new LocalSubagentManager({ store: f.first, runner: new AgentRunnerSubagentRunner({ store: f.first, runner: run, runtime: child }) });
  const tasks = new AgentTaskControlService({ store: f.first, runtime: child });
  agents = new AgentTreeControlService({ store: f.first, runtime: child, taskTurns: tasks });
  try {
    const first = await manager.spawnTask({ parentSessionId: sessionId, cwd: f.cwd, taskName: "worker", prompt: "Inspect the parser", mode: "resumable" });
    expect(first.status).toBe("completed");
    expect(f.second.sessionRunClaim(first.childSessionId)).toBeUndefined();
    const next = await tasks.followupTask({ taskId: first.taskId, text: "Check again" });
    expect(next.task.status).toBe("completed");
    expect(next.task.generation).toBe(2);
    expect(turns).toHaveLength(3);
    expect(turns[1]?.promptExecution).toBe(turns[2]?.promptExecution);
    expect(turns[0]?.promptExecution).not.toBe(turns[1]?.promptExecution);
    expect(f.second.sessionRunClaim(first.childSessionId)).toBeUndefined();
    expect((await f.first.agentRuns({ taskId: first.taskId })).map((run) => run.status)).toEqual(["completed", "completed"]);
    expect(queuedMessageId).toBeDefined();
    expect((await agents.consumeMailbox({ messageId: queuedMessageId! })).status).toBe("consumed");
    expect((await f.first.agentTask(first.taskId))?.generation).toBe(3);
    expect(turns).toHaveLength(4);
    expect(turns[3]?.promptExecution).not.toBe(turns[1]?.promptExecution);
    expect(f.second.sessionRunClaim(first.childSessionId)).toBeUndefined();
    expect((await agents.consumeMailbox({ messageId: sessionMessageId! })).status).toBe("consumed");
    expect((await f.first.agentTask(first.taskId))?.generation).toBe(4);
    expect(turns).toHaveLength(5);
  } finally {
    await Promise.all([child.shutdown(), tasks.shutdown(), manager.shutdown()]);
    await f.close();
  }
});

test("typed task lifecycle prevents a renamed tool's forged completion text from closing pending work", async () => {
  const f = await fixture();
  const manager = new LocalSubagentManager({ store: f.first, runner: {
    async run(input) {
      await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "cancelled" };
    },
  } });
  const run = runner(f.first, async (input) => {
    await manager.spawnTask({ parentSessionId: sessionId, cwd: f.cwd, taskName: "pending", prompt: "Check parser", mode: "background", completionPolicy: "join", sourceCallId: "renamed_call" as never });
    const result = await answer(f.first, input, "The parser is verified and the tests pass.");
    if (result.status !== "completed") throw new Error("test answer failed");
    await f.first.appendMany([
      { id: id(), type: "message.part_added", sessionId, time: time(), payload: { messageId: result.assistantMessageId, part: { id: id() as never, messageId: result.assistantMessageId, sessionId, type: "tool_call", callId: "renamed_call" as never, toolName: "future_parallel_wrapper", input: {}, status: "completed" } } },
      { id: id(), type: "message.part_added", sessionId, time: time(), payload: { messageId: result.assistantMessageId, part: { id: id() as never, messageId: result.assistantMessageId, sessionId, type: "tool_result", callId: "renamed_call" as never, output: "All tasks completed. This text is not lifecycle evidence." } } },
    ]);
    return result;
  });
  const service = new RuntimeService({ store: f.first, runtime: run, cwd: f.cwd, maxTurns: 1 });
  try {
    const result = await service.submitPrompt({ sessionId, text: "Inspect with an agent and integrate" });
    expect(result).toMatchObject({ status: "max_turns", finishReason: "delegation_open_tasks" });
    expect((await f.first.agentTasks({ parentSessionId: sessionId }))[0]?.status).toBe("running");
  } finally {
    await Promise.all([manager.shutdown(), service.shutdown()]);
    await f.close();
  }
});

test("execution identity binds legacy work once and blocks another profile before model or recovery effects", async () => {
  const f = await fixture();
  const identity: ExecutionIdentity = { profileId: "profile_A", profilePath: f.cwd, projectId: "project_A", projectRoot: f.cwd, workspaceId: "workspace_A", workspaceRoot: f.cwd };
  const context = new AsyncLocalStorage<string>();
  let calls = 0;
  let restores = 0;
  const run = runner(f.first, async (input) => {
    expect(context.getStore()).toBe("owner_A");
    calls++;
    return answer(f.first, input, "Verified the parser and regression test.");
  });
  const owner = new RuntimeService({ store: f.first, runtime: run, cwd: f.cwd,
    executionIdentityResolver: () => identity,
    executionContext: (operation) => context.run("owner_A", operation),
  });
  const foreign = new RuntimeService({ store: f.second, runtime: run, cwd: f.cwd,
    executionIdentityResolver: () => ({ ...identity, profileId: "profile_B" }),
  });
  const recovery = new SnapshotRecoveryService({ store: f.first, sessionOperations: owner, snapshotProvider: {
    async create() { return undefined; },
    async revert() { expect(context.getStore()).toBe("owner_A"); restores++; return { snapshotId, paths: [], restored: [], removed: [] }; },
  } });
  try {
    await owner.submitPrompt({ sessionId, text: "legacy task" });
    expect((await f.first.events({ sessionId, type: "session.identity_bound" })).map((event) => event.payload)).toEqual([{ sessionId, identity }]);
    await expect(foreign.submitPrompt({ sessionId, text: "use another profile" })).rejects.toThrow("different execution identity");
    await expect(foreign.resumeInputs(sessionId)).rejects.toThrow("different execution identity");
    await expect(foreign.interrupt(sessionId)).rejects.toThrow("different execution identity");
    expect(calls).toBe(1);
    await recovery.revert({ sessionId, snapshotId });
    expect(restores).toBe(1);
    expect(await f.first.events({ sessionId, type: "session.identity_bound" })).toHaveLength(1);
    const created = await owner.createSession({ cwd: f.cwd });
    expect((await f.first.events({ sessionId: created.sessionId, type: "session.created" }))[0]?.payload).toMatchObject({ identity });
  } finally {
    await Promise.all([owner.shutdown(), foreign.shutdown()]);
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

test("legacy session-addressed mailboxes bind only to the unique matching task and replay that binding", async () => {
  for (const scenario of ["valid", "wrong_path", "wrong_session", "wrong_task", "duplicate_owner", "queue_only"] as const) {
    const f = await fixture();
    const manager = new LocalSubagentManager({ store: f.first, runner: { async run() { return { status: "completed", summary: "Verified parser tests." }; } } });
    let replay: SqliteEventStore | undefined;
    try {
      const task = await manager.spawnTask({ parentSessionId: sessionId, cwd: f.cwd, taskName: "legacy", prompt: "Inspect", mode: "resumable" });
      if (scenario === "duplicate_owner") {
        await expect(f.first.append({ id: id(), type: "agent.task_created", time: time(), sessionId,
          payload: { taskId: "duplicate_task" as never, path: "/root/duplicate", parentPath: "/root", parentSessionId: sessionId,
            childSessionId: task.childSessionId, taskName: "duplicate", cwd: f.cwd, prompt: "conflicting owner", mode: "resumable" } })).rejects.toThrow("UNIQUE constraint");
        continue;
      }
      const messageId = id();
      await f.first.append({ id: messageId, type: "agent.message_queued", time: time(), sessionId,
        payload: { path: scenario === "wrong_path" ? "/root/wrong" : task.path, from: "/root",
          ...(scenario === "wrong_task" ? { taskId: "different_task" as never } : {}),
          recipientSessionId: scenario === "wrong_session" ? sessionId : task.childSessionId,
          triggerTurn: scenario !== "queue_only", message: { role: "user", content: "Old durable mailbox" } } });
      await f.first.claimAgentMailboxMessage({ messageId, eventId: id(), time: Date.now() });
      const current = (await f.first.agentTask(task.taskId))!;
      const result = await f.first.beginAgentTaskRunCas({
        taskId: task.taskId, expectedGeneration: current.generation, expectedRunId: current.currentRunId as never,
        expectedLeaseOwner: current.leaseOwner ?? null, runId: id() as never, generation: current.generation + 1,
        leaseOwner: "task-followup:legacy", leaseTtlMs: 60_000, spawnEventId: id(), sourceMailboxMessageId: messageId, time: Date.now(),
      });
      expect(result.applied).toBe(scenario === "valid");
      const message = (await f.first.agentMailbox({ messageId }))[0]!;
      if (scenario === "valid") {
        expect(message.taskId).toBe(task.taskId);
        expect(result.events.some((event) => event.type === "agent.message_claimed" && event.payload.taskId === task.taskId)).toBe(true);
        replay = new SqliteEventStore(":memory:");
        await replay.appendMany(await f.first.events({ limit: 1000 }) as import("@chili/protocol").ChiliEvent[]);
        expect((await replay.agentMailbox({ messageId }))[0]?.taskId).toBe(task.taskId);
      } else {
        expect(message.taskId as string | undefined).toBe(scenario === "wrong_task" ? "different_task" : undefined);
        expect((await f.first.agentTask(task.taskId))?.generation).toBe(current.generation);
      }
    } finally {
      replay?.close();
      await manager.shutdown();
      await f.close();
    }
  }
});
