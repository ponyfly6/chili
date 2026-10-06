import type {
  RuntimeEvent,
  EventEnvelope,
  Message,
  SessionId,
  SessionGoal,
  SessionGoalStatus,
  ToolCallId,
  ToolCallStatus,
  TurnId,
  ApprovalDecisionAction,
  ApprovalScope,
  SessionAgentMetadata,
  PersistedToolPolicy,
  ExecutionIdentity,
  RuntimeInputQueue,
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
}

export interface SessionRow {
  id: SessionId;
  cwd: string;
  title?: string;
  preview?: string;
  /** Historical workflow Session; conversation is readable but cannot execute. */
  readOnly?: true;
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

export interface SessionGoalRow extends SessionGoal {}

export interface SessionGoalQuery {
  sessionId?: SessionId;
  status?: SessionGoalStatus;
  limit?: number;
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
  append(event: RuntimeEvent, options?: EventAppendOptions): Promise<void>;
  appendMany(events: readonly RuntimeEvent[], options?: EventAppendOptions): Promise<void>;
  events(query?: EventQuery): Promise<EventEnvelope[]>;
  sessions(): Promise<SessionRow[]>;
  messages(sessionId: SessionId): Promise<Message[]>;
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

export type GoalMutationEvent = Extract<RuntimeEvent, { type: "goal.updated" | "goal.cleared" }>;

export interface GoalMutationSnapshot {
  readonly goal?: SessionGoalRow;
  readonly updatedEvents: readonly Extract<RuntimeEvent, { type: "goal.updated" }>[];
}

export interface GoalMutationDecision<T> {
  value: T;
  event?: GoalMutationEvent;
}

export interface GoalMutationResult<T> {
  value: T;
  /** Only events committed by this invocation; empty for an idempotent no-op. */
  events: readonly GoalMutationEvent[];
}

/** Optional atomic Goal read/decide/append capability. */
export interface GoalMutationStore {
  /** decide must be synchronous, free of I/O, and safe to invoke on retry. */
  mutateGoal<T>(
    sessionId: SessionId,
    decide: (snapshot: GoalMutationSnapshot) => GoalMutationDecision<T>,
    options?: EventAppendOptions,
  ): Promise<GoalMutationResult<T>>;
}

/** Wrappers report whether the complete inner chain supports atomic Goals. */
export interface GoalMutationCapabilityStore {
  supportsGoalMutation(): boolean;
}

export interface GoalProjectionStore {
  sessionGoal(sessionId: SessionId): Promise<SessionGoalRow | undefined>;
  sessionGoals(query?: SessionGoalQuery): Promise<SessionGoalRow[]>;
}

export interface EventMirror {
  write(event: RuntimeEvent): Promise<void>;
}
