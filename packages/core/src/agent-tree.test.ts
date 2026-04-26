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
  ThreadId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type { SubmitPromptInput, SubmitPromptResult } from "./runtime-service.js";
import { AgentTreeControlService } from "./agent-tree.js";

test("builds an agent path tree and consumes mailbox messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-tree-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const taskId = "task_child" as TaskId;
  const rootPath = "/root" as AgentPath;
  const childPath = "/root/task_child" as AgentPath;

  try {
    await store.appendMany([
      agentSpawned("event_root", "agent_root" as AgentRunId, rootPath, undefined, "lead", 1),
      {
        id: "event_task_created",
        type: "agent.task_created",
        time: 2 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          parentThreadId,
          childSessionId,
          childThreadId,
          taskName: "reader",
          cwd: "/repo",
          prompt: "read",
          mode: "one_shot",
        },
      },
      {
        id: "event_child_run_1",
        type: "agent.spawned",
        time: 3 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          runId: "agent_child_1" as AgentRunId,
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          parentThreadId,
          childSessionId,
          childThreadId,
          taskName: "reader",
          cwd: "/repo",
          mode: "one_shot",
        },
      },
      {
        id: "event_child_run_2",
        type: "agent.spawned",
        time: 4 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          runId: "agent_child_2" as AgentRunId,
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          parentThreadId,
          childSessionId,
          childThreadId,
          taskName: "reader followup",
          cwd: "/repo",
          mode: "one_shot",
        },
      },
      {
        id: "event_mailbox",
        type: "agent.message_queued",
        time: 5 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          taskId,
          path: childPath,
          from: rootPath,
          childSessionId,
          childThreadId,
          triggerTurn: true,
          message: { role: "user", content: "continue" },
        },
      },
    ]);

    const service = new AgentTreeControlService({
      store,
      createId: createSequentialId(),
      now: () => 6 as TimestampMs,
    });

    const snapshot = await service.snapshot({ rootPath });
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]).toMatchObject({
      path: rootPath,
      taskName: "lead",
      children: [
        {
          path: childPath,
          taskName: "reader followup",
          runIds: ["agent_child_1", "agent_child_2"],
          mailbox: [{ id: "event_mailbox", status: "queued" }],
        },
      ],
    });

    const consumed = await service.consumeMailbox({ messageId: "event_mailbox", consumedBy: childPath });
    expect(consumed).toMatchObject({
      id: "event_mailbox",
      status: "consumed",
      consumedAt: 6,
    });
    expect(await service.mailbox({ status: "queued" })).toEqual([]);
    expect((await service.snapshot({ rootPath })).nodes[0]?.children[0]?.mailbox).toEqual([]);
    expect((await service.snapshot({ rootPath, includeConsumedMailbox: true })).nodes[0]?.children[0]?.mailbox).toMatchObject([
      { id: "event_mailbox", status: "consumed" },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("synthesizes missing root and ancestor nodes from agent paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-tree-ancestors-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const rootPath = "/root" as AgentPath;
  const reviewerPath = "/root/reviewer" as AgentPath;
  const childPath = "/root/reviewer/reader" as AgentPath;

  try {
    await store.append(
      agentSpawned(
        "event_reader",
        "agent_reader" as AgentRunId,
        childPath,
        reviewerPath,
        "reader",
        5,
      ),
    );
    const service = new AgentTreeControlService({ store });

    const snapshot = await service.snapshot({ rootPath });

    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]).toMatchObject({
      path: rootPath,
      taskName: "",
      status: "empty",
      children: [
        {
          path: reviewerPath,
          taskName: "",
          status: "empty",
          children: [
            {
              path: childPath,
              parentPath: reviewerPath,
              taskName: "reader",
              runIds: ["agent_reader"],
            },
          ],
        },
      ],
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("delivers mailbox messages to child sessions before consuming them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-tree-delivery-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeMailboxRuntime();
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const taskId = "task_child" as TaskId;
  const rootPath = "/root" as AgentPath;
  const childPath = "/root/task_child" as AgentPath;

  try {
    await store.appendMany([
      {
        id: "event_task_created",
        type: "agent.task_created",
        time: 1 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          parentThreadId,
          childSessionId,
          childThreadId,
          taskName: "reader",
          cwd: "/repo",
          prompt: "read",
          mode: "resumable",
        },
      },
      {
        id: "event_mailbox",
        type: "agent.message_queued",
        time: 2 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          taskId,
          path: childPath,
          from: rootPath,
          childSessionId,
          childThreadId,
          triggerTurn: true,
          message: { role: "user", content: "continue from mailbox" },
        },
      },
    ]);

    const service = new AgentTreeControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 3 as TimestampMs,
    });

    const consumed = await service.consumeMailbox({ messageId: "event_mailbox" });

    expect(runtime.prompts).toMatchObject([
      {
        sessionId: childSessionId,
        threadId: childThreadId,
        cwd: "/repo",
        text: "continue from mailbox",
      },
    ]);
    expect(consumed).toMatchObject({
      id: "event_mailbox",
      status: "consumed",
      consumedAt: 3,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps mailbox queued when delivery fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-tree-delivery-failure-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeMailboxRuntime(new Error("child session is busy"));
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const childPath = "/root/task_child" as AgentPath;

  try {
    await store.append({
      id: "event_mailbox",
      type: "agent.message_queued",
      time: 1 as TimestampMs,
      payload: {
        path: childPath,
        from: "/root" as AgentPath,
        childSessionId,
        childThreadId,
        triggerTurn: true,
        message: { role: "user", content: "continue" },
      },
    });
    const service = new AgentTreeControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 2 as TimestampMs,
    });

    await expect(service.consumeMailbox({ messageId: "event_mailbox" })).rejects.toThrow("child session is busy");

    expect(await service.mailbox({ messageId: "event_mailbox" })).toMatchObject([
      {
        id: "event_mailbox",
        status: "queued",
      },
    ]);
    expect((await store.events({ type: "agent.message_consumed", limit: 10 }))).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function agentSpawned(
  id: string,
  runId: AgentRunId,
  path: AgentPath,
  parentPath: AgentPath | undefined,
  taskName: string,
  time: number,
): ChiliEvent {
  const payload: Extract<ChiliEvent, { type: "agent.spawned" }>["payload"] = {
    runId,
    path,
    taskName,
  };
  if (parentPath) payload.parentPath = parentPath;
  return {
    id,
    type: "agent.spawned",
    time: time as TimestampMs,
    payload,
  };
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

class FakeMailboxRuntime {
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
}
