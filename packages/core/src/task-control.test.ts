import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type {
  AgentPath,
  AgentRunId,
  ChiliEvent,
  MessageId,
  PartId,
  SessionId,
  TaskId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import type { SubmitPromptInput, SubmitPromptResult } from "./runtime-service.js";
import type { AgentTaskPromptRuntime } from "./task-control.js";
import { AgentTaskControlService } from "./task-control.js";
import { LocalSubagentConcurrencyLimiter } from "./subagent-run-limiter.js";

test("follows up an existing task through the child session and records a new run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-followup-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reader" as TaskId;

  try {
    await seedTask(store, {
      taskId,
      status: "completed",
      workerPolicy: { allowedTools: ["read"], writeScope: [], executeScope: [] },
    });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });

    const result = await service.followupTask({
      taskId,
      text: "check the package name again",
      maxTurns: 3,
    });

    expect(runtime.inputs[0]).toMatchObject({
      sessionId: "session_child",
      text: "check the package name again",
      maxTurns: 3,
    });
    expect(runtime.inputs[0]).not.toHaveProperty("cwd");
    expect(runtime.inputs[0]).not.toHaveProperty("system");
    expect(result.result.status).toBe("completed");
    expect(result.task).toMatchObject({
      id: taskId,
      status: "completed",
      currentRunId: "agent_1",
      generation: 1,
      childSessionId: "session_child",
      summary: "follow-up answer",
    });

    const events = await store.events({ limit: 100 });
    expect(events.map((event) => event.type)).toContain("agent.message_queued");
    expect(events.map((event) => event.type)).toContain("agent.message_consumed");
    expect(events.map((event) => event.type)).toContain("agent.spawned");
    const completedEvents = events.filter(
      (event): event is Extract<ChiliEvent, { type: "agent.completed" }> => event.type === "agent.completed",
    );
    expect(completedEvents.find((event) => event.payload.runId === result.task.currentRunId)).toMatchObject({
      type: "agent.completed",
      payload: { taskId, runId: "agent_1", status: "completed", summary: "follow-up answer" },
    });
    expect(await store.agentMailbox({ taskId })).toMatchObject([
      {
        id: "event_2",
        taskId,
        status: "consumed",
        triggerTurn: true,
        message: { role: "user", content: "check the package name again" },
        consumedAt: 10,
      },
    ]);
    expect(await store.agentMailbox({ status: "queued" })).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown publishes one promise before a prompt abort listener reenters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-shutdown-reentry-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_shutdown_reentry" as TaskId;
  const promptStarted = deferred<void>();
  let service!: AgentTaskControlService;
  let reentrantShutdown: Promise<void> | undefined;
  let abortCallbacks = 0;
  let promptCleanups = 0;

  try {
    await seedTask(store, { taskId, status: "completed" });
    service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });
    runtime.onSubmit = async (input) => {
      const signal = input.signal;
      if (!signal) throw new Error("Expected a shutdown-linked prompt signal");
      promptStarted.resolve();
      try {
        await new Promise<void>((_resolve, reject) => {
          const onAbort = (): void => {
            abortCallbacks++;
            reentrantShutdown = service.shutdown();
            reject(signal.reason ?? abortTestError());
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      } finally {
        promptCleanups++;
      }
    };

    const followup = service.followupTask({ taskId, text: "wait for shutdown" });
    const observedFollowup = followup.then(
      () => undefined,
      (error: unknown) => error,
    );
    await promptStarted.promise;

    const shutdown = service.shutdown();
    expect(reentrantShutdown).toBe(shutdown);
    expect(service.shutdown()).toBe(shutdown);
    await shutdown;

    expect(await observedFollowup).toMatchObject({ name: "AbortError" });
    expect(abortCallbacks).toBe(1);
    expect(promptCleanups).toBe(1);
    expect(await store.agentTask(taskId)).toMatchObject({ status: "cancelled" });
    expect(await store.events({ type: "agent.task_completed", limit: 100 })).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects direct follow-up of a terminal crash-safe dispatch reservation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-reserved-followup-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reserved_followup" as TaskId;
  const reservedRunId = "agent_reserved_followup" as AgentRunId;

  try {
    await seedTask(store, {
      taskId,
      status: "completed",
      dispatchId: "dispatch_reserved_followup",
      reservedRunId,
    });
    const service = new AgentTaskControlService({ store, runtime, createId: createSequentialId() });

    await expect(service.followupTask({ taskId, text: "must create a new team dispatch instead" }))
      .rejects.toMatchObject({
        name: "AgentTaskNotRunnableError",
        message: expect.stringContaining("cannot be reopened directly"),
      });
    expect(runtime.inputs).toEqual([]);
    expect(await store.events({ type: "agent.spawned", limit: 10 })).toHaveLength(1);
    expect(await store.agentRuns({ taskId })).toHaveLength(1);

    const task = (await store.agentTask(taskId))!;
    const defended = await store.beginAgentTaskRunCas({
      taskId,
      expectedGeneration: task.generation,
      expectedRunId: reservedRunId,
      expectedLeaseOwner: null,
      runId: "agent_reserved_followup_forbidden" as AgentRunId,
      generation: task.generation + 1,
      leaseOwner: "task-followup:forbidden",
      leaseTtlMs: 100,
      spawnEventId: "event_reserved_followup_forbidden",
      time: 20,
    });
    expect(defended).toMatchObject({ applied: false, events: [] });
    expect(await store.events({ type: "agent.spawned", limit: 10 })).toHaveLength(1);
    expect(await store.agentRuns({ taskId })).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects direct follow-up of a legacy team task identified by its worker policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-legacy-team-followup-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_legacy_team_followup" as TaskId;

  try {
    await seedTask(store, {
      taskId,
      status: "completed",
      workerPolicy: {
        teamId: "team_legacy_followup",
        taskId: "team_task_legacy_followup",
        memberPath: "/root/worker",
        parentSessionId: "session_parent",
      },
    });
    const projected = await store.agentTask(taskId);
    expect(projected).toMatchObject({
      id: taskId,
      status: "completed",
      workerPolicy: {
        teamId: "team_legacy_followup",
        taskId: "team_task_legacy_followup",
      },
    });
    expect(projected?.dispatchId).toBeUndefined();
    expect(projected?.reservedRunId).toBeUndefined();

    const service = new AgentTaskControlService({ store, runtime, createId: createSequentialId() });
    await expect(service.followupTask({ taskId, text: "must not reopen the legacy team worker" }))
      .rejects.toMatchObject({
        name: "AgentTaskNotRunnableError",
        message: expect.stringContaining("cannot be reopened directly"),
      });

    expect(runtime.inputs).toEqual([]);
    expect(await store.events({ type: "agent.spawned", limit: 10 })).toHaveLength(1);
    expect(await store.agentRuns({ taskId })).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("falls back to lifecycle events when an observable wrapper reports no atomic task capabilities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-projection-only-wrapper-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const projectionOnly = {
    append: sqlite.append.bind(sqlite),
    appendMany: sqlite.appendMany.bind(sqlite),
    events: sqlite.events.bind(sqlite),
    sessions: sqlite.sessions.bind(sqlite),
    messages: sqlite.messages.bind(sqlite),
    pendingApprovals: sqlite.pendingApprovals.bind(sqlite),
    agentTasks: sqlite.agentTasks.bind(sqlite),
    agentTask: sqlite.agentTask.bind(sqlite),
    agentRuns: sqlite.agentRuns.bind(sqlite),
    agentMailbox: sqlite.agentMailbox.bind(sqlite),
  };
  const store = new ObservableEventStore(projectionOnly);
  const runtime = new FakeTaskRuntime(sqlite);
  const taskId = "task_projection_only" as TaskId;

  try {
    await seedTask(sqlite, { taskId, status: "completed" });
    expect(store.supportsAgentTaskCapability("run-claim")).toBe(false);
    expect(store.supportsAgentTaskCapability("finalization")).toBe(false);
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });

    const result = await service.followupTask({ taskId, text: "compatibility follow-up" });

    expect(result.task).toMatchObject({ status: "completed", generation: 1, summary: "follow-up answer" });
    expect(await sqlite.events({ type: "agent.spawned", limit: 100 })).toHaveLength(2);
    expect(await sqlite.events({ type: "agent.task_completed", limit: 100 })).toHaveLength(1);
    expect(await sqlite.events({ type: "agent.completed", limit: 100 })).toHaveLength(2);
    expect(await sqlite.agentMailbox({ taskId })).toMatchObject([{ status: "consumed", triggerTurn: false }]);
    expect(await sqlite.events({ type: "agent.message_consumed", limit: 100 })).toHaveLength(1);
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("projection-only fallback requeues a failed source mailbox turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-projection-source-requeue-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const projectionOnly = {
    append: sqlite.append.bind(sqlite),
    appendMany: sqlite.appendMany.bind(sqlite),
    events: sqlite.events.bind(sqlite),
    sessions: sqlite.sessions.bind(sqlite),
    messages: sqlite.messages.bind(sqlite),
    pendingApprovals: sqlite.pendingApprovals.bind(sqlite),
    agentTasks: sqlite.agentTasks.bind(sqlite),
    agentTask: sqlite.agentTask.bind(sqlite),
    agentRuns: sqlite.agentRuns.bind(sqlite),
    agentMailbox: sqlite.agentMailbox.bind(sqlite),
  };
  const store = new ObservableEventStore(projectionOnly);
  const runtime = new FakeTaskRuntime(sqlite, hostileTaskControlError("source runtime unavailable"));
  const taskId = "task_projection_source" as TaskId;
  const messageId = "message_projection_source";

  try {
    await seedTask(sqlite, { taskId, status: "completed" });
    const task = (await sqlite.agentTask(taskId))!;
    await sqlite.append({
      id: messageId,
      type: "agent.message_queued",
      time: 2 as TimestampMs,
      payload: {
        taskId,
        path: task.path,
        from: "/root" as AgentPath,
        recipientSessionId: task.childSessionId!,
        triggerTurn: true,
        message: { role: "user", content: "retry from mailbox" },
      },
    });
    await sqlite.claimAgentMailboxMessage({
      messageId,
      eventId: "event_projection_source_claim",
      claimedBy: task.path,
      time: 3,
    });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });

    await expect(service.followupTask({
      taskId,
      text: "retry from mailbox",
      sourceMailboxMessageId: messageId,
    })).rejects.toThrow("source runtime unavailable");

    expect(await sqlite.agentMailbox({ messageId })).toMatchObject([{ status: "queued", triggerTurn: true }]);
    const requeuedEvents = await sqlite.events({ type: "agent.message_requeued", limit: 100 });
    expect(requeuedEvents).toHaveLength(1);
    const requeued = requeuedEvents[0] as Extract<ChiliEvent, { type: "agent.message_requeued" }>;
    expectTaskControlSafeDiagnostic(requeued.payload.error);
    expect(jsonByteLength(requeued)).toBeLessThanOrEqual(128 * 1024);
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("marks a planning-only non-tool follow-up result incomplete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-followup-incomplete-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  runtime.responseText = "I'll inspect the repository next.";
  const taskId = "task_reader" as TaskId;

  try {
    await seedTask(store, { taskId, status: "completed" });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });

    const result = await service.followupTask({ taskId, text: "check again" });

    expect(result.result.status).toBe("completed");
    expect(result.task).toMatchObject({
      id: taskId,
      status: "incomplete",
      currentRunId: "agent_1",
      summary: "I'll inspect the repository next.",
      error: "Subagent completion incomplete: planning_only",
    });
    expect((await store.events({ type: "agent.completed", limit: 100 })).at(-1)).toMatchObject({
      payload: {
        taskId,
        runId: "agent_1",
        status: "incomplete",
        summary: "I'll inspect the repository next.",
        error: "Subagent completion incomplete: planning_only",
      },
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("consumes a directly claimed follow-up message when runtime submission fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-followup-failure-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store, hostileTaskControlError("runtime unavailable"));
  const taskId = "task_reader" as TaskId;

  try {
    await seedTask(store, { taskId, status: "completed" });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });

    await expect(
      service.followupTask({
        taskId,
        text: "try the follow-up again",
      }),
    ).rejects.toThrow("runtime unavailable");

    expect(runtime.inputs[0]).toMatchObject({
      sessionId: "session_child",
      text: "try the follow-up again",
    });
    expect(await store.agentMailbox({ taskId })).toMatchObject([
      {
        id: "event_2",
        taskId,
        status: "consumed",
        triggerTurn: true,
        message: { role: "user", content: "try the follow-up again" },
      },
    ]);
    expect((await store.agentMailbox({ taskId }))[0]?.consumedAt).toBe(10);
    expect(await store.agentMailbox({ status: "queued" })).toEqual([]);
    expect((await store.events({ limit: 100 })).map((event) => event.type)).toContain("agent.message_consumed");
    const persistedTask = await store.agentTask(taskId);
    expect(persistedTask).toMatchObject({
      id: taskId,
      status: "failed",
      currentRunId: "agent_1",
    });
    expectTaskControlSafeDiagnostic(persistedTask?.error);
    const completionEvents = ((await store.events({ limit: 100 })) as ChiliEvent[]).filter(
      (event): event is Extract<ChiliEvent, { type: "agent.task_completed" | "agent.completed" }> =>
        (event.type === "agent.task_completed" || event.type === "agent.completed")
          && event.payload.runId === "agent_1",
    );
    expect(completionEvents).toHaveLength(2);
    for (const event of completionEvents) {
      expectTaskControlSafeDiagnostic(event.payload.error);
      expect(jsonByteLength(event)).toBeLessThanOrEqual(128 * 1024);
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("complete_task completes the active follow-up run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-complete-task-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reader" as TaskId;

  try {
    await seedTask(store, { taskId, status: "completed" });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });
    runtime.onSubmit = async () => {
      await service.completeTask({
        taskId,
        summary: "tool summary",
        status: "completed",
      });
    };

    const result = await service.followupTask({
      taskId,
      text: "finish with complete_task",
    });

    expect(runtime.inputs[0]?.signal?.aborted).toBe(true);
    expect(result.task).toMatchObject({
      id: taskId,
      status: "completed",
      currentRunId: "agent_1",
      summary: "tool summary",
    });
    expect(await store.events({ type: "agent.task_completed", limit: 100 })).toHaveLength(1);
    expect((await store.events({ type: "agent.task_completed", limit: 100 })).at(-1)).toMatchObject({
      payload: {
        taskId,
        runId: "agent_1",
        summary: "tool summary",
      },
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  ["planning-only", "I'll inspect the repository next.", "planning_only"],
  ["acknowledgement-only", "Okay.", "acknowledgement_only"],
  ["empty", "", "empty"],
] as const)("complete_task coerces a %s completed summary to incomplete", async (_label, summary, issue) => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-complete-incomplete-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reader" as TaskId;
  let completion: Awaited<ReturnType<AgentTaskControlService["completeTask"]>> | undefined;

  try {
    await seedTask(store, { taskId, status: "completed" });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });
    runtime.onSubmit = async () => {
      completion = await service.completeTask({ taskId, summary, status: "completed" });
    };

    const result = await service.followupTask({ taskId, text: "finish with complete_task" });

    expect(completion).toEqual({ taskId, summary, status: "incomplete" });
    expect(result.task).toMatchObject({
      id: taskId,
      status: "incomplete",
      currentRunId: "agent_1",
      error: `Subagent completion incomplete: ${issue}`,
    });
    expect((await store.events({ type: "agent.task_completed", limit: 100 })).at(-1)).toMatchObject({
      payload: {
        taskId,
        status: "incomplete",
        error: `Subagent completion incomplete: ${issue}`,
      },
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close wins over a late follow-up runtime completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-close-active-followup-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reader" as TaskId;

  try {
    await seedTask(store, { taskId, status: "completed" });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });
    runtime.onSubmit = async (input) => {
      const closed = await service.closeTask({
        taskId,
        status: "cancelled",
        summary: "stopped by user",
        interrupt: false,
      });
      expect(closed).toMatchObject({
        id: taskId,
        status: "cancelled",
        currentRunId: "agent_1",
        summary: "stopped by user",
      });
      expect(input.signal?.aborted).toBe(true);
    };

    const result = await service.followupTask({
      taskId,
      text: "finish after close",
    });

    expect(result.task).toMatchObject({
      id: taskId,
      status: "cancelled",
      currentRunId: "agent_1",
      summary: "stopped by user",
    });
    expect(await store.events({ type: "agent.task_completed", limit: 100 })).toHaveLength(1);
    expect(await store.agentMailbox({ status: "queued" })).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close cannot session-interrupt a generation reopened inside its scoped interrupt hook", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-close-reopen-gap-"));
  const databasePath = join(dir, "events.sqlite");
  const storeA = new SqliteEventStore(databasePath);
  const storeB = new SqliteEventStore(databasePath);
  const runtime = new FakeTaskRuntime(storeB);
  const taskId = "task_running" as TaskId;
  const providerGate = deferred<void>();
  runtime.onSubmit = async () => providerGate.promise;
  let reopened: Promise<Awaited<ReturnType<AgentTaskControlService["followupTask"]>>> | undefined;
  let interruptFence: { runId: AgentRunId | null; generation: number } | undefined;

  try {
    await seedTask(storeA, { taskId, status: "running" });
    const serviceB = new AgentTaskControlService({
      store: storeB,
      runtime,
    });
    const serviceA = new AgentTaskControlService({
      store: storeA,
      runtime,
      async interruptTask(closedTaskId, fence) {
        expect(closedTaskId).toBe(taskId);
        interruptFence = fence;
        reopened = serviceB.followupTask({ taskId, text: "new generation" });
        await waitUntil(() => runtime.inputs.length === 1);
        return true;
      },
    });

    const closed = await serviceA.closeTask({ taskId, status: "cancelled" });

    expect(closed).toMatchObject({ status: "cancelled", generation: 1 });
    expect(interruptFence).toEqual({
      runId: `agent_initial_${taskId}` as AgentRunId,
      generation: 0,
    });
    expect(runtime.interrupts).toEqual([]);
    expect(runtime.inputs[0]?.signal?.aborted).toBe(false);
    expect(await storeA.agentTask(taskId)).toMatchObject({ status: "running", generation: 2 });

    providerGate.resolve();
    await expect(reopened).resolves.toMatchObject({ task: { status: "completed", generation: 2 } });
    expect(await storeA.agentTask(taskId)).toMatchObject({ status: "completed", generation: 2 });
  } finally {
    providerGate.resolve();
    await reopened?.catch(() => undefined);
    storeB.close();
    storeA.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close cancels a follow-up queued behind the shared limiter without reopening its terminal task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-close-queued-followup-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reader" as TaskId;
  const limiter = new LocalSubagentConcurrencyLimiter(1);
  const releaseBlocker = await limiter.acquire();

  try {
    await seedTask(store, { taskId, status: "completed" });
    const service = new AgentTaskControlService({
      store,
      runtime,
      runLimiter: limiter,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });

    const followup = service.followupTask({ taskId, text: "queued follow-up" })
      .then(() => undefined, (error: unknown) => error);
    await waitUntil(() => limiter.snapshot().queuedRuns === 1);

    const closed = await service.closeTask({ taskId, status: "cancelled" });
    expect(closed).toMatchObject({
      id: taskId,
      status: "completed",
      currentRunId: `agent_initial_${taskId}`,
      summary: "initial answer",
    });
    expect(await followup).toMatchObject({ name: "AbortError" });
    expect(runtime.inputs).toEqual([]);
    expect(await store.events({ type: "agent.spawned", limit: 100 })).toHaveLength(1);
    expect(await store.agentTask(taskId)).toMatchObject({ status: "completed", generation: 0 });
    expect(limiter.snapshot()).toMatchObject({ activeRuns: 1, queuedRuns: 0 });
  } finally {
    releaseBlocker();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an abort signal cancels a queued follow-up before it spawns a generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-abort-queued-followup-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reader" as TaskId;
  const limiter = new LocalSubagentConcurrencyLimiter(1);
  const releaseBlocker = await limiter.acquire();

  try {
    await seedTask(store, { taskId, status: "completed" });
    const service = new AgentTaskControlService({
      store,
      runtime,
      runLimiter: limiter,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });
    const controller = new AbortController();
    const followup = service.followupTask({
      taskId,
      text: "queued follow-up",
      signal: controller.signal,
    }).then(() => undefined, (error: unknown) => error);
    await waitUntil(() => limiter.snapshot().queuedRuns === 1);

    controller.abort();

    expect(await followup).toMatchObject({ name: "AbortError" });
    expect(runtime.inputs).toEqual([]);
    expect(await store.events({ type: "agent.spawned", limit: 100 })).toHaveLength(1);
    expect(await store.agentTask(taskId)).toMatchObject({ status: "completed", generation: 0 });
    expect(limiter.snapshot()).toMatchObject({ activeRuns: 1, queuedRuns: 0 });
  } finally {
    releaseBlocker();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close cancels a follow-up waiting in its first delegation gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-close-first-gate-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reader" as TaskId;
  const gate = deferred<void>();
  let checks = 0;

  try {
    await seedTask(store, { taskId, status: "completed" });
    const service = new AgentTaskControlService({
      store,
      runtime,
      async assertDelegationEnabled() {
        checks += 1;
        if (checks === 1) await gate.promise;
      },
    });
    const followup = service.followupTask({ taskId, text: "wait in first gate" })
      .then(() => undefined, (error: unknown) => error);
    await waitUntil(() => checks === 1);

    expect(await service.closeTask({ taskId, status: "cancelled" })).toMatchObject({
      id: taskId,
      status: "completed",
      generation: 0,
    });
    gate.resolve();

    expect(await followup).toMatchObject({ name: "AbortError" });
    expect(runtime.inputs).toEqual([]);
    expect(await store.events({ type: "agent.spawned", limit: 100 })).toHaveLength(1);
    expect(await store.agentMailbox({ taskId })).toEqual([]);
  } finally {
    gate.resolve();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close during the post-permit delegation recheck cannot spawn a cancelled ghost generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-close-delegation-gate-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reader" as TaskId;
  const delegationGate = deferred<void>();
  let delegationChecks = 0;

  try {
    await seedTask(store, { taskId, status: "completed" });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      async assertDelegationEnabled() {
        delegationChecks++;
        if (delegationChecks === 2) await delegationGate.promise;
      },
    });
    const followup = service.followupTask({ taskId, text: "gated follow-up" })
      .then(() => undefined, (error: unknown) => error);
    await waitUntil(() => delegationChecks === 2);

    const closed = await service.closeTask({ taskId, status: "cancelled" });
    delegationGate.resolve();

    expect(closed).toMatchObject({ id: taskId, status: "completed", generation: 0 });
    expect(await followup).toMatchObject({ name: "AbortError" });
    expect(runtime.inputs).toEqual([]);
    expect(await store.agentTask(taskId)).toMatchObject({ status: "completed", generation: 0 });
    expect(await store.events({ type: "agent.spawned", limit: 100 })).toHaveLength(1);
    expect(await store.events({ type: "agent.message_queued", limit: 100 })).toEqual([]);
  } finally {
    delegationGate.resolve();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider-start lease expiry closes and requeues the exact follow-up generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-provider-start-expiry-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reader" as TaskId;
  let now = 100;
  let checks = 0;

  try {
    await seedTask(store, { taskId, status: "completed" });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => now as TimestampMs,
      leaseTtlMs: 10,
      async assertDelegationEnabled() {
        checks += 1;
        if (checks === 3) now = 111;
      },
    });

    await expect(service.followupTask({ taskId, text: "durable retry" })).rejects.toMatchObject({
      name: "AgentTaskNotRunnableError",
    });
    expect(runtime.inputs).toEqual([]);
    expect(await store.agentTask(taskId)).toMatchObject({ status: "incomplete", generation: 2 });
    const [message] = await store.agentMailbox({ taskId });
    expect(message).toMatchObject({ status: "queued", triggerTurn: true });

    const claim = await store.claimAgentMailboxMessage({
      messageId: message!.id,
      eventId: "event_recovery_claim",
      claimedBy: message!.path,
      time: 112,
    });
    expect(claim.applied).toBe(true);
    const retryRuntime = new FakeTaskRuntime(store);
    let retryId = 0;
    const retry = new AgentTaskControlService({
      store,
      runtime: retryRuntime,
      createId: (prefix) => `recovery_${prefix}_${++retryId}`,
      now: () => 112 as TimestampMs,
      leaseTtlMs: 10,
    });
    await retry.followupTask({
      taskId,
      text: "durable retry",
      sourceMailboxMessageId: message!.id,
    });

    expect(retryRuntime.inputs).toHaveLength(1);
    expect(await store.agentTask(taskId)).toMatchObject({ status: "completed", generation: 3 });
    expect(await store.agentMailbox({ messageId: message!.id })).toMatchObject([{ status: "consumed" }]);
    expect(await store.events({ type: "agent.message_queued", limit: 100 })).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("heartbeat expiry closes and requeues a provider turn that ignores abort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-heartbeat-expiry-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reader" as TaskId;
  const providerGate = deferred<void>();
  let now = 100;
  runtime.onSubmit = async () => providerGate.promise;

  try {
    await seedTask(store, { taskId, status: "completed" });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => now as TimestampMs,
      leaseTtlMs: 10,
      leaseHeartbeatIntervalMs: 1,
    });
    const outcome = service.followupTask({ taskId, text: "long provider turn" })
      .then(() => undefined, (error: unknown) => error);
    await waitUntil(() => runtime.inputs.length === 1);

    now = 111;
    await waitUntil(() => runtime.inputs[0]?.signal?.aborted === true);
    providerGate.resolve();

    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(await store.agentTask(taskId)).toMatchObject({ status: "incomplete", generation: 2 });
    expect(await store.agentMailbox({ taskId })).toMatchObject([{ status: "queued", triggerTurn: true }]);
  } finally {
    providerGate.resolve();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("heartbeat renewal keeps a long provider turn unavailable to recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-heartbeat-renewal-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reader" as TaskId;
  const providerGate = deferred<void>();
  let now = 100;
  runtime.onSubmit = async () => providerGate.promise;

  try {
    await seedTask(store, { taskId, status: "completed" });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => now as TimestampMs,
      leaseTtlMs: 30,
      leaseHeartbeatIntervalMs: 1,
    });
    const outcome = service.followupTask({ taskId, text: "renew the lease" });
    await waitUntil(() => runtime.inputs.length === 1);
    now = 110;
    await waitUntil(async () => (await store.agentTask(taskId))!.leaseExpiresAt! >= 140);
    const [message] = await store.agentMailbox({ taskId });

    const competingRuntime = new FakeTaskRuntime(store);
    const competing = new AgentTaskControlService({
      store,
      runtime: competingRuntime,
      now: () => 125 as TimestampMs,
    });
    await expect(competing.followupTask({
      taskId,
      text: "must wait",
      sourceMailboxMessageId: message!.id,
    })).rejects.toMatchObject({ name: "AgentTaskNotRunnableError" });
    expect(competingRuntime.inputs).toEqual([]);

    providerGate.resolve();
    await expect(outcome).resolves.toMatchObject({ task: { status: "completed" } });
    expect(await store.agentMailbox({ taskId })).toMatchObject([{ status: "consumed" }]);
  } finally {
    providerGate.resolve();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a committed close before provider-start lease CAS prevents the provider call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-close-before-provider-start-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const runtime = new FakeTaskRuntime(baseStore);
  const taskId = "task_reader" as TaskId;
  const closer = new AgentTaskControlService({ store, runtime });
  let closePromise: Promise<unknown> | undefined;

  try {
    await seedTask(baseStore, { taskId, status: "completed" });
    const unsubscribe = store.subscribe((event) => {
      if (event.type === "agent.spawned" && event.payload.taskId === taskId && event.payload.generation === 1) {
        closePromise = closer.closeTask({ taskId, status: "cancelled" });
      }
    });
    const renew = store.renewAgentTaskLease.bind(store);
    store.renewAgentTaskLease = async (input) => {
      await closePromise;
      return renew(input);
    };
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
    });

    await expect(service.followupTask({ taskId, text: "must not start" })).rejects.toMatchObject({
      name: "AgentTaskNotRunnableError",
    });
    await closePromise;
    unsubscribe();

    expect(runtime.inputs).toEqual([]);
    expect(await baseStore.agentTask(taskId)).toMatchObject({ status: "cancelled", generation: 2 });
    expect(await baseStore.agentMailbox({ taskId })).toMatchObject([{ status: "consumed" }]);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminal completion quiesces heartbeat renewal before a delayed CAS return", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-finalize-heartbeat-race-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reader" as TaskId;
  let renewals = 0;

  try {
    await seedTask(store, { taskId, status: "completed" });
    const renew = store.renewAgentTaskLease.bind(store);
    store.renewAgentTaskLease = async (input) => {
      renewals += 1;
      return renew(input);
    };
    const complete = store.completeAgentTaskCas.bind(store);
    store.completeAgentTaskCas = async (input) => {
      const result = await complete(input);
      const committedRenewals = renewals;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(renewals).toBe(committedRenewals);
      return result;
    };
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      leaseTtlMs: 30,
      leaseHeartbeatIntervalMs: 1,
    });

    await expect(service.followupTask({ taskId, text: "finish once" })).resolves.toMatchObject({
      task: { status: "completed", generation: 1 },
    });
    expect(await store.agentMailbox({ taskId })).toMatchObject([{ status: "consumed" }]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("two task control services claim a follow-up generation exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-followup-claim-race-"));
  const databasePath = join(dir, "events.sqlite");
  const storeA = new SqliteEventStore(databasePath);
  const storeB = new SqliteEventStore(databasePath);
  const runtimeA = new FakeTaskRuntime(storeA);
  const runtimeB = new FakeTaskRuntime(storeB);
  const taskId = "task_reader" as TaskId;
  const providerGate = deferred<void>();
  const initialReadBarrier = deferred<void>();
  let initialReads = 0;
  const assertDelegationEnabled = async () => {
    initialReads++;
    if (initialReads === 2) initialReadBarrier.resolve();
    await initialReadBarrier.promise;
  };
  runtimeA.onSubmit = async () => providerGate.promise;
  runtimeB.onSubmit = async () => providerGate.promise;

  try {
    await seedTask(storeA, { taskId, status: "completed" });
    const serviceA = new AgentTaskControlService({
      store: storeA,
      runtime: runtimeA,
      createId: createSequentialId("service-a"),
      assertDelegationEnabled,
    });
    const serviceB = new AgentTaskControlService({
      store: storeB,
      runtime: runtimeB,
      createId: createSequentialId("service-b"),
      assertDelegationEnabled,
    });
    const outcomeA = serviceA.followupTask({ taskId, text: "race A" })
      .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    const outcomeB = serviceB.followupTask({ taskId, text: "race B" })
      .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

    const loser = await Promise.race([outcomeA, outcomeB]);
    expect(loser.ok).toBe(false);
    if (!loser.ok) {
      expect(loser.error).toMatchObject({ name: "AgentTaskNotRunnableError" });
    }
    await waitUntil(() => runtimeA.inputs.length + runtimeB.inputs.length === 1);
    expect(runtimeA.inputs.length + runtimeB.inputs.length).toBe(1);
    expect(await storeA.agentTask(taskId)).toMatchObject({ status: "running", generation: 1 });
    expect(await storeA.events({ type: "agent.spawned", limit: 100 })).toHaveLength(2);
    expect(await storeA.events({ type: "agent.message_queued", limit: 100 })).toHaveLength(1);
    expect(await storeA.agentRuns({ taskId, status: "running" })).toHaveLength(1);

    providerGate.resolve();
    const outcomes = await Promise.all([outcomeA, outcomeB]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);
    expect(await storeA.agentTask(taskId)).toMatchObject({ status: "completed", generation: 1 });
    expect(await storeA.agentRuns({ taskId })).toHaveLength(2);
  } finally {
    providerGate.resolve();
    storeB.close();
    storeA.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a permit-queued follow-up cannot retarget a newer terminal generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-followup-stale-claim-"));
  const databasePath = join(dir, "events.sqlite");
  const storeA = new SqliteEventStore(databasePath);
  const storeB = new SqliteEventStore(databasePath);
  const runtimeA = new FakeTaskRuntime(storeA);
  const runtimeB = new FakeTaskRuntime(storeB);
  const taskId = "task_reader" as TaskId;
  const limiter = new LocalSubagentConcurrencyLimiter(1);
  const releaseBlocker = await limiter.acquire();
  let released = false;

  try {
    await seedTask(storeA, { taskId, status: "completed" });
    const queuedService = new AgentTaskControlService({
      store: storeA,
      runtime: runtimeA,
      runLimiter: limiter,
      createId: createSequentialId("queued"),
    });
    const competingService = new AgentTaskControlService({
      store: storeB,
      runtime: runtimeB,
      createId: createSequentialId("competing"),
    });
    const queuedOutcome = queuedService.followupTask({ taskId, text: "stale queued request" })
      .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    await waitUntil(() => limiter.snapshot().queuedRuns === 1);

    await competingService.followupTask({ taskId, text: "winning request" });
    expect(await storeB.agentTask(taskId)).toMatchObject({ status: "completed", generation: 1 });

    releaseBlocker();
    released = true;
    const outcome = await queuedOutcome;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({ name: "AgentTaskNotRunnableError" });
    }
    expect(runtimeA.inputs).toEqual([]);
    expect(runtimeB.inputs).toHaveLength(1);
    expect(await storeB.events({ type: "agent.spawned", limit: 100 })).toHaveLength(2);
    expect(await storeB.events({ type: "agent.message_queued", limit: 100 })).toHaveLength(1);
    expect(await storeB.agentRuns({ taskId })).toHaveLength(2);
  } finally {
    if (!released) releaseBlocker();
    storeB.close();
    storeA.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("closes a running task with a run-scoped local interrupt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-close-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_running" as TaskId;

  try {
    await seedTask(store, { taskId, status: "running" });
    const interrupts: Array<{ taskId: TaskId; runId: AgentRunId | null; generation: number }> = [];
    const service = new AgentTaskControlService({
      store,
      runtime,
      interruptTask(taskId, fence) {
        interrupts.push({ taskId, ...fence });
        return true;
      },
      createId: createSequentialId(),
      now: () => 20 as TimestampMs,
    });

    const task = await service.closeTask({
      taskId,
      status: "cancelled",
      summary: "stopped by user",
    });

    expect(interrupts).toEqual([{
      taskId,
      runId: `agent_initial_${taskId}` as AgentRunId,
      generation: 0,
    }]);
    expect(runtime.interrupts).toEqual([]);
    expect(task).toMatchObject({
      id: taskId,
      status: "cancelled",
      summary: "stopped by user",
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconciles stale running background tasks without touching live task ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-reconcile-stale-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const staleTaskId = "task_stale" as TaskId;
  const liveTaskId = "task_live" as TaskId;

  try {
    await seedTask(store, { taskId: staleTaskId, status: "running", mode: "background", time: 10 as TimestampMs });
    await seedTask(store, {
      taskId: liveTaskId,
      status: "running",
      mode: "background",
      time: 20 as TimestampMs,
      childSessionId: "session_child_live" as SessionId,
    });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 100 as TimestampMs,
    });

    const result = await service.reconcileStaleTasks({
      staleAfterMs: 30,
      liveTaskIds: [liveTaskId],
    });

    expect(result.scanned).toBe(2);
    expect(result.closed.map((task) => task.id)).toEqual([staleTaskId]);
    expect(await store.agentTask(staleTaskId)).toMatchObject({
      id: staleTaskId,
      status: "cancelled",
      currentRunId: "agent_initial_task_stale",
      summary: "Marked stale: background worker is no longer running",
      error: "stale_background_worker",
    });
    expect(await store.agentTask(liveTaskId)).toMatchObject({
      id: liveTaskId,
      status: "running",
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale reconciliation is authoritatively scoped to one parent session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-reconcile-session-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const activeSessionId = "session_recover_active" as SessionId;
  const otherSessionId = "session_recover_other" as SessionId;
  const activeTaskId = "task_recover_active" as TaskId;
  const otherTaskId = "task_recover_other" as TaskId;

  try {
    await seedTask(store, {
      taskId: activeTaskId,
      status: "running",
      mode: "background",
      time: 10 as TimestampMs,
      parentSessionId: activeSessionId,
    });
    await seedTask(store, {
      taskId: otherTaskId,
      status: "running",
      mode: "background",
      time: 10 as TimestampMs,
      parentSessionId: otherSessionId,
      childSessionId: "session_recover_other_child" as SessionId,
    });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 100 as TimestampMs,
    });

    const result = await service.reconcileStaleTasks({
      parentSessionId: activeSessionId,
      staleAfterMs: 30,
    });

    expect(result.scanned).toBe(1);
    expect(result.closed.map((task) => task.id)).toEqual([activeTaskId]);
    expect(await store.agentTask(activeTaskId)).toMatchObject({ status: "cancelled" });
    expect(await store.agentTask(otherTaskId)).toMatchObject({ status: "running" });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale reconciliation scans past an ineligible limited prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-reconcile-prefix-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const blockerTaskId = "task_recover_prefix_blocker" as TaskId;
  const staleTaskId = "task_recover_prefix_stale" as TaskId;

  try {
    await seedTask(store, {
      taskId: blockerTaskId,
      status: "running",
      mode: "resumable",
      time: 10 as TimestampMs,
      childSessionId: "session_recover_prefix_blocker" as SessionId,
    });
    await seedTask(store, {
      taskId: staleTaskId,
      status: "running",
      mode: "background",
      time: 20 as TimestampMs,
      childSessionId: "session_recover_prefix_stale" as SessionId,
    });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 100 as TimestampMs,
    });

    const result = await service.reconcileStaleTasks({ staleAfterMs: 30, limit: 1 });

    expect(result.scanned).toBe(2);
    expect(result.closed.map((task) => task.id)).toEqual([staleTaskId]);
    expect(await store.agentTask(blockerTaskId)).toMatchObject({ status: "running" });
    expect(await store.agentTask(staleTaskId)).toMatchObject({ status: "cancelled" });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale reconciliation cannot close a takeover generation created after its scan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-reconcile-takeover-race-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_takeover" as TaskId;

  try {
    await seedTask(store, { taskId, status: "running", mode: "background", time: 10 as TimestampMs });
    const closeAgentTaskCas = store.closeAgentTaskCas.bind(store);
    let injected = false;
    store.closeAgentTaskCas = async (input) => {
      if (!injected) {
        injected = true;
        const takeoverInput: Parameters<typeof store.claimAgentTaskLease>[0] = {
          taskId,
          generation: input.expectedGeneration,
          owner: "takeover_worker",
          ttlMs: 1_000,
          now: 100,
        };
        if (input.expectedRunId !== null) takeoverInput.runId = input.expectedRunId;
        const takeover = await store.claimAgentTaskLease(takeoverInput);
        expect(takeover.acquired).toBe(true);
      }
      return closeAgentTaskCas(input);
    };
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 100 as TimestampMs,
    });

    const result = await service.reconcileStaleTasks({ staleAfterMs: 30 });

    expect(result).toMatchObject({ scanned: 1, closed: [] });
    expect(await store.agentTask(taskId)).toMatchObject({
      status: "running",
      generation: 1,
      leaseOwner: "takeover_worker",
      leaseExpiresAt: 1_100,
    });
    expect(await store.events({ type: "agent.task_completed", limit: 100 })).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale reconciliation rechecks an expired lease at fenced close time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-reconcile-renew-race-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_renewed" as TaskId;

  try {
    await seedTask(store, { taskId, status: "running", mode: "background", time: 10 as TimestampMs });
    const lease = await store.claimAgentTaskLease({
      taskId,
      owner: "worker_a",
      ttlMs: 10,
      now: 20,
    });
    expect(lease).toMatchObject({ acquired: true, task: { generation: 1, leaseExpiresAt: 30 } });
    const closeAgentTaskCas = store.closeAgentTaskCas.bind(store);
    let injected = false;
    store.closeAgentTaskCas = async (input) => {
      if (!injected) {
        injected = true;
        expect(await store.renewAgentTaskLease({
          taskId,
          owner: "worker_a",
          generation: 1,
          ttlMs: 100,
          now: 29,
        })).toMatchObject({ acquired: true, task: { leaseExpiresAt: 129, updatedAt: 29 } });
      }
      return closeAgentTaskCas(input);
    };
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 100 as TimestampMs,
    });

    const result = await service.reconcileStaleTasks({ staleAfterMs: 30 });

    expect(result).toMatchObject({ scanned: 1, closed: [] });
    expect(await store.agentTask(taskId)).toMatchObject({
      status: "running",
      generation: 1,
      leaseOwner: "worker_a",
      leaseExpiresAt: 129,
      updatedAt: 29,
    });
    expect(await store.events({ type: "agent.task_completed", limit: 100 })).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale reconciliation rechecks task activity after its scan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-reconcile-activity-race-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_reactivated" as TaskId;

  try {
    await seedTask(store, { taskId, status: "running", mode: "background", time: 10 as TimestampMs });
    const closeAgentTaskCas = store.closeAgentTaskCas.bind(store);
    let injected = false;
    store.closeAgentTaskCas = async (input) => {
      if (!injected) {
        injected = true;
        await store.append({
          id: "event_reactivated_mailbox",
          type: "agent.message_queued",
          time: 100 as TimestampMs,
          payload: {
            taskId,
            path: `/root/${taskId}` as AgentPath,
            from: "/root" as AgentPath,
            recipientSessionId: "session_child" as SessionId,
            triggerTurn: false,
            message: { role: "user", content: "new activity" },
          },
        });
      }
      return closeAgentTaskCas(input);
    };
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 100 as TimestampMs,
    });

    const result = await service.reconcileStaleTasks({ staleAfterMs: 30 });

    expect(result).toMatchObject({ scanned: 1, closed: [] });
    expect(await store.agentTask(taskId)).toMatchObject({ status: "running", updatedAt: 100 });
    expect(await store.events({ type: "agent.task_completed", limit: 100 })).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile skips stale background tasks with an active durable lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-reconcile-lease-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const leasedTaskId = "task_leased" as TaskId;

  try {
    await seedTask(store, { taskId: leasedTaskId, status: "running", mode: "background", time: 10 as TimestampMs });
    const lease = await store.claimAgentTaskLease({
      taskId: leasedTaskId,
      owner: "worker_a",
      ttlMs: 1_000,
      now: 90,
    });
    expect(lease.acquired).toBe(true);

    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 100 as TimestampMs,
    });

    const result = await service.reconcileStaleTasks({ staleAfterMs: 30 });

    expect(result.scanned).toBe(1);
    expect(result.closed).toEqual([]);
    expect(await store.agentTask(leasedTaskId)).toMatchObject({
      id: leasedTaskId,
      status: "running",
      leaseOwner: "worker_a",
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("waits for any task in a batch and returns every current task record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-wait-any-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const completedTaskId = "task_completed" as TaskId;
  const runningTaskId = "task_running" as TaskId;

  try {
    await seedTask(store, { taskId: completedTaskId, status: "completed" });
    await seedTask(store, {
      taskId: runningTaskId,
      status: "running",
      childSessionId: "session_child_running" as SessionId,
    });
    const service = new AgentTaskControlService({ store, runtime, createId: createSequentialId() });

    const result = await service.waitForTasks({
      taskIds: [completedTaskId, runningTaskId, runningTaskId],
      waitFor: "any",
      timeoutMs: 25,
    });

    expect(result).toMatchObject({
      waitFor: "any",
      satisfied: true,
      timedOut: false,
      tasks: [
        { id: completedTaskId, status: "completed" },
        { id: runningTaskId, status: "running" },
      ],
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("batch wait timeout returns partial statuses without losing task handles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-wait-timeout-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const completedTaskId = "task_completed" as TaskId;
  const runningTaskId = "task_running" as TaskId;

  try {
    await seedTask(store, { taskId: completedTaskId, status: "completed" });
    await seedTask(store, {
      taskId: runningTaskId,
      status: "running",
      childSessionId: "session_child_running" as SessionId,
    });
    const service = new AgentTaskControlService({
      store,
      runtime,
      createId: createSequentialId(),
      pollIntervalMs: 1,
    });

    const result = await service.waitForTasks({
      taskIds: [completedTaskId, runningTaskId],
      waitFor: "all",
      timeoutMs: 2,
    });

    expect(result).toMatchObject({
      waitFor: "all",
      satisfied: false,
      timedOut: true,
      tasks: [
        { id: completedTaskId, status: "completed" },
        { id: runningTaskId, status: "running" },
      ],
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function seedTask(
  store: SqliteEventStore,
  input: {
    taskId: TaskId;
    status: "running" | "completed";
    mode?: "one_shot" | "resumable" | "background";
    time?: TimestampMs;
    parentSessionId?: SessionId;
    childSessionId?: SessionId;
    dispatchId?: string;
    reservedRunId?: AgentRunId;
    workerPolicy?: Record<string, unknown>;
  },
): Promise<void> {
  const parentSessionId = input.parentSessionId ?? ("session_parent" as SessionId);
  const childSessionId = input.childSessionId ?? ("session_child" as SessionId);
  const runId = input.reservedRunId ?? (`agent_initial_${input.taskId}` as AgentRunId);
  const path = `/root/${input.taskId}` as AgentPath;
  const parentPath = "/root" as AgentPath;
  const time = input.time ?? (1 as TimestampMs);
  const mode = input.mode ?? "one_shot";

  const events: ChiliEvent[] = [
    {
      id: `event_task_created_${input.taskId}`,
      type: "agent.task_created",
      time,
      sessionId: parentSessionId,
      payload: {
        taskId: input.taskId,
        ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
        ...(input.reservedRunId ? { reservedRunId: input.reservedRunId } : {}),
        path,
        parentPath,
        parentSessionId,
        childSessionId,
        taskName: "reader",
        cwd: "/repo",
        prompt: "read package",
        mode,
        ...(input.workerPolicy ? { workerPolicy: input.workerPolicy } : {}),
      },
    },
    {
      id: `event_spawned_${input.taskId}`,
      type: "agent.spawned",
      time,
      sessionId: parentSessionId,
      payload: {
        runId,
        taskId: input.taskId,
        path,
        parentPath,
        parentSessionId,
        childSessionId,
        taskName: "reader",
        cwd: "/repo",
        mode,
      },
    },
  ];

  if (input.status === "completed") {
    events.push({
      id: `event_completed_${input.taskId}`,
      type: "agent.completed",
      time,
      sessionId: parentSessionId,
      payload: {
        runId,
        taskId: input.taskId,
        path,
        status: "completed",
        summary: "initial answer",
      },
    });
  }

  await store.appendMany(events);
}

class FakeTaskRuntime implements AgentTaskPromptRuntime {
  readonly inputs: SubmitPromptInput[] = [];
  readonly interrupts: Array<{ sessionId: SessionId; reason?: string }> = [];
  onSubmit?: (input: SubmitPromptInput) => Promise<void>;
  responseText = "follow-up answer";

  constructor(
    private readonly store: SqliteEventStore,
    private readonly submitError?: Error,
  ) {}

  async submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult> {
    this.inputs.push(input);
    if (this.submitError) throw this.submitError;
    await this.onSubmit?.(input);
    const messageId = "message_followup" as MessageId;
    await this.store.append({
      id: "event_followup_message",
      type: "message.created",
      time: 10 as TimestampMs,
      sessionId: input.sessionId,
      payload: { messageId, role: "assistant" },
    });
    await this.store.append({
      id: "event_followup_part",
      type: "message.part_added",
      time: 10 as TimestampMs,
      sessionId: input.sessionId,
      payload: {
        messageId,
        part: {
          id: "part_followup" as PartId,
          messageId,
          sessionId: input.sessionId,
          type: "text",
          text: this.responseText,
        },
      },
    });
    return {
      status: "completed",
      turns: [
        {
          status: "completed",
          turnId: "turn_followup" as TurnId,
          assistantMessageId: messageId,
          finishReason: "stop",
        },
      ],
      finishReason: "stop",
    };
  }

  async interrupt(sessionId: SessionId, reason?: string): Promise<boolean> {
    const interrupt: { sessionId: SessionId; reason?: string } = { sessionId };
    if (reason) interrupt.reason = reason;
    this.interrupts.push(interrupt);
    return true;
  }
}

function createSequentialId(namespace?: string): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${namespace ? `${namespace}_` : ""}${++index}`;
}

const TASK_CONTROL_HOSTILE_SECRET = "sk-task-control-secret-123456789";

function hostileTaskControlError(label: string): Error {
  const error = new Error(
    `${label}\nAuthorization: Bearer ${TASK_CONTROL_HOSTILE_SECRET}\n`
      + `http://localhost:4321/private?token=${TASK_CONTROL_HOSTILE_SECRET}\n`
      + "\u0000\"\\\n".repeat(Math.ceil((5 * 1024 * 1024) / 4)),
  ) as Error & { code?: string };
  error.name = "TaskRuntimeFailure";
  error.code = "TOKEN_INVALIDATED";
  return error;
}

function expectTaskControlSafeDiagnostic(value: string | undefined): void {
  expect(value).toBeDefined();
  expect(value).toContain("[REDACTED]");
  expect(value).not.toContain(TASK_CONTROL_HOSTILE_SECRET);
  expect(value).not.toContain("localhost:4321");
  expect(new TextEncoder().encode(value ?? "").byteLength).toBeLessThanOrEqual(16 * 1024);
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function abortTestError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve: (value?: T) => resolve(value as T),
  };
}
