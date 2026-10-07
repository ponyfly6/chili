import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type {
  ApprovalId,
  ChiliEvent,
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

test("atomically rejects duplicate session creation and conflicting working directories", async () => {
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

for (const outcome of ["waiting_for_approval", "idle", "archived"] as const) {
  test(`stale recovery expires legacy approval waiters in ${outcome} sessions without losing history`, async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = `session_legacy_${outcome}` as SessionId;
    const turnId = `turn_legacy_${outcome}` as TurnId;
    const callId = `call_legacy_${outcome}` as ToolCallId;
    const approvalId = `approval_legacy_${outcome}` as ApprovalId;
    const base = { sessionId, time: 2 as TimestampMs };
    let ids = 0;
    try {
      await store.appendMany([
        sessionEvent("event_legacy_session", sessionId, 1 as TimestampMs),
        { ...base, id: "event_legacy_turn", type: "turn.started", payload: { turnId } },
        { ...base, id: "event_legacy_tool", type: "tool.call_started", payload: { turnId, callId, toolName: "bash", input: { command: "bun test" } } },
        { ...base, id: "event_legacy_wait", type: "tool.call_updated", payload: { callId, status: "waiting_for_approval" } },
        { ...base, id: "event_legacy_approval", type: "approval.requested", payload: { approvalId, callId, permission: "bash", patterns: ["bun test"] } },
        { ...base, id: "event_legacy_status", type: "session.status_changed", payload: { sessionId, status: "waiting_for_approval", turnId } },
      ]);
      if (outcome === "idle") await store.append({ ...base, id: "event_legacy_idle", type: "session.status_changed", payload: { sessionId, status: "idle", turnId } });
      if (outcome === "archived") await store.append({ ...base, id: "event_legacy_archive", type: "session.archived", payload: { sessionId } });

      const recovered = await store.reconcileStaleTurns({ staleBefore: 100, now: 101, createId: (prefix) => `${prefix}_legacy_${ids++}` });
      expect(recovered.filter((event) => event.type === "approval.resolved")).toEqual([
        expect.objectContaining({ sessionId, payload: { approvalId, decision: "deny", feedback: expect.stringContaining("interrupted") } }),
      ]);
      expect(recovered.filter((event) => event.type === "tool.call_finished")).toEqual([
        expect.objectContaining({ sessionId, payload: { callId, status: "failed", synthetic: true, error: expect.stringContaining("interrupted") } }),
      ]);
      if (outcome !== "waiting_for_approval") {
        expect(recovered.filter((event) => event.type === "turn.completed" || event.type === "session.status_changed")).toEqual([]);
      }
      expect(await store.pendingApprovals(sessionId)).toEqual([]);
      expect(await store.events({ sessionId, type: "approval.requested" })).toHaveLength(1);
      expect((await store.runtimeSnapshot({ sessionId })).events.filter((event) => event.type === "approval.requested")).toEqual([]);
      expect(await store.reconcileStaleTurns({ staleBefore: 200, now: 201, createId: () => "must_not_append" })).toEqual([]);
    } finally { store.close(); }
  });
}

test("legacy approval recovery preserves live claims and recent activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-legacy-approval-claim-"));
  const path = join(dir, "events.sqlite");
  const owner = new SqliteEventStore(path);
  const recovery = new SqliteEventStore(path);
  const sessionId = "session_live_legacy_approval" as SessionId;
  const approvalId = "approval_live_legacy" as ApprovalId;
  const now = Date.now();
  try {
    await owner.appendMany([
      sessionEvent("event_live_legacy_session", sessionId, 1 as TimestampMs),
      { id: "event_live_legacy_approval", type: "approval.requested", sessionId, time: 2 as TimestampMs,
        payload: { approvalId, permission: "bash", patterns: ["pwd"] } },
    ]);
    owner.claimSessionRun({ sessionId, claimId: "legacy_owner", sessionAccess: "root", time: now, leaseDurationMs: 60_000 });
    expect(await recovery.reconcileStaleTurns({ staleBefore: 100, now, createId: () => "must_not_append" })).toEqual([]);
    expect(await recovery.pendingApprovals(sessionId)).toHaveLength(1);
    owner.releaseSessionRun({ sessionId, claimId: "legacy_owner" });

    await owner.append({ id: "event_live_legacy_recent", type: "session.status_changed", sessionId, time: 100 as TimestampMs,
      payload: { sessionId, status: "idle" } });
    expect(await recovery.reconcileStaleTurns({ staleBefore: 100, now, createId: () => "must_not_append" })).toEqual([]);
    expect(await recovery.pendingApprovals(sessionId)).toHaveLength(1);
    expect((await recovery.reconcileStaleTurns({ staleBefore: 101, now, createId: () => "event_legacy_expired" })).map((event) => event.type)).toEqual(["approval.resolved"]);
    expect(await recovery.pendingApprovals(sessionId)).toEqual([]);
  } finally {
    owner.releaseSessionRun({ sessionId, claimId: "legacy_owner" });
    recovery.close();
    owner.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails closed when scoped session events lack or conflict with envelope identity", async () => {
  const store = new SqliteEventStore(":memory:");
  const sessionId = "session_identity_primary" as SessionId;
  const conflictingSessionId = "session_identity_conflict" as SessionId;
  const time = 1 as TimestampMs;
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
  ];

  try {
    for (const item of invalidEvents) {
      await expect(store.append(item.event)).rejects.toThrow(item.error);
    }
    expect(await store.events({ limit: 20 })).toEqual([]);
    expect(await store.sessions()).toEqual([]);

    await expect(store.appendMany([
      sessionEvent("event_identity_atomic_valid", sessionId, time),
      invalidEvents[1]!.event,
    ])).rejects.toThrow("session.renamed payload sessionId");
    expect(await store.events({ limit: 20 })).toEqual([]);
    expect(await store.sessions()).toEqual([]);
  } finally {
    store.close();
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
