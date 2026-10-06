import { Database } from "bun:sqlite";
import { SessionInputConflictError, SessionInputRepository, type SessionInputMutation, type SessionInputMutationOptions, type SessionInputMutationResult } from "./session-inputs.js";
import type {
  ApprovalEvent,
  RuntimeEvent,
  EventEnvelope,
  GoalEvent,
  Message,
  MessageId,
  MessageEvent,
  MessagePart,
  SessionId,
  SessionEvent,
  SessionGoal,
  SessionGoalStatus,
  TimestampMs,
  ToolEvent,
  TurnId,
} from "@chili/protocol";
import {
  isTransientEvent,
  parseSessionAgentMetadata,
  ROOT_AGENT_PATH,
} from "@chili/protocol";
import { decodeJson, encodeJson } from "./json.js";
import { SQLITE_SCHEMA } from "./schema.js";
import {
  sqliteJournalPolicy,
  type SqliteJournalMode,
} from "./sqlite-journal-policy.js";
import type {
  ApprovalRow,
  EventAppendOptions,
  EventCommitAwareStore,
  EventMirror,
  EventQuery,
  EventStore,
  GoalProjectionStore,
  GoalMutationDecision,
  GoalMutationEvent,
  GoalMutationResult,
  GoalMutationSnapshot,
  GoalMutationStore,
  SessionRow,
  CreateChildSessionInput,
  CreateChildSessionResult,
  SessionCreationClaimFence,
  SessionRunClaimFence,
  StaleTurnRecoveryInput,
  StaleTurnRecoveryStore,
  SessionGoalQuery,
  SessionGoalRow,
} from "./types.js";

interface StoredEventRow {
  seq: number;
  id: string;
  type: string;
  time: number;
  session_id: string | null;
  payload_json: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  turn_id: string | null;
  role: "system" | "user" | "assistant" | "tool";
  parent_id: string | null;
  created_at: number;
}

interface PartRow {
  data_json: string;
  delta_event_seq: number;
}

interface PendingPartDeltaRow {
  seq: number;
  part_id: string;
  payload_json: string;
}

interface SessionGoalProjectionRow {
  session_id: string;
  objective: string;
  status: SessionGoalStatus;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  last_reason: string | null;
}

export const SQLITE_WAL_AUTO_CHECKPOINT_PAGES = 256;
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;

export class SqliteJournalModeError extends Error {
  override readonly name = "SqliteJournalModeError";

  constructor(
    readonly sqliteVersion: string,
    readonly requestedMode: SqliteJournalMode,
    readonly actualMode: string,
    cause?: unknown,
  ) {
    super(
      `SQLite ${sqliteVersion} requires journal_mode=${requestedMode.toUpperCase()} for Chili, `
      + `but the database remained in journal_mode=${actualMode.toUpperCase()}`,
      cause === undefined ? undefined : { cause },
    );
  }
}

export class UnknownEventCursorError extends Error {
  override readonly name = "UnknownEventCursorError";

  constructor(readonly eventId: string) {
    super(`Unknown event cursor: ${eventId}`);
  }
}

export class SessionCwdConflictError extends Error {
  override readonly name = "SessionCwdConflictError";

  constructor(
    readonly sessionId: SessionId,
    readonly existingCwd: string,
    readonly requestedCwd: string,
  ) {
    super(
      `Session ${sessionId} already exists with cwd ${existingCwd}; cannot recreate it with cwd ${requestedCwd}`,
    );
  }
}

export class SessionAlreadyExistsError extends Error {
  override readonly name = "SessionAlreadyExistsError";

  constructor(
    readonly sessionId: SessionId,
    readonly existingCwd: string,
    readonly requestedCwd: string,
  ) {
    super(`Session ${sessionId} already exists with cwd ${existingCwd}`);
  }
}

export class SessionAccessError extends Error {
  override readonly name = "SessionAccessError";

  constructor(readonly sessionId: SessionId) {
    super(`Session ${sessionId} is not available for this runtime access`);
  }
}

export class SessionCreationClaimConflictError extends Error {
  override readonly name = "SessionCreationClaimConflictError";

  constructor(readonly sessionId: SessionId) {
    super(`Session ${sessionId} creation claim is not owned by this store connection`);
  }
}

export class SessionRunClaimConflictError extends Error {
  override readonly name = "SessionRunClaimConflictError";

  constructor(readonly sessionId: SessionId) {
    super(`Session ${sessionId} has an active runtime claim`);
  }
}

export class SessionStateConflictError extends Error {
  override readonly name = "SessionStateConflictError";

  constructor(readonly sessionId: SessionId, readonly status?: string) {
    super(status
      ? `Session ${sessionId} is not active (${status})`
      : `Session ${sessionId} does not exist`);
  }
}

export interface SqliteEventStoreOptions {
  mirror?: EventMirror;
  onMirrorError?: (error: unknown, event: RuntimeEvent) => void;
  busyTimeoutMs?: number;
  writeRetryAttempts?: number;
}

export class SqliteEventStore
  implements
    EventStore,
    EventCommitAwareStore,
    StaleTurnRecoveryStore,
    GoalProjectionStore,
    GoalMutationStore
{
  private readonly db: Database;
  private readonly legacySessionIds = new Map<string, SessionId>();
  private readonly ownedCreationClaims = new Map<SessionId, string>();
  private readonly ownedRunClaims = new Map<SessionId, string>();
  private readonly journalMode: string;
  private closed = false;
  private readonly inputs: SessionInputRepository;
  private inputMirrors: Promise<void> = Promise.resolve();

  constructor(path = ".chili/chili.sqlite", private readonly options: SqliteEventStoreOptions = {}) {
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec(`pragma busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 10_000))}`);
      const sqliteVersion = this.db
        .query<{ version: string }, []>("select sqlite_version() as version")
        .get()?.version ?? "unknown";
      const policy = sqliteJournalPolicy(sqliteVersion);
      this.journalMode = configureSqliteJournalMode(this.db, policy.journalMode, sqliteVersion);
      this.db.exec("pragma synchronous = FULL");
      if (this.journalMode === "wal") {
        this.db.exec(`pragma wal_autocheckpoint = ${SQLITE_WAL_AUTO_CHECKPOINT_PAGES}`);
      }
      this.db.exec(`pragma journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES}`);
      this.db.exec("pragma foreign_keys = ON");
      const [eventTableStatement, ...remainingStatements] = SQLITE_SCHEMA;
      if (eventTableStatement) {
        this.db.exec(eventTableStatement);
      }
      // Some pre-Session databases only carried the legacy event identity.
      // Add its replacement before sequence indexes reference session_id.
      this.addColumnIfMissing("events", "session_id", "text");
      this.backfillScopedEventSessionIds();
      this.migrateEventSequence();
      const tableStatements = remainingStatements.filter((statement) => /^create table\b/i.test(statement.trim()));
      const indexStatements = remainingStatements.filter((statement) => !/^create table\b/i.test(statement.trim()));
      for (const statement of tableStatements) {
        this.db.exec(statement);
      }
      this.addColumnIfMissing("tool_calls", "parent_call_id", "text");
      this.prepareSessionOnlyReplacementColumns();
      this.migrateMailboxRecipientSessionSchema();
      for (const statement of indexStatements) {
        this.db.exec(statement);
      }
      this.migrateApprovalSchema();
      this.migrateMessageSchema();
      this.migrateGoalSchema();
      this.migrateLegacyThreadSchema();
      this.migrateMessageCreationSequence();
      this.migrateSessionClaimSchema();
      this.addColumnIfMissing("sessions", "parent_session_id", "text");
      this.addColumnIfMissing("sessions", "agent_name", "text");
      this.addColumnIfMissing("sessions", "agent_path", "text");
      this.addColumnIfMissing("sessions", "agent_policy_json", "text");
      this.db.exec("create unique index if not exists sessions_agent_name on sessions(parent_session_id, agent_name) where parent_session_id is not null");
      this.addColumnIfMissing("tool_calls", "provider_call_id", "text");
      this.inputs = new SessionInputRepository(this.db, {
        commit: (events, fence) => { this.writeTransactionEvents(events, fence); },
        claim: (input) => this.claimSessionRun(input),
        forgetClaim: (sessionId, claimId) => {
          if (this.ownedRunClaims.get(sessionId) === claimId) this.ownedRunClaims.delete(sessionId);
        },
        assertSession: (sessionId, options) => {
          const session = this.db.query<{ status: string; parent_session_id: string | null }, [string]>("select status, parent_session_id from sessions where id = ?").get(sessionId);
          // Legacy task/team reservations remain read-only. A trusted adapter
          // may execute only a Session created with the new Agent identity.
          if ((!session?.parent_session_id && this.legacySessionReservationExists(sessionId))
            || (session && !!session.parent_session_id !== (options.sessionAccess === "child"))) {
            throw new SessionAccessError(sessionId);
          }
          if (!session || session.status !== "active") throw new SessionStateConflictError(sessionId, session?.status);
        },
        retry: (operation) => this.runWithWriteRetry(operation),
      });
      this.loadLegacySessionIdentities();
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Preserve the initialization error that explains why the store is unavailable.
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      if (this.journalMode === "wal") this.db.exec("pragma wal_checkpoint(TRUNCATE)");
    } finally {
      this.closed = true;
      this.db.close();
    }
  }

  sessionInputQueue(sessionId: SessionId) { return this.inputs.queue(sessionId); }

  sessionInput(sessionId: SessionId, submissionId: string) { return this.inputs.get(sessionId, submissionId); }

  sessionInputById(sessionId: SessionId, inputId: string) { return this.inputs.getById(sessionId, inputId); }

  mutateSessionInputs(input: SessionInputMutation, options?: SessionInputMutationOptions): SessionInputMutationResult {
    const result = this.inputs.mutate(input, options);
    this.inputMirrors = this.inputMirrors.catch(() => undefined).then(() => this.writeMirrors(result.events));
    // Mirror failures never change an already committed receipt.
    void this.inputMirrors.catch(() => undefined);
    return result;
  }

  async createChildSession(input: CreateChildSessionInput): Promise<CreateChildSessionResult> {
    for (const [name, value] of [["maxChildren", input.maxChildren], ["maxDepth", input.maxDepth]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError(`${name} must be a nonnegative safe integer`);
    }
    if (input.runClaim.sessionId !== input.parentSessionId) throw new SessionRunClaimConflictError(input.parentSessionId);
    const transact = this.db.transaction(() => {
      // This is the only cross-Session creation operation. Check the parent's
      // live ownership here without weakening ordinary event write fences.
      this.assertRunClaimFence(input.runClaim, []);
      const parent = this.readSession(input.parentSessionId);
      if (!parent || parent.status !== "active") throw new SessionStateConflictError(input.parentSessionId, parent?.status);
      if (parent.readOnly) throw new SessionAccessError(parent.id);
      const agent = parseSessionAgentMetadata({
        parentSessionId: input.parentSessionId,
        name: input.name,
        path: `${parent.agent?.path ?? ROOT_AGENT_PATH}/${input.name}`,
        policy: input.policy,
      });
      const existing = this.readSession(input.sessionId);
      if (existing) {
        if (existing.cwd !== input.cwd || encodeJson(existing.agent) !== encodeJson(agent)) {
          throw new SessionInputConflictError("Agent Session ID already belongs to a different creation");
        }
        const initial = this.inputs.get(existing.id, input.initialInput.submissionId);
        if (!initial || initial.inputId !== input.initialInput.inputId
          || initial.identity !== (input.initialInput.identity ?? input.initialInput.payload)
          || initial.mode !== input.initialInput.mode || initial.source !== input.initialInput.source) {
          throw new SessionInputConflictError("Agent Session ID already belongs to a different initial input");
        }
        return { session: existing, input: initial, queue: this.inputs.queue(existing.id), events: [], duplicate: true };
      }
      if (this.legacySessionReservationExists(input.sessionId) || this.sessionCreationClaimExists(input.sessionId)) {
        throw new SessionAccessError(input.sessionId);
      }
      const seen = new Set<SessionId>();
      let ancestor: SessionRow | undefined = parent;
      let childDepth = 0;
      while (ancestor) {
        if (seen.has(ancestor.id)) throw new SessionInputConflictError("Agent ancestry contains a cycle");
        seen.add(ancestor.id);
        childDepth++;
        if (!ancestor.agent) break;
        ancestor = this.readSession(ancestor.agent.parentSessionId);
        if (!ancestor) throw new SessionInputConflictError("Agent parent Session is missing");
      }
      if (input.maxDepth !== undefined && childDepth > input.maxDepth) {
        throw new SessionInputConflictError(`Agent depth ${childDepth} exceeds maxDepth ${input.maxDepth}`);
      }
      const count = this.db.query<{ count: number }, [string]>("select count(*) as count from sessions where parent_session_id = ?").get(parent.id)!.count;
      if (input.maxChildren !== undefined && count >= input.maxChildren) {
        throw new SessionInputConflictError(`Agent ${parent.id} already has ${count} direct children (maxChildren: ${input.maxChildren}); resume an existing agent instead`);
      }
      const event: Extract<RuntimeEvent, { type: "session.created" }> = {
        id: crypto.randomUUID(), type: "session.created", sessionId: input.sessionId, time: Date.now() as TimestampMs,
        payload: { sessionId: input.sessionId, cwd: input.cwd, agent, ...(input.identity ? { identity: input.identity } : {}) },
      };
      const created = this.writeTransactionEvents([event]);
      const accepted = this.inputs.mutate({ ...input.initialInput, kind: "accept", sessionId: input.sessionId }, { sessionAccess: "child" });
      return { session: this.readSession(input.sessionId)!, input: accepted.input!, queue: accepted.queue, events: [...created, ...accepted.events] };
    });
    const result = this.runWithWriteRetry(() => transact.immediate());
    await this.writeMirrors(result.events);
    return result;
  }

  private readSession(sessionId: SessionId): SessionRow | undefined {
    const row = this.db.query<{
      id: string; cwd: string; title: string | null; status: "active" | "archived";
      created_at: number; updated_at: number; parent_session_id: string | null;
      agent_name: string | null; agent_path: string | null; agent_policy_json: string | null;
    }, [string]>("select * from sessions where id = ?").get(sessionId);
    if (!row) return undefined;
    return {
      id: row.id as SessionId, cwd: row.cwd, ...(row.title ? { title: row.title } : {}), status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at,
      ...(!row.parent_session_id && this.legacySessionReservationExists(sessionId) ? { readOnly: true as const } : {}),
      ...(row.parent_session_id ? { agent: parseSessionAgentMetadata({
        parentSessionId: row.parent_session_id, name: row.agent_name, path: row.agent_path,
        policy: row.agent_policy_json ? decodeJson(row.agent_policy_json, undefined) : undefined,
      }) } : {}),
    };
  }

  async session(sessionId: SessionId): Promise<SessionRow | undefined> { return this.readSession(sessionId); }

  async childSessions(parentSessionId: SessionId): Promise<SessionRow[]> {
    return this.db.query<{ id: string }, [string]>("select id from sessions where parent_session_id = ? order by created_at, id").all(parentSessionId)
      .map((row) => this.readSession(row.id as SessionId)!);
  }

  async flushInputMirrors(): Promise<void> { await this.inputMirrors; }

  async append(event: RuntimeEvent, options?: EventAppendOptions): Promise<void> {
    await this.appendCommitted(event, options);
  }

  async appendCommitted(event: RuntimeEvent, options?: EventAppendOptions): Promise<boolean> {
    const durableEvents = isTransientEvent(event) ? [] : [event];
    const committed = this.writeTransaction(
      durableEvents,
      options?.runClaim,
      options?.creationClaim,
      [event],
    );
    if (durableEvents.length === 0) return true;
    if (committed.length === 0) return false;
    await this.writeMirror(committed[0]!);
    return true;
  }

  async appendMany(
    events: readonly RuntimeEvent[],
    options?: EventAppendOptions,
  ): Promise<void> {
    await this.appendManyCommitted(events, options);
  }

  async appendManyCommitted(
    events: readonly RuntimeEvent[],
    options?: EventAppendOptions,
  ): Promise<readonly RuntimeEvent[]> {
    const durableEvents = events.filter((event) => !isTransientEvent(event));
    const committed = this.writeTransaction(
      durableEvents,
      options?.runClaim,
      options?.creationClaim,
      events,
    );
    for (const event of committed) {
      await this.writeMirror(event);
    }
    const committedIds = new Set(committed.map((event) => event.id));
    const accepted = events.filter((event) => isTransientEvent(event) || committedIds.has(event.id));
    return accepted;
  }

  claimSessionCreation(input: {
    sessionId: SessionId;
    claimId: string;
    cwd: string;
    time: number;
    leaseDurationMs: number;
  }): { status: "claimed" | "already_exists" | "forbidden" } {
    const claim = this.db.transaction(() => {
      // A store connection is the implicit fence for ordinary session-scoped
      // appends. Never replace its claim in place: doing so would let the stale
      // caller's writes pass under the replacement claim stored in this map.
      if (this.legacySessionReservationExists(input.sessionId)) return { status: "forbidden" as const };
      if (this.ownedCreationClaims.has(input.sessionId)) {
        return { status: "already_exists" as const };
      }
      this.db.query(
        `delete from session_creation_claims where session_id = ? and lease_expires_at <= ?`,
      ).run(input.sessionId, input.time);
      const existing = this.db
        .query<{ found: number }, [string]>(`select 1 as found from sessions where id = ? limit 1`)
        .get(input.sessionId);
      const existingClaim = this.db
        .query<{ found: number }, [string]>(
          `select 1 as found from session_creation_claims where session_id = ? limit 1`,
        )
        .get(input.sessionId);
      if (existing || existingClaim) return { status: "already_exists" as const };
      const owner = this.columnExists("session_creation_claims", "owner");
      this.db.query(
        `insert into session_creation_claims
           (session_id, claim_id, cwd, ${owner ? "owner," : ""} claimed_at, heartbeat_at, lease_expires_at)
         values (?, ?, ?, ${owner ? "'root'," : ""} ?, ?, ?)`,
      ).run(
        input.sessionId,
        input.claimId,
        input.cwd,
        input.time,
        input.time,
        input.time + input.leaseDurationMs,
      );
      return { status: "claimed" as const };
    });
    const result = this.runWithWriteRetry(() => claim());
    if (result.status === "claimed") this.ownedCreationClaims.set(input.sessionId, input.claimId);
    return result;
  }

  renewSessionCreation(input: {
    sessionId: SessionId;
    claimId: string;
    time: number;
    leaseDurationMs: number;
  }): boolean {
    if (this.ownedCreationClaims.get(input.sessionId) !== input.claimId) return false;
    const renewed = this.runWithWriteRetry(() => this.db.query(
      `update session_creation_claims
          set heartbeat_at = ?, lease_expires_at = ?
        where session_id = ? and claim_id = ? and lease_expires_at > ?`,
    ).run(
      input.time,
      input.time + input.leaseDurationMs,
      input.sessionId,
      input.claimId,
      input.time,
    ));
    return renewed.changes === 1;
  }

  releaseSessionCreation(input: { sessionId: SessionId; claimId: string }): void {
    if (this.ownedCreationClaims.get(input.sessionId) !== input.claimId) return;
    this.runWithWriteRetry(() => {
      this.db.query(
        `delete from session_creation_claims where session_id = ? and claim_id = ?`,
      ).run(input.sessionId, input.claimId);
    });
    if (this.ownedCreationClaims.get(input.sessionId) === input.claimId) {
      this.ownedCreationClaims.delete(input.sessionId);
    }
  }

  sessionRunClaim(sessionId: SessionId): { claimId: string; leaseExpiresAt: number } | undefined {
    const row = this.db.query<{ claim_id: string; lease_expires_at: number }, [string]>(
      "select claim_id, lease_expires_at from session_run_claims where session_id = ?",
    ).get(sessionId);
    return row ? { claimId: row.claim_id, leaseExpiresAt: row.lease_expires_at } : undefined;
  }

  claimSessionRun(input: {
    sessionId: SessionId;
    claimId: string;
    sessionAccess?: "root" | "child";
    time: number;
    leaseDurationMs: number;
    respectDispatch?: boolean;
  }): { status: "claimed" | "busy" | "inactive" | "not_found" | "forbidden"; sessionStatus?: string } {
    const claim = this.db.transaction(() => {
      const session = this.db
        .query<{ status: string; parent_session_id: string | null }, [string]>(`select status, parent_session_id from sessions where id = ?`)
        .get(input.sessionId);
      if (!session?.parent_session_id && this.legacySessionReservationExists(input.sessionId)) return { status: "forbidden" as const };
      if (!session) return { status: "not_found" as const };
      if (session.status !== "active") {
        return { status: "inactive" as const, sessionStatus: session.status };
      }
      if (!!session.parent_session_id !== (input.sessionAccess === "child")) return { status: "forbidden" as const };
      // See claimSessionCreation: replacing an owned claim on this connection
      // would erase the identity needed to reject the old operation's appends.
      if (this.ownedRunClaims.has(input.sessionId)) return { status: "busy" as const };
      if (input.respectDispatch) {
        const paused = this.db.query<{ paused: number }, [string]>("select paused from session_dispatch where session_id = ?").get(input.sessionId);
        const queued = this.db.query<{ found: number }, [string]>("select 1 as found from session_inputs where session_id = ? and state != 'settled' limit 1").get(input.sessionId);
        if (paused?.paused || queued) return { status: "busy" as const };
      }
      this.db.query(
        `delete from session_creation_claims where session_id = ? and lease_expires_at <= ?`,
      ).run(input.sessionId, input.time);
      const creationClaim = this.db
        .query<{ found: number }, [string]>(
          `select 1 as found from session_creation_claims where session_id = ? limit 1`,
        )
        .get(input.sessionId);
      if (creationClaim) return { status: "busy" as const };
      const inserted = this.db.query(
        `insert into session_run_claims
           (session_id, claim_id, claimed_at, heartbeat_at, lease_expires_at, input_version)
         values (?, ?, ?, ?, ?, 1)
         on conflict(session_id) do update set
           claim_id = excluded.claim_id,
           claimed_at = excluded.claimed_at,
           heartbeat_at = excluded.heartbeat_at,
           lease_expires_at = excluded.lease_expires_at,
           input_version = excluded.input_version
         where session_run_claims.lease_expires_at <= ?`,
      ).run(
        input.sessionId,
        input.claimId,
        input.time,
        input.time,
        input.time + input.leaseDurationMs,
        input.time,
      );
      return inserted.changes === 1
        ? { status: "claimed" as const }
        : { status: "busy" as const };
    });
    const result = this.runWithWriteRetry(() => claim());
    if (result.status === "claimed") this.ownedRunClaims.set(input.sessionId, input.claimId);
    return result;
  }

  renewSessionRun(input: {
    sessionId: SessionId;
    claimId: string;
    time: number;
    leaseDurationMs: number;
  }): boolean {
    if (this.ownedRunClaims.get(input.sessionId) !== input.claimId) return false;
    const renewed = this.runWithWriteRetry(() => this.db.query(
      `update session_run_claims
          set heartbeat_at = ?, lease_expires_at = ?
        where session_id = ? and claim_id = ? and lease_expires_at > ?`,
    ).run(
      input.time,
      input.time + input.leaseDurationMs,
      input.sessionId,
      input.claimId,
      input.time,
    ));
    return renewed.changes === 1;
  }

  releaseSessionRun(input: { sessionId: SessionId; claimId: string }): void {
    if (this.ownedRunClaims.get(input.sessionId) !== input.claimId) return;
    this.runWithWriteRetry(() => {
      this.db.query(
        `delete from session_run_claims where session_id = ? and claim_id = ?`,
      ).run(input.sessionId, input.claimId);
    });
    if (this.ownedRunClaims.get(input.sessionId) === input.claimId) {
      this.ownedRunClaims.delete(input.sessionId);
    }
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    if (query.afterEventId && query.beforeEventId) {
      throw new TypeError("Event queries cannot combine afterEventId and beforeEventId");
    }
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.sessionId) {
      clauses.push("session_id = $sessionId");
      params.sessionId = query.sessionId;
    }
    if (query.type) {
      clauses.push("type = $type");
      params.type = query.type;
    }
    if (query.afterEventId) {
      const cursorClauses = ["id = $afterEventId"];
      const cursorParams: Record<string, unknown> = { afterEventId: query.afterEventId };
      if (query.sessionId) {
        cursorClauses.push("session_id = $sessionId");
        cursorParams.sessionId = query.sessionId;
      }
      const cursor = this.db
        .query<{ found: number }, any>(
          `select 1 as found from events where ${cursorClauses.join(" and ")} limit 1`,
        )
        .get(cursorParams);
      if (!cursor) throw new UnknownEventCursorError(query.afterEventId);
      clauses.push("seq > (select seq from events where id = $afterEventId)");
      params.afterEventId = query.afterEventId;
    }
    if (query.beforeEventId) {
      const cursorClauses = ["id = $beforeEventId"];
      const cursorParams: Record<string, unknown> = { beforeEventId: query.beforeEventId };
      if (query.sessionId) {
        cursorClauses.push("session_id = $sessionId");
        cursorParams.sessionId = query.sessionId;
      }
      const cursor = this.db
        .query<{ found: number }, any>(
          `select 1 as found from events where ${cursorClauses.join(" and ")} limit 1`,
        )
        .get(cursorParams);
      if (!cursor) throw new UnknownEventCursorError(query.beforeEventId);
      clauses.push("seq < (select seq from events where id = $beforeEventId)");
      params.beforeEventId = query.beforeEventId;
    }

    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const limit = query.limit ?? 500;
    params.limit = limit;

    const orderAndLimit = query.tail && !query.afterEventId
      ? `from (
           select seq, id, type, time, session_id, payload_json
           from events
           ${where}
           order by seq desc
           limit $limit
         )
         order by seq asc`
      : `from events
         ${where}
         order by seq asc
         limit $limit`;

    const rows = this.db
      .query<StoredEventRow, any>(
        `select seq, id, type, time, session_id, ${query.compactRequests
          ? `case when type = 'model.request_prepared' then
               json_remove(json_set(payload_json, '$.contentVersion',
                 coalesce(json_extract(payload_json, '$.contentVersion'), json_extract(payload_json, '$.request.contentVersion'))), '$.request')
             when type = 'message.part_added' and json_extract(payload_json, '$.part.type') = 'tool_result'
               then json_remove(payload_json, '$.part.structuredData')
             else payload_json end as payload_json`
          : "payload_json"}
         ${orderAndLimit}`,
      )
      .all(params);

    return rows.map((row) => this.eventFromRow(row));
  }

  async sessions(): Promise<SessionRow[]> {
    return this.db
      .query<{
        id: string;
        cwd: string;
        title: string | null;
        preview: string | null;
        status: "active" | "archived";
        created_at: number;
        updated_at: number;
        parent_session_id: string | null;
        agent_name: string | null;
        agent_path: string | null;
        agent_policy_json: string | null;
      }, []>(
        `select s.id, s.cwd, s.title, s.status, s.created_at, s.updated_at,
                s.parent_session_id, s.agent_name, s.agent_path, s.agent_policy_json,
                (select coalesce(
                          nullif(json_extract(mp.data_json, '$.displayText'), ''),
                          nullif(json_extract(mp.data_json, '$.text'), '')
                        )
                 from messages m
                 join message_parts mp on mp.message_id = m.id
                 where m.session_id = s.id
                   and m.role = 'user'
                   and mp.type = 'text'
                 order by m.created_event_seq desc, m.created_at desc, m.id desc, mp.ordinal asc
                 limit 1) as preview
         from sessions s
         order by s.updated_at desc, s.id desc`,
      )
      .all()
      .map((row) => ({
        id: row.id as SessionRow["id"],
        cwd: row.cwd,
        ...(row.title ? { title: row.title } : {}),
        ...(row.preview ? { preview: row.preview } : {}),
        ...(!row.parent_session_id && this.legacySessionReservationExists(row.id as SessionId) ? { readOnly: true as const } : {}),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.parent_session_id ? { agent: parseSessionAgentMetadata({
          parentSessionId: row.parent_session_id, name: row.agent_name, path: row.agent_path,
          policy: decodeJson(row.agent_policy_json, undefined),
        }) } : {}),
      }));
  }

  async messages(sessionId: Message["sessionId"]): Promise<Message[]> {
    const messages = this.db
      .query<MessageRow, [string]>(
        `select id, session_id, turn_id, role, parent_id, created_at
         from messages
         where session_id = ?
         order by created_event_seq asc, created_at asc, id asc`,
      )
      .all(sessionId);
    const pendingDeltas = this.pendingMessagePartDeltas(sessionId);

    return messages.map((message) => {
      const parts = this.db
        .query<PartRow, [string]>(
          `select data_json, delta_event_seq
           from message_parts
           where message_id = ?
           order by ordinal asc`,
        )
        .all(message.id)
        .map((row) => {
          let part = decodeJson<MessagePart>(row.data_json, {} as MessagePart);
          for (const delta of pendingDeltas.get(part.id) ?? []) {
            if (delta.seq <= row.delta_event_seq) continue;
            part = applyPartDelta(part, delta.field, delta.delta);
          }
          return part;
        });

      const result: Message = {
        id: message.id as Message["id"],
        sessionId: message.session_id as Message["sessionId"],
        role: message.role,
        parts,
        createdAt: message.created_at as Message["createdAt"],
      };
      if (message.parent_id) {
        result.parentId = message.parent_id as MessageId;
      }
      if (message.turn_id) {
        result.turnId = message.turn_id as TurnId;
      }
      return result;
    });
  }

  async pendingApprovals(sessionId?: ApprovalRow["sessionId"], limit?: number): Promise<ApprovalRow[]> {
    const boundedLimit = limit === undefined ? undefined : Math.max(1, Math.min(10_000, Math.trunc(limit)));
    const limitSql = boundedLimit === undefined ? "" : " limit ?";
    const sql = sessionId
      ? `select * from approvals where status = 'pending' and session_id = ? order by created_at asc${limitSql}`
      : `select * from approvals where status = 'pending' order by created_at asc${limitSql}`;
    const params = [sessionId, boundedLimit].filter((value) => value !== undefined);
    const rows = this.db.query<Record<string, unknown>, any>(sql).all(...params);

    return rows.map((row) => approvalFromRow(row));
  }

  async mutateGoal<T>(
    sessionId: SessionId,
    decide: (snapshot: GoalMutationSnapshot) => GoalMutationDecision<T>,
    options?: EventAppendOptions,
  ): Promise<GoalMutationResult<T>> {
    const run = this.db.transaction(() => {
      const row = this.db
        .query<SessionGoalProjectionRow, [string]>(
          `select session_id, objective, status, token_budget, tokens_used,
                  time_used_seconds, created_at, updated_at, completed_at, last_reason
           from session_goals where session_id = ?`,
        )
        .get(sessionId);
      const updatedEvents = this.db
        .query<StoredEventRow, [string]>(
          `select seq, id, type, time, session_id, payload_json from events
           where session_id = ? and type = 'goal.updated' order by seq asc`,
        )
        .all(sessionId)
        .map((event) => this.eventFromRow(event) as Extract<RuntimeEvent, { type: "goal.updated" }>);
      let goal = row ? sessionGoalFromRow(row) : undefined;
      if (!goal && updatedEvents.length > 0) {
        // Match GoalService's event replay when a derived projection is absent.
        // A clear also removes this row, so inspect the last committed Goal
        // event before recovering an update; never resurrect a cleared ledger.
        const latest = this.db
          .query<{ type: string }, [string]>(
            `select type from events
             where session_id = ? and type in ('goal.updated', 'goal.cleared')
             order by seq desc limit 1`,
          )
          .get(sessionId);
        const update = updatedEvents.at(-1);
        if (latest?.type === "goal.updated" && update) {
          const lastReason = update.payload.reason ?? update.payload.goal.lastReason;
          goal = { ...update.payload.goal, sessionId, ...(lastReason ? { lastReason } : {}) };
        }
      }
      const snapshot: GoalMutationSnapshot = {
        ...(goal ? { goal } : {}),
        updatedEvents,
      };
      const decision = decide(snapshot);
      if (decision && typeof (decision as { then?: unknown }).then === "function") {
        // Observe a rejected async function without ever waiting inside SQLite.
        if (decision instanceof Promise) void decision.catch(() => {});
        throw new TypeError("Goal mutation decisions must be synchronous; thenables are not supported.");
      }
      if (!decision || typeof decision !== "object" || !("value" in decision)) {
        throw new TypeError("Goal mutation must return a synchronous decision with a value.");
      }
      const event = decision.event;
      if (event && ((event.type !== "goal.updated" && event.type !== "goal.cleared") || event.sessionId !== sessionId)) {
        throw new Error("Goal mutation may only append a Goal event for its target session.");
      }
      const events = event
        ? this.writeTransactionEvents([event], options?.runClaim, options?.creationClaim) as GoalMutationEvent[]
        : [];
      return { value: decision.value, events };
    });
    // Acquire the writer reservation before reading, so another connection or
    // process cannot base its decision on the same stale Goal/receipt snapshot.
    const result = this.runWithWriteRetry(() => run.immediate());
    await this.writeMirrors(result.events);
    return result;
  }

  async sessionGoal(sessionId: SessionId): Promise<SessionGoalRow | undefined> {
    return (await this.sessionGoals({ sessionId, limit: 1 }))[0];
  }

  async sessionGoals(query: SessionGoalQuery = {}): Promise<SessionGoalRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.sessionId) {
      clauses.push("session_id = $sessionId");
      params.sessionId = query.sessionId;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<SessionGoalProjectionRow, any>(
        `select session_id, objective, status, token_budget, tokens_used,
                time_used_seconds, created_at, updated_at, completed_at, last_reason
         from session_goals
         ${where}
         order by updated_at desc, session_id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => sessionGoalFromRow(row));
  }

  private writeTransaction(
    events: readonly RuntimeEvent[],
    runClaim?: SessionRunClaimFence,
    creationClaim?: SessionCreationClaimFence,
    fenceEvents: readonly RuntimeEvent[] = events,
  ): RuntimeEvent[] {
    const run = this.db.transaction((items: readonly RuntimeEvent[]) => {
      return this.writeTransactionEvents(items, runClaim, creationClaim, fenceEvents);
    });
    return this.runWithWriteRetry(() => run(events));
  }

  private writeTransactionEvents(
    events: readonly RuntimeEvent[],
    runClaim?: SessionRunClaimFence,
    creationClaim?: SessionCreationClaimFence,
    fenceEvents: readonly RuntimeEvent[] = events,
  ): RuntimeEvent[] {
    this.assertRunClaimFence(runClaim, fenceEvents);
    this.assertCreationClaimFence(creationClaim, fenceEvents);
    for (const event of fenceEvents) {
      if (event.type.startsWith("agent.") || event.type.startsWith("team.")) {
        throw new SessionInputConflictError("Legacy workflow events are read-only");
      }
      this.assertWritableEventTargets(event);
      validateScopedEventSessionIdentity(event);
      this.assertOwnedCreationClaim(event.sessionId);
      this.assertOwnedRunClaim(event.sessionId);
    }
    const committed: RuntimeEvent[] = [];
    for (const event of events) {
      const eventSeq = this.insertEvent(event);
      this.applyProjection(event, eventSeq);
      committed.push(event);
    }
    return committed;
  }

  private assertWritableEventTargets(event: RuntimeEvent): void {
    const targets = new Set<string>();
    const add = (sessionId: string | null | undefined): void => { if (sessionId) targets.add(sessionId); };
    const message = (messageId: string): void => {
      add(this.db.query<{ session_id: string }, [string]>("select session_id from messages where id = ?").get(messageId)?.session_id);
    };
    add(event.sessionId);
    if (event.type === "message.created" || event.type === "message.part_added" || event.type === "message.part_delta") {
      message(event.payload.messageId);
      if (event.type === "message.part_added") {
        add(event.payload.part.sessionId);
        message(event.payload.part.messageId);
      }
      const partId = event.type === "message.part_added" ? event.payload.part.id
        : event.type === "message.part_delta" ? event.payload.partId : undefined;
      if (partId) add(this.db.query<{ session_id: string }, [string]>("select session_id from message_parts where id = ?").get(partId)?.session_id);
    } else if (event.type.startsWith("tool.")) {
      add(this.db.query<{ session_id: string | null }, [string]>("select session_id from tool_calls where id = ?").get((event as ToolEvent).payload.callId)?.session_id);
    } else if (event.type === "approval.requested" || event.type === "approval.resolved") {
      add(this.db.query<{ session_id: string | null }, [string]>("select session_id from approvals where id = ?").get(event.payload.approvalId)?.session_id);
    } else if (event.type === "turn.completed") {
      for (const row of this.db.query<{ session_id: string }, [string]>("select distinct session_id from messages where turn_id = ?").all(event.payload.turnId)) add(row.session_id);
    }
    for (const id of targets) {
      const sessionId = id as SessionId;
      const session = this.readSession(sessionId);
      if (session?.readOnly || (!session && this.legacySessionReservationExists(sessionId))) throw new SessionAccessError(sessionId);
    }
  }

  private assertCreationClaimFence(
    creationClaim: SessionCreationClaimFence | undefined,
    events: readonly RuntimeEvent[],
  ): void {
    if (!creationClaim) return;
    if (events.some((event) => event.sessionId !== creationClaim.sessionId)) {
      throw new SessionCreationClaimConflictError(creationClaim.sessionId);
    }
    const durableClaim = this.db
      .query<{ claim_id: string; lease_expires_at: number }, [string]>(
        `select claim_id, lease_expires_at from session_creation_claims where session_id = ?`,
      )
      .get(creationClaim.sessionId);
    if (
      this.ownedCreationClaims.get(creationClaim.sessionId) !== creationClaim.claimId
      || !durableClaim
      || durableClaim.claim_id !== creationClaim.claimId
      || durableClaim.lease_expires_at <= Date.now()
    ) {
      throw new SessionCreationClaimConflictError(creationClaim.sessionId);
    }
  }

  private assertRunClaimFence(
    runClaim: SessionRunClaimFence | undefined,
    events: readonly RuntimeEvent[],
  ): void {
    if (!runClaim) return;
    const durableClaim = this.db
      .query<{ claim_id: string; lease_expires_at: number }, [string]>(
        `select claim_id, lease_expires_at from session_run_claims where session_id = ?`,
      )
      .get(runClaim.sessionId);
    if (
      this.ownedRunClaims.get(runClaim.sessionId) !== runClaim.claimId
      || !durableClaim
      || durableClaim.claim_id !== runClaim.claimId
      || durableClaim.lease_expires_at <= Date.now()
    ) {
      throw new SessionRunClaimConflictError(runClaim.sessionId);
    }
    for (const event of events) {
      if (event.sessionId !== runClaim.sessionId) {
        throw new SessionRunClaimConflictError(runClaim.sessionId);
      }
    }
  }

  private assertOwnedCreationClaim(sessionId: SessionId | undefined): void {
    if (!sessionId) return;
    const ownedClaimId = this.ownedCreationClaims.get(sessionId);
    if (!ownedClaimId) return;
    const durableClaim = this.db
      .query<{ claim_id: string; lease_expires_at: number }, [string]>(
        `select claim_id, lease_expires_at from session_creation_claims where session_id = ?`,
      )
      .get(sessionId);
    if (
      !durableClaim
      || durableClaim.claim_id !== ownedClaimId
      || durableClaim.lease_expires_at <= Date.now()
    ) {
      throw new SessionCreationClaimConflictError(sessionId);
    }
  }

  private assertOwnedRunClaim(sessionId: SessionId | undefined): void {
    if (!sessionId) return;
    const ownedClaimId = this.ownedRunClaims.get(sessionId);
    if (!ownedClaimId) return;
    const durableClaim = this.db
      .query<{ claim_id: string; lease_expires_at: number }, [string]>(
        `select claim_id, lease_expires_at from session_run_claims where session_id = ?`,
      )
      .get(sessionId);
    if (
      !durableClaim
      || durableClaim.claim_id !== ownedClaimId
      || durableClaim.lease_expires_at <= Date.now()
    ) {
      throw new SessionRunClaimConflictError(sessionId);
    }
  }

  async reconcileStaleTurns(input: StaleTurnRecoveryInput): Promise<RuntimeEvent[]> {
    const status = input.status ?? "failed";
    const reason = input.reason ?? "stale_turn_recovered";
    const now = (input.now ?? Date.now()) as TimestampMs;
    const reconcile = this.db.transaction(() => {
      const rows = this.db
        .query<{
          session_id: string;
          turn_seq: number | null;
          turn_time: number | null;
          turn_id: string | null;
          status_seq: number | null;
          status_time: number | null;
          runtime_status: string | null;
          completion_seq: number | null;
          completion_time: number | null;
        }, { now: number }>(
          `with latest_turns as (
             select event.session_id,
                    event.seq,
                    event.time,
                    json_extract(event.payload_json, '$.turnId') as turn_id,
                    row_number() over (partition by event.session_id order by event.seq desc) as ordinal
               from events event
              where event.type = 'turn.started'
                and event.session_id is not null
           ),
           latest_statuses as (
             select event.session_id,
                    event.seq,
                    event.time,
                    json_extract(event.payload_json, '$.status') as runtime_status,
                    row_number() over (partition by event.session_id order by event.seq desc) as ordinal
               from events event
              where event.type = 'session.status_changed'
                and event.session_id is not null
           )
           select session.id as session_id,
                  turn.seq as turn_seq,
                  turn.time as turn_time,
                  turn.turn_id as turn_id,
                  runtime.seq as status_seq,
                  runtime.time as status_time,
                  runtime.runtime_status as runtime_status,
                  (
                    select max(completed.seq)
                      from events completed
                     where completed.session_id = session.id
                       and completed.type = 'turn.completed'
                       and json_extract(completed.payload_json, '$.turnId') = turn.turn_id
                  ) as completion_seq,
                  (
                    select max(completed.time)
                      from events completed
                     where completed.session_id = session.id
                       and completed.type = 'turn.completed'
                       and json_extract(completed.payload_json, '$.turnId') = turn.turn_id
                  ) as completion_time
             from sessions session
             left join latest_turns turn
               on turn.session_id = session.id
              and turn.ordinal = 1
             left join latest_statuses runtime
               on runtime.session_id = session.id
              and runtime.ordinal = 1
            where session.status = 'active'
              and not exists (
                select 1
                  from session_creation_claims creation
                 where creation.session_id = session.id
                   and creation.lease_expires_at > $now
              )
              and not exists (
                select 1
                  from session_run_claims run
                 where run.session_id = session.id
                   and run.lease_expires_at > $now
              )
            order by coalesce(turn.seq, runtime.seq) asc`,
        )
        .all({ now: Number(now) });

      const events: RuntimeEvent[] = [];
      for (const row of rows) {
        const sessionId = row.session_id as SessionId;
        if (this.readSession(sessionId)?.readOnly) continue;
        if (
          this.ownedCreationClaims.has(sessionId)
          || this.ownedRunClaims.has(sessionId)
        ) continue;

        const transientStatus = row.runtime_status === "running"
          || row.runtime_status === "waiting_for_approval"
          || row.runtime_status === "cancelling";
        const base = { time: now, sessionId };

        if (row.turn_id === null || row.turn_seq === null || row.turn_time === null) {
          // Runtime publishes the prompt-level running state before the runner
          // can append turn.started. A crash in that window still needs a
          // terminal recovery event, but there is no turn identity to attach.
          if (
            !transientStatus
            || row.status_time === null
            || row.status_time >= input.staleBefore
          ) continue;
          events.push({
            ...base,
            id: input.createId("event"),
            type: "session.status_changed",
            payload: { sessionId, status, reason },
          });
          continue;
        }

        const lastActivityAt = Math.max(
          row.turn_time,
          row.status_time ?? Number.NEGATIVE_INFINITY,
          row.completion_time ?? Number.NEGATIVE_INFINITY,
        );
        if (lastActivityAt >= input.staleBefore) continue;

        const statusAfterTurn = row.status_seq !== null && row.status_seq > row.turn_seq;
        const turnId = row.turn_id as TurnId;

        if (row.completion_seq === null) {
          // A later terminal/idle session event proves this historic incomplete
          // turn is no longer the active prompt. Only a transient latest state
          // (or no status written after the turn) is recoverable.
          if (statusAfterTurn && !transientStatus) continue;
          events.push({
            ...base,
            id: input.createId("event"),
            type: "turn.completed",
            payload: { turnId, status },
          });
        } else if (!transientStatus) {
          // A completed internal turn can still belong to a multi-turn prompt.
          // Recover only when the latest session state proves the prompt was
          // left transient; never infer idle directly from turn.completed.
          continue;
        }

        events.push({
          ...base,
          id: input.createId("event"),
          type: "session.status_changed",
          payload: {
            sessionId,
            status,
            turnId,
            reason,
          },
        });
      }

      if (events.length > 0) this.writeTransactionEvents(events);
      return events;
    });
    const events = this.runWithWriteRetry(() => reconcile());
    if (events.length === 0) return [];
    await this.writeMirrors(events);
    return events;
  }

  private runWithWriteRetry<T>(action: () => T): T {
    const attempts = Math.max(1, Math.trunc(this.options.writeRetryAttempts ?? 6));
    let delayMs = 25;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return action();
      } catch (error) {
        if (attempt >= attempts || !isSqliteBusyError(error)) throw error;
        sleepSync(delayMs);
        delayMs = Math.min(delayMs * 2, 500);
      }
    }
    throw new Error("SQLite write retry exhausted");
  }

  private async writeMirror(event: RuntimeEvent): Promise<void> {
    if (!this.options.mirror) return;
    try {
      await this.options.mirror.write(event);
    } catch (error) {
      this.options.onMirrorError?.(error, event);
    }
  }

  private async writeMirrors(events: readonly RuntimeEvent[]): Promise<void> {
    for (const event of events) {
      await this.writeMirror(event);
    }
  }

  private insertEvent(event: RuntimeEvent): number {
    const seq = this.nextEventSeq();
    this.db
      .query(
        `insert into events (seq, id, type, time, session_id, payload_json)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seq,
        event.id,
        event.type,
        event.time,
        event.sessionId ?? null,
        encodeJson(event.payload),
      );
    return seq;
  }

  private backfillScopedEventSessionIds(): void {
    this.db.exec(`
      update events
         set session_id = case
           when type like 'session.%' and json_type(payload_json, '$.sessionId') = 'text'
             then json_extract(payload_json, '$.sessionId')
           when type = 'goal.updated' and json_type(payload_json, '$.goal.sessionId') = 'text'
             then json_extract(payload_json, '$.goal.sessionId')
           when type = 'goal.cleared' and json_type(payload_json, '$.sessionId') = 'text'
             then json_extract(payload_json, '$.sessionId')
           when type = 'goal.cleared' and json_type(payload_json, '$.previousGoal.sessionId') = 'text'
             then json_extract(payload_json, '$.previousGoal.sessionId')
           else session_id
         end
       where session_id is null
         and json_valid(payload_json)
         and (
           (type like 'session.%' and json_type(payload_json, '$.sessionId') = 'text')
           or (type = 'goal.updated' and json_type(payload_json, '$.goal.sessionId') = 'text')
           or (type = 'goal.cleared' and json_type(payload_json, '$.sessionId') = 'text')
           or (type = 'goal.cleared' and json_type(payload_json, '$.previousGoal.sessionId') = 'text')
         )
    `);
  }

  private migrateEventSequence(): void {
    const columns = this.db.query<{ name: string }, []>(`pragma table_info(events)`).all();
    if (!columns.some((column) => column.name === "seq")) {
      this.db.exec(`alter table events add column seq integer`);
    }
    this.db.exec(`update events set seq = rowid where seq is null`);
    this.db.exec(`create unique index if not exists events_seq_idx on events(seq)`);
    this.db.exec(`create unique index if not exists events_id_idx on events(id)`);
    this.db.exec(`create index if not exists events_session_seq_idx on events(session_id, seq)`);
    this.db.exec(`create index if not exists events_session_type_seq_idx on events(session_id, type, seq)`);
    this.db.exec(`create index if not exists events_type_seq_idx on events(type, seq)`);
  }

  private migrateApprovalSchema(): void {
    this.addColumnIfMissing("approvals", "metadata_json", "text");
    this.addColumnIfMissing("approvals", "max_approval_scope", "text");
  }

  private migrateMessageSchema(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        create table if not exists schema_migrations (
          name text primary key
        )
      `);
      this.addColumnIfMissing("messages", "turn_id", "text");
      this.addColumnIfMissing(
        "message_parts",
        "delta_event_seq",
        "integer not null default 0",
      );
      const deltaCheckpointMigration = "message_part_delta_checkpoints_v1";
      const checkpointBackfilled = this.db
        .query<{ found: number }, [string]>(
          `select 1 as found from schema_migrations where name = ? limit 1`,
        )
        .get(deltaCheckpointMigration);
      if (!checkpointBackfilled) {
        this.db.exec(`
          update message_parts
             set delta_event_seq = coalesce((
               select max(events.seq)
                 from events
                where events.type = 'message.part_delta'
                  and json_extract(events.payload_json, '$.partId') = message_parts.id
             ), 0)
        `);
        this.db.query(`insert into schema_migrations (name) values (?)`).run(deltaCheckpointMigration);
      }
      this.db.exec(`create index if not exists messages_turn_idx on messages(turn_id)`);
    });
    migrate();
  }

  private migrateMessageCreationSequence(): void {
    const migrate = this.db.transaction(() => {
      this.addColumnIfMissing("messages", "created_event_seq", "integer");
      const marker = "message_creation_event_sequence_v1";
      const alreadyMigrated = this.db
        .query<{ found: number }, [string]>(
          `select 1 as found from schema_migrations where name = ? limit 1`,
        )
        .get(marker);
      if (!alreadyMigrated) {
        // Session identity migration must finish first. Only durable creation
        // events can establish causal order; timestamps and random IDs cannot.
        this.db.exec(`
          update messages
             set created_event_seq = creation.seq
            from (
              select session_id,
                     json_extract(payload_json, '$.messageId') as message_id,
                     min(seq) as seq
                from events
               where type = 'message.created'
                 and json_valid(payload_json)
                 and json_type(payload_json, '$.messageId') = 'text'
               group by session_id, json_extract(payload_json, '$.messageId')
            ) as creation
           where messages.id = creation.message_id
             and messages.session_id = creation.session_id
             and messages.created_event_seq is null
        `);
        // Incomplete legacy projections retain NULL: they form a stable prefix
        // in their previous timestamp/ID order, without inventing event history.
        this.db.query(`insert into schema_migrations (name) values (?)`).run(marker);
      }
      this.db.exec(`create index if not exists messages_session_created_seq_idx
        on messages(session_id, created_event_seq, created_at, id)`);
      // Older writers insert the event before its projection in the same
      // transaction but omit created_event_seq. Keep their new messages in
      // causal order without rebinding existing, unanchored legacy rows.
      this.db.exec(`
        create trigger if not exists messages_created_event_seq_compat
        after insert on messages
        when new.created_event_seq is null
        begin
          update messages
             set created_event_seq = (
               select min(seq)
                 from events
                where session_id = new.session_id
                  and type = 'message.created'
                  and json_valid(payload_json)
                  and json_type(payload_json, '$.messageId') = 'text'
                  and json_extract(payload_json, '$.messageId') = new.id
             )
           where id = new.id;
        end
      `);
    });
    migrate();
  }

  private prepareSessionOnlyReplacementColumns(): void {
    for (const [table, column] of [
      ["events", "session_id"],
      ["messages", "session_id"],
      ["tool_calls", "session_id"],
      ["approvals", "session_id"],
      ["agent_runs", "session_id"],
      ["agent_runs", "parent_session_id"],
      ["agent_runs", "child_session_id"],
      ["agent_tasks", "parent_session_id"],
      ["agent_tasks", "child_session_id"],
      ["agent_mailbox", "recipient_session_id"],
      ["team_members", "child_session_id"],
      ["team_message_deliveries", "child_session_id"],
    ] as const) {
      if (this.tableExists(table)) this.addColumnIfMissing(table, column, "text");
    }
  }

  private migrateMailboxRecipientSessionSchema(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        create table if not exists schema_migrations (
          name text primary key
        )
      `);
      const marker = "mailbox_recipient_session_v1";
      const hasChildSessionColumn = this.columnExists("agent_mailbox", "child_session_id");
      const alreadyMigrated = this.db
        .query<{ found: number }, [string]>(
          `select 1 as found from schema_migrations where name = ? limit 1`,
        )
        .get(marker);
      const payloadConflict = this.db
        .query<{ id: string; child_session_id: string; recipient_session_id: string }, []>(
          `select id,
                  json_extract(payload_json, '$.childSessionId') as child_session_id,
                  json_extract(payload_json, '$.recipientSessionId') as recipient_session_id
             from events
            where type = 'agent.message_queued'
              and json_type(payload_json, '$.childSessionId') = 'text'
              and json_type(payload_json, '$.recipientSessionId') = 'text'
              and json_extract(payload_json, '$.childSessionId')
                    <> json_extract(payload_json, '$.recipientSessionId')
            limit 1`,
        )
        .get();
      if (payloadConflict) {
        throw new Error(
          `Cannot migrate mailbox event ${payloadConflict.id}: child session ${payloadConflict.child_session_id} conflicts with recipient session ${payloadConflict.recipient_session_id}.`,
        );
      }
      if (alreadyMigrated && !hasChildSessionColumn) return;

      if (hasChildSessionColumn) {
        const conflict = this.db
          .query<{ id: string; child_session_id: string; recipient_session_id: string }, []>(
            `select id, child_session_id, recipient_session_id
               from agent_mailbox
              where child_session_id is not null
                and recipient_session_id is not null
                and child_session_id <> recipient_session_id
              limit 1`,
          )
          .get();
        if (conflict) {
          throw new Error(
            `Cannot migrate mailbox message ${conflict.id}: child session ${conflict.child_session_id} conflicts with recipient session ${conflict.recipient_session_id}.`,
          );
        }
        this.db.exec(`
          update agent_mailbox
             set recipient_session_id = coalesce(recipient_session_id, child_session_id)
           where child_session_id is not null
        `);
        const legacyIndexes = this.db
          .query<{ name: string }, []>(
            `select name
               from sqlite_master
              where type = 'index'
                and tbl_name = 'agent_mailbox'
                and sql is not null
                and lower(sql) like '%child_session_id%'`,
          )
          .all();
        for (const index of legacyIndexes) {
          this.db.exec(`drop index if exists "${index.name.replaceAll('"', '""')}"`);
        }
        this.dropColumnIfPresent("agent_mailbox", "child_session_id");
      }
      this.db.query(`insert or ignore into schema_migrations (name) values (?)`).run(marker);
    });
    migrate();
  }

  /**
   * One-way compatibility migration for databases created before SessionId
   * became the sole conversation identity. The legacy identifiers are used
   * only long enough to prove a lossless one-to-one mapping and backfill any
   * missing SessionId values; all legacy columns are then removed atomically.
   */
  private migrateLegacyThreadSchema(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        create table if not exists schema_migrations (
          name text primary key
        )
      `);

      const marker = "session_only_schema_v1";
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
        ["agent_mailbox", "child_thread_id"],
        ["team_members", "child_thread_id"],
        ["team_message_deliveries", "child_thread_id"],
      ] as const;
      this.prepareSessionOnlyReplacementColumns();
      const hasLegacyGoalTable = this.tableExists("thread_goals");
      const hasLegacyColumns = legacyColumns.some(([table, column]) => this.columnExists(table, column));
      const legacyPayloadIdentityPaths = [
        ["threadId", "$.threadId"],
        ["parentThreadId", "$.parentThreadId"],
        ["childThreadId", "$.childThreadId"],
        ["recipientThreadId", "$.recipientThreadId"],
        ["goal.threadId", "$.goal.threadId"],
        ["previousGoal.threadId", "$.previousGoal.threadId"],
      ] as const;
      const legacyPayloadIdentities = legacyPayloadIdentityPaths
        .map(([field, path]) => `
          select id as event_id, '${field}' as field,
                 json_extract(payload_json, '${path}') as legacy_id
            from events
           where json_type(payload_json, '${path}') = 'text'`)
        .join(" union all ");
      const hasLegacyPayloads = this.db
        .query<{ found: number }, []>(
          `select 1 as found from (${legacyPayloadIdentities}) limit 1`,
        )
        .get() !== null;
      const hasLegacySessionIdentities = this.tableExists("legacy_session_identities");
      const legacyPayloadMappingsAreComplete = !hasLegacyPayloads || (
        hasLegacySessionIdentities
        && this.db
          .query<{ found: number }, []>(
            `select 1 as found
               from (${legacyPayloadIdentities}) as payload_identity
               left join legacy_session_identities as identity
                 on identity.legacy_id = payload_identity.legacy_id
              where identity.session_id is null
              limit 1`,
          )
          .get() === null
      );
      const alreadyMigrated = this.db
        .query<{ found: number }, [string]>(
          `select 1 as found from schema_migrations where name = ? limit 1`,
        )
        .get(marker);
      if (
        alreadyMigrated
        && !hasLegacyGoalTable
        && !hasLegacyColumns
        && legacyPayloadMappingsAreComplete
      ) return;

      const identityPairs: string[] = [];
      if (hasLegacyGoalTable || hasLegacyColumns || hasLegacyPayloads || hasLegacySessionIdentities) {
        this.db.exec(`
          create table if not exists legacy_session_identities (
            legacy_id text primary key,
            session_id text not null unique
          )
        `);
        identityPairs.push(
          `select legacy_id, session_id from legacy_session_identities`,
        );
      }
      const addColumnPair = (
        table: string,
        legacyColumn: string,
        sessionColumn: string,
      ): void => {
        if (!this.columnExists(table, legacyColumn) || !this.columnExists(table, sessionColumn)) return;
        identityPairs.push(
          `select ${legacyColumn} as legacy_id, ${sessionColumn} as session_id
             from ${table}
            where ${legacyColumn} is not null and ${sessionColumn} is not null`,
        );
      };
      addColumnPair("events", "thread_id", "session_id");
      addColumnPair("messages", "thread_id", "session_id");
      addColumnPair("tool_calls", "thread_id", "session_id");
      addColumnPair("approvals", "thread_id", "session_id");
      addColumnPair("agent_runs", "thread_id", "session_id");
      addColumnPair("agent_runs", "parent_thread_id", "parent_session_id");
      addColumnPair("agent_runs", "child_thread_id", "child_session_id");
      addColumnPair("agent_tasks", "parent_thread_id", "parent_session_id");
      addColumnPair("agent_tasks", "child_thread_id", "child_session_id");
      addColumnPair("agent_mailbox", "child_thread_id", "recipient_session_id");
      addColumnPair("team_members", "child_thread_id", "child_session_id");
      addColumnPair("team_message_deliveries", "child_thread_id", "child_session_id");
      if (hasLegacyGoalTable) {
        this.addColumnIfMissing("thread_goals", "session_id", "text");
        this.addColumnIfMissing("thread_goals", "token_budget", "integer");
        this.addColumnIfMissing("thread_goals", "tokens_used", "integer not null default 0");
        this.addColumnIfMissing("thread_goals", "time_used_seconds", "real not null default 0");
        this.addColumnIfMissing("thread_goals", "completed_at", "integer");
        this.addColumnIfMissing("thread_goals", "last_reason", "text");
        addColumnPair("thread_goals", "thread_id", "session_id");
      }
      if (this.columnExists("events", "thread_id")) {
        for (const sessionPath of [
          "$.sessionId",
          "$.goal.sessionId",
          "$.previousGoal.sessionId",
        ] as const) {
          identityPairs.push(
            `select thread_id as legacy_id,
                    json_extract(payload_json, '${sessionPath}') as session_id
               from events
              where thread_id is not null
                and json_type(payload_json, '${sessionPath}') = 'text'`,
          );
        }
      }
      for (const [legacyPath, sessionPath] of [
        ["$.threadId", "$.sessionId"],
        ["$.goal.threadId", "$.goal.sessionId"],
        ["$.previousGoal.threadId", "$.previousGoal.sessionId"],
        ["$.parentThreadId", "$.parentSessionId"],
        ["$.childThreadId", "$.childSessionId"],
        ["$.recipientThreadId", "$.recipientSessionId"],
      ] as const) {
        identityPairs.push(
          `select json_extract(payload_json, '${legacyPath}') as legacy_id,
                  json_extract(payload_json, '${sessionPath}') as session_id
             from events
            where json_type(payload_json, '${legacyPath}') = 'text'
          and json_type(payload_json, '${sessionPath}') = 'text'`,
        );
      }
      identityPairs.push(
        `select json_extract(payload_json, '$.childThreadId') as legacy_id,
                json_extract(payload_json, '$.recipientSessionId') as session_id
           from events
          where type = 'agent.message_queued'
            and json_type(payload_json, '$.childThreadId') = 'text'
            and json_type(payload_json, '$.recipientSessionId') = 'text'`,
      );
      for (const legacyPath of [
        "$.threadId",
        "$.goal.threadId",
        "$.previousGoal.threadId",
      ] as const) {
        identityPairs.push(
          `select json_extract(payload_json, '${legacyPath}') as legacy_id,
                  session_id
             from events
            where json_type(payload_json, '${legacyPath}') = 'text'
              and session_id is not null`,
        );
      }

      this.db.exec(`
        drop table if exists temp._legacy_thread_sessions;
        create temp table _legacy_thread_sessions (
          legacy_id text primary key,
          session_id text not null unique
        )
      `);
      if (identityPairs.length > 0) {
        const union = identityPairs.join(" union all ");
        const ambiguousLegacy = this.db
          .query<{ legacy_id: string; session_ids: string }, []>(
            `select legacy_id, group_concat(distinct session_id) as session_ids
               from (${union})
              group by legacy_id
             having count(distinct session_id) > 1
              limit 1`,
          )
          .get();
        if (ambiguousLegacy) {
          throw new Error(
            `Cannot migrate legacy conversation ${ambiguousLegacy.legacy_id}: it maps to multiple sessions (${ambiguousLegacy.session_ids}).`,
          );
        }
        const ambiguousSession = this.db
          .query<{ session_id: string; legacy_ids: string }, []>(
            `select session_id, group_concat(distinct legacy_id) as legacy_ids
               from (${union})
              group by session_id
             having count(distinct legacy_id) > 1
              limit 1`,
          )
          .get();
        if (ambiguousSession) {
          throw new Error(
            `Cannot migrate session ${ambiguousSession.session_id}: it owns multiple legacy conversations (${ambiguousSession.legacy_ids}).`,
          );
        }

        this.db.exec(`
          insert into _legacy_thread_sessions (legacy_id, session_id)
          select legacy_id, min(session_id)
            from (${union})
           group by legacy_id
        `);
      }

      const unresolvedPayloadIdentity = this.db
        .query<{ event_id: string; field: string; legacy_id: string }, []>(
          `select payload_identity.event_id, payload_identity.field, payload_identity.legacy_id
             from (${legacyPayloadIdentities}) as payload_identity
             left join _legacy_thread_sessions as identity
               on identity.legacy_id = payload_identity.legacy_id
            where identity.session_id is null
            limit 1`,
        )
        .get();
      if (unresolvedPayloadIdentity) {
        throw new Error(
          `Cannot migrate legacy event ${unresolvedPayloadIdentity.event_id}: ${unresolvedPayloadIdentity.field} value ${unresolvedPayloadIdentity.legacy_id} has no unambiguous SessionId mapping.`,
        );
      }
      if (this.tableExists("legacy_session_identities")) {
        this.db.exec(`
          insert into legacy_session_identities (legacy_id, session_id)
          select legacy_id, session_id from _legacy_thread_sessions
          where true
          on conflict(legacy_id) do update set session_id = excluded.session_id
        `);
      }

      const backfill = (
        table: string,
        legacyColumn: string,
        sessionColumn: string,
      ): void => {
        if (!this.columnExists(table, legacyColumn) || !this.columnExists(table, sessionColumn)) return;
        this.db.exec(`
          update ${table}
             set ${sessionColumn} = coalesce(
               ${sessionColumn},
               (select session_id from _legacy_thread_sessions where legacy_id = ${table}.${legacyColumn})
             )
           where ${legacyColumn} is not null
        `);
        const unresolved = this.db
          .query<{ count: number }, []>(
            `select count(*) as count
               from ${table}
              where ${legacyColumn} is not null and ${sessionColumn} is null`,
          )
          .get()?.count ?? 0;
        if (unresolved > 0) {
          throw new Error(
            `Cannot migrate ${unresolved} ${table} row(s): ${legacyColumn} has no unambiguous SessionId mapping.`,
          );
        }
      };
      backfill("events", "thread_id", "session_id");
      backfill("messages", "thread_id", "session_id");
      backfill("tool_calls", "thread_id", "session_id");
      backfill("approvals", "thread_id", "session_id");
      backfill("agent_runs", "thread_id", "session_id");
      backfill("agent_runs", "parent_thread_id", "parent_session_id");
      backfill("agent_runs", "child_thread_id", "child_session_id");
      backfill("agent_tasks", "parent_thread_id", "parent_session_id");
      backfill("agent_tasks", "child_thread_id", "child_session_id");
      backfill("agent_mailbox", "child_thread_id", "recipient_session_id");
      backfill("team_members", "child_thread_id", "child_session_id");
      backfill("team_message_deliveries", "child_thread_id", "child_session_id");
      if (hasLegacyGoalTable) backfill("thread_goals", "thread_id", "session_id");

      if (hasLegacyGoalTable) {
        const legacyGoals = this.db
          .query<{
            thread_id: string;
            session_id: string | null;
            objective: string;
            status: string;
            token_budget: number | null;
            tokens_used: number;
            time_used_seconds: number;
            created_at: number;
            updated_at: number;
            completed_at: number | null;
            last_reason: string | null;
          }, []>(
            `select thread_id, session_id, objective, status, token_budget, tokens_used,
                    time_used_seconds, created_at, updated_at, completed_at, last_reason
               from thread_goals`,
          )
          .all();
        const sessions = new Set<string>();
        for (const goal of legacyGoals) {
          if (!goal.session_id) {
            throw new Error(`Cannot migrate legacy goal ${goal.thread_id}: no SessionId mapping exists.`);
          }
          if (sessions.has(goal.session_id)) {
            throw new Error(
              `Cannot migrate legacy goals: session ${goal.session_id} owns more than one goal.`,
            );
          }
          sessions.add(goal.session_id);
          this.db
            .query(
              `insert into session_goals
                 (session_id, objective, status, token_budget, tokens_used, time_used_seconds,
                  created_at, updated_at, completed_at, last_reason)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               on conflict(session_id) do update set
                 objective = excluded.objective,
                 status = excluded.status,
                 token_budget = excluded.token_budget,
                 tokens_used = excluded.tokens_used,
                 time_used_seconds = excluded.time_used_seconds,
                 created_at = excluded.created_at,
                 updated_at = excluded.updated_at,
                 completed_at = excluded.completed_at,
                 last_reason = excluded.last_reason
               where excluded.updated_at >= session_goals.updated_at`,
            )
            .run(
              goal.session_id,
              goal.objective,
              goal.status,
              goal.token_budget,
              goal.tokens_used,
              goal.time_used_seconds,
              goal.created_at,
              goal.updated_at,
              goal.completed_at,
              goal.last_reason,
            );
        }
      }

      const legacyIndexes = this.db
        .query<{ name: string }, []>(
          `select name
             from sqlite_master
            where type = 'index'
              and sql is not null
              and (lower(name) like '%thread%' or lower(sql) like '%thread%')`,
        )
        .all();
      for (const index of legacyIndexes) {
        this.db.exec(`drop index if exists "${index.name.replaceAll('"', '""')}"`);
      }
      for (const [table, column] of legacyColumns) {
        this.dropColumnIfPresent(table, column);
      }
      if (hasLegacyGoalTable) this.db.exec(`drop table thread_goals`);
      this.db.exec(`drop table if exists temp._legacy_thread_sessions`);
      this.db.query(`insert or ignore into schema_migrations (name) values (?)`).run(marker);
    });
    migrate();
  }

  private migrateGoalSchema(): void {
    this.db.exec(`
      create table if not exists session_goals (
        session_id text not null primary key,
        objective text not null,
        status text not null,
        token_budget integer,
        tokens_used integer not null default 0,
        time_used_seconds real not null default 0,
        created_at integer not null,
        updated_at integer not null,
        completed_at integer,
        last_reason text
      )
    `);
    this.addColumnIfMissing("session_goals", "token_budget", "integer");
    this.addColumnIfMissing("session_goals", "tokens_used", "integer not null default 0");
    this.addColumnIfMissing("session_goals", "time_used_seconds", "real not null default 0");
    this.addColumnIfMissing("session_goals", "completed_at", "integer");
    this.addColumnIfMissing("session_goals", "last_reason", "text");
    this.db.exec(`create index if not exists session_goals_status_idx on session_goals(status, updated_at)`);
  }

  private migrateSessionClaimSchema(): void {
    this.db.exec(`
      create table if not exists session_creation_claims (
        session_id text primary key,
        claim_id text not null unique,
        cwd text not null,
        claimed_at integer not null,
        heartbeat_at integer not null,
        lease_expires_at integer not null
      )
    `);
    this.addColumnIfMissing("session_creation_claims", "heartbeat_at", "integer");
    this.addColumnIfMissing("session_creation_claims", "lease_expires_at", "integer");
    this.db.exec(`update session_creation_claims set heartbeat_at = coalesce(heartbeat_at, claimed_at)`);
    this.db.exec(`update session_creation_claims set lease_expires_at = coalesce(lease_expires_at, 0)`);
    this.db.exec(`
      create table if not exists session_run_claims (
        session_id text primary key,
        claim_id text not null unique,
        claimed_at integer not null,
        heartbeat_at integer not null,
        lease_expires_at integer not null
      )
    `);
    this.addColumnIfMissing("session_run_claims", "heartbeat_at", "integer");
    this.addColumnIfMissing("session_run_claims", "lease_expires_at", "integer");
    this.db.exec(`update session_run_claims set heartbeat_at = coalesce(heartbeat_at, claimed_at)`);
    this.db.exec(`update session_run_claims set lease_expires_at = coalesce(lease_expires_at, 0)`);
  }

  /** Old workflow identities remain reserved, including references without a Session row. */
  private legacySessionReservationExists(sessionId: SessionId): boolean {
    const leadPath = this.columnExists("teams", "lead_path")
      ? `(select lead_path from teams where id = m.team_id)` : "null";
    const recipientIsLead = this.columnExists("teams", "session_id") && this.columnExists("teams", "lead_path")
      ? "exists (select 1 from teams t where t.session_id = r.recipient_session_id and t.lead_path = r.path)" : "0";
    const checks: string[] = [];
    const parameters: string[] = [];
    for (const [table, column] of [["agent_tasks", "child_session_id"], ["agent_runs", "child_session_id"]] as const) {
      if (!this.columnExists(table, column)) continue;
      checks.push(`exists (select 1 from ${table} where ${column} = ?)`);
      parameters.push(sessionId);
    }
    if (this.columnExists("agent_mailbox", "recipient_session_id")) {
      checks.push(`exists (select 1 from agent_mailbox r where r.recipient_session_id = ?
        and r.path <> '/root' and not (${recipientIsLead}))`);
      parameters.push(sessionId);
    }
    if (this.columnExists("team_members", "child_session_id")) {
      checks.push(`exists (select 1 from team_members m where m.child_session_id = ?
        and m.path <> coalesce(${leadPath},
          (select json_extract(t.payload_json, '$.leadPath') from events t where t.type = 'team.created'
            and json_extract(t.payload_json, '$.teamId') = m.team_id order by t.seq limit 1), '/root'))`);
      parameters.push(sessionId);
    }
    if (checks.length && this.db.query<{ found: number }, string[]>(
      `select 1 as found where ${checks.join(" or ")} limit 1`,
    ).get(...parameters)) return true;

    const legacyIds = [...this.legacySessionIds].filter(([, id]) => id === sessionId).map(([id]) => id);
    const persistedLeadPath = this.columnExists("teams", "lead_path")
      ? `(select lead_path from teams where id = json_extract(e.payload_json, '$.teamId'))` : "null";
    // Event-only histories reserve child/recipient identities too. Lead/root
    // sessions retain their ordinary conversation access.
    return [sessionId, ...legacyIds].some((identity) => this.db.query<{ found: number }, [string, string, string, string]>(
      `select 1 as found from events e
        where (e.type like 'agent.%' or e.type = 'team.member_added')
          and (json_extract(e.payload_json, '$.childSessionId') = ?
            or json_extract(e.payload_json, '$.recipientSessionId') = ?
            or json_extract(e.payload_json, '$.childThreadId') = ?
            or json_extract(e.payload_json, '$.recipientThreadId') = ?)
          and (e.type != 'agent.message_queued' or json_extract(e.payload_json, '$.path') <> '/root')
          and (e.type != 'team.member_added' or json_extract(e.payload_json, '$.path') <> coalesce(
            ${persistedLeadPath},
            (select json_extract(t.payload_json, '$.leadPath') from events t where t.type = 'team.created'
              and json_extract(t.payload_json, '$.teamId') = json_extract(e.payload_json, '$.teamId') order by t.seq limit 1),
            '/root'))
        limit 1`,
    ).get(identity, identity, identity, identity) !== null);
  }

  private sessionCreationClaimExists(sessionId: SessionId): boolean {
    this.db.query(
      `delete from session_creation_claims where session_id = ? and lease_expires_at <= ?`,
    ).run(sessionId, Date.now());
    return this.db
      .query<{ found: number }, [string]>(
        `select 1 as found from session_creation_claims where session_id = ? limit 1`,
      )
      .get(sessionId) !== null;
  }

  private sessionRunClaimExists(sessionId: SessionId): boolean {
    this.db.query(
      `delete from session_run_claims where session_id = ? and lease_expires_at <= ?`,
    ).run(sessionId, Date.now());
    return this.db
      .query<{ found: number }, [string]>(
        `select 1 as found from session_run_claims where session_id = ? limit 1`,
      )
      .get(sessionId) !== null;
  }

  private addColumnIfMissing(table: string, column: string, definition: string): boolean {
    if (!this.columnExists(table, column)) {
      this.db.exec(`alter table ${table} add column ${column} ${definition}`);
      return true;
    }
    return false;
  }

  private tableExists(table: string): boolean {
    return this.db
      .query<{ found: number }, [string]>(
        `select 1 as found from sqlite_master where type = 'table' and name = ? limit 1`,
      )
      .get(table) !== null;
  }

  private columnExists(table: string, column: string): boolean {
    if (!this.tableExists(table)) return false;
    return this.db
      .query<{ name: string }, []>(`pragma table_info(${table})`)
      .all()
      .some((item) => item.name === column);
  }

  private dropColumnIfPresent(table: string, column: string): void {
    if (this.columnExists(table, column)) {
      this.db.exec(`alter table ${table} drop column ${column}`);
    }
  }

  private loadLegacySessionIdentities(): void {
    if (!this.tableExists("legacy_session_identities")) return;
    const rows = this.db
      .query<{ legacy_id: string; session_id: string }, []>(
        `select legacy_id, session_id from legacy_session_identities`,
      )
      .all();
    for (const row of rows) {
      this.legacySessionIds.set(row.legacy_id, row.session_id as SessionId);
    }
  }

  private nextEventSeq(): number {
    const row = this.db.query<{ seq: number | null }, []>(`select max(seq) as seq from events`).get();
    return (row?.seq ?? 0) + 1;
  }

  private applyProjection(event: RuntimeEvent, eventSeq: number): void {
    if (event.type === "turn.completed") {
      this.compactTurnMessagePartDeltas(event.payload.turnId);
      return;
    }
    if (event.type.startsWith("session.")) {
      this.applySessionEvent(event as SessionEvent);
      return;
    }
    if (event.type.startsWith("message.")) {
      this.applyMessageEvent(event as MessageEvent, eventSeq);
      return;
    }
    if (event.type.startsWith("tool.")) {
      this.applyToolEvent(event as ToolEvent);
      return;
    }
    if (event.type.startsWith("approval.")) {
      this.applyApprovalEvent(event as ApprovalEvent);
      return;
    }
    if (event.type.startsWith("goal.")) {
      this.applyGoalEvent(event as GoalEvent);
      return;
    }
  }

  private applySessionEvent(event: SessionEvent): void {
    if (event.type === "session.created") {
      const creationClaim = this.db
        .query<{
          claim_id: string;
          cwd: string;
                lease_expires_at: number;
        }, [string]>(
          `select claim_id, cwd, lease_expires_at
             from session_creation_claims
            where session_id = ?`,
        )
        .get(event.sessionId);
      const ownedCreationClaimId = this.ownedCreationClaims.get(event.sessionId);
      if (
        (!creationClaim && ownedCreationClaimId !== undefined)
        || (
          creationClaim !== null
          && (
            creationClaim.lease_expires_at <= Date.now()
            || ownedCreationClaimId !== creationClaim.claim_id
          )
        )
      ) {
        throw new SessionCreationClaimConflictError(event.sessionId);
      }
      if (creationClaim?.cwd !== undefined && creationClaim.cwd !== event.payload.cwd) {
        throw new SessionCwdConflictError(event.sessionId, creationClaim.cwd, event.payload.cwd);
      }
      if (this.legacySessionReservationExists(event.sessionId)) {
        throw new SessionAccessError(event.sessionId);
      }
      const title = event.payload.cwd.split("/").filter(Boolean).at(-1) ?? "Untitled";
      const agent = event.payload.agent === undefined ? undefined : parseSessionAgentMetadata(event.payload.agent);
      if (agent) {
        if (agent.parentSessionId === event.sessionId) throw new SessionInputConflictError("Agent cannot be its own parent");
        const parent = this.readSession(agent.parentSessionId);
        if (!parent || parent.readOnly || parent.status !== "active" || agent.path !== `${parent.agent?.path ?? ROOT_AGENT_PATH}/${agent.name}`) throw new SessionInputConflictError("Agent parent or path does not match");
      }
      const inserted = this.db
        .query(
          `insert into sessions (id, cwd, title, status, created_at, updated_at, parent_session_id, agent_name, agent_path, agent_policy_json)
           values (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
           on conflict(id) do nothing`,
        )
        .run(event.sessionId, event.payload.cwd, title, event.time, event.time,
          agent?.parentSessionId ?? null, agent?.name ?? null, agent?.path ?? null, agent ? encodeJson(agent.policy) : null);
      if (inserted.changes === 0) {
        const persisted = this.db
          .query<{ cwd: string }, [string]>(`select cwd from sessions where id = ?`)
          .get(event.sessionId);
        if (persisted && persisted.cwd !== event.payload.cwd) {
          throw new SessionCwdConflictError(event.sessionId, persisted.cwd, event.payload.cwd);
        }
        throw new SessionAlreadyExistsError(
          event.sessionId,
          persisted?.cwd ?? event.payload.cwd,
          event.payload.cwd,
        );
      }
      return;
    }

    if (event.type === "session.archived") {
      if (this.tableExists("session_inputs")) {
        this.db.query("update session_inputs set state = 'settled', outcome = 'cancelled', revision = revision + 1, updated_at = ? where session_id = ? and state = 'pending'").run(event.time, event.sessionId);
        this.db.query("update session_dispatch set paused = 1, revision = revision + 1 where session_id = ?").run(event.sessionId);
      }
      const session = this.db
        .query<{ status: string }, [string]>(`select status from sessions where id = ?`)
        .get(event.sessionId);
      if (!session) throw new SessionStateConflictError(event.sessionId);
      if (session.status !== "active") {
        throw new SessionStateConflictError(event.sessionId, session.status);
      }
      if (this.sessionCreationClaimExists(event.sessionId) || this.sessionRunClaimExists(event.sessionId)) {
        throw new SessionRunClaimConflictError(event.sessionId);
      }
      this.db
        .query(`update sessions set status = 'archived', updated_at = ? where id = ?`)
        .run(event.time, event.sessionId);
      return;
    }

    if (event.type === "session.renamed") {
      this.db
        .query(`update sessions set title = ?, updated_at = ? where id = ?`)
        .run(event.payload.title, event.time, event.sessionId);
    }
  }

  private applyMessageEvent(event: MessageEvent, eventSeq: number): void {
    if (event.type === "message.created") {
      if (!event.sessionId) {
        throw new Error("message.created requires event.sessionId");
      }
      this.db
        .query(
          `insert into messages (id, session_id, turn_id, role, parent_id, created_at, created_event_seq)
           values (?, ?, ?, ?, null, ?, ?)
           on conflict(id) do nothing`,
        )
        .run(event.payload.messageId, event.sessionId, event.payload.turnId ?? null, event.payload.role, event.time, eventSeq);
      return;
    }

    if (event.type === "message.part_added") {
      const part = event.payload.part;
      const ordinal = this.nextPartOrdinal(part.messageId);
      this.db
        .query(
          `insert into message_parts (id, message_id, session_id, type, ordinal, data_json, created_at)
           values (?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do update set data_json = excluded.data_json`,
        )
        .run(part.id, part.messageId, part.sessionId, part.type, ordinal, encodeJson(part), event.time);
      return;
    }

    if (event.type === "message.part_delta") {
      return;
    }
  }

  private pendingMessagePartDeltas(
    sessionId: SessionId,
  ): Map<string, { seq: number; field: string; delta: string }[]> {
    const rows = this.db
      .query<PendingPartDeltaRow, [string]>(
        `select events.seq,
                json_extract(events.payload_json, '$.partId') as part_id,
                events.payload_json
           from events
           join message_parts on message_parts.id = json_extract(events.payload_json, '$.partId')
          where events.session_id = ?
            and events.type = 'message.part_delta'
            and events.seq > message_parts.delta_event_seq
          order by events.seq asc`,
      )
      .all(sessionId);
    const deltas = new Map<string, { seq: number; field: string; delta: string }[]>();
    for (const row of rows) {
      const payload = decodeJson<{ field?: unknown; delta?: unknown }>(row.payload_json, {});
      if (typeof payload.field !== "string" || typeof payload.delta !== "string") continue;
      const items = deltas.get(row.part_id) ?? [];
      items.push({ seq: row.seq, field: payload.field, delta: payload.delta });
      deltas.set(row.part_id, items);
    }
    return deltas;
  }

  private compactTurnMessagePartDeltas(turnId: TurnId): void {
    const rows = this.db
      .query<PendingPartDeltaRow & PartRow, [string]>(
        `select events.seq,
                message_parts.id as part_id,
                events.payload_json,
                message_parts.data_json,
                message_parts.delta_event_seq
           from events
           join message_parts on message_parts.id = json_extract(events.payload_json, '$.partId')
           join messages on messages.id = message_parts.message_id
          where events.type = 'message.part_delta'
            and messages.turn_id = ?
            and events.seq > message_parts.delta_event_seq
          order by events.seq asc`,
      )
      .all(turnId);
    const compacted = new Map<string, { part: MessagePart; seq: number }>();
    for (const row of rows) {
      const payload = decodeJson<{ field?: unknown; delta?: unknown }>(row.payload_json, {});
      if (typeof payload.field !== "string" || typeof payload.delta !== "string") continue;
      const current = compacted.get(row.part_id) ?? {
        part: decodeJson<MessagePart>(row.data_json, {} as MessagePart),
        seq: row.delta_event_seq,
      };
      current.part = applyPartDelta(current.part, payload.field, payload.delta);
      current.seq = row.seq;
      compacted.set(row.part_id, current);
    }
    const update = this.db.query(
      `update message_parts
          set data_json = ?, delta_event_seq = ?
        where id = ?`,
    );
    for (const [partId, item] of compacted) {
      update.run(encodeJson(item.part), item.seq, partId);
    }
  }

  private applyToolEvent(event: ToolEvent): void {
    // External/provider IDs are never keys for this projection. Also fence
    // legacy writers so a repeated ID cannot alter another session or turn.
    const existing = this.db.query<{ session_id: string | null; turn_id: string | null }, [string]>(
      "select session_id, turn_id from tool_calls where id = ?",
    ).get(event.payload.callId);
    if (existing && (existing.session_id !== (event.sessionId ?? null)
      || (event.type === "tool.call_started" && existing.turn_id !== event.payload.turnId))) {
      throw new Error(`Tool call identity conflict: ${event.payload.callId}`);
    }
    if (event.type === "tool.call_started") {
      this.db
        .query(
          `insert into tool_calls
             (id, provider_call_id, parent_call_id, session_id, turn_id, tool_name, status, input_json, started_at, updated_at)
           values (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
           on conflict(id) do update set
             status = excluded.status,
             provider_call_id = coalesce(excluded.provider_call_id, tool_calls.provider_call_id),
             parent_call_id = coalesce(excluded.parent_call_id, tool_calls.parent_call_id),
             updated_at = excluded.updated_at`,
        )
        .run(
          event.payload.callId,
          event.payload.providerCallId ?? null,
          event.payload.parentCallId ?? null,
          event.sessionId ?? null,
          event.payload.turnId,
          event.payload.toolName,
          encodeJson(event.payload.input),
          event.time,
          event.time,
        );
      return;
    }

    if (event.type === "tool.call_updated") {
      this.db
        .query(`update tool_calls set status = ?, provider_call_id = coalesce(?, provider_call_id), updated_at = ? where id = ?`)
        .run(event.payload.status, event.payload.providerCallId ?? null, event.time, event.payload.callId);
      return;
    }

    if (event.type === "tool.call_finished") {
      this.db
        .query(
          `update tool_calls
           set status = ?, output = ?, error = ?, synthetic = ?, updated_at = ?
           where id = ?`,
        )
        .run(
          event.payload.status,
          event.payload.output ?? null,
          event.payload.error ?? null,
          event.payload.synthetic ? 1 : 0,
          event.time,
          event.payload.callId,
        );
    }
  }

  private applyApprovalEvent(event: ApprovalEvent): void {
    if (event.type === "approval.requested") {
      this.db
        .query(
          `insert into approvals
             (id, session_id, call_id, permission, patterns_json, max_approval_scope, metadata_json, status, created_at)
           values (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
           on conflict(id) do update set
             status = 'pending',
             max_approval_scope = excluded.max_approval_scope,
             metadata_json = excluded.metadata_json`,
        )
        .run(
          event.payload.approvalId,
          event.sessionId ?? null,
          event.payload.callId ?? null,
          event.payload.permission,
          encodeJson(event.payload.patterns),
          event.payload.maxApprovalScope ?? null,
          event.payload.metadata ? encodeJson(event.payload.metadata) : null,
          event.time,
        );
      return;
    }

    if (event.type === "approval.resolved") {
      this.db
        .query(
          `update approvals
           set status = 'resolved', decision = ?, feedback = ?, resolved_at = ?
           where id = ?`,
        )
        .run(event.payload.decision, event.payload.feedback ?? null, event.time, event.payload.approvalId);
    }
  }

  private applyGoalEvent(event: GoalEvent): void {
    if (event.type === "goal.updated") {
      const goal = event.payload.goal;
      this.db
        .query(
          `insert into session_goals
             (session_id, objective, status, token_budget, tokens_used,
              time_used_seconds, created_at, updated_at, completed_at, last_reason)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(session_id) do update set
             objective = excluded.objective,
             status = excluded.status,
             token_budget = excluded.token_budget,
             tokens_used = excluded.tokens_used,
             time_used_seconds = excluded.time_used_seconds,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             completed_at = excluded.completed_at,
             last_reason = excluded.last_reason`,
        )
        .run(
          event.sessionId,
          goal.objective,
          goal.status,
          goal.tokenBudget ?? null,
          goal.tokensUsed,
          goal.timeUsedSeconds,
          goal.createdAt,
          goal.updatedAt,
          goal.completedAt ?? null,
          event.payload.reason ?? goal.lastReason ?? null,
        );
      return;
    }

    this.db
      .query(`delete from session_goals where session_id = ?`)
      .run(event.sessionId);
  }

  private nextPartOrdinal(messageId: string): number {
    const row = this.db
      .query<{ count: number }, [string]>(`select count(*) as count from message_parts where message_id = ?`)
      .get(messageId);
    return row?.count ?? 0;
  }

  private eventFromRow(row: StoredEventRow): EventEnvelope {
    if (
      (row.type.startsWith("session.") || row.type === "goal.updated" || row.type === "goal.cleared")
      && !row.session_id
    ) {
      throw new Error(`Cannot replay ${row.type}: event has no SessionId.`);
    }
    const event: EventEnvelope = {
      id: row.id,
      type: row.type,
      time: row.time as EventEnvelope["time"],
      payload: canonicalizeLegacyEventPayload(
        row.type,
        decodeJson<Record<string, unknown>>(row.payload_json, {}),
        row.session_id,
        (legacyId) => this.legacySessionIds.get(legacyId),
      ),
    };
    if (row.session_id) {
      event.sessionId = row.session_id as SessionId;
    }
    return event;
  }
}

function validateScopedEventSessionIdentity(event: RuntimeEvent): void {
  if (event.type.startsWith("session.")) {
    const envelopeSessionId = event.sessionId;
    const payloadSessionId = (event.payload as { sessionId?: unknown }).sessionId;
    if (!envelopeSessionId) {
      throw new Error(`${event.type} requires event.sessionId`);
    }
    if (payloadSessionId !== envelopeSessionId) {
      throw new Error(
        `${event.type} payload sessionId ${String(payloadSessionId)} does not match event.sessionId ${envelopeSessionId}`,
      );
    }
    return;
  }
  if (event.type === "goal.updated") {
    if (!event.sessionId) {
      throw new Error("goal.updated requires event.sessionId");
    }
    if (event.payload.goal.sessionId !== event.sessionId) {
      throw new Error(
        `goal.updated goal sessionId ${event.payload.goal.sessionId} does not match event.sessionId ${event.sessionId}`,
      );
    }
    return;
  }
  if (event.type === "goal.cleared") {
    if (!event.sessionId) {
      throw new Error("goal.cleared requires event.sessionId");
    }
    if (event.payload.sessionId !== event.sessionId) {
      throw new Error(
        `goal.cleared payload sessionId ${event.payload.sessionId} does not match event.sessionId ${event.sessionId}`,
      );
    }
    if (event.payload.previousGoal && event.payload.previousGoal.sessionId !== event.sessionId) {
      throw new Error(
        `goal.cleared previous goal sessionId ${event.payload.previousGoal.sessionId} does not match event.sessionId ${event.sessionId}`,
      );
    }
    return;
  }

}

/**
 * Canonicalize protocol-owned fields from legacy event rows at the read
 * boundary. The append-only payload ledger remains byte-for-byte intact while
 * callers only observe the current Session-only contract.
 */
function canonicalizeLegacyEventPayload(
  type: string,
  payload: Record<string, unknown>,
  sessionId: string | null,
  resolveLegacySessionId: (legacyId: string) => SessionId | undefined,
): Record<string, unknown> {
  const output = { ...payload };
  const legacyConversationId = output.threadId;
  delete output.threadId;
  if (type.startsWith("session.") && sessionId) {
    output.sessionId = sessionId;
  }
  const canonicalizeIdentity = (
    legacyKey: "parentThreadId" | "childThreadId" | "recipientThreadId",
    sessionKey: "parentSessionId" | "childSessionId" | "recipientSessionId",
  ): void => {
    const legacyId = output[legacyKey];
    delete output[legacyKey];
    if (typeof legacyId !== "string") return;
    const resolved = resolveLegacySessionId(legacyId);
    const existing = output[sessionKey];
    if (typeof existing === "string") {
      if (resolved && existing !== resolved) {
        throw new Error(
          `Cannot replay legacy event payload: ${legacyKey} maps to ${resolved}, not ${existing}.`,
        );
      }
      return;
    }
    if (!resolved) {
      throw new Error(
        `Cannot replay legacy event payload: ${legacyKey} value ${legacyId} has no SessionId mapping.`,
      );
    }
    output[sessionKey] = resolved;
  };

  canonicalizeIdentity("parentThreadId", "parentSessionId");
  if (type === "agent.message_queued") {
    const legacyChildId = output.childThreadId;
    const previousRecipientId = output.childSessionId;
    const currentRecipientId = output.recipientSessionId;
    delete output.childThreadId;
    delete output.childSessionId;
    if (
      typeof previousRecipientId === "string"
      && typeof currentRecipientId === "string"
      && previousRecipientId !== currentRecipientId
    ) {
      throw new Error(
        `Cannot replay legacy mailbox payload: child session ${previousRecipientId} conflicts with recipient session ${currentRecipientId}.`,
      );
    }
    const mappedRecipientId = typeof legacyChildId === "string"
      ? resolveLegacySessionId(legacyChildId)
      : undefined;
    const recipientId = typeof currentRecipientId === "string"
      ? currentRecipientId
      : typeof previousRecipientId === "string"
        ? previousRecipientId
        : mappedRecipientId;
    if (mappedRecipientId && recipientId && mappedRecipientId !== recipientId) {
      throw new Error(
        `Cannot replay legacy mailbox payload: child identity maps to ${mappedRecipientId}, not ${recipientId}.`,
      );
    }
    if (typeof legacyChildId === "string" && !recipientId) {
      throw new Error(
        `Cannot replay legacy mailbox payload: childThreadId value ${legacyChildId} has no SessionId mapping.`,
      );
    }
    if (recipientId) output.recipientSessionId = recipientId;
  } else {
    canonicalizeIdentity("childThreadId", "childSessionId");
  }
  canonicalizeIdentity("recipientThreadId", "recipientSessionId");

  const canonicalGoal = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const goal = { ...(value as Record<string, unknown>) };
    const legacyId = goal.threadId;
    delete goal.threadId;
    const resolved = sessionId
      ?? (typeof goal.sessionId === "string" ? goal.sessionId : undefined)
      ?? (typeof legacyId === "string" ? resolveLegacySessionId(legacyId) : undefined);
    if (typeof legacyId === "string" && !resolved) {
      throw new Error(
        `Cannot replay legacy event goal: threadId value ${legacyId} has no SessionId mapping.`,
      );
    }
    if (resolved) goal.sessionId = resolved;
    return goal;
  };

  if (output.goal !== undefined) {
    output.goal = canonicalGoal(output.goal);
  }
  if (output.previousGoal !== undefined) {
    output.previousGoal = canonicalGoal(output.previousGoal);
  }
  if (type === "goal.cleared") {
    const resolved = sessionId
      ?? (typeof output.sessionId === "string" ? output.sessionId : undefined)
      ?? (typeof legacyConversationId === "string"
        ? resolveLegacySessionId(legacyConversationId)
        : undefined);
    if (typeof legacyConversationId === "string" && !resolved) {
      throw new Error(
        `Cannot replay legacy goal.cleared event: threadId value ${legacyConversationId} has no SessionId mapping.`,
      );
    }
    if (resolved) output.sessionId = resolved;
  }
  return output;
}

function approvalFromRow(row: Record<string, unknown>): ApprovalRow {
  const approval: ApprovalRow = {
    id: String(row.id),
    permission: String(row.permission),
    patterns: decodeJson(String(row.patterns_json), [] as string[]),
    status: row.status as ApprovalRow["status"],
    createdAt: Number(row.created_at),
  };
  if (row.session_id) approval.sessionId = String(row.session_id) as SessionId;
  if (row.call_id) approval.callId = String(row.call_id);
  if (isApprovalScope(row.max_approval_scope)) approval.maxApprovalScope = row.max_approval_scope;
  if (row.metadata_json) approval.metadata = decodeJson<Record<string, unknown>>(String(row.metadata_json), {});
  if (row.decision) approval.decision = row.decision as NonNullable<ApprovalRow["decision"]>;
  if (row.feedback) approval.feedback = String(row.feedback);
  if (row.resolved_at) approval.resolvedAt = Number(row.resolved_at);
  return approval;
}

function isApprovalScope(value: unknown): value is NonNullable<ApprovalRow["maxApprovalScope"]> {
  return value === "once" || value === "session" || value === "persistent";
}

function sessionGoalFromRow(row: SessionGoalProjectionRow): SessionGoalRow {
  const goal: SessionGoal = {
    sessionId: row.session_id as SessionId,
    objective: row.objective,
    status: row.status,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    createdAt: row.created_at as SessionGoal["createdAt"],
    updatedAt: row.updated_at as SessionGoal["updatedAt"],
  };
  if (row.token_budget !== null) goal.tokenBudget = row.token_budget;
  if (row.completed_at !== null) goal.completedAt = row.completed_at as TimestampMs;
  if (row.last_reason) goal.lastReason = row.last_reason as NonNullable<SessionGoal["lastReason"]>;
  return goal;
}

function applyPartDelta(part: MessagePart, field: string, delta: string): MessagePart {
  if (field === "text" && (part.type === "text" || part.type === "reasoning")) {
    return { ...part, text: part.text + delta };
  }
  if (field === "output" && part.type === "tool_result") {
    return { ...part, output: part.output + delta };
  }
  return part;
}

function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("database is locked") || message.includes("database busy") || message.includes("sqlite_busy");
}

function configureSqliteJournalMode(
  db: Database,
  requestedMode: SqliteJournalMode,
  sqliteVersion: string,
): string {
  let actualMode = "unknown";
  try {
    const row = db
      .query<Record<string, unknown>, []>(`pragma journal_mode = ${requestedMode.toUpperCase()}`)
      .get();
    actualMode = String(row ? Object.values(row)[0] : "unknown").toLowerCase();
  } catch (error) {
    throw new SqliteJournalModeError(sqliteVersion, requestedMode, actualMode, error);
  }
  // SQLite in-memory databases report MEMORY and cannot be shared across
  // processes, so they do not meet the WAL-reset bug's preconditions.
  if (actualMode !== requestedMode && actualMode !== "memory") {
    throw new SqliteJournalModeError(sqliteVersion, requestedMode, actualMode);
  }
  return actualMode;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
