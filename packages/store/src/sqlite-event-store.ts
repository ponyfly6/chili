import { Database } from "bun:sqlite";
import type {
  AgentCompleteTaskPayload,
  AgentCompletedPayload,
  AgentRunId,
  AgentMessageClaimedPayload,
  AgentMessageConsumedPayload,
  AgentMessageDiscardedPayload,
  AgentMessageRequeuedPayload,
  AgentEvent,
  ApprovalEvent,
  ChiliEvent,
  EventEnvelope,
  AgentPath,
  AgentMailboxPayload,
  GoalEvent,
  Message,
  MessageId,
  MessageEvent,
  MessagePart,
  SessionId,
  TaskId,
  SessionEvent,
  TeamEvent,
  TeamId,
  TeamMessageDelivery,
  TeamMessageDeliveryStatus,
  SessionGoal,
  SessionGoalStatus,
  TeamTaskClaimedPayload,
  TimestampMs,
  ToolCallId,
  ToolEvent,
  TurnId,
} from "@chili/protocol";
import {
  boundPersistedJsonValue,
  isTransientEvent,
  normalizePersistedError,
  PERSISTED_JSON_LIMITS,
  TEAM_TASK_RUNTIME_METADATA_KEYS,
} from "@chili/protocol";
import { decodeJson, encodeJson } from "./json.js";
import { AGENT_TASKS_CHILD_SESSION_UNIQUE_INDEX, SQLITE_SCHEMA } from "./schema.js";
import {
  sqliteJournalPolicy,
  type SqliteJournalMode,
} from "./sqlite-journal-policy.js";
import type {
  AgentMailboxQuery,
  AgentMailboxRow,
  AgentMailboxClaimInput,
  AgentMailboxConsumeInput,
  AgentMailboxDiscardInput,
  AgentMailboxDeliveryStore,
  AgentMailboxMutationResult,
  AgentMailboxRequeueInput,
  AgentTaskCloseCasInput,
  AgentTaskBeginRunCasInput,
  AgentTaskBeginRunResult,
  AgentTaskCompleteCasInput,
  AgentTaskFinalizationResult,
  AgentTaskFinalizationStore,
  AgentTaskLeaseClaimInput,
  AgentTaskLeaseReleaseInput,
  AgentTaskLeaseRenewInput,
  AgentTaskLeaseResult,
  AgentTaskLeaseStore,
  AgentTaskRunClaimStore,
  AgentRunRow,
  AgentRunQuery,
  AgentTaskQuery,
  AgentTaskRow,
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
  SessionCreationClaimFence,
  SessionRunClaimFence,
  StaleTurnRecoveryInput,
  StaleTurnRecoveryStore,
  SubagentProjectionStore,
  TeamMemberQuery,
  TeamMemberRow,
  TeamMessageDeliveryQuery,
  TeamMessageDeliveryRow,
  TeamMessageQuery,
  TeamMessageRow,
  TeamOwnerSessionBindInput,
  TeamOwnerSessionBindResult,
  TeamOwnerSessionBindStore,
  TeamProjectionStore,
  TeamQuery,
  TeamRow,
  TeamTaskClaimInput,
  TeamTaskClaimStore,
  TeamTaskAgentSyncInput,
  TeamTaskAgentSyncResult,
  TeamTaskAgentSyncStore,
  TeamTaskMutationResult,
  TeamTaskQuery,
  TeamTaskRow,
  TeamTaskVerificationClaimInput,
  TeamTaskVerificationClaimResult,
  TeamTaskVerificationClaimStore,
  SessionGoalQuery,
  SessionGoalRow,
} from "./types.js";

const AGENT_TEAM_CAS_TEXT_JSON_BYTES = 64 * 1024;
const AGENT_TEAM_CAS_METADATA_JSON_BYTES = 256 * 1024;

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

interface AgentTaskProjectionRow {
  id: string;
  dispatch_id: string | null;
  reserved_run_id: string | null;
  worker_policy_json: string | null;
  path: string;
  parent_path: string | null;
  parent_session_id: string | null;
  child_session_id: string | null;
  task_name: string;
  cwd: string | null;
  prompt: string | null;
  mode: string | null;
  source_call_id: string | null;
  batch_id: string | null;
  batch_index: number | null;
  expected_batch_size: number | null;
  completion_policy: string | null;
  max_concurrency: number | null;
  status: string;
  current_run_id: string | null;
  summary: string | null;
  error: string | null;
  completion_json: string | null;
  generation: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  lease_heartbeat_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface AgentTaskStateRow {
  dispatch_id: string | null;
  reserved_run_id: string | null;
  worker_policy_json: string | null;
  status: string;
  generation: number;
  current_run_id: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  path: string;
  parent_path: string | null;
  parent_session_id: string | null;
  child_session_id: string | null;
  task_name: string;
  cwd: string | null;
  mode: string | null;
  source_call_id: string | null;
  batch_id: string | null;
  batch_index: number | null;
  expected_batch_size: number | null;
  completion_policy: string | null;
  max_concurrency: number | null;
}

interface AgentRunProjectionRow {
  id: string;
  session_id: string | null;
  task_id: string | null;
  path: string;
  parent_path: string | null;
  parent_session_id: string | null;
  child_session_id: string | null;
  task_name: string;
  cwd: string | null;
  mode: string | null;
  generation: number;
  status: AgentRunRow["status"];
  created_at: number;
  completed_at: number | null;
}

interface AgentMailboxProjectionRow {
  id: string;
  task_id: string | null;
  path: string;
  from_path: string;
  recipient_session_id: string | null;
  trigger_turn: number;
  status: AgentMailboxRow["status"];
  message_json: string | null;
  created_at: number;
  consumed_at: number | null;
}

interface TeamProjectionRow {
  id: string;
  session_id: string | null;
  name: string;
  lead_path: string;
  status: TeamRow["status"];
  description: string | null;
  created_at: number;
  updated_at: number;
}

interface TeamMemberProjectionRow {
  team_id: string;
  path: string;
  name: string;
  role: string;
  status: TeamMemberRow["status"];
  child_session_id: string | null;
  model: string | null;
  tool_scope_json: string | null;
  write_scope_json: string | null;
  current_task_id: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

interface TeamTaskProjectionRow {
  id: string;
  team_id: string;
  session_id: string | null;
  owner_path: string | null;
  status: TeamTaskRow["status"];
  title: string | null;
  description: string | null;
  created_by: string | null;
  depends_on_json: string | null;
  summary: string | null;
  error: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface TeamTaskStateRow {
  id: string;
  team_id: string;
  status: TeamTaskRow["status"];
  owner_path: string | null;
  depends_on_json: string | null;
  metadata_json: string | null;
}

interface TeamMessageProjectionRow {
  id: string;
  team_id: string;
  from_path: string;
  to_path: string;
  task_id: string | null;
  kind: TeamMessageRow["kind"];
  delivery: TeamMessageDelivery | null;
  delivery_status: TeamMessageDeliveryStatus | null;
  delivery_error: string | null;
  delivery_updated_at: number | null;
  delivered_at: number | null;
  content: string;
  summary: string | null;
  metadata_json: string | null;
  created_at: number;
}

interface TeamMessageDeliveryProjectionRow {
  mailbox_message_id: string;
  team_id: string;
  team_message_id: string;
  path: string;
  child_session_id: string | null;
  trigger_turn: number;
  status: TeamMessageDeliveryStatus;
  error: string | null;
  queued_at: number;
  updated_at: number;
  delivered_at: number | null;
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

export class SessionReservedForSubagentError extends Error {
  override readonly name = "SessionReservedForSubagentError";

  constructor(readonly sessionId: SessionId) {
    super(`Session ${sessionId} is reserved for a subagent`);
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

export class TeamAlreadyExistsError extends Error {
  override readonly name = "TeamAlreadyExistsError";

  constructor(readonly teamId: TeamId) {
    super(`Team already exists: ${teamId}`);
  }
}

export class TeamTaskAlreadyExistsError extends Error {
  override readonly name = "TeamTaskAlreadyExistsError";

  constructor(readonly taskId: TaskId, readonly existingTeamId?: TeamId) {
    super(existingTeamId
      ? `Team task already exists: ${taskId} in ${existingTeamId}`
      : `Team task already exists: ${taskId}`);
  }
}

export interface SqliteEventStoreOptions {
  mirror?: EventMirror;
  onMirrorError?: (error: unknown, event: ChiliEvent) => void;
  busyTimeoutMs?: number;
  writeRetryAttempts?: number;
}

export class SqliteEventStore
  implements
    EventStore,
    EventCommitAwareStore,
    StaleTurnRecoveryStore,
    GoalProjectionStore,
    GoalMutationStore,
    SubagentProjectionStore,
    AgentTaskLeaseStore,
    AgentTaskRunClaimStore,
    AgentTaskFinalizationStore,
    AgentMailboxDeliveryStore,
    TeamProjectionStore,
    TeamOwnerSessionBindStore,
    TeamTaskClaimStore,
    TeamTaskAgentSyncStore,
    TeamTaskVerificationClaimStore
{
  private readonly db: Database;
  private readonly legacySessionIds = new Map<string, SessionId>();
  private readonly ownedCreationClaims = new Map<SessionId, string>();
  private readonly ownedRunClaims = new Map<SessionId, string>();
  private readonly journalMode: string;
  private closed = false;

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
      this.prepareSessionOnlyReplacementColumns();
      this.migrateMailboxRecipientSessionSchema();
      for (const statement of indexStatements) {
        if (statement === AGENT_TASKS_CHILD_SESSION_UNIQUE_INDEX) continue;
        this.db.exec(statement);
      }
      this.migrateApprovalSchema();
      this.migrateMessageSchema();
      this.migrateGoalSchema();
      this.migrateLegacyThreadSchema();
      this.db.exec(AGENT_TASKS_CHILD_SESSION_UNIQUE_INDEX);
      this.migrateSubagentSchema();
      this.migrateTeamSchema();
      this.migrateSessionClaimSchema();
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

  async append(event: ChiliEvent, options?: EventAppendOptions): Promise<void> {
    await this.appendCommitted(event, options);
  }

  async appendCommitted(event: ChiliEvent, options?: EventAppendOptions): Promise<boolean> {
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
    events: readonly ChiliEvent[],
    options?: EventAppendOptions,
  ): Promise<void> {
    await this.appendManyCommitted(events, options);
  }

  async appendManyCommitted(
    events: readonly ChiliEvent[],
    options?: EventAppendOptions,
  ): Promise<readonly ChiliEvent[]> {
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
    owner: "root" | "child";
    time: number;
    leaseDurationMs: number;
  }): { status: "claimed" | "already_exists" | "subagent" } {
    const claim = this.db.transaction(() => {
      // A store connection is the implicit fence for ordinary session-scoped
      // appends. Never replace its claim in place: doing so would let the stale
      // caller's writes pass under the replacement claim stored in this map.
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
      if (input.owner === "root" && this.subagentSessionReservationExists(input.sessionId)) {
        return { status: "subagent" as const };
      }
      this.db.query(
        `insert into session_creation_claims
           (session_id, claim_id, cwd, owner, claimed_at, heartbeat_at, lease_expires_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.sessionId,
        input.claimId,
        input.cwd,
        input.owner,
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

  claimSessionRun(input: {
    sessionId: SessionId;
    claimId: string;
    allowSubagentSessions: boolean;
    time: number;
    leaseDurationMs: number;
  }): { status: "claimed" | "busy" | "inactive" | "not_found" | "subagent"; sessionStatus?: string } {
    const claim = this.db.transaction(() => {
      // See claimSessionCreation: replacing an owned claim on this connection
      // would erase the identity needed to reject the old operation's appends.
      if (this.ownedRunClaims.has(input.sessionId)) return { status: "busy" as const };
      this.db.query(
        `delete from session_creation_claims where session_id = ? and lease_expires_at <= ?`,
      ).run(input.sessionId, input.time);
      const creationClaim = this.db
        .query<{ found: number }, [string]>(
          `select 1 as found from session_creation_claims where session_id = ? limit 1`,
        )
        .get(input.sessionId);
      if (creationClaim) return { status: "busy" as const };
      const session = this.db
        .query<{ status: string }, [string]>(`select status from sessions where id = ?`)
        .get(input.sessionId);
      const subagentOwned = this.subagentSessionReservationExists(input.sessionId);
      if (!session) {
        return !input.allowSubagentSessions && subagentOwned
          ? { status: "subagent" as const }
          : { status: "not_found" as const };
      }
      if (session.status !== "active") {
        return { status: "inactive" as const, sessionStatus: session.status };
      }
      if (!input.allowSubagentSessions && subagentOwned) return { status: "subagent" as const };
      const inserted = this.db.query(
        `insert into session_run_claims
           (session_id, claim_id, claimed_at, heartbeat_at, lease_expires_at)
         values (?, ?, ?, ?, ?)
         on conflict(session_id) do update set
           claim_id = excluded.claim_id,
           claimed_at = excluded.claimed_at,
           heartbeat_at = excluded.heartbeat_at,
           lease_expires_at = excluded.lease_expires_at
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
        `select seq, id, type, time, session_id, payload_json
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
        source: "interactive" | "subagent";
        status: "active" | "archived";
        created_at: number;
        updated_at: number;
      }, []>(
        `select s.id, s.cwd, s.title, s.status, s.created_at, s.updated_at,
                case
                  when exists (select 1 from agent_tasks t where t.child_session_id = s.id)
                    or exists (select 1 from agent_runs r where r.child_session_id = s.id)
                    or exists (
                      select 1
                      from team_members m
                      join teams t on t.id = m.team_id
                      where m.child_session_id = s.id
                        and m.path <> t.lead_path
                    )
                  then 'subagent'
                  else 'interactive'
                end as source,
                (select coalesce(
                          nullif(json_extract(mp.data_json, '$.displayText'), ''),
                          nullif(json_extract(mp.data_json, '$.text'), '')
                        )
                 from messages m
                 join message_parts mp on mp.message_id = m.id
                 where m.session_id = s.id
                   and m.role = 'user'
                   and mp.type = 'text'
                 order by m.created_at desc, mp.ordinal asc
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
        source: row.source,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  async messages(sessionId: Message["sessionId"]): Promise<Message[]> {
    const messages = this.db
      .query<MessageRow, [string]>(
        `select id, session_id, turn_id, role, parent_id, created_at
         from messages
         where session_id = ?
         order by created_at asc, id asc`,
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
        .map((event) => this.eventFromRow(event) as Extract<ChiliEvent, { type: "goal.updated" }>);
      const snapshot: GoalMutationSnapshot = {
        ...(row ? { goal: sessionGoalFromRow(row) } : {}),
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

  async agentTask(taskId: TaskId): Promise<AgentTaskRow | undefined> {
    return (await this.agentTasks({ taskId, limit: 1 }))[0];
  }

  async agentTasks(query: AgentTaskQuery = {}): Promise<AgentTaskRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.taskId) {
      clauses.push("id = $taskId");
      params.taskId = query.taskId;
    }
    if (query.path) {
      clauses.push("path = $path");
      params.path = query.path;
    }
    if (query.parentSessionId) {
      clauses.push("parent_session_id = $parentSessionId");
      params.parentSessionId = query.parentSessionId;
    }
    if (query.childSessionId) {
      clauses.push("child_session_id = $childSessionId");
      params.childSessionId = query.childSessionId;
    }
    if (query.sourceCallId) {
      clauses.push("source_call_id = $sourceCallId");
      params.sourceCallId = query.sourceCallId;
    }
    if (query.batchId) {
      clauses.push("batch_id = $batchId");
      params.batchId = query.batchId;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<AgentTaskProjectionRow, any>(
        `select id, dispatch_id, reserved_run_id, worker_policy_json,
                path, parent_path, parent_session_id, child_session_id,
                task_name, cwd, prompt, mode, source_call_id, batch_id, batch_index, expected_batch_size,
                completion_policy, max_concurrency, status, current_run_id, summary, error, completion_json,
                generation, lease_owner, lease_expires_at, lease_heartbeat_at, created_at, updated_at, completed_at
         from agent_tasks
         ${where}
         order by created_at asc, id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => agentTaskFromRow(row));
  }

  async agentRuns(query: AgentRunQuery = {}): Promise<AgentRunRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.taskId) {
      clauses.push("task_id = $taskId");
      params.taskId = query.taskId;
    }
    if (query.path) {
      clauses.push("path = $path");
      params.path = query.path;
    }
    if (query.sessionId) {
      clauses.push("session_id = $sessionId");
      params.sessionId = query.sessionId;
    }
    if (query.childSessionId) {
      clauses.push("child_session_id = $childSessionId");
      params.childSessionId = query.childSessionId;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<AgentRunProjectionRow, any>(
        `select id, session_id, task_id, path, parent_path, parent_session_id,
                child_session_id, task_name, cwd, mode, status, generation, created_at, completed_at
         from agent_runs
         ${where}
         order by created_at asc, id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => agentRunFromRow(row));
  }

  async agentMailbox(query: AgentMailboxQuery = {}): Promise<AgentMailboxRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.messageId) {
      clauses.push("id = $messageId");
      params.messageId = query.messageId;
    }
    if (query.taskId) {
      clauses.push("task_id = $taskId");
      params.taskId = query.taskId;
    }
    if (query.path) {
      clauses.push("path = $path");
      params.path = query.path;
    }
    if (query.recipientSessionId) {
      clauses.push("recipient_session_id = $recipientSessionId");
      params.recipientSessionId = query.recipientSessionId;
    }
    if (query.triggerTurn !== undefined) {
      clauses.push("trigger_turn = $triggerTurn");
      params.triggerTurn = query.triggerTurn ? 1 : 0;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<AgentMailboxProjectionRow, any>(
        `select id, task_id, path, from_path, recipient_session_id, trigger_turn, status,
                message_json, created_at, consumed_at
         from agent_mailbox
         ${where}
         order by created_at asc, rowid asc, id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => agentMailboxFromRow(row));
  }

  async teams(query: TeamQuery = {}): Promise<TeamRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.teamId) {
      clauses.push("id = $teamId");
      params.teamId = query.teamId;
    }
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
      .query<TeamProjectionRow, any>(
        `select id, session_id, name, lead_path, status, description, created_at, updated_at
         from teams
         ${where}
         order by updated_at desc, id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => teamFromRow(row));
  }

  async teamMembers(query: TeamMemberQuery = {}): Promise<TeamMemberRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.teamId) {
      clauses.push("team_id = $teamId");
      params.teamId = query.teamId;
    }
    if (query.path) {
      clauses.push("path = $path");
      params.path = query.path;
    }
    if (query.childSessionId) {
      clauses.push("child_session_id = $childSessionId");
      params.childSessionId = query.childSessionId;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<TeamMemberProjectionRow, any>(
        `select team_id, path, name, role, status, child_session_id, model,
                tool_scope_json, write_scope_json, current_task_id, created_at, updated_at, closed_at
         from team_members
         ${where}
         order by created_at asc, path asc
         limit $limit`,
      )
      .all(params)
      .map((row) => teamMemberFromRow(row));
  }

  async teamTasks(query: TeamTaskQuery = {}): Promise<TeamTaskRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.teamId) {
      clauses.push("team_id = $teamId");
      params.teamId = query.teamId;
    }
    if (query.taskId) {
      clauses.push("id = $taskId");
      params.taskId = query.taskId;
    }
    if (query.ownerPath) {
      clauses.push("owner_path = $ownerPath");
      params.ownerPath = query.ownerPath;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<TeamTaskProjectionRow, any>(
        `select id, team_id, session_id, owner_path, status, title, description, created_by,
                depends_on_json, summary, error, metadata_json, created_at, updated_at, completed_at
         from team_tasks
         ${where}
         order by created_at asc, id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => teamTaskFromRow(row));
  }

  async teamMessages(query: TeamMessageQuery = {}): Promise<TeamMessageRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.messageId) {
      clauses.push("m.id = $messageId");
      params.messageId = query.messageId;
    }
    if (query.teamId) {
      clauses.push("m.team_id = $teamId");
      params.teamId = query.teamId;
    }
    if (query.path) {
      clauses.push("(m.from_path = $path or m.to_path = $path or m.to_path = '*')");
      params.path = query.path;
    }
    if (query.taskId) {
      clauses.push("m.task_id = $taskId");
      params.taskId = query.taskId;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<TeamMessageProjectionRow, any>(
        `select m.id, m.team_id, m.from_path, m.to_path, m.task_id, m.kind, m.delivery, m.content,
                m.summary, m.metadata_json, m.created_at,
                (
                  select case
                    when count(*) = 0 then null
                    when sum(case when d.status = 'failed' then 1 else 0 end) > 0 then 'failed'
                    when sum(case when d.status = 'delivering' then 1 else 0 end) > 0 then 'delivering'
                    when sum(case when d.status = 'queued' then 1 else 0 end) > 0 then 'queued'
                    else 'delivered'
                  end
                  from team_message_deliveries d
                  where d.team_message_id = m.id
                ) as delivery_status,
                (
                  select d.error
                  from team_message_deliveries d
                  where d.team_message_id = m.id and d.error is not null
                  order by d.updated_at desc, d.mailbox_message_id asc
                  limit 1
                ) as delivery_error,
                (
                  select max(d.updated_at)
                  from team_message_deliveries d
                  where d.team_message_id = m.id
                ) as delivery_updated_at,
                (
                  select max(d.delivered_at)
                  from team_message_deliveries d
                  where d.team_message_id = m.id
                ) as delivered_at
         from team_messages m
         ${where}
         order by m.created_at asc, m.rowid asc, m.id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => teamMessageFromRow(row));
  }

  async teamMessageDeliveries(query: TeamMessageDeliveryQuery = {}): Promise<TeamMessageDeliveryRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.teamId) {
      clauses.push("team_id = $teamId");
      params.teamId = query.teamId;
    }
    if (query.teamMessageId) {
      clauses.push("team_message_id = $teamMessageId");
      params.teamMessageId = query.teamMessageId;
    }
    if (query.mailboxMessageId) {
      clauses.push("mailbox_message_id = $mailboxMessageId");
      params.mailboxMessageId = query.mailboxMessageId;
    }
    if (query.path) {
      clauses.push("path = $path");
      params.path = query.path;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<TeamMessageDeliveryProjectionRow, any>(
        `select mailbox_message_id, team_id, team_message_id, path, child_session_id,
                trigger_turn, status, error, queued_at, updated_at, delivered_at
         from team_message_deliveries
         ${where}
         order by updated_at asc, mailbox_message_id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => teamMessageDeliveryFromRow(row));
  }

  async claimTeamTask(input: TeamTaskClaimInput): Promise<TeamTaskMutationResult> {
    const admittedInput: TeamTaskClaimInput = {
      ...input,
      ...(input.metadata
        ? { metadata: boundedCasMetadata(input.metadata, "team task claim metadata") }
        : {}),
    };
    const run = this.db.transaction((item: TeamTaskClaimInput) => {
      const current = this.teamTaskState(item.teamId, item.taskId);
      if (!current) return { applied: false, reason: "not_found" as const, events: [] as ChiliEvent[] };
      if (isFinalTeamTaskStatus(current.status)) {
        return { applied: false, reason: "already_resolved" as const, events: [] as ChiliEvent[] };
      }
      if (current.status === "blocked" || !this.teamTaskDependenciesComplete(current)) {
        return { applied: false, reason: "blocked" as const, events: [] as ChiliEvent[] };
      }
      if (current.status !== "pending" || (current.owner_path && current.owner_path !== item.ownerPath)) {
        return { applied: false, reason: "already_claimed" as const, events: [] as ChiliEvent[] };
      }
      if (this.teamMemberUnavailableForClaim(item.teamId, item.ownerPath, item.taskId)) {
        return { applied: false, reason: "member_unavailable" as const, events: [] as ChiliEvent[] };
      }
      if (this.teamTaskHasRunningWriteConflict(current)) {
        return { applied: false, reason: "write_conflict" as const, events: [] as ChiliEvent[] };
      }

      const event = this.teamTaskClaimedEvent(item, current);
      const cas = this.db
        .query(
          `update team_tasks
           set owner_path = $ownerPath,
               status = 'in_progress',
               metadata_json = $metadata,
               updated_at = $time,
               completed_at = null
           where id = $taskId
             and team_id = $teamId
             and status = 'pending'
             and (owner_path is null or owner_path = $ownerPath)`,
        )
        .run({
          teamId: item.teamId,
          taskId: item.taskId,
          ownerPath: item.ownerPath,
          metadata: item.metadata ? encodeJson(item.metadata) : current.metadata_json,
          time: event.time,
        });
      if (cas.changes === 0) return { applied: false, reason: "already_claimed" as const, events: [] as ChiliEvent[] };
      this.writeTransactionEvents([event], item.runClaim);
      return { applied: true, events: [event] };
    });
    const result = this.runWithWriteRetry(() => run(admittedInput));

    await this.writeMirrors(result.events);
    const task = (await this.teamTasks({ teamId: input.teamId, taskId: input.taskId, limit: 1 }))[0];
    return { ...result, ...(task ? { task } : {}) };
  }

  async bindTeamOwnerSession(input: TeamOwnerSessionBindInput): Promise<TeamOwnerSessionBindResult> {
    const run = this.db.transaction((item: TeamOwnerSessionBindInput) => {
      const current = this.db
        .query<{ session_id: string | null; status: TeamRow["status"] }, [string]>(
          `select session_id, status from teams where id = ?`,
        )
        .get(item.teamId);
      if (!current) {
        return { applied: false, reason: "not_found" as const, events: [] as ChiliEvent[] };
      }
      if (current.status !== "active") {
        return {
          applied: false,
          reason: "team_inactive" as const,
          ...(current.session_id ? { ownerSessionId: current.session_id as SessionId } : {}),
          events: [] as ChiliEvent[],
        };
      }
      if (current.session_id) {
        return current.session_id === item.ownerSessionId
          ? {
              applied: false,
              reason: "already_bound" as const,
              ownerSessionId: current.session_id as SessionId,
              events: [] as ChiliEvent[],
            }
          : {
              applied: false,
              reason: "conflict" as const,
              ownerSessionId: current.session_id as SessionId,
              events: [] as ChiliEvent[],
            };
      }

      const session = this.teamOwnerSessionState(item.ownerSessionId);
      if (!session) {
        return { applied: false, reason: "session_not_found" as const, events: [] as ChiliEvent[] };
      }
      if (session.status !== "active") {
        return { applied: false, reason: "session_inactive" as const, events: [] as ChiliEvent[] };
      }
      if (session.source === "subagent" || this.subagentSessionReservationExists(item.ownerSessionId)) {
        return { applied: false, reason: "subagent_session" as const, events: [] as ChiliEvent[] };
      }

      const time = (item.time ?? Date.now()) as TimestampMs;
      const event: Extract<ChiliEvent, { type: "team.owner_session_bound" }> = {
        id: item.eventId,
        type: "team.owner_session_bound",
        time,
        sessionId: item.ownerSessionId,
        payload: {
          teamId: item.teamId,
          ownerSessionId: item.ownerSessionId,
        },
      };
      const cas = this.db
        .query(
          `update teams
              set session_id = $ownerSessionId,
                  updated_at = $time
            where id = $teamId
              and status = 'active'
              and session_id is null`,
        )
        .run({
          teamId: item.teamId,
          ownerSessionId: item.ownerSessionId,
          time,
        });
      if (cas.changes === 0) {
        const latest = this.db
          .query<{ session_id: string | null; status: TeamRow["status"] }, [string]>(
            `select session_id, status from teams where id = ?`,
          )
          .get(item.teamId);
        if (!latest) return { applied: false, reason: "not_found" as const, events: [] as ChiliEvent[] };
        if (latest.status !== "active") {
          return {
            applied: false,
            reason: "team_inactive" as const,
            ...(latest.session_id ? { ownerSessionId: latest.session_id as SessionId } : {}),
            events: [] as ChiliEvent[],
          };
        }
        return latest.session_id === item.ownerSessionId
          ? {
              applied: false,
              reason: "already_bound" as const,
              ownerSessionId: item.ownerSessionId,
              events: [] as ChiliEvent[],
            }
          : {
              applied: false,
              reason: "conflict" as const,
              ...(latest.session_id ? { ownerSessionId: latest.session_id as SessionId } : {}),
              events: [] as ChiliEvent[],
            };
      }
      this.writeTransactionEvents([event], item.runClaim);
      return {
        applied: true,
        ownerSessionId: item.ownerSessionId,
        events: [event],
      };
    });
    const result = this.runWithWriteRetry(() => run(input));
    await this.writeMirrors(result.events);
    const team = (await this.teams({ teamId: input.teamId, limit: 1 }))[0];
    return { ...result, ...(team ? { team } : {}) };
  }

  async claimTeamTaskVerification(input: TeamTaskVerificationClaimInput): Promise<TeamTaskVerificationClaimResult> {
    const admittedInput: TeamTaskVerificationClaimInput = {
      ...input,
      metadata: boundedCasMetadata(
        input.metadata,
        "team task verification metadata",
        ["verification"],
      ),
    };
    const run = this.db.transaction((item: TeamTaskVerificationClaimInput) => {
      const current = this.teamTaskState(item.teamId, item.taskId);
      if (!current) return { applied: false, reason: "not_found" as const, events: [] as ChiliEvent[] };
      const currentVerification = verificationStatus(current.metadata_json);
      if (current.status !== "completed") return { applied: false, reason: "not_completed" as const, events: [] as ChiliEvent[] };
      if (currentVerification === "passed") return { applied: false, reason: "already_verified" as const, events: [] as ChiliEvent[] };
      if (currentVerification === "pending" && !isStalePendingVerification(current.metadata_json, item.stalePendingBefore)) {
        return { applied: false, reason: "verification_pending" as const, events: [] as ChiliEvent[] };
      }

      const metadata = boundedCasMetadata(
        verificationClaimMetadata(current.metadata_json, item.metadata),
        "team task verification metadata",
        ["verification", ...TEAM_TASK_RUNTIME_METADATA_KEYS],
      );
      const event = this.teamTaskVerificationClaimedEvent(item, current, metadata);
      const cas = this.db
        .query(
          `update team_tasks
           set metadata_json = $metadata,
               updated_at = $time
           where id = $taskId
             and team_id = $teamId
             and status = 'completed'
             and (($currentMetadata is null and metadata_json is null) or metadata_json = $currentMetadata)`,
        )
        .run({
          teamId: item.teamId,
          taskId: item.taskId,
          metadata: encodeJson(metadata),
          currentMetadata: current.metadata_json,
          time: event.time,
        });
      if (cas.changes === 0) {
        const latest = this.teamTaskState(item.teamId, item.taskId);
        if (!latest) return { applied: false, reason: "not_found" as const, events: [] as ChiliEvent[] };
        const latestVerification = verificationStatus(latest.metadata_json);
        if (latest.status !== "completed") return { applied: false, reason: "not_completed" as const, events: [] as ChiliEvent[] };
        if (latestVerification === "passed") return { applied: false, reason: "already_verified" as const, events: [] as ChiliEvent[] };
        if (latestVerification === "pending" && !isStalePendingVerification(latest.metadata_json, item.stalePendingBefore)) {
          return { applied: false, reason: "verification_pending" as const, events: [] as ChiliEvent[] };
        }
        return { applied: false, reason: "stale" as const, events: [] as ChiliEvent[] };
      }

      this.writeTransactionEvents([event], item.runClaim);
      return { applied: true, events: [event] };
    });
    const result = this.runWithWriteRetry(() => run(admittedInput));

    await this.writeMirrors(result.events);
    const task = (await this.teamTasks({ teamId: input.teamId, taskId: input.taskId, limit: 1 }))[0];
    return { ...result, ...(task ? { task } : {}) };
  }

  async syncTeamTaskFromAgentCas(input: TeamTaskAgentSyncInput): Promise<TeamTaskAgentSyncResult> {
    const admittedInput: TeamTaskAgentSyncInput = {
      ...input,
      metadata: boundedCasMetadata(input.metadata, "team task sync metadata"),
      ...(input.summary !== undefined
        ? { summary: boundedCasText(input.summary, "team task summary") }
        : {}),
      ...(input.error !== undefined
        ? { error: normalizePersistedError(input.error).message }
        : {}),
    };
    const run = this.db.transaction((item: TeamTaskAgentSyncInput) => {
      const current = this.teamTaskState(item.teamId, item.taskId);
      if (!current) return { applied: false, reason: "not_found" as const, events: [] as ChiliEvent[] };
      if (current.status !== "in_progress") {
        return { applied: false, reason: "not_in_progress" as const, events: [] as ChiliEvent[] };
      }
      const nextMetadataJson = encodeJson(item.metadata);
      const dispatchIdentity = teamTaskDispatchSyncIdentity(
        current.metadata_json,
        nextMetadataJson,
        item,
      );
      if (!dispatchIdentity) {
        return { applied: false, reason: "binding_mismatch" as const, events: [] as ChiliEvent[] };
      }

      const agent = this.agentTaskState(item.agentTaskId);
      if (
        !agent ||
        agent.generation !== item.agentGeneration ||
        (
          dispatchIdentity.modern
            ? agent.dispatch_id !== dispatchIdentity.dispatchId
              || agent.reserved_run_id !== item.agentRunId
              || (
                agent.current_run_id !== item.agentRunId
                && !(dispatchIdentity.allowUnspawned && agent.current_run_id === null)
              )
            : agent.current_run_id !== item.agentRunId
        )
      ) {
        return { applied: false, reason: "binding_mismatch" as const, events: [] as ChiliEvent[] };
      }
      if (!isFinalTaskStatus(agent.status) || agent.status !== item.agentStatus) {
        return { applied: false, reason: "agent_not_terminal" as const, events: [] as ChiliEvent[] };
      }
      if (!teamTaskStatusMatchesAgentStatus(item.status, item.agentStatus)) {
        return { applied: false, reason: "binding_mismatch" as const, events: [] as ChiliEvent[] };
      }

      const time = item.time ?? Date.now();
      const cas = this.db
        .query(
          `update team_tasks
           set updated_at = updated_at
           where id = $taskId
             and team_id = $teamId
             and status = 'in_progress'
             and (($ownerPath is null and owner_path is null) or owner_path = $ownerPath)
             and (($currentMetadata is null and metadata_json is null) or metadata_json = $currentMetadata)
             and exists (
               select 1 from agent_tasks
               where id = $agentTaskId
                 and generation = $agentGeneration
                 and (
                   ($modernDispatch = 0 and current_run_id = $agentRunId)
                   or (
                     $modernDispatch = 1
                     and dispatch_id = $dispatchId
                     and reserved_run_id = $agentRunId
                     and (
                       current_run_id = $agentRunId
                       or ($allowUnspawned = 1 and current_run_id is null)
                     )
                   )
                 )
                 and status = $agentStatus
             )`,
        )
        .run({
          taskId: item.taskId,
          teamId: item.teamId,
          ownerPath: current.owner_path,
          currentMetadata: current.metadata_json,
          agentTaskId: item.agentTaskId,
          agentGeneration: item.agentGeneration,
          agentRunId: item.agentRunId,
          agentStatus: item.agentStatus,
          modernDispatch: dispatchIdentity.modern ? 1 : 0,
          dispatchId: dispatchIdentity.dispatchId ?? null,
          allowUnspawned: dispatchIdentity.allowUnspawned ? 1 : 0,
        });
      if (cas.changes === 0) {
        return { applied: false, reason: "stale" as const, events: [] as ChiliEvent[] };
      }

      const taskEvent: Extract<ChiliEvent, { type: "team.task_updated" }> = {
        id: item.taskEventId,
        type: "team.task_updated",
        time: time as TimestampMs,
        payload: {
          teamId: item.teamId,
          taskId: item.taskId,
          status: item.status,
          metadata: item.metadata,
          ...(item.summary !== undefined ? { summary: item.summary } : {}),
          ...(item.error !== undefined ? { error: item.error } : {}),
        },
      };
      const sessionId = item.sessionId ?? this.sessionIdForTeamTask(current.id);
      if (sessionId) taskEvent.sessionId = sessionId as SessionId;

      const events: ChiliEvent[] = [taskEvent];
      if (current.owner_path) {
        const memberEvent: Extract<ChiliEvent, { type: "team.member_status_changed" }> = {
          id: item.memberEventId,
          type: "team.member_status_changed",
          time: time as TimestampMs,
          payload: {
            teamId: item.teamId,
            path: current.owner_path as AgentPath,
            status: "idle",
            reason: `task_${item.status}`,
          },
        };
        if (sessionId) memberEvent.sessionId = sessionId as SessionId;
        events.push(memberEvent);
      }

      this.writeTransactionEvents(events, item.runClaim);
      return { applied: true, events };
    });
    const result = this.runWithWriteRetry(() => run(admittedInput));

    await this.writeMirrors(result.events);
    const task = (await this.teamTasks({ teamId: input.teamId, taskId: input.taskId, limit: 1 }))[0];
    return { ...result, ...(task ? { task } : {}) };
  }

  async claimAgentMailboxMessage(input: AgentMailboxClaimInput): Promise<AgentMailboxMutationResult> {
    const run = this.db.transaction((item: AgentMailboxClaimInput) => {
      const current = this.agentMailboxState(item.messageId);
      if (!current || current.status !== "queued") return { applied: false, events: [] as ChiliEvent[] };

      const event = this.agentMailboxClaimedEvent(item, current);
      const cas = this.db
        .query(`update agent_mailbox set status = 'delivering' where id = $messageId and status = 'queued'`)
        .run({ messageId: item.messageId });
      if (cas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };
      this.writeTransactionEvents([event]);
      return { applied: true, events: [event] };
    });
    const result = this.runWithWriteRetry(() => run(input));

    await this.writeMirrors(result.events);
    const message = await this.agentMailboxMessage(input.messageId);
    return { ...result, ...(message ? { message } : {}) };
  }

  async consumeAgentMailboxMessage(input: AgentMailboxConsumeInput): Promise<AgentMailboxMutationResult> {
    const run = this.db.transaction((item: AgentMailboxConsumeInput) => {
      const current = this.agentMailboxState(item.messageId);
      if (!current || current.status === "consumed") return { applied: false, events: [] as ChiliEvent[] };
      if (current.status !== "delivering") return { applied: false, events: [] as ChiliEvent[] };

      const event = this.agentMailboxConsumedEvent(item, current);
      const cas = this.db
        .query(
          `update agent_mailbox
           set status = 'consumed',
               consumed_at = $time
           where id = $messageId
             and status = 'delivering'`,
        )
        .run({ messageId: item.messageId, time: event.time });
      if (cas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };
      this.writeTransactionEvents([event]);
      return { applied: true, events: [event] };
    });
    const result = this.runWithWriteRetry(() => run(input));

    await this.writeMirrors(result.events);
    const message = await this.agentMailboxMessage(input.messageId);
    return { ...result, ...(message ? { message } : {}) };
  }

  async requeueAgentMailboxMessage(input: AgentMailboxRequeueInput): Promise<AgentMailboxMutationResult> {
    const admittedInput: AgentMailboxRequeueInput = {
      ...input,
      ...(input.error !== undefined
        ? { error: normalizePersistedError(input.error).message }
        : {}),
    };
    const run = this.db.transaction((item: AgentMailboxRequeueInput) => {
      const current = this.agentMailboxState(item.messageId);
      if (!current || current.status !== "delivering") return { applied: false, events: [] as ChiliEvent[] };

      const event = this.agentMailboxRequeuedEvent(item, current);
      const cas = this.db
        .query(
          `update agent_mailbox
           set status = 'queued',
               consumed_at = null
           where id = $messageId
             and status = 'delivering'`,
        )
        .run({ messageId: item.messageId });
      if (cas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };
      this.writeTransactionEvents([event]);
      return { applied: true, events: [event] };
    });
    const result = this.runWithWriteRetry(() => run(admittedInput));

    await this.writeMirrors(result.events);
    const message = await this.agentMailboxMessage(input.messageId);
    return { ...result, ...(message ? { message } : {}) };
  }

  async discardAgentMailboxMessage(input: AgentMailboxDiscardInput): Promise<AgentMailboxMutationResult> {
    const admittedInput: AgentMailboxDiscardInput = {
      ...input,
      reason: normalizePersistedError(input.reason).message,
    };
    const run = this.db.transaction((item: AgentMailboxDiscardInput) => {
      const current = this.agentMailboxState(item.messageId);
      if (!current || current.status === "consumed" || current.status === "discarded") {
        return { applied: false, events: [] as ChiliEvent[] };
      }
      if (current.status !== "delivering") return { applied: false, events: [] as ChiliEvent[] };

      const event = this.agentMailboxDiscardedEvent(item, current);
      const cas = this.db
        .query(
          `update agent_mailbox
           set status = 'discarded',
               consumed_at = $time
           where id = $messageId
             and status = 'delivering'`,
        )
        .run({ messageId: item.messageId, time: event.time });
      if (cas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };
      this.writeTransactionEvents([event]);
      return { applied: true, events: [event] };
    });
    const result = this.runWithWriteRetry(() => run(admittedInput));

    await this.writeMirrors(result.events);
    const message = await this.agentMailboxMessage(input.messageId);
    return { ...result, ...(message ? { message } : {}) };
  }

  async claimAgentTaskLease(input: AgentTaskLeaseClaimInput): Promise<AgentTaskLeaseResult> {
    const run = this.db.transaction((item: AgentTaskLeaseClaimInput) => {
      const now = item.now ?? Date.now();
      const expiresAt = now + item.ttlMs;
      const result = this.db.query(
        `update agent_tasks
         set lease_owner = $owner,
             lease_expires_at = $expiresAt,
             lease_heartbeat_at = $now,
             generation = generation + 1,
             updated_at = $now
         where id = $taskId
           and status = 'running'
           and ($runId is null or current_run_id = $runId)
           and ($generation is null or generation = $generation)
           and (
             lease_owner is null
             or lease_expires_at is null
             or lease_expires_at <= $now
           )`,
      ).run({
        taskId: item.taskId,
        owner: item.owner,
        runId: item.runId ?? null,
        generation: item.generation ?? null,
        now,
        expiresAt,
      });
      if (result.changes > 0) {
        this.db.query(
          `update agent_runs
           set generation = max(
             generation,
             coalesce((select generation from agent_tasks where id = $taskId), generation)
           )
           where id = (select current_run_id from agent_tasks where id = $taskId)`,
        ).run({ taskId: item.taskId });
      }
      const row = this.agentTaskProjectionState(item.taskId);
      const task = row ? agentTaskFromRow(row) : undefined;
      return result.changes > 0 && task ? { acquired: true, task } : { acquired: false, ...(task ? { task } : {}) };
    });
    return this.runWithWriteRetry(() => run(input));
  }

  async renewAgentTaskLease(input: AgentTaskLeaseRenewInput): Promise<AgentTaskLeaseResult> {
    const now = input.now ?? Date.now();
    const expiresAt = now + input.ttlMs;
    const result = this.db
      .query(
        `update agent_tasks
         set lease_expires_at = $expiresAt,
             lease_heartbeat_at = $now,
             updated_at = $now
         where id = $taskId
           and status = 'running'
           and lease_owner = $owner
           and generation = $generation
           and lease_expires_at > $now`,
      )
      .run({
        taskId: input.taskId,
        owner: input.owner,
        generation: input.generation,
        now,
        expiresAt,
      });
    const task = await this.agentTask(input.taskId);
    return result.changes > 0 && task ? { acquired: true, task } : { acquired: false, ...(task ? { task } : {}) };
  }

  async releaseAgentTaskLease(input: AgentTaskLeaseReleaseInput): Promise<boolean> {
    const now = input.now ?? Date.now();
    const result = this.db
      .query(
        `update agent_tasks
         set lease_owner = null,
             lease_expires_at = null,
             lease_heartbeat_at = null,
             updated_at = $now
         where id = $taskId
           and lease_owner = $owner
           and generation = $generation`,
      )
      .run({
        taskId: input.taskId,
        owner: input.owner,
        generation: input.generation,
        now,
      });
    return result.changes > 0;
  }

  async beginAgentTaskRunCas(input: AgentTaskBeginRunCasInput): Promise<AgentTaskBeginRunResult> {
    const admittedInput: AgentTaskBeginRunCasInput = {
      ...input,
      ...(input.message
        ? { message: boundedCasMailboxPayload(input.message) }
        : {}),
    };
    const run = this.db.transaction((item: AgentTaskBeginRunCasInput) => {
      const current = this.agentTaskState(item.taskId);
      if (!current) return { applied: false, events: [] as ChiliEvent[] };
      const reservedInitial = item.reservedInitial === true;
      if (reservedInitial) {
        if (
          current.status !== "pending"
          || current.generation !== 0
          || current.current_run_id !== null
          || current.lease_owner !== null
          || current.dispatch_id === null
          || current.reserved_run_id !== item.runId
        ) {
          return { applied: false, events: [] as ChiliEvent[] };
        }
        if (
          item.expectedGeneration !== 0
          || item.expectedRunId !== null
          || item.expectedLeaseOwner !== null
        ) {
          throw new Error("reserved initial agent task run requires pending generation 0 without a run or lease");
        }
        if (item.sourceMailboxMessageId || item.messageEventId || item.messageClaimEventId || item.message) {
          throw new Error("reserved initial agent task run cannot include a follow-up message");
        }
      } else {
        if (
          current.dispatch_id !== null
          || current.reserved_run_id !== null
          || isTeamTaskWorkerPolicyJson(current.worker_policy_json)
        ) {
          return { applied: false, events: [] as ChiliEvent[] };
        }
        if (!isFinalTaskStatus(current.status)) {
          return { applied: false, events: [] as ChiliEvent[] };
        }
      }
      if (item.generation !== item.expectedGeneration + 1) {
        throw new Error("agent task run generation must advance its expected generation fence by one");
      }
      const existingRun = this.db
        .query<{ found: number }, [string]>(
          `select 1 as found from agent_runs where id = ? limit 1`,
        )
        .get(item.runId);
      if (existingRun) {
        throw new Error(`agent task run cannot reuse existing runId ${item.runId}`);
      }
      if ((item.messageEventId === undefined) !== (item.message === undefined)) {
        throw new Error("agent task run messageEventId and message must be provided together");
      }
      if ((item.messageClaimEventId === undefined) !== (item.message === undefined)) {
        throw new Error("agent task run messageClaimEventId and message must be provided together");
      }
      if (item.sourceMailboxMessageId && item.messageEventId) {
        throw new Error("agent task run sourceMailboxMessageId cannot be combined with a new message");
      }
      if (item.messageEventId && !item.from) {
        throw new Error("agent task run queued message requires from");
      }
      if (!Number.isFinite(item.leaseTtlMs) || item.leaseTtlMs <= 0) {
        throw new Error("agent task run leaseTtlMs must be positive");
      }
      if (item.sourceMailboxMessageId) {
        // A mailbox retry may recover an interrupted generation, but it must
        // never reopen a task that was explicitly cancelled after delivery was
        // claimed. Manual follow-ups (without a source message) remain allowed.
        if (current.status === "cancelled") return { applied: false, events: [] as ChiliEvent[] };
        const message = this.agentMailboxState(item.sourceMailboxMessageId);
        if (!message || message.status !== "delivering" || message.task_id !== item.taskId) {
          return { applied: false, events: [] as ChiliEvent[] };
        }
      }

      const cas = reservedInitial
        ? this.db
            .query(
              `update agent_tasks
               set updated_at = updated_at
               where id = $taskId
                 and status = 'pending'
                 and generation = 0
                 and current_run_id is null
                 and lease_owner is null
                 and dispatch_id is not null
                 and reserved_run_id = $runId`,
            )
            .run({ taskId: item.taskId, runId: item.runId })
        : this.db
            .query(
              `update agent_tasks
               set updated_at = updated_at
               where id = $taskId
                 and status in ('completed', 'incomplete', 'failed', 'cancelled')
                 and generation = $expectedGeneration
                 and current_run_id is $expectedRunId
                 and lease_owner is $expectedLeaseOwner`,
            )
            .run({
              taskId: item.taskId,
              expectedGeneration: item.expectedGeneration,
              expectedRunId: item.expectedRunId,
              expectedLeaseOwner: item.expectedLeaseOwner,
            });
      if (cas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };

      const now = item.time ?? Date.now();
      const sessionId = item.sessionId ?? current.parent_session_id ?? current.child_session_id;
      const events: ChiliEvent[] = [];
      if (item.messageEventId && item.message && item.from) {
        const messageEvent: Extract<ChiliEvent, { type: "agent.message_queued" }> = {
          id: item.messageEventId,
          type: "agent.message_queued",
          time: now as TimestampMs,
          payload: {
            taskId: item.taskId,
            path: current.path as AgentPath,
            from: item.from,
            triggerTurn: true,
            ...(current.child_session_id ? { recipientSessionId: current.child_session_id as SessionId } : {}),
            message: item.message,
          },
        };
        if (sessionId) messageEvent.sessionId = sessionId as SessionId;
        events.push(messageEvent);

        const claimEvent: Extract<ChiliEvent, { type: "agent.message_claimed" }> = {
          id: item.messageClaimEventId!,
          type: "agent.message_claimed",
          time: now as TimestampMs,
          payload: {
            messageId: item.messageEventId,
            taskId: item.taskId,
            path: current.path as AgentPath,
            claimedBy: current.path as AgentPath,
          },
        };
        if (sessionId) claimEvent.sessionId = sessionId as SessionId;
        events.push(claimEvent);
      }

      const spawnEvent: Extract<ChiliEvent, { type: "agent.spawned" }> = {
        id: item.spawnEventId,
        type: "agent.spawned",
        time: now as TimestampMs,
        payload: {
          runId: item.runId,
          taskId: item.taskId,
          path: current.path as AgentPath,
          ...(current.parent_path ? { parentPath: current.parent_path as AgentPath } : {}),
          ...(current.parent_session_id ? { parentSessionId: current.parent_session_id as SessionId } : {}),
          ...(current.child_session_id ? { childSessionId: current.child_session_id as SessionId } : {}),
          taskName: current.task_name,
          ...(current.cwd ? { cwd: current.cwd } : {}),
          ...(current.mode ? { mode: current.mode as NonNullable<Extract<ChiliEvent, { type: "agent.spawned" }>["payload"]["mode"]> } : {}),
          ...(current.worker_policy_json
            ? { workerPolicy: decodeJson<Record<string, unknown>>(current.worker_policy_json, {}) }
            : {}),
          ...(current.source_call_id ? { sourceCallId: current.source_call_id as ToolCallId } : {}),
          ...(current.batch_id ? { batchId: current.batch_id } : {}),
          ...(current.batch_index !== null ? { batchIndex: current.batch_index } : {}),
          ...(current.expected_batch_size !== null
            ? { expectedBatchSize: current.expected_batch_size }
            : {}),
          ...(current.completion_policy
            ? {
                completionPolicy: current.completion_policy as NonNullable<
                  Extract<ChiliEvent, { type: "agent.spawned" }>["payload"]["completionPolicy"]
                >,
              }
            : {}),
          ...(current.max_concurrency !== null ? { maxConcurrency: current.max_concurrency } : {}),
          generation: item.generation,
        },
      };
      if (sessionId) spawnEvent.sessionId = sessionId as SessionId;
      events.push(spawnEvent);
      this.writeTransactionEvents(events);
      const lease = this.db.query(
        `update agent_tasks
         set lease_owner = $leaseOwner,
             lease_expires_at = $leaseExpiresAt,
             lease_heartbeat_at = $now,
             updated_at = $now
         where id = $taskId
           and status = 'running'
           and generation = $generation
           and current_run_id = $runId
           and lease_owner is null`,
      ).run({
        taskId: item.taskId,
        generation: item.generation,
        runId: item.runId,
        leaseOwner: item.leaseOwner,
        leaseExpiresAt: now + item.leaseTtlMs,
        now,
      });
      if (lease.changes !== 1) {
        throw new Error("agent task run lease claim lost its committed generation");
      }
      return { applied: true, events };
    });
    const result = this.runWithWriteRetry(() => run(admittedInput));

    await this.writeMirrors(result.events);
    const task = await this.agentTask(input.taskId);
    return { ...result, ...(task ? { task } : {}) };
  }

  async completeAgentTaskCas(input: AgentTaskCompleteCasInput): Promise<AgentTaskFinalizationResult> {
    const admittedInput = admittedAgentTaskCompleteInput(input);
    const run = this.db.transaction((item: AgentTaskCompleteCasInput) => {
      const current = this.agentTaskState(item.taskId);
      if (!current || isFinalTaskStatus(current.status)) return { applied: false, events: [] as ChiliEvent[] };

      const generation = normalizedGeneration(item.generation) ?? item.expectedGeneration;
      if (generation !== item.expectedGeneration) {
        throw new Error("agent task completion generation must match its expected generation fence");
      }
      if ((item.runId ?? null) !== item.expectedRunId) {
        throw new Error("agent task completion runId must match its expected run fence");
      }
      if (item.expectedRunId && !item.agentEventId) {
        throw new Error("agent task completion for a spawned run requires agentEventId");
      }
      if ((item.mailboxMessageId === undefined) !== (item.mailboxConsumeEventId === undefined)) {
        throw new Error("agent task completion mailboxMessageId and mailboxConsumeEventId must be provided together");
      }
      const now = item.time ?? Date.now();
      const cas = this.db
        .query(
          `update agent_tasks
           set updated_at = updated_at
           where id = $taskId
             and status = 'running'
             and current_run_id is $expectedRunId
             and generation = $expectedGeneration
             and lease_owner is $expectedLeaseOwner
             and ($requireActiveLease = 0 or lease_expires_at > $now)`,
        )
        .run({
          taskId: item.taskId,
          expectedRunId: item.expectedRunId,
          expectedGeneration: item.expectedGeneration,
          expectedLeaseOwner: item.expectedLeaseOwner,
          requireActiveLease: item.requireActiveLease ? 1 : 0,
          now,
        });
      if (cas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };

      let mailbox: AgentMailboxProjectionRow | undefined;
      if (item.mailboxMessageId) {
        mailbox = this.agentMailboxState(item.mailboxMessageId);
        if (!mailbox || mailbox.status !== "delivering" || mailbox.task_id !== item.taskId) {
          return { applied: false, events: [] as ChiliEvent[] };
        }
        const mailboxCas = this.db
          .query(
            `update agent_mailbox
             set status = status
             where id = $messageId
               and task_id = $taskId
               and status = 'delivering'`,
          )
          .run({ messageId: item.mailboxMessageId, taskId: item.taskId });
        if (mailboxCas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };
      }

      const event = this.taskCompletedEvent(item, current, generation);
      const events: ChiliEvent[] = [event];
      if (item.runId && item.agentEventId) events.push(this.agentCompletedEvent(item, current, generation));
      if (mailbox && item.mailboxMessageId && item.mailboxConsumeEventId) {
        events.push(this.agentMailboxConsumedEvent({
          messageId: item.mailboxMessageId,
          eventId: item.mailboxConsumeEventId,
          consumedBy: mailbox.path as AgentPath,
          ...(item.sessionId ? { sessionId: item.sessionId } : {}),
          time: now,
        }, mailbox));
      }
      this.writeTransactionEvents(events, item.runClaim);
      return { applied: true, events };
    });
    const result = this.runWithWriteRetry(() => run(admittedInput));

    await this.writeMirrors(result.events);
    const task = await this.agentTask(input.taskId);
    return { ...result, ...(task ? { task } : {}) };
  }

  async closeAgentTaskCas(input: AgentTaskCloseCasInput): Promise<AgentTaskFinalizationResult> {
    const admittedInput: AgentTaskCloseCasInput = {
      ...input,
      ...(input.summary !== undefined
        ? { summary: boundedCasText(input.summary, "agent task summary") }
        : {}),
      ...(input.error !== undefined
        ? { error: normalizePersistedError(input.error).message }
        : {}),
      ...(input.mailboxError !== undefined
        ? { mailboxError: normalizePersistedError(input.mailboxError).message }
        : {}),
    };
    const run = this.db.transaction((item: AgentTaskCloseCasInput) => {
      const current = this.agentTaskState(item.taskId);
      if (!current) return { applied: false, events: [] as ChiliEvent[] };
      if (isFinalTaskStatus(current.status)) return { applied: false, events: [] as ChiliEvent[] };
      if (item.expectedRunId && !item.agentEventId) {
        throw new Error("agent task closure for a spawned run requires agentEventId");
      }
      if (item.requireActiveLease && item.requireExpiredLease) {
        throw new Error("agent task closure cannot require both an active and an expired lease");
      }
      const mailboxFields = [item.mailboxMessageId, item.mailboxEventId, item.mailboxDisposition];
      if (mailboxFields.some((value) => value !== undefined) && mailboxFields.some((value) => value === undefined)) {
        throw new Error(
          "agent task closure mailboxMessageId, mailboxEventId, and mailboxDisposition must be provided together",
        );
      }
      if (item.mailboxError !== undefined && item.mailboxDisposition !== "requeue") {
        throw new Error("agent task closure mailboxError requires mailboxDisposition requeue");
      }

      const now = item.time ?? Date.now();

      const cas = this.db
        .query(
          `update agent_tasks
           set updated_at = updated_at
           where id = $taskId
             and status not in ('completed', 'incomplete', 'failed', 'cancelled')
             and generation = $expectedGeneration
             and current_run_id is $expectedRunId
             and lease_owner is $expectedLeaseOwner
             and ($requireActiveLease = 0 or lease_expires_at > $now)
             and ($checkLeaseExpiresAt = 0 or lease_expires_at is $expectedLeaseExpiresAt)
             and ($requireLeaseEvidence = 0 or (
               lease_owner is not null
               and length(lease_owner) > 0
               and lease_expires_at is not null
             ))
             and ($requireExpiredLease = 0 or lease_expires_at is null or lease_expires_at <= $now)
             and ($updatedBeforeOrAt is null or updated_at <= $updatedBeforeOrAt)`,
        )
        .run({
          taskId: item.taskId,
          expectedGeneration: item.expectedGeneration,
          expectedRunId: item.expectedRunId,
          expectedLeaseOwner: item.expectedLeaseOwner,
          requireActiveLease: item.requireActiveLease ? 1 : 0,
          checkLeaseExpiresAt: item.expectedLeaseExpiresAt !== undefined ? 1 : 0,
          expectedLeaseExpiresAt: item.expectedLeaseExpiresAt ?? null,
          requireLeaseEvidence: item.requireLeaseEvidence ? 1 : 0,
          requireExpiredLease: item.requireExpiredLease ? 1 : 0,
          updatedBeforeOrAt: item.updatedBeforeOrAt ?? null,
          now,
        });
      if (cas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };

      let mailbox: AgentMailboxProjectionRow | undefined;
      if (item.mailboxMessageId) {
        mailbox = this.agentMailboxState(item.mailboxMessageId);
        if (!mailbox || mailbox.status !== "delivering" || mailbox.task_id !== item.taskId) {
          return { applied: false, events: [] as ChiliEvent[] };
        }
        const mailboxCas = this.db
          .query(
            `update agent_mailbox
             set status = status
             where id = $messageId
               and task_id = $taskId
               and status = 'delivering'`,
          )
          .run({ messageId: item.mailboxMessageId, taskId: item.taskId });
        if (mailboxCas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };
      }

      const generation = current.generation + 1;
      const completionInput: AgentTaskCompleteCasInput = {
        taskId: item.taskId,
        path: current.path as AgentPath,
        status: item.status,
        eventId: item.eventId,
        expectedGeneration: item.expectedGeneration,
        expectedRunId: item.expectedRunId,
        expectedLeaseOwner: item.expectedLeaseOwner,
        generation,
      };
      if (current.current_run_id) completionInput.runId = current.current_run_id as NonNullable<AgentTaskCompleteCasInput["runId"]>;
      if (item.summary) completionInput.summary = item.summary;
      if (item.error) completionInput.error = item.error;
      if (item.agentEventId) completionInput.agentEventId = item.agentEventId;
      if (item.sessionId) completionInput.sessionId = item.sessionId;
      completionInput.time = now;

      const event = this.taskCompletedEvent(completionInput, current, generation);
      const events: ChiliEvent[] = [event];
      if (current.current_run_id && item.agentEventId) {
        events.push(this.agentCompletedEvent(completionInput, current, generation));
      }
      if (mailbox && item.mailboxMessageId && item.mailboxEventId && item.mailboxDisposition) {
        if (item.mailboxDisposition === "consume") {
          events.push(this.agentMailboxConsumedEvent({
            messageId: item.mailboxMessageId,
            eventId: item.mailboxEventId,
            consumedBy: mailbox.path as AgentPath,
            ...(item.sessionId ? { sessionId: item.sessionId } : {}),
            time: now,
          }, mailbox));
        } else {
          events.push(this.agentMailboxRequeuedEvent({
            messageId: item.mailboxMessageId,
            eventId: item.mailboxEventId,
            ...(item.mailboxError ? { error: item.mailboxError } : {}),
            ...(item.sessionId ? { sessionId: item.sessionId } : {}),
            time: now,
          }, mailbox));
        }
      }
      this.writeTransactionEvents(events, item.runClaim);
      return { applied: true, events };
    });
    const result = this.runWithWriteRetry(() => run(admittedInput));

    await this.writeMirrors(result.events);
    const task = await this.agentTask(input.taskId);
    return { ...result, ...(task ? { task } : {}) };
  }

  private writeTransaction(
    events: readonly ChiliEvent[],
    runClaim?: SessionRunClaimFence,
    creationClaim?: SessionCreationClaimFence,
    fenceEvents: readonly ChiliEvent[] = events,
  ): ChiliEvent[] {
    const run = this.db.transaction((items: readonly ChiliEvent[]) => {
      return this.writeTransactionEvents(items, runClaim, creationClaim, fenceEvents);
    });
    return this.runWithWriteRetry(() => run(events));
  }

  private writeTransactionEvents(
    events: readonly ChiliEvent[],
    runClaim?: SessionRunClaimFence,
    creationClaim?: SessionCreationClaimFence,
    fenceEvents: readonly ChiliEvent[] = events,
  ): ChiliEvent[] {
    this.assertRunClaimFence(runClaim, fenceEvents);
    this.assertCreationClaimFence(creationClaim, fenceEvents);
    for (const event of fenceEvents) {
      validateScopedEventSessionIdentity(event);
      this.assertOwnedCreationClaim(event.sessionId);
      this.assertOwnedRunClaim(event.sessionId);
    }
    const committed: ChiliEvent[] = [];
    for (const event of events) {
      if (event.type === "agent.task_created") {
        const existing = this.agentTaskProjectionState(event.payload.taskId);
        if (existing) {
          if (sameAgentTaskCreationIdentity(existing, event.payload)) continue;
          throw new Error(
            `Agent task already exists with a different creation identity: ${event.payload.taskId}`,
          );
        }
        this.assertAgentTaskReservationAvailable(event.payload);
      }
      this.insertEvent(event);
      this.applyProjection(event);
      committed.push(event);
    }
    return committed;
  }

  private assertAgentTaskReservationAvailable(
    payload: Extract<AgentEvent, { type: "agent.task_created" }>["payload"],
  ): void {
    if (payload.dispatchId) {
      const conflict = this.db
        .query<{ id: string }, [string]>(
          `select id from agent_tasks where dispatch_id = ? limit 1`,
        )
        .get(payload.dispatchId);
      if (conflict && conflict.id !== payload.taskId) {
        throw new Error(`Agent dispatch identity already belongs to task ${conflict.id}: ${payload.dispatchId}`);
      }
    }
    if (payload.reservedRunId) {
      const conflict = this.db
        .query<{ id: string }, [string]>(
          `select id from agent_tasks where reserved_run_id = ? limit 1`,
        )
        .get(payload.reservedRunId);
      if (conflict && conflict.id !== payload.taskId) {
        throw new Error(`Agent run reservation already belongs to task ${conflict.id}: ${payload.reservedRunId}`);
      }
    }
  }

  private assertCreationClaimFence(
    creationClaim: SessionCreationClaimFence | undefined,
    events: readonly ChiliEvent[],
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
    events: readonly ChiliEvent[],
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
      if (!this.isRunClaimEventIdentityAuthorized(runClaim.sessionId, event)) {
        throw new SessionRunClaimConflictError(runClaim.sessionId);
      }
    }
  }

  private isRunClaimEventIdentityAuthorized(
    ownerSessionId: SessionId,
    event: ChiliEvent,
  ): boolean {
    const actorSessionId = event.sessionId;
    if (!actorSessionId) return false;
    if (actorSessionId === ownerSessionId) return true;

    if (event.type.startsWith("team.")) {
      const teamEvent = event as TeamEvent;
      const teamId = teamEvent.payload.teamId;
      let actorPath: AgentPath | undefined;
      if (teamEvent.type === "team.member_status_changed") {
        actorPath = teamEvent.payload.path;
      } else if (teamEvent.type === "team.task_claimed") {
        actorPath = teamEvent.payload.claimedBy ?? teamEvent.payload.ownerPath;
      } else if (teamEvent.type === "team.message_sent") {
        actorPath = teamEvent.payload.from;
      } else if (teamEvent.type === "team.task_created") {
        actorPath = teamEvent.payload.createdBy;
      } else if (teamEvent.type === "team.task_assigned") {
        actorPath = teamEvent.payload.assignedBy;
      } else if (teamEvent.type === "team.task_updated") {
        const ownerPath = this.db
          .query<{ owner_path: string | null }, [string, string]>(
            `select owner_path from team_tasks where team_id = ? and id = ?`,
          )
          .get(teamId, teamEvent.payload.taskId)?.owner_path;
        actorPath = ownerPath ? ownerPath as AgentPath : undefined;
      }
      return actorPath !== undefined && this.teamDescendantBindingExists({
        teamId,
        ownerSessionId,
        actorSessionId,
        actorPath,
      });
    }

    // Team mailbox fan-out is the sole agent event written with descendant
    // provenance under the owning team's run claim. All other agent/session/
    // goal/runtime events must use the claimed session identity exactly.
    if (event.type === "agent.message_queued") {
      const metadata = teamMailboxMetadata(event.payload.message);
      if (!metadata) return false;
      if (!this.teamDescendantBindingExists({
        teamId: metadata.teamId,
        ownerSessionId,
        actorSessionId,
        actorPath: event.payload.from,
      })) {
        return false;
      }
      const recipientSessionId = event.payload.recipientSessionId;
      if (!recipientSessionId) return false;
      return this.db
        .query<{ found: number }, [string, string, string]>(
          `select 1 as found
             from team_members
            where team_id = ?
              and path = ?
              and child_session_id = ?
              and status <> 'closed'
            limit 1`,
        )
        .get(metadata.teamId, event.payload.path, recipientSessionId) !== null;
    }

    return false;
  }

  private teamDescendantBindingExists(input: {
    teamId: TeamId;
    ownerSessionId: SessionId;
    actorSessionId: SessionId;
    actorPath: AgentPath;
  }): boolean {
    const team = this.db
      .query<{ lead_path: string }, [string, string, string, string]>(
        `select t.lead_path
           from teams t
           join team_members m on m.team_id = t.id
          where t.id = ?
            and t.session_id = ?
            and t.status = 'active'
            and m.child_session_id = ?
            and m.path = ?
            and m.status <> 'closed'
          limit 1`,
      )
      .get(input.teamId, input.ownerSessionId, input.actorSessionId, input.actorPath);
    if (!team) return false;

    return this.db
      .query<{ found: number }, {
        actorSessionId: string;
        actorPath: string;
        ownerSessionId: string;
        leadPath: string;
      }>(
        `with recursive ancestry(child_session_id, path, parent_session_id, parent_path) as (
           select child_session_id, path, parent_session_id, parent_path
             from agent_tasks
            where child_session_id = $actorSessionId
              and path = $actorPath
           union
           select parent.child_session_id, parent.path, parent.parent_session_id, parent.parent_path
             from agent_tasks parent
             join ancestry child on parent.child_session_id = child.parent_session_id
            where parent.path = child.parent_path
         )
         select 1 as found
           from ancestry
          where parent_session_id = $ownerSessionId
            and parent_path = $leadPath
          limit 1`,
      )
      .get({
        actorSessionId: input.actorSessionId,
        actorPath: input.actorPath,
        ownerSessionId: input.ownerSessionId,
        leadPath: team.lead_path,
      }) !== null;
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

  async reconcileStaleTurns(input: StaleTurnRecoveryInput): Promise<ChiliEvent[]> {
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
              and not exists (
                select 1
                  from agent_tasks task
                 where task.child_session_id = session.id
                   and task.status in ('pending', 'running')
                   and task.lease_expires_at > $now
              )
            order by coalesce(turn.seq, runtime.seq) asc`,
        )
        .all({ now: Number(now) });

      const events: ChiliEvent[] = [];
      for (const row of rows) {
        const sessionId = row.session_id as SessionId;
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

  private async writeMirror(event: ChiliEvent): Promise<void> {
    if (!this.options.mirror) return;
    try {
      await this.options.mirror.write(event);
    } catch (error) {
      this.options.onMirrorError?.(error, event);
    }
  }

  private async writeMirrors(events: readonly ChiliEvent[]): Promise<void> {
    for (const event of events) {
      await this.writeMirror(event);
    }
  }

  private taskCompletedEvent(
    input: AgentTaskCompleteCasInput,
    current: AgentTaskStateRow,
    generation: number,
  ): Extract<ChiliEvent, { type: "agent.task_completed" }> {
    const payload: AgentCompleteTaskPayload = {
      taskId: input.taskId,
      path: current.path as AgentPath,
      status: input.status,
      generation,
    };
    if (input.runId) payload.runId = input.runId;
    if (input.summary) payload.summary = input.summary;
    if (input.error) payload.error = input.error;

    const event: EventEnvelope<"agent.task_completed", AgentCompleteTaskPayload> = {
      id: input.eventId,
      type: "agent.task_completed",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload,
    };
    const sessionId = input.sessionId ?? current.parent_session_id ?? current.child_session_id;
    if (sessionId) event.sessionId = sessionId as SessionId;
    return event;
  }

  private agentCompletedEvent(
    input: AgentTaskCompleteCasInput,
    current: AgentTaskStateRow,
    generation: number,
  ): Extract<ChiliEvent, { type: "agent.completed" }> {
    if (!input.runId || !input.agentEventId) {
      throw new Error("agent.completed CAS event requires runId and agentEventId");
    }
    const payload: AgentCompletedPayload = {
      runId: input.runId,
      taskId: input.taskId,
      path: current.path as AgentPath,
      status: input.status,
      generation,
    };
    if (input.summary) payload.summary = input.summary;
    if (input.error) payload.error = input.error;

    const event: EventEnvelope<"agent.completed", AgentCompletedPayload> = {
      id: input.agentEventId,
      type: "agent.completed",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload,
    };
    const sessionId = input.sessionId ?? current.parent_session_id ?? current.child_session_id;
    if (sessionId) event.sessionId = sessionId as SessionId;
    return event;
  }

  private agentMailboxClaimedEvent(
    input: AgentMailboxClaimInput,
    current: AgentMailboxProjectionRow,
  ): Extract<ChiliEvent, { type: "agent.message_claimed" }> {
    const payload: AgentMessageClaimedPayload = {
      messageId: input.messageId,
      path: current.path as AgentPath,
    };
    if (current.task_id) payload.taskId = current.task_id as TaskId;
    if (input.claimedBy) payload.claimedBy = input.claimedBy;

    const event: EventEnvelope<"agent.message_claimed", AgentMessageClaimedPayload> = {
      id: input.eventId,
      type: "agent.message_claimed",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload,
    };
    const sessionId = input.sessionId
      ?? this.parentSessionIdForTask(current.task_id)
      ?? current.recipient_session_id;
    if (sessionId) event.sessionId = sessionId as SessionId;
    return event;
  }

  private agentMailboxConsumedEvent(
    input: AgentMailboxConsumeInput,
    current: AgentMailboxProjectionRow,
  ): Extract<ChiliEvent, { type: "agent.message_consumed" }> {
    const payload: AgentMessageConsumedPayload = {
      messageId: input.messageId,
      path: current.path as AgentPath,
      consumedBy: input.consumedBy ?? (current.path as AgentPath),
    };
    if (current.task_id) payload.taskId = current.task_id as TaskId;

    const event: EventEnvelope<"agent.message_consumed", AgentMessageConsumedPayload> = {
      id: input.eventId,
      type: "agent.message_consumed",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload,
    };
    const sessionId = input.sessionId
      ?? this.parentSessionIdForTask(current.task_id)
      ?? current.recipient_session_id;
    if (sessionId) event.sessionId = sessionId as SessionId;
    return event;
  }

  private agentMailboxRequeuedEvent(
    input: AgentMailboxRequeueInput,
    current: AgentMailboxProjectionRow,
  ): Extract<ChiliEvent, { type: "agent.message_requeued" }> {
    const payload: AgentMessageRequeuedPayload = {
      messageId: input.messageId,
      path: current.path as AgentPath,
    };
    if (current.task_id) payload.taskId = current.task_id as TaskId;
    if (input.error) payload.error = input.error;

    const event: EventEnvelope<"agent.message_requeued", AgentMessageRequeuedPayload> = {
      id: input.eventId,
      type: "agent.message_requeued",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload,
    };
    const sessionId = input.sessionId
      ?? this.parentSessionIdForTask(current.task_id)
      ?? current.recipient_session_id;
    if (sessionId) event.sessionId = sessionId as SessionId;
    return event;
  }

  private agentMailboxDiscardedEvent(
    input: AgentMailboxDiscardInput,
    current: AgentMailboxProjectionRow,
  ): Extract<ChiliEvent, { type: "agent.message_discarded" }> {
    const payload: AgentMessageDiscardedPayload = {
      messageId: input.messageId,
      path: current.path as AgentPath,
      reason: input.reason,
    };
    if (current.task_id) payload.taskId = current.task_id as TaskId;
    if (input.discardedBy) payload.discardedBy = input.discardedBy;

    const event: EventEnvelope<"agent.message_discarded", AgentMessageDiscardedPayload> = {
      id: input.eventId,
      type: "agent.message_discarded",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload,
    };
    const sessionId = input.sessionId
      ?? this.parentSessionIdForTask(current.task_id)
      ?? current.recipient_session_id;
    if (sessionId) event.sessionId = sessionId as SessionId;
    return event;
  }

  private insertEvent(event: ChiliEvent): void {
    this.db
      .query(
        `insert into events (seq, id, type, time, session_id, payload_json)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.nextEventSeq(),
        event.id,
        event.type,
        event.time,
        event.sessionId ?? null,
        encodeJson(event.payload),
      );
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

  private migrateSubagentSchema(): void {
    this.addColumnIfMissing("agent_runs", "task_id", "text");
    this.addColumnIfMissing("agent_runs", "parent_session_id", "text");
    this.addColumnIfMissing("agent_runs", "child_session_id", "text");
    this.addColumnIfMissing("agent_runs", "cwd", "text");
    this.addColumnIfMissing("agent_runs", "mode", "text");
    this.addColumnIfMissing("agent_runs", "generation", "integer not null default 0");
    this.addColumnIfMissing("agent_tasks", "generation", "integer not null default 0");
    this.addColumnIfMissing("agent_tasks", "dispatch_id", "text");
    this.addColumnIfMissing("agent_tasks", "reserved_run_id", "text");
    this.addColumnIfMissing("agent_tasks", "worker_policy_json", "text");
    this.backfillAgentTaskWorkerPolicies();
    this.addColumnIfMissing("agent_tasks", "lease_owner", "text");
    this.addColumnIfMissing("agent_tasks", "lease_expires_at", "integer");
    this.addColumnIfMissing("agent_tasks", "lease_heartbeat_at", "integer");
    this.addColumnIfMissing("agent_tasks", "source_call_id", "text");
    this.addColumnIfMissing("agent_tasks", "batch_id", "text");
    this.addColumnIfMissing("agent_tasks", "batch_index", "integer");
    this.addColumnIfMissing("agent_tasks", "expected_batch_size", "integer");
    this.addColumnIfMissing("agent_tasks", "completion_policy", "text");
    this.addColumnIfMissing("agent_tasks", "max_concurrency", "integer");
    this.addColumnIfMissing("agent_mailbox", "consumed_at", "integer");
    this.db.exec(`create unique index if not exists agent_tasks_dispatch_id_idx
      on agent_tasks(dispatch_id) where dispatch_id is not null`);
    this.db.exec(`create unique index if not exists agent_tasks_reserved_run_id_idx
      on agent_tasks(reserved_run_id) where reserved_run_id is not null`);
    this.db.exec(`create index if not exists agent_runs_task_idx on agent_runs(task_id)`);
    this.db.exec(`create index if not exists agent_runs_child_session_idx on agent_runs(child_session_id)`);
    this.db.exec(AGENT_TASKS_CHILD_SESSION_UNIQUE_INDEX);
    this.db.exec(
      `create index if not exists agent_mailbox_recipient_session_idx
       on agent_mailbox(recipient_session_id, created_at)`,
    );
    this.db.exec(`create index if not exists agent_mailbox_status_idx on agent_mailbox(status, created_at)`);
    this.db.exec(`create index if not exists agent_tasks_lease_idx on agent_tasks(status, lease_expires_at)`);
    this.db.exec(`create index if not exists agent_tasks_lease_owner_idx on agent_tasks(lease_owner, status)`);
    this.db.exec(
      `create index if not exists agent_tasks_batch_idx
       on agent_tasks(parent_session_id, source_call_id, batch_id)`,
    );
  }

  private backfillAgentTaskWorkerPolicies(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        create table if not exists schema_migrations (
          name text primary key
        )
      `);
      const marker = "agent_task_worker_policy_backfill_v1";
      const alreadyMigrated = this.db
        .query<{ found: number }, [string]>(
          `select 1 as found from schema_migrations where name = ? limit 1`,
        )
        .get(marker);
      if (alreadyMigrated) return;

      this.db.exec(`
        update agent_tasks
           set worker_policy_json = (
             select json_extract(event.payload_json, '$.workerPolicy')
               from events event
              where event.type = 'agent.task_created'
                and json_valid(event.payload_json)
                and json_type(event.payload_json, '$.taskId') = 'text'
                and json_extract(event.payload_json, '$.taskId') = agent_tasks.id
                and json_type(event.payload_json, '$.workerPolicy') = 'object'
              order by event.seq asc
              limit 1
           )
         where worker_policy_json is null
           and exists (
             select 1
               from events event
              where event.type = 'agent.task_created'
                and json_valid(event.payload_json)
                and json_type(event.payload_json, '$.taskId') = 'text'
                and json_extract(event.payload_json, '$.taskId') = agent_tasks.id
                and json_type(event.payload_json, '$.workerPolicy') = 'object'
           )
      `);
      this.db.query(`insert into schema_migrations (name) values (?)`).run(marker);
    });
    migrate();
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
      this.addColumnIfMissing(table, column, "text");
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
      const assertUniqueTaskChildSessions = (): void => {
        const duplicateChildSession = this.db
          .query<{ child_session_id: string; task_ids: string }, []>(
            `select child_session_id, group_concat(id) as task_ids
               from agent_tasks
              where child_session_id is not null
              group by child_session_id
             having count(*) > 1
              limit 1`,
          )
          .get();
        if (duplicateChildSession) {
          throw new Error(
            `Cannot enforce one task per child session ${duplicateChildSession.child_session_id}: duplicate tasks ${duplicateChildSession.task_ids}.`,
          );
        }
      };
      assertUniqueTaskChildSessions();
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
      const childSessionIndex = this.db
        .query<{ unique: number; partial: number; name: string }, []>(`pragma index_list(agent_tasks)`)
        .all()
        .find((index) => index.name === "agent_tasks_child_session_idx");
      const childSessionIndexColumns = this.db
        .query<{ name: string | null }, []>(`pragma index_info(agent_tasks_child_session_idx)`)
        .all();
      const childSessionIndexSql = this.db
        .query<{ sql: string | null }, []>(
          `select sql from sqlite_master where type = 'index' and name = 'agent_tasks_child_session_idx'`,
        )
        .get()?.sql
        ?.toLowerCase()
        .replaceAll(/\s+/g, " ")
        .trim();
      const childSessionIndexIsCanonical = childSessionIndex?.unique === 1
        && childSessionIndex.partial === 1
        && childSessionIndexColumns.length === 1
        && childSessionIndexColumns[0]?.name === "child_session_id"
        && childSessionIndexSql
          === "create unique index agent_tasks_child_session_idx on agent_tasks(child_session_id) where child_session_id is not null";
      if (
        alreadyMigrated
        && !hasLegacyGoalTable
        && !hasLegacyColumns
        && legacyPayloadMappingsAreComplete
        && childSessionIndexIsCanonical
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

      // Two distinct legacy task rows can become duplicates only after their
      // replacement SessionId values are backfilled.
      assertUniqueTaskChildSessions();

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
      this.db.exec(`drop index if exists agent_tasks_batch_idx`);
      this.db.exec(`drop index if exists agent_tasks_child_session_idx`);
      for (const [table, column] of legacyColumns) {
        this.dropColumnIfPresent(table, column);
      }
      if (hasLegacyGoalTable) this.db.exec(`drop table thread_goals`);
      this.db.exec(`drop table if exists temp._legacy_thread_sessions`);
      this.db.exec(AGENT_TASKS_CHILD_SESSION_UNIQUE_INDEX);
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

  private migrateTeamSchema(): void {
    this.addColumnIfMissing("teams", "description", "text");
    this.addColumnIfMissing("team_tasks", "description", "text");
    this.addColumnIfMissing("team_tasks", "created_by", "text");
    this.addColumnIfMissing("team_tasks", "depends_on_json", "text");
    this.addColumnIfMissing("team_tasks", "summary", "text");
    this.addColumnIfMissing("team_tasks", "error", "text");
    this.addColumnIfMissing("team_tasks", "metadata_json", "text");
    this.addColumnIfMissing("team_tasks", "completed_at", "integer");
    this.addColumnIfMissing("team_messages", "delivery", "text");
    this.db.exec(`
      create table if not exists team_message_deliveries (
        mailbox_message_id text primary key,
        team_id text not null,
        team_message_id text not null,
        path text not null,
        child_session_id text,
        trigger_turn integer not null,
        status text not null,
        error text,
        queued_at integer not null,
        updated_at integer not null,
        delivered_at integer
      )
    `);
    this.db.exec(`create index if not exists team_tasks_owner_status_idx on team_tasks(owner_path, status)`);
    this.db.exec(`create index if not exists team_members_team_status_idx on team_members(team_id, status)`);
    this.db.exec(`create index if not exists team_members_path_idx on team_members(path)`);
    this.db.exec(`create index if not exists team_members_child_session_idx on team_members(child_session_id)`);
    this.db.exec(`create index if not exists team_messages_team_time_idx on team_messages(team_id, created_at)`);
    this.db.exec(`create index if not exists team_messages_to_time_idx on team_messages(to_path, created_at)`);
    this.db.exec(`create index if not exists team_messages_task_idx on team_messages(task_id, created_at)`);
    this.db.exec(`create index if not exists team_message_deliveries_team_idx on team_message_deliveries(team_id, updated_at)`);
    this.db.exec(`create index if not exists team_message_deliveries_message_idx on team_message_deliveries(team_message_id, updated_at)`);
    this.db.exec(`create index if not exists team_message_deliveries_status_idx on team_message_deliveries(status, updated_at)`);
  }

  private migrateSessionClaimSchema(): void {
    this.db.exec(`
      create table if not exists session_creation_claims (
        session_id text primary key,
        claim_id text not null unique,
        cwd text not null,
        owner text not null check (owner in ('root', 'child')),
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

  private subagentSessionReservationExists(sessionId: SessionId): boolean {
    return this.db.query<{ found: number }, [string, string, string]>(
      `select 1 as found
         where exists (select 1 from agent_tasks where child_session_id = ?)
            or exists (select 1 from agent_runs where child_session_id = ?)
            or exists (
              select 1
                from team_members m
                join teams t on t.id = m.team_id
               where m.child_session_id = ?
                 and m.path <> t.lead_path
            )
         limit 1`,
    ).get(sessionId, sessionId, sessionId) !== null;
  }

  private teamOwnerSessionState(
    sessionId: SessionId,
  ): { status: string; source: "interactive" | "subagent" } | undefined {
    return this.db
      .query<{ status: string; source: "interactive" | "subagent" }, [string, string, string, string]>(
        `select s.status,
                case
                  when exists (select 1 from agent_tasks where child_session_id = ?)
                    or exists (select 1 from agent_runs where child_session_id = ?)
                    or exists (
                      select 1
                        from team_members m
                        join teams t on t.id = m.team_id
                       where m.child_session_id = ?
                         and m.path <> t.lead_path
                    )
                  then 'subagent'
                  else 'interactive'
                end as source
           from sessions s
          where s.id = ?`,
      )
      .get(sessionId, sessionId, sessionId, sessionId) ?? undefined;
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

  private applyProjection(event: ChiliEvent): void {
    if (event.type === "turn.completed") {
      this.compactTurnMessagePartDeltas(event.payload.turnId);
      return;
    }
    if (event.type.startsWith("session.")) {
      this.applySessionEvent(event as SessionEvent);
      return;
    }
    if (event.type.startsWith("message.")) {
      this.applyMessageEvent(event as MessageEvent);
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
    if (event.type.startsWith("agent.")) {
      this.applyAgentEvent(event as AgentEvent);
      return;
    }
    if (event.type.startsWith("team.")) {
      this.applyTeamEvent(event as TeamEvent);
    }
  }

  private applySessionEvent(event: SessionEvent): void {
    if (event.type === "session.created") {
      const creationClaim = this.db
        .query<{
          claim_id: string;
          cwd: string;
          owner: "root" | "child";
          lease_expires_at: number;
        }, [string]>(
          `select claim_id, cwd, owner, lease_expires_at
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
      if (creationClaim?.owner === "root" && this.subagentSessionReservationExists(event.sessionId)) {
        throw new SessionReservedForSubagentError(event.sessionId);
      }
      const title = event.payload.cwd.split("/").filter(Boolean).at(-1) ?? "Untitled";
      const inserted = this.db
        .query(
          `insert into sessions (id, cwd, title, status, created_at, updated_at)
           values (?, ?, ?, 'active', ?, ?)
           on conflict(id) do nothing`,
        )
        .run(event.sessionId, event.payload.cwd, title, event.time, event.time);
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

  private applyMessageEvent(event: MessageEvent): void {
    if (event.type === "message.created") {
      if (!event.sessionId) {
        throw new Error("message.created requires event.sessionId");
      }
      this.db
        .query(
          `insert into messages (id, session_id, turn_id, role, parent_id, created_at)
           values (?, ?, ?, ?, null, ?)
           on conflict(id) do nothing`,
        )
        .run(event.payload.messageId, event.sessionId, event.payload.turnId ?? null, event.payload.role, event.time);
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
    if (event.type === "tool.call_started") {
      this.db
        .query(
          `insert into tool_calls
             (id, session_id, turn_id, tool_name, status, input_json, started_at, updated_at)
           values (?, ?, ?, ?, 'running', ?, ?, ?)
           on conflict(id) do update set
             status = excluded.status,
             updated_at = excluded.updated_at`,
        )
        .run(
          event.payload.callId,
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
        .query(`update tool_calls set status = ?, updated_at = ? where id = ?`)
        .run(event.payload.status, event.time, event.payload.callId);
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

  private applyAgentEvent(event: AgentEvent): void {
    if (event.type === "agent.task_created") {
      const existing = this.agentTaskProjectionState(event.payload.taskId);
      if (existing) {
        if (sameAgentTaskCreationIdentity(existing, event.payload)) return;
        throw new Error(`Agent task already exists with a different creation identity: ${event.payload.taskId}`);
      }
      this.db
        .query(
          `insert into agent_tasks
             (id, dispatch_id, reserved_run_id, worker_policy_json,
              path, parent_path, parent_session_id, child_session_id,
              task_name, cwd, prompt, mode, source_call_id, batch_id, batch_index, expected_batch_size,
              completion_policy, max_concurrency, status, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          event.payload.taskId,
          event.payload.dispatchId ?? null,
          event.payload.reservedRunId ?? null,
          event.payload.workerPolicy ? encodeJson(event.payload.workerPolicy) : null,
          event.payload.path,
          event.payload.parentPath,
          event.payload.parentSessionId,
          event.payload.childSessionId,
          event.payload.taskName,
          event.payload.cwd,
          event.payload.prompt,
          event.payload.mode ?? null,
          event.payload.sourceCallId ?? null,
          event.payload.batchId ?? null,
          event.payload.batchIndex ?? null,
          event.payload.expectedBatchSize ?? null,
          event.payload.completionPolicy ?? null,
          event.payload.maxConcurrency ?? null,
          event.time,
          event.time,
        );
      return;
    }

    if (event.type === "agent.spawned") {
      const parentSessionId = event.payload.parentSessionId ?? event.sessionId ?? null;
      const payloadGeneration = normalizedGeneration(event.payload.generation);
      if (event.payload.taskId) {
        const current = this.agentTaskState(event.payload.taskId);
        if (current && !shouldApplySpawnToTask(current, event.payload.runId, payloadGeneration)) return;
      }
      this.db
        .query(
          `insert into agent_runs
             (id, session_id, task_id, path, parent_path, parent_session_id,
              child_session_id, task_name, cwd, mode, status, generation, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
           on conflict(id) do update set
             status = 'running',
             session_id = coalesce(excluded.session_id, agent_runs.session_id),
             task_id = coalesce(excluded.task_id, agent_runs.task_id),
             path = excluded.path,
             parent_path = coalesce(excluded.parent_path, agent_runs.parent_path),
             parent_session_id = coalesce(excluded.parent_session_id, agent_runs.parent_session_id),
             child_session_id = coalesce(excluded.child_session_id, agent_runs.child_session_id),
             task_name = excluded.task_name,
             cwd = coalesce(excluded.cwd, agent_runs.cwd),
             mode = coalesce(excluded.mode, agent_runs.mode),
             generation = max(agent_runs.generation, excluded.generation),
             completed_at = null
           where agent_runs.completed_at is null`,
        )
        .run(
          event.payload.runId,
          event.sessionId ?? null,
          event.payload.taskId ?? null,
          event.payload.path,
          event.payload.parentPath ?? null,
          parentSessionId,
          event.payload.childSessionId ?? null,
          event.payload.taskName,
          event.payload.cwd ?? null,
          event.payload.mode ?? null,
          payloadGeneration ?? 0,
          event.time,
        );
      if (event.payload.taskId) {
        this.applyAgentSpawnToTask(event, parentSessionId, payloadGeneration);
      }
      return;
    }

    if (event.type === "agent.message_queued") {
      this.db
        .query(
          `insert into agent_mailbox
             (id, task_id, path, from_path, recipient_session_id, trigger_turn, status, message_json, created_at)
           values (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
           on conflict(id) do update set
             task_id = excluded.task_id,
             path = excluded.path,
             from_path = excluded.from_path,
             recipient_session_id = excluded.recipient_session_id,
             trigger_turn = excluded.trigger_turn,
             message_json = excluded.message_json`,
        )
        .run(
          event.id,
          event.payload.taskId ?? null,
          event.payload.path,
          event.payload.from,
          event.payload.recipientSessionId ?? null,
          event.payload.triggerTurn ? 1 : 0,
          event.payload.message ? encodeJson(event.payload.message) : null,
          event.time,
        );
      if (event.payload.taskId) {
        this.db.query(`update agent_tasks set updated_at = ? where id = ?`).run(event.time, event.payload.taskId);
      }
      this.applyTeamMessageDeliveryQueued(event);
      return;
    }

    if (event.type === "agent.message_claimed") {
      this.db
        .query(`update agent_mailbox set status = 'delivering' where id = ? and status = 'queued'`)
        .run(event.payload.messageId);
      this.applyTeamMessageDeliveryStatus(event.payload.messageId, "delivering", event.time);
      if (event.payload.taskId) {
        this.db.query(`update agent_tasks set updated_at = ? where id = ?`).run(event.time, event.payload.taskId);
      }
      return;
    }

    if (event.type === "agent.message_requeued") {
      this.db
        .query(`update agent_mailbox set status = 'queued', consumed_at = null where id = ? and status = 'delivering'`)
        .run(event.payload.messageId);
      this.applyTeamMessageDeliveryStatus(event.payload.messageId, "failed", event.time, event.payload.error);
      if (event.payload.taskId) {
        this.db.query(`update agent_tasks set updated_at = ? where id = ?`).run(event.time, event.payload.taskId);
      }
      return;
    }

    if (event.type === "agent.message_discarded") {
      this.db
        .query(`update agent_mailbox set status = 'discarded', consumed_at = ? where id = ?`)
        .run(event.time, event.payload.messageId);
      this.applyTeamMessageDeliveryStatus(event.payload.messageId, "failed", event.time, event.payload.reason);
      if (event.payload.taskId) {
        this.db.query(`update agent_tasks set updated_at = ? where id = ?`).run(event.time, event.payload.taskId);
      }
      return;
    }

    if (event.type === "agent.message_consumed") {
      this.db
        .query(`update agent_mailbox set status = 'consumed', consumed_at = ? where id = ?`)
        .run(event.time, event.payload.messageId);
      this.applyTeamMessageDeliveryStatus(event.payload.messageId, "delivered", event.time);
      if (event.payload.taskId) {
        this.db.query(`update agent_tasks set updated_at = ? where id = ?`).run(event.time, event.payload.taskId);
      }
      return;
    }

    if (event.type === "agent.task_completed") {
      this.applyAgentTaskCompletion(event.payload, event.time);
      return;
    }

    if (event.type === "agent.completed") {
      const generation = normalizedGeneration(event.payload.generation);
      this.db
        .query(
          `update agent_runs
           set status = ?, completed_at = ?, task_id = coalesce(?, task_id),
               generation = max(generation, ?)
           where id = ?
             and completed_at is null
             and (? is null or generation <= ?)`,
        )
        .run(
          event.payload.status,
          event.time,
          event.payload.taskId ?? null,
          generation ?? 0,
          event.payload.runId,
          generation ?? null,
          generation ?? null,
        );
      if (event.payload.taskId) {
        this.applyAgentTaskCompletion(
          {
            taskId: event.payload.taskId,
            path: event.payload.path,
            runId: event.payload.runId,
            ...(event.payload.generation !== undefined ? { generation: event.payload.generation } : {}),
            status: event.payload.status,
            ...(event.payload.summary ? { summary: event.payload.summary } : {}),
            ...(event.payload.error ? { error: event.payload.error } : {}),
          },
          event.time,
        );
      }
    }
  }

  private applyTeamMessageDeliveryQueued(event: Extract<AgentEvent, { type: "agent.message_queued" }>): void {
    const metadata = teamMailboxMetadata(event.payload.message);
    if (!metadata) return;
    this.db
      .query(
        `insert into team_message_deliveries
           (mailbox_message_id, team_id, team_message_id, path, child_session_id,
            trigger_turn, status, error, queued_at, updated_at, delivered_at)
         values (?, ?, ?, ?, ?, ?, 'queued', null, ?, ?, null)
         on conflict(mailbox_message_id) do update set
           team_id = excluded.team_id,
           team_message_id = excluded.team_message_id,
           path = excluded.path,
           child_session_id = excluded.child_session_id,
           trigger_turn = excluded.trigger_turn,
           status = 'queued',
           error = null,
           updated_at = excluded.updated_at,
           delivered_at = null`,
      )
      .run(
        event.id,
        metadata.teamId,
        metadata.teamMessageId,
        event.payload.path,
        event.payload.recipientSessionId ?? null,
        event.payload.triggerTurn ? 1 : 0,
        event.time,
        event.time,
      );
  }

  private applyTeamMessageDeliveryStatus(
    mailboxMessageId: string,
    status: TeamMessageDeliveryStatus,
    time: number,
    error?: string,
  ): void {
    this.db
      .query(
        `update team_message_deliveries
         set status = ?,
             error = ?,
             updated_at = ?,
             delivered_at = case when ? = 'delivered' then ? else delivered_at end
         where mailbox_message_id = ?`,
      )
      .run(status, error ?? null, time, status, time, mailboxMessageId);
  }

  private applyAgentSpawnToTask(
    event: Extract<AgentEvent, { type: "agent.spawned" }>,
    parentSessionId: string | null,
    payloadGeneration: number | undefined,
  ): void {
    const taskId = event.payload.taskId;
    if (!taskId) return;
    const current = this.agentTaskState(taskId);
    if (current && !shouldApplySpawnToTask(current, event.payload.runId, payloadGeneration)) return;
    const generation = payloadGeneration ?? current?.generation ?? 0;

    this.db
      .query(
        `insert into agent_tasks
           (id, path, parent_path, parent_session_id, child_session_id,
            task_name, cwd, mode, source_call_id, batch_id, batch_index, expected_batch_size,
            completion_policy, max_concurrency, status, generation, current_run_id, lease_owner,
            lease_expires_at, lease_heartbeat_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, null, null, null, ?, ?)
         on conflict(id) do update set
           status = 'running',
           generation = excluded.generation,
           current_run_id = excluded.current_run_id,
           path = excluded.path,
           parent_path = coalesce(excluded.parent_path, agent_tasks.parent_path),
           parent_session_id = coalesce(excluded.parent_session_id, agent_tasks.parent_session_id),
           child_session_id = coalesce(excluded.child_session_id, agent_tasks.child_session_id),
           task_name = excluded.task_name,
           cwd = coalesce(excluded.cwd, agent_tasks.cwd),
           mode = coalesce(excluded.mode, agent_tasks.mode),
           source_call_id = coalesce(excluded.source_call_id, agent_tasks.source_call_id),
           batch_id = coalesce(excluded.batch_id, agent_tasks.batch_id),
           batch_index = coalesce(excluded.batch_index, agent_tasks.batch_index),
           expected_batch_size = coalesce(excluded.expected_batch_size, agent_tasks.expected_batch_size),
           completion_policy = coalesce(excluded.completion_policy, agent_tasks.completion_policy),
           max_concurrency = coalesce(excluded.max_concurrency, agent_tasks.max_concurrency),
           summary = null,
           error = null,
           completion_json = null,
           lease_owner = null,
           lease_expires_at = null,
           lease_heartbeat_at = null,
           completed_at = null,
           updated_at = excluded.updated_at`,
      )
      .run(
        taskId,
        event.payload.path,
        event.payload.parentPath ?? null,
        parentSessionId,
        event.payload.childSessionId ?? null,
        event.payload.taskName,
        event.payload.cwd ?? null,
        event.payload.mode ?? null,
        event.payload.sourceCallId ?? null,
        event.payload.batchId ?? null,
        event.payload.batchIndex ?? null,
        event.payload.expectedBatchSize ?? null,
        event.payload.completionPolicy ?? null,
        event.payload.maxConcurrency ?? null,
        generation,
        event.payload.runId,
        event.time,
        event.time,
      );
  }

  private applyAgentTaskCompletion(payload: AgentCompleteTaskPayload, time: number): void {
    const generation = normalizedGeneration(payload.generation);
    const current = this.agentTaskState(payload.taskId);
    if (current && !shouldApplyTaskCompletion(current, payload.runId, generation)) {
      return;
    }

    this.db
      .query(
        `insert into agent_tasks
           (id, path, task_name, status, generation, current_run_id, summary, error, completion_json,
            lease_owner, lease_expires_at, lease_heartbeat_at, created_at, updated_at, completed_at)
         values (?, ?, '', ?, ?, ?, ?, ?, ?, null, null, null, ?, ?, ?)
         on conflict(id) do update set
           path = excluded.path,
           status = excluded.status,
           generation = max(agent_tasks.generation, excluded.generation),
           current_run_id = coalesce(excluded.current_run_id, agent_tasks.current_run_id),
           summary = excluded.summary,
           error = excluded.error,
           completion_json = excluded.completion_json,
           lease_owner = null,
           lease_expires_at = null,
           lease_heartbeat_at = null,
           updated_at = excluded.updated_at,
           completed_at = excluded.completed_at`,
      )
      .run(
        payload.taskId,
        payload.path,
        payload.status,
        generation ?? current?.generation ?? 0,
        payload.runId ?? null,
        payload.summary ?? null,
        payload.error ?? null,
        encodeJson(payload),
        time,
        time,
        time,
      );

    if (payload.runId) {
      this.db
        .query(
          `update agent_runs
           set status = ?, completed_at = ?, task_id = coalesce(task_id, ?), generation = max(generation, ?)
           where id = ? and completed_at is null`,
        )
        .run(payload.status, time, payload.taskId, generation ?? current?.generation ?? 0, payload.runId);
    }
  }

  private agentTaskState(taskId: TaskId): AgentTaskStateRow | undefined {
    const row = this.db
      .query<AgentTaskStateRow, [string]>(
        `select dispatch_id, reserved_run_id, worker_policy_json,
                status, generation, current_run_id, lease_owner, lease_expires_at,
                path, parent_path, parent_session_id, child_session_id, task_name, cwd, mode,
                source_call_id, batch_id, batch_index, expected_batch_size, completion_policy, max_concurrency
         from agent_tasks
         where id = ?`,
      )
      .get(taskId);
    return row ?? undefined;
  }

  private agentTaskProjectionState(taskId: TaskId): AgentTaskProjectionRow | undefined {
    const row = this.db
      .query<AgentTaskProjectionRow, [string]>(
        `select id, dispatch_id, reserved_run_id, worker_policy_json,
                path, parent_path, parent_session_id, child_session_id,
                task_name, cwd, prompt, mode, source_call_id, batch_id, batch_index, expected_batch_size,
                completion_policy, max_concurrency, status, current_run_id, summary, error, completion_json,
                generation, lease_owner, lease_expires_at, lease_heartbeat_at, created_at, updated_at, completed_at
         from agent_tasks
         where id = ?`,
      )
      .get(taskId);
    return row ?? undefined;
  }

  private agentMailboxState(messageId: string): AgentMailboxProjectionRow | undefined {
    const row = this.db
      .query<AgentMailboxProjectionRow, [string]>(
        `select id, task_id, path, from_path, recipient_session_id, trigger_turn, status,
                message_json, created_at, consumed_at
         from agent_mailbox
         where id = ?`,
      )
      .get(messageId);
    return row ?? undefined;
  }

  private async agentMailboxMessage(messageId: string): Promise<AgentMailboxRow | undefined> {
    return (await this.agentMailbox({ messageId, limit: 1 }))[0];
  }

  private parentSessionIdForTask(taskId: string | null): string | undefined {
    if (!taskId) return undefined;
    return this.db
      .query<{ parent_session_id: string | null }, [string]>(
        `select parent_session_id from agent_tasks where id = ?`,
      )
      .get(taskId)?.parent_session_id ?? undefined;
  }

  private teamTaskState(teamId: TeamId, taskId: TaskId): TeamTaskStateRow | undefined {
    const row = this.db
      .query<TeamTaskStateRow, [string, string]>(
        `select id, team_id, status, owner_path, depends_on_json, metadata_json
         from team_tasks
         where team_id = ? and id = ?`,
      )
      .get(teamId, taskId);
    return row ?? undefined;
  }

  private teamMemberUnavailableForClaim(teamId: TeamId, ownerPath: AgentPath, taskId: TaskId): boolean {
    const row = this.db
      .query<{ status: TeamMemberRow["status"]; current_task_id: string | null }, [string, string]>(
        `select status, current_task_id
         from team_members
         where team_id = ? and path = ?`,
      )
      .get(teamId, ownerPath);
    if (!row) return false;
    if (row.status === "closed" || row.status === "blocked") return true;
    return row.status === "running" && row.current_task_id !== taskId;
  }

  private teamTaskHasRunningWriteConflict(task: TeamTaskStateRow): boolean {
    const writeScope = teamTaskWriteScope(task.metadata_json);
    if (writeScope.length === 0) return false;

    const running = this.db
      .query<{ id: string; metadata_json: string | null }, [string, string]>(
        `select id, metadata_json
         from team_tasks
         where team_id = ? and status = 'in_progress' and id <> ?`,
      )
      .all(task.team_id, task.id);
    return running.some((candidate) => {
      const candidateWriteScope = teamTaskWriteScope(candidate.metadata_json);
      return candidateWriteScope.length > 0 && scopesOverlap(writeScope, candidateWriteScope);
    });
  }

  private teamTaskDependenciesComplete(task: TeamTaskStateRow): boolean {
    const dependencies = decodeJson<TaskId[]>(task.depends_on_json ?? "[]", []);
    if (dependencies.length === 0) return true;

    const completed = this.db
      .query<{ count: number }, any>(
        `select count(*) as count
         from team_tasks
         where team_id = $teamId
           and status = 'completed'
           and id in (${dependencies.map((_, index) => `$dep${index}`).join(", ")})`,
      )
      .get(Object.fromEntries([["teamId", task.team_id], ...dependencies.map((id, index) => [`dep${index}`, id])]));
    return (completed?.count ?? 0) === dependencies.length;
  }

  private teamTaskClaimedEvent(
    input: TeamTaskClaimInput,
    current: TeamTaskStateRow,
  ): Extract<ChiliEvent, { type: "team.task_claimed" }> {
    const payload: TeamTaskClaimedPayload = {
      teamId: input.teamId,
      taskId: input.taskId,
      ownerPath: input.ownerPath,
    };
    if (input.claimedBy) payload.claimedBy = input.claimedBy;
    if (input.metadata) payload.metadata = input.metadata;

    const event: EventEnvelope<"team.task_claimed", TeamTaskClaimedPayload> = {
      id: input.eventId,
      type: "team.task_claimed",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload,
    };
    const sessionId = input.sessionId ?? this.sessionIdForTeamTask(current.id);
    if (sessionId) event.sessionId = sessionId as SessionId;
    return event;
  }

  private teamTaskVerificationClaimedEvent(
    input: TeamTaskVerificationClaimInput,
    current: TeamTaskStateRow,
    metadata: Record<string, unknown>,
  ): Extract<ChiliEvent, { type: "team.task_updated" }> {
    const event: Extract<ChiliEvent, { type: "team.task_updated" }> = {
      id: input.eventId,
      type: "team.task_updated",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload: {
        teamId: input.teamId,
        taskId: input.taskId,
        metadata,
      },
    };
    const sessionId = input.sessionId ?? this.sessionIdForTeamTask(current.id);
    if (sessionId) event.sessionId = sessionId as SessionId;
    return event;
  }

  private sessionIdForTeamTask(taskId: string): string | undefined {
    return this.db
      .query<{ session_id: string | null }, [string]>(`select session_id from team_tasks where id = ?`)
      .get(taskId)?.session_id ?? undefined;
  }

  private touchTeam(teamId: TeamId, time: number): void {
    this.db.query(`update teams set updated_at = ? where id = ?`).run(time, teamId);
  }

  private applyTeamEvent(event: TeamEvent): void {
    if (event.type === "team.created") {
      const inserted = this.db
        .query(
          `insert into teams (id, session_id, name, lead_path, status, description, created_at, updated_at)
           values (?, ?, ?, ?, 'active', ?, ?, ?)
           on conflict(id) do nothing`,
        )
        .run(
          event.payload.teamId,
          event.sessionId ?? null,
          event.payload.name,
          event.payload.leadPath,
          event.payload.description ?? null,
          event.time,
          event.time,
        );
      if (inserted.changes === 0) throw new TeamAlreadyExistsError(event.payload.teamId);
      return;
    }

    if (event.type === "team.owner_session_bound") {
      const current = this.db
        .query<{ session_id: string | null; status: TeamRow["status"] }, [string]>(
          `select session_id, status from teams where id = ?`,
        )
        .get(event.payload.teamId);
      if (!current) throw new Error(`Cannot bind owner session for missing team ${event.payload.teamId}`);
      if (current.status !== "active") {
        throw new Error(`Cannot bind owner session for inactive team ${event.payload.teamId}`);
      }
      if (current.session_id && current.session_id !== event.payload.ownerSessionId) {
        throw new Error(
          `Team ${event.payload.teamId} owner session conflicts: ${current.session_id} != ${event.payload.ownerSessionId}`,
        );
      }
      const session = this.teamOwnerSessionState(event.payload.ownerSessionId);
      if (!session) throw new Error(`Cannot bind missing owner session ${event.payload.ownerSessionId}`);
      if (session.status !== "active") {
        throw new Error(`Cannot bind inactive owner session ${event.payload.ownerSessionId}`);
      }
      if (session.source !== "interactive" || this.subagentSessionReservationExists(event.payload.ownerSessionId)) {
        throw new Error(`Cannot bind subagent owner session ${event.payload.ownerSessionId}`);
      }
      this.db
        .query(
          `update teams
              set session_id = ?,
                  updated_at = ?
            where id = ?
              and (session_id is null or session_id = ?)`,
        )
        .run(
          event.payload.ownerSessionId,
          event.time,
          event.payload.teamId,
          event.payload.ownerSessionId,
        );
      return;
    }

    if (event.type === "team.member_added") {
      this.db
        .query(
          `insert into team_members
             (team_id, path, name, role, status, child_session_id, model,
              tool_scope_json, write_scope_json, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(team_id, path) do update set
             name = excluded.name,
             role = excluded.role,
             status = excluded.status,
             child_session_id = coalesce(excluded.child_session_id, team_members.child_session_id),
             model = coalesce(excluded.model, team_members.model),
             tool_scope_json = coalesce(excluded.tool_scope_json, team_members.tool_scope_json),
             write_scope_json = coalesce(excluded.write_scope_json, team_members.write_scope_json),
             closed_at = null,
             updated_at = excluded.updated_at`,
        )
        .run(
          event.payload.teamId,
          event.payload.path,
          event.payload.name,
          event.payload.role,
          event.payload.status ?? "idle",
          event.payload.childSessionId ?? null,
          event.payload.model ?? null,
          event.payload.toolScope ? encodeJson(event.payload.toolScope) : null,
          event.payload.writeScope ? encodeJson(event.payload.writeScope) : null,
          event.time,
          event.time,
        );
      this.touchTeam(event.payload.teamId, event.time);
      return;
    }

    if (event.type === "team.member_status_changed") {
      this.db
        .query(
          `update team_members
           set status = ?,
               current_task_id = ?,
               closed_at = case when ? = 'closed' then ? else closed_at end,
               updated_at = ?
           where team_id = ? and path = ?`,
        )
        .run(
          event.payload.status,
          event.payload.taskId ?? null,
          event.payload.status,
          event.time,
          event.time,
          event.payload.teamId,
          event.payload.path,
        );
      this.touchTeam(event.payload.teamId, event.time);
      return;
    }

    if (event.type === "team.task_created") {
      const inserted = this.db
        .query(
          `insert into team_tasks
             (id, team_id, session_id, owner_path, status, title, description, created_by,
              depends_on_json, metadata_json, created_at, updated_at, completed_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do nothing`,
        )
        .run(
          event.payload.taskId,
          event.payload.teamId,
          event.sessionId ?? null,
          event.payload.ownerPath ?? null,
          event.payload.status ?? "pending",
          event.payload.title ?? String(event.payload.taskId),
          event.payload.description ?? null,
          event.payload.createdBy ?? null,
          encodeJson(event.payload.dependsOn ?? []),
          event.payload.metadata ? encodeJson(event.payload.metadata) : null,
          event.time,
          event.time,
          isFinalTeamTaskStatus(event.payload.status ?? "pending") ? event.time : null,
        );
      if (inserted.changes === 0) {
        const existing = this.db
          .query<{ team_id: string }, [string]>(`select team_id from team_tasks where id = ?`)
          .get(event.payload.taskId);
        throw new TeamTaskAlreadyExistsError(
          event.payload.taskId,
          existing?.team_id as TeamId | undefined,
        );
      }
      this.touchTeam(event.payload.teamId, event.time);
      return;
    }

    if (event.type === "team.task_assigned") {
      this.db
        .query(
          `update team_tasks
           set owner_path = ?,
               updated_at = ?
           where id = ? and team_id = ?`,
        )
        .run(event.payload.ownerPath, event.time, event.payload.taskId, event.payload.teamId);
      this.db
        .query(
          `update team_members
           set current_task_id = ?,
               updated_at = ?
           where team_id = ? and path = ?`,
        )
        .run(event.payload.taskId, event.time, event.payload.teamId, event.payload.ownerPath);
      this.touchTeam(event.payload.teamId, event.time);
      return;
    }

    if (event.type === "team.task_claimed") {
      this.db
        .query(
          `update team_tasks
           set owner_path = ?,
               status = 'in_progress',
               metadata_json = coalesce(?, metadata_json),
               completed_at = null,
               updated_at = ?
           where id = ? and team_id = ?`,
        )
        .run(
          event.payload.ownerPath,
          event.payload.metadata ? encodeJson(event.payload.metadata) : null,
          event.time,
          event.payload.taskId,
          event.payload.teamId,
        );
      this.db
        .query(
          `update team_members
           set status = 'running',
               current_task_id = ?,
               updated_at = ?
           where team_id = ? and path = ?`,
        )
        .run(event.payload.taskId, event.time, event.payload.teamId, event.payload.ownerPath);
      this.touchTeam(event.payload.teamId, event.time);
      return;
    }

    if (event.type === "team.task_updated") {
      const current = this.teamTaskState(event.payload.teamId, event.payload.taskId);
      const status = event.payload.status ?? current?.status ?? "pending";
      this.db
        .query(
          `update team_tasks
           set status = coalesce(?, status),
               owner_path = coalesce(?, owner_path),
               title = coalesce(?, title),
               description = coalesce(?, description),
               depends_on_json = coalesce(?, depends_on_json),
               summary = coalesce(?, summary),
               error = coalesce(?, error),
               metadata_json = coalesce(?, metadata_json),
               completed_at = case when ? in ('completed', 'failed', 'cancelled') then ? else completed_at end,
               updated_at = ?
           where id = ? and team_id = ?`,
        )
        .run(
          event.payload.status ?? null,
          event.payload.ownerPath ?? null,
          event.payload.title ?? null,
          event.payload.description ?? null,
          event.payload.dependsOn ? encodeJson(event.payload.dependsOn) : null,
          event.payload.summary ?? null,
          event.payload.error ?? null,
          event.payload.metadata ? encodeJson(event.payload.metadata) : null,
          status,
          event.time,
          event.time,
          event.payload.taskId,
          event.payload.teamId,
        );
      if (event.payload.ownerPath) {
        this.db
          .query(
            `update team_members
             set current_task_id = ?,
                 updated_at = ?
             where team_id = ? and path = ?`,
          )
          .run(event.payload.taskId, event.time, event.payload.teamId, event.payload.ownerPath);
      }
      this.touchTeam(event.payload.teamId, event.time);
      return;
    }

    if (event.type === "team.message_sent") {
      this.db
        .query(
          `insert into team_messages
             (id, team_id, from_path, to_path, task_id, kind, delivery, content, summary, metadata_json, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do nothing`,
        )
        .run(
          event.payload.messageId,
          event.payload.teamId,
          event.payload.from,
          event.payload.to,
          event.payload.taskId ?? null,
          event.payload.kind ?? "text",
          event.payload.delivery ?? null,
          event.payload.content,
          event.payload.summary ?? null,
          event.payload.metadata ? encodeJson(event.payload.metadata) : null,
          event.time,
        );
      this.touchTeam(event.payload.teamId, event.time);
    }
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

function validateScopedEventSessionIdentity(event: ChiliEvent): void {
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
  if (event.type === "team.owner_session_bound") {
    if (!event.sessionId) {
      throw new Error("team.owner_session_bound requires event.sessionId");
    }
    if (event.payload.ownerSessionId !== event.sessionId) {
      throw new Error(
        `team.owner_session_bound ownerSessionId ${event.payload.ownerSessionId} does not match event.sessionId ${event.sessionId}`,
      );
    }
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

function agentTaskFromRow(row: AgentTaskProjectionRow): AgentTaskRow {
  const task: AgentTaskRow = {
    id: row.id as TaskId,
    path: row.path as AgentPath,
    status: row.status as AgentTaskRow["status"],
    taskName: row.task_name,
    generation: row.generation ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.dispatch_id) task.dispatchId = row.dispatch_id;
  if (row.reserved_run_id) task.reservedRunId = row.reserved_run_id as AgentRunId;
  if (row.parent_path) task.parentPath = row.parent_path as AgentPath;
  if (row.parent_session_id) task.parentSessionId = row.parent_session_id as SessionId;
  if (row.child_session_id) task.childSessionId = row.child_session_id as SessionId;
  if (row.cwd) task.cwd = row.cwd;
  if (row.prompt) task.prompt = row.prompt;
  if (row.mode) task.mode = row.mode as NonNullable<AgentTaskRow["mode"]>;
  if (row.worker_policy_json) {
    task.workerPolicy = decodeJson<Record<string, unknown>>(row.worker_policy_json, {});
  }
  if (row.source_call_id) task.sourceCallId = row.source_call_id as NonNullable<AgentTaskRow["sourceCallId"]>;
  if (row.batch_id) task.batchId = row.batch_id;
  if (row.batch_index !== null) task.batchIndex = row.batch_index;
  if (row.expected_batch_size !== null) task.expectedBatchSize = row.expected_batch_size;
  if (row.completion_policy) {
    task.completionPolicy = row.completion_policy as NonNullable<AgentTaskRow["completionPolicy"]>;
  }
  if (row.max_concurrency !== null) task.maxConcurrency = row.max_concurrency;
  if (row.current_run_id) task.currentRunId = row.current_run_id as AgentRunId;
  if (row.summary) task.summary = row.summary;
  if (row.error) task.error = row.error;
  if (row.completion_json) task.completion = decodeJson<Record<string, unknown>>(row.completion_json, {});
  if (row.lease_owner) task.leaseOwner = row.lease_owner;
  if (row.lease_expires_at !== null) task.leaseExpiresAt = row.lease_expires_at;
  if (row.lease_heartbeat_at !== null) task.leaseHeartbeatAt = row.lease_heartbeat_at;
  if (row.completed_at) task.completedAt = row.completed_at;
  return task;
}

function agentRunFromRow(row: AgentRunProjectionRow): AgentRunRow {
  const run: AgentRunRow = {
    id: row.id as AgentRunId,
    path: row.path as AgentPath,
    taskName: row.task_name,
    status: row.status,
    createdAt: row.created_at,
  };
  if (row.session_id) run.sessionId = row.session_id as SessionId;
  if (row.task_id) run.taskId = row.task_id as TaskId;
  if (row.parent_path) run.parentPath = row.parent_path as AgentPath;
  if (row.parent_session_id) run.parentSessionId = row.parent_session_id as SessionId;
  if (row.child_session_id) run.childSessionId = row.child_session_id as SessionId;
  if (row.cwd) run.cwd = row.cwd;
  if (row.mode) run.mode = row.mode as NonNullable<AgentRunRow["mode"]>;
  if (row.completed_at) run.completedAt = row.completed_at;
  return run;
}

function agentMailboxFromRow(row: AgentMailboxProjectionRow): AgentMailboxRow {
  const message: AgentMailboxRow = {
    id: row.id,
    path: row.path as AgentPath,
    fromPath: row.from_path as AgentPath,
    triggerTurn: row.trigger_turn === 1,
    status: row.status,
    createdAt: row.created_at,
  };
  if (row.task_id) message.taskId = row.task_id as TaskId;
  if (row.recipient_session_id) {
    message.recipientSessionId = row.recipient_session_id as SessionId;
  }
  if (row.message_json) {
    message.message = decodeJson<AgentMailboxPayload>(row.message_json, { content: "" });
  }
  if (row.consumed_at) message.consumedAt = row.consumed_at;
  return message;
}

function teamFromRow(row: TeamProjectionRow): TeamRow {
  const team: TeamRow = {
    id: row.id as TeamId,
    name: row.name,
    leadPath: row.lead_path as AgentPath,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.session_id) team.sessionId = row.session_id as SessionId;
  if (row.description) team.description = row.description;
  return team;
}

function teamMemberFromRow(row: TeamMemberProjectionRow): TeamMemberRow {
  const member: TeamMemberRow = {
    teamId: row.team_id as TeamId,
    path: row.path as AgentPath,
    name: row.name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.child_session_id) member.childSessionId = row.child_session_id as SessionId;
  if (row.model) member.model = row.model;
  if (row.tool_scope_json) member.toolScope = decodeJson<string[]>(row.tool_scope_json, []);
  if (row.write_scope_json) member.writeScope = decodeJson<string[]>(row.write_scope_json, []);
  if (row.current_task_id) member.currentTaskId = row.current_task_id as TaskId;
  if (row.closed_at) member.closedAt = row.closed_at;
  return member;
}

function teamTaskFromRow(row: TeamTaskProjectionRow): TeamTaskRow {
  const task: TeamTaskRow = {
    id: row.id as TaskId,
    teamId: row.team_id as TeamId,
    title: row.title ?? row.id,
    status: row.status,
    dependsOn: decodeJson<TaskId[]>(row.depends_on_json ?? "[]", []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.session_id) task.sessionId = row.session_id as SessionId;
  if (row.description) task.description = row.description;
  if (row.owner_path) task.ownerPath = row.owner_path as AgentPath;
  if (row.created_by) task.createdBy = row.created_by as AgentPath;
  if (row.summary) task.summary = row.summary;
  if (row.error) task.error = row.error;
  if (row.metadata_json) task.metadata = decodeJson<Record<string, unknown>>(row.metadata_json, {});
  if (row.completed_at) task.completedAt = row.completed_at;
  return task;
}

function teamTaskWriteScope(metadataJson: string | null): string[] {
  if (!metadataJson) return [];
  const metadata = decodeJson<Record<string, unknown>>(metadataJson, {});
  return metadataStringArray(metadata, ["writeScope", "write_scope", "writeScopes", "write_scopes"]) ?? [];
}

function metadataStringArray(metadata: Record<string, unknown>, keys: readonly string[]): string[] | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (!Array.isArray(value)) continue;
    const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : [];
  }
  return undefined;
}

function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftItem) => right.some((rightItem) => pathScopeContains(leftItem, rightItem) || pathScopeContains(rightItem, leftItem)));
}

function pathScopeContains(scope: string, item: string): boolean {
  const normalizedScope = normalizePathScope(scope);
  const normalizedItem = normalizePathScope(item);
  if (normalizedScope === "*" || normalizedScope === "." || normalizedScope === "/") return true;
  return normalizedItem === normalizedScope || normalizedItem.startsWith(`${normalizedScope}/`);
}

function normalizePathScope(value: string): string {
  let normalized = value.trim().replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized || ".";
}

function teamMessageFromRow(row: TeamMessageProjectionRow): TeamMessageRow {
  const message: TeamMessageRow = {
    id: row.id,
    teamId: row.team_id as TeamId,
    fromPath: row.from_path as AgentPath,
    toPath: row.to_path as AgentPath | "*",
    content: row.content,
    kind: row.kind,
    createdAt: row.created_at,
  };
  if (row.delivery) message.delivery = row.delivery;
  if (row.delivery_status) message.deliveryStatus = row.delivery_status;
  if (row.delivery_error) message.deliveryError = row.delivery_error;
  if (row.delivery_updated_at) message.deliveryUpdatedAt = row.delivery_updated_at;
  if (row.delivered_at) message.deliveredAt = row.delivered_at;
  if (row.task_id) message.taskId = row.task_id as TaskId;
  if (row.summary) message.summary = row.summary;
  if (row.metadata_json) message.metadata = decodeJson<Record<string, unknown>>(row.metadata_json, {});
  return message;
}

function teamMessageDeliveryFromRow(row: TeamMessageDeliveryProjectionRow): TeamMessageDeliveryRow {
  const delivery: TeamMessageDeliveryRow = {
    mailboxMessageId: row.mailbox_message_id,
    teamId: row.team_id as TeamId,
    teamMessageId: row.team_message_id,
    path: row.path as AgentPath,
    status: row.status,
    triggerTurn: row.trigger_turn === 1,
    queuedAt: row.queued_at,
    updatedAt: row.updated_at,
  };
  if (row.child_session_id) delivery.childSessionId = row.child_session_id as SessionId;
  if (row.error) delivery.error = row.error;
  if (row.delivered_at) delivery.deliveredAt = row.delivered_at;
  return delivery;
}

function teamMailboxMetadata(payload: AgentMailboxPayload | undefined): { teamId: TeamId; teamMessageId: string } | undefined {
  const metadata = payload?.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const teamId = metadata.teamId;
  const teamMessageId = metadata.teamMessageId;
  if (typeof teamId !== "string" || teamId.length === 0) return undefined;
  if (typeof teamMessageId !== "string" || teamMessageId.length === 0) return undefined;
  return { teamId: teamId as TeamId, teamMessageId };
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

function normalizedGeneration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function sameAgentTaskCreationIdentity(
  current: AgentTaskProjectionRow,
  payload: Extract<AgentEvent, { type: "agent.task_created" }>["payload"],
): boolean {
  if (current.dispatch_id !== (payload.dispatchId ?? null)) return false;
  return (
    current.reserved_run_id === (payload.reservedRunId ?? null)
    && sameCanonicalJson(current.worker_policy_json, payload.workerPolicy)
    && current.path === payload.path
    && current.parent_path === payload.parentPath
    && current.parent_session_id === payload.parentSessionId
    && current.child_session_id === payload.childSessionId
    && current.task_name === payload.taskName
    && current.cwd === payload.cwd
    && current.prompt === payload.prompt
    && current.mode === (payload.mode ?? null)
    && current.source_call_id === (payload.sourceCallId ?? null)
    && current.batch_id === (payload.batchId ?? null)
    && current.batch_index === (payload.batchIndex ?? null)
    && current.expected_batch_size === (payload.expectedBatchSize ?? null)
    && current.completion_policy === (payload.completionPolicy ?? null)
    && current.max_concurrency === (payload.maxConcurrency ?? null)
  );
}

function sameCanonicalJson(currentJson: string | null, candidate: unknown): boolean {
  if (currentJson === null) return candidate === undefined;
  if (candidate === undefined) return false;
  return JSON.stringify(sortJsonValue(decodeJson<unknown>(currentJson, null)))
    === JSON.stringify(sortJsonValue(candidate));
}

function shouldApplySpawnToTask(
  current: AgentTaskStateRow,
  runId: string,
  generation: number | undefined,
): boolean {
  if (generation !== undefined && generation < current.generation) return false;
  if (
    generation !== undefined
    && generation === current.generation
    && current.current_run_id
    && current.current_run_id !== runId
  ) return false;
  if (isFinalTaskStatus(current.status)) {
    return generation !== undefined && generation > current.generation;
  }
  return generation === undefined || generation >= current.generation;
}

function shouldApplyTaskCompletion(
  current: AgentTaskStateRow,
  runId: string | undefined,
  generation: number | undefined,
): boolean {
  if (isFinalTaskStatus(current.status)) return false;
  if (runId && current.current_run_id && current.current_run_id !== runId) return false;
  if (generation !== undefined && generation < current.generation) return false;
  return true;
}

function isFinalTaskStatus(status: string): boolean {
  return status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled";
}

function isFinalTeamTaskStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function verificationStatus(metadataJson: string | null): string | undefined {
  if (!metadataJson) return undefined;
  const metadata = decodeJson<Record<string, unknown>>(metadataJson, {});
  const verification = metadata.verification;
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) return undefined;
  const status = (verification as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

function teamTaskDispatchSyncIdentity(
  currentMetadataJson: string | null,
  nextMetadataJson: string,
  input: Pick<TeamTaskAgentSyncInput, "agentTaskId" | "agentRunId" | "agentGeneration">,
): { modern: boolean; dispatchId?: string; allowUnspawned: boolean } | undefined {
  const current = teamTaskDispatchMetadata(currentMetadataJson);
  const next = teamTaskDispatchMetadata(nextMetadataJson);
  if (!current || !next) return undefined;
  if (
    current.agentTaskId !== input.agentTaskId
    || current.runId !== input.agentRunId
    || next.agentTaskId !== input.agentTaskId
    || next.runId !== input.agentRunId
    || next.generation !== input.agentGeneration
  ) {
    return undefined;
  }

  const currentDispatchId = typeof current.dispatchId === "string" ? current.dispatchId : undefined;
  const nextDispatchId = typeof next.dispatchId === "string" ? next.dispatchId : undefined;
  if (!currentDispatchId && !nextDispatchId) {
    return current.generation === input.agentGeneration
      ? { modern: false, allowUnspawned: false }
      : undefined;
  }
  if (
    !currentDispatchId
    || currentDispatchId !== nextDispatchId
    || (current.state !== "prepared" && current.state !== "bound")
    || next.state !== "bound"
    || (current.state === "bound"
      && (typeof current.generation !== "number" || current.generation > input.agentGeneration))
    || canonicalDispatchIdentity(current) !== canonicalDispatchIdentity(next)
  ) {
    return undefined;
  }
  return {
    modern: true,
    dispatchId: currentDispatchId,
    allowUnspawned: current.state === "prepared",
  };
}

function teamTaskDispatchMetadata(metadataJson: string | null): Record<string, unknown> | undefined {
  if (!metadataJson) return undefined;
  const metadata = decodeJson<Record<string, unknown>>(metadataJson, {});
  const dispatch = metadata.chiliTeamDispatch;
  return dispatch && typeof dispatch === "object" && !Array.isArray(dispatch)
    ? dispatch as Record<string, unknown>
    : undefined;
}

function canonicalDispatchIdentity(value: Record<string, unknown>): string {
  const identity = { ...value };
  delete identity.state;
  delete identity.generation;
  delete identity.agentStatus;
  delete identity.syncedAt;
  return JSON.stringify(sortJsonValue(identity));
}

function isTeamTaskWorkerPolicyJson(value: string | null): boolean {
  if (!value) return false;
  const policy = decodeJson<unknown>(value, null);
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  const record = policy as Record<string, unknown>;
  return typeof record.teamId === "string"
    && record.teamId.length > 0
    && typeof record.taskId === "string"
    && record.taskId.length > 0;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  );
}

function teamTaskStatusMatchesAgentStatus(
  teamStatus: TeamTaskAgentSyncInput["status"],
  agentStatus: TeamTaskAgentSyncInput["agentStatus"],
): boolean {
  if (agentStatus === "completed") return teamStatus === "completed";
  if (agentStatus === "incomplete") return teamStatus === "blocked";
  return teamStatus === agentStatus;
}

function isStalePendingVerification(metadataJson: string | null, stalePendingBefore: number | undefined): boolean {
  if (stalePendingBefore === undefined || verificationStatus(metadataJson) !== "pending") return false;
  const metadata = decodeJson<Record<string, unknown>>(metadataJson ?? "{}", {});
  const verification = metadata.verification;
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) return false;
  const startedAt = (verification as Record<string, unknown>).startedAt;
  return typeof startedAt !== "number" || startedAt <= stalePendingBefore;
}

function verificationClaimMetadata(metadataJson: string | null, claimMetadata: Record<string, unknown>): Record<string, unknown> {
  const current = decodeJson<Record<string, unknown>>(metadataJson ?? "{}", {});
  return {
    ...current,
    verification: claimMetadata.verification,
  };
}

function admittedAgentTaskCompleteInput(input: AgentTaskCompleteCasInput): AgentTaskCompleteCasInput {
  return {
    ...input,
    ...(input.summary !== undefined
      ? { summary: boundedCasText(input.summary, "agent task summary") }
      : {}),
    ...(input.error !== undefined
      ? { error: normalizePersistedError(input.error).message }
      : {}),
  };
}

function boundedCasText(value: string, label: string): string {
  const bounded = boundPersistedJsonValue(value, {
    maxBytes: AGENT_TEAM_CAS_TEXT_JSON_BYTES,
    maxStringBytes: AGENT_TEAM_CAS_TEXT_JSON_BYTES - 2,
    maxItems: 1,
    maxDepth: 1,
    maxNodes: 1,
    label,
  });
  return typeof bounded === "string" ? bounded : "";
}

function boundedCasMetadata(
  value: Record<string, unknown>,
  label: string,
  priorityKeys: readonly string[] = TEAM_TASK_RUNTIME_METADATA_KEYS,
): Record<string, unknown> {
  const prioritized = Object.create(null) as Record<string, unknown>;
  for (const key of priorityKeys) {
    if (safeMetadataHasOwn(value, key)) prioritized[key] = safeMetadataGet(value, key);
  }
  try {
    for (const key in value) {
      if (Object.keys(prioritized).length >= PERSISTED_JSON_LIMITS.items) break;
      if (!safeMetadataHasOwn(value, key) || Object.prototype.hasOwnProperty.call(prioritized, key)) continue;
      prioritized[key] = safeMetadataGet(value, key);
    }
  } catch {
    prioritized.__omitted__ = "additional CAS metadata keys could not be enumerated";
  }
  const bounded = boundPersistedJsonValue(normalizeCasMetadataDiagnostics(prioritized, value), {
    maxBytes: AGENT_TEAM_CAS_METADATA_JSON_BYTES,
    maxStringBytes: PERSISTED_JSON_LIMITS.stringBytes,
    maxItems: PERSISTED_JSON_LIMITS.items,
    maxDepth: PERSISTED_JSON_LIMITS.depth,
    maxNodes: PERSISTED_JSON_LIMITS.nodes,
    label,
  });
  return bounded && typeof bounded === "object" && !Array.isArray(bounded)
    ? bounded as Record<string, unknown>
    : {};
}

function normalizeCasMetadataDiagnostics(
  value: Record<string, unknown>,
  originalRoot?: object,
): Record<string, unknown> {
  const seen = new WeakSet<object>();
  if (originalRoot && originalRoot !== value) seen.add(originalRoot);
  const normalized = normalizeCasMetadataValue(value, [], {
    nodes: 0,
    seen,
  });
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : {};
}

function normalizeCasMetadataValue(
  value: unknown,
  path: readonly string[],
  state: { nodes: number; seen: WeakSet<object> },
): unknown {
  state.nodes += 1;
  if (state.nodes > PERSISTED_JSON_LIMITS.nodes) return "[omitted: CAS metadata node limit exceeded]";
  if (value === null || typeof value !== "object") return value;
  if (path.length >= PERSISTED_JSON_LIMITS.depth) return "[omitted: CAS metadata depth limit exceeded]";
  if (state.seen.has(value)) return "[omitted: circular CAS metadata]";
  state.seen.add(value);

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    const length = safeMetadataArrayLength(value);
    for (let index = 0; index < Math.min(length, PERSISTED_JSON_LIMITS.items); index += 1) {
      result.push(normalizeCasMetadataValue(safeMetadataGet(value, String(index)), path, state));
    }
    if (length > result.length) result.push(`[${length - result.length} CAS metadata items omitted]`);
    state.seen.delete(value);
    return result;
  }

  const result = Object.create(null) as Record<string, unknown>;
  let entries = 0;
  try {
    for (const key in value) {
      if (entries >= PERSISTED_JSON_LIMITS.items) {
        result.__omitted__ = "additional CAS metadata keys omitted";
        break;
      }
      if (!safeMetadataHasOwn(value, key)) continue;
      entries += 1;
      const item = safeMetadataGet(value, key);
      const normalizedKey = normalizedMetadataKey(key);
      result[key] = isDiagnosticMetadataField(normalizedKey, path)
        ? normalizePersistedError(item).message
        : normalizeCasMetadataValue(item, [...path, normalizedKey], state);
    }
  } catch {
    result.__omitted__ = "additional CAS metadata keys could not be enumerated";
  }
  state.seen.delete(value);
  return result;
}

function isDiagnosticMetadataField(key: string, path: readonly string[]): boolean {
  if (key === "error" || key === "reason" || key === "failurereason") return true;
  if (key !== "feedback") return false;
  return path.some((segment) =>
    segment === "diagnostic"
      || segment === "diagnostics"
      || segment === "failure"
      || segment === "failures"
      || segment === "error"
      || segment === "errors"
      || segment === "preflight"
      || segment === "verification"
  );
}

function normalizedMetadataKey(value: string): string {
  return value.replace(/[_ -]/gu, "").toLowerCase();
}

function safeMetadataGet(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return `[omitted: ${key} metadata getter threw]`;
  }
}

function safeMetadataHasOwn(value: object, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    return false;
  }
}

function safeMetadataArrayLength(value: unknown[]): number {
  const length = safeMetadataGet(value, "length");
  return typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : 0;
}

function boundedCasMailboxPayload(value: AgentMailboxPayload): AgentMailboxPayload {
  if ("content" in value) {
    return {
      ...value,
      content: boundedCasText(value.content, "agent mailbox content"),
      ...(value.metadata
        ? { metadata: boundedCasMetadata(value.metadata, "agent mailbox metadata") }
        : {}),
    };
  }
  const bounded = boundPersistedJsonValue(value, {
    maxBytes: AGENT_TEAM_CAS_METADATA_JSON_BYTES,
    maxStringBytes: AGENT_TEAM_CAS_TEXT_JSON_BYTES,
    maxItems: PERSISTED_JSON_LIMITS.items,
    maxDepth: PERSISTED_JSON_LIMITS.depth,
    maxNodes: PERSISTED_JSON_LIMITS.nodes,
    label: "agent mailbox message",
  });
  return bounded && typeof bounded === "object" && !Array.isArray(bounded)
    ? bounded as unknown as AgentMailboxPayload
    : { role: "user", content: "[agent mailbox message omitted]" };
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

export type { AgentMailboxRow, AgentRunRow, AgentTaskRow };
