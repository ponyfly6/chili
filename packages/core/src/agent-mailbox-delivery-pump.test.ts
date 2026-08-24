import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type {
  AgentPath,
  AgentRunId,
  ChiliEvent,
  MessageId,
  SessionId,
  TaskId,
  TeamId,
  ThreadId,
  TimestampMs,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { AgentMailboxDeliveryPump } from "./agent-mailbox-delivery-pump.js";
import { AgentTreeControlService } from "./agent-tree.js";
import type { SubmitPromptInput, SubmitPromptResult } from "./runtime-service.js";

test("terminal background policies notify only the parent runtime and remain idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-completion-policy-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const childRuntime = new RecordingMailboxRuntime();
  const rootRuntime = new RecordingMailboxRuntime();
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const rootPath = "/root" as AgentPath;
  const cases = [
    { id: "task_notify", mode: "background", policy: "notify", shouldNotify: true },
    { id: "task_join", mode: "background", policy: "join", shouldNotify: false },
    { id: "task_supervised", mode: "background", policy: "supervised", shouldNotify: false },
    { id: "task_detached", mode: "background", policy: "detached", shouldNotify: false },
    { id: "task_legacy", mode: "background", policy: undefined, shouldNotify: true },
    { id: "task_foreground", mode: "one_shot", policy: "notify", shouldNotify: false },
  ] as const;

  try {
    await store.appendMany(
      cases.map((item, index) => taskCreatedEvent({
        id: `event_created_${item.id}`,
        taskId: item.id as TaskId,
        path: `/root/${item.id}` as AgentPath,
        parentPath: rootPath,
        parentSessionId,
        parentThreadId,
        childSessionId: `session_${item.id}` as SessionId,
        childThreadId: `thread_${item.id}` as ThreadId,
        mode: item.mode,
        time: index + 1,
      })),
    );
    const service = new AgentTreeControlService({
      store,
      runtime: childRuntime,
      rootRuntime,
      createId: createSequentialId(),
      now: () => 20 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({ agents: service, events: store, includeExisting: false });
    pump.start();

    const completions = cases.map((item, index) => taskCompletedEvent({
      id: `event_completed_${item.id}`,
      taskId: item.id as TaskId,
      path: `/root/${item.id}` as AgentPath,
      status: "completed",
      summary: `summary for ${item.id}`,
      ...(item.policy ? { policy: item.policy } : {}),
      parentSessionId,
      parentThreadId,
      time: 10 + index,
    }));
    await store.appendMany(completions);
    await pump.waitForIdle();

    expect(childRuntime.prompts).toEqual([]);
    expect(rootRuntime.prompts).toHaveLength(cases.filter((item) => item.shouldNotify).length);
    expect(rootRuntime.prompts.map((prompt) => prompt.sessionId)).toEqual([parentSessionId, parentSessionId]);
    expect(rootRuntime.prompts.map((prompt) => prompt.threadId)).toEqual([parentThreadId, parentThreadId]);
    const completionMessages = (await service.mailbox({ limit: 20 })).filter(
      (message) => message.message?.metadata?.kind === "subagent_completion_batch",
    );
    expect(completionMessages).toHaveLength(2);
    expect(completionMessages.every((message) => message.path === rootPath && message.status === "consumed")).toBe(true);
    expect(completionMessages.map((message) => message.fromPath).sort()).toEqual([
      "/root/task_legacy",
      "/root/task_notify",
    ]);

    await service.notifyTaskCompletion(completions[0] as Extract<ChiliEvent, { type: "agent.task_completed" }>);
    await pump.waitForIdle();
    expect(rootRuntime.prompts).toHaveLength(2);

    await pump.stop();
    pump.start();
    await pump.waitForIdle();
    await pump.stop();
    expect(rootRuntime.prompts).toHaveLength(2);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("completion notification retries only after the matching parent becomes idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-completion-retry-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const rootRuntime = new FailOnceMailboxRuntime();
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const taskId = "task_notify" as TaskId;
  const path = "/root/task_notify" as AgentPath;

  try {
    await store.append(taskCreatedEvent({
      id: "event_created",
      taskId,
      path,
      parentPath: "/root" as AgentPath,
      parentSessionId,
      parentThreadId,
      childSessionId: "session_child" as SessionId,
      childThreadId: "thread_child" as ThreadId,
      mode: "background",
      time: 1,
    }));
    const service = new AgentTreeControlService({
      store,
      runtime: new RecordingMailboxRuntime(),
      rootRuntime,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({ agents: service, events: store, includeExisting: false });
    pump.start();

    await store.append(taskCompletedEvent({
      id: "event_completed",
      taskId,
      path,
      status: "failed",
      error: "provider unavailable",
      policy: "notify",
      parentSessionId,
      parentThreadId,
      time: 2,
    }));
    await pump.waitForIdle();
    expect(rootRuntime.attempts).toBe(1);
    expect(await service.mailbox({ status: "queued" })).toHaveLength(1);

    await store.append(sessionStatusEvent("event_unrelated_idle", "session_other" as SessionId, "thread_other" as ThreadId, "idle", 3));
    await pump.waitForIdle();
    await store.append(sessionStatusEvent("event_parent_running", parentSessionId, parentThreadId, "running", 4));
    await pump.waitForIdle();
    expect(rootRuntime.attempts).toBe(1);

    await store.append(sessionStatusEvent("event_parent_idle", parentSessionId, parentThreadId, "idle", 5));
    await pump.waitForIdle();
    expect(rootRuntime.attempts).toBe(2);
    expect(rootRuntime.prompts).toHaveLength(1);
    expect(await service.mailbox({ status: "queued" })).toEqual([]);

    await store.append(sessionStatusEvent("event_parent_idle_again", parentSessionId, parentThreadId, "idle", 6));
    await pump.waitForIdle();
    await pump.stop();
    expect(rootRuntime.attempts).toBe(2);
    expect(await store.events({ type: "agent.message_requeued", limit: 10 })).toHaveLength(1);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup recovery scans terminal task rows instead of a bounded event tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-completion-recovery-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const rootRuntime = new RecordingMailboxRuntime();
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;

  try {
    await store.appendMany([
      taskCreatedEvent({
        id: "event_created_notify",
        taskId: "task_notify" as TaskId,
        path: "/root/task_notify" as AgentPath,
        parentPath: "/root" as AgentPath,
        parentSessionId,
        parentThreadId,
        childSessionId: "session_notify" as SessionId,
        childThreadId: "thread_notify" as ThreadId,
        mode: "background",
        completionPolicy: "notify",
        time: 1,
      }),
      taskCompletedEvent({
        id: "event_completed_notify",
        taskId: "task_notify" as TaskId,
        path: "/root/task_notify" as AgentPath,
        status: "completed",
        summary: "recover this older completion",
        parentSessionId,
        parentThreadId,
        time: 2,
      }),
      taskCreatedEvent({
        id: "event_created_detached",
        taskId: "task_detached" as TaskId,
        path: "/root/task_detached" as AgentPath,
        parentPath: "/root" as AgentPath,
        parentSessionId,
        parentThreadId,
        childSessionId: "session_detached" as SessionId,
        childThreadId: "thread_detached" as ThreadId,
        mode: "background",
        completionPolicy: "detached",
        time: 3,
      }),
      taskCompletedEvent({
        id: "event_completed_detached",
        taskId: "task_detached" as TaskId,
        path: "/root/task_detached" as AgentPath,
        status: "completed",
        summary: "newer terminal event must not hide notify",
        parentSessionId,
        parentThreadId,
        time: 4,
      }),
    ]);
    const service = new AgentTreeControlService({
      store,
      runtime: new RecordingMailboxRuntime(),
      rootRuntime,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({
      agents: service,
      events: store,
      maxInitialDrain: 1,
    });

    pump.start();
    await pump.waitForIdle();
    await pump.stop();

    expect(rootRuntime.prompts).toHaveLength(1);
    expect(rootRuntime.prompts[0]?.text).toContain("recover this older completion");
    expect(await service.mailbox({ status: "consumed" })).toHaveLength(1);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup delivery is not starved by more than maxInitialDrain queue-only messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-mailbox-startup-filter-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const runtime = new RecordingMailboxRuntime();
  const childSessionId = "session_startup_filter" as SessionId;
  const childThreadId = "thread_startup_filter" as ThreadId;
  const path = "/root/startup_filter" as AgentPath;

  try {
    const queueOnly = Array.from({ length: 1_001 }, (_, index): ChiliEvent => ({
      id: `event_queue_only_${index.toString().padStart(4, "0")}`,
      type: "agent.message_queued",
      time: (index + 1) as TimestampMs,
      sessionId: childSessionId,
      threadId: childThreadId,
      payload: {
        path,
        from: "/root" as AgentPath,
        childSessionId,
        childThreadId,
        triggerTurn: false,
        message: { role: "user", content: `queue only ${index}` },
      },
    }));
    await store.appendMany([
      ...queueOnly,
      {
        id: "event_trigger_after_queue_only_prefix",
        type: "agent.message_queued",
        time: 1_002 as TimestampMs,
        sessionId: childSessionId,
        threadId: childThreadId,
        payload: {
          path,
          from: "/root" as AgentPath,
          childSessionId,
          childThreadId,
          triggerTurn: true,
          message: { role: "user", content: "deliver after restart" },
        },
      },
    ]);
    expect((await store.agentMailbox({
      status: "queued",
      triggerTurn: true,
      limit: 2_000,
    })).map((message) => message.id)).toEqual(["event_trigger_after_queue_only_prefix"]);
    expect(await store.agentMailbox({
      status: "queued",
      triggerTurn: false,
      limit: 2_000,
    })).toHaveLength(1_001);

    const service = new AgentTreeControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 2_000 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({
      agents: service,
      events: store,
      maxInitialDrain: 1_000,
    });

    pump.start();
    await within(pump.waitForIdle(), 2_000, "startup trigger delivery beyond a queue-only prefix");
    await pump.stop();

    expect(runtime.prompts).toHaveLength(1);
    expect(runtime.prompts[0]?.text).toBe("deliver after restart");
    expect(await service.mailbox({
      messageId: "event_trigger_after_queue_only_prefix",
      triggerTurn: true,
    })).toMatchObject([{ status: "consumed" }]);
    expect(await service.mailbox({
      status: "queued",
      triggerTurn: false,
      limit: 2_000,
    })).toHaveLength(1_001);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a trigger message for a pending child stays queued until the initial task is terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-pending-mailbox-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const childRuntime = new RecordingMailboxRuntime();
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const taskId = "task_pending" as TaskId;
  const path = "/root/task_pending" as AgentPath;
  const followups: string[] = [];

  try {
    await store.append(taskCreatedEvent({
      id: "event_created",
      taskId,
      path,
      parentPath: "/root" as AgentPath,
      parentSessionId,
      parentThreadId,
      childSessionId,
      childThreadId,
      mode: "resumable",
      completionPolicy: "join",
      time: 1,
    }));
    const service = new AgentTreeControlService({
      store,
      runtime: childRuntime,
      taskTurns: {
        async followupTask(input) {
          followups.push(input.text);
          const task = await store.agentTask(input.taskId);
          if (!task) throw new Error("missing task");
          return { task, result: completedPromptResult() };
        },
      },
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({ agents: service, events: store, includeExisting: false });
    pump.start();

    await store.append({
      id: "event_pending_message",
      type: "agent.message_queued",
      time: 2 as TimestampMs,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        taskId,
        path,
        from: "/root" as AgentPath,
        childSessionId,
        childThreadId,
        triggerTurn: true,
        message: { role: "user", content: "follow up after the initial run" },
      },
    });
    await within(
      pump.waitForIdle(),
      500,
      "a pending child mailbox lane to become quiescent without a retry timer",
    );
    expect(followups).toEqual([]);
    expect(await service.mailbox({ messageId: "event_pending_message" })).toMatchObject([{ status: "queued" }]);

    await store.append({
      id: "event_spawned",
      type: "agent.spawned",
      time: 3 as TimestampMs,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        runId: "agent_initial" as AgentRunId,
        taskId,
        path,
        parentPath: "/root" as AgentPath,
        parentSessionId,
        parentThreadId,
        childSessionId,
        childThreadId,
        taskName: taskId,
        cwd: "/repo",
        mode: "resumable",
        generation: 1,
        completionPolicy: "join",
      },
    });
    await store.append(sessionStatusEvent("event_child_idle_while_running", childSessionId, childThreadId, "idle", 4));
    await within(
      pump.waitForIdle(),
      500,
      "a still-running child mailbox lane to remain quiescent after idle",
    );
    expect(followups).toEqual([]);

    const completed = taskCompletedEvent({
      id: "event_initial_completed",
      taskId,
      path,
      status: "completed",
      summary: "initial run done",
      parentSessionId,
      parentThreadId,
      time: 5,
    });
    await store.append(completed);
    await within(
      pump.waitForIdle(),
      500,
      "the terminal task event to wake and drain the deferred mailbox lane",
    );

    expect(followups).toEqual(["follow up after the initial run"]);
    expect(childRuntime.prompts).toEqual([]);
    expect(await service.mailbox({ messageId: "event_pending_message" })).toMatchObject([{ status: "consumed" }]);

    await store.append({ ...completed, id: "event_duplicate_completion", time: 6 as TimestampMs });
    await pump.waitForIdle();
    await pump.stop();
    expect(followups).toHaveLength(1);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("notify batches wait for every expected task and wake the parent once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-completion-batch-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const rootRuntime = new RecordingMailboxRuntime();
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const sourceCallId = "call_batch" as ToolCallId;
  const batchId = "batch_shared";
  const firstTaskId = "task_first" as TaskId;
  const secondTaskId = "task_second" as TaskId;

  try {
    await store.append(taskCreatedEvent({
      id: "event_created_first",
      taskId: firstTaskId,
      path: "/root/task_first" as AgentPath,
      parentPath: "/root" as AgentPath,
      parentSessionId,
      parentThreadId,
      childSessionId: "session_first" as SessionId,
      childThreadId: "thread_first" as ThreadId,
      mode: "background",
      sourceCallId,
      batchId,
      batchIndex: 0,
      expectedBatchSize: 2,
      completionPolicy: "notify",
      time: 1,
    }));
    const service = new AgentTreeControlService({
      store,
      runtime: new RecordingMailboxRuntime(),
      rootRuntime,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({ agents: service, events: store, includeExisting: false });
    pump.start();

    await store.append(taskCompletedEvent({
      id: "event_completed_first",
      taskId: firstTaskId,
      path: "/root/task_first" as AgentPath,
      status: "completed",
      summary: "x".repeat(2000),
      parentSessionId,
      parentThreadId,
      time: 3,
    }));
    await pump.waitForIdle();
    expect(rootRuntime.prompts).toEqual([]);
    expect(await service.mailbox({ limit: 10 })).toEqual([]);

    await store.append(taskCreatedEvent({
      id: "event_created_second",
      taskId: secondTaskId,
      path: "/root/task_second" as AgentPath,
      parentPath: "/root" as AgentPath,
      parentSessionId,
      parentThreadId,
      childSessionId: "session_second" as SessionId,
      childThreadId: "thread_second" as ThreadId,
      mode: "background",
      sourceCallId,
      batchId,
      batchIndex: 1,
      expectedBatchSize: 2,
      completionPolicy: "notify",
      time: 4,
    }));
    await store.append(taskCompletedEvent({
      id: "event_completed_second",
      taskId: secondTaskId,
      path: "/root/task_second" as AgentPath,
      status: "failed",
      error: "provider rate limited",
      parentSessionId,
      parentThreadId,
      time: 5,
    }));
    await pump.waitForIdle();

    expect(rootRuntime.prompts).toHaveLength(1);
    const text = rootRuntime.prompts[0]?.text ?? "";
    expect(text).toContain('"total":2');
    expect(text).toContain('"completed":1');
    expect(text).toContain('"failed":1');
    expect(text).toContain('"taskId":"task_first"');
    expect(text).toContain('"taskId":"task_second"');
    expect(text).not.toContain("x".repeat(1000));
    expect(await service.mailbox({ status: "consumed" })).toHaveLength(1);

    await store.append({
      id: "event_spawned_second_generation",
      type: "agent.spawned",
      time: 6 as TimestampMs,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        runId: "agent_second_generation" as AgentRunId,
        taskId: secondTaskId,
        path: "/root/task_second" as AgentPath,
        parentPath: "/root" as AgentPath,
        parentSessionId,
        parentThreadId,
        childSessionId: "session_second" as SessionId,
        childThreadId: "thread_second" as ThreadId,
        taskName: secondTaskId,
        cwd: "/repo",
        mode: "background",
        generation: 2,
        sourceCallId,
        batchId,
        batchIndex: 1,
        expectedBatchSize: 2,
        completionPolicy: "notify",
      },
    });
    const secondGeneration = taskCompletedEvent({
      id: "event_completed_second_generation",
      taskId: secondTaskId,
      path: "/root/task_second" as AgentPath,
      status: "completed",
      summary: "retry completed",
      generation: 2,
      parentSessionId,
      parentThreadId,
      time: 7,
    });
    await store.append(secondGeneration);
    await pump.waitForIdle();
    expect(rootRuntime.prompts).toHaveLength(2);
    expect(rootRuntime.prompts[1]?.text).toContain("retry completed");
    expect(await service.mailbox({ status: "consumed" })).toHaveLength(2);

    await service.notifyTaskCompletion(secondGeneration);
    await pump.waitForIdle();
    await pump.stop();
    expect(rootRuntime.prompts).toHaveLength(2);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a sealed partial notify batch uses the tasks that were actually created", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-completion-seal-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const rootRuntime = new RecordingMailboxRuntime();
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const sourceCallId = "call_partial" as ToolCallId;
  const taskId = "task_only_created" as TaskId;

  try {
    await store.append(taskCreatedEvent({
      id: "event_created",
      taskId,
      path: "/root/task_only_created" as AgentPath,
      parentPath: "/root" as AgentPath,
      parentSessionId,
      parentThreadId,
      childSessionId: "session_child" as SessionId,
      childThreadId: "thread_child" as ThreadId,
      mode: "background",
      sourceCallId,
      batchId: "batch_partial",
      batchIndex: 0,
      expectedBatchSize: 2,
      completionPolicy: "notify",
      time: 1,
    }));
    const service = new AgentTreeControlService({
      store,
      runtime: new RecordingMailboxRuntime(),
      rootRuntime,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({ agents: service, events: store, includeExisting: false });
    pump.start();

    await store.append(taskCompletedEvent({
      id: "event_completed",
      taskId,
      path: "/root/task_only_created" as AgentPath,
      status: "completed",
      summary: "only successful spawn",
      parentSessionId,
      parentThreadId,
      time: 2,
    }));
    await pump.waitForIdle();
    expect(rootRuntime.prompts).toEqual([]);

    await store.append({
      id: "event_batch_sealed",
      type: "tool.call_finished",
      time: 3 as TimestampMs,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        callId: sourceCallId,
        status: "failed",
        error: "second spawn failed",
      },
    });
    await pump.waitForIdle();
    await pump.stop();

    expect(rootRuntime.prompts).toHaveLength(1);
    expect(rootRuntime.prompts[0]?.text).toContain('"total":1');
    expect(rootRuntime.prompts[0]?.text).toContain('"expectedBatchSize":2');
    expect(rootRuntime.prompts[0]?.text).toContain('"spawned":1');
    expect(rootRuntime.prompts[0]?.text).toContain('"terminal":1');
    expect(rootRuntime.prompts[0]?.text).toContain('"untracked":1');
    expect(rootRuntime.prompts[0]?.text).toContain("only successful spawn");
    expect(await service.mailbox({ status: "consumed" })).toHaveLength(1);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit parent recipients override child task routing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-parent-routing-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const childRuntime = new RecordingMailboxRuntime();
  const rootRuntime = new RecordingMailboxRuntime();
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const taskId = "task_child" as TaskId;

  try {
    await store.appendMany([
      taskCreatedEvent({
        id: "event_created",
        taskId,
        path: "/root/task_child" as AgentPath,
        parentPath: "/root" as AgentPath,
        parentSessionId,
        parentThreadId,
        childSessionId: "session_child" as SessionId,
        childThreadId: "thread_child" as ThreadId,
        mode: "background",
        time: 1,
      }),
      {
        id: "event_parent_mailbox",
        type: "agent.message_queued",
        time: 2 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          taskId,
          path: "/root" as AgentPath,
          from: "/root/task_child" as AgentPath,
          childSessionId: parentSessionId,
          childThreadId: parentThreadId,
          triggerTurn: true,
          message: { role: "user", content: "parent completion" },
        },
      },
    ]);
    const service = new AgentTreeControlService({
      store,
      runtime: childRuntime,
      rootRuntime,
      createId: createSequentialId(),
      now: () => 3 as TimestampMs,
    });

    await service.consumeMailbox({ messageId: "event_parent_mailbox" });

    expect(childRuntime.prompts).toEqual([]);
    expect(rootRuntime.prompts).toMatchObject([
      { sessionId: parentSessionId, threadId: parentThreadId, text: "parent completion" },
    ]);
    const consumed = (await store.events({ type: "agent.message_consumed", limit: 10 }))[0];
    expect(consumed?.sessionId).toBe(parentSessionId);
    expect(consumed?.threadId).toBe(parentThreadId);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed team trigger delivery leaves the member blocked and mailbox queued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-team-mailbox-failure-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const teamId = "team_mailbox" as TeamId;
  const workerPath = "/root/worker" as AgentPath;
  const childSessionId = "session_worker" as SessionId;
  const childThreadId = "thread_worker" as ThreadId;

  try {
    await store.appendMany([
      {
        id: "event_team_created",
        type: "team.created",
        time: 1 as TimestampMs,
        payload: { teamId, name: "mailbox team", leadPath: "/root" as AgentPath },
      },
      {
        id: "event_member_added",
        type: "team.member_added",
        time: 2 as TimestampMs,
        payload: {
          teamId,
          path: workerPath,
          name: "worker",
          role: "implementer",
          status: "idle",
          childSessionId,
          childThreadId,
        },
      },
      teamMailboxEvent("event_team_failure", teamId, "teammsg_failure", workerPath, childSessionId, childThreadId, 3),
    ]);
    const service = new AgentTreeControlService({
      store,
      runtime: new RecordingMailboxRuntime(new Error("worker turn failed")),
      createId: createSequentialId(),
      now: () => 4 as TimestampMs,
    });

    await expect(service.consumeMailbox({ messageId: "event_team_failure" })).rejects.toThrow("worker turn failed");

    const statuses = (await store.events({ type: "team.member_status_changed", limit: 20 })).map(
      (event) => (event as Extract<ChiliEvent, { type: "team.member_status_changed" }>).payload.status,
    );
    expect(statuses).toEqual(["running", "blocked"]);
    expect(await store.teamMembers({ teamId, path: workerPath })).toMatchObject([{ status: "blocked" }]);
    expect(await service.mailbox({ messageId: "event_team_failure" })).toMatchObject([{ status: "queued" }]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function taskCreatedEvent(input: {
  id: string;
  taskId: TaskId;
  path: AgentPath;
  parentPath: AgentPath;
  parentSessionId: SessionId;
  parentThreadId: ThreadId;
  childSessionId: SessionId;
  childThreadId: ThreadId;
  mode: "background" | "one_shot" | "resumable";
  sourceCallId?: ToolCallId;
  batchId?: string;
  batchIndex?: number;
  expectedBatchSize?: number;
  completionPolicy?: "join" | "notify" | "detached" | "supervised";
  time: number;
}): Extract<ChiliEvent, { type: "agent.task_created" }> {
  return {
    id: input.id,
    type: "agent.task_created",
    time: input.time as TimestampMs,
    sessionId: input.parentSessionId,
    threadId: input.parentThreadId,
    payload: {
      taskId: input.taskId,
      path: input.path,
      parentPath: input.parentPath,
      parentSessionId: input.parentSessionId,
      parentThreadId: input.parentThreadId,
      childSessionId: input.childSessionId,
      childThreadId: input.childThreadId,
      taskName: input.taskId,
      cwd: "/repo",
      prompt: `run ${input.taskId}`,
      mode: input.mode,
      ...(input.sourceCallId ? { sourceCallId: input.sourceCallId } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.batchIndex !== undefined ? { batchIndex: input.batchIndex } : {}),
      ...(input.expectedBatchSize !== undefined ? { expectedBatchSize: input.expectedBatchSize } : {}),
      ...(input.completionPolicy ? { completionPolicy: input.completionPolicy } : {}),
    },
  };
}

function taskCompletedEvent(input: {
  id: string;
  taskId: TaskId;
  path: AgentPath;
  status: "completed" | "incomplete" | "failed" | "cancelled";
  summary?: string;
  error?: string;
  generation?: number;
  policy?: "join" | "notify" | "detached" | "supervised";
  batchId?: string;
  parentSessionId: SessionId;
  parentThreadId: ThreadId;
  time: number;
}): Extract<ChiliEvent, { type: "agent.task_completed" }> {
  const payload: Extract<ChiliEvent, { type: "agent.task_completed" }>["payload"] = {
    taskId: input.taskId,
    path: input.path,
    status: input.status,
    generation: input.generation ?? 1,
  };
  if (input.summary) payload.summary = input.summary;
  if (input.error) payload.error = input.error;
  if (input.policy || input.batchId) {
    payload.metadata = {
      ...(input.policy ? { completionPolicy: input.policy } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
    };
  }
  return {
    id: input.id,
    type: "agent.task_completed",
    time: input.time as TimestampMs,
    sessionId: input.parentSessionId,
    threadId: input.parentThreadId,
    payload,
  };
}

function sessionStatusEvent(
  id: string,
  sessionId: SessionId,
  threadId: ThreadId,
  status: "running" | "idle",
  time: number,
): Extract<ChiliEvent, { type: "session.status_changed" }> {
  return {
    id,
    type: "session.status_changed",
    time: time as TimestampMs,
    sessionId,
    threadId,
    payload: { sessionId, status },
  };
}

function teamMailboxEvent(
  id: string,
  teamId: TeamId,
  teamMessageId: string,
  path: AgentPath,
  childSessionId: SessionId,
  childThreadId: ThreadId,
  time: number,
): Extract<ChiliEvent, { type: "agent.message_queued" }> {
  return {
    id,
    type: "agent.message_queued",
    time: time as TimestampMs,
    sessionId: childSessionId,
    threadId: childThreadId,
    payload: {
      path,
      from: "/root" as AgentPath,
      childSessionId,
      childThreadId,
      triggerTurn: true,
      message: {
        role: "user",
        content: `team message ${teamMessageId}`,
        metadata: { teamId, teamMessageId },
      },
    },
  };
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

class RecordingMailboxRuntime {
  readonly messages: Array<{ sessionId: SessionId; threadId: ThreadId; text: string }> = [];
  readonly prompts: SubmitPromptInput[] = [];

  constructor(private readonly error?: Error) {}

  async appendUserMessage(input: { sessionId: SessionId; threadId: ThreadId; text: string }): Promise<MessageId> {
    this.messages.push(input);
    return "message_mailbox" as MessageId;
  }

  async submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult> {
    this.prompts.push(input);
    if (this.error) throw this.error;
    return completedPromptResult();
  }
}

class FailOnceMailboxRuntime extends RecordingMailboxRuntime {
  attempts = 0;

  override async submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult> {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error("parent session is busy");
    return super.submitPrompt(input);
  }
}

function completedPromptResult(): SubmitPromptResult {
  return {
    status: "completed",
    turns: [
      {
        status: "completed",
        turnId: "turn_mailbox" as TurnId,
        assistantMessageId: "message_assistant" as MessageId,
        finishReason: "stop",
      },
    ],
    finishReason: "stop",
  };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
