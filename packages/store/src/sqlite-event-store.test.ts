import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
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
} from "@chili/protocol";
import { SqliteEventStore } from "./sqlite-event-store.js";

test("orders event replay and afterEventId cursors by insertion sequence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-seq-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const time = 1 as TimestampMs;

  try {
    await store.append(sessionEvent("z_event", "session_z" as SessionId, "thread_z" as ThreadId, time));
    await store.append(sessionEvent("a_event", "session_a" as SessionId, "thread_a" as ThreadId, time));

    expect((await store.events({ limit: 10 })).map((event) => event.id)).toEqual(["z_event", "a_event"]);
    expect((await store.events({ afterEventId: "z_event", limit: 10 })).map((event) => event.id)).toEqual(["a_event"]);
    expect((await store.events({ afterEventId: "a_event", limit: 10 })).map((event) => event.id)).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrates older event tables without seq and uses row insertion order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-seq-migration-"));
  const dbPath = join(dir, "events.sqlite");
  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    create table events (
      id text primary key,
      type text not null,
      time integer not null,
      session_id text,
      thread_id text,
      payload_json text not null
    )
  `);
  db.query(
    `insert into events (id, type, time, session_id, thread_id, payload_json)
     values (?, 'session.created', 1, ?, ?, ?)`,
  ).run("z_event", "session_z", "thread_z", JSON.stringify({ sessionId: "session_z", cwd: "/repo" }));
  db.query(
    `insert into events (id, type, time, session_id, thread_id, payload_json)
     values (?, 'session.created', 1, ?, ?, ?)`,
  ).run("a_event", "session_a", "thread_a", JSON.stringify({ sessionId: "session_a", cwd: "/repo" }));
  db.close();

  const store = new SqliteEventStore(dbPath);
  try {
    expect((await store.events({ limit: 10 })).map((event) => event.id)).toEqual(["z_event", "a_event"]);
    expect((await store.events({ afterEventId: "z_event", limit: 10 })).map((event) => event.id)).toEqual(["a_event"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("replays message part deltas into stored messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-part-delta-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_delta" as SessionId;
  const threadId = "thread_delta" as ThreadId;
  const messageId = "message_delta" as MessageId;
  const partId = "part_delta" as PartId;
  const time = 1 as TimestampMs;

  try {
    await store.append(sessionEvent("event_session", sessionId, threadId, time));
    await store.append({
      id: "event_message",
      type: "message.created",
      time,
      sessionId,
      threadId,
      payload: { messageId, role: "assistant" },
    });
    await store.append({
      id: "event_part",
      type: "message.part_added",
      time,
      sessionId,
      threadId,
      payload: {
        messageId,
        part: {
          id: partId,
          messageId,
          sessionId,
          type: "text",
          text: "hel",
        },
      },
    });
    await store.append({
      id: "event_delta",
      type: "message.part_delta",
      time,
      sessionId,
      threadId,
      payload: { messageId, partId, field: "text", delta: "lo" },
    });

    const messages = await store.messages(sessionId);
    expect(messages[0]?.parts).toEqual([
      {
        id: partId,
        messageId,
        sessionId,
        type: "text",
        text: "hello",
      },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("projects local subagent tasks, runs, mailbox, and completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-subagent-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const taskId = "task_review" as TaskId;
  const runId = "agent_review" as AgentRunId;
  const path = "/root/task_review" as AgentPath;
  const parentPath = "/root" as AgentPath;
  const time = 1 as TimestampMs;

  try {
    await store.append(sessionEvent("event_session", parentSessionId, parentThreadId, time));
    await store.append({
      id: "event_task_created",
      type: "agent.task_created",
      time,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        taskId,
        path,
        parentPath,
        parentSessionId,
        parentThreadId,
        childSessionId,
        childThreadId,
        taskName: "review",
        cwd: "/repo",
        prompt: "Review this",
        mode: "one_shot",
      },
    });
    await store.append({
      id: "event_spawned",
      type: "agent.spawned",
      time,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        runId,
        taskId,
        path,
        parentPath,
        parentSessionId,
        parentThreadId,
        childSessionId,
        childThreadId,
        taskName: "review",
        cwd: "/repo",
        mode: "one_shot",
      },
    });
    await store.append({
      id: "event_mailbox",
      type: "agent.message_queued",
      time,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        taskId,
        path,
        from: parentPath,
        childSessionId,
        childThreadId,
        triggerTurn: true,
        message: { role: "user", content: "go" },
      },
    });
    await store.append({
      id: "event_mailbox_consumed",
      type: "agent.message_consumed",
      time,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        messageId: "event_mailbox",
        taskId,
        path,
        consumedBy: path,
      },
    });
    await store.append({
      id: "event_task_completed",
      type: "agent.task_completed",
      time,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        taskId,
        runId,
        path,
        status: "completed",
        summary: "done",
      },
    });
    await store.append({
      id: "event_completed",
      type: "agent.completed",
      time,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        runId,
        taskId,
        path,
        status: "completed",
        summary: "done",
      },
    });

    expect(await store.agentTasks({ taskId })).toEqual([
      {
        id: taskId,
        path,
        parentPath,
        parentSessionId,
        parentThreadId,
        childSessionId,
        childThreadId,
        taskName: "review",
        cwd: "/repo",
        prompt: "Review this",
        mode: "one_shot",
        status: "completed",
        currentRunId: runId,
        summary: "done",
        completion: {
          taskId,
          runId,
          path,
          status: "completed",
          summary: "done",
        },
        createdAt: time,
        updatedAt: time,
        completedAt: time,
      },
    ]);
    expect(await store.agentRuns({ taskId })).toMatchObject([
      {
        id: runId,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        taskId,
        path,
        parentPath,
        parentSessionId,
        parentThreadId,
        childSessionId,
        childThreadId,
        taskName: "review",
        cwd: "/repo",
        mode: "one_shot",
        status: "completed",
      },
    ]);
    expect(await store.agentMailbox({ taskId })).toMatchObject([
      {
        id: "event_mailbox",
        taskId,
        path,
        fromPath: parentPath,
        childSessionId,
        childThreadId,
        triggerTurn: true,
        status: "consumed",
        message: { role: "user", content: "go" },
        consumedAt: time,
      },
    ]);
    expect(await store.agentMailbox({ status: "queued" })).toEqual([]);
    expect(await store.agentMailbox({ messageId: "event_mailbox", status: "consumed" })).toMatchObject([
      {
        id: "event_mailbox",
        status: "consumed",
      },
    ]);
    expect(await store.agentTask(taskId)).toMatchObject({ id: taskId, status: "completed" });

    await store.append({
      id: "event_spawned_followup",
      type: "agent.spawned",
      time: (time + 1) as TimestampMs,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        runId: "agent_review_followup" as AgentRunId,
        taskId,
        path,
        parentPath,
        parentSessionId,
        parentThreadId,
        childSessionId,
        childThreadId,
        taskName: "review",
        cwd: "/repo",
        mode: "one_shot",
      },
    });

    const resumed = await store.agentTask(taskId);
    expect(resumed).toMatchObject({
      id: taskId,
      status: "running",
      currentRunId: "agent_review_followup",
    });
    expect(resumed?.completedAt).toBeUndefined();
    expect(resumed?.summary).toBeUndefined();
    expect(resumed?.completion).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function sessionEvent(id: string, sessionId: SessionId, threadId: ThreadId, time: TimestampMs): ChiliEvent {
  return {
    id,
    type: "session.created",
    time,
    sessionId,
    threadId,
    payload: { sessionId, cwd: "/repo" },
  };
}
