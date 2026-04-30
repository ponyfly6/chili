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
import { SqliteEventStore } from "@chili/store";
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

test("runs a child task through an AgentRunner", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeChildRunner(store);
  const subagentRunner = new AgentRunnerSubagentRunner({
    runner,
    store,
    maxTurns: 2,
    system: ["child system"],
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
      "child system",
      "Subagent task id: task_child. Repository cwd: /repo. Agent path: /root/task_child (logical agent identifier, not a filesystem path). Use repository-relative paths, or absolute paths under the repository cwd; never prefix file paths with the agent path. When the task is complete, either provide a final concise answer or call complete_task with this task id and a clear summary.",
    ],
  });
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
    status: "running",
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

    await store.append({
      id: "event_external_close",
      type: "agent.task_completed",
      time: 101 as TimestampMs,
      sessionId: "session_parent" as SessionId,
      threadId: "thread_parent" as ThreadId,
      payload: {
        taskId: task.taskId,
        path: task.path,
        runId: task.runId,
        generation: (leasedTask?.generation ?? 0) + 1,
        status: "cancelled",
        summary: "external close",
      },
    });

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

    await store.append({
      id: "event_external_close_before_finish",
      type: "agent.task_completed",
      time: 101 as TimestampMs,
      sessionId: "session_parent" as SessionId,
      threadId: "thread_parent" as ThreadId,
      payload: {
        taskId: task.taskId,
        path: task.path,
        runId: task.runId,
        generation: (leasedTask?.generation ?? 0) + 1,
        status: "cancelled",
        summary: "external close",
      },
    });

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
    expect(await store.events({ type: "agent.completed", limit: 10 })).toEqual([]);
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

  await Promise.resolve();
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

  await Promise.resolve();
  expect(await manager.interruptTask(task.taskId)).toBe(true);
  finish();
  await manager.waitForBackgroundTasks();
  expect(store.items.map((event) => event.type)).toEqual(["agent.task_created", "agent.spawned"]);
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

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}
