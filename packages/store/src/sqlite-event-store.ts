import { Database } from "bun:sqlite";
import { SessionInputConflictError, SessionInputRepository, type SessionInputMutation, type SessionInputMutationOptions, type SessionInputMutationResult } from "./session-inputs.js";
import type {
  ApprovalEvent,
  RuntimeEvent,
  EventEnvelope,
  Message,
  MessageId,
  MessageEvent,
  MessagePart,
  SessionId,
  SessionEvent,
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
import { EventPageTooLargeError } from "./types.js";
import { readRuntimeStateSnapshot } from "./runtime-snapshot.js";
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
  EventReplayBoundary,
  EventReplayBoundaryQuery,
  EventStore,
  SessionRow,
  CreateChildSessionInput,
  CreateChildSessionResult,
  SessionCreationClaimFence,
  SessionRunClaimFence,
  StaleTurnRecoveryInput,
  StaleTurnRecoveryStore,
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

export const SQLITE_WAL_AUTO_CHECKPOINT_PAGES = 256;
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;
/** Never ask SQLite's JSON functions to parse an unbounded audit row. */
const MAX_BOUNDED_COMPACTION_SOURCE_BYTES = 16 * 1024 * 1024;

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
    StaleTurnRecoveryStore
{
  private readonly db: Database;
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
      for (const statement of SQLITE_SCHEMA) this.db.exec(statement);
      this.inputs = new SessionInputRepository(this.db, {
        commit: (events, fence) => { this.writeTransactionEvents(events, fence); },
        claim: (input) => this.claimSessionRun(input),
        forgetClaim: (sessionId, claimId) => {
          if (this.ownedRunClaims.get(sessionId) === claimId) this.ownedRunClaims.delete(sessionId);
        },
        assertSession: (sessionId, options) => {
          const session = this.db.query<{ status: string; parent_session_id: string | null }, [string]>("select status, parent_session_id from sessions where id = ?").get(sessionId);
          if (session && !!session.parent_session_id !== (options.sessionAccess === "child")) {
            throw new SessionAccessError(sessionId);
          }
          if (!session || session.status !== "active") throw new SessionStateConflictError(sessionId, session?.status);
        },
        retry: (operation) => this.runWithWriteRetry(operation),
      });
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
      if (this.sessionCreationClaimExists(input.sessionId)) {
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
  }): { status: "claimed" | "already_exists" } {
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
      this.db.query(
        `insert into session_creation_claims
           (session_id, claim_id, cwd, claimed_at, heartbeat_at, lease_expires_at)
         values (?, ?, ?, ?, ?, ?)`,
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
  }): { status: "claimed" | "busy" | "inactive" | "not_found" | "forbidden"; sessionStatus?: string } {
    const claim = this.db.transaction(() => {
      const session = this.db
        .query<{ status: string; parent_session_id: string | null }, [string]>(`select status, parent_session_id from sessions where id = ?`)
        .get(input.sessionId);
      if (!session) return { status: "not_found" as const };
      if (session.status !== "active") {
        return { status: "inactive" as const, sessionStatus: session.status };
      }
      if (!!session.parent_session_id !== (input.sessionAccess === "child")) return { status: "forbidden" as const };
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

  private eventQueryConditions(query: EventQuery): { where: string; params: Record<string, unknown> } {
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

    return { where: clauses.length ? `where ${clauses.join(" and ")}` : "", params };
  }

  async eventReplayBoundary(query: EventReplayBoundaryQuery = {}): Promise<EventReplayBoundary> {
    const { where, params } = this.eventQueryConditions(query);
    const limit = query.limit ?? 5_000;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Replay limit must be a positive safe integer");
    const tail = query.tail && !query.afterEventId;
    // Fetch only small identity rows. The extra tail identity anchors the
    // selected window without ever materializing its (possibly huge) bodies.
    const rows = this.db.query<{ id: string }, any>(
      `select id from events ${where} order by seq ${tail ? "desc" : "asc"} limit $limit`,
    ).all({ ...params, limit: tail ? limit + 1 : limit });
    const afterEventId = tail ? rows[limit]?.id : query.afterEventId;
    return { ...(afterEventId ? { afterEventId } : {}), count: Math.min(limit, rows.length) };
  }

  async runtimeSnapshot(query: { sessionId?: SessionId; maxBytes?: number } = {}) {
    return readRuntimeStateSnapshot(this.db, query);
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    const { where, params } = this.eventQueryConditions(query);
    const limit = query.limit ?? 500;
    params.limit = limit;

    const compactPayload = query.compactRequests
      ? `case when type = 'model.request_prepared' then
           json_remove(json_set(payload_json, '$.contentVersion',
             coalesce(json_extract(payload_json, '$.contentVersion'), json_extract(payload_json, '$.request.contentVersion'))), '$.request')
         when type = 'message.part_added' and json_extract(payload_json, '$.part.type') = 'tool_result'
           then json_remove(payload_json, '$.part.structuredData')
         else payload_json end`
      : "payload_json";
    const payload = query.maxBytes !== undefined && query.compactRequests
      ? `case when length(cast(payload_json as blob)) > ${MAX_BOUNDED_COMPACTION_SOURCE_BYTES}
           then payload_json else ${compactPayload} end`
      : compactPayload;

    if (query.maxBytes !== undefined) {
      if (!Number.isSafeInteger(query.maxBytes) || query.maxBytes < 1) {
        throw new TypeError("Event page maxBytes must be a positive safe integer");
      }
      const tail = !!query.tail && !query.afterEventId;
      const candidates = this.db.prepare<Omit<StoredEventRow, "payload_json"> & { payload_bytes: number }, any>(
        `select seq, id, type, time, session_id, length(cast(${payload} as blob)) as payload_bytes
         from events ${where} order by seq ${tail ? "desc" : "asc"} limit $limit`,
      );
      const result: EventEnvelope[] = [];
      let bytes = 0;
      try {
        for (const row of candidates.iterate(params)) {
          const envelope = {
            id: row.id, type: row.type, time: row.time, payload: {},
            ...(row.session_id ? { sessionId: row.session_id } : {}),
          };
          const estimatedBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8") - 2 + row.payload_bytes;
          if (bytes + estimatedBytes > query.maxBytes) {
            if (result.length === 0) throw new EventPageTooLargeError(row.id, estimatedBytes, query.maxBytes);
            break;
          }
          // Only a proven bounded payload crosses from SQLite into JS. Oversized
          // multi-megabyte rows cannot force an unbounded JSON decode first.
          const body = this.db.query<{ payload_json: string }, [number]>(
            `select ${payload} as payload_json from events where seq = ?`,
          ).get(row.seq)!;
          const event = this.eventFromRow({ ...row, payload_json: body.payload_json });
          const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
          if (bytes + eventBytes > query.maxBytes) {
            if (result.length === 0) throw new EventPageTooLargeError(row.id, eventBytes, query.maxBytes);
            break;
          }
          result.push(event);
          bytes += eventBytes;
        }
      } finally {
        // Bun's SQLite iterator does not reset its statement on early break
        // or throw. Release the read lock before a later write/checkpoint.
        candidates.finalize();
      }
      return tail ? result.reverse() : result;
    }

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
        `select seq, id, type, time, session_id, ${payload} as payload_json
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
    const result = this.db
      .query(
        `insert into events (id, type, time, session_id, payload_json)
         values (?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.type,
        event.time,
        event.sessionId ?? null,
        encodeJson(event.payload),
      );
    return Number(result.lastInsertRowid);
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
      const title = event.payload.cwd.split("/").filter(Boolean).at(-1) ?? "Untitled";
      const agent = event.payload.agent === undefined ? undefined : parseSessionAgentMetadata(event.payload.agent);
      if (agent) {
        if (agent.parentSessionId === event.sessionId) throw new SessionInputConflictError("Agent cannot be its own parent");
        const parent = this.readSession(agent.parentSessionId);
        if (!parent || parent.status !== "active" || agent.path !== `${parent.agent?.path ?? ROOT_AGENT_PATH}/${agent.name}`) throw new SessionInputConflictError("Agent parent or path does not match");
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
      this.db.query("update session_inputs set state = 'settled', outcome = 'cancelled', revision = revision + 1, updated_at = ? where session_id = ? and state = 'pending'").run(event.time, event.sessionId);
      this.db.query("update session_dispatch set paused = 1, revision = revision + 1 where session_id = ?").run(event.sessionId);
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
    // repeated writes so a reused ID cannot alter another session or turn.
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

  private nextPartOrdinal(messageId: string): number {
    const row = this.db
      .query<{ count: number }, [string]>(`select count(*) as count from message_parts where message_id = ?`)
      .get(messageId);
    return row?.count ?? 0;
  }

  private eventFromRow(row: StoredEventRow): EventEnvelope {
    if (row.type.startsWith("session.") && !row.session_id) {
      throw new Error(`Cannot replay ${row.type}: event has no SessionId.`);
    }
    const event: EventEnvelope = {
      id: row.id,
      type: row.type,
      time: row.time as EventEnvelope["time"],
      payload: decodeJson<Record<string, unknown>>(row.payload_json, {}),
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
