import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import type {
  AgentPath,
  ApprovalId,
  ChiliEvent,
  EventEnvelope,
  RuntimeEvent,
  MessageId,
  PartId,
  SessionId,
  TimestampMs,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import { ObservableEventStore } from "./observable-event-store.js";
import {
  SessionAccessError,
  SessionAlreadyExistsError,
  SessionCreationClaimConflictError,
  SessionCwdConflictError,
  SessionRunClaimConflictError,
  SqliteEventStore,
  SqliteJournalModeError,
} from "./sqlite-event-store.js";
import { sqliteJournalPolicy } from "./sqlite-journal-policy.js";

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

test("configures SQLite for safe bounded journal maintenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-wal-pragmas-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));

  try {
    const db = sqliteDatabase(store);
    const sqliteVersion = String(db.query<{ version: string }, []>(
      "select sqlite_version() as version",
    ).get()?.version);
    const journalPolicy = sqliteJournalPolicy(sqliteVersion);
    expect(pragmaString(db, "journal_mode")).toBe(journalPolicy.journalMode);
    expect(pragmaNumber(db, "synchronous")).toBe(2);
    if (journalPolicy.journalMode === "wal") {
      expect(pragmaNumber(db, "wal_autocheckpoint")).toBe(256);
    }
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
    expect(db.query<{ name: string }, []>(
      `select name from sqlite_master where type = 'table' and name in (
        'agent_runs', 'agent_tasks', 'agent_mailbox', 'teams', 'team_members',
        'team_tasks', 'team_messages', 'team_message_deliveries'
      )`,
    ).all()).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close checkpoints WAL stores and leaves rollback stores without a WAL", async () => {
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
    if (pragmaString(sqliteDatabase(store), "journal_mode") === "wal") {
      expect(await fileSize(`${dbPath}-wal`)).toBeGreaterThan(0);
    } else {
      expect(await fileSize(`${dbPath}-wal`)).toBe(0);
    }
    store.close();
    expect(await fileSize(`${dbPath}-wal`)).toBe(0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("affected SQLite fails closed when an active WAL peer prevents rollback fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-wal-fail-closed-"));
  const dbPath = join(dir, "events.sqlite");
  const walPeer = new Database(dbPath, { create: true, strict: true });
  const sqliteVersion = String(walPeer.query<{ version: string }, []>(
    "select sqlite_version() as version",
  ).get()?.version);

  try {
    if (sqliteJournalPolicy(sqliteVersion).walResetSafe) return;
    walPeer.exec("pragma journal_mode = WAL");
    walPeer.exec("create table peer_lock (value text)");

    expect(() => new SqliteEventStore(dbPath, { busyTimeoutMs: 5 })).toThrow(
      SqliteJournalModeError,
    );
    expect(pragmaString(walPeer, "journal_mode")).toBe("wal");
  } finally {
    walPeer.close();
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

test("transient output validates run claims before Observable emits it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-transient-run-fence-"));
  const dbPath = join(dir, "events.sqlite");
  const staleBase = new SqliteEventStore(dbPath);
  const currentBase = new SqliteEventStore(dbPath);
  const stale = new ObservableEventStore(staleBase);
  const sessionId = "session_transient_run_fence" as SessionId;
  const claimedAt = Date.now();
  const emitted: ChiliEvent[] = [];
  const unsubscribe = stale.subscribe((event) => emitted.push(event));
  const delta: ChiliEvent = {
    id: "event_transient_stale_delta",
    type: "tool.output_delta",
    time: 2 as TimestampMs,
    sessionId,
    payload: {
      callId: "toolcall_transient_stale_delta" as ToolCallId,
      stream: "stdout",
      delta: "must not escape a stale lease",
    },
  };

  try {
    await staleBase.append(sessionEvent("event_transient_run_session", sessionId, 1 as TimestampMs));
    expect(staleBase.claimSessionRun({
      sessionId,
      claimId: "run_claim_transient_stale",
      sessionAccess: "root",
      time: claimedAt,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    expect(currentBase.claimSessionRun({
      sessionId,
      claimId: "run_claim_transient_current",
      sessionAccess: "root",
      time: claimedAt + 100,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });

    await expect(stale.append(delta)).rejects.toBeInstanceOf(SessionRunClaimConflictError);
    await expect(stale.append(delta, {
      runClaim: { sessionId, claimId: "run_claim_transient_stale" },
    })).rejects.toBeInstanceOf(SessionRunClaimConflictError);
    expect(emitted).toEqual([]);
    expect(await staleBase.events({ type: "tool.output_delta", limit: 10 })).toEqual([]);
  } finally {
    unsubscribe();
    currentBase.releaseSessionRun({ sessionId, claimId: "run_claim_transient_current" });
    staleBase.releaseSessionRun({ sessionId, claimId: "run_claim_transient_stale" });
    currentBase.close();
    staleBase.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("mixed transient batches validate every event against the creation fence", async () => {
  const store = new SqliteEventStore(":memory:");
  const observable = new ObservableEventStore(store);
  const sessionId = "session_mixed_creation_fence" as SessionId;
  const otherSessionId = "session_mixed_creation_fence_other" as SessionId;
  const claimId = "creation_claim_mixed_events";
  const emitted: ChiliEvent[] = [];
  const unsubscribe = observable.subscribe((event) => emitted.push(event));
  const now = Date.now();

  try {
    expect(store.claimSessionCreation({
      sessionId,
      claimId,
      cwd: "/repo",
      time: now,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });
    await store.append(sessionEvent("event_mixed_creation_session", sessionId, 1 as TimestampMs));

    await expect(observable.appendMany([
      {
        id: "event_mixed_creation_status",
        type: "session.status_changed",
        time: 2 as TimestampMs,
        sessionId,
        payload: { sessionId, status: "idle" },
      },
      {
        id: "event_mixed_creation_delta",
        type: "tool.output_delta",
        time: 3 as TimestampMs,
        sessionId: otherSessionId,
        payload: {
          callId: "toolcall_mixed_creation_delta" as ToolCallId,
          stream: "stderr",
          delta: "wrong session",
        },
      },
    ], { creationClaim: { sessionId, claimId } })).rejects.toBeInstanceOf(
      SessionCreationClaimConflictError,
    );

    expect(emitted).toEqual([]);
    expect(await store.events({ sessionId, type: "session.status_changed", limit: 10 })).toEqual([]);
  } finally {
    unsubscribe();
    store.releaseSessionCreation({ sessionId, claimId });
    store.close();
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
      status: "active",
      createdAt: 1,
      updatedAt: 4,
    }]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy task child sessions remain readable and reject both run access modes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-retired-messages-"));
  const dbPath = join(dir, "events.sqlite");
  let store = new SqliteEventStore(dbPath);
  const parentSessionId = "session_legacy_parent" as SessionId;
  const childSessionId = "session_legacy_child" as SessionId;
  const legacyEvent = legacyTaskEvent(parentSessionId, childSessionId);

  try {
    await store.appendMany([
      sessionEvent("event_legacy_parent", parentSessionId, 1 as TimestampMs),
      sessionEvent("event_legacy_child", childSessionId, 2 as TimestampMs),
    ]);
    insertLegacyEvent(store, legacyEvent);
    createLegacyTaskTable(sqliteDatabase(store));
    sqliteDatabase(store).query(
      `insert into agent_tasks
         (id, path, parent_session_id, child_session_id, task_name, status, created_at, updated_at)
       values (?, ?, ?, ?, 'legacy worker', 'running', 3, 3)`,
    ).run(legacyEvent.payload.taskId, legacyEvent.payload.path, parentSessionId, childSessionId);
    const messageId = "message_legacy_child" as MessageId;
    const historicalPart = {
      id: "part_legacy_child" as PartId, messageId, sessionId: childSessionId,
      type: "text" as const, text: "Saved worker response",
    };
    sqliteDatabase(store).query(`insert into messages (id, session_id, role, created_at)
      values (?, ?, 'assistant', 4)`).run(messageId, childSessionId);
    sqliteDatabase(store).query(`insert into message_parts
      (id, message_id, session_id, type, ordinal, data_json, created_at)
      values (?, ?, ?, 'text', 0, ?, 4)`).run(
      historicalPart.id, messageId, childSessionId, JSON.stringify(historicalPart),
    );

    store = reopenRetiredWorkflowFixture(store, dbPath);
    expect(await store.messages(childSessionId)).toEqual([{
      id: messageId, sessionId: childSessionId, role: "assistant", createdAt: 4 as TimestampMs,
      parts: [historicalPart],
    }]);
    expect(await store.session(parentSessionId)).not.toHaveProperty("readOnly");
    expect(await store.session(childSessionId)).toMatchObject({ id: childSessionId, readOnly: true });
    expect(await store.session(childSessionId)).not.toHaveProperty("agent");
    expect(await store.events({ sessionId: parentSessionId, type: "agent.task_created" })).toEqual([]);
    expect(sqliteDatabase(store).query<{ payload_json: string }, [string]>(
      "select payload_json from events where id = ?",
    ).get(legacyEvent.id)).toEqual({ payload_json: JSON.stringify(legacyEvent.payload) });
    for (const sessionAccess of ["root", "child"] as const) {
      expect(store.claimSessionRun({
        sessionId: childSessionId, claimId: `legacy_${sessionAccess}`, sessionAccess,
        time: Date.now(), leaseDurationMs: 60_000,
      })).toEqual({ status: "forbidden" });
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy event-only reservations cannot be created or resumed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-retired-event-only-"));
  const dbPath = join(dir, "events.sqlite");
  let store = new SqliteEventStore(dbPath);
  const parentSessionId = "session_event_only_parent" as SessionId;
  const childSessionId = "session_event_only_child" as SessionId;
  const reservedSessionId = "session_event_only_reserved" as SessionId;

  try {
    await store.appendMany([
      sessionEvent("event_only_parent", parentSessionId, 1 as TimestampMs),
      sessionEvent("event_only_child", childSessionId, 2 as TimestampMs),
    ]);
    insertLegacyEvent(store, legacyTaskEvent(parentSessionId, childSessionId));
    insertLegacyEvent(store, legacyTaskEvent(parentSessionId, reservedSessionId));
    expect(sqliteDatabase(store).query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table' and name = 'agent_tasks'",
    ).get()).toBeNull();
    store = reopenRetiredWorkflowFixture(store, dbPath);
    expect(await store.session(reservedSessionId)).toMatchObject({ id: reservedSessionId, status: "archived", readOnly: true });
    expect(await store.session(childSessionId)).toMatchObject({ readOnly: true });
    for (const sessionId of [childSessionId, reservedSessionId]) {
      for (const sessionAccess of ["root", "child"] as const) {
        expect(store.claimSessionRun({
          sessionId, claimId: `${sessionId}_${sessionAccess}`, sessionAccess,
          time: Date.now(), leaseDurationMs: 60_000,
        })).toEqual({ status: "forbidden" });
      }
    }
    expect(store.claimSessionCreation({
      sessionId: reservedSessionId, claimId: "event_only_creation", cwd: "/repo",
      time: Date.now(), leaseDurationMs: 60_000,
    })).toEqual({ status: "forbidden" });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy team workers are read-only while the original lead remains a root session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-retired-team-"));
  const dbPath = join(dir, "events.sqlite");
  let store = new SqliteEventStore(dbPath);
  const rootSessionId = "session_team_root" as SessionId;
  const workerSessionId = "session_team_worker" as SessionId;
  const teamId = "team_legacy";
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;

  try {
    await store.appendMany([
      sessionEvent("event_team_root", rootSessionId, 1 as TimestampMs),
      sessionEvent("event_team_worker", workerSessionId, 2 as TimestampMs),
    ]);
    insertLegacyEvent(store, {
      id: "event_team_created", type: "team.created", time: 3 as TimestampMs,
      sessionId: rootSessionId, payload: { teamId, name: "legacy team", leadPath },
    });
    const db = sqliteDatabase(store);
    createLegacyTeamTables(db);
    db.query(`insert into teams (id, session_id, name, lead_path, status, created_at, updated_at)
      values (?, ?, 'legacy team', ?, 'active', 3, 3)`).run(teamId, rootSessionId, leadPath);
    for (const [path, childSessionId, role] of [
      [leadPath, rootSessionId, "leader"], [workerPath, workerSessionId, "implementer"],
    ] as const) {
      insertLegacyEvent(store, {
        id: `event_member_${childSessionId}`, type: "team.member_added", time: 4 as TimestampMs,
        sessionId: rootSessionId, payload: { teamId, path, name: role, role, childSessionId },
      });
      db.query(`insert into team_members
        (team_id, path, name, role, status, child_session_id, created_at, updated_at)
        values (?, ?, ?, ?, 'running', ?, 4, 4)`).run(teamId, path, role, role, childSessionId);
    }

    const notice = {
      id: "event_team_completion_notice", type: "agent.message_queued", time: 5 as TimestampMs,
      sessionId: rootSessionId,
      payload: {
        taskId: "task_legacy_worker", path: leadPath, from: workerPath,
        recipientSessionId: rootSessionId, triggerTurn: false,
        message: { role: "user", content: "The historical worker completed" },
      },
    };
    insertLegacyEvent(store, notice);
    createLegacyMailboxTable(db);
    db.query(`insert into agent_mailbox
      (id, task_id, path, from_path, recipient_session_id, trigger_turn, status, message_json, created_at)
      values (?, ?, ?, ?, ?, 0, 'queued', ?, 5)`).run(
      notice.id, notice.payload.taskId ?? null, leadPath, workerPath, rootSessionId,
      JSON.stringify(notice.payload.message),
    );

    store = reopenRetiredWorkflowFixture(store, dbPath);
    const migratedDb = sqliteDatabase(store);
    expect(await store.session(rootSessionId)).not.toHaveProperty("readOnly");
    expect(await store.session(workerSessionId)).toMatchObject({ readOnly: true });
    expect(await store.events({ sessionId: rootSessionId, type: "team.member_added" })).toEqual([]);
    expect(migratedDb.query<{ count: number }, []>(
      "select count(*) as count from events where type = 'team.member_added'",
    ).get()).toEqual({ count: 2 });
    expect(store.claimSessionRun({
      sessionId: rootSessionId, claimId: "team_lead_root", time: Date.now(), leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });
    for (const sessionAccess of ["root", "child"] as const) {
      expect(store.claimSessionRun({
        sessionId: workerSessionId, claimId: `team_worker_${sessionAccess}`, sessionAccess,
        time: Date.now(), leaseDurationMs: 60_000,
      })).toEqual({ status: "forbidden" });
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime session admission reads durable flags without querying retired tables or events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-retired-runtime-"));
  const dbPath = join(dir, "events.sqlite");
  let store = new SqliteEventStore(dbPath);
  const rootSessionId = "session_persisted_root" as SessionId;
  const childSessionId = "session_persisted_legacy_child" as SessionId;
  try {
    await store.appendMany([
      sessionEvent("event_persisted_root", rootSessionId, 1 as TimestampMs),
      sessionEvent("event_persisted_child", childSessionId, 2 as TimestampMs),
    ]);
    insertLegacyEvent(store, legacyTaskEvent(rootSessionId, childSessionId));
    store = reopenRetiredWorkflowFixture(store, dbPath);
    const db = sqliteDatabase(store);
    const query = spyOn(db, "query");
    let queries: string[];
    try {
      expect(await store.session(rootSessionId)).not.toHaveProperty("readOnly");
      expect(await store.session(childSessionId)).toMatchObject({ readOnly: true });
      expect(await store.childSessions(rootSessionId)).toEqual([]);
      expect((await store.sessions()).find((session) => session.id === childSessionId)).toMatchObject({ readOnly: true });
      for (const sessionAccess of ["root", "child"] as const) {
        expect(store.claimSessionRun({ sessionId: childSessionId, claimId: `blocked_${sessionAccess}`,
          sessionAccess, time: Date.now(), leaseDurationMs: 60_000 })).toEqual({ status: "forbidden" });
      }
      expect(store.claimSessionCreation({ sessionId: childSessionId, claimId: "blocked_creation",
        cwd: "/repo", time: Date.now(), leaseDurationMs: 60_000 })).toEqual({ status: "forbidden" });
      expect(store.claimSessionRun({ sessionId: rootSessionId, claimId: "ordinary_root",
        time: Date.now(), leaseDurationMs: 60_000 })).toEqual({ status: "claimed" });
      store.releaseSessionRun({ sessionId: rootSessionId, claimId: "ordinary_root" });
      queries = query.mock.calls.map(([sql]) => sql);
    } finally { query.mockRestore(); }
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter((sql) => /\b(?:events|sqlite_master|agent_runs|agent_tasks|agent_mailbox|teams|team_members|team_tasks|team_messages|team_message_deliveries)\b/iu.test(sql))).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy workflow appends reject the entire batch before persistence or observation", async () => {
  const base = new SqliteEventStore(":memory:");
  const store = new ObservableEventStore(base);
  const sessionId = "session_legacy_append" as SessionId;
  const emitted: ChiliEvent[] = [];
  const unsubscribe = store.subscribe((event) => { emitted.push(event); });
  const legacyEvents = [
    legacyTaskEvent(sessionId, "session_rejected_child" as SessionId),
    { id: "event_rejected_team", type: "team.created", time: 1 as TimestampMs, sessionId,
      payload: { teamId: "team_rejected", name: "rejected", leadPath: "/root" as AgentPath } },
  ];

  try {
    for (const legacy of legacyEvents) {
      // Exercise the runtime boundary used by untyped callers and persisted input.
      const untrusted = legacy as unknown as RuntimeEvent;
      await expect(store.append(untrusted)).rejects.toThrow();
      await expect(store.appendMany([
        sessionEvent(`event_before_${legacy.id}`, sessionId, 1 as TimestampMs), untrusted,
      ])).rejects.toThrow();
    }
    expect(await store.events({ limit: 10 })).toEqual([]);
    expect(await store.sessions()).toEqual([]);
    expect(emitted).toEqual([]);
  } finally {
    unsubscribe();
    base.close();
  }
});

test("legacy message ownership rejects implicit and forged session writes atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-retired-ownership-"));
  const dbPath = join(dir, "events.sqlite");
  let store = new SqliteEventStore(dbPath);
  const rootSessionId = "session_readonly_root" as SessionId;
  const childSessionId = "session_readonly_child" as SessionId;
  const rootMessageId = "message_readonly_root" as MessageId;
  const childMessageId = "message_readonly_child" as MessageId;
  const childPartId = "part_readonly_child" as PartId;
  const newPartId = "part_readonly_forbidden" as PartId;
  const approvalId = "approval_readonly_child" as ApprovalId;

  try {
    await store.appendMany([
      sessionEvent("event_readonly_root", rootSessionId, 1 as TimestampMs),
      sessionEvent("event_readonly_child", childSessionId, 1 as TimestampMs),
      { id: "event_readonly_root_message", type: "message.created", time: 2 as TimestampMs,
        sessionId: rootSessionId, payload: { messageId: rootMessageId, role: "assistant" } },
      { id: "event_readonly_child_message", type: "message.created", time: 2 as TimestampMs,
        sessionId: childSessionId, payload: { messageId: childMessageId, role: "assistant" } },
      { id: "event_readonly_child_part", type: "message.part_added", time: 3 as TimestampMs,
        sessionId: childSessionId, payload: { messageId: childMessageId,
          part: { id: childPartId, messageId: childMessageId, sessionId: childSessionId,
            type: "text", text: "Original historical answer" } } },
      { id: "event_readonly_approval", type: "approval.requested", time: 3 as TimestampMs,
        sessionId: childSessionId, payload: { approvalId, permission: "bash.unsandboxed", patterns: ["echo historical"] } },
    ]);
    insertLegacyEvent(store, legacyTaskEvent(rootSessionId, childSessionId));
    store = reopenRetiredWorkflowFixture(store, dbPath);
    const originalRoot = await store.session(rootSessionId);
    const originalApprovals = await store.pendingApprovals(childSessionId);
    const originalEvents = await store.events({ limit: 20 });
    const originalMessages = await store.messages(childSessionId);
    const newPart = {
      id: newPartId, messageId: childMessageId, sessionId: childSessionId,
      type: "text" as const, text: "forbidden replacement",
    };
    const delta = { messageId: childMessageId, partId: childPartId, field: "text" as const, delta: "forbidden" };
    const attempts: RuntimeEvent[] = [
      { id: "event_implicit_part", type: "message.part_added", time: 4 as TimestampMs,
        payload: { messageId: childMessageId, part: newPart } },
      { id: "event_forged_envelope_part", type: "message.part_added", time: 4 as TimestampMs,
        sessionId: rootSessionId, payload: { messageId: childMessageId, part: newPart } },
      { id: "event_forged_part_session", type: "message.part_added", time: 4 as TimestampMs,
        sessionId: rootSessionId, payload: { messageId: childMessageId,
          part: { ...newPart, sessionId: rootSessionId } } },
      { id: "event_forged_part_message", type: "message.part_added", time: 4 as TimestampMs,
        sessionId: rootSessionId, payload: { messageId: rootMessageId,
          part: { ...newPart, sessionId: rootSessionId } } },
      { id: "event_reused_legacy_part", type: "message.part_added", time: 4 as TimestampMs,
        sessionId: rootSessionId, payload: { messageId: rootMessageId,
          part: { ...newPart, id: childPartId, messageId: rootMessageId, sessionId: rootSessionId } } },
      { id: "event_implicit_delta", type: "message.part_delta", time: 4 as TimestampMs, payload: delta },
      { id: "event_forged_delta_envelope", type: "message.part_delta", time: 4 as TimestampMs,
        sessionId: rootSessionId, payload: delta },
      { id: "event_forged_delta_message", type: "message.part_delta", time: 4 as TimestampMs,
        sessionId: rootSessionId, payload: { ...delta, messageId: rootMessageId } },
      { id: "event_implicit_approval", type: "approval.resolved", time: 4 as TimestampMs,
        payload: { approvalId, decision: "allow_once" } },
    ];
    for (const event of attempts) {
      await expect(store.append(event)).rejects.toBeInstanceOf(SessionAccessError);
    }
    await expect(store.appendMany([
      { id: "event_root_rename_rollback", type: "session.renamed", time: 5 as TimestampMs,
        sessionId: rootSessionId, payload: { sessionId: rootSessionId, title: "Must roll back" } },
      { id: "event_mixed_legacy_delta", type: "message.part_delta", time: 5 as TimestampMs, payload: delta },
    ])).rejects.toBeInstanceOf(SessionAccessError);
    expect(await store.events({ limit: 20 })).toEqual(originalEvents);
    expect(await store.messages(childSessionId)).toEqual(originalMessages);
    expect(await store.session(rootSessionId)).toEqual(originalRoot);
    expect(await store.pendingApprovals(childSessionId)).toEqual(originalApprovals);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("orders event replay and forward/backward cursors by insertion sequence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-seq-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const time = 1 as TimestampMs;

  try {
    await store.append(sessionEvent("z_event", "session_z" as SessionId, time));
    await store.append(sessionEvent("a_event", "session_a" as SessionId, time));

    expect((await store.events({ limit: 10 })).map((event) => event.id)).toEqual(["z_event", "a_event"]);
    expect((await store.events({ afterEventId: "z_event", limit: 10 })).map((event) => event.id)).toEqual(["a_event"]);
    expect((await store.events({ afterEventId: "a_event", limit: 10 })).map((event) => event.id)).toEqual([]);
    expect((await store.events({ beforeEventId: "a_event", limit: 10, tail: true })).map((event) => event.id)).toEqual(["z_event"]);
    expect((await store.events({ beforeEventId: "z_event", limit: 10, tail: true })).map((event) => event.id)).toEqual([]);
    await expect(store.events({ afterEventId: "z_event", beforeEventId: "a_event", limit: 10 })).rejects.toThrow(
      "cannot combine",
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("workflow filtering preserves current event limits and cursors through historical rows", async () => {
  const store = new SqliteEventStore(":memory:");
  const sessionId = "session_filtered_history" as SessionId;
  const messageId = "message_filtered_history" as MessageId;
  const partId = "part_filtered_history" as PartId;
  const currentEvents: RuntimeEvent[] = [
    sessionEvent("event_current_session", sessionId, 1 as TimestampMs),
    { id: "event_current_message", type: "message.created", time: 2 as TimestampMs, sessionId,
      payload: { messageId, role: "assistant" } },
    { id: "event_current_part", type: "message.part_added", time: 3 as TimestampMs, sessionId,
      payload: { messageId, part: { id: partId, messageId, sessionId, type: "text", text: "Hello" } } },
    { id: "event_current_delta", type: "message.part_delta", time: 4 as TimestampMs, sessionId,
      payload: { messageId, partId, field: "text", delta: "!" } },
  ];
  const historicalIds = ["event_old_prefix", "event_old_gap", "event_old_middle", "event_old_tail"];

  try {
    for (const [index, event] of currentEvents.entries()) {
      // Deliberately opaque legacy payloads must never reach the current decoder.
      insertLegacyEvent(store, {
        id: historicalIds[index]!, type: index % 2 === 0 ? "agent.task_created" : "team.created",
        time: event.time, sessionId, payload: { opaqueHistoricalData: index },
      });
      await store.append(event);
    }
    insertLegacyEvent(store, {
      id: "event_old_end", type: "agent.completed", time: 5 as TimestampMs,
      sessionId, payload: { opaqueHistoricalData: "last" },
    });

    expect(await store.events({ sessionId, limit: 2 })).toEqual(currentEvents.slice(0, 2));
    expect(await store.events({ limit: 4 })).toEqual(currentEvents);
    expect(await store.events({ sessionId, afterEventId: "event_old_middle", limit: 1 }))
      .toEqual(currentEvents.slice(2, 3));
    expect(await store.events({ sessionId, beforeEventId: "event_old_middle", limit: 2 }))
      .toEqual(currentEvents.slice(0, 2));
    expect(await store.events({ sessionId, beforeEventId: "event_old_middle", tail: true, limit: 1 }))
      .toEqual(currentEvents.slice(1, 2));
    expect(await store.events({ sessionId, tail: true, limit: 2 })).toEqual(currentEvents.slice(2));
    expect(await store.events({ sessionId, afterEventId: "event_old_end", limit: 1 })).toEqual([]);
    expect(await store.events({ sessionId, beforeEventId: "event_old_prefix", tail: true, limit: 1 })).toEqual([]);
    for (const type of ["agent.task_created", "agent.completed", "team.created"]) {
      expect(await store.events({ sessionId, type, limit: 1 })).toEqual([]);
    }
    expect(await store.events({ sessionId, type: "message.part_added", afterEventId: "event_old_middle", limit: 1 }))
      .toEqual(currentEvents.slice(2, 3));
    expect((await store.messages(sessionId))[0]?.parts).toEqual([
      { id: partId, messageId, sessionId, type: "text", text: "Hello!" },
    ]);
    expect(sqliteDatabase(store).query<{ id: string }, []>(
      "select id from events where type like 'agent.%' or type like 'team.%' order by seq",
    ).all()).toEqual([...historicalIds, "event_old_end"].map((id) => ({ id })));
  } finally {
    store.close();
  }
});

test("tail event replay returns the latest bounded window in insertion order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-tail-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_tail" as SessionId;

  try {
    await store.append(sessionEvent("event_1", sessionId, 1 as TimestampMs));
    for (const [id, time] of [["event_2", 2], ["event_3", 3], ["event_4", 4]] as const) {
      await store.append({
        id,
        type: "session.status_changed",
        time: time as TimestampMs,
        sessionId,
        payload: { sessionId, status: "idle" },
      });
    }

    expect((await store.events({ sessionId, limit: 2 })).map((event) => event.id)).toEqual(["event_1", "event_2"]);
    expect((await store.events({ sessionId, limit: 2, tail: true })).map((event) => event.id)).toEqual(["event_3", "event_4"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomically rejects live duplicate session creation while preserving historic duplicate events", async () => {
  const store = new SqliteEventStore(":memory:");
  const sessionId = "session_first_cwd_wins" as SessionId;

  try {
    await store.append({
      id: "event_first_session_create",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/authoritative/repo" },
    });
    sqliteDatabase(store).query(
      `insert into events (id, type, time, session_id, payload_json)
       values (?, 'session.created', ?, ?, ?)`,
    ).run(
      "event_historic_duplicate_session_create",
      2,
      sessionId,
      JSON.stringify({ sessionId, cwd: "/authoritative/repo" }),
    );

    await expect(store.append({
      id: "event_live_duplicate_session_create",
      type: "session.created",
      time: 3 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/authoritative/repo" },
    })).rejects.toBeInstanceOf(SessionAlreadyExistsError);

    await expect(store.append({
      id: "event_conflicting_session_recreate",
      type: "session.created",
      time: 4 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/attacker/repo" },
    })).rejects.toBeInstanceOf(SessionCwdConflictError);

    expect(await store.sessions()).toEqual([
      expect.objectContaining({
        id: sessionId,
        cwd: "/authoritative/repo",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }),
    ]);
    expect((await store.events({ sessionId, type: "session.created", limit: 10 })).map((event) => event.id)).toEqual([
      "event_first_session_create",
      "event_historic_duplicate_session_create",
    ]);
  } finally {
    store.close();
  }
});

test("session claim leases survive reopen, renew active work, and recover after expiry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-session-claim-lease-"));
  const dbPath = join(dir, "events.sqlite");
  const activeSessionId = "session_claim_lease_active" as SessionId;
  const creatingSessionId = "session_claim_lease_creating" as SessionId;
  const first = new SqliteEventStore(dbPath);

  try {
    await first.append(sessionEvent("event_claim_lease_session", activeSessionId, 1 as TimestampMs));
    expect(first.claimSessionRun({
      sessionId: activeSessionId,
      claimId: "run_claim_crashed_owner",
      sessionAccess: "root",
      time: 1_000,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    expect(first.renewSessionRun({
      sessionId: activeSessionId,
      claimId: "run_claim_crashed_owner",
      time: 1_050,
      leaseDurationMs: 100,
    })).toBe(true);
    expect(first.claimSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_crashed_owner",
      cwd: "/repo",
      time: 2_000,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    first.close();

    const beforeExpiry = new SqliteEventStore(dbPath);
    expect(beforeExpiry.claimSessionRun({
      sessionId: activeSessionId,
      claimId: "run_claim_early_contender",
      sessionAccess: "root",
      time: 1_149,
      leaseDurationMs: 100,
    })).toEqual({ status: "busy" });
    expect(beforeExpiry.claimSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_early_contender",
      cwd: "/repo",
      time: 2_099,
      leaseDurationMs: 100,
    })).toEqual({ status: "already_exists" });
    beforeExpiry.close();

    const afterExpiry = new SqliteEventStore(dbPath);
    expect(afterExpiry.claimSessionRun({
      sessionId: activeSessionId,
      claimId: "run_claim_recovered_owner",
      sessionAccess: "root",
      time: 1_150,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    expect(afterExpiry.claimSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_recovered_owner",
      cwd: "/repo",
      time: 2_100,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    afterExpiry.releaseSessionRun({
      sessionId: activeSessionId,
      claimId: "run_claim_recovered_owner",
    });
    afterExpiry.releaseSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_recovered_owner",
    });
    afterExpiry.close();
  } finally {
    first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a connection cannot replace its own stale claim before the old owner releases it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-same-connection-claim-"));
  const dbPath = join(dir, "events.sqlite");
  const stale = new SqliteEventStore(dbPath);
  const peer = new SqliteEventStore(dbPath);
  const sessionId = "session_same_connection_claim" as SessionId;
  const creatingSessionId = "session_same_connection_creation" as SessionId;
  const now = Date.now();

  try {
    await stale.append(sessionEvent("event_same_connection_claim_session", sessionId, 1 as TimestampMs));
    expect(stale.claimSessionRun({
      sessionId,
      claimId: "run_claim_same_connection_old",
      sessionAccess: "root",
      time: now - 1_000,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    expect(stale.claimSessionRun({
      sessionId,
      claimId: "run_claim_same_connection_replacement",
      sessionAccess: "root",
      time: now,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "busy" });
    expect(peer.claimSessionRun({
      sessionId,
      claimId: "run_claim_peer_replacement",
      sessionAccess: "root",
      time: now,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });
    await expect(stale.append({
      id: "event_same_connection_stale_write",
      type: "session.status_changed",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId, status: "failed" },
    })).rejects.toBeInstanceOf(SessionRunClaimConflictError);

    expect(stale.claimSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_same_connection_old",
      cwd: "/repo",
      time: now - 1_000,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    expect(stale.claimSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_same_connection_replacement",
      cwd: "/repo",
      time: now,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "already_exists" });
    expect(peer.claimSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_peer_replacement",
      cwd: "/repo",
      time: now,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });
    await expect(stale.append(sessionEvent(
      "event_same_connection_stale_create",
      creatingSessionId,
      3 as TimestampMs,
    ))).rejects.toBeInstanceOf(SessionCreationClaimConflictError);
  } finally {
    peer.releaseSessionRun({ sessionId, claimId: "run_claim_peer_replacement" });
    stale.releaseSessionRun({ sessionId, claimId: "run_claim_same_connection_old" });
    peer.releaseSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_peer_replacement",
    });
    stale.releaseSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_same_connection_old",
    });
    peer.close();
    stale.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("claim renewal and release are owned by the claiming store connection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-claim-connection-owner-"));
  const dbPath = join(dir, "events.sqlite");
  const owner = new SqliteEventStore(dbPath);
  const stranger = new SqliteEventStore(dbPath);
  const sessionId = "session_claim_connection_owner" as SessionId;
  const creatingSessionId = "session_creation_connection_owner" as SessionId;
  const now = Date.now();

  try {
    await owner.append(sessionEvent("event_claim_connection_owner", sessionId, 1 as TimestampMs));
    expect(owner.claimSessionRun({
      sessionId,
      claimId: "run_claim_connection_owner",
      sessionAccess: "root",
      time: now,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });
    expect(stranger.renewSessionRun({
      sessionId,
      claimId: "run_claim_connection_owner",
      time: now + 1,
      leaseDurationMs: 60_000,
    })).toBe(false);
    stranger.releaseSessionRun({ sessionId, claimId: "run_claim_connection_owner" });
    expect(owner.renewSessionRun({
      sessionId,
      claimId: "run_claim_connection_owner",
      time: now + 2,
      leaseDurationMs: 60_000,
    })).toBe(true);

    expect(owner.claimSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_connection_owner",
      cwd: "/repo",
      time: now,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });
    expect(stranger.renewSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_connection_owner",
      time: now + 1,
      leaseDurationMs: 60_000,
    })).toBe(false);
    stranger.releaseSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_connection_owner",
    });
    expect(owner.renewSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_connection_owner",
      time: now + 2,
      leaseDurationMs: 60_000,
    })).toBe(true);
  } finally {
    owner.releaseSessionRun({ sessionId, claimId: "run_claim_connection_owner" });
    owner.releaseSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_connection_owner",
    });
    stranger.close();
    owner.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an active creation claim fences run and archive after session.created until release", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-session-creation-fence-"));
  const dbPath = join(dir, "events.sqlite");
  const creator = new SqliteEventStore(dbPath);
  const peer = new SqliteEventStore(dbPath);
  const sessionId = "session_creation_fence" as SessionId;
  const creationClaimId = "creation_claim_initializing";
  const runClaimId = "run_claim_after_creation";
  const now = Date.now();

  try {
    expect(creator.claimSessionCreation({
      sessionId,
      claimId: creationClaimId,
      cwd: "/repo",
      time: now,
      leaseDurationMs: 120_000,
    })).toEqual({ status: "claimed" });
    await creator.append({
      id: "event_session_creation_fence_created",
      type: "session.created",
      time: now as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    });

    await expect(peer.append({
      id: "event_creation_fence_wrong_connection",
      type: "session.status_changed",
      time: now as TimestampMs,
      sessionId,
      payload: { sessionId, status: "idle" },
    }, { creationClaim: { sessionId, claimId: creationClaimId } })).rejects.toBeInstanceOf(
      SessionCreationClaimConflictError,
    );
    await expect(creator.append({
      id: "event_creation_fence_wrong_claim",
      type: "session.status_changed",
      time: now as TimestampMs,
      sessionId,
      payload: { sessionId, status: "idle" },
    }, { creationClaim: { sessionId, claimId: "creation_claim_wrong" } })).rejects.toBeInstanceOf(
      SessionCreationClaimConflictError,
    );
    const otherSessionId = "session_creation_fence_other" as SessionId;
    await expect(creator.append({
      id: "event_creation_fence_wrong_session",
      type: "session.status_changed",
      time: now as TimestampMs,
      sessionId: otherSessionId,
      payload: { sessionId: otherSessionId, status: "idle" },
    }, { creationClaim: { sessionId, claimId: creationClaimId } })).rejects.toBeInstanceOf(
      SessionCreationClaimConflictError,
    );
    await expect(creator.append({
      id: "event_creation_fence_authorized",
      type: "session.status_changed",
      time: now as TimestampMs,
      sessionId,
      payload: { sessionId, status: "idle" },
    }, { creationClaim: { sessionId, claimId: creationClaimId } })).resolves.toBeUndefined();
    expect((await creator.events({ sessionId, type: "session.status_changed", limit: 10 })).map((event) =>
      event.id
    )).toEqual(["event_creation_fence_authorized"]);

    expect(peer.claimSessionRun({
      sessionId,
      claimId: "run_claim_during_creation",
      sessionAccess: "root",
      time: now + 1,
      leaseDurationMs: 120_000,
    })).toEqual({ status: "busy" });
    await expect(peer.append({
      id: "event_archive_during_creation",
      type: "session.archived",
      time: (now + 1) as TimestampMs,
      sessionId,
      payload: { sessionId },
    })).rejects.toBeInstanceOf(SessionRunClaimConflictError);
    expect(await peer.events({ sessionId, type: "session.archived", limit: 10 })).toEqual([]);

    creator.releaseSessionCreation({ sessionId, claimId: creationClaimId });
    expect(peer.claimSessionRun({
      sessionId,
      claimId: runClaimId,
      sessionAccess: "root",
      time: now + 2,
      leaseDurationMs: 120_000,
    })).toEqual({ status: "claimed" });
    peer.releaseSessionRun({ sessionId, claimId: runClaimId });
  } finally {
    peer.close();
    creator.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an expired root creation owner fails closed when a contender discovers a child reservation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-expired-root-claim-"));
  const dbPath = join(dir, "events.sqlite");
  const staleRootStore = new SqliteEventStore(dbPath);
  let contenderStore = new SqliteEventStore(dbPath);
  const parentSessionId = "session_expired_claim_parent" as SessionId;
  const childSessionId = "session_expired_claim_child" as SessionId;

  try {
    expect(staleRootStore.claimSessionCreation({
      sessionId: childSessionId,
      claimId: "creation_claim_expired_root",
      cwd: "/repo",
      time: 1_000,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    const reservation = legacyTaskEvent(parentSessionId, childSessionId);
    insertLegacyEvent(contenderStore, reservation);
    createLegacyTaskTable(sqliteDatabase(contenderStore));
    sqliteDatabase(contenderStore).query(`insert into agent_tasks
      (id, path, parent_session_id, child_session_id, task_name, status, created_at, updated_at)
      values (?, ?, ?, ?, 'expired claim child', 'running', 1, 1)`).run(
      reservation.payload.taskId, reservation.payload.path, parentSessionId, childSessionId,
    );

    contenderStore = reopenRetiredWorkflowFixture(contenderStore, dbPath);
    expect(contenderStore.claimSessionCreation({
      sessionId: childSessionId,
      claimId: "creation_claim_reservation_contender",
      cwd: "/repo",
      time: 1_100,
      leaseDurationMs: 100,
    })).toEqual({ status: "forbidden" });
    await expect(staleRootStore.append({
      id: "event_expired_root_late_create",
      type: "session.created",
      time: 2 as TimestampMs,
      sessionId: childSessionId,
      payload: { sessionId: childSessionId, cwd: "/repo" },
    })).rejects.toBeInstanceOf(SessionAccessError);

    expect(await staleRootStore.session(childSessionId)).toMatchObject({ status: "archived", readOnly: true });
    expect(await staleRootStore.events({
      sessionId: childSessionId,
      type: "session.created",
      limit: 10,
    })).toEqual([]);
  } finally {
    contenderStore.close();
    staleRootStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale run owner cannot append after another connection takes over its lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-stale-run-owner-"));
  const dbPath = join(dir, "events.sqlite");
  const staleOwner = new SqliteEventStore(dbPath);
  const currentOwner = new SqliteEventStore(dbPath);
  const sessionId = "session_stale_run_owner" as SessionId;
  const staleTurnId = "turn_stale_run_owner" as TurnId;
  const staleMessageId = "message_stale_run_owner" as MessageId;
  const currentTurnId = "turn_current_run_owner" as TurnId;
  const currentMessageId = "message_current_run_owner" as MessageId;
  const claimedAt = Date.now();

  try {
    await staleOwner.append(sessionEvent("event_stale_run_session", sessionId, 1 as TimestampMs));
    expect(staleOwner.claimSessionRun({
      sessionId,
      claimId: "run_claim_stale_owner",
      sessionAccess: "root",
      time: claimedAt,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    expect(currentOwner.claimSessionRun({
      sessionId,
      claimId: "run_claim_current_owner",
      sessionAccess: "root",
      time: claimedAt + 100,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });

    const staleEvents: RuntimeEvent[] = [
      {
        id: "event_stale_owner_turn",
        type: "turn.started",
        time: 2 as TimestampMs,
        sessionId,
        payload: { turnId: staleTurnId },
      },
      {
        id: "event_stale_owner_message",
        type: "message.created",
        time: 3 as TimestampMs,
        sessionId,
        payload: { messageId: staleMessageId, role: "user", turnId: staleTurnId },
      },
      {
        id: "event_stale_owner_status",
        type: "session.status_changed",
        time: 4 as TimestampMs,
        sessionId,
        payload: { sessionId, status: "running", turnId: staleTurnId },
      },
    ];
    await expect(staleOwner.appendMany(staleEvents)).rejects.toBeInstanceOf(SessionRunClaimConflictError);
    expect((await staleOwner.events({ sessionId, limit: 10 })).map((event) => event.id)).toEqual([
      "event_stale_run_session",
    ]);
    expect(await staleOwner.messages(sessionId)).toEqual([]);

    staleOwner.releaseSessionRun({ sessionId, claimId: "run_claim_stale_owner" });
    expect(sqliteDatabase(currentOwner)
      .query<{ claim_id: string }, [string]>(
        `select claim_id from session_run_claims where session_id = ?`,
      )
      .get(sessionId))
      .toEqual({ claim_id: "run_claim_current_owner" });

    await currentOwner.appendMany([
      {
        id: "event_current_owner_turn",
        type: "turn.started",
        time: 5 as TimestampMs,
        sessionId,
        payload: { turnId: currentTurnId },
      },
      {
        id: "event_current_owner_message",
        type: "message.created",
        time: 6 as TimestampMs,
        sessionId,
        payload: { messageId: currentMessageId, role: "user", turnId: currentTurnId },
      },
      {
        id: "event_current_owner_status",
        type: "session.status_changed",
        time: 7 as TimestampMs,
        sessionId,
        payload: { sessionId, status: "running", turnId: currentTurnId },
      },
    ]);
    expect((await currentOwner.events({ sessionId, limit: 10 })).map((event) => event.id)).toEqual([
      "event_stale_run_session",
      "event_current_owner_turn",
      "event_current_owner_message",
      "event_current_owner_status",
    ]);
    expect(await currentOwner.messages(sessionId)).toEqual([
      expect.objectContaining({ id: currentMessageId, sessionId, turnId: currentTurnId }),
    ]);
  } finally {
    currentOwner.close();
    staleOwner.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a run owner cannot append after its own lease expires without a takeover", async () => {
  const store = new SqliteEventStore(":memory:");
  const sessionId = "session_expired_run_owner" as SessionId;

  try {
    await store.append(sessionEvent("event_expired_run_session", sessionId, 1 as TimestampMs));
    expect(store.claimSessionRun({
      sessionId,
      claimId: "run_claim_expired_owner",
      sessionAccess: "root",
      time: Date.now() - 1_000,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });

    await expect(store.append({
      id: "event_expired_owner_status",
      type: "session.status_changed",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId, status: "running" },
    })).rejects.toBeInstanceOf(SessionRunClaimConflictError);
    expect((await store.events({ sessionId, limit: 10 })).map((event) => event.id)).toEqual([
      "event_expired_run_session",
    ]);
  } finally {
    store.close();
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

test("stale recovery leaves legacy child history unchanged while recovering ordinary sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-retired-recovery-"));
  const dbPath = join(dir, "events.sqlite");
  let store = new SqliteEventStore(dbPath);
  const parentSessionId = "session_recovery_root" as SessionId;
  const childSessionId = "session_recovery_legacy" as SessionId;
  let recoveredIds = 0;

  try {
    for (const sessionId of [parentSessionId, childSessionId]) {
      await store.appendMany([
        sessionEvent(`event_${sessionId}`, sessionId, 1 as TimestampMs),
        { id: `event_turn_${sessionId}`, type: "turn.started", time: 2 as TimestampMs,
          sessionId, payload: { turnId: `turn_${sessionId}` as TurnId } },
      ]);
    }
    insertLegacyEvent(store, legacyTaskEvent(parentSessionId, childSessionId));
    store = reopenRetiredWorkflowFixture(store, dbPath);
    const originalHistory = await store.events({ sessionId: childSessionId, limit: 10 });
    await expect(store.append({
      id: "event_legacy_reactivated", type: "session.status_changed", time: 4 as TimestampMs,
      sessionId: childSessionId, payload: { sessionId: childSessionId, status: "running" },
    })).rejects.toBeInstanceOf(SessionAccessError);

    const recovered = await store.reconcileStaleTurns({
      staleBefore: 100, now: 101, createId: (prefix) => `${prefix}_recovered_${recoveredIds++}`,
    });
    expect(recovered.map((event) => event.type)).toEqual(["turn.completed", "session.status_changed"]);
    expect(recovered.every((event) => event.sessionId === parentSessionId)).toBe(true);
    expect(await store.events({ sessionId: childSessionId, limit: 10 })).toEqual(originalHistory);
    expect(await store.session(childSessionId)).toMatchObject({ readOnly: true });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale-turn recovery does not finalize a turn protected by a live run claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-live-turn-recovery-"));
  const dbPath = join(dir, "events.sqlite");
  const runner = new SqliteEventStore(dbPath);
  const recovery = new SqliteEventStore(dbPath);
  const sessionId = "session_live_turn_recovery" as SessionId;
  const turnId = "turn_live_turn_recovery" as TurnId;
  const now = Date.now();
  let recoveredIds = 0;

  try {
    await runner.appendMany([
      sessionEvent("event_live_turn_session", sessionId, 1 as TimestampMs),
      {
        id: "event_live_turn_running",
        type: "session.status_changed",
        time: 2 as TimestampMs,
        sessionId,
        payload: { sessionId, status: "running" },
      },
      {
        id: "event_live_turn_started",
        type: "turn.started",
        time: 3 as TimestampMs,
        sessionId,
        payload: { turnId },
      },
    ]);
    expect(runner.claimSessionRun({
      sessionId,
      claimId: "run_claim_live_turn_recovery",
      sessionAccess: "root",
      time: now,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });

    expect(await recovery.reconcileStaleTurns({
      staleBefore: 1_000,
      now,
      createId: (prefix) => `${prefix}_live_${recoveredIds++}`,
    })).toEqual([]);
    expect((await recovery.events({ sessionId, limit: 10 })).map((event) => event.id)).toEqual([
      "event_live_turn_session",
      "event_live_turn_running",
      "event_live_turn_started",
    ]);

    runner.releaseSessionRun({ sessionId, claimId: "run_claim_live_turn_recovery" });
    expect((await recovery.reconcileStaleTurns({
      staleBefore: 1_000,
      now: now + 1,
      createId: (prefix) => `${prefix}_released_${recoveredIds++}`,
    })).map((event) => event.type)).toEqual(["turn.completed", "session.status_changed"]);
  } finally {
    runner.releaseSessionRun({ sessionId, claimId: "run_claim_live_turn_recovery" });
    recovery.close();
    runner.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovers a completed internal turn whose latest stale session state is still transient", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-completed-turn-crash-gap-"));
  const dbPath = join(dir, "events.sqlite");
  const first = new SqliteEventStore(dbPath);
  const second = new SqliteEventStore(dbPath);
  const sessionId = "session_completed_turn_crash_gap" as SessionId;
  const turnId = "turn_completed_turn_crash_gap" as TurnId;
  let recoveredIds = 0;

  try {
    await first.appendMany([
      sessionEvent("event_completed_gap_session", sessionId, 1 as TimestampMs),
      {
        id: "event_completed_gap_running",
        type: "session.status_changed",
        time: 2 as TimestampMs,
        sessionId,
        payload: { sessionId, status: "running" },
      },
      {
        id: "event_completed_gap_turn_started",
        type: "turn.started",
        time: 3 as TimestampMs,
        sessionId,
        payload: { turnId },
      },
      {
        id: "event_completed_gap_turn_completed",
        type: "turn.completed",
        time: 4 as TimestampMs,
        sessionId,
        payload: { turnId, status: "completed" },
      },
    ]);

    const recovered = await first.reconcileStaleTurns({
      staleBefore: 100,
      now: 101,
      createId: (prefix) => `${prefix}_completed_gap_${recoveredIds++}`,
    });
    expect(recovered.map((event) => event.type)).toEqual(["session.status_changed"]);
    expect(recovered[0]?.payload).toEqual({
      sessionId,
      status: "failed",
      turnId,
      reason: "stale_turn_recovered",
    });
    expect((await first.events({ sessionId, type: "turn.completed", limit: 10 }))).toHaveLength(1);

    // A second connection rechecks the committed terminal status instead of
    // duplicating the recovery event selected by the first transaction.
    expect(await second.reconcileStaleTurns({
      staleBefore: 200,
      now: 201,
      createId: (prefix) => `${prefix}_duplicate_${recoveredIds++}`,
    })).toEqual([]);
  } finally {
    second.close();
    first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovers a stale transient session that crashed before turn.started", async () => {
  const store = new SqliteEventStore(":memory:");
  const sessionId = "session_crash_before_turn_started" as SessionId;

  try {
    await store.appendMany([
      sessionEvent("event_crash_before_turn_session", sessionId, 1 as TimestampMs),
      {
        id: "event_crash_before_turn_running",
        type: "session.status_changed",
        time: 2 as TimestampMs,
        sessionId,
        payload: { sessionId, status: "running", reason: "prompt_submitted" },
      },
    ]);

    const recovered = await store.reconcileStaleTurns({
      staleBefore: 100,
      now: 101,
      createId: (prefix) => `${prefix}_before_turn`,
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      type: "session.status_changed",
      sessionId,
      payload: {
        sessionId,
        status: "failed",
        reason: "stale_turn_recovered",
      },
    });
    expect(recovered[0]?.payload).not.toHaveProperty("turnId");
    expect(await store.reconcileStaleTurns({
      staleBefore: 200,
      now: 201,
      createId: (prefix) => `${prefix}_again`,
    })).toEqual([]);
  } finally {
    store.close();
  }
});

test("stale recovery preserves later idle and archived session outcomes", async () => {
  const store = new SqliteEventStore(":memory:");
  const idleSessionId = "session_recovery_later_idle" as SessionId;
  const archivedSessionId = "session_recovery_later_archived" as SessionId;
  const idleTurnId = "turn_recovery_later_idle" as TurnId;
  const archivedTurnId = "turn_recovery_later_archived" as TurnId;

  try {
    await store.appendMany([
      sessionEvent("event_recovery_idle_session", idleSessionId, 1 as TimestampMs),
      {
        id: "event_recovery_idle_running",
        type: "session.status_changed",
        time: 2 as TimestampMs,
        sessionId: idleSessionId,
        payload: { sessionId: idleSessionId, status: "running" },
      },
      {
        id: "event_recovery_idle_turn",
        type: "turn.started",
        time: 3 as TimestampMs,
        sessionId: idleSessionId,
        payload: { turnId: idleTurnId },
      },
      {
        id: "event_recovery_idle_completion",
        type: "turn.completed",
        time: 4 as TimestampMs,
        sessionId: idleSessionId,
        payload: { turnId: idleTurnId, status: "completed" },
      },
      {
        id: "event_recovery_idle_terminal",
        type: "session.status_changed",
        time: 5 as TimestampMs,
        sessionId: idleSessionId,
        payload: { sessionId: idleSessionId, status: "idle", turnId: idleTurnId },
      },
      sessionEvent("event_recovery_archived_session", archivedSessionId, 6 as TimestampMs),
      {
        id: "event_recovery_archived_running",
        type: "session.status_changed",
        time: 7 as TimestampMs,
        sessionId: archivedSessionId,
        payload: { sessionId: archivedSessionId, status: "running" },
      },
      {
        id: "event_recovery_archived_turn",
        type: "turn.started",
        time: 8 as TimestampMs,
        sessionId: archivedSessionId,
        payload: { turnId: archivedTurnId },
      },
      {
        id: "event_recovery_archived_terminal",
        type: "session.archived",
        time: 9 as TimestampMs,
        sessionId: archivedSessionId,
        payload: { sessionId: archivedSessionId },
      },
    ]);

    expect(await store.reconcileStaleTurns({
      staleBefore: 100,
      now: 101,
      createId: (prefix) => `${prefix}_must_not_write`,
    })).toEqual([]);
    expect((await store.events({ type: "session.status_changed", limit: 20 })).map((event) => event.id)).toEqual([
      "event_recovery_idle_running",
      "event_recovery_idle_terminal",
      "event_recovery_archived_running",
    ]);
  } finally {
    store.close();
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
  const invalidEvents: Array<{ event: RuntimeEvent; error: string }> = [
    {
      event: {
        id: "event_identity_session_missing_envelope",
        type: "session.created",
        time,
        payload: { sessionId, cwd: "/repo" },
      } as unknown as RuntimeEvent,
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
      } as unknown as RuntimeEvent,
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
      } as unknown as RuntimeEvent,
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
  createLegacyTaskTable(legacyDb);
  createLegacyTeamTables(legacyDb);
  createLegacyMailboxTable(legacyDb);
  legacyDb.exec(`
    create table agent_runs (
      id text primary key, session_id text, parent_session_id text, child_session_id text
    );
    create table team_message_deliveries (
      mailbox_message_id text primary key, child_session_id text
    );
  `);
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
          parentThreadId: "thread_legacy_parent",
          parentSessionId: "session_legacy_parent",
          childThreadId: "thread_legacy_child",
          childSessionId: "session_legacy_child",
          recipientThreadId: "thread_legacy_recipient",
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
          parentThreadId: "thread_legacy_parent",
          childThreadId: "thread_legacy_child",
          recipientThreadId: "thread_legacy_recipient",
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
    expect(retiredWorkflowTables(sqliteDatabase(store))).toEqual([]);
    expect(await store.session("session_legacy_recipient" as SessionId)).toMatchObject({ readOnly: true, status: "archived" });
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
    expect(retiredWorkflowTables(sqliteDatabase(store))).toEqual([]);
    expect(await store.session("session_legacy_recipient" as SessionId)).toMatchObject({ readOnly: true, status: "archived" });
    assertCanonicalSchema(sqliteDatabase(store));
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
  const taskId = "task_missing_replacement";
  let store = new SqliteEventStore(dbPath);
  store.close();

  const legacyDb = new Database(dbPath, { create: true, strict: true });
  createLegacyTaskTable(legacyDb);
  legacyDb.exec(`
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
    expect(retiredWorkflowTables(sqliteDatabase(store))).toEqual([]);
    expect(await store.session(sessionId)).toMatchObject({ readOnly: true });
    for (const sessionAccess of ["root", "child"] as const) {
      expect(store.claimSessionRun({
        sessionId, claimId: `migrated_${sessionAccess}`, sessionAccess,
        time: Date.now(), leaseDurationMs: 60_000,
      })).toEqual({ status: "forbidden" });
    }
    const migratedDb = sqliteDatabase(store);
    expect(migratedDb.query<{ name: string }, []>("pragma table_info(agent_tasks)").all()).toEqual([]);
    expect(migratedDb.query<{ name: string }, []>(
      "select name from schema_migrations where name = 'session_only_schema_v1'",
    ).get()).toEqual({ name: "session_only_schema_v1" });
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
    const deltas: RuntimeEvent[] = Array.from({ length: 128 }, (_, index) => ({
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

function sessionEvent(id: string, sessionId: SessionId, time: TimestampMs): RuntimeEvent {
  return {
    id,
    type: "session.created",
    time,
    sessionId,
    payload: { sessionId, cwd: "/repo" },
  };
}

function insertLegacyEvent(store: SqliteEventStore, event: EventEnvelope<string, Record<string, unknown>>): void {
  sqliteDatabase(store).query(
    "insert into events (id, type, time, session_id, payload_json) values (?, ?, ?, ?, ?)",
  ).run(event.id, event.type, event.time, event.sessionId ?? null, JSON.stringify(event.payload));
}

function legacyTaskEvent(parentSessionId: SessionId, childSessionId: SessionId) {
  return {
    id: `event_task_${childSessionId}`, type: "agent.task_created", time: 3 as TimestampMs,
    sessionId: parentSessionId,
    payload: {
      taskId: `task_${childSessionId}`, path: `/root/${childSessionId}` as AgentPath,
      parentPath: "/root" as AgentPath, parentSessionId, childSessionId,
      taskName: "legacy worker", cwd: "/repo", prompt: "inspect the repository",
    },
  };
}

function createLegacyTaskTable(db: Database): void {
  db.exec(`create table agent_tasks (
    id text primary key, path text not null, parent_session_id text, child_session_id text,
    task_name text not null, status text not null, created_at integer not null, updated_at integer not null
  )`);
}

function createLegacyTeamTables(db: Database): void {
  db.exec(`
    create table teams (
      id text primary key, session_id text, name text not null, lead_path text not null,
      status text not null, created_at integer not null, updated_at integer not null
    );
    create table team_members (
      team_id text not null, path text not null, name text not null, role text not null,
      status text not null, child_session_id text, created_at integer not null, updated_at integer not null,
      primary key (team_id, path)
    );
  `);
}

function createLegacyMailboxTable(db: Database): void {
  db.exec(`create table agent_mailbox (
    id text primary key, task_id text, path text, from_path text, recipient_session_id text,
    trigger_turn integer, status text, message_json text, created_at integer
  )`);
}

const retiredTables = [
  "team_message_deliveries", "team_messages", "team_tasks", "team_members",
  "teams", "agent_mailbox", "agent_runs", "agent_tasks",
] as const;

function retiredWorkflowTables(db: Database): string[] {
  return db.query<{ name: string }, []>(`select name from sqlite_master
    where type = 'table' and name in (${retiredTables.map((table) => `'${table}'`).join(",")}) order by name`)
    .all().map((row) => row.name);
}

function reopenRetiredWorkflowFixture(store: SqliteEventStore, path: string): SqliteEventStore {
  store.close();
  const db = new Database(path);
  try { db.query("delete from schema_migrations where name = 'retired_workflows_v1'").run(); }
  finally { db.close(); }
  return new SqliteEventStore(path);
}

function createAllRetiredWorkflowTables(db: Database, populated = false): void {
  createLegacyTaskTable(db);
  createLegacyTeamTables(db);
  createLegacyMailboxTable(db);
  db.exec(`
    create table agent_runs (id text primary key, session_id text, parent_session_id text, child_session_id text);
    create table team_tasks (id text primary key, team_id text);
    create table team_messages (id text primary key, team_id text);
    create table team_message_deliveries (mailbox_message_id text primary key, child_session_id text);
  `);
  if (!populated) return;
  db.exec(`
    insert into agent_tasks values ('old_task','/root/worker','retired_root','retired_worker','worker','completed',1,1);
    insert into agent_runs values ('old_run','retired_root','retired_root','retired_reserved');
    insert into teams values ('old_team','retired_root','old team','/root','active',1,1);
    insert into team_members values ('old_team','/root/worker','worker','implementer','idle','retired_worker',1,1);
    insert into agent_mailbox values ('old_mail','old_task','/root/worker','/root','retired_worker',1,'queued','{}',1);
    insert into team_tasks values ('old_team_task','old_team');
    insert into team_messages values ('old_team_message','old_team');
    insert into team_message_deliveries values ('old_delivery','retired_worker');
  `);
}

for (const populated of [false, true]) test(`startup migration removes all ${populated ? "populated" : "empty"} retired tables and is idempotent`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-retired-tables-"));
  const dbPath = join(dir, "events.sqlite");
  let store = new SqliteEventStore(dbPath);
  const rootId = "retired_root" as SessionId;
  const workerId = "retired_worker" as SessionId;
  const messageId = "retired_message" as MessageId;
  try {
    await store.appendMany([
      sessionEvent("retired_root_created", rootId, 1 as TimestampMs),
      sessionEvent("retired_worker_created", workerId, 2 as TimestampMs),
      { id: "retired_message_created", type: "message.created", sessionId: workerId, time: 3 as TimestampMs,
        payload: { messageId, role: "assistant" } },
      { id: "retired_message_text", type: "message.part_added", sessionId: workerId, time: 4 as TimestampMs,
        payload: { messageId, part: { id: "retired_part" as PartId, messageId, sessionId: workerId, type: "text", text: "Saved ordinary response" } } },
    ]);
    const messages = await store.messages(workerId);
    store.close();
    const legacy = new Database(dbPath);
    try {
      // Even a database with the marker must clean up subsequently discovered old tables.
      expect(legacy.query<{ name: string }, []>("select name from schema_migrations where name = 'retired_workflows_v1'").get())
        .toEqual({ name: "retired_workflows_v1" });
      createAllRetiredWorkflowTables(legacy, populated);
      for (const table of retiredTables) {
        expect(legacy.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count).toBe(populated ? 1 : 0);
      }
    } finally { legacy.close(); }
    store = new SqliteEventStore(dbPath);
    expect(retiredWorkflowTables(sqliteDatabase(store))).toEqual([]);
    expect(await store.messages(workerId)).toEqual(messages);
    expect(await store.session(rootId)).not.toHaveProperty("readOnly");
    if (populated) {
      expect(await store.session(workerId)).toMatchObject({ readOnly: true });
      const reservedId = "retired_reserved" as SessionId;
      expect(await store.session(reservedId)).toMatchObject({ id: reservedId, readOnly: true, status: "archived" });
      expect(await store.session(reservedId)).not.toHaveProperty("agent");
      expect(store.claimSessionCreation({ sessionId: reservedId, claimId: "reserved_creation", cwd: "/repo",
        time: Date.now(), leaseDurationMs: 60_000 })).toEqual({ status: "forbidden" });
      for (const sessionAccess of ["root", "child"] as const) {
        expect(store.claimSessionRun({ sessionId: reservedId, claimId: `reserved_${sessionAccess}`, sessionAccess,
          time: Date.now(), leaseDurationMs: 60_000 })).toEqual({ status: "forbidden" });
      }
    } else expect(await store.session(workerId)).not.toHaveProperty("readOnly");
    const sessions = await store.sessions();
    store.close();
    store = new SqliteEventStore(dbPath);
    expect(retiredWorkflowTables(sqliteDatabase(store))).toEqual([]);
    expect(await store.sessions()).toEqual(sessions);
    expect(await store.messages(workerId)).toEqual(messages);
    expect(sqliteDatabase(store).query<{ count: number }, []>("select count(*) as count from schema_migrations where name = 'retired_workflows_v1'").get()?.count).toBe(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed second retired-table drop rolls back every table, read-only flag and migration marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-retired-rollback-"));
  const dbPath = join(dir, "events.sqlite");
  const initial = new SqliteEventStore(dbPath);
  await initial.appendMany([
    sessionEvent("rollback_root", "retired_root" as SessionId, 1 as TimestampMs),
    sessionEvent("rollback_worker", "retired_worker" as SessionId, 2 as TimestampMs),
  ]);
  initial.close();
  const legacy = new Database(dbPath);
  try {
    createAllRetiredWorkflowTables(legacy, true);
    legacy.query("delete from schema_migrations where name = 'retired_workflows_v1'").run();
  } finally { legacy.close(); }
  const originalExec = Database.prototype.exec;
  let drops = 0;
  const exec = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, ...args: Parameters<typeof originalExec>) {
    if (/^\s*drop table\b/iu.test(args[0]) && retiredTables.some((table) => args[0].includes(table))) {
      drops++;
      if (drops === 2) throw new Error("injected retired-table drop failure");
    }
    return originalExec.apply(this, args);
  });
  try {
    expect(() => new SqliteEventStore(dbPath)).toThrow("injected retired-table drop failure");
    expect(drops).toBe(2);
  } finally { exec.mockRestore(); }
  try {
    const audit = new Database(dbPath);
    try {
      expect(retiredWorkflowTables(audit)).toEqual([...retiredTables].sort());
      for (const table of retiredTables) expect(audit.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count).toBe(1);
      expect(audit.query<{ read_only: number }, []>("select read_only from sessions where id = 'retired_worker'").get()?.read_only).toBe(0);
      expect(audit.query("select id from sessions where id = 'retired_reserved'").get()).toBeNull();
      expect(audit.query("select name from schema_migrations where name = 'retired_workflows_v1'").get()).toBeNull();
    } finally { audit.close(); }
    const recovered = new SqliteEventStore(dbPath);
    try {
      expect(retiredWorkflowTables(sqliteDatabase(recovered))).toEqual([]);
      expect(await recovered.session("retired_worker" as SessionId)).toMatchObject({ readOnly: true });
    } finally { recovered.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("startup migration reserves both mapped historical thread aliases and their canonical sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-retired-aliases-"));
  const dbPath = join(dir, "events.sqlite");
  let store = new SqliteEventStore(dbPath);
  const rootId = "alias_root" as SessionId;
  await store.append(sessionEvent("alias_root_created", rootId, 1 as TimestampMs));
  store.close();
  const aliases = [
    ["thread_old_child", "session_old_child"],
    ["thread_old_recipient", "session_old_recipient"],
  ] as const;
  const legacy = new Database(dbPath);
  try {
    legacy.exec("create table legacy_session_identities (legacy_id text primary key, session_id text not null)");
    for (const [alias, sessionId] of aliases) {
      legacy.query("insert into legacy_session_identities values (?, ?)").run(alias, sessionId);
    }
    const insert = legacy.query("insert into events (id, type, time, session_id, payload_json) values (?, ?, 2, ?, ?)");
    insert.run("alias_child_event", "agent.task_created", rootId,
      JSON.stringify({ childThreadId: aliases[0][0], parentSessionId: rootId, path: "/root/worker", cwd: "/repo" }));
    insert.run("alias_recipient_event", "agent.message_queued", rootId,
      JSON.stringify({ recipientThreadId: aliases[1][0], path: "/root/recipient", from: "/root", triggerTurn: true }));
    legacy.query("delete from schema_migrations where name = 'retired_workflows_v1'").run();
  } finally { legacy.close(); }
  try {
    store = new SqliteEventStore(dbPath);
    for (const identity of aliases.flat()) {
      const sessionId = identity as SessionId;
      expect(await store.session(sessionId)).toMatchObject({ id: identity, status: "archived", readOnly: true });
      expect(await store.session(sessionId)).not.toHaveProperty("agent");
      expect(store.claimSessionCreation({ sessionId, claimId: `create_${identity}`, cwd: "/repo",
        time: Date.now(), leaseDurationMs: 60_000 })).toEqual({ status: "forbidden" });
      for (const sessionAccess of ["root", "child"] as const) {
        expect(store.claimSessionRun({ sessionId, claimId: `run_${identity}_${sessionAccess}`, sessionAccess,
          time: Date.now(), leaseDurationMs: 60_000 })).toEqual({ status: "forbidden" });
      }
    }
    expect(await store.session(rootId)).not.toHaveProperty("readOnly");
    store.close();
    store = new SqliteEventStore(dbPath);
    for (const identity of aliases.flat()) {
      expect(await store.session(identity as SessionId)).toMatchObject({ readOnly: true, status: "archived" });
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup migration tolerates opaque and invalid historical workflow JSON without changing the raw events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-retired-opaque-"));
  const dbPath = join(dir, "events.sqlite");
  let store = new SqliteEventStore(dbPath);
  const rootId = "opaque_root" as SessionId;
  const created = sessionEvent("opaque_root_created", rootId, 1 as TimestampMs);
  await store.append(created);
  store.close();
  const rawPayloads = ["{not valid JSON", '"opaque historical payload"', "null"];
  const legacy = new Database(dbPath);
  try {
    for (const [index, payload] of rawPayloads.entries()) {
      legacy.query("insert into events (id, type, time, session_id, payload_json) values (?, 'agent.task_created', 2, ?, ?)")
        .run(`opaque_${index}`, rootId, payload);
    }
    // Exercise both the pre-Session payload scan and retired-workflow startup migration.
    legacy.query("delete from schema_migrations where name in ('session_only_schema_v1', 'retired_workflows_v1')").run();
  } finally { legacy.close(); }
  try {
    for (let reopen = 0; reopen < 2; reopen++) {
      store = new SqliteEventStore(dbPath);
      expect(await store.events({ sessionId: rootId, limit: 20 })).toEqual([created]);
      expect(await store.session(rootId)).not.toHaveProperty("readOnly");
      expect(sqliteDatabase(store).query<{ payload_json: string }, []>(
        "select payload_json from events where type = 'agent.task_created' order by seq",
      ).all().map((row) => row.payload_json)).toEqual(rawPayloads);
      store.close();
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
