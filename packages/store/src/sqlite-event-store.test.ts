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
import { ObservableEventStore } from "./observable-event-store.js";
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

test("migrates older agent task tables with generation and lease columns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-lease-migration-"));
  const dbPath = join(dir, "events.sqlite");
  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    create table agent_tasks (
      id text primary key,
      path text not null,
      parent_path text,
      parent_session_id text,
      parent_thread_id text,
      child_session_id text,
      child_thread_id text,
      task_name text not null,
      cwd text,
      prompt text,
      mode text,
      status text not null,
      current_run_id text,
      summary text,
      error text,
      completion_json text,
      created_at integer not null,
      updated_at integer not null,
      completed_at integer
    )
  `);
  db.query(
    `insert into agent_tasks
       (id, path, task_name, status, current_run_id, created_at, updated_at)
     values (?, ?, ?, 'running', ?, 1, 1)`,
  ).run("task_old", "/root/task_old", "old task", "agent_old");
  db.close();

  const store = new SqliteEventStore(dbPath);
  try {
    expect(await store.agentTask("task_old" as TaskId)).toMatchObject({
      id: "task_old",
      status: "running",
      generation: 0,
    });

    const claim = await store.claimAgentTaskLease({
      taskId: "task_old" as TaskId,
      owner: "worker_migrated",
      ttlMs: 100,
      now: 10,
    });
    expect(claim).toMatchObject({
      acquired: true,
      task: {
        generation: 1,
        leaseOwner: "worker_migrated",
        leaseExpiresAt: 110,
      },
    });
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
        generation: 0,
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
        generation: 1,
      },
    });

    const resumed = await store.agentTask(taskId);
    expect(resumed).toMatchObject({
      id: taskId,
      status: "running",
      currentRunId: "agent_review_followup",
      generation: 1,
    });
    expect(resumed?.completedAt).toBeUndefined();
    expect(resumed?.summary).toBeUndefined();
    expect(resumed?.completion).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("claims, renews, expires, and releases task leases with generation CAS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-lease-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_lease" as TaskId;
  const runId = "agent_lease" as AgentRunId;

  try {
    await appendRunningTask(store, { taskId, runId, generation: 1, time: 1 as TimestampMs });

    const first = await store.claimAgentTaskLease({ taskId, owner: "worker_a", ttlMs: 50, now: 100 });
    expect(first).toMatchObject({
      acquired: true,
      task: {
        id: taskId,
        generation: 2,
        leaseOwner: "worker_a",
        leaseExpiresAt: 150,
        leaseHeartbeatAt: 100,
      },
    });

    const blocked = await store.claimAgentTaskLease({ taskId, owner: "worker_b", ttlMs: 50, now: 110 });
    expect(blocked.acquired).toBe(false);
    expect(blocked.task).toMatchObject({ leaseOwner: "worker_a", generation: 2 });

    const wrongOwnerRenew = await store.renewAgentTaskLease({
      taskId,
      owner: "worker_b",
      generation: 2,
      ttlMs: 50,
      now: 120,
    });
    expect(wrongOwnerRenew.acquired).toBe(false);

    const renewed = await store.renewAgentTaskLease({
      taskId,
      owner: "worker_a",
      generation: 2,
      ttlMs: 50,
      now: 120,
    });
    expect(renewed).toMatchObject({
      acquired: true,
      task: {
        generation: 2,
        leaseOwner: "worker_a",
        leaseExpiresAt: 170,
        leaseHeartbeatAt: 120,
      },
    });

    const expiredClaim = await store.claimAgentTaskLease({ taskId, owner: "worker_b", ttlMs: 50, now: 171 });
    expect(expiredClaim).toMatchObject({
      acquired: true,
      task: {
        generation: 3,
        leaseOwner: "worker_b",
        leaseExpiresAt: 221,
        leaseHeartbeatAt: 171,
      },
    });

    expect(await store.releaseAgentTaskLease({ taskId, owner: "worker_a", generation: 2, now: 172 })).toBe(false);
    expect(await store.releaseAgentTaskLease({ taskId, owner: "worker_b", generation: 3, now: 173 })).toBe(true);
    expect(await store.agentTask(taskId)).toMatchObject({ generation: 3 });
    expect((await store.agentTask(taskId))?.leaseOwner).toBeUndefined();
    expect((await store.agentTask(taskId))?.leaseExpiresAt).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("finalizes agent tasks through SQLite CAS without leaking stale events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-final-cas-"));
  const mirrored: ChiliEvent[] = [];
  const store = new SqliteEventStore(join(dir, "events.sqlite"), {
    mirror: {
      async write(event) {
        mirrored.push(event);
      },
    },
  });
  const taskId = "task_final_cas" as TaskId;
  const runId = "agent_final_cas" as AgentRunId;
  const path = "/root/task_final_cas" as AgentPath;

  try {
    await appendRunningTask(store, { taskId, runId, path, generation: 1, time: 1 as TimestampMs });
    await store.claimAgentTaskLease({ taskId, owner: "worker_a", ttlMs: 100, now: 10 });

    const completed = await store.completeAgentTaskCas({
      taskId,
      path,
      runId,
      generation: 2,
      owner: "worker_a",
      status: "completed",
      summary: "done",
      eventId: "event_cas_task_completed",
      agentEventId: "event_cas_agent_completed",
      sessionId: "session_parent" as SessionId,
      threadId: "thread_parent" as ThreadId,
      time: 20,
    });

    expect(completed.applied).toBe(true);
    expect(completed.events.map((event) => event.id)).toEqual(["event_cas_task_completed", "event_cas_agent_completed"]);
    expect(mirrored.map((event) => event.id)).toEqual([
      "event_task_created_task_final_cas",
      "event_spawned_task_final_cas",
      "event_cas_task_completed",
      "event_cas_agent_completed",
    ]);
    expect(await store.agentTask(taskId)).toMatchObject({
      id: taskId,
      status: "completed",
      generation: 2,
      summary: "done",
    });
    expect((await store.agentTask(taskId))?.leaseOwner).toBeUndefined();

    const stale = await store.completeAgentTaskCas({
      taskId,
      path,
      runId,
      generation: 2,
      owner: "worker_a",
      status: "failed",
      error: "late failure",
      eventId: "event_late_cas_task_completed",
      agentEventId: "event_late_cas_agent_completed",
      time: 21,
    });
    expect(stale.applied).toBe(false);
    expect(stale.events).toEqual([]);
    expect((await store.events({ type: "agent.task_completed", limit: 10 })).map((event) => event.id)).toEqual([
      "event_cas_task_completed",
    ]);
    expect(mirrored.map((event) => event.id)).not.toContain("event_late_cas_task_completed");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close task CAS wins over runner completion CAS and Observable only emits committed events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-close-cas-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const emitted: ChiliEvent[] = [];
  const unsubscribe = store.subscribe((event) => emitted.push(event));
  const taskId = "task_close_cas" as TaskId;
  const runId = "agent_close_cas" as AgentRunId;
  const path = "/root/task_close_cas" as AgentPath;

  try {
    await appendRunningTask(baseStore, { taskId, runId, path, generation: 1, time: 1 as TimestampMs });
    await baseStore.claimAgentTaskLease({ taskId, owner: "worker_a", ttlMs: 100, now: 10 });

    const closed = await store.closeAgentTaskCas({
      taskId,
      status: "cancelled",
      summary: "stopped",
      eventId: "event_close_cas_task",
      agentEventId: "event_close_cas_agent",
      time: 20,
    });
    expect(closed.applied).toBe(true);
    expect(emitted.map((event) => event.id)).toEqual(["event_close_cas_task", "event_close_cas_agent"]);
    expect(await baseStore.agentTask(taskId)).toMatchObject({
      id: taskId,
      status: "cancelled",
      generation: 3,
      summary: "stopped",
    });

    const late = await store.completeAgentTaskCas({
      taskId,
      path,
      runId,
      generation: 2,
      owner: "worker_a",
      status: "completed",
      summary: "late",
      eventId: "event_late_complete_cas_task",
      agentEventId: "event_late_complete_cas_agent",
      time: 21,
    });
    expect(late.applied).toBe(false);
    expect(emitted.map((event) => event.id)).toEqual(["event_close_cas_task", "event_close_cas_agent"]);
    expect((await baseStore.events({ type: "agent.task_completed", limit: 10 })).map((event) => event.id)).toEqual([
      "event_close_cas_task",
    ]);
  } finally {
    unsubscribe();
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("claims, requeues, and consumes mailbox messages through SQLite CAS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-mailbox-cas-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const emitted: ChiliEvent[] = [];
  const unsubscribe = store.subscribe((event) => emitted.push(event));
  const taskId = "task_mailbox_cas" as TaskId;
  const path = "/root/task_mailbox_cas" as AgentPath;
  const parentPath = "/root" as AgentPath;
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;

  try {
    await baseStore.append({
      id: "event_mailbox",
      type: "agent.message_queued",
      time: 1 as TimestampMs,
      payload: {
        taskId,
        path,
        from: parentPath,
        childSessionId,
        childThreadId,
        triggerTurn: true,
        message: { role: "user", content: "continue" },
      },
    });

    const firstClaim = await store.claimAgentMailboxMessage({
      messageId: "event_mailbox",
      eventId: "event_claim_a",
      claimedBy: path,
      time: 2,
    });
    expect(firstClaim).toMatchObject({
      applied: true,
      message: { id: "event_mailbox", status: "delivering" },
    });

    const blockedClaim = await store.claimAgentMailboxMessage({
      messageId: "event_mailbox",
      eventId: "event_claim_blocked",
      claimedBy: path,
      time: 3,
    });
    expect(blockedClaim.applied).toBe(false);
    expect(blockedClaim.events).toEqual([]);
    expect(blockedClaim.message).toMatchObject({ id: "event_mailbox", status: "delivering" });

    const requeued = await store.requeueAgentMailboxMessage({
      messageId: "event_mailbox",
      eventId: "event_requeue",
      error: "delivery failed",
      time: 4,
    });
    expect(requeued).toMatchObject({
      applied: true,
      message: { id: "event_mailbox", status: "queued" },
    });

    const secondClaim = await store.claimAgentMailboxMessage({
      messageId: "event_mailbox",
      eventId: "event_claim_b",
      claimedBy: path,
      time: 5,
    });
    expect(secondClaim).toMatchObject({
      applied: true,
      message: { id: "event_mailbox", status: "delivering" },
    });

    const consumed = await store.consumeAgentMailboxMessage({
      messageId: "event_mailbox",
      eventId: "event_consumed",
      consumedBy: path,
      time: 6,
    });
    expect(consumed).toMatchObject({
      applied: true,
      message: { id: "event_mailbox", status: "consumed", consumedAt: 6 },
    });

    const lateConsume = await store.consumeAgentMailboxMessage({
      messageId: "event_mailbox",
      eventId: "event_consumed_late",
      consumedBy: path,
      time: 7,
    });
    expect(lateConsume.applied).toBe(false);
    expect(lateConsume.events).toEqual([]);
    expect(lateConsume.message).toMatchObject({ id: "event_mailbox", status: "consumed", consumedAt: 6 });

    expect(emitted.map((event) => event.id)).toEqual([
      "event_claim_a",
      "event_requeue",
      "event_claim_b",
      "event_consumed",
    ]);
    expect((await baseStore.events({ type: "agent.message_claimed", limit: 10 })).map((event) => event.id)).toEqual([
      "event_claim_a",
      "event_claim_b",
    ]);
    expect((await baseStore.events({ type: "agent.message_requeued", limit: 10 })).map((event) => event.id)).toEqual([
      "event_requeue",
    ]);
    expect((await baseStore.events({ type: "agent.message_consumed", limit: 10 })).map((event) => event.id)).toEqual([
      "event_consumed",
    ]);
  } finally {
    unsubscribe();
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("final task projection wins over late completion and stale spawn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-generation-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_generation" as TaskId;
  const runId = "agent_generation" as AgentRunId;
  const path = "/root/task_generation" as AgentPath;

  try {
    await appendRunningTask(store, { taskId, runId, path, generation: 1, time: 1 as TimestampMs });
    await store.claimAgentTaskLease({ taskId, owner: "worker_a", ttlMs: 50, now: 10 });

    await store.append({
      id: "event_close_task",
      type: "agent.task_completed",
      time: 20 as TimestampMs,
      payload: {
        taskId,
        path,
        runId,
        generation: 3,
        status: "cancelled",
        summary: "stopped by user",
      },
    });
    await store.append({
      id: "event_late_task_completed",
      type: "agent.task_completed",
      time: 21 as TimestampMs,
      payload: {
        taskId,
        path,
        runId,
        generation: 2,
        status: "completed",
        summary: "late success",
      },
    });
    await store.append({
      id: "event_late_agent_completed",
      type: "agent.completed",
      time: 22 as TimestampMs,
      payload: {
        taskId,
        path,
        runId,
        generation: 2,
        status: "completed",
        summary: "late success",
      },
    });
    await store.append({
      id: "event_stale_spawn",
      type: "agent.spawned",
      time: 23 as TimestampMs,
      payload: {
        runId: "agent_generation_stale" as AgentRunId,
        taskId,
        path,
        taskName: "review",
      },
    });

    expect(await store.agentTask(taskId)).toMatchObject({
      id: taskId,
      status: "cancelled",
      generation: 3,
      summary: "stopped by user",
    });
    expect((await store.agentTask(taskId))?.leaseOwner).toBeUndefined();
    expect(await store.agentRuns({ taskId })).toMatchObject([{ id: runId, status: "cancelled" }]);

    await store.append({
      id: "event_new_spawn",
      type: "agent.spawned",
      time: 24 as TimestampMs,
      payload: {
        runId: "agent_generation_followup" as AgentRunId,
        taskId,
        path,
        taskName: "review",
        generation: 4,
      },
    });

    expect(await store.agentTask(taskId)).toMatchObject({
      id: taskId,
      status: "running",
      currentRunId: "agent_generation_followup",
      generation: 4,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function appendRunningTask(
  store: SqliteEventStore,
  input: {
    taskId: TaskId;
    runId: AgentRunId;
    path?: AgentPath;
    generation?: number;
    time: TimestampMs;
  },
): Promise<void> {
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const path = input.path ?? (`/root/${input.taskId}` as AgentPath);
  const parentPath = "/root" as AgentPath;

  await store.appendMany([
    {
      id: `event_task_created_${input.taskId}`,
      type: "agent.task_created",
      time: input.time,
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
        taskName: "review",
        cwd: "/repo",
        prompt: "Review this",
        mode: "background",
      },
    },
    {
      id: `event_spawned_${input.taskId}`,
      type: "agent.spawned",
      time: input.time,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      payload: {
        runId: input.runId,
        taskId: input.taskId,
        path,
        parentPath,
        parentSessionId,
        parentThreadId,
        childSessionId,
        childThreadId,
        taskName: "review",
        cwd: "/repo",
        mode: "background",
        ...(input.generation !== undefined ? { generation: input.generation } : {}),
      },
    },
  ]);
}

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
