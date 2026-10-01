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
import {
  SessionAlreadyExistsError,
  SessionCreationClaimConflictError,
  SessionCwdConflictError,
  SessionRunClaimConflictError,
  SqliteEventStore,
  SqliteJournalModeError,
  TeamTaskAlreadyExistsError,
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
      allowSubagentSessions: false,
      time: claimedAt,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    expect(currentBase.claimSessionRun({
      sessionId,
      claimId: "run_claim_transient_current",
      allowSubagentSessions: false,
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
      owner: "root",
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
      allowSubagentSessions: false,
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
      owner: "root",
      time: 2_000,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    first.close();

    const beforeExpiry = new SqliteEventStore(dbPath);
    expect(beforeExpiry.claimSessionRun({
      sessionId: activeSessionId,
      claimId: "run_claim_early_contender",
      allowSubagentSessions: false,
      time: 1_149,
      leaseDurationMs: 100,
    })).toEqual({ status: "busy" });
    expect(beforeExpiry.claimSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_early_contender",
      cwd: "/repo",
      owner: "root",
      time: 2_099,
      leaseDurationMs: 100,
    })).toEqual({ status: "already_exists" });
    beforeExpiry.close();

    const afterExpiry = new SqliteEventStore(dbPath);
    expect(afterExpiry.claimSessionRun({
      sessionId: activeSessionId,
      claimId: "run_claim_recovered_owner",
      allowSubagentSessions: false,
      time: 1_150,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    expect(afterExpiry.claimSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_recovered_owner",
      cwd: "/repo",
      owner: "root",
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
      allowSubagentSessions: false,
      time: now - 1_000,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    expect(stale.claimSessionRun({
      sessionId,
      claimId: "run_claim_same_connection_replacement",
      allowSubagentSessions: false,
      time: now,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "busy" });
    expect(peer.claimSessionRun({
      sessionId,
      claimId: "run_claim_peer_replacement",
      allowSubagentSessions: false,
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
      owner: "root",
      time: now - 1_000,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    expect(stale.claimSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_same_connection_replacement",
      cwd: "/repo",
      owner: "root",
      time: now,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "already_exists" });
    expect(peer.claimSessionCreation({
      sessionId: creatingSessionId,
      claimId: "creation_claim_peer_replacement",
      cwd: "/repo",
      owner: "root",
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
      allowSubagentSessions: false,
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
      owner: "root",
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
      owner: "root",
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
      allowSubagentSessions: false,
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
      allowSubagentSessions: false,
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
  const contenderStore = new SqliteEventStore(dbPath);
  const parentSessionId = "session_expired_claim_parent" as SessionId;
  const childSessionId = "session_expired_claim_child" as SessionId;

  try {
    expect(staleRootStore.claimSessionCreation({
      sessionId: childSessionId,
      claimId: "creation_claim_expired_root",
      cwd: "/repo",
      owner: "root",
      time: 1_000,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    await contenderStore.append({
      id: "event_expired_claim_child_reserved",
      type: "agent.task_created",
      time: 1 as TimestampMs,
      sessionId: parentSessionId,
      payload: {
        taskId: "task_expired_claim_child" as TaskId,
        path: "/root/expired-claim-child" as AgentPath,
        parentPath: "/root" as AgentPath,
        parentSessionId,
        childSessionId,
        taskName: "expired claim child",
        cwd: "/repo",
        prompt: "own the reserved child session",
        mode: "background",
      },
    });

    expect(contenderStore.claimSessionCreation({
      sessionId: childSessionId,
      claimId: "creation_claim_reservation_contender",
      cwd: "/repo",
      owner: "root",
      time: 1_100,
      leaseDurationMs: 100,
    })).toEqual({ status: "subagent" });
    await expect(staleRootStore.append({
      id: "event_expired_root_late_create",
      type: "session.created",
      time: 2 as TimestampMs,
      sessionId: childSessionId,
      payload: { sessionId: childSessionId, cwd: "/repo" },
    })).rejects.toBeInstanceOf(SessionCreationClaimConflictError);

    expect(await staleRootStore.sessions()).toEqual([]);
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
      allowSubagentSessions: false,
      time: claimedAt,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    expect(currentOwner.claimSessionRun({
      sessionId,
      claimId: "run_claim_current_owner",
      allowSubagentSessions: false,
      time: claimedAt + 100,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });

    const staleEvents: ChiliEvent[] = [
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
      allowSubagentSessions: false,
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

test("run-claim fences allow only durably bound descendant actor provenance", async () => {
  const store = new SqliteEventStore(":memory:");
  const ownerSessionId = "session_fenced_team_owner" as SessionId;
  const actorSessionId = "session_fenced_team_actor" as SessionId;
  const siblingSessionId = "session_fenced_team_sibling" as SessionId;
  const unrelatedSessionId = "session_fenced_team_unrelated" as SessionId;
  const teamId = "team_fenced_actor" as TeamId;
  const otherTeamId = "team_fenced_other" as TeamId;
  const actorPath = "/root/actor" as AgentPath;
  const siblingPath = "/root/sibling" as AgentPath;
  const claimId = "run_claim_fenced_team_owner";
  const actorClaimId = "run_claim_fenced_team_actor";

  try {
    await store.append(sessionEvent("event_fenced_owner_session", ownerSessionId, 1 as TimestampMs));
    await store.appendMany([
      {
        id: "event_fenced_actor_task",
        type: "agent.task_created",
        time: 2 as TimestampMs,
        sessionId: ownerSessionId,
        payload: {
          taskId: "task_fenced_actor" as TaskId,
          path: actorPath,
          parentPath: "/root" as AgentPath,
          parentSessionId: ownerSessionId,
          childSessionId: actorSessionId,
          taskName: "actor",
          cwd: "/repo",
          prompt: "act",
        },
      },
      {
        id: "event_fenced_sibling_task",
        type: "agent.task_created",
        time: 3 as TimestampMs,
        sessionId: ownerSessionId,
        payload: {
          taskId: "task_fenced_sibling" as TaskId,
          path: siblingPath,
          parentPath: "/root" as AgentPath,
          parentSessionId: ownerSessionId,
          childSessionId: siblingSessionId,
          taskName: "sibling",
          cwd: "/repo",
          prompt: "act",
        },
      },
      sessionEvent("event_fenced_actor_session", actorSessionId, 4 as TimestampMs),
      sessionEvent("event_fenced_sibling_session", siblingSessionId, 5 as TimestampMs),
      sessionEvent("event_fenced_unrelated_session", unrelatedSessionId, 6 as TimestampMs),
      {
        id: "event_fenced_team",
        type: "team.created",
        time: 7 as TimestampMs,
        sessionId: ownerSessionId,
        payload: { teamId, name: "fenced", leadPath: "/root" as AgentPath },
      },
      {
        id: "event_fenced_team_lead",
        type: "team.member_added",
        time: 8 as TimestampMs,
        sessionId: ownerSessionId,
        payload: {
          teamId,
          path: "/root" as AgentPath,
          name: "lead",
          role: "lead",
          childSessionId: ownerSessionId,
        },
      },
      {
        id: "event_fenced_team_actor",
        type: "team.member_added",
        time: 9 as TimestampMs,
        sessionId: ownerSessionId,
        payload: {
          teamId,
          path: actorPath,
          name: "actor",
          role: "worker",
          childSessionId: actorSessionId,
        },
      },
      {
        id: "event_fenced_team_sibling",
        type: "team.member_added",
        time: 10 as TimestampMs,
        sessionId: ownerSessionId,
        payload: {
          teamId,
          path: siblingPath,
          name: "sibling",
          role: "worker",
          childSessionId: siblingSessionId,
        },
      },
      {
        id: "event_fenced_other_team",
        type: "team.created",
        time: 11 as TimestampMs,
        sessionId: ownerSessionId,
        payload: { teamId: otherTeamId, name: "other", leadPath: "/root" as AgentPath },
      },
    ]);
    expect(store.claimSessionRun({
      sessionId: ownerSessionId,
      claimId,
      allowSubagentSessions: false,
      time: Date.now(),
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });

    await expect(store.append({
      id: "event_fenced_actor_write",
      type: "team.member_status_changed",
      time: 12 as TimestampMs,
      sessionId: actorSessionId,
      payload: { teamId, path: actorPath, status: "running" },
    }, { runClaim: { sessionId: ownerSessionId, claimId } })).resolves.toBeUndefined();

    await expect(store.append({
      id: "event_fenced_ordinary_cross_session",
      type: "session.status_changed",
      time: 13 as TimestampMs,
      sessionId: actorSessionId,
      payload: { sessionId: actorSessionId, status: "idle" },
    }, { runClaim: { sessionId: ownerSessionId, claimId } })).rejects.toBeInstanceOf(
      SessionRunClaimConflictError,
    );
    await expect(store.append({
      id: "event_fenced_missing_session",
      type: "tool.output_delta",
      time: 14 as TimestampMs,
      payload: {
        callId: "toolcall_fenced_missing_session" as ToolCallId,
        stream: "stdout",
        delta: "forged",
      },
    }, { runClaim: { sessionId: ownerSessionId, claimId } })).rejects.toBeInstanceOf(
      SessionRunClaimConflictError,
    );
    await expect(store.append({
      id: "event_fenced_fake_path",
      type: "team.member_status_changed",
      time: 15 as TimestampMs,
      sessionId: actorSessionId,
      payload: { teamId, path: "/root/forged" as AgentPath, status: "idle" },
    }, { runClaim: { sessionId: ownerSessionId, claimId } })).rejects.toBeInstanceOf(
      SessionRunClaimConflictError,
    );
    await expect(store.append({
      id: "event_fenced_cross_team",
      type: "team.member_status_changed",
      time: 16 as TimestampMs,
      sessionId: actorSessionId,
      payload: { teamId: otherTeamId, path: actorPath, status: "idle" },
    }, { runClaim: { sessionId: ownerSessionId, claimId } })).rejects.toBeInstanceOf(
      SessionRunClaimConflictError,
    );
    await expect(store.append({
      id: "event_fenced_unrelated_actor",
      type: "team.member_status_changed",
      time: 17 as TimestampMs,
      sessionId: unrelatedSessionId,
      payload: { teamId, path: actorPath, status: "idle" },
    }, { runClaim: { sessionId: ownerSessionId, claimId } })).rejects.toBeInstanceOf(
      SessionRunClaimConflictError,
    );

    expect(store.claimSessionRun({
      sessionId: actorSessionId,
      claimId: actorClaimId,
      allowSubagentSessions: true,
      time: Date.now(),
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });
    await expect(store.append({
      id: "event_fenced_reverse_actor",
      type: "team.member_status_changed",
      time: 18 as TimestampMs,
      sessionId: ownerSessionId,
      payload: { teamId, path: "/root" as AgentPath, status: "idle" },
    }, { runClaim: { sessionId: actorSessionId, claimId: actorClaimId } })).rejects.toBeInstanceOf(
      SessionRunClaimConflictError,
    );
    await expect(store.append({
      id: "event_fenced_sibling_actor",
      type: "team.member_status_changed",
      time: 19 as TimestampMs,
      sessionId: siblingSessionId,
      payload: { teamId, path: siblingPath, status: "idle" },
    }, { runClaim: { sessionId: actorSessionId, claimId: actorClaimId } })).rejects.toBeInstanceOf(
      SessionRunClaimConflictError,
    );

    await store.append({
      id: "event_fenced_actor_closed",
      type: "team.member_status_changed",
      time: 20 as TimestampMs,
      sessionId: ownerSessionId,
      payload: { teamId, path: actorPath, status: "closed" },
    }, { runClaim: { sessionId: ownerSessionId, claimId } });
    await expect(store.append({
      id: "event_fenced_closed_actor_write",
      type: "team.member_status_changed",
      time: 21 as TimestampMs,
      sessionId: actorSessionId,
      payload: { teamId, path: actorPath, status: "idle" },
    }, { runClaim: { sessionId: ownerSessionId, claimId } })).rejects.toBeInstanceOf(
      SessionRunClaimConflictError,
    );

    expect((await store.events({ sessionId: actorSessionId, limit: 20 })).map((event) => event.id)).toEqual([
      "event_fenced_actor_session",
      "event_fenced_actor_write",
    ]);
  } finally {
    store.releaseSessionRun({ sessionId: actorSessionId, claimId: actorClaimId });
    store.releaseSessionRun({ sessionId: ownerSessionId, claimId });
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
      allowSubagentSessions: false,
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

test("stale-turn recovery respects a live child task lease and recovers once after expiry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-live-child-turn-recovery-"));
  const dbPath = join(dir, "events.sqlite");
  const worker = new SqliteEventStore(dbPath);
  const recovery = new SqliteEventStore(dbPath);
  const parentSessionId = "session_live_child_parent" as SessionId;
  const childSessionId = "session_live_child_recovery" as SessionId;
  const taskId = "task_live_child_recovery" as TaskId;
  const runId = "agent_live_child_recovery" as AgentRunId;
  const turnId = "turn_live_child_recovery" as TurnId;
  const now = Date.now();
  let recoveredIds = 0;

  try {
    await worker.appendMany([
      sessionEvent("event_live_child_parent_session", parentSessionId, (now - 1_000) as TimestampMs),
      {
        id: "event_live_child_task_created",
        type: "agent.task_created",
        time: (now - 950) as TimestampMs,
        sessionId: parentSessionId,
        payload: {
          taskId,
          path: "/root/live-child" as AgentPath,
          parentPath: "/root" as AgentPath,
          parentSessionId,
          childSessionId,
          taskName: "live child",
          cwd: "/repo",
          prompt: "keep working",
          mode: "background",
        },
      },
      {
        id: "event_live_child_spawned",
        type: "agent.spawned",
        time: (now - 900) as TimestampMs,
        sessionId: parentSessionId,
        payload: {
          runId,
          taskId,
          path: "/root/live-child" as AgentPath,
          parentPath: "/root" as AgentPath,
          parentSessionId,
          childSessionId,
          taskName: "live child",
          cwd: "/repo",
          mode: "background",
          generation: 1,
        },
      },
      sessionEvent("event_live_child_session", childSessionId, (now - 850) as TimestampMs),
      {
        id: "event_live_child_running",
        type: "session.status_changed",
        time: (now - 800) as TimestampMs,
        sessionId: childSessionId,
        payload: { sessionId: childSessionId, status: "running" },
      },
      {
        id: "event_live_child_turn",
        type: "turn.started",
        time: (now - 750) as TimestampMs,
        sessionId: childSessionId,
        payload: { turnId },
      },
    ]);
    expect(await worker.claimAgentTaskLease({
      taskId,
      runId,
      generation: 1,
      owner: "worker_live_child",
      ttlMs: 100,
      now,
    })).toMatchObject({ acquired: true, task: { leaseExpiresAt: now + 100 } });

    expect(await recovery.reconcileStaleTurns({
      staleBefore: now,
      now: now + 99,
      createId: (prefix) => `${prefix}_live_child_${recoveredIds++}`,
    })).toEqual([]);
    expect((await recovery.events({ sessionId: childSessionId, limit: 20 })).at(-1)?.id).toBe(
      "event_live_child_turn",
    );

    expect((await recovery.reconcileStaleTurns({
      staleBefore: now,
      now: now + 100,
      createId: (prefix) => `${prefix}_expired_child_${recoveredIds++}`,
    })).map((event) => event.type)).toEqual(["turn.completed", "session.status_changed"]);
    expect(await recovery.reconcileStaleTurns({
      staleBefore: now + 200,
      now: now + 200,
      createId: (prefix) => `${prefix}_duplicate_child_${recoveredIds++}`,
    })).toEqual([]);
  } finally {
    recovery.close();
    worker.close();
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

test("migration preserves legacy team worker identity and follow-up CAS rejects reopening it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-legacy-team-worker-migration-"));
  const dbPath = join(dir, "events.sqlite");
  const taskId = "task_legacy_team_worker" as TaskId;
  const currentRunId = "agent_legacy_team_worker" as AgentRunId;
  const legacyWorkerPolicy = {
    teamId: "team_legacy_worker",
    taskId: "team_task_legacy_worker",
    memberPath: "/root/worker",
    parentSessionId: "session_legacy_worker_parent",
  };
  const legacyDb = new Database(dbPath, { create: true, strict: true });
  legacyDb.exec(`
    create table events (
      id text primary key,
      type text not null,
      time integer not null,
      session_id text,
      payload_json text not null
    );
    create table agent_tasks (
      id text primary key,
      path text not null,
      parent_path text,
      parent_session_id text,
      child_session_id text,
      task_name text not null,
      cwd text,
      prompt text,
      mode text,
      status text not null,
      generation integer not null default 0,
      current_run_id text,
      summary text,
      error text,
      completion_json text,
      created_at integer not null,
      updated_at integer not null,
      completed_at integer
    )
  `);
  legacyDb.query(
    `insert into agent_tasks
       (id, path, parent_path, parent_session_id, child_session_id,
        task_name, cwd, prompt, mode, status, generation, current_run_id,
        created_at, updated_at, completed_at)
     values (?, ?, ?, ?, ?, ?, '/repo', 'legacy team prompt', 'background',
             'completed', 1, ?, 1, 2, 2)`,
  ).run(
    taskId,
    "/root/worker/task_legacy_team_worker",
    "/root/worker",
    "session_legacy_worker_parent",
    "session_legacy_worker_child",
    "legacy team worker",
    currentRunId,
  );
  legacyDb.query(
    `insert into events (id, type, time, session_id, payload_json)
     values ('event_legacy_team_worker_created', 'agent.task_created', 1, ?, ?)`,
  ).run(
    "session_legacy_worker_parent",
    JSON.stringify({
      taskId,
      path: "/root/worker/task_legacy_team_worker",
      parentPath: "/root/worker",
      parentSessionId: "session_legacy_worker_parent",
      childSessionId: "session_legacy_worker_child",
      taskName: "legacy team worker",
      cwd: "/repo",
      prompt: "legacy team prompt",
      mode: "background",
      workerPolicy: legacyWorkerPolicy,
    }),
  );
  legacyDb.close();

  const store = new SqliteEventStore(dbPath);
  try {
    const migrated = sqliteDatabase(store).query<{
      dispatch_id: string | null;
      reserved_run_id: string | null;
      worker_policy_json: string | null;
    }, [string]>(
      `select dispatch_id, reserved_run_id, worker_policy_json
       from agent_tasks where id = ?`,
    ).get(taskId);
    expect(migrated).toMatchObject({
      dispatch_id: null,
      reserved_run_id: null,
      worker_policy_json: expect.any(String),
    });
    expect(sqliteDatabase(store).query<{ name: string }, []>(
      `select name from schema_migrations where name = 'agent_task_worker_policy_backfill_v1'`,
    ).get()).toEqual({ name: "agent_task_worker_policy_backfill_v1" });
    expect(await store.agentTask(taskId)).toMatchObject({
      id: taskId,
      status: "completed",
      generation: 1,
      currentRunId,
      workerPolicy: {
        teamId: "team_legacy_worker",
        taskId: "team_task_legacy_worker",
      },
    });

    const result = await store.beginAgentTaskRunCas({
      taskId,
      expectedGeneration: 1,
      expectedRunId: currentRunId,
      expectedLeaseOwner: null,
      runId: "agent_legacy_team_worker_forbidden" as AgentRunId,
      generation: 2,
      leaseOwner: "task-followup:legacy-team-worker",
      leaseTtlMs: 100,
      spawnEventId: "event_legacy_team_worker_forbidden",
      time: 3,
    });
    expect(result).toMatchObject({ applied: false, events: [] });
    expect(await store.agentTask(taskId)).toMatchObject({
      status: "completed",
      generation: 1,
      currentRunId,
    });
    expect(await store.events({ type: "agent.spawned", limit: 10 })).toEqual([]);
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

test("treats an exact late reserved task creation as a no-op across ledger, mirror, and observers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-reserved-create-idempotency-"));
  const mirrored: ChiliEvent[] = [];
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"), {
    mirror: {
      async write(event) {
        mirrored.push(event);
      },
    },
  });
  const store = new ObservableEventStore(baseStore);
  const observed: ChiliEvent[] = [];
  const unsubscribe = store.subscribe((event) => observed.push(event));
  const parentSessionId = "session_reserved_create_parent" as SessionId;
  const taskId = "task_reserved_create" as TaskId;
  const runId = "agent_reserved_create" as AgentRunId;
  const path = "/root/task_reserved_create" as AgentPath;
  const workerPolicy = {
    tools: ["read", "search"],
    constraints: { network: false, filesystem: "workspace" },
    enabled: true,
  };
  const creation: Extract<ChiliEvent, { type: "agent.task_created" }> = {
    id: "event_reserved_create_first",
    type: "agent.task_created",
    time: 1 as TimestampMs,
    sessionId: parentSessionId,
    payload: {
      taskId,
      dispatchId: "dispatch_reserved_create",
      reservedRunId: runId,
      path,
      parentPath: "/root" as AgentPath,
      parentSessionId,
      childSessionId: "session_reserved_create_child" as SessionId,
      taskName: "reserved create",
      cwd: "/repo",
      prompt: "perform the frozen work",
      mode: "one_shot",
      workerPolicy,
    },
  };

  try {
    await store.append(creation);
    expect((await store.closeAgentTaskCas({
      taskId,
      status: "cancelled",
      eventId: "event_reserved_create_cancelled",
      expectedGeneration: 0,
      expectedRunId: null,
      expectedLeaseOwner: null,
      time: 2,
    })).applied).toBe(true);

    await store.append({
      ...creation,
      id: "event_reserved_create_late_exact",
      time: 3 as TimestampMs,
      payload: {
        ...creation.payload,
        workerPolicy: {
          enabled: true,
          constraints: { filesystem: "workspace", network: false },
          tools: ["read", "search"],
        },
      },
    });

    expect(await baseStore.agentTask(taskId)).toMatchObject({
      status: "cancelled",
      generation: 1,
      dispatchId: creation.payload.dispatchId,
      reservedRunId: runId,
      workerPolicy,
    });
    expect(await baseStore.events({ type: "agent.task_created", limit: 10 })).toEqual([creation]);
    expect(mirrored.filter((event) => event.type === "agent.task_created")).toEqual([creation]);
    expect(observed.filter((event) => event.type === "agent.task_created")).toEqual([creation]);
  } finally {
    unsubscribe();
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects cross-task dispatch and reserved-run reuse and rolls back the whole batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-reservation-conflict-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const parentSessionId = "session_reservation_conflict_parent" as SessionId;
  const first: Extract<ChiliEvent, { type: "agent.task_created" }> = {
    id: "event_reservation_conflict_first",
    type: "agent.task_created",
    time: 1 as TimestampMs,
    sessionId: parentSessionId,
    payload: {
      taskId: "task_reservation_conflict_first" as TaskId,
      dispatchId: "dispatch_reservation_conflict",
      reservedRunId: "agent_reservation_conflict" as AgentRunId,
      path: "/root/task_reservation_conflict_first" as AgentPath,
      parentPath: "/root" as AgentPath,
      parentSessionId,
      childSessionId: "session_reservation_conflict_first" as SessionId,
      taskName: "first reservation",
      cwd: "/repo",
      prompt: "first",
      mode: "one_shot",
    },
  };

  try {
    await store.append(first);
    const dispatchConflict: Extract<ChiliEvent, { type: "agent.task_created" }> = {
      ...first,
      id: "event_reservation_dispatch_conflict",
      payload: {
        ...first.payload,
        taskId: "task_reservation_dispatch_conflict" as TaskId,
        reservedRunId: "agent_reservation_dispatch_conflict" as AgentRunId,
        path: "/root/task_reservation_dispatch_conflict" as AgentPath,
        childSessionId: "session_reservation_dispatch_conflict" as SessionId,
      },
    };
    await expect(store.append(dispatchConflict)).rejects.toThrow("dispatch identity already belongs");

    const runConflict: Extract<ChiliEvent, { type: "agent.task_created" }> = {
      ...dispatchConflict,
      id: "event_reservation_run_conflict",
      payload: {
        ...dispatchConflict.payload,
        taskId: "task_reservation_run_conflict" as TaskId,
        dispatchId: "dispatch_reservation_run_conflict",
        reservedRunId: first.payload.reservedRunId as AgentRunId,
        path: "/root/task_reservation_run_conflict" as AgentPath,
        childSessionId: "session_reservation_run_conflict" as SessionId,
      },
    };
    await expect(store.append(runConflict)).rejects.toThrow("run reservation already belongs");

    const batchCandidate: Extract<ChiliEvent, { type: "agent.task_created" }> = {
      ...first,
      id: "event_reservation_batch_candidate",
      payload: {
        ...first.payload,
        taskId: "task_reservation_batch_candidate" as TaskId,
        dispatchId: "dispatch_reservation_batch_candidate",
        reservedRunId: "agent_reservation_batch_candidate" as AgentRunId,
        path: "/root/task_reservation_batch_candidate" as AgentPath,
        childSessionId: "session_reservation_batch_candidate" as SessionId,
      },
    };
    await expect(store.appendMany([batchCandidate, dispatchConflict])).rejects.toThrow(
      "dispatch identity already belongs",
    );

    expect(await store.agentTask(batchCandidate.payload.taskId)).toBeUndefined();
    expect((await store.events({ type: "agent.task_created", limit: 10 })).map((event) => event.id)).toEqual([
      first.id,
    ]);
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

    const sameOwnerBlocked = await store.claimAgentTaskLease({
      taskId,
      runId,
      generation: 2,
      owner: "worker_a",
      ttlMs: 50,
      now: 105,
    });
    expect(sameOwnerBlocked).toMatchObject({
      acquired: false,
      task: {
        generation: 2,
        leaseOwner: "worker_a",
        leaseExpiresAt: 150,
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

test("rejects task completion and closure fenced by a released run claim after takeover", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-task-finalization-run-claim-"));
  const dbPath = join(dir, "events.sqlite");
  const staleOwner = new SqliteEventStore(dbPath);
  const takeoverOwner = new SqliteEventStore(dbPath);
  const sessionId = "session_parent" as SessionId;
  const taskId = "task_finalization_run_claim" as TaskId;
  const runId = "agent_finalization_run_claim" as AgentRunId;
  const path = "/root/task_finalization_run_claim" as AgentPath;
  const staleClaim = { sessionId, claimId: "run_claim_finalization_stale" };
  const takeoverClaim = { sessionId, claimId: "run_claim_finalization_takeover" };

  try {
    await staleOwner.append(sessionEvent("event_finalization_run_claim_session", sessionId, 1 as TimestampMs));
    await appendRunningTask(staleOwner, { taskId, runId, path, generation: 1, time: 2 as TimestampMs });
    expect(staleOwner.claimSessionRun({
      ...staleClaim,
      allowSubagentSessions: true,
      time: 10,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    staleOwner.releaseSessionRun(staleClaim);
    expect(takeoverOwner.claimSessionRun({
      ...takeoverClaim,
      allowSubagentSessions: true,
      time: 11,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });

    await expect(staleOwner.completeAgentTaskCas({
      taskId,
      path,
      runId,
      generation: 1,
      expectedGeneration: 1,
      expectedRunId: runId,
      expectedLeaseOwner: null,
      status: "completed",
      eventId: "event_finalization_stale_task_complete",
      agentEventId: "event_finalization_stale_run_complete",
      sessionId,
      time: 12,
      runClaim: staleClaim,
    })).rejects.toBeInstanceOf(SessionRunClaimConflictError);
    await expect(staleOwner.closeAgentTaskCas({
      taskId,
      status: "cancelled",
      eventId: "event_finalization_stale_task_close",
      agentEventId: "event_finalization_stale_run_close",
      expectedGeneration: 1,
      expectedRunId: runId,
      expectedLeaseOwner: null,
      sessionId,
      time: 13,
      runClaim: staleClaim,
    })).rejects.toBeInstanceOf(SessionRunClaimConflictError);

    expect(await takeoverOwner.agentTask(taskId)).toMatchObject({
      status: "running",
      generation: 1,
      currentRunId: runId,
    });
    expect(await takeoverOwner.agentRuns({ taskId })).toEqual([
      expect.objectContaining({ id: runId, status: "running" }),
    ]);
    expect(await takeoverOwner.events({ type: "agent.task_completed", limit: 10 })).toEqual([]);
    expect(await takeoverOwner.events({ type: "agent.completed", limit: 10 })).toEqual([]);
  } finally {
    takeoverOwner.releaseSessionRun(takeoverClaim);
    staleOwner.close();
    takeoverOwner.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects team-agent synchronization fenced by a released run claim after takeover", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-team-agent-sync-run-claim-"));
  const dbPath = join(dir, "events.sqlite");
  const staleOwner = new SqliteEventStore(dbPath);
  const takeoverOwner = new SqliteEventStore(dbPath);
  const sessionId = "session_team_agent_sync_run_claim" as SessionId;
  const teamId = "team_agent_sync_run_claim" as TeamId;
  const teamTaskId = "task_team_agent_sync_run_claim" as TaskId;
  const agentTaskId = "task_agent_sync_run_claim" as TaskId;
  const agentRunId = "agent_sync_run_claim" as AgentRunId;
  const workerPath = "/root/worker" as AgentPath;
  const agentPath = "/root/worker/task_agent_sync_run_claim" as AgentPath;
  const childSessionId = "session_team_agent_sync_child" as SessionId;
  const staleClaim = { sessionId, claimId: "run_claim_team_agent_sync_stale" };
  const takeoverClaim = { sessionId, claimId: "run_claim_team_agent_sync_takeover" };
  const preparedDispatch = {
    state: "prepared",
    dispatchId: "dispatch_team_agent_sync_run_claim",
    agentTaskId,
    agentPath,
    runId: agentRunId,
    childSessionId,
    ownerPath: workerPath,
    mode: "background",
    dispatchedAt: 5,
    taskCwd: "/repo",
    taskName: "fenced synchronization",
    prompt: "complete the fenced task",
    workerPolicy: {
      teamId,
      taskId: teamTaskId,
      memberPath: workerPath,
      parentSessionId: sessionId,
    },
  };

  try {
    await staleOwner.appendMany([
      sessionEvent("event_team_agent_sync_session", sessionId, 1 as TimestampMs),
      {
        id: "event_team_agent_sync_team",
        type: "team.created",
        time: 2 as TimestampMs,
        sessionId,
        payload: { teamId, name: "sync fence", leadPath: "/root" as AgentPath },
      },
      {
        id: "event_team_agent_sync_member",
        type: "team.member_added",
        time: 3 as TimestampMs,
        sessionId,
        payload: { teamId, path: workerPath, name: "worker", role: "implementer" },
      },
      {
        id: "event_team_agent_sync_task",
        type: "team.task_created",
        time: 4 as TimestampMs,
        sessionId,
        payload: {
          teamId,
          taskId: teamTaskId,
          title: "fenced synchronization",
          ownerPath: workerPath,
        },
      },
      {
        id: "event_team_agent_sync_claimed",
        type: "team.task_claimed",
        time: 5 as TimestampMs,
        sessionId,
        payload: {
          teamId,
          taskId: teamTaskId,
          ownerPath: workerPath,
          claimedBy: workerPath,
          metadata: { chiliTeamDispatch: preparedDispatch },
        },
      },
      {
        id: "event_team_agent_sync_agent_created",
        type: "agent.task_created",
        time: 6 as TimestampMs,
        sessionId,
        payload: {
          taskId: agentTaskId,
          dispatchId: preparedDispatch.dispatchId,
          reservedRunId: agentRunId,
          path: agentPath,
          parentPath: workerPath,
          parentSessionId: sessionId,
          childSessionId,
          taskName: preparedDispatch.taskName,
          cwd: preparedDispatch.taskCwd,
          prompt: preparedDispatch.prompt,
          mode: "background",
          workerPolicy: preparedDispatch.workerPolicy,
        },
      },
    ]);
    expect((await staleOwner.closeAgentTaskCas({
      taskId: agentTaskId,
      status: "cancelled",
      eventId: "event_team_agent_sync_agent_closed",
      expectedGeneration: 0,
      expectedRunId: null,
      expectedLeaseOwner: null,
      sessionId,
      time: 7,
    })).applied).toBe(true);

    expect(staleOwner.claimSessionRun({
      ...staleClaim,
      allowSubagentSessions: false,
      time: 10,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });
    staleOwner.releaseSessionRun(staleClaim);
    expect(takeoverOwner.claimSessionRun({
      ...takeoverClaim,
      allowSubagentSessions: false,
      time: 11,
      leaseDurationMs: 100,
    })).toEqual({ status: "claimed" });

    await expect(staleOwner.syncTeamTaskFromAgentCas({
      teamId,
      taskId: teamTaskId,
      agentTaskId,
      agentRunId,
      agentGeneration: 1,
      agentStatus: "cancelled",
      status: "cancelled",
      metadata: {
        chiliTeamDispatch: {
          ...preparedDispatch,
          state: "bound",
          generation: 1,
          agentStatus: "cancelled",
          syncedAt: 12,
        },
      },
      taskEventId: "event_team_agent_sync_stale_task",
      memberEventId: "event_team_agent_sync_stale_member",
      sessionId,
      runClaim: staleClaim,
      time: 12,
    })).rejects.toBeInstanceOf(SessionRunClaimConflictError);

    expect(await takeoverOwner.teamTasks({ teamId, taskId: teamTaskId, limit: 1 })).toMatchObject([
      { id: teamTaskId, status: "in_progress", ownerPath: workerPath },
    ]);
    expect((await takeoverOwner.events({ type: "team.task_updated", limit: 10 })).map((event) => event.id))
      .not.toContain("event_team_agent_sync_stale_task");
    expect((await takeoverOwner.events({ type: "team.member_status_changed", limit: 10 })).map((event) => event.id))
      .not.toContain("event_team_agent_sync_stale_member");
  } finally {
    takeoverOwner.releaseSessionRun(takeoverClaim);
    staleOwner.close();
    takeoverOwner.close();
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

test("bounds direct agent and team CAS callers before persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-cas-persistence-bounds-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_direct_cas_bounds" as TaskId;
  const runId = "agent_direct_cas_bounds" as AgentRunId;
  const path = "/root/direct_cas_bounds" as AgentPath;
  const summaryPrefix =
    `Ordinary direct summary keeps ${STORE_HOSTILE_SECRET} and `
    + `http://127.0.0.1:4777/result?token=${STORE_HOSTILE_SECRET}.\n`;
  const hugeOrdinarySummary = `${summaryPrefix}${storeWorstEscapedText()}`;

  try {
    await appendRunningTask(store, { taskId, runId, path, generation: 1, time: 1 as TimestampMs });
    const completed = await store.completeAgentTaskCas({
      taskId,
      path,
      runId,
      generation: 1,
      expectedGeneration: 1,
      expectedRunId: runId,
      expectedLeaseOwner: null,
      status: "failed",
      summary: hugeOrdinarySummary,
      error: hostileStoreDiagnostic("direct task failed", true),
      eventId: "event_direct_cas_task_completed",
      agentEventId: "event_direct_cas_agent_completed",
      time: 2,
    });

    expect(completed.applied).toBe(true);
    expect(completed.task?.summary?.startsWith(summaryPrefix)).toBe(true);
    expect(completed.task?.summary).not.toContain("[REDACTED]");
    expectStoreSafeDiagnostic(completed.task?.error);
    expect(completed.events).toHaveLength(2);
    for (const event of completed.events) {
      if (event.type === "agent.task_completed" || event.type === "agent.completed") {
        expectStoreSafeDiagnostic(event.payload.error);
      }
      expect(jsonByteLength(event)).toBeLessThanOrEqual(192 * 1024);
    }

    await store.append({
      id: "event_direct_cas_mailbox",
      type: "agent.message_queued",
      time: 3 as TimestampMs,
      payload: {
        path,
        from: "/root" as AgentPath,
        triggerTurn: true,
        message: { role: "user", content: "retry directly" },
      },
    });
    expect((await store.claimAgentMailboxMessage({
      messageId: "event_direct_cas_mailbox",
      eventId: "event_direct_cas_mailbox_claim",
      time: 4,
    })).applied).toBe(true);
    const requeued = await store.requeueAgentMailboxMessage({
      messageId: "event_direct_cas_mailbox",
      eventId: "event_direct_cas_mailbox_requeue",
      error: hostileStoreDiagnostic("direct mailbox failed", true),
      time: 5,
    });
    expect(requeued.applied).toBe(true);
    const requeuedEvent = requeued.events[0] as Extract<ChiliEvent, { type: "agent.message_requeued" }>;
    expectStoreSafeDiagnostic(requeuedEvent.payload.error);
    expect(jsonByteLength(requeuedEvent)).toBeLessThanOrEqual(128 * 1024);
    expect((await store.claimAgentMailboxMessage({
      messageId: "event_direct_cas_mailbox",
      eventId: "event_direct_cas_mailbox_reclaim",
      time: 6,
    })).applied).toBe(true);
    const discarded = await store.discardAgentMailboxMessage({
      messageId: "event_direct_cas_mailbox",
      eventId: "event_direct_cas_mailbox_discard",
      reason: hostileStoreDiagnostic("direct mailbox discarded", false),
      time: 7,
    });
    expect(discarded.applied).toBe(true);
    const discardedEvent = discarded.events[0] as Extract<ChiliEvent, { type: "agent.message_discarded" }>;
    expectStoreSafeDiagnostic(discardedEvent.payload.reason);
    expect(jsonByteLength(discardedEvent)).toBeLessThanOrEqual(32 * 1024);

    const teamId = "team_direct_cas_bounds" as TeamId;
    const teamTaskId = "task_direct_team_cas_bounds" as TaskId;
    const leadPath = "/root" as AgentPath;
    const workerPath = "/root/direct_worker" as AgentPath;
    await store.appendMany([
      {
        id: "event_direct_cas_team_created",
        type: "team.created",
        time: 6 as TimestampMs,
        payload: { teamId, name: "direct bounds", leadPath },
      },
      {
        id: "event_direct_cas_team_member",
        type: "team.member_added",
        time: 7 as TimestampMs,
        payload: { teamId, path: workerPath, name: "worker", role: "implementer" },
      },
      {
        id: "event_direct_cas_team_task",
        type: "team.task_created",
        time: 8 as TimestampMs,
        payload: { teamId, taskId: teamTaskId, title: "Direct CAS task" },
      },
    ]);
    const ordinaryFeedback = `Ordinary feedback keeps ${STORE_HOSTILE_SECRET}`;
    const metadata: Record<string, unknown> = {
      feedback: ordinaryFeedback,
      verification: { status: "failed", feedback: hostileStoreDiagnostic("verification failed", false) },
      nested: { failureReason: hostileStoreDiagnostic("claim failed", false) },
      "failure reason": hostileStoreDiagnostic("spaced claim failure", false),
      ordinaryBlob: hugeOrdinarySummary,
      values: Array.from({ length: 300 }, (_, index) => index),
    };
    Object.defineProperty(metadata, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { error: hostileStoreDiagnostic("prototype key failure", false) },
    });
    metadata.circular = metadata;
    const claimed = await store.claimTeamTask({
      teamId,
      taskId: teamTaskId,
      ownerPath: workerPath,
      claimedBy: workerPath,
      metadata,
      eventId: "event_direct_cas_team_claim",
      time: 9,
    });

    expect(claimed.applied).toBe(true);
    expect(claimed.task?.metadata?.feedback).toBe(ordinaryFeedback);
    expectStoreSafeDiagnostic(
      ((claimed.task?.metadata?.verification as Record<string, unknown> | undefined)?.feedback as string | undefined),
    );
    expectStoreSafeDiagnostic(
      ((claimed.task?.metadata?.nested as Record<string, unknown> | undefined)?.failureReason as string | undefined),
    );
    expectStoreSafeDiagnostic(claimed.task?.metadata?.["failure reason"] as string | undefined);
    expect(Object.prototype.hasOwnProperty.call(claimed.task?.metadata, "__proto__")).toBe(true);
    expectStoreSafeDiagnostic(
      ((claimed.task?.metadata?.["__proto__"] as Record<string, unknown> | undefined)?.error as string | undefined),
    );
    expect(jsonByteLength(claimed.task?.metadata)).toBeLessThanOrEqual(256 * 1024);
    expect(jsonByteLength(claimed.events[0])).toBeLessThanOrEqual(320 * 1024);
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

test("atomically binds one active interactive owner session and preserves it across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-team-owner-bind-"));
  const dbPath = join(dir, "events.sqlite");
  const first = new SqliteEventStore(dbPath);
  const second = new SqliteEventStore(dbPath);
  const teamId = "team_owner_bind" as TeamId;
  const sessionA = "session_owner_a" as SessionId;
  const sessionB = "session_owner_b" as SessionId;

  try {
    await first.appendMany([
      sessionEvent("event_owner_a", sessionA, 1 as TimestampMs),
      sessionEvent("event_owner_b", sessionB, 2 as TimestampMs),
      {
        id: "event_team_owner_unbound",
        type: "team.created",
        time: 3 as TimestampMs,
        payload: {
          teamId,
          name: "owner bind",
          leadPath: "/root" as AgentPath,
        },
      },
    ]);

    const results = await Promise.all([
      first.bindTeamOwnerSession({
        teamId,
        ownerSessionId: sessionA,
        eventId: "event_bind_owner_a",
        time: 4,
      }),
      second.bindTeamOwnerSession({
        teamId,
        ownerSessionId: sessionB,
        eventId: "event_bind_owner_b",
        time: 5,
      }),
    ]);
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(results.filter((result) => result.reason === "conflict")).toHaveLength(1);
    const winner = results.find((result) => result.applied)?.ownerSessionId;
    expect(winner === sessionA || winner === sessionB).toBe(true);

    first.close();
    second.close();
    const reopened = new SqliteEventStore(dbPath);
    try {
      expect(await reopened.teams({ teamId })).toMatchObject([{ id: teamId, sessionId: winner }]);
      expect(await reopened.events({ type: "team.owner_session_bound", limit: 10 })).toHaveLength(1);
    } finally {
      reopened.close();
    }
  } finally {
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("owner binding rejects subagent sessions and mismatched binding event identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-team-owner-subagent-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const teamId = "team_owner_subagent" as TeamId;
  const rootSessionId = "session_owner_root" as SessionId;
  const childSessionId = "session_owner_child" as SessionId;

  try {
    await store.appendMany([
      sessionEvent("event_owner_root", rootSessionId, 1 as TimestampMs),
      sessionEvent("event_owner_child", childSessionId, 2 as TimestampMs),
      {
        id: "event_owner_child_task",
        type: "agent.task_created",
        time: 3 as TimestampMs,
        sessionId: rootSessionId,
        payload: {
          taskId: "task_owner_child" as TaskId,
          path: "/root/child" as AgentPath,
          parentPath: "/root" as AgentPath,
          parentSessionId: rootSessionId,
          childSessionId,
          taskName: "child",
          cwd: "/repo",
          prompt: "child",
        },
      },
      {
        id: "event_team_owner_subagent",
        type: "team.created",
        time: 4 as TimestampMs,
        payload: {
          teamId,
          name: "subagent owner",
          leadPath: "/root" as AgentPath,
        },
      },
    ]);

    expect(await store.bindTeamOwnerSession({
      teamId,
      ownerSessionId: childSessionId,
      eventId: "event_bind_subagent",
      time: 5,
    })).toMatchObject({ applied: false, reason: "subagent_session" });
    expect((await store.teams({ teamId }))[0]?.sessionId).toBeUndefined();

    await expect(store.append({
      id: "event_bind_mismatch",
      type: "team.owner_session_bound",
      time: 6 as TimestampMs,
      sessionId: rootSessionId,
      payload: { teamId, ownerSessionId: childSessionId },
    })).rejects.toThrow("does not match event.sessionId");
    expect((await store.teams({ teamId }))[0]?.sessionId).toBeUndefined();
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

test("duplicate team task projection preserves the first write and rolls back its batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-team-task-first-write-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const firstTeamId = "team_task_store_first" as TeamId;
  const secondTeamId = "team_task_store_second" as TeamId;
  const firstLead = "/root/first" as AgentPath;
  const secondLead = "/root/second" as AgentPath;
  const taskId = "task_store_global" as TaskId;

  try {
    await store.appendMany([
      {
        id: "event_task_store_first_team",
        type: "team.created",
        time: 1 as TimestampMs,
        payload: { teamId: firstTeamId, name: "first", leadPath: firstLead },
      },
      {
        id: "event_task_store_first_lead",
        type: "team.member_added",
        time: 2 as TimestampMs,
        payload: {
          teamId: firstTeamId,
          path: firstLead,
          name: "first lead",
          role: "leader",
          status: "running",
        },
      },
      {
        id: "event_task_store_second_team",
        type: "team.created",
        time: 3 as TimestampMs,
        payload: { teamId: secondTeamId, name: "second", leadPath: secondLead },
      },
      {
        id: "event_task_store_second_lead",
        type: "team.member_added",
        time: 4 as TimestampMs,
        payload: {
          teamId: secondTeamId,
          path: secondLead,
          name: "second lead",
          role: "leader",
          status: "running",
        },
      },
      {
        id: "event_task_store_original",
        type: "team.task_created",
        time: 5 as TimestampMs,
        payload: {
          teamId: firstTeamId,
          taskId,
          title: "preserve original",
          description: "original description",
          createdBy: firstLead,
          ownerPath: firstLead,
          status: "completed",
          metadata: { source: "original", ordinal: 1 },
        },
      },
    ]);
    const [original] = await store.teamTasks({ taskId });
    const teamsBefore = await store.teams({});
    const membersBefore = await store.teamMembers({});
    const eventsBefore = await store.events({ limit: 100 });

    await expect(store.appendMany([
      {
        id: "event_task_store_rolled_back_member",
        type: "team.member_status_changed",
        time: 6 as TimestampMs,
        payload: {
          teamId: secondTeamId,
          path: secondLead,
          status: "idle",
        },
      },
      {
        id: "event_task_store_duplicate",
        type: "team.task_created",
        time: 7 as TimestampMs,
        payload: {
          teamId: secondTeamId,
          taskId,
          title: "must not replace original",
          description: "replacement description",
          createdBy: secondLead,
          ownerPath: secondLead,
          status: "failed",
          metadata: { source: "duplicate", ordinal: 2 },
        },
      },
    ])).rejects.toBeInstanceOf(TeamTaskAlreadyExistsError);

    expect(await store.teamTasks({ taskId })).toEqual([original!]);
    expect(original).toMatchObject({
      id: taskId,
      teamId: firstTeamId,
      ownerPath: firstLead,
      status: "completed",
      title: "preserve original",
      description: "original description",
      createdBy: firstLead,
      metadata: { source: "original", ordinal: 1 },
      completedAt: 5,
    });
    expect(await store.teams({})).toEqual(teamsBefore);
    expect(await store.teamMembers({})).toEqual(membersBefore);
    expect(await store.events({ limit: 100 })).toEqual(eventsBefore);
    const createdEvents = await store.events({ type: "team.task_created", limit: 10 });
    expect(createdEvents.filter(
      (event) => event.type === "team.task_created"
        && (event.payload as { taskId?: TaskId }).taskId === taskId,
    )).toHaveLength(1);
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

const STORE_HOSTILE_SECRET = "sk-store-cas-secret-123456789";

function hostileStoreDiagnostic(label: string, includeWorstEscaped: boolean): string {
  return `${label}\nAuthorization: Bearer ${STORE_HOSTILE_SECRET}\n`
    + `http://127.0.0.1:4777/private?token=${STORE_HOSTILE_SECRET}\n`
    + (includeWorstEscaped ? storeWorstEscapedText() : "diagnostic detail");
}

function storeWorstEscapedText(): string {
  return "\u0000\"\\\n".repeat(Math.ceil((5 * 1024 * 1024) / 4));
}

function expectStoreSafeDiagnostic(value: string | undefined): void {
  expect(value).toBeDefined();
  expect(value).toContain("[REDACTED]");
  expect(value).not.toContain(STORE_HOSTILE_SECRET);
  expect(value).not.toContain("127.0.0.1");
  expect(new TextEncoder().encode(value ?? "").byteLength).toBeLessThanOrEqual(16 * 1024);
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
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
