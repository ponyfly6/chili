import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type {
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  MessagePart,
  SessionId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import type { ApprovalRow, EventAppendOptions, EventQuery, EventStore, SessionRow } from "@chili/store";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import type { AgentRunner, AppendUserMessageInput, CreateSessionInput, RunTurnInput, RunTurnResult } from "./runner.js";
import {
  AgentRunnerSubagentRunner,
  LocalSubagentManager,
  type LocalSubagentRunInput,
} from "./subagent.js";

test("spawns a local subagent and records lifecycle events", async () => {
  const store = new MemoryEventStore();
  let runInput: LocalSubagentRunInput | undefined;
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    runner: {
      async run(input) {
        runInput = input;
        return { status: "completed", summary: "read it" };
      },
    },
  });

  const result = await manager.spawnTask({
    parentSessionId: "session_parent" as SessionId,
    cwd: "/repo",
    taskName: "reader",
    prompt: "Read README",
  });

  expect(result).toMatchObject({
    taskId: "task_1",
    runId: "agent_2",
    path: "/root/task_1",
    parentPath: "/root",
    childSessionId: "session_3",
    status: "completed",
    summary: "read it",
  });
  expect(runInput).toMatchObject({
    taskId: "task_1",
    runId: "agent_2",
    path: "/root/task_1",
    parentSessionId: "session_parent",
    childSessionId: "session_3",
    cwd: "/repo",
    taskName: "reader",
    prompt: "Read README",
    generation: 1,
  });
  expect(store.items.map((event) => event.type)).toEqual([
    "agent.task_created",
    "agent.spawned",
    "agent.task_completed",
    "agent.completed",
  ]);
  expect(store.items[0]).toMatchObject({
    sessionId: "session_parent",
    payload: {
      taskId: "task_1",
      path: "/root/task_1",
      parentPath: "/root",
      parentSessionId: "session_parent",
      childSessionId: "session_3",
      taskName: "reader",
      cwd: "/repo",
      prompt: "Read README",
      mode: "one_shot",
    },
  });
  expect(store.items[1]).toMatchObject({
    sessionId: "session_parent",
    payload: {
      runId: "agent_2",
      taskId: "task_1",
      path: "/root/task_1",
      parentPath: "/root",
      taskName: "reader",
      generation: 1,
    },
  });
  expect(store.items[2]).toMatchObject({
    payload: {
      taskId: "task_1",
      runId: "agent_2",
      path: "/root/task_1",
      status: "completed",
      generation: 1,
      summary: "read it",
    },
  });
  expect(store.items[3]).toMatchObject({
    sessionId: "session_parent",
    payload: {
      runId: "agent_2",
      taskId: "task_1",
      path: "/root/task_1",
      status: "completed",
      generation: 1,
      summary: "read it",
    },
  });
});

test("shutdown publishes one promise before a runner abort listener reenters", async () => {
  const store = new MemoryEventStore();
  const runnerStarted = deferred<void>();
  let manager!: LocalSubagentManager;
  let reentrantShutdown: Promise<void> | undefined;
  let abortCallbacks = 0;
  let runnerCleanups = 0;

  manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    runner: {
      async run(input) {
        const signal = input.signal;
        if (!signal) throw new Error("Expected a shutdown-linked runner signal");
        runnerStarted.resolve(undefined);
        try {
          await new Promise<void>((_resolve, reject) => {
            const onAbort = (): void => {
              abortCallbacks++;
              reentrantShutdown = manager.shutdown();
              reject(abortTestError());
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
          throw new Error("Runner unexpectedly settled without aborting");
        } finally {
          runnerCleanups++;
        }
      },
    },
  });

  await manager.spawnTask({
    parentSessionId: "session_shutdown_reentry" as SessionId,
    cwd: "/repo",
    taskName: "shutdown reentry",
    prompt: "Wait for shutdown",
    mode: "background",
  });
  await runnerStarted.promise;

  const shutdown = manager.shutdown();
  expect(reentrantShutdown).toBe(shutdown);
  expect(manager.shutdown()).toBe(shutdown);
  await shutdown;

  expect(abortCallbacks).toBe(1);
  expect(runnerCleanups).toBe(1);
  expect(store.items.filter((event) => event.type === "agent.task_completed")).toHaveLength(1);
  expect(store.items.filter((event) => event.type === "agent.completed")).toHaveLength(1);
});

test("redacts and bounds hostile subagent failures before publishing completion events", async () => {
  const store = new MemoryEventStore();
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    runner: {
      async run() {
        return { status: "failed", error: hostilePersistenceError("subagent provider failed") };
      },
    },
  });

  const result = await manager.spawnTask({
    parentSessionId: "session_hostile_failure" as SessionId,
    cwd: "/repo",
    taskName: "hostile failure",
    prompt: "Fail safely",
  });

  expect(result.status).toBe("failed");
  expectPersistenceSafeDiagnostic(result.error?.message);
  expect((result.error as Error & { code?: string }).code).toBe("TOKEN_INVALIDATED");
  const completionEvents = store.items.filter(
    (event) => event.type === "agent.task_completed" || event.type === "agent.completed",
  );
  expect(completionEvents).toHaveLength(2);
  for (const event of completionEvents) {
    expectPersistenceSafeDiagnostic(event.payload.error);
    expect(jsonByteLength(event)).toBeLessThanOrEqual(128 * 1024);
  }
});

test("bounds hostile subagent summaries without redacting ordinary authored content", async () => {
  const store = new MemoryEventStore();
  const summaryPrefix =
    `Ordinary summary keeps ${HOSTILE_PERSISTENCE_SECRET} and `
    + `http://127.0.0.1:4317/result?token=${HOSTILE_PERSISTENCE_SECRET}.\n`;
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    runner: {
      async run() {
        return { status: "completed", summary: `${summaryPrefix}${hostileWorstEscapedText()}` };
      },
    },
  });

  const result = await manager.spawnTask({
    parentSessionId: "session_hostile_summary" as SessionId,
    cwd: "/repo",
    taskName: "hostile summary",
    prompt: "Complete safely",
  });

  expect(result.status).toBe("completed");
  expect(result.summary?.startsWith(summaryPrefix)).toBe(true);
  expect(result.summary).not.toContain("[REDACTED]");
  const completionEvents = store.items.filter(
    (event) => event.type === "agent.task_completed" || event.type === "agent.completed",
  );
  expect(completionEvents).toHaveLength(2);
  for (const event of completionEvents) {
    expect(event.payload.summary?.startsWith(summaryPrefix)).toBe(true);
    expect(event.payload.summary).not.toContain("[REDACTED]");
    expect(jsonByteLength(event)).toBeLessThanOrEqual(80 * 1024);
  }
});

test("falls back to paired appends when an observable inner store has no CAS capability", async () => {
  const inner = new MemoryEventStore();
  const store = new ObservableEventStore(inner);
  const observed: ChiliEvent[] = [];
  const unsubscribe = store.subscribe((event) => observed.push(event));
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    runner: {
      async run() {
        return { status: "completed", summary: "done" };
      },
    },
  });

  try {
    await manager.spawnTask({
      parentSessionId: "session_parent" as SessionId,
      cwd: "/repo",
      taskName: "observable fallback",
      prompt: "Finish",
    });

    expect(inner.items.map((event) => event.type)).toEqual([
      "agent.task_created",
      "agent.spawned",
      "agent.task_completed",
      "agent.completed",
    ]);
    expect(observed.map((event) => event.type)).toEqual(inner.items.map((event) => event.type));
  } finally {
    unsubscribe();
  }
});

test("runs a child task through an AgentRunner", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeChildRunner(store);
  const subagentRunner = new AgentRunnerSubagentRunner({
    runner,
    store,
    maxTurns: 2,
  });

  const result = await subagentRunner.run({
    taskId: "task_child" as never,
    runId: "agent_child" as never,
    path: "/root/task_child",
    parentPath: "/root",
    parentSessionId: "session_parent" as SessionId,
    childSessionId: "session_child" as SessionId,
    cwd: "/repo",
    taskName: "reader",
    prompt: "Read README",
    generation: 1,
  });

  expect(result).toEqual({
    status: "completed",
    summary: "child answer",
  });
  expect(runner.createInputs).toEqual([
    {
      sessionId: "session_child" as SessionId,
      cwd: "/repo",
    },
  ]);
  expect(runner.userMessages).toEqual([
    {
      sessionId: "session_child" as SessionId,
      text: "Read README",
    },
  ]);
  expect(runner.turnInputs[0]).toMatchObject({
    sessionId: "session_child",
    cwd: "/repo",
    system: [
      "You are a local Chili subagent. Work in the assigned repository scope, keep results concise, and return a clear final summary.",
    ],
    developer: [
      "Subagent task id: task_child. Repository cwd: /repo. Agent path: /root/task_child (logical agent identifier, not a filesystem path). Use repository-relative paths, or absolute paths under the repository cwd; never prefix file paths with the agent path. When the task is complete, either provide a final concise answer or call complete_task with this task id and a clear summary.",
    ],
  });
});

test("repairs a planning-only child response once and accepts the concrete result", async () => {
  const store = new MemoryEventStore();
  const runner = new ScriptedChildRunner(store, [
    { text: "I'll inspect the repository next." },
    { text: "Found the bug in src/index.ts and verified the focused test passes." },
  ]);
  const subagentRunner = new AgentRunnerSubagentRunner({ runner, store, maxTurns: 1 });

  const result = await subagentRunner.run(localRunInput());

  expect(result).toEqual({
    status: "completed",
    summary: "Found the bug in src/index.ts and verified the focused test passes.",
  });
  expect(runner.turnInputs).toHaveLength(2);
  expect(runner.userMessages).toHaveLength(2);
  expect(runner.userMessages[1]?.text).toContain("previous response was incomplete");
  expect(runner.userMessages[1]?.text).toContain("only described work you intended to do");
});

test("marks a child incomplete after its one repair is still planning-only", async () => {
  const store = new MemoryEventStore();
  const runner = new ScriptedChildRunner(store, [
    { text: "I'll inspect the repository next." },
    { text: "Let me start by reading the source." },
  ]);
  const subagentRunner = new AgentRunnerSubagentRunner({ runner, store, maxTurns: 1 });

  const result = await subagentRunner.run(localRunInput());

  expect(result).toMatchObject({
    status: "incomplete",
    summary: "Let me start by reading the source.",
    error: { message: "Subagent completion incomplete: planning_only" },
  });
  expect(runner.turnInputs).toHaveLength(2);
  expect(runner.userMessages).toHaveLength(2);
});

test("marks an invalid max-turn final response incomplete", async () => {
  const store = new MemoryEventStore();
  const runner = new ScriptedChildRunner(store, [
    { finishReason: "tool_use" },
    { text: "I'll continue investigating next." },
  ]);
  const subagentRunner = new AgentRunnerSubagentRunner({ runner, store, maxTurns: 1 });

  const result = await subagentRunner.run(localRunInput());

  expect(result).toMatchObject({
    status: "incomplete",
    summary: "I'll continue investigating next.",
    error: { message: "Subagent completion incomplete: planning_only" },
  });
  expect(runner.turnInputs.at(-1)).toMatchObject({ toolMode: "disabled" });
});

test("tracks background subagent tasks until they complete", async () => {
  const store = new MemoryEventStore();
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    runner: {
      async run() {
        await Promise.resolve();
        return { status: "completed", summary: "background done" };
      },
    },
  });

  const task = await manager.spawnTask({
    parentSessionId: "session_parent" as SessionId,
    cwd: "/repo",
    taskName: "background reader",
    prompt: "Read README",
    mode: "background",
  });

  expect(task).toMatchObject({
    taskId: "task_1",
    status: "pending",
  });
  await manager.waitForBackgroundTasks();
  expect(store.items.at(-2)).toMatchObject({
    type: "agent.task_completed",
    payload: { taskId: "task_1", status: "completed", summary: "background done" },
  });
  expect(store.items.at(-1)).toMatchObject({
    type: "agent.completed",
    payload: { taskId: "task_1", status: "completed", summary: "background done" },
  });
});

test("background subagents run under a durable task lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-lease-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  let runGeneration: number | undefined;
  let leaseOwner: string | undefined;
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 100 as TimestampMs,
    leaseTtlMs: 90,
    leaseHeartbeatIntervalMs: 20,
    runner: {
      async run(input) {
        runGeneration = input.generation;
        leaseOwner = (await store.agentTask(input.taskId))?.leaseOwner;
        return { status: "completed", summary: "background done" };
      },
    },
  });

  try {
    const task = await manager.spawnTask({
      parentSessionId: "session_parent" as SessionId,
      cwd: "/repo",
      taskName: "background reader",
      prompt: "Read README",
      mode: "background",
    });

    await manager.waitForBackgroundTasks();

    expect(runGeneration).toBe(2);
    expect(leaseOwner).toBe("local:agent_2");
    expect(await store.agentTask(task.taskId)).toMatchObject({
      id: task.taskId,
      status: "completed",
      generation: 2,
      summary: "background done",
    });
    expect((await store.agentTask(task.taskId))?.leaseOwner).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an initial lease that expires during the post-spawn gate cannot start the runner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-pre-run-lease-expiry-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  let now = 100;
  let delegationChecks = 0;
  let runnerCalls = 0;
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => now as TimestampMs,
    leaseTtlMs: 10,
    leaseHeartbeatIntervalMs: 1_000,
    assertDelegationEnabled: async () => {
      delegationChecks++;
      if (delegationChecks === 3) now = 111;
    },
    runner: {
      async run() {
        runnerCalls++;
        return { status: "completed", summary: "must not run" };
      },
    },
  });

  try {
    const result = await manager.spawnTask({
      parentSessionId: "session_parent" as SessionId,
      cwd: "/repo",
      taskName: "expired before runner",
      prompt: "Do not start after ownership expires",
    });

    expect(delegationChecks).toBe(3);
    expect(runnerCalls).toBe(0);
    expect(result).toMatchObject({ status: "cancelled" });
    expect(await store.agentTask(result.taskId)).toMatchObject({
      status: "cancelled",
      generation: 3,
      error: expect.stringContaining("lease lost"),
    });
    expect((await store.events({ type: "agent.task_completed", limit: 10 }))).toHaveLength(1);
    expect((await store.events({ type: "agent.completed", limit: 10 }))).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("background subagents abort when an external close invalidates the lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-lease-close-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  let started!: () => void;
  let abortSeen = false;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 100 as TimestampMs,
    leaseTtlMs: 90,
    leaseHeartbeatIntervalMs: 2,
    runner: {
      async run(input) {
        started();
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              abortSeen = true;
              resolve();
            },
            { once: true },
          );
        });
        return { status: "completed", summary: "late completion" };
      },
    },
  });

  try {
    const task = await manager.spawnTask({
      parentSessionId: "session_parent" as SessionId,
      cwd: "/repo",
      taskName: "background reader",
      prompt: "Read README",
      mode: "background",
    });
    await startedPromise;
    const leasedTask = await store.agentTask(task.taskId);
    expect(leasedTask).toMatchObject({
      status: "running",
      generation: 2,
      leaseOwner: "local:agent_2",
    });

    if (!leasedTask) throw new Error("Expected a leased task projection");
    const closed = await store.closeAgentTaskCas({
      taskId: task.taskId,
      status: "cancelled",
      eventId: "event_external_close",
      agentEventId: "event_external_agent_close",
      expectedGeneration: leasedTask.generation,
      expectedRunId: task.runId,
      expectedLeaseOwner: leasedTask.leaseOwner ?? null,
      summary: "external close",
      sessionId: "session_parent" as SessionId,
      time: 101,
    });
    expect(closed.applied).toBe(true);

    await waitUntil(() => abortSeen);
    await manager.waitForBackgroundTasks();

    expect(await store.agentTask(task.taskId)).toMatchObject({
      id: task.taskId,
      status: "cancelled",
      generation: 3,
      summary: "external close",
    });
    expect((await store.events({ type: "agent.task_completed", limit: 10 })).map((event) => event.id)).toEqual([
      "event_external_close",
    ]);
    expect((await store.events({ type: "agent.completed", limit: 10 })).map((event) => event.id)).toEqual([
      "event_external_agent_close",
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lease loss detaches the stale runner without closing the takeover generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-lease-loss-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  let now = 100;
  let started!: () => void;
  let abortSeen = false;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => now as TimestampMs,
    leaseTtlMs: 90,
    leaseHeartbeatIntervalMs: 2,
    runner: {
      async run(input) {
        started();
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => {
            abortSeen = true;
            resolve();
          }, { once: true });
        });
        return { status: "completed", summary: "late completion" };
      },
    },
  });

  try {
    const task = await manager.spawnTask({
      parentSessionId: "session_parent" as SessionId,
      cwd: "/repo",
      taskName: "lease loser",
      prompt: "Wait",
      mode: "background",
    });
    await startedPromise;
    const leasedTask = await store.agentTask(task.taskId);
    expect(leasedTask).toMatchObject({ status: "running", generation: 2 });
    if (!leasedTask) throw new Error("Expected the running task lease projection");

    now = 200;
    const takeover = await store.claimAgentTaskLease({
      taskId: task.taskId,
      runId: task.runId,
      generation: leasedTask.generation,
      owner: "external-owner",
      ttlMs: 90,
      now,
    });
    expect(takeover.acquired).toBe(true);

    await waitUntil(() => abortSeen);
    await manager.waitForBackgroundTasks();

    expect(await store.agentTask(task.taskId)).toMatchObject({
      status: "running",
      generation: 3,
      currentRunId: task.runId,
      leaseOwner: "external-owner",
    });
    expect(await store.agentRuns({ taskId: task.taskId })).toEqual([
      expect.objectContaining({ id: task.runId, status: "running" }),
    ]);
    expect(await store.events({ type: "agent.task_completed", limit: 10 })).toEqual([]);
    expect(await store.events({ type: "agent.completed", limit: 10 })).toEqual([]);
    expect(manager.runStats()).toMatchObject({ activeRuns: 0, queuedRuns: 0, backgroundTasks: 0 });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an expired lease closes its own generation when no takeover occurred", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-lease-expiry-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  let now = 100;
  let started!: () => void;
  let abortSeen = false;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => now as TimestampMs,
    leaseTtlMs: 50,
    leaseHeartbeatIntervalMs: 2,
    runner: {
      async run(input) {
        started();
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => {
            abortSeen = true;
            resolve();
          }, { once: true });
        });
        return { status: "completed", summary: "late completion" };
      },
    },
  });

  try {
    const task = await manager.spawnTask({
      parentSessionId: "session_parent" as SessionId,
      cwd: "/repo",
      taskName: "expired owner",
      prompt: "Wait",
      mode: "background",
    });
    await startedPromise;
    expect(await store.agentTask(task.taskId)).toMatchObject({
      status: "running",
      generation: 2,
      leaseOwner: "local:agent_2",
      leaseExpiresAt: 150,
    });

    now = 150;
    await waitUntil(() => abortSeen);
    await manager.waitForBackgroundTasks();

    expect(await store.agentTask(task.taskId)).toMatchObject({
      status: "cancelled",
      generation: 3,
      error: `Local subagent task lease lost: ${task.taskId}`,
    });
    expect(await store.events({ type: "agent.task_completed", limit: 10 })).toHaveLength(1);
    expect(await store.events({ type: "agent.completed", limit: 10 })).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("background subagents suppress completion when external close wins before heartbeat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-lease-race-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  let started!: () => void;
  let finish!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const finishPromise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 100 as TimestampMs,
    leaseTtlMs: 90,
    leaseHeartbeatIntervalMs: 1_000,
    runner: {
      async run() {
        started();
        await finishPromise;
        return { status: "completed", summary: "late completion" };
      },
    },
  });

  try {
    const task = await manager.spawnTask({
      parentSessionId: "session_parent" as SessionId,
      cwd: "/repo",
      taskName: "background reader",
      prompt: "Read README",
      mode: "background",
    });
    await startedPromise;
    const leasedTask = await store.agentTask(task.taskId);

    if (!leasedTask) throw new Error("Expected a leased task projection");
    const closed = await store.closeAgentTaskCas({
      taskId: task.taskId,
      status: "cancelled",
      eventId: "event_external_close_before_finish",
      agentEventId: "event_external_agent_close_before_finish",
      expectedGeneration: leasedTask.generation,
      expectedRunId: task.runId,
      expectedLeaseOwner: leasedTask.leaseOwner ?? null,
      summary: "external close",
      sessionId: "session_parent" as SessionId,
      time: 101,
    });
    expect(closed.applied).toBe(true);

    finish();
    await manager.waitForBackgroundTasks();

    expect(await store.agentTask(task.taskId)).toMatchObject({
      id: task.taskId,
      status: "cancelled",
      generation: 3,
      summary: "external close",
    });
    expect((await store.events({ type: "agent.task_completed", limit: 10 })).map((event) => event.id)).toEqual([
      "event_external_close_before_finish",
    ]);
    expect((await store.events({ type: "agent.completed", limit: 10 })).map((event) => event.id)).toEqual([
      "event_external_agent_close_before_finish",
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("complete_task completes a leased local background task without leaking the lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-lease-complete-tool-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 100 as TimestampMs,
    leaseTtlMs: 90,
    leaseHeartbeatIntervalMs: 20,
    runner: {
      async run(input) {
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
        return { status: "completed", summary: "late completion" };
      },
    },
  });

  try {
    const task = await manager.spawnTask({
      parentSessionId: "session_parent" as SessionId,
      cwd: "/repo",
      taskName: "background reader",
      prompt: "Read README",
      mode: "background",
    });

    await waitUntil(async () => Boolean((await store.agentTask(task.taskId))?.leaseOwner));
    await manager.completeTask({ taskId: task.taskId, summary: "tool summary" });
    await manager.waitForBackgroundTasks();

    expect(await store.agentTask(task.taskId)).toMatchObject({
      id: task.taskId,
      status: "completed",
      generation: 2,
      summary: "tool summary",
    });
    expect((await store.agentTask(task.taskId))?.leaseOwner).toBeUndefined();
    expect((await store.events({ type: "agent.completed", limit: 10 })).at(-1)).toMatchObject({
      payload: {
        taskId: task.taskId,
        status: "completed",
        generation: 2,
        summary: "tool summary",
      },
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("complete_task fails for unknown local subagent tasks", async () => {
  const store = new MemoryEventStore();
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    runner: {
      async run() {
        return { status: "completed", summary: "done" };
      },
    },
  });

  await expect(
    manager.completeTask({
      taskId: "task_missing",
      summary: "done",
    }),
  ).rejects.toThrow("No active local subagent task: task_missing");
});

test("complete_task completes a local background task without abort overriding it", async () => {
  const store = new MemoryEventStore();
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    runner: {
      async run(input) {
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
        return { status: "completed", summary: "late completion" };
      },
    },
  });

  const task = await manager.spawnTask({
    parentSessionId: "session_parent" as SessionId,
    cwd: "/repo",
    taskName: "background reader",
    prompt: "Read README",
    mode: "background",
  });

  await waitUntil(() => store.items.some((event) =>
    event.type === "agent.spawned" && event.payload.taskId === task.taskId));
  const completion = await manager.completeTask({
    taskId: task.taskId,
    summary: "tool summary",
  });
  await manager.waitForBackgroundTasks();

  expect(completion).toEqual({
    taskId: "task_1",
    summary: "tool summary",
    status: "completed",
  });
  expect(store.items.map((event) => event.type)).toEqual([
    "agent.task_created",
    "agent.spawned",
    "agent.task_completed",
    "agent.completed",
  ]);
  expect(store.items.at(-1)).toMatchObject({
    type: "agent.completed",
    payload: { taskId: "task_1", status: "completed", summary: "tool summary" },
  });
});

test("complete_task commits paired terminal projections before an abort-ignoring runner settles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-complete-hung-runner-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const firstGate = deferred<void>();
  const started: string[] = [];
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 100 as TimestampMs,
    maxActiveRuns: 1,
    leaseTtlMs: 100,
    leaseHeartbeatIntervalMs: 1_000,
    runner: {
      async run(input) {
        started.push(input.taskName);
        if (input.taskName === "first") await firstGate.promise;
        return { status: "completed", summary: `${input.taskName} runner result` };
      },
    },
  });

  try {
    const first = await manager.spawnTask({
      parentSessionId: "session_parent" as SessionId,
      cwd: "/repo",
      taskName: "first",
      prompt: "Wait even after abort",
      mode: "background",
    });
    await waitUntil(() => started.length === 1);
    const second = await manager.spawnTask({
      parentSessionId: "session_parent" as SessionId,
      cwd: "/repo",
      taskName: "second",
      prompt: "Run after first settles",
      mode: "background",
    });
    await waitUntil(() => manager.runStats().queuedRuns === 1);

    await manager.completeTask({ taskId: first.taskId, summary: "tool result" });

    expect(await store.agentTask(first.taskId)).toMatchObject({
      status: "completed",
      summary: "tool result",
      generation: 2,
    });
    expect(await store.agentRuns({ taskId: first.taskId })).toEqual([
      expect.objectContaining({ id: first.runId, status: "completed" }),
    ]);
    expect(((await store.events({ type: "agent.task_completed", limit: 20 })) as ChiliEvent[]).filter(
      (event) => event.type === "agent.task_completed" && event.payload.taskId === first.taskId,
    )).toHaveLength(1);
    expect(((await store.events({ type: "agent.completed", limit: 20 })) as ChiliEvent[]).filter(
      (event) => event.type === "agent.completed" && event.payload.taskId === first.taskId,
    )).toHaveLength(1);
    expect(started).toEqual(["first"]);
    expect(manager.runStats()).toMatchObject({ activeRuns: 1, queuedRuns: 1, backgroundTasks: 2 });

    firstGate.resolve();
    await manager.waitForBackgroundTasks();

    expect(started).toEqual(["first", "second"]);
    expect(await store.agentTask(second.taskId)).toMatchObject({ status: "completed" });
    expect(((await store.events({ type: "agent.task_completed", limit: 20 })) as ChiliEvent[]).filter(
      (event) => event.type === "agent.task_completed" && event.payload.taskId === first.taskId,
    )).toHaveLength(1);
    expect(((await store.events({ type: "agent.completed", limit: 20 })) as ChiliEvent[]).filter(
      (event) => event.type === "agent.completed" && event.payload.taskId === first.taskId,
    )).toHaveLength(1);
  } finally {
    firstGate.resolve();
    await manager.waitForBackgroundTasks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("complete_task coerces a planning-only completed summary to incomplete", async () => {
  const store = new MemoryEventStore();
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    runner: {
      async run(input) {
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(abortTestError()), { once: true });
        });
        return { status: "completed", summary: "late completion" };
      },
    },
  });
  const task = await manager.spawnTask({
    parentSessionId: "session_parent" as SessionId,
    cwd: "/repo",
    taskName: "background reader",
    prompt: "Read README",
    mode: "background",
  });
  await waitUntil(() => store.items.some((event) =>
    event.type === "agent.spawned" && event.payload.taskId === task.taskId));

  const completion = await manager.completeTask({
    taskId: task.taskId,
    summary: "I'll inspect the repository next.",
  });
  await manager.waitForBackgroundTasks();

  expect(completion).toEqual({
    taskId: task.taskId,
    status: "incomplete",
    summary: "I'll inspect the repository next.",
  });
  expect(store.items.filter((event) => event.type === "agent.task_completed")).toHaveLength(1);
  expect(store.items.filter((event) => event.type === "agent.completed")).toHaveLength(1);
  expect(store.items.at(-1)).toMatchObject({
    type: "agent.completed",
    payload: {
      taskId: task.taskId,
      status: "incomplete",
      error: "Subagent completion incomplete: planning_only",
    },
  });
});

test("external interrupt prevents a late background subagent completion", async () => {
  const store = new MemoryEventStore();
  let finish!: () => void;
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    runner: {
      async run() {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { status: "completed", summary: "late completion" };
      },
    },
  });

  const task = await manager.spawnTask({
    parentSessionId: "session_parent" as SessionId,
    cwd: "/repo",
    taskName: "background reader",
    prompt: "Read README",
    mode: "background",
  });

  await waitUntil(() => store.items.some((event) =>
    event.type === "agent.spawned" && event.payload.taskId === task.taskId));
  expect(await manager.interruptTask(task.taskId)).toBe(true);
  finish();
  await manager.waitForBackgroundTasks();
  expect(store.items.map((event) => event.type)).toEqual([
    "agent.task_created",
    "agent.spawned",
    "agent.task_completed",
    "agent.completed",
  ]);
});

for (const cap of [1, 2]) {
  test(`limits five background runner lifetimes to batch concurrency ${cap}`, async () => {
    const store = new MemoryEventStore();
    const gate = deferred<void>();
    let active = 0;
    let maxActive = 0;
    const started: string[] = [];
    const manager = new LocalSubagentManager({
      store,
      createId: createSequentialId(),
      maxActiveRuns: 5,
      runner: {
        async run(input) {
          active++;
          maxActive = Math.max(maxActive, active);
          started.push(input.taskName);
          await gate.promise;
          active--;
          return { status: "completed", summary: `${input.taskName} done` };
        },
      },
    });

    const handles = [];
    for (let index = 0; index < 5; index++) {
      handles.push(await manager.spawnTask({
        parentSessionId: "session_parent" as SessionId,
        cwd: "/repo",
        taskName: `task ${index}`,
        prompt: `Run task ${index}`,
        mode: "background",
        batchId: `batch_cap_${cap}`,
        batchIndex: index,
        expectedBatchSize: 5,
        maxConcurrency: cap,
        completionPolicy: "join",
      }));
    }

    expect(handles.map((handle) => handle.status)).toEqual(Array(5).fill("pending"));
    await waitUntil(() => started.length === cap);
    expect(maxActive).toBe(cap);
    expect(store.items.filter((event) => event.type === "agent.spawned")).toHaveLength(cap);
    expect(manager.runStats()).toMatchObject({
      maxActiveRuns: 5,
      activeRuns: cap,
      queuedRuns: 5 - cap,
      peakActiveRuns: cap,
      backgroundTasks: 5,
    });

    gate.resolve();
    await manager.waitForBackgroundTasks();

    expect(started).toHaveLength(5);
    expect(maxActive).toBe(cap);
    expect(manager.runStats()).toMatchObject({
      activeRuns: 0,
      queuedRuns: 0,
      peakActiveRuns: cap,
      backgroundTasks: 0,
    });
  });
}

test("applies the global cap across multiple batches and unbatched background tasks", async () => {
  const store = new MemoryEventStore();
  const gate = deferred<void>();
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    maxActiveRuns: 3,
    runner: {
      async run(input) {
        active++;
        started++;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active--;
        return { status: "completed", summary: `${input.taskName} done` };
      },
    },
  });

  const inputs = [
    { taskName: "batch a 1", batchId: "batch_a", batchIndex: 0, maxConcurrency: 2 },
    { taskName: "batch a 2", batchId: "batch_a", batchIndex: 1, maxConcurrency: 2 },
    { taskName: "batch b 1", batchId: "batch_b", batchIndex: 0, maxConcurrency: 2 },
    { taskName: "batch b 2", batchId: "batch_b", batchIndex: 1, maxConcurrency: 2 },
    { taskName: "single 1" },
    { taskName: "single 2" },
  ];
  for (const input of inputs) {
    await manager.spawnTask({
      parentSessionId: "session_parent" as SessionId,
      cwd: "/repo",
      prompt: input.taskName,
      mode: "background",
      ...input,
    });
  }

  await waitUntil(() => started === 3);
  expect(maxActive).toBe(3);
  expect(manager.runStats()).toMatchObject({
    maxActiveRuns: 3,
    activeRuns: 3,
    queuedRuns: 3,
    peakActiveRuns: 3,
  });

  gate.resolve();
  await manager.waitForBackgroundTasks();
  expect(started).toBe(6);
  expect(maxActive).toBe(3);
  expect(manager.runStats()).toMatchObject({ activeRuns: 0, queuedRuns: 0, backgroundTasks: 0 });
});

test("releases a lifecycle permit after a runner throws", async () => {
  const store = new MemoryEventStore();
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    maxActiveRuns: 1,
    runner: {
      async run(input) {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          if (input.taskName === "fails") throw new Error("runner start failed");
          return { status: "completed", summary: "done" };
        } finally {
          active--;
        }
      },
    },
  });

  for (const taskName of ["fails", "next", "last"]) {
    await manager.spawnTask({
      parentSessionId: "session_parent" as SessionId,
      cwd: "/repo",
      taskName,
      prompt: taskName,
      mode: "background",
    });
  }
  await manager.waitForBackgroundTasks();

  expect(calls).toBe(3);
  expect(maxActive).toBe(1);
  expect(store.items.filter((event) => event.type === "agent.task_completed").map((event) => event.payload.status))
    .toEqual(["failed", "completed", "completed"]);
  expect(store.items.filter((event) => event.type === "agent.completed")).toHaveLength(3);
  expect(manager.runStats()).toMatchObject({ activeRuns: 0, queuedRuns: 0, peakActiveRuns: 1 });
});

test("cancels a queued task without spawning its runner and releases its queue slot", async () => {
  const store = new MemoryEventStore();
  const firstGate = deferred<void>();
  const started: string[] = [];
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    maxActiveRuns: 1,
    runner: {
      async run(input) {
        started.push(input.taskName);
        if (input.taskName === "first") await firstGate.promise;
        return { status: "completed", summary: `${input.taskName} done` };
      },
    },
  });

  const first = await manager.spawnTask({
    parentSessionId: "session_parent" as SessionId,
    cwd: "/repo",
    taskName: "first",
    prompt: "first",
    mode: "background",
  });
  await waitUntil(() => started.length === 1);
  const queued = await manager.spawnTask({
    parentSessionId: "session_parent" as SessionId,
    cwd: "/repo",
    taskName: "queued",
    prompt: "queued",
    mode: "background",
  });
  await waitUntil(() => manager.runStats().queuedRuns === 1);

  expect(queued.status).toBe("pending");
  expect(await manager.interruptTask(queued.taskId)).toBe(true);
  expect(started).toEqual(["first"]);
  expect(store.items.filter((event) =>
    event.type === "agent.spawned" && event.payload.taskId === queued.taskId)).toHaveLength(0);
  expect(store.items.filter((event) =>
    event.type === "agent.task_completed" && event.payload.taskId === queued.taskId)).toHaveLength(1);
  expect(store.items.filter((event) =>
    event.type === "agent.completed" && event.payload.taskId === queued.taskId)).toHaveLength(0);

  firstGate.resolve();
  await manager.waitForBackgroundTasks();
  expect(started).toEqual(["first"]);
  expect(store.items.filter((event) =>
    event.type === "agent.task_completed" && event.payload.taskId === first.taskId)).toHaveLength(1);
  expect(manager.runStats()).toMatchObject({ activeRuns: 0, queuedRuns: 0, backgroundTasks: 0 });
});

test("an interrupt during the delegation gate cannot append a ghost spawn", async () => {
  const store = new MemoryEventStore();
  const gate = deferred<void>();
  const gateEntered = deferred<void>();
  let runnerCalls = 0;
  let delegationChecks = 0;
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    assertDelegationEnabled: async () => {
      delegationChecks++;
      if (delegationChecks === 1) return;
      gateEntered.resolve();
      await gate.promise;
    },
    runner: {
      async run() {
        runnerCalls++;
        return { status: "completed", summary: "unexpected" };
      },
    },
  });

  const task = await manager.spawnTask({
    parentSessionId: "session_parent" as SessionId,
    cwd: "/repo",
    taskName: "gated",
    prompt: "Wait at policy gate",
    mode: "background",
  });
  await gateEntered.promise;
  expect(await manager.interruptTask(task.taskId, { runId: null, generation: 0 })).toBe(true);
  gate.resolve();
  await manager.waitForBackgroundTasks();

  expect(runnerCalls).toBe(0);
  expect(store.items.filter((event) => event.type === "agent.spawned")).toEqual([]);
  expect(store.items.filter((event) => event.type === "agent.task_completed")).toHaveLength(1);
  expect(store.items.filter((event) => event.type === "agent.completed")).toEqual([]);
});

test("reserved task creation recovers the exact durable task and rejects identity reuse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-reserved-identity-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  let firstRuns = 0;
  let retryRuns = 0;
  const reserved = {
    dispatchId: "dispatch_reserved_identity",
    taskId: "task_reserved_identity" as never,
    runId: "agent_reserved_identity" as never,
    childSessionId: "session_reserved_identity_child" as SessionId,
    parentSessionId: "session_reserved_identity_parent" as SessionId,
    parentPath: "/root/worker" as const,
    cwd: "/repo",
    taskName: "reserved",
    prompt: "Perform the frozen work",
    mode: "one_shot" as const,
  };

  try {
    const first = new LocalSubagentManager({
      store,
      createId: createSequentialId(),
      runner: {
        async run() {
          firstRuns++;
          return { status: "completed", summary: "done" };
        },
      },
    });
    const created = await first.spawnTask(reserved);
    expect(created).toMatchObject({
      taskId: reserved.taskId,
      runId: reserved.runId,
      childSessionId: reserved.childSessionId,
      status: "completed",
    });

    const retry = new LocalSubagentManager({
      store,
      createId: createSequentialId(),
      runner: {
        async run() {
          retryRuns++;
          return { status: "completed", summary: "must not run" };
        },
      },
    });
    await expect(retry.spawnTask(reserved)).resolves.toMatchObject({
      taskId: reserved.taskId,
      runId: reserved.runId,
      status: "completed",
      summary: "done",
    });
    await expect(retry.spawnTask({ ...reserved, prompt: "Different work" })).rejects.toThrow(
      "different creation identity",
    );

    const firstCreation = (await store.events({ type: "agent.task_created" }))[0];
    if (!firstCreation || firstCreation.type !== "agent.task_created") throw new Error("missing creation event");
    const creationEvent = firstCreation as Extract<ChiliEvent, { type: "agent.task_created" }>;
    await expect(store.append({
      ...creationEvent,
      id: "event_conflicting_reserved_identity",
      payload: {
        ...creationEvent.payload,
        dispatchId: "dispatch_conflicting_identity",
        prompt: "Overwrite attempt",
      },
    })).rejects.toThrow("different creation identity");

    expect(firstRuns).toBe(1);
    expect(retryRuns).toBe(0);
    expect(await store.events({ type: "agent.task_created" })).toHaveLength(1);
    expect(await store.agentTask(reserved.taskId)).toMatchObject({
      dispatchId: reserved.dispatchId,
      reservedRunId: reserved.runId,
      prompt: reserved.prompt,
      summary: "done",
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reserved agent.task_created is owner-fenced and fails closed without atomic run claim", async () => {
  const store = new RecordingMemoryEventStore();
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    runner: { async run() { return { status: "completed" }; } },
  });
  const runClaim = {
    sessionId: "session_reserved_fence" as SessionId,
    claimId: "claim_reserved_fence",
  };

  await expect(manager.spawnTask({
    dispatchId: "dispatch_reserved_fence",
    taskId: "task_reserved_fence" as never,
    runId: "agent_reserved_fence" as never,
    childSessionId: "session_reserved_fence_child" as SessionId,
    parentSessionId: runClaim.sessionId,
    cwd: "/repo",
    taskName: "fenced",
    prompt: "fenced creation",
    runClaim,
  })).rejects.toThrow("requires atomic run-claim capability");

  expect(store.appends.find((item) => item.event.type === "agent.task_created")?.options).toEqual({ runClaim });
  expect(store.appends.find((item) => item.event.type === "agent.spawned")).toBeUndefined();
});

test("repeating a reserved background spawn in one manager returns the active task without scheduling twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-reserved-active-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const completion = deferred<void>();
  let runs = 0;
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    runner: {
      async run() {
        runs++;
        await completion.promise;
        return { status: "completed", summary: "once" };
      },
    },
  });
  const reserved = {
    dispatchId: "dispatch_reserved_active",
    taskId: "task_reserved_active" as never,
    runId: "agent_reserved_active" as never,
    childSessionId: "session_reserved_active_child" as SessionId,
    parentSessionId: "session_reserved_active_parent" as SessionId,
    cwd: "/repo",
    taskName: "active",
    prompt: "run once",
    mode: "background" as const,
  };

  try {
    const first = await manager.spawnTask(reserved);
    const second = await manager.spawnTask(reserved);
    expect(first).toMatchObject({ taskId: reserved.taskId, status: "pending" });
    expect(second).toMatchObject({ taskId: reserved.taskId });
    await waitUntil(() => runs === 1);
    expect(runs).toBe(1);
    expect(await store.events({ type: "agent.task_created" })).toHaveLength(1);

    completion.resolve();
    await manager.waitForBackgroundTasks();
    expect(runs).toBe(1);
    expect(await store.agentTask(reserved.taskId)).toMatchObject({ status: "completed", summary: "once" });
  } finally {
    completion.resolve();
    await manager.waitForBackgroundTasks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("two managers race to recover a pending reserved task but the durable lease starts only one runner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-pending-takeover-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const completion = deferred<void>();
  const ids = createSequentialId();
  let runs = 0;
  const reserved = {
    dispatchId: "dispatch_pending_takeover",
    taskId: "task_pending_takeover" as never,
    runId: "agent_pending_takeover" as never,
    childSessionId: "session_pending_takeover_child" as SessionId,
    parentSessionId: "session_pending_takeover_parent" as SessionId,
    parentPath: "/root" as const,
    cwd: "/repo",
    taskName: "pending takeover",
    prompt: "resume the durable pending task",
    mode: "one_shot" as const,
  };
  const runner = {
    async run() {
      runs++;
      await completion.promise;
      return { status: "completed" as const, summary: "taken over once" };
    },
  };

  try {
    await store.append({
      id: "event_seed_pending_takeover",
      type: "agent.task_created",
      time: 1 as TimestampMs,
      sessionId: reserved.parentSessionId,
      payload: {
        taskId: reserved.taskId,
        dispatchId: reserved.dispatchId,
        reservedRunId: reserved.runId,
        path: "/root/task_pending_takeover" as never,
        parentPath: reserved.parentPath,
        parentSessionId: reserved.parentSessionId,
        childSessionId: reserved.childSessionId,
        taskName: reserved.taskName,
        cwd: reserved.cwd,
        prompt: reserved.prompt,
        mode: reserved.mode,
      },
    });
    expect(await store.agentTask(reserved.taskId)).toMatchObject({ status: "pending", generation: 0 });

    const first = new LocalSubagentManager({ store, runner, createId: ids });
    const second = new LocalSubagentManager({ store, runner, createId: ids });
    const firstResult = first.spawnTask(reserved);
    const secondResult = second.spawnTask(reserved);
    await waitUntil(() => runs === 1);
    expect(runs).toBe(1);

    completion.resolve();
    await Promise.all([firstResult, secondResult]);
    expect(runs).toBe(1);
    expect(await store.events({ type: "agent.task_created" })).toHaveLength(1);
    expect(await store.agentTask(reserved.taskId)).toMatchObject({
      status: "completed",
      summary: "taken over once",
    });
  } finally {
    completion.resolve();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("two SQLite managers race a fresh reserved identity but create, spawn, and run it only once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-fresh-reserved-race-"));
  const dbPath = join(dir, "events.sqlite");
  const firstStore = new SqliteEventStore(dbPath);
  const secondStore = new SqliteEventStore(dbPath);
  const completion = deferred<void>();
  const attempts: Array<Promise<unknown>> = [];
  let runs = 0;
  let firstIds = 0;
  let secondIds = 0;
  const runner = {
    async run() {
      runs++;
      await completion.promise;
      return { status: "completed" as const, summary: "fresh reservation ran once" };
    },
  };
  const reservation = {
    dispatchId: "dispatch_fresh_reserved_race",
    taskId: "task_fresh_reserved_race" as never,
    runId: "agent_fresh_reserved_race" as never,
    childSessionId: "session_fresh_reserved_race_child" as SessionId,
    parentSessionId: "session_fresh_reserved_race_parent" as SessionId,
    parentPath: "/root" as const,
    cwd: "/repo",
    taskName: "fresh reserved race",
    prompt: "run the fresh reservation exactly once",
    mode: "one_shot" as const,
  };
  const first = new LocalSubagentManager({
    store: firstStore,
    runner,
    createId: (prefix) => `${prefix}_fresh_first_${++firstIds}`,
  });
  const second = new LocalSubagentManager({
    store: secondStore,
    runner,
    createId: (prefix) => `${prefix}_fresh_second_${++secondIds}`,
  });

  try {
    const firstAttempt = first.spawnTask({
      ...reservation,
      workerPolicy: {
        allowedTools: ["read", "grep"],
        writeScope: ["/repo/packages"],
        executeScope: [],
        metadata: { alpha: 1, nested: { left: true, right: false } },
      },
    });
    const secondAttempt = second.spawnTask({
      ...reservation,
      workerPolicy: {
        metadata: { nested: { right: false, left: true }, alpha: 1 },
        executeScope: [],
        writeScope: ["/repo/packages"],
        allowedTools: ["read", "grep"],
      },
    });
    attempts.push(firstAttempt, secondAttempt);

    await waitUntil(() => runs === 1, 1_000);
    expect(runs).toBe(1);
    expect(await firstStore.events({ type: "agent.task_created" })).toHaveLength(1);
    expect(await firstStore.events({ type: "agent.spawned" })).toHaveLength(1);

    completion.resolve();
    const results = await Promise.allSettled([firstAttempt, secondAttempt]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(runs).toBe(1);
    expect(await firstStore.events({ type: "agent.task_created" })).toHaveLength(1);
    expect(await firstStore.events({ type: "agent.spawned" })).toHaveLength(1);
    expect(await firstStore.agentTask(reservation.taskId)).toMatchObject({
      status: "completed",
      generation: 1,
      summary: "fresh reservation ran once",
    });
  } finally {
    completion.resolve();
    await Promise.allSettled(attempts);
    firstStore.close();
    secondStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a reserved retry observes a live durable lease without creating, spawning, or running again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-live-reserved-retry-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  let runs = 0;
  const reserved = {
    dispatchId: "dispatch_live_reserved_retry",
    taskId: "task_live_reserved_retry" as never,
    runId: "agent_live_reserved_retry" as never,
    childSessionId: "session_live_reserved_retry_child" as SessionId,
    parentSessionId: "session_live_reserved_retry_parent" as SessionId,
    parentPath: "/root" as const,
    cwd: "/repo",
    taskName: "live reserved retry",
    prompt: "observe the active owner",
    mode: "one_shot" as const,
  };

  try {
    await store.append({
      id: "event_live_reserved_retry_created",
      type: "agent.task_created",
      time: 100 as TimestampMs,
      sessionId: reserved.parentSessionId,
      payload: {
        taskId: reserved.taskId,
        dispatchId: reserved.dispatchId,
        reservedRunId: reserved.runId,
        path: "/root/task_live_reserved_retry" as never,
        parentPath: reserved.parentPath,
        parentSessionId: reserved.parentSessionId,
        childSessionId: reserved.childSessionId,
        taskName: reserved.taskName,
        cwd: reserved.cwd,
        prompt: reserved.prompt,
        mode: reserved.mode,
      },
    });
    expect((await store.beginAgentTaskRunCas({
      taskId: reserved.taskId,
      expectedGeneration: 0,
      expectedRunId: null,
      expectedLeaseOwner: null,
      runId: reserved.runId,
      generation: 1,
      leaseOwner: `local:${reserved.runId}`,
      leaseTtlMs: 1_000,
      spawnEventId: "event_live_reserved_retry_spawned",
      reservedInitial: true,
      sessionId: reserved.parentSessionId,
      time: 100,
    })).applied).toBe(true);

    const retry = new LocalSubagentManager({
      store,
      now: () => 200 as TimestampMs,
      createId: createSequentialId(),
      runner: {
        async run() {
          runs++;
          return { status: "completed", summary: "must not run" };
        },
      },
    });
    await expect(retry.spawnTask(reserved)).resolves.toMatchObject({
      taskId: reserved.taskId,
      runId: reserved.runId,
      status: "running",
    });

    expect(runs).toBe(0);
    expect(await store.events({ type: "agent.task_created" })).toHaveLength(1);
    expect(await store.events({ type: "agent.spawned" })).toHaveLength(1);
    expect(await store.agentTask(reserved.taskId)).toMatchObject({
      status: "running",
      generation: 1,
      leaseOwner: `local:${reserved.runId}`,
      leaseExpiresAt: 1_100,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reserved retries close expired and missing durable leases without rerunning", async () => {
  for (const leaseState of ["expired", "missing"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `chili-subagent-${leaseState}-reserved-retry-`));
    const store = new SqliteEventStore(join(dir, "events.sqlite"));
    let runs = 0;
    const reserved = {
      dispatchId: `dispatch_${leaseState}_reserved_retry`,
      taskId: `task_${leaseState}_reserved_retry` as never,
      runId: `agent_${leaseState}_reserved_retry` as never,
      childSessionId: `session_${leaseState}_reserved_retry_child` as SessionId,
      parentSessionId: `session_${leaseState}_reserved_retry_parent` as SessionId,
      parentPath: "/root" as const,
      cwd: "/repo",
      taskName: `${leaseState} reserved retry`,
      prompt: "close abandoned durable work",
      mode: "one_shot" as const,
    };

    try {
      await store.append({
        id: `event_${leaseState}_reserved_retry_created`,
        type: "agent.task_created",
        time: 100 as TimestampMs,
        sessionId: reserved.parentSessionId,
        payload: {
          taskId: reserved.taskId,
          dispatchId: reserved.dispatchId,
          reservedRunId: reserved.runId,
          path: `/root/${reserved.taskId}` as never,
          parentPath: reserved.parentPath,
          parentSessionId: reserved.parentSessionId,
          childSessionId: reserved.childSessionId,
          taskName: reserved.taskName,
          cwd: reserved.cwd,
          prompt: reserved.prompt,
          mode: reserved.mode,
        },
      });
      expect((await store.beginAgentTaskRunCas({
        taskId: reserved.taskId,
        expectedGeneration: 0,
        expectedRunId: null,
        expectedLeaseOwner: null,
        runId: reserved.runId,
        generation: 1,
        leaseOwner: `local:${reserved.runId}`,
        leaseTtlMs: 10,
        spawnEventId: `event_${leaseState}_reserved_retry_spawned`,
        reservedInitial: true,
        sessionId: reserved.parentSessionId,
        time: 100,
      })).applied).toBe(true);
      if (leaseState === "missing") {
        expect(await store.releaseAgentTaskLease({
          taskId: reserved.taskId,
          owner: `local:${reserved.runId}`,
          generation: 1,
          now: 105,
        })).toBe(true);
      }

      const retry = new LocalSubagentManager({
        store,
        now: () => 200 as TimestampMs,
        createId: createSequentialId(),
        runner: {
          async run() {
            runs++;
            return { status: "completed", summary: "must not run" };
          },
        },
      });
      await expect(retry.spawnTask(reserved)).resolves.toMatchObject({
        taskId: reserved.taskId,
        runId: reserved.runId,
        status: "incomplete",
      });

      expect(runs).toBe(0);
      expect(await store.events({ type: "agent.task_created" })).toHaveLength(1);
      expect(await store.events({ type: "agent.spawned" })).toHaveLength(1);
      expect(await store.agentTask(reserved.taskId)).toMatchObject({
        status: "incomplete",
        generation: 2,
        error: "reserved_worker_lease_expired",
      });
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

class MemoryEventStore implements EventStore {
  readonly items: ChiliEvent[] = [];

  async append(event: ChiliEvent): Promise<void> {
    this.items.push(event);
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    const afterIndex = query.afterEventId
      ? this.items.findIndex((event) => event.id === query.afterEventId)
      : -1;
    const limit = query.limit ?? 500;
    return this.items
      .slice(afterIndex + 1)
      .filter((event) => {
        if (query.sessionId && event.sessionId !== query.sessionId) return false;
        if (query.type && event.type !== query.type) return false;
        return true;
      })
      .slice(0, limit);
  }

  async sessions(): Promise<SessionRow[]> {
    return [];
  }

  async messages(): Promise<Message[]> {
    return this.items.flatMap((event) => {
      if (event.type !== "message.created" || !event.sessionId) return [];
      const parts = this.items.flatMap((partEvent) =>
        partEvent.type === "message.part_added" && partEvent.payload.messageId === event.payload.messageId
          ? [partEvent.payload.part]
          : [],
      );
      return [
        {
          id: event.payload.messageId,
          sessionId: event.sessionId,
          role: event.payload.role,
          parts,
          createdAt: event.time,
        },
      ];
    });
  }

  async pendingApprovals(): Promise<ApprovalRow[]> {
    return [];
  }
}

class RecordingMemoryEventStore extends MemoryEventStore {
  readonly appends: Array<{ event: ChiliEvent; options?: EventAppendOptions }> = [];

  override async append(event: ChiliEvent, options?: EventAppendOptions): Promise<void> {
    this.appends.push({ event, ...(options ? { options } : {}) });
    await super.append(event);
  }
}

class FakeChildRunner implements AgentRunner {
  readonly createInputs: CreateSessionInput[] = [];
  readonly userMessages: AppendUserMessageInput[] = [];
  readonly turnInputs: RunTurnInput[] = [];

  constructor(private readonly store: MemoryEventStore) {}

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    this.createInputs.push(input);
    return input.sessionId ?? ("session_child" as SessionId);
  }

  async appendUserMessage(input: AppendUserMessageInput): Promise<MessageId> {
    this.userMessages.push(input);
    return "message_user_child" as MessageId;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.turnInputs.push(input);
    const messageId = "message_assistant_child" as MessageId;
    const part: MessagePart = {
      id: "part_child" as never,
      messageId,
      sessionId: input.sessionId,
      type: "text",
      text: "child answer",
    };
    await this.store.append({
      id: "event_child_message",
      type: "message.created",
      time: 1 as TimestampMs,
      sessionId: input.sessionId,
      payload: { messageId, role: "assistant" },
    });
    await this.store.append({
      id: "event_child_part",
      type: "message.part_added",
      time: 1 as TimestampMs,
      sessionId: input.sessionId,
      payload: { messageId, part },
    });
    return {
      status: "completed",
      turnId: "turn_child" as TurnId,
      assistantMessageId: messageId,
      finishReason: "stop",
    };
  }
}

class ScriptedChildRunner implements AgentRunner {
  readonly createInputs: CreateSessionInput[] = [];
  readonly userMessages: AppendUserMessageInput[] = [];
  readonly turnInputs: RunTurnInput[] = [];
  private index = 0;

  constructor(
    private readonly store: MemoryEventStore,
    private readonly script: Array<{ text?: string; finishReason?: string }>,
  ) {}

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    this.createInputs.push(input);
    return input.sessionId ?? ("session_child" as SessionId);
  }

  async appendUserMessage(input: AppendUserMessageInput): Promise<MessageId> {
    this.userMessages.push(input);
    return `message_user_${this.userMessages.length}` as MessageId;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.turnInputs.push(input);
    const item = this.script[this.index++] ?? {};
    const messageId = `message_assistant_${this.index}` as MessageId;
    if (item.text !== undefined) {
      const part: MessagePart = {
        id: `part_${this.index}` as never,
        messageId,
        sessionId: input.sessionId,
        type: "text",
        text: item.text,
      };
      await this.store.append({
        id: `event_message_${this.index}`,
        type: "message.created",
        time: this.index as TimestampMs,
        sessionId: input.sessionId,
        payload: { messageId, role: "assistant" },
      });
      await this.store.append({
        id: `event_part_${this.index}`,
        type: "message.part_added",
        time: this.index as TimestampMs,
        sessionId: input.sessionId,
        payload: { messageId, part },
      });
    }
    return {
      status: "completed",
      turnId: `turn_${this.index}` as TurnId,
      assistantMessageId: messageId,
      finishReason: item.finishReason ?? "stop",
    };
  }
}

function localRunInput(): LocalSubagentRunInput {
  return {
    taskId: "task_child" as never,
    runId: "agent_child" as never,
    path: "/root/task_child",
    parentPath: "/root",
    parentSessionId: "session_parent" as SessionId,
    childSessionId: "session_child" as SessionId,
    cwd: "/repo",
    taskName: "reader",
    prompt: "Read README",
    generation: 1,
  };
}

function abortTestError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

const HOSTILE_PERSISTENCE_SECRET = "sk-agent-persistence-secret-123456789";

function hostilePersistenceError(label: string): Error {
  const error = new Error(
    `${label}\nAuthorization: Bearer ${HOSTILE_PERSISTENCE_SECRET}\n`
      + `http://127.0.0.1:4317/internal?token=${HOSTILE_PERSISTENCE_SECRET}\n`
      + hostileWorstEscapedText(),
  ) as Error & { code?: string };
  error.name = "ProviderFailure";
  error.code = "TOKEN_INVALIDATED";
  return error;
}

function hostileWorstEscapedText(): string {
  return "\u0000\"\\\n".repeat(Math.ceil((5 * 1024 * 1024) / 4));
}

function expectPersistenceSafeDiagnostic(value: string | undefined): void {
  expect(value).toBeDefined();
  expect(value).toContain("[REDACTED]");
  expect(value).not.toContain(HOSTILE_PERSISTENCE_SECRET);
  expect(value).not.toContain("127.0.0.1");
  expect(new TextEncoder().encode(value ?? "").byteLength).toBeLessThanOrEqual(16 * 1024);
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}
