import type {
  AgentPath,
  AgentRunId,
  AgentMailboxPayload,
  AgentMailboxStatus,
  AgentTaskMode,
  AgentTaskStatus,
  TaskCompletionPolicy,
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  SessionId,
  SessionGoal,
  SessionGoalStatus,
  TaskId,
  TeamId,
  TeamMessageDelivery,
  TeamMessageDeliveryStatus,
  TeamMemberStatus,
  TeamMessageKind,
  TeamTaskStatus,
  ToolCallId,
  ToolCallStatus,
  TurnId,
  ApprovalDecisionAction,
  ApprovalScope,
} from "@chili/protocol";

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
  source?: "interactive" | "subagent";
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
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

export interface AgentRunRow {
  id: AgentRunId;
  sessionId?: SessionId;
  taskId?: TaskId;
  path: AgentPath;
  parentPath?: AgentPath;
  parentSessionId?: SessionId;
  childSessionId?: SessionId;
  taskName: string;
  cwd?: string;
  mode?: AgentTaskMode;
  status: "running" | "completed" | "incomplete" | "failed" | "cancelled";
  createdAt: number;
  completedAt?: number;
}

export interface AgentTaskRow {
  id: TaskId;
  dispatchId?: string;
  reservedRunId?: AgentRunId;
  path: AgentPath;
  status: AgentTaskStatus;
  taskName: string;
  generation: number;
  parentPath?: AgentPath;
  parentSessionId?: SessionId;
  childSessionId?: SessionId;
  cwd?: string;
  prompt?: string;
  mode?: AgentTaskMode;
  workerPolicy?: Record<string, unknown>;
  sourceCallId?: ToolCallId;
  batchId?: string;
  batchIndex?: number;
  expectedBatchSize?: number;
  completionPolicy?: TaskCompletionPolicy;
  maxConcurrency?: number;
  currentRunId?: AgentRunId;
  summary?: string;
  error?: string;
  completion?: Record<string, unknown>;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  leaseHeartbeatAt?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface AgentMailboxRow {
  id: string;
  path: AgentPath;
  fromPath: AgentPath;
  triggerTurn: boolean;
  status: AgentMailboxStatus;
  taskId?: TaskId;
  recipientSessionId?: SessionId;
  message?: AgentMailboxPayload;
  createdAt: number;
  consumedAt?: number;
}

export interface AgentTaskQuery {
  taskId?: TaskId;
  path?: AgentPath;
  parentSessionId?: SessionId;
  childSessionId?: SessionId;
  sourceCallId?: ToolCallId;
  batchId?: string;
  status?: AgentTaskStatus;
  limit?: number;
}

export interface AgentRunQuery {
  taskId?: TaskId;
  path?: AgentPath;
  sessionId?: SessionId;
  childSessionId?: SessionId;
  status?: AgentRunRow["status"];
  limit?: number;
}

export interface AgentMailboxQuery {
  messageId?: string;
  taskId?: TaskId;
  path?: AgentPath;
  recipientSessionId?: SessionId;
  triggerTurn?: boolean;
  status?: AgentMailboxStatus;
  limit?: number;
}

export interface AgentTaskLeaseClaimInput {
  taskId: TaskId;
  owner: string;
  ttlMs: number;
  now?: number;
  runId?: AgentRunId;
  generation?: number;
}

export interface AgentTaskAdmissionInput {
  event: Extract<ChiliEvent, { type: "agent.task_created" }>;
  /** Unique admission:v1: token reserved before publishing the pending task. */
  owner: string;
  ttlMs: number;
  now?: number;
  runClaim?: SessionRunClaimFence;
}

export interface AgentTaskAdmissionResult {
  applied: boolean;
  /** Authoritative state when returned; mirrors may delay the response. */
  task?: AgentTaskRow;
  events: ChiliEvent[];
}

export interface AgentTaskLeaseRenewInput {
  taskId: TaskId;
  owner: string;
  generation: number;
  ttlMs: number;
  now?: number;
}

export interface AgentTaskLeaseReleaseInput {
  taskId: TaskId;
  owner: string;
  generation: number;
  now?: number;
}

export interface AgentTaskLeaseResult {
  acquired: boolean;
  task?: AgentTaskRow;
}

export type AgentTaskFinalStatus = Exclude<AgentTaskStatus, "pending" | "running">;

export interface AgentTaskCompleteCasInput {
  taskId: TaskId;
  path: AgentPath;
  status: AgentTaskFinalStatus;
  eventId: string;
  /** Exact task generation owned by the caller. */
  expectedGeneration: number;
  /** Exact run owned by the caller, or null when closing an unspawned task. */
  expectedRunId: AgentRunId | null;
  /** Exact lease owner observed/owned by the caller, including null for no lease. */
  expectedLeaseOwner: string | null;
  /** Require the matching lease to still be unexpired (worker-owned finalization). */
  requireActiveLease?: boolean;
  runId?: AgentRunId;
  generation?: number;
  owner?: string;
  summary?: string;
  error?: string;
  agentEventId?: string;
  /** Delivering mailbox message completed by this task generation. */
  mailboxMessageId?: string;
  /** Event that consumes mailboxMessageId in the same transaction as task/run completion. */
  mailboxConsumeEventId?: string;
  sessionId?: SessionId;
  time?: number;
  /** Optional root-session ownership fence for owner-driven completion. */
  runClaim?: SessionRunClaimFence;
}

export interface AgentTaskCloseCasInput {
  taskId: TaskId;
  status: AgentTaskFinalStatus;
  eventId: string;
  /** Exact task generation observed by the caller. */
  expectedGeneration: number;
  /** Exact current run observed by the caller, or null when no run exists. */
  expectedRunId: AgentRunId | null;
  /** Exact lease owner observed by the caller, including null for no lease. */
  expectedLeaseOwner: string | null;
  /** Require the matching lease to still be unexpired (worker-owned finalization). */
  requireActiveLease?: boolean;
  /** Exact lease expiry observed by a stale scanner or lease holder. */
  expectedLeaseExpiresAt?: number | null;
  /** Require the observed lease to still be absent or expired at commit time. */
  requireExpiredLease?: boolean;
  /** Require a non-empty owner and finite expiry to prove a durable lease existed. */
  requireLeaseEvidence?: boolean;
  /** Require the task to remain no newer than the stale-scan cutoff. */
  updatedBeforeOrAt?: number;
  summary?: string;
  error?: string;
  agentEventId?: string;
  /** Delivering mailbox message owned by the task generation being closed. */
  mailboxMessageId?: string;
  /** Event that consumes or requeues mailboxMessageId in the same transaction. */
  mailboxEventId?: string;
  mailboxDisposition?: "consume" | "requeue";
  mailboxError?: string;
  sessionId?: SessionId;
  time?: number;
  /** Optional root-session ownership fence for owner-driven closure. */
  runClaim?: SessionRunClaimFence;
}

export interface AgentTaskFinalizationResult {
  applied: boolean;
  task?: AgentTaskRow;
  events: ChiliEvent[];
}

export interface AgentTaskBeginRunCasInput {
  taskId: TaskId;
  expectedGeneration: number;
  expectedRunId: AgentRunId | null;
  expectedLeaseOwner: string | null;
  runId: AgentRunId;
  generation: number;
  leaseOwner: string;
  leaseTtlMs: number;
  spawnEventId: string;
  /**
   * Start the immutable run reserved by agent.task_created. This path accepts
   * only pending generation 0 with no current run or lease, and verifies that
   * runId matches the stored reservation.
   */
  reservedInitial?: boolean;
  /** Start a pending generation-0 admission while retaining its active owner token. */
  admittedInitial?: boolean;
  sourceMailboxMessageId?: string;
  messageEventId?: string;
  messageClaimEventId?: string;
  from?: AgentPath;
  message?: AgentMailboxPayload;
  sessionId?: SessionId;
  time?: number;
}

export interface AgentTaskBeginRunResult {
  applied: boolean;
  task?: AgentTaskRow;
  events: ChiliEvent[];
}

export interface AgentMailboxClaimInput {
  messageId: string;
  eventId: string;
  claimedBy?: AgentPath;
  sessionId?: SessionId;
  time?: number;
}

export interface AgentMailboxConsumeInput {
  messageId: string;
  eventId: string;
  consumedBy?: AgentPath;
  sessionId?: SessionId;
  time?: number;
}

export interface AgentMailboxRequeueInput {
  messageId: string;
  eventId: string;
  error?: string;
  sessionId?: SessionId;
  time?: number;
}

export interface AgentMailboxDiscardInput {
  messageId: string;
  eventId: string;
  discardedBy?: AgentPath;
  reason: string;
  sessionId?: SessionId;
  time?: number;
}

export interface AgentMailboxMutationResult {
  applied: boolean;
  message?: AgentMailboxRow;
  events: ChiliEvent[];
}

export interface TeamRow {
  id: TeamId;
  sessionId?: SessionId;
  name: string;
  leadPath: AgentPath;
  status: "active" | "archived";
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamMemberRow {
  teamId: TeamId;
  path: AgentPath;
  name: string;
  role: string;
  status: TeamMemberStatus;
  childSessionId?: SessionId;
  model?: string;
  toolScope?: string[];
  writeScope?: string[];
  currentTaskId?: TaskId;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface TeamTaskRow {
  id: TaskId;
  teamId: TeamId;
  sessionId?: SessionId;
  title: string;
  description?: string;
  status: TeamTaskStatus;
  ownerPath?: AgentPath;
  createdBy?: AgentPath;
  dependsOn: TaskId[];
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface TeamMessageRow {
  id: string;
  teamId: TeamId;
  fromPath: AgentPath;
  toPath: AgentPath | "*";
  content: string;
  kind: TeamMessageKind;
  delivery?: TeamMessageDelivery;
  deliveryStatus?: TeamMessageDeliveryStatus;
  deliveryError?: string;
  deliveryUpdatedAt?: number;
  deliveredAt?: number;
  taskId?: TaskId;
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface TeamQuery {
  teamId?: TeamId;
  sessionId?: SessionId;
  status?: TeamRow["status"];
  limit?: number;
}

export interface TeamMemberQuery {
  teamId?: TeamId;
  path?: AgentPath;
  childSessionId?: SessionId;
  status?: TeamMemberStatus;
  limit?: number;
}

export interface TeamTaskQuery {
  teamId?: TeamId;
  taskId?: TaskId;
  ownerPath?: AgentPath;
  status?: TeamTaskStatus;
  limit?: number;
}

export interface TeamMessageQuery {
  messageId?: string;
  teamId?: TeamId;
  path?: AgentPath;
  taskId?: TaskId;
  limit?: number;
}

export interface TeamMessageDeliveryRow {
  mailboxMessageId: string;
  teamId: TeamId;
  teamMessageId: string;
  path: AgentPath;
  status: TeamMessageDeliveryStatus;
  triggerTurn: boolean;
  childSessionId?: SessionId;
  error?: string;
  queuedAt: number;
  updatedAt: number;
  deliveredAt?: number;
}

export interface TeamMessageDeliveryQuery {
  teamId?: TeamId;
  teamMessageId?: string;
  mailboxMessageId?: string;
  path?: AgentPath;
  status?: TeamMessageDeliveryStatus;
  limit?: number;
}

/**
 * A durable runtime claim that must still be owned when a write transaction
 * commits. This is separate from event.sessionId so descendant actors can keep
 * their provenance while the root session remains the operation authority.
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

export interface TeamTaskClaimInput {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath: AgentPath;
  eventId: string;
  claimedBy?: AgentPath;
  metadata?: Record<string, unknown>;
  sessionId?: SessionId;
  runClaim?: SessionRunClaimFence;
  time?: number;
}

export interface TeamTaskMutationResult {
  applied: boolean;
  task?: TeamTaskRow;
  events: ChiliEvent[];
  reason?: "not_found" | "already_claimed" | "already_resolved" | "blocked" | "member_unavailable" | "write_conflict";
}

export interface TeamTaskVerificationClaimInput {
  teamId: TeamId;
  taskId: TaskId;
  eventId: string;
  metadata: Record<string, unknown>;
  sessionId?: SessionId;
  runClaim?: SessionRunClaimFence;
  stalePendingBefore?: number;
  time?: number;
}

export interface TeamTaskVerificationClaimResult {
  applied: boolean;
  task?: TeamTaskRow;
  events: ChiliEvent[];
  reason?: "not_found" | "not_completed" | "already_verified" | "verification_pending" | "stale";
}

export interface TeamTaskAgentSyncInput {
  teamId: TeamId;
  taskId: TaskId;
  agentTaskId: TaskId;
  agentRunId: AgentRunId;
  agentGeneration: number;
  agentStatus: AgentTaskFinalStatus;
  status: Exclude<TeamTaskStatus, "pending" | "in_progress">;
  metadata: Record<string, unknown>;
  taskEventId: string;
  memberEventId: string;
  sessionId?: SessionId;
  runClaim?: SessionRunClaimFence;
  summary?: string;
  error?: string;
  time?: number;
}

export interface TeamTaskAgentSyncResult {
  applied: boolean;
  task?: TeamTaskRow;
  events: ChiliEvent[];
  reason?: "not_found" | "not_in_progress" | "binding_mismatch" | "agent_not_terminal" | "stale";
}

export interface TeamOwnerSessionBindInput {
  teamId: TeamId;
  ownerSessionId: SessionId;
  eventId: string;
  runClaim?: SessionRunClaimFence;
  time?: number;
}

export interface TeamOwnerSessionBindResult {
  applied: boolean;
  ownerSessionId?: SessionId;
  team?: TeamRow;
  events: ChiliEvent[];
  reason?: "not_found" | "team_inactive" | "session_not_found" | "session_inactive" | "subagent_session" | "already_bound" | "conflict";
}

export interface EventStore {
  append(event: ChiliEvent, options?: EventAppendOptions): Promise<void>;
  appendMany(events: readonly ChiliEvent[], options?: EventAppendOptions): Promise<void>;
  events(query?: EventQuery): Promise<EventEnvelope[]>;
  sessions(): Promise<SessionRow[]>;
  messages(sessionId: SessionId): Promise<Message[]>;
  pendingApprovals(sessionId?: SessionId, limit?: number): Promise<ApprovalRow[]>;
}

/** Optional append receipts used by wrappers to suppress idempotent no-ops. */
export interface EventCommitAwareStore {
  appendCommitted(event: ChiliEvent, options?: EventAppendOptions): Promise<boolean>;
  appendManyCommitted(
    events: readonly ChiliEvent[],
    options?: EventAppendOptions,
  ): Promise<readonly ChiliEvent[]>;
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
  reconcileStaleTurns(input: StaleTurnRecoveryInput): Promise<ChiliEvent[]>;
}

export type GoalMutationEvent = Extract<ChiliEvent, { type: "goal.updated" | "goal.cleared" }>;

export interface GoalMutationSnapshot {
  readonly goal?: SessionGoalRow;
  readonly updatedEvents: readonly Extract<ChiliEvent, { type: "goal.updated" }>[];
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

export interface SubagentProjectionStore {
  agentTasks(query?: AgentTaskQuery): Promise<AgentTaskRow[]>;
  agentTask(taskId: TaskId): Promise<AgentTaskRow | undefined>;
  agentRuns(query?: AgentRunQuery): Promise<AgentRunRow[]>;
  agentMailbox(query?: AgentMailboxQuery): Promise<AgentMailboxRow[]>;
}

export interface AgentTaskLeaseStore {
  claimAgentTaskLease(input: AgentTaskLeaseClaimInput): Promise<AgentTaskLeaseResult>;
  renewAgentTaskLease(input: AgentTaskLeaseRenewInput): Promise<AgentTaskLeaseResult>;
  releaseAgentTaskLease(input: AgentTaskLeaseReleaseInput): Promise<boolean>;
}

/** Atomically publishes a new ordinary task together with its initial ownership lease. */
export interface AgentTaskAdmissionStore {
  admitAgentTask(input: AgentTaskAdmissionInput): Promise<AgentTaskAdmissionResult>;
}

export interface AgentTaskFinalizationStore {
  completeAgentTaskCas(input: AgentTaskCompleteCasInput): Promise<AgentTaskFinalizationResult>;
  closeAgentTaskCas(input: AgentTaskCloseCasInput): Promise<AgentTaskFinalizationResult>;
}

export interface AgentTaskRunClaimStore {
  beginAgentTaskRunCas(input: AgentTaskBeginRunCasInput): Promise<AgentTaskBeginRunResult>;
}

export type AgentTaskStoreCapability = "admission" | "lease" | "run-claim" | "finalization";

/**
 * Wrappers that always expose forwarding methods use this hook to report
 * whether their inner store actually implements the optional capability.
 */
export interface AgentTaskCapabilityStore {
  supportsAgentTaskCapability(capability: AgentTaskStoreCapability): boolean;
}

export interface AgentMailboxDeliveryStore {
  claimAgentMailboxMessage(input: AgentMailboxClaimInput): Promise<AgentMailboxMutationResult>;
  consumeAgentMailboxMessage(input: AgentMailboxConsumeInput): Promise<AgentMailboxMutationResult>;
  requeueAgentMailboxMessage(input: AgentMailboxRequeueInput): Promise<AgentMailboxMutationResult>;
  discardAgentMailboxMessage(input: AgentMailboxDiscardInput): Promise<AgentMailboxMutationResult>;
}

export type AgentMailboxStoreCapability = "delivery";

/**
 * Wrappers that always expose mailbox CAS forwarding methods use this hook to
 * report whether their inner store actually implements the capability.
 */
export interface AgentMailboxCapabilityStore {
  supportsAgentMailboxCapability(capability: AgentMailboxStoreCapability): boolean;
}

export interface TeamProjectionStore {
  teams(query?: TeamQuery): Promise<TeamRow[]>;
  teamMembers(query?: TeamMemberQuery): Promise<TeamMemberRow[]>;
  teamTasks(query?: TeamTaskQuery): Promise<TeamTaskRow[]>;
  teamMessages(query?: TeamMessageQuery): Promise<TeamMessageRow[]>;
  teamMessageDeliveries(query?: TeamMessageDeliveryQuery): Promise<TeamMessageDeliveryRow[]>;
}

export interface TeamTaskClaimStore {
  claimTeamTask(input: TeamTaskClaimInput): Promise<TeamTaskMutationResult>;
}

export interface TeamOwnerSessionBindStore {
  bindTeamOwnerSession(input: TeamOwnerSessionBindInput): Promise<TeamOwnerSessionBindResult>;
}

export interface TeamTaskVerificationClaimStore {
  claimTeamTaskVerification(input: TeamTaskVerificationClaimInput): Promise<TeamTaskVerificationClaimResult>;
}

export interface TeamTaskAgentSyncStore {
  syncTeamTaskFromAgentCas(input: TeamTaskAgentSyncInput): Promise<TeamTaskAgentSyncResult>;
}

export interface EventMirror {
  write(event: ChiliEvent): Promise<void>;
}
