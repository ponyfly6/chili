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
  ThreadGoal,
  ThreadGoalStatus,
  TaskId,
  TeamId,
  TeamMessageDelivery,
  TeamMessageDeliveryStatus,
  TeamMemberStatus,
  TeamMessageKind,
  TeamTaskStatus,
  ThreadId,
  ToolCallId,
  ToolCallStatus,
  ApprovalDecisionAction,
  ApprovalScope,
} from "@chili/protocol";

export interface EventQuery {
  sessionId?: SessionId;
  threadId?: ThreadId;
  type?: string;
  afterEventId?: string;
  limit?: number;
  tail?: boolean;
}

export interface SessionRow {
  id: SessionId;
  cwd: string;
  title?: string;
  threadId?: ThreadId;
  preview?: string;
  source?: "interactive" | "subagent";
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
}

export interface ToolCallRow {
  id: string;
  sessionId?: SessionId;
  threadId?: ThreadId;
  turnId?: string;
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
  threadId?: ThreadId;
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

export interface ThreadGoalRow extends ThreadGoal {}

export interface ThreadGoalQuery {
  sessionId?: SessionId;
  threadId?: ThreadId;
  status?: ThreadGoalStatus;
  limit?: number;
}

export interface AgentRunRow {
  id: string;
  sessionId?: SessionId;
  threadId?: ThreadId;
  taskId?: TaskId;
  path: AgentPath;
  parentPath?: AgentPath;
  parentSessionId?: SessionId;
  parentThreadId?: ThreadId;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  taskName: string;
  cwd?: string;
  mode?: AgentTaskMode;
  status: "running" | "completed" | "incomplete" | "failed" | "cancelled";
  createdAt: number;
  completedAt?: number;
}

export interface AgentTaskRow {
  id: TaskId;
  path: AgentPath;
  status: AgentTaskStatus;
  taskName: string;
  generation: number;
  parentPath?: AgentPath;
  parentSessionId?: SessionId;
  parentThreadId?: ThreadId;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  cwd?: string;
  prompt?: string;
  mode?: AgentTaskMode;
  sourceCallId?: ToolCallId;
  batchId?: string;
  batchIndex?: number;
  expectedBatchSize?: number;
  completionPolicy?: TaskCompletionPolicy;
  maxConcurrency?: number;
  currentRunId?: string;
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
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
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
  childSessionId?: SessionId;
  triggerTurn?: boolean;
  status?: AgentMailboxStatus;
  limit?: number;
}

export interface AgentTaskLeaseClaimInput {
  taskId: TaskId;
  owner: string;
  ttlMs: number;
  now?: number;
  runId?: string;
  generation?: number;
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
  threadId?: ThreadId;
  time?: number;
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
  threadId?: ThreadId;
  time?: number;
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
  sourceMailboxMessageId?: string;
  messageEventId?: string;
  messageClaimEventId?: string;
  from?: AgentPath;
  message?: AgentMailboxPayload;
  sessionId?: SessionId;
  threadId?: ThreadId;
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
  threadId?: ThreadId;
  time?: number;
}

export interface AgentMailboxConsumeInput {
  messageId: string;
  eventId: string;
  consumedBy?: AgentPath;
  sessionId?: SessionId;
  threadId?: ThreadId;
  time?: number;
}

export interface AgentMailboxRequeueInput {
  messageId: string;
  eventId: string;
  error?: string;
  sessionId?: SessionId;
  threadId?: ThreadId;
  time?: number;
}

export interface AgentMailboxDiscardInput {
  messageId: string;
  eventId: string;
  discardedBy?: AgentPath;
  reason: string;
  sessionId?: SessionId;
  threadId?: ThreadId;
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
  childThreadId?: ThreadId;
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
  childThreadId?: ThreadId;
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

export interface TeamTaskClaimInput {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath: AgentPath;
  eventId: string;
  claimedBy?: AgentPath;
  sessionId?: SessionId;
  threadId?: ThreadId;
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
  threadId?: ThreadId;
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
  threadId?: ThreadId;
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

export interface EventStore {
  append(event: ChiliEvent): Promise<void>;
  appendMany(events: readonly ChiliEvent[]): Promise<void>;
  events(query?: EventQuery): Promise<EventEnvelope[]>;
  sessions(): Promise<SessionRow[]>;
  messages(sessionId: SessionId): Promise<Message[]>;
  pendingApprovals(sessionId?: SessionId): Promise<ApprovalRow[]>;
}

export interface GoalProjectionStore {
  threadGoal(threadId: ThreadId): Promise<ThreadGoalRow | undefined>;
  threadGoals(query?: ThreadGoalQuery): Promise<ThreadGoalRow[]>;
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

export interface AgentTaskFinalizationStore {
  completeAgentTaskCas(input: AgentTaskCompleteCasInput): Promise<AgentTaskFinalizationResult>;
  closeAgentTaskCas(input: AgentTaskCloseCasInput): Promise<AgentTaskFinalizationResult>;
}

export interface AgentTaskRunClaimStore {
  beginAgentTaskRunCas(input: AgentTaskBeginRunCasInput): Promise<AgentTaskBeginRunResult>;
}

export type AgentTaskStoreCapability = "lease" | "run-claim" | "finalization";

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

export interface TeamTaskVerificationClaimStore {
  claimTeamTaskVerification(input: TeamTaskVerificationClaimInput): Promise<TeamTaskVerificationClaimResult>;
}

export interface TeamTaskAgentSyncStore {
  syncTeamTaskFromAgentCas(input: TeamTaskAgentSyncInput): Promise<TeamTaskAgentSyncResult>;
}

export interface EventMirror {
  write(event: ChiliEvent): Promise<void>;
}
