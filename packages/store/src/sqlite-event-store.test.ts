import { mkdtemp, rm, stat } from "node:fs/promises";
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
  TimestampMs,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import { ObservableEventStore } from "./observable-event-store.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

test("round-trips assistant text phase without transforming the event payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-assistant-phase-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_assistant_phase" as SessionId;
  const messageId = "message_assistant_phase" as MessageId;
  const partId = "part_assistant_phase" as PartId;
  const event: ChiliEvent = {
    id: "event_assistant_phase",
    type: "message.part_added",
    time: 1 as TimestampMs,
    sessionId,
    payload: {
      messageId,
      part: {
        id: partId,
        messageId,
        sessionId,
        type: "text",
        text: "Checking the repository.",
        phase: "commentary",
      },
    },
  };

  try {
    await store.append(event);
    expect(await store.events({ sessionId, limit: 10 })).toEqual([event]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("configures SQLite for bounded WAL maintenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-wal-pragmas-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));

  try {
    const db = sqliteDatabase(store);
    expect(pragmaString(db, "journal_mode")).toBe("wal");
    expect(pragmaNumber(db, "synchronous")).toBe(2);
    expect(pragmaNumber(db, "wal_autocheckpoint")).toBe(256);
    expect(pragmaNumber(db, "journal_size_limit")).toBe(16 * 1024 * 1024);
    expect(db.query<{ name: string }, []>(
      "select name from sqlite_master where type = 'index' and name = 'events_session_type_seq_idx'",
    ).get()?.name).toBe("events_session_type_seq_idx");
    expect(db.query<{ name: string }, []>(
      "select name from sqlite_master where name = 'legacy_session_identities'",
    ).get()).toBeNull();
    expect(db.query<{ name: string }, []>(
      "select name from sqlite_master where sql is not null and lower(sql) like '%thread%'",
    ).all()).toEqual([]);
    const mailboxColumns = db
      .query<{ name: string }, []>("pragma table_info(agent_mailbox)")
      .all()
      .map((column) => column.name);
    expect(mailboxColumns).toContain("recipient_session_id");
    expect(mailboxColumns).not.toContain("child_session_id");
    expect(db
      .query<{ name: string }, []>("pragma index_info(agent_mailbox_recipient_session_idx)")
      .all()
      .map((column) => column.name))
      .toEqual(["recipient_session_id", "created_at"]);
    expect(db.query<{ name: string }, []>(
      "select name from sqlite_master where type = 'index' and name = 'agent_mailbox_child_session_idx'",
    ).get()).toBeNull();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close checkpoints and truncates the WAL file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-wal-close-"));
  const dbPath = join(dir, "events.sqlite");
  const store = new SqliteEventStore(dbPath);

  try {
    const events = Array.from({ length: 1_000 }, (_, index) => sessionEvent(
      `event_wal_${index}`,
      `session_wal_${index}` as SessionId,
      index as TimestampMs,
    ));
    await store.appendMany(events);
    expect(await fileSize(`${dbPath}-wal`)).toBeGreaterThan(0);
    store.close();
    expect(await fileSize(`${dbPath}-wal`)).toBe(0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("broadcasts transient tool output deltas without persisting or mirroring them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-transient-tool-output-"));
  const mirrored: ChiliEvent[] = [];
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"), {
    mirror: { write: async (event) => { mirrored.push(event); } },
  });
  const store = new ObservableEventStore(baseStore);
  const emitted: ChiliEvent[] = [];
  const unsubscribe = store.subscribe((event) => emitted.push(event));
  const event: ChiliEvent = {
    id: "event_tool_output_delta_transient",
    type: "tool.output_delta",
    time: 1 as TimestampMs,
    sessionId: "session_tool_output_delta" as SessionId,
    payload: {
      callId: "toolcall_tool_output_delta" as import("@chili/protocol").ToolCallId,
      stream: "stdout",
      delta: "live output",
      bytes: 11,
      sequence: 1,
    },
  };

  try {
    await store.append(event);
    expect(emitted).toEqual([event]);
    expect(await baseStore.events({ type: "tool.output_delta", limit: 10 })).toEqual([]);
    expect(mirrored).toEqual([]);
  } finally {
    unsubscribe();
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("isolates observable listener failures after the durable commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-observer-failure-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const listenerErrors: unknown[] = [];
  const store = new ObservableEventStore(baseStore, {
    onListenerError: (error) => listenerErrors.push(error),
  });
  const delivered: ChiliEvent[] = [];
  store.subscribe(() => {
    throw new Error("subscriber exploded");
  });
  store.subscribe((event) => delivered.push(event));
  const event = sessionEvent(
    "event_observer_failure",
    "session_observer_failure" as SessionId,
    1 as TimestampMs,
  );

  try {
    await expect(store.append(event)).resolves.toBeUndefined();
    expect((await baseStore.events({ limit: 10 })).map((item) => item.id)).toEqual([event.id]);
    expect(delivered).toEqual([event]);
    expect(listenerErrors).toHaveLength(1);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("session summaries include the recent prompt preview and renamed title", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-session-summary-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_summary" as SessionId;
  const messageId = "message_summary" as MessageId;
  const partId = "part_summary" as PartId;

  try {
    await store.appendMany([
      sessionEvent("event_summary_created", sessionId, 1 as TimestampMs),
      {
        id: "event_summary_message",
        type: "message.created",
        time: 2 as TimestampMs,
        sessionId,
        payload: { messageId, role: "user" },
      },
      {
        id: "event_summary_part",
        type: "message.part_added",
        time: 3 as TimestampMs,
        sessionId,
        payload: {
          messageId,
          part: { id: partId, messageId, sessionId, type: "text", text: "internal prompt", displayText: "Visible saved prompt" },
        },
      },
      {
        id: "event_summary_renamed",
        type: "session.renamed",
        time: 4 as TimestampMs,
        sessionId,
        payload: { sessionId, title: "Important work" },
      },
    ]);

    expect(await store.sessions()).toEqual([{
      id: sessionId,
      cwd: "/repo",
      title: "Important work",
      preview: "Visible saved prompt",
      source: "interactive",
      status: "active",
      createdAt: 1,
      updatedAt: 4,
    }]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("classifies persisted child agent sessions as subagents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-session-source-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const parentSessionId = "session_source_parent" as SessionId;
  const childSessionId = "session_source_child" as SessionId;

  try {
    await store.appendMany([
      sessionEvent("event_source_parent", parentSessionId, 1 as TimestampMs),
      sessionEvent("event_source_child", childSessionId, 2 as TimestampMs),
      {
        id: "event_source_task",
        type: "agent.task_created",
        time: 3 as TimestampMs,
        sessionId: parentSessionId,
        payload: {
          taskId: "task_source_child" as TaskId,
          path: "/root/task_source_child" as AgentPath,
          parentPath: "/root" as AgentPath,
          parentSessionId,
          childSessionId,
          taskName: "worker",
          cwd: "/repo",
          prompt: "inspect the repository",
        },
      },
    ]);

    const sessions = await store.sessions();
    expect(sessions.find((session) => session.id === parentSessionId)?.source).toBe("interactive");
    expect(sessions.find((session) => session.id === childSessionId)?.source).toBe("subagent");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps a team lead session interactive while classifying worker sessions as subagents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-team-session-source-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const rootSessionId = "session_source_team_root" as SessionId;
  const workerSessionId = "session_source_team_worker" as SessionId;
  const teamId = "team_source" as TeamId;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;

  try {
    await store.appendMany([
      sessionEvent("event_source_team_root", rootSessionId, 1 as TimestampMs),
      sessionEvent("event_source_team_worker", workerSessionId, 2 as TimestampMs),
      {
        id: "event_source_team_created",
        type: "team.created",
        time: 3 as TimestampMs,
        sessionId: rootSessionId,
        payload: {
          teamId,
          name: "source team",
          leadPath,
        },
      },
      {
        id: "event_source_team_lead",
        type: "team.member_added",
        time: 4 as TimestampMs,
        sessionId: rootSessionId,
        payload: {
          teamId,
          path: leadPath,
          name: "team-lead",
          role: "leader",
          status: "running",
          childSessionId: rootSessionId,
        },
      },
      {
        id: "event_source_team_worker_member",
        type: "team.member_added",
        time: 5 as TimestampMs,
        sessionId: rootSessionId,
        payload: {
          teamId,
          path: workerPath,
          name: "worker",
          role: "implementer",
          childSessionId: workerSessionId,
        },
      },
    ]);

    const sessions = await store.sessions();
    expect(sessions.find((session) => session.id === rootSessionId)?.source).toBe("interactive");
    expect(sessions.find((session) => session.id === workerSessionId)?.source).toBe("subagent");
    expect(await store.teamMembers({ childSessionId: workerSessionId })).toEqual([
      expect.objectContaining({ teamId, path: workerPath, childSessionId: workerSessionId }),
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("orders event replay and afterEventId cursors by insertion sequence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-seq-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const time = 1 as TimestampMs;

  try {
    await store.append(sessionEvent("z_event", "session_z" as SessionId, time));
    await store.append(sessionEvent("a_event", "session_a" as SessionId, time));

    expect((await store.events({ limit: 10 })).map((event) => event.id)).toEqual(["z_event", "a_event"]);
    expect((await store.events({ afterEventId: "z_event", limit: 10 })).map((event) => event.id)).toEqual(["a_event"]);
    expect((await store.events({ afterEventId: "a_event", limit: 10 })).map((event) => event.id)).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("tail event replay returns the latest bounded window in insertion order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-tail-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_tail" as SessionId;

  try {
    await store.append(sessionEvent("event_1", sessionId, 1 as TimestampMs));
    await store.append(sessionEvent("event_2", sessionId, 2 as TimestampMs));
    await store.append(sessionEvent("event_3", sessionId, 3 as TimestampMs));
    await store.append(sessionEvent("event_4", sessionId, 4 as TimestampMs));

    expect((await store.events({ sessionId, limit: 2 })).map((event) => event.id)).toEqual(["event_1", "event_2"]);
    expect((await store.events({ sessionId, limit: 2, tail: true })).map((event) => event.id)).toEqual(["event_3", "event_4"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconciles stale turns without completion events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-stale-turn-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_stale_turn" as SessionId;
  let recoveredIds = 0;

  try {
    await store.append(sessionEvent("event_session", sessionId, 100 as TimestampMs));
    await store.append({
      id: "event_turn_started",
      type: "turn.started",
      time: 110 as TimestampMs,
      sessionId,
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

test("fails closed when scoped session and goal events lack or conflict with envelope identity", async () => {
  const store = new SqliteEventStore(":memory:");
  const sessionId = "session_identity_primary" as SessionId;
  const conflictingSessionId = "session_identity_conflict" as SessionId;
  const time = 1 as TimestampMs;
  const goalFor = (goalSessionId: SessionId) => ({
    sessionId: goalSessionId,
    objective: "preserve scoped event identity",
    status: "active" as const,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: time,
    updatedAt: time,
  });
  // These casts model untyped/external callers bypassing the compile-time scoped envelope requirement.
  const invalidEvents: Array<{ event: ChiliEvent; error: string }> = [
    {
      event: {
        id: "event_identity_session_missing_envelope",
        type: "session.created",
        time,
        payload: { sessionId, cwd: "/repo" },
      } as unknown as ChiliEvent,
      error: "session.created requires event.sessionId",
    },
    {
      event: {
        id: "event_identity_session_payload_mismatch",
        type: "session.renamed",
        time,
        sessionId,
        payload: { sessionId: conflictingSessionId, title: "wrong session" },
      },
      error: "session.renamed payload sessionId session_identity_conflict does not match event.sessionId session_identity_primary",
    },
    {
      event: {
        id: "event_identity_goal_missing_envelope",
        type: "goal.updated",
        time,
        payload: { goal: goalFor(sessionId) },
      } as unknown as ChiliEvent,
      error: "goal.updated requires event.sessionId",
    },
    {
      event: {
        id: "event_identity_goal_payload_mismatch",
        type: "goal.updated",
        time,
        sessionId,
        payload: { goal: goalFor(conflictingSessionId) },
      },
      error: "goal.updated goal sessionId session_identity_conflict does not match event.sessionId session_identity_primary",
    },
    {
      event: {
        id: "event_identity_goal_clear_missing_envelope",
        type: "goal.cleared",
        time,
        payload: { sessionId },
      } as unknown as ChiliEvent,
      error: "goal.cleared requires event.sessionId",
    },
    {
      event: {
        id: "event_identity_goal_clear_payload_mismatch",
        type: "goal.cleared",
        time,
        sessionId,
        payload: { sessionId: conflictingSessionId },
      },
      error: "goal.cleared payload sessionId session_identity_conflict does not match event.sessionId session_identity_primary",
    },
    {
      event: {
        id: "event_identity_previous_goal_mismatch",
        type: "goal.cleared",
        time,
        sessionId,
        payload: { sessionId, previousGoal: goalFor(conflictingSessionId) },
      },
      error: "goal.cleared previous goal sessionId session_identity_conflict does not match event.sessionId session_identity_primary",
    },
  ];

  try {
    for (const item of invalidEvents) {
      await expect(store.append(item.event)).rejects.toThrow(item.error);
    }
    expect(await store.events({ limit: 20 })).toEqual([]);
    expect(await store.sessions()).toEqual([]);
    expect(await store.sessionGoals()).toEqual([]);

    await expect(store.appendMany([
      sessionEvent("event_identity_atomic_valid", sessionId, time),
      invalidEvents[3]!.event,
    ])).rejects.toThrow("goal.updated goal sessionId");
    expect(await store.events({ limit: 20 })).toEqual([]);
    expect(await store.sessions()).toEqual([]);
  } finally {
    store.close();
  }
});

test("canonicalizes conflicting historical scoped payload identity from the event row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-row-identity-authority-"));
  const dbPath = join(dir, "events.sqlite");
  const authoritativeSessionId = "session_row_authority" as SessionId;
  const stalePayloadSessionId = "session_stale_payload" as SessionId;
  let store = new SqliteEventStore(dbPath);
  store.close();

  const rawDb = new Database(dbPath, { create: true, strict: true });
  rawDb.query(
    `insert into events (id, type, time, session_id, payload_json)
     values ('event_row_authority_session', 'session.created', 1, ?, ?)`,
  ).run(
    authoritativeSessionId,
    JSON.stringify({ sessionId: stalePayloadSessionId, cwd: "/row-authority" }),
  );
  rawDb.query(
    `insert into events (id, type, time, session_id, payload_json)
     values ('event_row_authority_goal', 'goal.updated', 2, ?, ?)`,
  ).run(
    authoritativeSessionId,
    JSON.stringify({
      reason: "external",
      goal: {
        sessionId: stalePayloadSessionId,
        objective: "trust the durable row",
        status: "active",
        tokensUsed: 2,
        timeUsedSeconds: 3,
        createdAt: 1,
        updatedAt: 2,
      },
    }),
  );
  rawDb.query(
    `insert into events (id, type, time, session_id, payload_json)
     values ('event_row_authority_goal_clear', 'goal.cleared', 3, ?, ?)`,
  ).run(
    authoritativeSessionId,
    JSON.stringify({
      sessionId: stalePayloadSessionId,
      reason: "external",
      previousGoal: {
        sessionId: stalePayloadSessionId,
        objective: "trust the durable row",
        status: "active",
        tokensUsed: 2,
        timeUsedSeconds: 3,
        createdAt: 1,
        updatedAt: 2,
      },
    }),
  );
  rawDb.close();

  try {
    store = new SqliteEventStore(dbPath);
    expect(await store.events({ sessionId: authoritativeSessionId, limit: 10 })).toEqual([
      {
        id: "event_row_authority_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId: authoritativeSessionId,
        payload: { sessionId: authoritativeSessionId, cwd: "/row-authority" },
      },
      {
        id: "event_row_authority_goal",
        type: "goal.updated",
        time: 2 as TimestampMs,
        sessionId: authoritativeSessionId,
        payload: {
          reason: "external",
          goal: {
            sessionId: authoritativeSessionId,
            objective: "trust the durable row",
            status: "active",
            tokensUsed: 2,
            timeUsedSeconds: 3,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      },
      {
        id: "event_row_authority_goal_clear",
        type: "goal.cleared",
        time: 3 as TimestampMs,
        sessionId: authoritativeSessionId,
        payload: {
          sessionId: authoritativeSessionId,
          reason: "external",
          previousGoal: {
            sessionId: authoritativeSessionId,
            objective: "trust the durable row",
            status: "active",
            tokensUsed: 2,
            timeUsedSeconds: 3,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      },
    ]);
    const persistedPayloads = sqliteDatabase(store).query<{
      id: string;
      payload_session_id: string | null;
    }, []>(
      `select id,
              coalesce(
                json_extract(payload_json, '$.sessionId'),
                json_extract(payload_json, '$.goal.sessionId'),
                json_extract(payload_json, '$.previousGoal.sessionId')
              ) as payload_session_id
         from events
        where id like 'event_row_authority_%'
        order by seq`,
    ).all();
    expect(persistedPayloads).toEqual([
      { id: "event_row_authority_session", payload_session_id: stalePayloadSessionId },
      { id: "event_row_authority_goal", payload_session_id: stalePayloadSessionId },
      { id: "event_row_authority_goal_clear", payload_session_id: stalePayloadSessionId },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("backfills missing historical event row identity from scoped payloads on reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-scoped-identity-backfill-"));
  const dbPath = join(dir, "events.sqlite");
  const sessionPayloadId = "session_backfill_session_payload" as SessionId;
  const goalPayloadId = "session_backfill_goal_payload" as SessionId;
  const previousGoalPayloadId = "session_backfill_previous_goal" as SessionId;
  let store = new SqliteEventStore(dbPath);
  store.close();

  const rawDb = new Database(dbPath, { create: true, strict: true });
  rawDb.query(
    `insert into events (id, type, time, session_id, payload_json)
     values ('event_backfill_session_payload', 'session.created', 1, null, ?)`,
  ).run(JSON.stringify({ sessionId: sessionPayloadId, cwd: "/backfilled" }));
  rawDb.query(
    `insert into events (id, type, time, session_id, payload_json)
     values ('event_backfill_goal_payload', 'goal.updated', 2, null, ?)`,
  ).run(JSON.stringify({
    goal: {
      sessionId: goalPayloadId,
      objective: "recover the goal identity",
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 2,
      updatedAt: 2,
    },
  }));
  rawDb.query(
    `insert into events (id, type, time, session_id, payload_json)
     values ('event_backfill_previous_goal_payload', 'goal.cleared', 3, null, ?)`,
  ).run(JSON.stringify({
    previousGoal: {
      sessionId: previousGoalPayloadId,
      objective: "recover the previous goal identity",
      status: "active",
      tokensUsed: 1,
      timeUsedSeconds: 1,
      createdAt: 2,
      updatedAt: 3,
    },
  }));
  rawDb.close();

  try {
    store = new SqliteEventStore(dbPath);
    expect(sqliteDatabase(store).query<{ id: string; session_id: string | null }, []>(
      `select id, session_id
         from events
        where id like 'event_backfill_%'
        order by seq`,
    ).all()).toEqual([
      { id: "event_backfill_session_payload", session_id: sessionPayloadId },
      { id: "event_backfill_goal_payload", session_id: goalPayloadId },
      { id: "event_backfill_previous_goal_payload", session_id: previousGoalPayloadId },
    ]);
    expect(await store.events({ limit: 10 })).toEqual([
      {
        id: "event_backfill_session_payload",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId: sessionPayloadId,
        payload: { sessionId: sessionPayloadId, cwd: "/backfilled" },
      },
      {
        id: "event_backfill_goal_payload",
        type: "goal.updated",
        time: 2 as TimestampMs,
        sessionId: goalPayloadId,
        payload: {
          goal: {
            sessionId: goalPayloadId,
            objective: "recover the goal identity",
            status: "active",
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 2,
            updatedAt: 2,
          },
        },
      },
      {
        id: "event_backfill_previous_goal_payload",
        type: "goal.cleared",
        time: 3 as TimestampMs,
        sessionId: previousGoalPayloadId,
        payload: {
          sessionId: previousGoalPayloadId,
          previousGoal: {
            sessionId: previousGoalPayloadId,
            objective: "recover the previous goal identity",
            status: "active",
            tokensUsed: 1,
            timeUsedSeconds: 1,
            createdAt: 2,
            updatedAt: 3,
          },
        },
      },
    ]);
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

test("migrates the complete legacy thread schema to canonical session-only storage idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-session-only-migration-"));
  const dbPath = join(dir, "events.sqlite");
  const sessionId = "session_legacy_canonical" as SessionId;
  const legacyThreadId = "thread_legacy_canonical";
  const legacyColumns = [
    ["events", "thread_id"],
    ["messages", "thread_id"],
    ["tool_calls", "thread_id"],
    ["approvals", "thread_id"],
    ["agent_runs", "thread_id"],
    ["agent_runs", "parent_thread_id"],
    ["agent_runs", "child_thread_id"],
    ["agent_tasks", "parent_thread_id"],
    ["agent_tasks", "child_thread_id"],
    ["agent_mailbox", "child_session_id"],
    ["agent_mailbox", "child_thread_id"],
    ["team_members", "child_thread_id"],
    ["team_message_deliveries", "child_thread_id"],
  ] as const;
  let store = new SqliteEventStore(dbPath);
  store.close();

  const legacyDb = new Database(dbPath, { create: true, strict: true });
  legacyDb.exec(`
    alter table events add column thread_id text;
    alter table messages add column thread_id text;
    alter table tool_calls add column thread_id text;
    alter table approvals add column thread_id text;
    alter table agent_runs add column thread_id text;
    alter table agent_runs add column parent_thread_id text;
    alter table agent_runs add column child_thread_id text;
    alter table agent_tasks add column parent_thread_id text;
    alter table agent_tasks add column child_thread_id text;
    alter table agent_mailbox add column child_session_id text;
    alter table agent_mailbox add column child_thread_id text;
    alter table team_members add column child_thread_id text;
    alter table team_message_deliveries add column child_thread_id text;
    create index events_thread_seq_idx on events(thread_id, seq);
    create index events_thread_time_idx on events(thread_id, time, id);
    create table thread_goals (
      thread_id text primary key,
      session_id text,
      objective text not null,
      status text not null,
      token_budget integer,
      tokens_used integer not null default 0,
      time_used_seconds real not null default 0,
      created_at integer not null,
      updated_at integer not null,
      completed_at integer,
      last_reason text
    );
    create index thread_goals_session_idx on thread_goals(session_id);
  `);
  legacyDb.query(
    `insert into events (id, type, time, session_id, thread_id, payload_json)
     values (?, 'session.created', 1, ?, ?, ?)`,
  ).run(
    "event_legacy_session",
    sessionId,
    legacyThreadId,
    JSON.stringify({ sessionId, cwd: "/legacy/repo" }),
  );
  legacyDb.query(
    `insert into events (id, type, time, session_id, thread_id, payload_json)
     values (?, 'goal.updated', 2, null, ?, ?)`,
  ).run(
    "event_legacy_goal_updated",
    legacyThreadId,
    JSON.stringify({
      threadId: legacyThreadId,
      parentThreadId: "thread_legacy_parent",
      parentSessionId: "session_legacy_parent",
      childThreadId: "thread_legacy_child",
      childSessionId: "session_legacy_child",
      recipientThreadId: "thread_legacy_recipient",
      recipientSessionId: "session_legacy_recipient",
      reason: "external",
      goal: {
        threadId: legacyThreadId,
        objective: "finish the legacy migration",
        status: "active",
        tokenBudget: 10_000,
        tokensUsed: 123,
        timeUsedSeconds: 4,
        createdAt: 1,
        updatedAt: 2,
      },
    }),
  );
  legacyDb.query(
    `insert into events (id, type, time, session_id, thread_id, payload_json)
     values (?, 'goal.cleared', 3, null, ?, ?)`,
  ).run(
    "event_legacy_goal_cleared",
    legacyThreadId,
    JSON.stringify({
      threadId: legacyThreadId,
      parentThreadId: "thread_legacy_parent",
      childThreadId: "thread_legacy_child",
      recipientThreadId: "thread_legacy_recipient",
      reason: "external",
      previousGoal: {
        threadId: legacyThreadId,
        objective: "finish the legacy migration",
        status: "active",
        tokenBudget: 10_000,
        tokensUsed: 123,
        timeUsedSeconds: 4,
        createdAt: 1,
        updatedAt: 2,
      },
    }),
  );
  legacyDb.query(
    `insert into events (id, type, time, session_id, thread_id, payload_json)
     values (?, 'agent.message_queued', 4, ?, null, ?)`,
  ).run(
    "event_legacy_mailbox",
    sessionId,
    JSON.stringify({
      taskId: "task_legacy_mailbox",
      path: "/root/legacy-recipient",
      from: "/root",
      childSessionId: "session_legacy_recipient",
      triggerTurn: true,
      message: { role: "user", content: "legacy mailbox message" },
    }),
  );
  legacyDb.query(
    `insert into agent_mailbox
       (id, task_id, path, from_path, recipient_session_id, child_session_id, child_thread_id,
        trigger_turn, status, message_json, created_at)
     values (?, ?, ?, ?, null, ?, ?, 1, 'queued', ?, 4)`,
  ).run(
    "event_legacy_mailbox",
    "task_legacy_mailbox",
    "/root/legacy-recipient",
    "/root",
    "session_legacy_recipient",
    "thread_legacy_recipient",
    JSON.stringify({ role: "user", content: "legacy mailbox message" }),
  );
  legacyDb.query(
    `insert into thread_goals
       (thread_id, session_id, objective, status, token_budget, tokens_used,
        time_used_seconds, created_at, updated_at, last_reason)
     values (?, null, ?, 'active', 10000, 123, 4, 1, 2, 'external')`,
  ).run(legacyThreadId, "finish the legacy migration");
  legacyDb.close();

  const assertCanonicalSchema = (db: Database): void => {
    const remainingColumns = legacyColumns.filter(([table, column]) => db
      .query<{ name: string }, []>(`pragma table_info(${table})`)
      .all()
      .some((item) => item.name === column));
    expect(remainingColumns).toEqual([]);
    expect(db.query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table' and name = 'thread_goals'",
    ).get()).toBeNull();
    expect(db.query<{ name: string }, []>(
      "select name from sqlite_master where type = 'index' and lower(name) like '%thread%' order by name",
    ).all()).toEqual([]);
    expect(db.query<{ name: string }, []>(
      "select name from schema_migrations where name = 'session_only_schema_v1'",
    ).get()).toEqual({ name: "session_only_schema_v1" });
  };

  try {
    store = new SqliteEventStore(dbPath);
    const canonicalEvents = await store.events({ sessionId, limit: 10 });
    expect(canonicalEvents).toEqual([
      {
        id: "event_legacy_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: "/legacy/repo" },
      },
      {
        id: "event_legacy_goal_updated",
        type: "goal.updated",
        time: 2 as TimestampMs,
        sessionId,
        payload: {
          parentSessionId: "session_legacy_parent",
          childSessionId: "session_legacy_child",
          recipientSessionId: "session_legacy_recipient",
          reason: "external",
          goal: {
            sessionId,
            objective: "finish the legacy migration",
            status: "active",
            tokenBudget: 10_000,
            tokensUsed: 123,
            timeUsedSeconds: 4,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      },
      {
        id: "event_legacy_goal_cleared",
        type: "goal.cleared",
        time: 3 as TimestampMs,
        sessionId,
        payload: {
          parentSessionId: "session_legacy_parent",
          childSessionId: "session_legacy_child",
          recipientSessionId: "session_legacy_recipient",
          sessionId,
          reason: "external",
          previousGoal: {
            sessionId,
            objective: "finish the legacy migration",
            status: "active",
            tokenBudget: 10_000,
            tokensUsed: 123,
            timeUsedSeconds: 4,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      },
      {
        id: "event_legacy_mailbox",
        type: "agent.message_queued",
        time: 4 as TimestampMs,
        sessionId,
        payload: {
          taskId: "task_legacy_mailbox" as TaskId,
          path: "/root/legacy-recipient" as AgentPath,
          from: "/root" as AgentPath,
          recipientSessionId: "session_legacy_recipient" as SessionId,
          triggerTurn: true,
          message: { role: "user", content: "legacy mailbox message" },
        },
      },
    ]);
    expect(await store.sessionGoal(sessionId)).toEqual({
      sessionId,
      objective: "finish the legacy migration",
      status: "active",
      tokenBudget: 10_000,
      tokensUsed: 123,
      timeUsedSeconds: 4,
      createdAt: 1 as TimestampMs,
      updatedAt: 2 as TimestampMs,
      lastReason: "external",
    });
    const rawClearedPayload = JSON.parse(String(sqliteDatabase(store)
      .query<{ payload_json: string }, []>(
        "select payload_json from events where id = 'event_legacy_goal_cleared'",
      )
      .get()?.payload_json)) as Record<string, unknown>;
    expect(rawClearedPayload).toMatchObject({
      childThreadId: "thread_legacy_child",
      recipientThreadId: "thread_legacy_recipient",
    });
    expect(rawClearedPayload).not.toHaveProperty("childSessionId");
    const rawMailboxPayload = JSON.parse(String(sqliteDatabase(store)
      .query<{ payload_json: string }, []>(
        "select payload_json from events where id = 'event_legacy_mailbox'",
      )
      .get()?.payload_json)) as Record<string, unknown>;
    expect(rawMailboxPayload).toMatchObject({
      childSessionId: "session_legacy_recipient",
    });
    expect(rawMailboxPayload).not.toHaveProperty("recipientSessionId");
    expect(await store.agentMailbox({
      recipientSessionId: "session_legacy_recipient" as SessionId,
    })).toEqual([
      expect.objectContaining({
        id: "event_legacy_mailbox",
        recipientSessionId: "session_legacy_recipient",
      }),
    ]);
    expect(sqliteDatabase(store)
      .query<{ session_id: string }, [string]>(
        "select session_id from legacy_session_identities where legacy_id = ?",
      )
      .get("thread_legacy_child"))
      .toEqual({ session_id: "session_legacy_child" });
    assertCanonicalSchema(sqliteDatabase(store));

    store.close();
    store = new SqliteEventStore(dbPath);
    expect(await store.events({ sessionId, limit: 10 })).toEqual(canonicalEvents);
    expect(await store.sessionGoal(sessionId)).toMatchObject({
      sessionId,
      objective: "finish the legacy migration",
      tokensUsed: 123,
    });
    expect(await store.agentMailbox({
      recipientSessionId: "session_legacy_recipient" as SessionId,
    })).toEqual([
      expect.objectContaining({
        id: "event_legacy_mailbox",
        recipientSessionId: "session_legacy_recipient",
      }),
    ]);
    assertCanonicalSchema(sqliteDatabase(store));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects duplicate legacy task child sessions and rolls the migration back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-session-only-duplicate-child-"));
  const dbPath = join(dir, "events.sqlite");
  const bootstrap = new SqliteEventStore(dbPath);
  bootstrap.close();

  const legacyDb = new Database(dbPath, { create: true, strict: true });
  legacyDb.exec(`
    drop index agent_tasks_child_session_idx;
    delete from schema_migrations where name = 'session_only_schema_v1';
    alter table events add column thread_id text;
    alter table agent_tasks add column child_thread_id text;
  `);
  legacyDb.query(
    `insert into events (id, type, time, session_id, thread_id, payload_json)
     values ('event_duplicate_child_session', 'session.created', 1, ?, ?, ?)`,
  ).run(
    "session_duplicate_child",
    "thread_duplicate_child",
    JSON.stringify({ sessionId: "session_duplicate_child", cwd: "/repo" }),
  );
  const insert = legacyDb.query(
    `insert into agent_tasks
       (id, path, child_session_id, child_thread_id, task_name, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, 'running', 1, 1)`,
  );
  insert.run(
    "task_duplicate_child_a",
    "/root/task_duplicate_child_a",
    null,
    "thread_duplicate_child",
    "duplicate child a",
  );
  insert.run(
    "task_duplicate_child_b",
    "/root/task_duplicate_child_b",
    null,
    "thread_duplicate_child",
    "duplicate child b",
  );
  legacyDb.close();

  try {
    expect(() => new SqliteEventStore(dbPath)).toThrow(
      "Cannot enforce one task per child session session_duplicate_child",
    );

    const auditDb = new Database(dbPath, { create: false, strict: true });
    try {
      expect(auditDb.query<{ count: number }, []>(
        "select count(*) as count from agent_tasks where child_session_id is null",
      ).get()?.count).toBe(2);
      expect(auditDb.query<{ name: string }, []>("pragma table_info(agent_tasks)").all())
        .toContainEqual(expect.objectContaining({ name: "child_thread_id" }));
      expect(auditDb.query<{ name: string }, []>(
        "select name from schema_migrations where name = 'session_only_schema_v1'",
      ).get()).toBeNull();
      expect(auditDb.query<{ name: string }, []>(
        "select name from sqlite_master where type = 'index' and name = 'agent_tasks_child_session_idx'",
      ).get()).toBeNull();
    } finally {
      auditDb.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rebuilds a misleading same-named child session index on the canonical column", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-session-only-wrong-index-"));
  const dbPath = join(dir, "events.sqlite");
  let store = new SqliteEventStore(dbPath);
  store.close();

  const legacyDb = new Database(dbPath, { create: true, strict: true });
  legacyDb.exec(`
    drop index agent_tasks_child_session_idx;
    create unique index agent_tasks_child_session_idx on agent_tasks(path);
  `);
  legacyDb.close();

  try {
    store = new SqliteEventStore(dbPath);
    const migratedDb = sqliteDatabase(store);
    expect(migratedDb
      .query<{ name: string }, []>(
        "select name from pragma_index_info('agent_tasks_child_session_idx') order by seqno",
      )
      .all())
      .toEqual([{ name: "child_session_id" }]);
    expect(migratedDb
      .query<{ unique: number; partial: number; name: string }, []>(
        `select name, [unique], partial from pragma_index_list('agent_tasks')`,
      )
      .all())
      .toContainEqual({
        name: "agent_tasks_child_session_idx",
        unique: 1,
        partial: 1,
      });

    const insert = migratedDb.query(
      `insert into agent_tasks
         (id, path, child_session_id, task_name, status, created_at, updated_at)
       values (?, ?, 'session_unique_child', ?, 'running', 1, 1)`,
    );
    insert.run("task_unique_child_a", "/root/task_unique_child_a", "unique child a");
    expect(() => insert.run(
      "task_unique_child_b",
      "/root/task_unique_child_b",
      "unique child b",
    )).toThrow();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects ambiguous legacy conversation mappings and rolls the migration back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-session-only-ambiguous-"));
  const dbPath = join(dir, "events.sqlite");
  const bootstrap = new SqliteEventStore(dbPath);
  bootstrap.close();

  const legacyDb = new Database(dbPath, { create: true, strict: true });
  legacyDb.exec(`
    delete from schema_migrations where name = 'session_only_schema_v1';
    alter table events add column thread_id text;
  `);
  const insert = legacyDb.query(
    `insert into events (id, type, time, session_id, thread_id, payload_json)
     values (?, 'session.created', ?, ?, 'thread_ambiguous', ?)`,
  );
  insert.run(
    "event_ambiguous_a",
    1,
    "session_ambiguous_a",
    JSON.stringify({ sessionId: "session_ambiguous_a", cwd: "/repo/a" }),
  );
  insert.run(
    "event_ambiguous_b",
    2,
    "session_ambiguous_b",
    JSON.stringify({ sessionId: "session_ambiguous_b", cwd: "/repo/b" }),
  );
  legacyDb.close();

  try {
    expect(() => new SqliteEventStore(dbPath)).toThrow(
      "Cannot migrate legacy conversation thread_ambiguous: it maps to multiple sessions",
    );

    const auditDb = new Database(dbPath, { create: false, strict: true });
    try {
      expect(auditDb.query<{ count: number }, []>(
        "select count(*) as count from events where thread_id = 'thread_ambiguous'",
      ).get()?.count).toBe(2);
      expect(auditDb.query<{ name: string }, []>("pragma table_info(events)").all())
        .toContainEqual(expect.objectContaining({ name: "thread_id" }));
      expect(auditDb.query<{ name: string }, []>(
        "select name from schema_migrations where name = 'session_only_schema_v1'",
      ).get()).toBeNull();
    } finally {
      auditDb.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("adds and backfills missing replacement session columns before dropping legacy columns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-session-only-missing-replacement-"));
  const dbPath = join(dir, "events.sqlite");
  const sessionId = "session_missing_replacement" as SessionId;
  const taskId = "task_missing_replacement" as TaskId;
  let store = new SqliteEventStore(dbPath);
  store.close();

  const legacyDb = new Database(dbPath, { create: true, strict: true });
  legacyDb.exec(`
    drop index agent_tasks_child_session_idx;
    drop index events_session_seq_idx;
    drop index events_session_type_seq_idx;
    drop index events_session_time_idx;
    delete from schema_migrations where name = 'session_only_schema_v1';
    alter table events add column thread_id text;
    alter table events drop column session_id;
    alter table agent_tasks drop column child_session_id;
    alter table agent_tasks add column child_thread_id text;
  `);
  legacyDb.query(
    `insert into events (id, type, time, thread_id, payload_json)
     values ('event_missing_replacement_session', 'session.created', 1, ?, ?)`,
  ).run(
    "thread_missing_replacement",
    JSON.stringify({ sessionId, cwd: "/repo" }),
  );
  legacyDb.query(
    `insert into agent_tasks
       (id, path, child_thread_id, task_name, status, created_at, updated_at)
     values (?, '/root/task_missing_replacement', 'thread_missing_replacement',
             'missing replacement', 'running', 1, 1)`,
  ).run(taskId);
  legacyDb.close();

  try {
    store = new SqliteEventStore(dbPath);
    expect(await store.events({ sessionId, limit: 10 })).toEqual([
      {
        id: "event_missing_replacement_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: "/repo" },
      },
    ]);
    expect(await store.agentTask(taskId)).toMatchObject({
      id: taskId,
      childSessionId: sessionId,
      status: "running",
    });
    const migratedDb = sqliteDatabase(store);
    const columns = migratedDb.query<{ name: string }, []>("pragma table_info(agent_tasks)").all();
    expect(columns).toContainEqual(expect.objectContaining({ name: "child_session_id" }));
    expect(columns).not.toContainEqual(expect.objectContaining({ name: "child_thread_id" }));
    expect(migratedDb.query<{ name: string }, []>(
      "select name from sqlite_master where type = 'index' and name = 'agent_tasks_child_session_idx'",
    ).get()).toEqual({ name: "agent_tasks_child_session_idx" });
    expect(migratedDb.query<{ name: string }, []>(
      "select name from schema_migrations where name = 'session_only_schema_v1'",
    ).get()).toEqual({ name: "session_only_schema_v1" });
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

test("migrates older approval tables and reads added projection fields", async () => {
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
      payload: {
        approvalId: "approval_metadata" as ApprovalId,
        permission: "tool.bash",
        patterns: ["bun test"],
        maxApprovalScope: "once",
        metadata: { reason: "Policy requires approval", source: "workspace config" },
      },
    });

    expect(await store.pendingApprovals(sessionId)).toMatchObject([
      {
        id: "approval_metadata",
        maxApprovalScope: "once",
        metadata: { reason: "Policy requires approval", source: "workspace config" },
      },
    ]);
    expect(sqliteDatabase(store).query<{ name: string }, []>("pragma table_info(approvals)").all())
      .toContainEqual(expect.objectContaining({ name: "max_approval_scope" }));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("materializes maximum approval scope in pending approval rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-approval-scope-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_approval_scope" as SessionId;

  try {
    await store.append({
      id: "event_approval_scope",
      type: "approval.requested",
      time: 1 as TimestampMs,
      sessionId,
      payload: {
        approvalId: "approval_scope" as ApprovalId,
        permission: "bash.unsandboxed",
        patterns: ["open README.md"],
        maxApprovalScope: "once",
      },
    });

    expect(await store.pendingApprovals(sessionId)).toEqual([
      {
        id: "approval_scope",
        sessionId,
        permission: "bash.unsandboxed",
        patterns: ["open README.md"],
        maxApprovalScope: "once",
        status: "pending",
        createdAt: 1,
      },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrates older message tables without turn_id before creating turn indexes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-message-turn-migration-"));
  const dbPath = join(dir, "events.sqlite");
  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    create table messages (
      id text primary key,
      session_id text not null,
      thread_id text,
      role text not null,
      parent_id text,
      created_at integer not null
    )
  `);
  db.close();

  const store = new SqliteEventStore(dbPath);
  const sessionId = "session_message_turn_migration" as SessionId;
  const turnId = "turn_message_turn_migration" as TurnId;
  const messageId = "message_message_turn_migration" as MessageId;

  try {
    await store.append({
      id: "event_message_turn_migration",
      type: "message.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { messageId, role: "user", turnId },
    });

    expect(await store.messages(sessionId)).toEqual([
      {
        id: messageId,
        sessionId,
        role: "user",
        parts: [],
        turnId,
        createdAt: 1 as TimestampMs,
      },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("projects persistent session goals and clears them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-goal-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_goal_store" as SessionId;

  try {
    await store.append(sessionEvent("event_goal_session", sessionId, 1 as TimestampMs));
    await store.append({
      id: "event_goal_set",
      type: "goal.updated",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        reason: "set",
        goal: {
          sessionId,
          objective: "ship /goal",
          status: "active",
          tokenBudget: 50_000,
          tokensUsed: 123,
          timeUsedSeconds: 4,
          createdAt: 2 as TimestampMs,
          updatedAt: 2 as TimestampMs,
        },
      },
    });

    expect(await store.sessionGoal(sessionId)).toMatchObject({
      sessionId,
      objective: "ship /goal",
      status: "active",
      tokenBudget: 50_000,
      tokensUsed: 123,
    });

    await store.append({
      id: "event_goal_clear",
      type: "goal.cleared",
      time: 3 as TimestampMs,
      sessionId,
      payload: { sessionId, reason: "clear" },
    });
    expect(await store.sessionGoal(sessionId)).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("replays message part deltas without rewriting the full projection until turn completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-part-delta-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_delta" as SessionId;
  const messageId = "message_delta" as MessageId;
  const partId = "part_delta" as PartId;
  const turnId = "turn_delta" as TurnId;
  const time = 1 as TimestampMs;

  try {
    await store.append(sessionEvent("event_session", sessionId, time));
    await store.append({
      id: "event_message",
      type: "message.created",
      time,
      sessionId,
      payload: { messageId, role: "assistant", turnId },
    });
    await store.append({
      id: "event_part",
      type: "message.part_added",
      time,
      sessionId,
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
      payload: { messageId, partId, field: "text", delta: "lo" },
    });

    const db = sqliteDatabase(store);
    const beforeCompletion = db
      .query<{ data_json: string; delta_event_seq: number }, [string]>(
        "select data_json, delta_event_seq from message_parts where id = ?",
      )
      .get(partId);
    expect(JSON.parse(beforeCompletion?.data_json ?? "{}").text).toBe("hel");
    expect(beforeCompletion?.delta_event_seq).toBe(0);

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
    expect(await store.events({ type: "message.part_delta", limit: 10 })).toHaveLength(1);

    await store.append({
      id: "event_turn_completed",
      type: "turn.completed",
      time: 2 as TimestampMs,
      sessionId,
      payload: { turnId, status: "completed" },
    });

    const afterCompletion = db
      .query<{ data_json: string; delta_event_seq: number }, [string]>(
        "select data_json, delta_event_seq from message_parts where id = ?",
      )
      .get(partId);
    expect(JSON.parse(afterCompletion?.data_json ?? "{}").text).toBe("hello");
    expect(afterCompletion?.delta_event_seq).toBeGreaterThan(0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrates older eager message projections without replaying historical deltas twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-part-delta-migration-"));
  const dbPath = join(dir, "events.sqlite");
  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    create table events (
      seq integer primary key autoincrement,
      id text not null unique,
      type text not null,
      time integer not null,
      session_id text,
      thread_id text,
      payload_json text not null
    );
    create table messages (
      id text primary key,
      session_id text not null,
      thread_id text,
      turn_id text,
      role text not null,
      parent_id text,
      created_at integer not null
    );
    create table message_parts (
      id text primary key,
      message_id text not null,
      session_id text not null,
      type text not null,
      ordinal integer not null,
      data_json text not null,
      created_at integer not null
    );
    insert into messages
      (id, session_id, thread_id, turn_id, role, created_at)
    values
      ('message_legacy_delta', 'session_legacy_delta', 'thread_legacy_delta', 'turn_legacy_delta', 'assistant', 1);
    insert into message_parts
      (id, message_id, session_id, type, ordinal, data_json, created_at)
    values
      ('part_legacy_delta', 'message_legacy_delta', 'session_legacy_delta', 'text', 0,
       '{"id":"part_legacy_delta","messageId":"message_legacy_delta","sessionId":"session_legacy_delta","type":"text","text":"hello"}', 1);
    insert into events
      (id, type, time, session_id, thread_id, payload_json)
    values
      ('event_legacy_delta', 'message.part_delta', 2, 'session_legacy_delta', 'thread_legacy_delta',
       '{"messageId":"message_legacy_delta","partId":"part_legacy_delta","field":"text","delta":"lo"}');
  `);
  db.close();

  const store = new SqliteEventStore(dbPath);
  try {
    const migrated = sqliteDatabase(store)
      .query<{ data_json: string; delta_event_seq: number }, []>(
        "select data_json, delta_event_seq from message_parts where id = 'part_legacy_delta'",
      )
      .get();
    expect(JSON.parse(migrated?.data_json ?? "{}").text).toBe("hello");
    expect(migrated?.delta_event_seq).toBe(1);
    expect((await store.messages("session_legacy_delta" as SessionId))[0]?.parts).toMatchObject([
      { id: "part_legacy_delta", text: "hello" },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("finishes checkpoint backfill when the column exists without a migration marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-part-delta-resumed-migration-"));
  const dbPath = join(dir, "events.sqlite");
  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    create table events (
      seq integer primary key autoincrement,
      id text not null unique,
      type text not null,
      time integer not null,
      session_id text,
      thread_id text,
      payload_json text not null
    );
    create table messages (
      id text primary key,
      session_id text not null,
      thread_id text,
      turn_id text,
      role text not null,
      parent_id text,
      created_at integer not null
    );
    create table message_parts (
      id text primary key,
      message_id text not null,
      session_id text not null,
      type text not null,
      ordinal integer not null,
      data_json text not null,
      delta_event_seq integer not null default 0,
      created_at integer not null
    );
    insert into messages
      (id, session_id, thread_id, turn_id, role, created_at)
    values
      ('message_interrupted_delta', 'session_interrupted_delta', 'thread_interrupted_delta',
       'turn_interrupted_delta', 'assistant', 1);
    insert into message_parts
      (id, message_id, session_id, type, ordinal, data_json, delta_event_seq, created_at)
    values
      ('part_interrupted_delta', 'message_interrupted_delta', 'session_interrupted_delta', 'text', 0,
       '{"id":"part_interrupted_delta","messageId":"message_interrupted_delta","sessionId":"session_interrupted_delta","type":"text","text":"hello"}', 0, 1);
    insert into events
      (id, type, time, session_id, thread_id, payload_json)
    values
      ('event_interrupted_delta', 'message.part_delta', 2, 'session_interrupted_delta', 'thread_interrupted_delta',
       '{"messageId":"message_interrupted_delta","partId":"part_interrupted_delta","field":"text","delta":"lo"}');
  `);
  db.close();

  let store = new SqliteEventStore(dbPath);
  try {
    const migratedDb = sqliteDatabase(store);
    expect(migratedDb
      .query<{ delta_event_seq: number }, []>(
        "select delta_event_seq from message_parts where id = 'part_interrupted_delta'",
      )
      .get()?.delta_event_seq).toBe(1);
    expect(migratedDb
      .query<{ name: string }, []>(
        "select name from schema_migrations where name = 'message_part_delta_checkpoints_v1'",
      )
      .get()?.name).toBe("message_part_delta_checkpoints_v1");

    const sessionId = "session_after_checkpoint_marker" as SessionId;
    const messageId = "message_after_checkpoint_marker" as MessageId;
    const partId = "part_after_checkpoint_marker" as PartId;
    const turnId = "turn_after_checkpoint_marker" as TurnId;
    await store.appendMany([
      {
        id: "event_message_after_checkpoint_marker",
        type: "message.created",
        time: 3 as TimestampMs,
        sessionId,
        payload: { messageId, role: "assistant", turnId },
      },
      {
        id: "event_part_after_checkpoint_marker",
        type: "message.part_added",
        time: 4 as TimestampMs,
        sessionId,
        payload: {
          messageId,
          part: { id: partId, messageId, sessionId, type: "text", text: "new" },
        },
      },
      {
        id: "event_delta_after_checkpoint_marker",
        type: "message.part_delta",
        time: 5 as TimestampMs,
        sessionId,
        payload: { messageId, partId, field: "text", delta: "!" },
      },
    ]);
    store.close();

    store = new SqliteEventStore(dbPath);
    const reopenedDb = sqliteDatabase(store);
    const pendingProjection = reopenedDb
      .query<{ data_json: string; delta_event_seq: number }, [string]>(
        "select data_json, delta_event_seq from message_parts where id = ?",
      )
      .get(partId);
    expect(JSON.parse(pendingProjection?.data_json ?? "{}").text).toBe("new");
    expect(pendingProjection?.delta_event_seq).toBe(0);
    expect((await store.messages(sessionId))[0]?.parts).toMatchObject([{ id: partId, text: "new!" }]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("writes a growing message projection once instead of once per streamed delta", async () => {
  const store = new SqliteEventStore(":memory:");
  const sessionId = "session_delta_amplification" as SessionId;
  const turnId = "turn_delta_amplification" as TurnId;
  const messageId = "message_delta_amplification" as MessageId;
  const partId = "part_delta_amplification" as PartId;

  try {
    await store.appendMany([
      sessionEvent("event_delta_amplification_session", sessionId, 1 as TimestampMs),
      {
        id: "event_delta_amplification_message",
        type: "message.created",
        time: 2 as TimestampMs,
        sessionId,
        payload: { messageId, role: "assistant", turnId },
      },
      {
        id: "event_delta_amplification_part",
        type: "message.part_added",
        time: 3 as TimestampMs,
        sessionId,
        payload: {
          messageId,
          part: { id: partId, messageId, sessionId, type: "text", text: "seed" },
        },
      },
    ]);

    const db = sqliteDatabase(store);
    db.exec(`
      create temp table message_part_update_count (count integer not null);
      insert into message_part_update_count values (0);
      create temp trigger count_message_part_data_updates
      after update of data_json on message_parts
      begin
        update message_part_update_count set count = count + 1;
      end;
    `);
    const chunk = "x".repeat(1_024);
    const deltas: ChiliEvent[] = Array.from({ length: 128 }, (_, index) => ({
      id: `event_delta_amplification_${index}`,
      type: "message.part_delta",
      time: (4 + index) as TimestampMs,
      sessionId,
      payload: { messageId, partId, field: "text", delta: chunk },
    }));
    await store.appendMany(deltas);

    expect(db.query<{ count: number }, []>("select count from message_part_update_count").get()?.count).toBe(0);
    const streamedPart = (await store.messages(sessionId))[0]?.parts[0];
    expect(streamedPart?.type === "text" ? streamedPart.text.length : 0).toBe(4 + 128 * chunk.length);

    await store.append({
      id: "event_delta_amplification_completed",
      type: "turn.completed",
      time: 200 as TimestampMs,
      sessionId,
      payload: { turnId, status: "completed" },
    });
    expect(db.query<{ count: number }, []>("select count from message_part_update_count").get()?.count).toBe(1);
  } finally {
    store.close();
  }
});

test("projects local subagent tasks, runs, mailbox, and completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-subagent-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const parentSessionId = "session_parent" as SessionId;
  const childSessionId = "session_child" as SessionId;
  const taskId = "task_review" as TaskId;
  const runId = "agent_review" as AgentRunId;
  const path = "/root/task_review" as AgentPath;
  const parentPath = "/root" as AgentPath;
  const time = 1 as TimestampMs;

  try {
    await store.append(sessionEvent("event_session", parentSessionId, time));
    await store.append({
      id: "event_task_created",
      type: "agent.task_created",
      time,
      sessionId: parentSessionId,
      payload: {
        taskId,
        path,
        parentPath,
        parentSessionId,
        childSessionId,
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
      payload: {
        runId,
        taskId,
        path,
        parentPath,
        parentSessionId,
        childSessionId,
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
      payload: {
        taskId,
        path,
        from: parentPath,
        recipientSessionId: childSessionId,
        triggerTurn: true,
        message: { role: "user", content: "go" },
      },
    });
    await store.append({
      id: "event_mailbox_consumed",
      type: "agent.message_consumed",
      time,
      sessionId: parentSessionId,
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
        childSessionId,
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
        taskId,
        path,
        parentPath,
        parentSessionId,
        childSessionId,
        taskName: "review",
        cwd: "/repo",
        mode: "one_shot",
        status: "completed",
      },
    ]);
    expect(await store.agentMailbox({ taskId, recipientSessionId: childSessionId })).toMatchObject([
      {
        id: "event_mailbox",
        taskId,
        path,
        fromPath: parentPath,
        recipientSessionId: childSessionId,
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
      payload: {
        runId: "agent_review_followup" as AgentRunId,
        taskId,
        path,
        parentPath,
        parentSessionId,
        childSessionId,
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

test("round-trips and queries local subagent scheduling provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-subagent-provenance-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const parentSessionId = "session_provenance_parent" as SessionId;
  const sourceCallId = "call_provenance_batch" as ToolCallId;
  const batchId = "batch_provenance";
  const taskId = "task_provenance_created" as TaskId;
  const spawnedTaskId = "task_provenance_spawned" as TaskId;

  try {
    await store.append({
      id: "event_provenance_task_created",
      type: "agent.task_created",
      time: 1 as TimestampMs,
      sessionId: parentSessionId,
      payload: {
        taskId,
        path: "/root/task_provenance_created" as AgentPath,
        parentPath: "/root" as AgentPath,
        parentSessionId,
        childSessionId: "session_provenance_created" as SessionId,
        taskName: "created provenance",
        cwd: "/repo",
        prompt: "inspect created provenance",
        mode: "background",
        sourceCallId,
        batchId,
        batchIndex: 0,
        expectedBatchSize: 2,
        completionPolicy: "supervised",
        maxConcurrency: 1,
      },
    });
    await store.append({
      id: "event_provenance_task_spawned",
      type: "agent.spawned",
      time: 2 as TimestampMs,
      sessionId: parentSessionId,
      payload: {
        runId: "agent_provenance_created" as AgentRunId,
        taskId,
        path: "/root/task_provenance_created" as AgentPath,
        parentPath: "/root" as AgentPath,
        parentSessionId,
        childSessionId: "session_provenance_created" as SessionId,
        taskName: "created provenance",
        cwd: "/repo",
        mode: "background",
        generation: 1,
      },
    });

    await store.append({
      id: "event_provenance_spawn_only",
      type: "agent.spawned",
      time: 3 as TimestampMs,
      sessionId: parentSessionId,
      payload: {
        runId: "agent_provenance_spawned" as AgentRunId,
        taskId: spawnedTaskId,
        path: "/root/task_provenance_spawned" as AgentPath,
        parentPath: "/root" as AgentPath,
        parentSessionId,
        childSessionId: "session_provenance_spawned" as SessionId,
        taskName: "spawned provenance",
        cwd: "/repo",
        mode: "background",
        generation: 1,
        sourceCallId,
        batchId,
        batchIndex: 1,
        expectedBatchSize: 2,
        completionPolicy: "notify",
        maxConcurrency: 1,
      },
    });

    expect(await store.agentTask(taskId)).toMatchObject({
      sourceCallId,
      batchId,
      batchIndex: 0,
      expectedBatchSize: 2,
      completionPolicy: "supervised",
      maxConcurrency: 1,
    });
    expect(await store.agentTask(spawnedTaskId)).toMatchObject({
      sourceCallId,
      batchId,
      batchIndex: 1,
      expectedBatchSize: 2,
      completionPolicy: "notify",
      maxConcurrency: 1,
    });
    expect((await store.agentTasks({ sourceCallId, batchId })).map((task) => task.id)).toEqual([
      taskId,
      spawnedTaskId,
    ]);
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

    const staleExpirySnapshot = await store.closeAgentTaskCas({
      taskId,
      status: "cancelled",
      eventId: "event_stale_expiry_task_close",
      agentEventId: "event_stale_expiry_run_close",
      expectedGeneration: 2,
      expectedRunId: runId,
      expectedLeaseOwner: "worker_a",
      expectedLeaseExpiresAt: 150,
      requireExpiredLease: true,
      time: 171,
    });
    expect(staleExpirySnapshot.applied).toBe(false);
    expect(await store.agentTask(taskId)).toMatchObject({
      status: "running",
      generation: 2,
      leaseExpiresAt: 170,
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

test("rejects stale lease-holder finalization after a takeover generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-lease-takeover-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_lease_takeover" as TaskId;
  const runId = "agent_lease_takeover" as AgentRunId;
  const path = "/root/task_lease_takeover" as AgentPath;

  try {
    await appendRunningTask(store, { taskId, runId, path, generation: 1, time: 1 as TimestampMs });
    const first = await store.claimAgentTaskLease({
      taskId,
      runId,
      generation: 1,
      owner: "worker_a",
      ttlMs: 50,
      now: 100,
    });
    expect(first).toMatchObject({ acquired: true, task: { generation: 2, leaseOwner: "worker_a" } });

    const expiredRenewal = await store.renewAgentTaskLease({
      taskId,
      owner: "worker_a",
      generation: 2,
      ttlMs: 50,
      now: 150,
    });
    expect(expiredRenewal.acquired).toBe(false);

    const takeover = await store.claimAgentTaskLease({
      taskId,
      runId,
      generation: 2,
      owner: "worker_b",
      ttlMs: 50,
      now: 150,
    });
    expect(takeover).toMatchObject({ acquired: true, task: { generation: 3, leaseOwner: "worker_b" } });
    expect(sqliteDatabase(store).query<{ generation: number }, [string]>(
      "select generation from agent_runs where id = ?",
    ).get(runId)?.generation).toBe(3);

    await store.append({
      id: "event_stale_agent_completion",
      type: "agent.completed",
      time: 151 as TimestampMs,
      payload: {
        runId,
        taskId,
        path,
        status: "failed",
        generation: 2,
        error: "stale worker result",
      },
    });
    expect(await store.agentTask(taskId)).toMatchObject({ status: "running", generation: 3 });
    expect(await store.agentRuns({ taskId })).toEqual([
      expect.objectContaining({ id: runId, status: "running" }),
    ]);

    const staleCompletion = await store.completeAgentTaskCas({
      taskId,
      path,
      runId,
      generation: 2,
      expectedGeneration: 2,
      expectedRunId: runId,
      expectedLeaseOwner: "worker_a",
      requireActiveLease: true,
      status: "completed",
      eventId: "event_stale_task_completion",
      agentEventId: "event_stale_run_completion",
      time: 152,
    });
    const staleClose = await store.closeAgentTaskCas({
      taskId,
      status: "cancelled",
      eventId: "event_stale_task_close",
      agentEventId: "event_stale_run_close",
      expectedGeneration: 2,
      expectedRunId: runId,
      expectedLeaseOwner: "worker_a",
      time: 152,
    });
    expect(staleCompletion).toMatchObject({ applied: false, events: [] });
    expect(staleClose).toMatchObject({ applied: false, events: [] });
    expect(await store.agentTask(taskId)).toMatchObject({
      status: "running",
      generation: 3,
      leaseOwner: "worker_b",
    });

    const winner = await store.completeAgentTaskCas({
      taskId,
      path: "/caller/supplied/wrong-path" as AgentPath,
      runId,
      generation: 3,
      expectedGeneration: 3,
      expectedRunId: runId,
      expectedLeaseOwner: "worker_b",
      requireActiveLease: true,
      status: "completed",
      summary: "winner result",
      eventId: "event_winner_task_completion",
      agentEventId: "event_winner_run_completion",
      time: 160,
    });
    expect(winner.applied).toBe(true);
    expect(winner.events.map((event) => event.id)).toEqual([
      "event_winner_task_completion",
      "event_winner_run_completion",
    ]);
    expect(winner.events.map((event) => {
      if (event.type !== "agent.task_completed" && event.type !== "agent.completed") {
        throw new Error(`Unexpected completion event: ${event.type}`);
      }
      return event.payload.path;
    })).toEqual([path, path]);
    expect(await store.agentTask(taskId)).toMatchObject({ status: "completed", generation: 3 });
    expect(await store.agentRuns({ taskId })).toEqual([
      expect.objectContaining({ id: runId, status: "completed" }),
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rolls back paired task and run completion when the second event cannot insert", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-pair-rollback-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_pair_rollback" as TaskId;
  const runId = "agent_pair_rollback" as AgentRunId;
  const path = "/root/task_pair_rollback" as AgentPath;

  try {
    await appendRunningTask(store, { taskId, runId, path, generation: 1, time: 1 as TimestampMs });
    await store.append(sessionEvent(
      "event_pair_run_conflict",
      "session_conflict" as SessionId,
      2 as TimestampMs,
    ));

    await expect(store.completeAgentTaskCas({
      taskId,
      path,
      runId,
      generation: 1,
      expectedGeneration: 1,
      expectedRunId: runId,
      expectedLeaseOwner: null,
      status: "completed",
      eventId: "event_pair_task_new",
      agentEventId: "event_pair_run_conflict",
      time: 3,
    })).rejects.toThrow();

    expect(await store.agentTask(taskId)).toMatchObject({ status: "running", generation: 1 });
    expect(await store.agentRuns({ taskId })).toEqual([
      expect.objectContaining({ id: runId, status: "running" }),
    ]);
    expect(await store.events({ type: "agent.task_completed", limit: 10 })).toEqual([]);
    expect(await store.events({ type: "agent.completed", limit: 10 })).toEqual([]);
    expect((await store.events({ limit: 20 })).map((event) => event.id)).not.toContain("event_pair_task_new");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomically completes a task and consumes its delivering mailbox message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-mailbox-complete-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_mailbox_complete" as TaskId;
  const runId = "agent_mailbox_complete" as AgentRunId;
  const path = "/root/task_mailbox_complete" as AgentPath;
  const messageId = "event_mailbox_complete_message";

  try {
    await appendRunningTask(store, { taskId, runId, path, generation: 1, time: 1 as TimestampMs });
    await store.append({
      id: messageId,
      type: "agent.message_queued",
      time: 2 as TimestampMs,
      payload: {
        taskId,
        path,
        from: "/root" as AgentPath,
        triggerTurn: true,
        message: { role: "user", content: "finish this" },
      },
    });
    expect((await store.claimAgentMailboxMessage({
      messageId,
      eventId: "event_mailbox_complete_claim",
      time: 3,
    })).applied).toBe(true);

    const result = await store.completeAgentTaskCas({
      taskId,
      path,
      runId,
      generation: 1,
      expectedGeneration: 1,
      expectedRunId: runId,
      expectedLeaseOwner: null,
      status: "completed",
      summary: "done",
      eventId: "event_mailbox_complete_task",
      agentEventId: "event_mailbox_complete_agent",
      mailboxMessageId: messageId,
      mailboxConsumeEventId: "event_mailbox_complete_consumed",
      time: 4,
    });

    expect(result.applied).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual([
      "agent.task_completed",
      "agent.completed",
      "agent.message_consumed",
    ]);
    expect(await store.agentTask(taskId)).toMatchObject({ status: "completed", generation: 1 });
    expect(await store.agentRuns({ taskId })).toEqual([
      expect.objectContaining({ id: runId, status: "completed" }),
    ]);
    expect(await store.agentMailbox({ messageId, limit: 1 })).toEqual([
      expect.objectContaining({ id: messageId, status: "consumed", consumedAt: 4 }),
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomically closes a task and requeues its delivering mailbox message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-mailbox-close-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_mailbox_close" as TaskId;
  const runId = "agent_mailbox_close" as AgentRunId;
  const path = "/root/task_mailbox_close" as AgentPath;
  const messageId = "event_mailbox_close_message";

  try {
    await appendRunningTask(store, { taskId, runId, path, generation: 1, time: 1 as TimestampMs });
    await store.append({
      id: messageId,
      type: "agent.message_queued",
      time: 2 as TimestampMs,
      payload: {
        taskId,
        path,
        from: "/root" as AgentPath,
        triggerTurn: true,
        message: { role: "user", content: "retry this" },
      },
    });
    expect((await store.claimAgentMailboxMessage({
      messageId,
      eventId: "event_mailbox_close_claim",
      time: 3,
    })).applied).toBe(true);

    const result = await store.closeAgentTaskCas({
      taskId,
      status: "incomplete",
      summary: "retry after lost ownership",
      error: "followup_lease_lost",
      eventId: "event_mailbox_close_task",
      agentEventId: "event_mailbox_close_agent",
      expectedGeneration: 1,
      expectedRunId: runId,
      expectedLeaseOwner: null,
      mailboxMessageId: messageId,
      mailboxEventId: "event_mailbox_close_requeued",
      mailboxDisposition: "requeue",
      mailboxError: "followup_lease_lost",
      time: 4,
    });

    expect(result.applied).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual([
      "agent.task_completed",
      "agent.completed",
      "agent.message_requeued",
    ]);
    expect(await store.agentTask(taskId)).toMatchObject({ status: "incomplete", generation: 2 });
    expect(await store.agentRuns({ taskId })).toEqual([
      expect.objectContaining({ id: runId, status: "incomplete" }),
    ]);
    expect(await store.agentMailbox({ messageId, limit: 1 })).toEqual([
      expect.objectContaining({ id: messageId, status: "queued" }),
    ]);
    expect(result.events.at(-1)).toMatchObject({
      type: "agent.message_requeued",
      payload: { messageId, taskId, error: "followup_lease_lost" },
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rolls back task, run, and mailbox completion when the mailbox event cannot insert", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-mailbox-rollback-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_mailbox_rollback" as TaskId;
  const runId = "agent_mailbox_rollback" as AgentRunId;
  const path = "/root/task_mailbox_rollback" as AgentPath;
  const messageId = "event_mailbox_rollback_message";

  try {
    await appendRunningTask(store, { taskId, runId, path, generation: 1, time: 1 as TimestampMs });
    await store.append({
      id: messageId,
      type: "agent.message_queued",
      time: 2 as TimestampMs,
      payload: {
        taskId,
        path,
        from: "/root" as AgentPath,
        triggerTurn: true,
        message: { role: "user", content: "finish atomically" },
      },
    });
    expect((await store.claimAgentMailboxMessage({
      messageId,
      eventId: "event_mailbox_rollback_claim",
      time: 3,
    })).applied).toBe(true);
    await store.append(sessionEvent(
      "event_mailbox_rollback_conflict",
      "session_mailbox_rollback" as SessionId,
      4 as TimestampMs,
    ));

    await expect(store.completeAgentTaskCas({
      taskId,
      path,
      runId,
      generation: 1,
      expectedGeneration: 1,
      expectedRunId: runId,
      expectedLeaseOwner: null,
      status: "completed",
      eventId: "event_mailbox_rollback_task",
      agentEventId: "event_mailbox_rollback_agent",
      mailboxMessageId: messageId,
      mailboxConsumeEventId: "event_mailbox_rollback_conflict",
      time: 5,
    })).rejects.toThrow();

    expect(await store.agentTask(taskId)).toMatchObject({ status: "running", generation: 1 });
    expect(await store.agentRuns({ taskId })).toEqual([
      expect.objectContaining({ id: runId, status: "running" }),
    ]);
    expect(await store.agentMailbox({ messageId, limit: 1 })).toEqual([
      expect.objectContaining({ id: messageId, status: "delivering" }),
    ]);
    expect((await store.events({ type: "agent.task_completed", limit: 10 })).map((event) => event.id)).toEqual([]);
    expect((await store.events({ type: "agent.completed", limit: 10 })).map((event) => event.id)).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("claims exactly one concurrent follow-up generation with its queued message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-run-claim-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_run_claim" as TaskId;
  const oldRunId = "agent_run_claim_old" as AgentRunId;
  const path = "/root/task_run_claim" as AgentPath;

  try {
    await appendRunningTask(store, { taskId, runId: oldRunId, path, generation: 1, time: 1 as TimestampMs });
    const initialCompletion = await store.completeAgentTaskCas({
      taskId,
      path,
      runId: oldRunId,
      generation: 1,
      expectedGeneration: 1,
      expectedRunId: oldRunId,
      expectedLeaseOwner: null,
      status: "completed",
      eventId: "event_run_claim_initial_task",
      agentEventId: "event_run_claim_initial_agent",
      time: 2,
    });
    expect(initialCompletion.applied).toBe(true);

    const contenders = ["a", "b"] as const;
    const results = await Promise.all(contenders.map((suffix) => store.beginAgentTaskRunCas({
      taskId,
      expectedGeneration: 1,
      expectedRunId: oldRunId,
      expectedLeaseOwner: null,
      runId: `agent_run_claim_${suffix}` as AgentRunId,
      generation: 2,
      leaseOwner: `followup:agent_run_claim_${suffix}`,
      leaseTtlMs: 100,
      spawnEventId: `event_run_claim_spawn_${suffix}`,
      messageEventId: `event_run_claim_message_${suffix}`,
      messageClaimEventId: `event_run_claim_message_claim_${suffix}`,
      from: "/root" as AgentPath,
      message: { role: "user", content: `follow-up ${suffix}` },
      time: 3,
    })));

    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(results.filter((result) => !result.applied)).toHaveLength(1);
    expect(results.find((result) => result.applied)?.events.map((event) => event.type)).toEqual([
      "agent.message_queued",
      "agent.message_claimed",
      "agent.spawned",
    ]);
    const task = await store.agentTask(taskId);
    expect(task).toMatchObject({
      status: "running",
      generation: 2,
      leaseOwner: expect.stringContaining("followup:agent_run_claim_"),
      leaseExpiresAt: 103,
    });
    const winnerRunId = results.find((result) => result.applied)?.events.find(
      (event) => event.type === "agent.spawned",
    )?.payload.runId;
    expect(task?.currentRunId).toBe(winnerRunId);
    expect(((await store.events({ type: "agent.message_queued", limit: 10 })) as ChiliEvent[]).filter(
      (event) => event.type === "agent.message_queued" && event.payload.taskId === taskId,
    )).toHaveLength(1);
    expect(await store.agentMailbox({ taskId, status: "delivering", limit: 10 })).toHaveLength(1);
    expect(((await store.events({ type: "agent.spawned", limit: 10 })) as ChiliEvent[]).filter(
      (event) => event.type === "agent.spawned"
        && event.payload.taskId === taskId
        && event.payload.generation === 2,
    )).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects reusing a completed agent run id for a follow-up generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-run-reuse-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_run_reuse" as TaskId;
  const runId = "agent_run_reuse" as AgentRunId;
  const path = "/root/task_run_reuse" as AgentPath;

  try {
    await appendRunningTask(store, { taskId, runId, path, generation: 1, time: 1 as TimestampMs });
    expect((await store.completeAgentTaskCas({
      taskId,
      path,
      runId,
      generation: 1,
      expectedGeneration: 1,
      expectedRunId: runId,
      expectedLeaseOwner: null,
      status: "completed",
      eventId: "event_run_reuse_completed_task",
      agentEventId: "event_run_reuse_completed_agent",
      time: 2,
    })).applied).toBe(true);

    await expect(store.beginAgentTaskRunCas({
      taskId,
      expectedGeneration: 1,
      expectedRunId: runId,
      expectedLeaseOwner: null,
      runId,
      generation: 2,
      leaseOwner: "followup:agent_run_reuse",
      leaseTtlMs: 100,
      spawnEventId: "event_run_reuse_spawn",
      time: 3,
    })).rejects.toThrow("agent task run cannot reuse existing runId agent_run_reuse");

    expect(await store.agentTask(taskId)).toMatchObject({
      status: "completed",
      generation: 1,
      currentRunId: runId,
    });
    expect(await store.agentRuns({ taskId })).toEqual([
      expect.objectContaining({ id: runId, status: "completed" }),
    ]);
    expect((await store.events({ type: "agent.spawned", limit: 100 })).map((event) => event.id))
      .not.toContain("event_run_reuse_spawn");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a source mailbox retry cannot reopen an explicitly cancelled task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-source-cancelled-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_source_cancelled" as TaskId;
  const oldRunId = "agent_source_cancelled_old" as AgentRunId;
  const path = "/root/task_source_cancelled" as AgentPath;
  const messageId = "event_source_cancelled_message";

  try {
    await appendRunningTask(store, { taskId, runId: oldRunId, path, generation: 1, time: 1 as TimestampMs });
    expect((await store.closeAgentTaskCas({
      taskId,
      status: "cancelled",
      eventId: "event_source_cancelled_task",
      agentEventId: "event_source_cancelled_agent",
      expectedGeneration: 1,
      expectedRunId: oldRunId,
      expectedLeaseOwner: null,
      time: 2,
    })).applied).toBe(true);
    await store.append({
      id: messageId,
      type: "agent.message_queued",
      time: 3 as TimestampMs,
      payload: {
        taskId,
        path,
        from: "/root" as AgentPath,
        triggerTurn: true,
        message: { role: "user", content: "stale retry" },
      },
    });
    expect((await store.claimAgentMailboxMessage({
      messageId,
      eventId: "event_source_cancelled_claim",
      time: 4,
    })).applied).toBe(true);

    const result = await store.beginAgentTaskRunCas({
      taskId,
      expectedGeneration: 2,
      expectedRunId: oldRunId,
      expectedLeaseOwner: null,
      runId: "agent_source_cancelled_retry" as AgentRunId,
      generation: 3,
      leaseOwner: "task-followup:agent_source_cancelled_retry",
      leaseTtlMs: 100,
      spawnEventId: "event_source_cancelled_spawn",
      sourceMailboxMessageId: messageId,
      time: 5,
    });

    expect(result).toMatchObject({ applied: false, events: [] });
    expect(await store.agentTask(taskId)).toMatchObject({
      status: "cancelled",
      generation: 2,
      currentRunId: oldRunId,
    });
    expect(await store.agentMailbox({ messageId, limit: 1 })).toEqual([
      expect.objectContaining({ id: messageId, status: "delivering" }),
    ]);
    expect((await store.events({ type: "agent.spawned", limit: 10 })).map((event) => event.id)).not.toContain(
      "event_source_cancelled_spawn",
    );
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
      expectedGeneration: 2,
      expectedRunId: runId,
      expectedLeaseOwner: "worker_a",
      requireActiveLease: true,
      status: "completed",
      summary: "done",
      eventId: "event_cas_task_completed",
      agentEventId: "event_cas_agent_completed",
      sessionId: "session_parent" as SessionId,
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
      expectedGeneration: 2,
      expectedRunId: runId,
      expectedLeaseOwner: "worker_a",
      requireActiveLease: true,
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

test("persists incomplete as a terminal agent task status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-incomplete-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_incomplete" as TaskId;
  const runId = "agent_incomplete" as AgentRunId;
  const path = "/root/task_incomplete" as AgentPath;

  try {
    await appendRunningTask(store, { taskId, runId, path, generation: 1, time: 1 as TimestampMs });
    const result = await store.completeAgentTaskCas({
      taskId,
      path,
      runId,
      generation: 1,
      expectedGeneration: 1,
      expectedRunId: runId,
      expectedLeaseOwner: null,
      status: "incomplete",
      summary: "I'll inspect it next.",
      error: "planning_only",
      eventId: "event_incomplete_task",
      agentEventId: "event_incomplete_agent",
      time: 20,
    });

    expect(result.applied).toBe(true);
    expect(await store.agentTask(taskId)).toMatchObject({
      status: "incomplete",
      summary: "I'll inspect it next.",
      error: "planning_only",
      completedAt: 20,
    });
    expect((await store.agentRuns({ taskId }))[0]).toMatchObject({
      status: "incomplete",
      completedAt: 20,
    });

    const lateClose = await store.closeAgentTaskCas({
      taskId,
      status: "cancelled",
      eventId: "event_late_close_incomplete",
      expectedGeneration: 1,
      expectedRunId: runId,
      expectedLeaseOwner: null,
      time: 21,
    });
    expect(lateClose.applied).toBe(false);
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
      expectedGeneration: 2,
      expectedRunId: runId,
      expectedLeaseOwner: "worker_a",
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
      expectedGeneration: 2,
      expectedRunId: runId,
      expectedLeaseOwner: "worker_a",
      requireActiveLease: true,
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
  const recipientSessionId = "session_child" as SessionId;

  try {
    await baseStore.append({
      id: "event_mailbox",
      type: "agent.message_queued",
      time: 1 as TimestampMs,
      payload: {
        taskId,
        path,
        from: parentPath,
        recipientSessionId,
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
      message: { id: "event_mailbox", recipientSessionId, status: "delivering" },
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
  const teamId = "team_alpha" as TeamId;
  const leadPath = "/root" as AgentPath;
  const reviewerPath = "/root/reviewer" as AgentPath;
  const setupTaskId = "task_setup" as TaskId;
  const reviewTaskId = "task_review" as TaskId;

  try {
    await store.appendMany([
      sessionEvent("event_session_team", sessionId, 1 as TimestampMs),
      {
        id: "event_team_created",
        type: "team.created",
        time: 2 as TimestampMs,
        sessionId,
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
        payload: {
          teamId,
          path: reviewerPath,
          name: "reviewer",
          role: "code-reviewer",
          childSessionId: "session_reviewer" as SessionId,
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
        recipientSessionId: childSessionId,
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
  const teamId = "team_claim" as TeamId;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const otherPath = "/root/other" as AgentPath;
  const setupTaskId = "task_claim_setup" as TaskId;
  const readyTaskId = "task_claim_ready" as TaskId;
  const busyTaskId = "task_claim_busy" as TaskId;
  const runningWriteTaskId = "task_claim_running_write" as TaskId;
  const conflictingWriteTaskId = "task_claim_conflicting_write" as TaskId;
  const blockedTaskId = "task_claim_blocked" as TaskId;
  const failedDependencyTaskId = "task_claim_failed_dependency" as TaskId;
  const waitsOnFailedTaskId = "task_claim_waits_on_failed" as TaskId;

  try {
    await store.appendMany([
      sessionEvent("event_team_claim_session", sessionId, 1 as TimestampMs),
      {
        id: "event_team_claim_created",
        type: "team.created",
        time: 2 as TimestampMs,
        sessionId,
        payload: { teamId, name: "claimers", leadPath },
      },
      {
        id: "event_team_claim_worker",
        type: "team.member_added",
        time: 3 as TimestampMs,
        sessionId,
        payload: { teamId, path: workerPath, name: "worker", role: "implementer" },
      },
      {
        id: "event_team_claim_other",
        type: "team.member_added",
        time: 4 as TimestampMs,
        sessionId,
        payload: { teamId, path: otherPath, name: "other", role: "implementer" },
      },
      {
        id: "event_team_claim_setup",
        type: "team.task_created",
        time: 5 as TimestampMs,
        sessionId,
        payload: { teamId, taskId: setupTaskId, title: "setup", status: "completed" },
      },
      {
        id: "event_team_claim_ready",
        type: "team.task_created",
        time: 6 as TimestampMs,
        sessionId,
        payload: { teamId, taskId: readyTaskId, title: "ready", dependsOn: [setupTaskId] },
      },
      {
        id: "event_team_claim_busy",
        type: "team.task_created",
        time: 7 as TimestampMs,
        sessionId,
        payload: { teamId, taskId: busyTaskId, title: "busy" },
      },
      {
        id: "event_team_claim_running_write",
        type: "team.task_created",
        time: 8 as TimestampMs,
        sessionId,
        payload: {
          teamId,
          taskId: runningWriteTaskId,
          title: "running write",
          status: "in_progress",
          ownerPath: leadPath,
          metadata: { writeScope: ["packages/core"] },
        },
      },
      {
        id: "event_team_claim_conflicting_write",
        type: "team.task_created",
        time: 9 as TimestampMs,
        sessionId,
        payload: {
          teamId,
          taskId: conflictingWriteTaskId,
          title: "conflicting write",
          metadata: { writeScope: ["packages/core/src"] },
        },
      },
      {
        id: "event_team_claim_blocked",
        type: "team.task_created",
        time: 10 as TimestampMs,
        sessionId,
        payload: { teamId, taskId: blockedTaskId, title: "blocked", dependsOn: ["task_missing" as TaskId] },
      },
      {
        id: "event_team_claim_failed_dependency",
        type: "team.task_created",
        time: 11 as TimestampMs,
        sessionId,
        payload: { teamId, taskId: failedDependencyTaskId, title: "failed dependency", status: "failed" },
      },
      {
        id: "event_team_claim_waits_on_failed",
        type: "team.task_created",
        time: 12 as TimestampMs,
        sessionId,
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

    const memberUnavailable = await store.claimTeamTask({
      teamId,
      taskId: busyTaskId,
      ownerPath: workerPath,
      eventId: "event_team_claim_member_unavailable",
      time: 11,
    });
    expect(memberUnavailable).toMatchObject({
      applied: false,
      reason: "member_unavailable",
      task: {
        id: busyTaskId,
        status: "pending",
      },
    });

    const writeConflict = await store.claimTeamTask({
      teamId,
      taskId: conflictingWriteTaskId,
      ownerPath: otherPath,
      eventId: "event_team_claim_write_conflict",
      time: 12,
    });
    expect(writeConflict).toMatchObject({
      applied: false,
      reason: "write_conflict",
      task: {
        id: conflictingWriteTaskId,
        status: "pending",
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

function sqliteDatabase(store: SqliteEventStore): Database {
  return (store as unknown as { db: Database }).db;
}

function pragmaNumber(db: Database, name: string): number {
  return Number(pragmaValue(db, name));
}

function pragmaString(db: Database, name: string): string {
  return String(pragmaValue(db, name));
}

function pragmaValue(db: Database, name: string): unknown {
  const row = db.query<Record<string, unknown>, []>(`pragma ${name}`).get();
  const value = row ? Object.values(row)[0] : undefined;
  if (value === undefined) throw new Error(`Missing PRAGMA value: ${name}`);
  return value;
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path).catch(() => ({ size: 0 }))).size;
}

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
  const childSessionId = "session_child" as SessionId;
  const path = input.path ?? (`/root/${input.taskId}` as AgentPath);
  const parentPath = "/root" as AgentPath;

  await store.appendMany([
    {
      id: `event_task_created_${input.taskId}`,
      type: "agent.task_created",
      time: input.time,
      sessionId: parentSessionId,
      payload: {
        taskId: input.taskId,
        path,
        parentPath,
        parentSessionId,
        childSessionId,
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
      payload: {
        runId: input.runId,
        taskId: input.taskId,
        path,
        parentPath,
        parentSessionId,
        childSessionId,
        taskName: "review",
        cwd: "/repo",
        mode: "background",
        ...(input.generation !== undefined ? { generation: input.generation } : {}),
      },
    },
  ]);
}

function sessionEvent(id: string, sessionId: SessionId, time: TimestampMs): ChiliEvent {
  return {
    id,
    type: "session.created",
    time,
    sessionId,
    payload: { sessionId, cwd: "/repo" },
  };
}
