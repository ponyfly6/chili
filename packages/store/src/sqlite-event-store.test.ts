import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type {
  AgentPath,
  AgentRunId,
  ApprovalId,
  ChiliEvent,
  MessageId,
  PartId,
  SessionId,
  TaskId,
  TeamId,
  ThreadId,
  TimestampMs,
  TurnId,
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

test("reconciles stale turns without completion events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-stale-turn-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_stale_turn" as SessionId;
  const threadId = "thread_stale_turn" as ThreadId;
  let recoveredIds = 0;

  try {
    await store.append(sessionEvent("event_session", sessionId, threadId, 100 as TimestampMs));
    await store.append({
      id: "event_turn_started",
      type: "turn.started",
      time: 110 as TimestampMs,
      sessionId,
      threadId,
      payload: { turnId: "turn_stale" as TurnId },
    });

    const recovered = await store.reconcileStaleTurns({
      staleBefore: 1_000,
      createId: (prefix) => `${prefix}_${recoveredIds++}`,
    });

    expect(recovered.map((event) => event.type)).toEqual(["turn.completed", "session.status_changed"]);
    const events = await store.events({ sessionId, limit: 10 });
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
      "turn.completed",
      "session.status_changed",
    ]);
    expect(events.at(-2)?.payload).toEqual({ turnId: "turn_stale", status: "failed" });
    expect(events.at(-1)?.payload).toMatchObject({
      sessionId,
      status: "failed",
      turnId: "turn_stale",
      reason: "stale_turn_recovered",
    });
    expect(await store.reconcileStaleTurns({ staleBefore: 2_000, createId: (prefix) => `${prefix}_again` })).toEqual([]);
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

test("migrates older team message tables without delivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-team-message-migration-"));
  const dbPath = join(dir, "events.sqlite");
  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    create table team_messages (
      id text primary key,
      team_id text not null,
      from_path text not null,
      to_path text not null,
      task_id text,
      kind text not null,
      content text not null,
      summary text,
      metadata_json text,
      created_at integer not null
    )
  `);
  db.query(
    `insert into team_messages
       (id, team_id, from_path, to_path, kind, content, created_at)
     values (?, ?, ?, ?, 'text', ?, 1)`,
  ).run("teammsg_old", "team_old", "/root", "/root/worker", "old message");
  db.close();

  const store = new SqliteEventStore(dbPath);
  try {
    expect(await store.teamMessages({ teamId: "team_old" as TeamId })).toMatchObject([
      {
        id: "teammsg_old",
        teamId: "team_old",
        kind: "text",
        content: "old message",
      },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrates older approval tables and reads approval metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-approval-migration-"));
  const dbPath = join(dir, "events.sqlite");
  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    create table approvals (
      id text primary key,
      session_id text,
      thread_id text,
      call_id text,
      permission text not null,
      patterns_json text not null,
      status text not null,
      decision text,
      feedback text,
      created_at integer not null,
      resolved_at integer
    )
  `);
  db.close();

  const store = new SqliteEventStore(dbPath);
  try {
    const sessionId = "session_approval_metadata" as SessionId;
    await store.append({
      id: "event_approval_metadata",
      type: "approval.requested",
      time: 1 as TimestampMs,
      sessionId,
      threadId: "thread_approval_metadata" as ThreadId,
      payload: {
        approvalId: "approval_metadata" as ApprovalId,
        permission: "tool.bash",
        patterns: ["bun test"],
        metadata: { reason: "Policy requires approval", source: "workspace config" },
      },
    });

    expect(await store.pendingApprovals(sessionId)).toMatchObject([
      {
        id: "approval_metadata",
        metadata: { reason: "Policy requires approval", source: "workspace config" },
      },
    ]);
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

test("projects team members, task board, and messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-team-projection-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_team" as SessionId;
  const threadId = "thread_team" as ThreadId;
  const teamId = "team_alpha" as TeamId;
  const leadPath = "/root" as AgentPath;
  const reviewerPath = "/root/reviewer" as AgentPath;
  const setupTaskId = "task_setup" as TaskId;
  const reviewTaskId = "task_review" as TaskId;

  try {
    await store.appendMany([
      sessionEvent("event_session_team", sessionId, threadId, 1 as TimestampMs),
      {
        id: "event_team_created",
        type: "team.created",
        time: 2 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          teamId,
          name: "alpha",
          leadPath,
          description: "parallel review team",
        },
      },
      {
        id: "event_team_lead",
        type: "team.member_added",
        time: 3 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          teamId,
          path: leadPath,
          name: "team-lead",
          role: "leader",
          status: "running",
          writeScope: ["/repo"],
        },
      },
      {
        id: "event_team_reviewer",
        type: "team.member_added",
        time: 4 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          teamId,
          path: reviewerPath,
          name: "reviewer",
          role: "code-reviewer",
          childSessionId: "session_reviewer" as SessionId,
          childThreadId: "thread_reviewer" as ThreadId,
          model: "test-model",
          toolScope: ["read", "git_diff"],
          writeScope: ["packages/core"],
        },
      },
      {
        id: "event_setup_task",
        type: "team.task_created",
        time: 5 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          teamId,
          taskId: setupTaskId,
          title: "Prepare context",
          createdBy: leadPath,
          status: "completed",
          metadata: { phase: "setup" },
        },
      },
      {
        id: "event_review_task",
        type: "team.task_created",
        time: 6 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          teamId,
          taskId: reviewTaskId,
          title: "Review team runtime",
          description: "Check projection behavior",
          createdBy: leadPath,
          dependsOn: [setupTaskId],
        },
      },
      {
        id: "event_review_assigned",
        type: "team.task_assigned",
        time: 7 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          teamId,
          taskId: reviewTaskId,
          ownerPath: reviewerPath,
          assignedBy: leadPath,
        },
      },
      {
        id: "event_review_message",
        type: "team.message_sent",
        time: 8 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          teamId,
          messageId: "message_review_assignment",
          from: leadPath,
          to: reviewerPath,
          kind: "task_assignment",
          delivery: "queueOnly",
          taskId: reviewTaskId,
          content: "Please review team runtime.",
          summary: "assignment",
        },
      },
      {
        id: "event_review_done",
        type: "team.task_updated",
        time: 9 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          teamId,
          taskId: reviewTaskId,
          status: "completed",
          summary: "Projection looks consistent",
        },
      },
      {
        id: "event_reviewer_idle",
        type: "team.member_status_changed",
        time: 10 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          teamId,
          path: reviewerPath,
          status: "idle",
        },
      },
    ]);

    expect(await store.teams({ teamId })).toEqual([
      {
        id: teamId,
        sessionId,
        name: "alpha",
        leadPath,
        status: "active",
        description: "parallel review team",
        createdAt: 2,
        updatedAt: 10,
      },
    ]);
    expect(await store.teamMembers({ teamId })).toMatchObject([
      {
        teamId,
        path: leadPath,
        name: "team-lead",
        role: "leader",
        status: "running",
        writeScope: ["/repo"],
      },
      {
        teamId,
        path: reviewerPath,
        name: "reviewer",
        role: "code-reviewer",
        status: "idle",
        childSessionId: "session_reviewer",
        childThreadId: "thread_reviewer",
        model: "test-model",
        toolScope: ["read", "git_diff"],
        writeScope: ["packages/core"],
      },
    ]);
    expect(await store.teamTasks({ teamId })).toMatchObject([
      {
        id: setupTaskId,
        status: "completed",
        title: "Prepare context",
        createdBy: leadPath,
        metadata: { phase: "setup" },
        completedAt: 5,
      },
      {
        id: reviewTaskId,
        status: "completed",
        title: "Review team runtime",
        description: "Check projection behavior",
        ownerPath: reviewerPath,
        dependsOn: [setupTaskId],
        summary: "Projection looks consistent",
        completedAt: 9,
      },
    ]);
    expect(await store.teamMessages({ teamId, path: reviewerPath })).toMatchObject([
      {
        id: "message_review_assignment",
        teamId,
        fromPath: leadPath,
        toPath: reviewerPath,
        kind: "task_assignment",
        delivery: "queueOnly",
        taskId: reviewTaskId,
        content: "Please review team runtime.",
      },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("projects team message delivery status from agent mailbox lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-team-message-delivery-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const teamId = "team_delivery" as TeamId;
  const teamMessageId = "teammsg_delivery";
  const mailboxMessageId = "agentmsg_delivery";
  const workerPath = "/root/worker" as AgentPath;
  const childSessionId = "session_worker" as SessionId;
  const childThreadId = "thread_worker" as ThreadId;

  try {
    await store.append({
      id: "event_team_message",
      type: "team.message_sent",
      time: 1 as TimestampMs,
      payload: {
        teamId,
        messageId: teamMessageId,
        from: "/root" as AgentPath,
        to: workerPath,
        content: "Run delivery test",
        kind: "text",
        delivery: "triggerTurn",
      },
    });
    await store.append({
      id: mailboxMessageId,
      type: "agent.message_queued",
      time: 2 as TimestampMs,
      payload: {
        path: workerPath,
        from: "/root" as AgentPath,
        childSessionId,
        childThreadId,
        triggerTurn: true,
        message: {
          role: "user",
          content: "Run delivery test",
          metadata: { teamId, teamMessageId },
        },
      },
    });

    expect(await store.teamMessages({ teamId })).toMatchObject([
      {
        id: teamMessageId,
        delivery: "triggerTurn",
        deliveryStatus: "queued",
        deliveryUpdatedAt: 2,
      },
    ]);
    expect(await store.teamMessageDeliveries({ teamMessageId })).toMatchObject([
      {
        mailboxMessageId,
        teamId,
        teamMessageId,
        path: workerPath,
        status: "queued",
        triggerTurn: true,
        childSessionId,
        childThreadId,
      },
    ]);

    await store.append({
      id: "event_delivery_claimed",
      type: "agent.message_claimed",
      time: 3 as TimestampMs,
      payload: { messageId: mailboxMessageId, path: workerPath },
    });
    expect((await store.teamMessages({ teamId }))[0]).toMatchObject({
      deliveryStatus: "delivering",
      deliveryUpdatedAt: 3,
    });

    await store.append({
      id: "event_delivery_requeued",
      type: "agent.message_requeued",
      time: 4 as TimestampMs,
      payload: { messageId: mailboxMessageId, path: workerPath, error: "child busy" },
    });
    expect((await store.teamMessages({ teamId }))[0]).toMatchObject({
      deliveryStatus: "failed",
      deliveryError: "child busy",
      deliveryUpdatedAt: 4,
    });

    await store.append({
      id: "event_delivery_claimed_again",
      type: "agent.message_claimed",
      time: 5 as TimestampMs,
      payload: { messageId: mailboxMessageId, path: workerPath },
    });
    await store.append({
      id: "event_delivery_consumed",
      type: "agent.message_consumed",
      time: 6 as TimestampMs,
      payload: { messageId: mailboxMessageId, path: workerPath },
    });
    expect((await store.teamMessages({ teamId }))[0]).toMatchObject({
      deliveryStatus: "delivered",
      deliveredAt: 6,
      deliveryUpdatedAt: 6,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("claims team tasks with dependency-aware CAS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-team-claim-"));
  const mirrored: ChiliEvent[] = [];
  const store = new SqliteEventStore(join(dir, "events.sqlite"), {
    mirror: {
      async write(event) {
        mirrored.push(event);
      },
    },
  });
  const sessionId = "session_team_claim" as SessionId;
  const threadId = "thread_team_claim" as ThreadId;
  const teamId = "team_claim" as TeamId;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const otherPath = "/root/other" as AgentPath;
  const setupTaskId = "task_claim_setup" as TaskId;
  const readyTaskId = "task_claim_ready" as TaskId;
  const blockedTaskId = "task_claim_blocked" as TaskId;
  const failedDependencyTaskId = "task_claim_failed_dependency" as TaskId;
  const waitsOnFailedTaskId = "task_claim_waits_on_failed" as TaskId;

  try {
    await store.appendMany([
      sessionEvent("event_team_claim_session", sessionId, threadId, 1 as TimestampMs),
      {
        id: "event_team_claim_created",
        type: "team.created",
        time: 2 as TimestampMs,
        sessionId,
        threadId,
        payload: { teamId, name: "claimers", leadPath },
      },
      {
        id: "event_team_claim_worker",
        type: "team.member_added",
        time: 3 as TimestampMs,
        sessionId,
        threadId,
        payload: { teamId, path: workerPath, name: "worker", role: "implementer" },
      },
      {
        id: "event_team_claim_setup",
        type: "team.task_created",
        time: 4 as TimestampMs,
        sessionId,
        threadId,
        payload: { teamId, taskId: setupTaskId, title: "setup", status: "completed" },
      },
      {
        id: "event_team_claim_ready",
        type: "team.task_created",
        time: 5 as TimestampMs,
        sessionId,
        threadId,
        payload: { teamId, taskId: readyTaskId, title: "ready", dependsOn: [setupTaskId] },
      },
      {
        id: "event_team_claim_blocked",
        type: "team.task_created",
        time: 6 as TimestampMs,
        sessionId,
        threadId,
        payload: { teamId, taskId: blockedTaskId, title: "blocked", dependsOn: ["task_missing" as TaskId] },
      },
      {
        id: "event_team_claim_failed_dependency",
        type: "team.task_created",
        time: 7 as TimestampMs,
        sessionId,
        threadId,
        payload: { teamId, taskId: failedDependencyTaskId, title: "failed dependency", status: "failed" },
      },
      {
        id: "event_team_claim_waits_on_failed",
        type: "team.task_created",
        time: 8 as TimestampMs,
        sessionId,
        threadId,
        payload: { teamId, taskId: waitsOnFailedTaskId, title: "waits on failed", dependsOn: [failedDependencyTaskId] },
      },
    ]);

    const claimed = await store.claimTeamTask({
      teamId,
      taskId: readyTaskId,
      ownerPath: workerPath,
      claimedBy: workerPath,
      eventId: "event_team_claim_ready_cas",
      sessionId,
      threadId,
      time: 9,
    });
    expect(claimed).toMatchObject({
      applied: true,
      task: {
        id: readyTaskId,
        status: "in_progress",
        ownerPath: workerPath,
      },
    });
    expect(claimed.events.map((event) => event.type)).toEqual(["team.task_claimed"]);
    expect(mirrored.map((event) => event.id)).toContain("event_team_claim_ready_cas");

    const duplicate = await store.claimTeamTask({
      teamId,
      taskId: readyTaskId,
      ownerPath: otherPath,
      eventId: "event_team_claim_duplicate",
      time: 10,
    });
    expect(duplicate).toMatchObject({
      applied: false,
      reason: "already_claimed",
      task: {
        id: readyTaskId,
        status: "in_progress",
        ownerPath: workerPath,
      },
    });

    const blocked = await store.claimTeamTask({
      teamId,
      taskId: blockedTaskId,
      ownerPath: workerPath,
      eventId: "event_team_claim_blocked_cas",
      time: 11,
    });
    expect(blocked).toMatchObject({
      applied: false,
      reason: "blocked",
      task: {
        id: blockedTaskId,
        status: "pending",
      },
    });
    const blockedByFailedDependency = await store.claimTeamTask({
      teamId,
      taskId: waitsOnFailedTaskId,
      ownerPath: workerPath,
      eventId: "event_team_claim_failed_dependency_cas",
      time: 12,
    });
    expect(blockedByFailedDependency).toMatchObject({
      applied: false,
      reason: "blocked",
      task: {
        id: waitsOnFailedTaskId,
        status: "pending",
      },
    });
    expect((await store.events({ type: "team.task_claimed", limit: 10 })).map((event) => event.id)).toEqual([
      "event_team_claim_ready_cas",
    ]);
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
