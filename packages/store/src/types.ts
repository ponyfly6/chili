import type {
  RuntimeEvent,
  EventEnvelope,
  Message,
  MessageId,
  SessionId,
  ToolCallId,
  ToolCallStatus,
  TurnId,
  ApprovalDecisionAction,
  ApprovalScope,
  SessionAgentMetadata,
  PersistedToolPolicy,
  ExecutionIdentity,
  RuntimeInputQueue,
  RuntimeStateSnapshot,
  ChiliEvent,
} from "@chili/protocol";
import type { SessionInputAccept, StoredSessionInput } from "./session-inputs.js";

export interface EventQuery {
  /** Omit request audit bodies and program-only results before decoding client projections. */
  compactRequests?: boolean;
  sessionId?: SessionId;
  type?: string;
  afterEventId?: string;
  /** Read events strictly before this durable cursor. */
  beforeEventId?: string;
  limit?: number;
  tail?: boolean;
  /**
   * Bound the UTF-8 JSON bytes returned by this page. A forward page is a
   * continuous prefix; a tail page is a continuous suffix, still in ascending
   * durable order. An oversized first candidate must fail with its cursor;
   * implementations must never silently skip it or decode an unbounded row.
   */
  maxBytes?: number;
}

export interface EventReplayBoundaryQuery {
  sessionId?: SessionId;
  afterEventId?: string;
  /** Maximum count to inspect, including the overflow probe for resume. */
  limit?: number;
  tail?: boolean;
}

export interface EventReplayBoundary {
  /** Cursor immediately before the selected tail, or the supplied resume cursor. */
  afterEventId?: string;
  /** Matching event count, capped at the requested limit. */
  count: number;
}

/** Optional metadata-only replay sizing; never decodes event bodies. */
export interface EventReplayBoundaryStore {
  eventReplayBoundary(query?: EventReplayBoundaryQuery): Promise<EventReplayBoundary>;
}

export class EventPageTooLargeError extends Error {
  override readonly name = "EventPageTooLargeError";

  constructor(readonly eventId: string, readonly bytes: number, readonly maxBytes: number) {
    super(`Event ${eventId} requires ${bytes} bytes, exceeding the ${maxBytes}-byte page budget`);
  }
}

export interface SessionRow {
  id: SessionId;
  cwd: string;
  title?: string;
  preview?: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  agent?: SessionAgentMetadata;
}

export interface CreateChildSessionInput {
  sessionId: SessionId;
  parentSessionId: SessionId;
  name: string;
  cwd: string;
  policy: PersistedToolPolicy;
  identity?: ExecutionIdentity;
  initialInput: Omit<SessionInputAccept, "kind" | "sessionId">;
  maxChildren?: number;
  maxDepth?: number;
  runClaim: SessionRunClaimFence;
}

export interface CreateChildSessionResult {
  session: SessionRow;
  input: StoredSessionInput;
  queue: RuntimeInputQueue;
  events: RuntimeEvent[];
  duplicate?: boolean;
}

export interface AgentSessionStore {
  session(sessionId: SessionId): Promise<SessionRow | undefined>;
  childSessions(parentSessionId: SessionId): Promise<SessionRow[]>;
  createChildSession(input: CreateChildSessionInput): Promise<CreateChildSessionResult>;
}

export interface ToolCallRow {
  id: string;
  providerCallId?: string;
  parentCallId?: ToolCallId;
  sessionId?: SessionId;
  turnId?: TurnId;
  toolName: string;
  status: ToolCallStatus;
  input?: unknown;
  output?: string;
  error?: string;
  synthetic?: boolean;
  startedAt: number;
  updatedAt: number;
}

export interface ApprovalRow {
  id: string;
  sessionId?: SessionId;
  callId?: string;
  permission: string;
  patterns: string[];
  maxApprovalScope?: ApprovalScope;
  metadata?: Record<string, unknown>;
  status: "pending" | "resolved";
  decision?: ApprovalDecisionAction;
  feedback?: string;
  createdAt: number;
  resolvedAt?: number;
}

/**
 * A durable runtime claim that must still be owned when a write transaction
 * commits. Every event written under it must have that Session identity.
 */
export interface SessionRunClaimFence {
  sessionId: SessionId;
  claimId: string;
}

/** A durable session-creation claim that must still be owned at commit time. */
export interface SessionCreationClaimFence {
  sessionId: SessionId;
  claimId: string;
}

export interface EventAppendOptions {
  runClaim?: SessionRunClaimFence;
  creationClaim?: SessionCreationClaimFence;
}

export interface EventStore {
  /** Acquire control of this root conversation until its Host closes. Reads do not acquire. */
  acquireSessionOwnership?(sessionId: SessionId): boolean;
  /** Check admission without acquiring ownership. Durable mutations check again atomically. */
  assertSessionOwnership?(sessionId: SessionId): void;
  /** Read-only maintenance filter: Host-backed stores repair only their already-owned roots. */
  canRecoverSession?(sessionId: SessionId): boolean;
  append(event: RuntimeEvent, options?: EventAppendOptions): Promise<void>;
  appendMany(events: readonly RuntimeEvent[], options?: EventAppendOptions): Promise<void>;
  /**
   * Return only committed durable records, in strictly increasing storage
   * sequence (including tail queries). afterEventId is exclusive and resolves
   * in the requested Session scope; unknown cursors fail. The sequence and ID
   * of a committed record never change. Pages never omit matching records in
   * the selected prefix/suffix. Notifications are wakeups, not replay data.
   */
  events(query?: EventQuery): Promise<EventEnvelope[]>;
  eventReplayBoundary?(query?: EventReplayBoundaryQuery): Promise<EventReplayBoundary>;
  /** Durable state and watermark from one read transaction, plus current in-memory content when available. */
  runtimeSnapshot?(query?: { sessionId?: SessionId; maxBytes?: number }): Promise<RuntimeStateSnapshot>;
  /**
   * Synchronously capture complete, uncommitted text/reasoning from this process.
   * Subscribe before calling this method so subsequent deltas cannot fall into
   * an asynchronous gap. Returned snapshots never advance the durable cursor.
   */
  activeMessageParts?(query?: { sessionId?: SessionId; maxBytes?: number }): ChiliEvent[];
  sessions(): Promise<SessionRow[]>;
  messages(sessionId: SessionId): Promise<Message[]>;
  /** Message role/text never establishes provenance; consult its durable accepted input. */
  sessionInputForMessage?(sessionId: SessionId, messageId: MessageId): StoredSessionInput | undefined;
  /** Durable queue revision also covers accepted inputs not yet promoted to messages. */
  sessionInputQueue?(sessionId: SessionId): RuntimeInputQueue;
  pendingApprovals(sessionId?: SessionId, limit?: number): Promise<ApprovalRow[]>;
}

/** Optional append receipts used by wrappers to suppress idempotent no-ops. */
export interface EventCommitAwareStore {
  appendCommitted(event: RuntimeEvent, options?: EventAppendOptions): Promise<boolean>;
  appendManyCommitted(
    events: readonly RuntimeEvent[],
    options?: EventAppendOptions,
  ): Promise<readonly RuntimeEvent[]>;
}

export interface StaleTurnRecoveryInput {
  staleBefore: number;
  createId: (prefix: string) => string;
  now?: number;
  status?: "failed" | "cancelled";
  reason?: string;
}

/** Optional atomic recovery capability for stores with durable turn state. */
export interface StaleTurnRecoveryStore {
  reconcileStaleTurns(input: StaleTurnRecoveryInput): Promise<RuntimeEvent[]>;
}

export interface EventMirror {
  write(event: RuntimeEvent): Promise<void>;
}
