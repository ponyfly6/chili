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
  ThreadId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import type { ApprovalRow, EventQuery, EventStore, SessionRow } from "@chili/store";
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
    parentThreadId: "thread_parent" as ThreadId,
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
    childThreadId: "thread_4",
    status: "completed",
    summary: "read it",
  });
  expect(runInput).toMatchObject({
    taskId: "task_1",
    runId: "agent_2",
    path: "/root/task_1",
    parentSessionId: "session_parent",
    parentThreadId: "thread_parent",
    childSessionId: "session_3",
    childThreadId: "thread_4",
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
    threadId: "thread_parent",
    payload: {
      taskId: "task_1",
      path: "/root/task_1",
      parentPath: "/root",
      parentSessionId: "session_parent",
      parentThreadId: "thread_parent",
      childSessionId: "session_3",
      childThreadId: "thread_4",
      taskName: "reader",
      cwd: "/repo",
      prompt: "Read README",
      mode: "one_shot",
    },
  });
  expect(store.items[1]).toMatchObject({
    sessionId: "session_parent",
    threadId: "thread_parent",
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
    threadId: "thread_parent",
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
    childThreadId: "thread_child" as ThreadId,
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
      threadId: "thread_child" as ThreadId,
      cwd: "/repo",
    },
  ]);
  expect(runner.userMessages).toEqual([
    {
      sessionId: "session_child" as SessionId,
      threadId: "thread_child" as ThreadId,
      text: "Read README",
    },
  ]);
  expect(runner.turnInputs[0]).toMatchObject({
    sessionId: "session_child",
    threadId: "thread_child",
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
    parentThreadId: "thread_parent" as ThreadId,
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
      parentThreadId: "thread_parent" as ThreadId,
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
      parentThreadId: "thread_parent" as ThreadId,
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
      parentThreadId: "thread_parent" as ThreadId,
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
      threadId: "thread_parent" as ThreadId,
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
      parentThreadId: "thread_parent" as ThreadId,
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
      parentThreadId: "thread_parent" as ThreadId,
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
      parentThreadId: "thread_parent" as ThreadId,
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
      threadId: "thread_parent" as ThreadId,
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
      parentThreadId: "thread_parent" as ThreadId,
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
    parentThreadId: "thread_parent" as ThreadId,
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
      parentThreadId: "thread_parent" as ThreadId,
      cwd: "/repo",
      taskName: "first",
      prompt: "Wait even after abort",
      mode: "background",
    });
    await waitUntil(() => started.length === 1);
    const second = await manager.spawnTask({
      parentSessionId: "session_parent" as SessionId,
      parentThreadId: "thread_parent" as ThreadId,
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
    parentThreadId: "thread_parent" as ThreadId,
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
        parentThreadId: "thread_parent" as ThreadId,
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
        if (query.threadId && event.threadId !== query.threadId) return false;
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
      threadId: input.threadId,
      payload: { messageId, role: "assistant" },
    });
    await this.store.append({
      id: "event_child_part",
      type: "message.part_added",
      time: 1 as TimestampMs,
      sessionId: input.sessionId,
      threadId: input.threadId,
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
        threadId: input.threadId,
        payload: { messageId, role: "assistant" },
      });
      await this.store.append({
        id: `event_part_${this.index}`,
        type: "message.part_added",
        time: this.index as TimestampMs,
        sessionId: input.sessionId,
        threadId: input.threadId,
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
    childThreadId: "thread_child" as ThreadId,
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
