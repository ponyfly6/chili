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
  ThreadId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type { SubmitPromptInput, SubmitPromptResult } from "./runtime-service.js";
import type { AgentTaskPromptRuntime } from "./task-control.js";
import { AgentTaskControlService } from "./task-control.js";

test("follows up an existing task through the child session and records a new run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-followup-"));
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
      system: ["child base system"],
    });

    const result = await service.followupTask({
      taskId,
      text: "check the package name again",
      maxTurns: 3,
    });

    expect(runtime.inputs[0]).toMatchObject({
      sessionId: "session_child",
      threadId: "thread_child",
      cwd: "/repo",
      text: "check the package name again",
      maxTurns: 3,
    });
    expect(runtime.inputs[0]?.system).toEqual([
      "child base system",
      "Subagent task id: task_reader. Agent path: /root/task_reader. This is a follow-up for an existing task; answer in the task context and call complete_task with this task id when finished.",
    ]);
    expect(result.result.status).toBe("completed");
    expect(result.task).toMatchObject({
      id: taskId,
      status: "completed",
      currentRunId: "agent_1",
      summary: "follow-up answer",
    });

    const events = await store.events({ limit: 100 });
    expect(events.map((event) => event.type)).toContain("agent.message_queued");
    expect(events.map((event) => event.type)).toContain("agent.message_consumed");
    expect(events.map((event) => event.type)).toContain("agent.spawned");
    expect(events.at(-1)).toMatchObject({
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

test("leaves a follow-up mailbox message queued when runtime submission fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-followup-failure-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store, new Error("runtime unavailable"));
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
      threadId: "thread_child",
      text: "try the follow-up again",
    });
    expect(await store.agentMailbox({ taskId })).toMatchObject([
      {
        id: "event_2",
        taskId,
        status: "queued",
        triggerTurn: true,
        message: { role: "user", content: "try the follow-up again" },
      },
    ]);
    expect((await store.agentMailbox({ taskId }))[0]?.consumedAt).toBeUndefined();
    expect(await store.agentMailbox({ status: "consumed" })).toEqual([]);
    expect((await store.events({ limit: 100 })).map((event) => event.type)).not.toContain("agent.message_consumed");
    expect(await store.agentTask(taskId)).toMatchObject({
      id: taskId,
      status: "failed",
      currentRunId: "agent_1",
      error: "runtime unavailable",
    });
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

test("closes a running task and interrupts the child session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-close-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeTaskRuntime(store);
  const taskId = "task_running" as TaskId;

  try {
    await seedTask(store, { taskId, status: "running" });
    const interruptedTaskIds: TaskId[] = [];
    const service = new AgentTaskControlService({
      store,
      runtime,
      interruptTask(taskId) {
        interruptedTaskIds.push(taskId);
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

    expect(interruptedTaskIds).toEqual([taskId]);
    expect(runtime.interrupts).toEqual([{ sessionId: "session_child" as SessionId, reason: "task_closed" }]);
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

async function seedTask(
  store: SqliteEventStore,
  input: { taskId: TaskId; status: "running" | "completed" },
): Promise<void> {
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const runId = "agent_initial" as AgentRunId;
  const path = `/root/${input.taskId}` as AgentPath;
  const parentPath = "/root" as AgentPath;
  const time = 1 as TimestampMs;

  const events: ChiliEvent[] = [
    {
      id: "event_task_created",
      type: "agent.task_created",
      time,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        taskId: input.taskId,
        path,
        parentPath,
        parentSessionId,
        parentThreadId,
        childSessionId,
        childThreadId,
        taskName: "reader",
        cwd: "/repo",
        prompt: "read package",
        mode: "one_shot",
      },
    },
    {
      id: "event_spawned",
      type: "agent.spawned",
      time,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        runId,
        taskId: input.taskId,
        path,
        parentPath,
        parentSessionId,
        parentThreadId,
        childSessionId,
        childThreadId,
        taskName: "reader",
        cwd: "/repo",
        mode: "one_shot",
      },
    },
  ];

  if (input.status === "completed") {
    events.push({
      id: "event_completed",
      type: "agent.completed",
      time,
      sessionId: parentSessionId,
      threadId: parentThreadId,
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
      threadId: input.threadId,
      payload: { messageId, role: "assistant" },
    });
    await this.store.append({
      id: "event_followup_part",
      type: "message.part_added",
      time: 10 as TimestampMs,
      sessionId: input.sessionId,
      threadId: input.threadId,
      payload: {
        messageId,
        part: {
          id: "part_followup" as PartId,
          messageId,
          sessionId: input.sessionId,
          type: "text",
          text: "follow-up answer",
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

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}
