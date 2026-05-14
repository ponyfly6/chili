import type { AgentPath, TaskId, TeamId, ThreadId, SessionId, ToolExecutionContext } from "@chili/protocol";

export type TeamMemberStatus = "idle" | "running" | "waiting" | "blocked" | "closed";
export type TeamTaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";
export type TeamMessageKind = "text" | "task_assignment" | "system";
export type TeamMessageDelivery = "queueOnly" | "triggerTurn";
export type TeamMessageDeliveryStatus = "queued" | "delivering" | "delivered" | "failed";

export interface TeamRecord {
  teamId: TeamId | string;
  name: string;
  leadPath: AgentPath | string;
  status: "active" | "archived";
  sessionId?: SessionId | string;
  description?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface TeamMemberRecord {
  teamId: TeamId | string;
  path: AgentPath | string;
  name: string;
  role: string;
  status: TeamMemberStatus;
  childSessionId?: SessionId | string;
  childThreadId?: ThreadId | string;
  model?: string;
  toolScope?: string[];
  writeScope?: string[];
  currentTaskId?: TaskId | string;
  createdAt?: number;
  updatedAt?: number;
  closedAt?: number;
}

export interface TeamTaskRecord {
  taskId: TaskId | string;
  teamId: TeamId | string;
  title: string;
  status: TeamTaskStatus;
  sessionId?: SessionId | string;
  description?: string;
  ownerPath?: AgentPath | string;
  createdBy?: AgentPath | string;
  dependsOn?: (TaskId | string)[];
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number;
}

export interface TeamMessageRecord {
  messageId: string;
  teamId: TeamId | string;
  fromPath: AgentPath | string;
  toPath: AgentPath | string | "*";
  content: string;
  kind: TeamMessageKind;
  delivery?: TeamMessageDelivery;
  deliveryStatus?: TeamMessageDeliveryStatus;
  deliveryError?: string;
  deliveryUpdatedAt?: number;
  deliveredAt?: number;
  taskId?: TaskId | string;
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export interface TeamMessageDeliveryRecord {
  mailboxMessageId: string;
  teamId: TeamId | string;
  teamMessageId: string;
  path: AgentPath | string;
  status: TeamMessageDeliveryStatus;
  triggerTurn: boolean;
  childSessionId?: SessionId | string;
  childThreadId?: ThreadId | string;
  error?: string;
  queuedAt?: number;
  updatedAt?: number;
  deliveredAt?: number;
}

export interface TeamTaskClaimRecord {
  applied: boolean;
  task?: TeamTaskRecord;
  reason?: "not_found" | "already_claimed" | "already_resolved" | "blocked" | "member_unavailable" | "write_conflict";
}

export interface TeamSnapshotMemberRecord extends TeamMemberRecord {
  taskIds: (TaskId | string)[];
  deliveryIds: string[];
  currentTask?: TeamTaskRecord;
}

export interface TeamSnapshotTaskRecord extends TeamTaskRecord {
  blockedBy: (TaskId | string)[];
  blocks: (TaskId | string)[];
  ready: boolean;
  messageIds: string[];
  owner?: TeamMemberRecord;
  dispatch?: unknown;
}

export interface TeamSnapshotMessageRecord extends TeamMessageRecord {
  deliveries: TeamMessageDeliveryRecord[];
}

export interface TeamSnapshotStatsRecord {
  memberCount: number;
  taskCount: number;
  messageCount: number;
  deliveryCount: number;
  membersByStatus: Record<string, number>;
  tasksByStatus: Record<string, number>;
  messagesByDeliveryStatus: Record<string, number>;
  deliveriesByStatus: Record<string, number>;
  readyTaskIds: (TaskId | string)[];
  blockedTaskIds: (TaskId | string)[];
}

export interface TeamSnapshotRecord {
  team: TeamRecord;
  members: TeamSnapshotMemberRecord[];
  tasks: TeamSnapshotTaskRecord[];
  messages: TeamSnapshotMessageRecord[];
  messageDeliveries: TeamMessageDeliveryRecord[];
  stats: TeamSnapshotStatsRecord;
  generatedAt?: number;
}

export interface TeamCreateToolInput {
  teamId?: string;
  name: string;
  leadPath: string;
  description?: string;
  leadName?: string;
  leadRole?: string;
  leadStatus?: TeamMemberStatus;
  leadWriteScope?: string[];
}

export interface TeamListToolInput {
  status?: "active" | "archived";
  limit?: number;
}

export interface TeamSnapshotToolInput {
  teamId: string;
}

export interface TeamMemberAddToolInput {
  teamId: string;
  path: string;
  name: string;
  role: string;
  status?: TeamMemberStatus;
  childSessionId?: string;
  childThreadId?: string;
  model?: string;
  toolScope?: string[];
  writeScope?: string[];
}

export interface TeamMemberListToolInput {
  teamId: string;
  status?: TeamMemberStatus;
  limit?: number;
}

export interface TeamTaskCreateToolInput {
  teamId: string;
  taskId?: string;
  title: string;
  description?: string;
  createdBy?: string;
  ownerPath?: string;
  dependsOn?: string[];
  status?: TeamTaskStatus;
  metadata?: Record<string, unknown>;
  writeScope?: string[];
  executeScope?: string[];
  requiredTools?: string[];
  suggestedTestCommands?: string[];
}

export interface TeamTaskCreateBatchItemInput {
  taskId?: string;
  title: string;
  description?: string;
  createdBy?: string;
  ownerPath?: string;
  dependsOn?: string[];
  status?: TeamTaskStatus;
  metadata?: Record<string, unknown>;
  writeScope?: string[];
  executeScope?: string[];
  requiredTools?: string[];
  suggestedTestCommands?: string[];
}

export interface TeamTaskCreateBatchToolInput {
  teamId: string;
  createdBy?: string;
  tasks: TeamTaskCreateBatchItemInput[];
}

export interface TeamTaskListToolInput {
  teamId: string;
  status?: TeamTaskStatus;
  ownerPath?: string;
  limit?: number;
}

export interface TeamTaskAssignToolInput {
  teamId: string;
  taskId: string;
  ownerPath: string;
  assignedBy?: string;
  message?: string;
  messageDelivery?: TeamMessageDelivery;
  messageSummary?: string;
}

export interface TeamTaskClaimToolInput {
  teamId: string;
  taskId: string;
  ownerPath: string;
  claimedBy?: string;
}

export interface TeamTaskUpdateToolInput {
  teamId: string;
  taskId: string;
  status?: TeamTaskStatus;
  ownerPath?: string;
  title?: string;
  description?: string;
  dependsOn?: string[];
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export type TeamTaskDispatchMode = "one_shot" | "resumable" | "background";
export type TeamTaskDispatchStatus = "running" | "completed" | "failed" | "cancelled" | "skipped";

export interface TeamTaskDispatchToolInput {
  teamId: string;
  taskId: string;
  ownerPath?: string;
  mode?: TeamTaskDispatchMode;
  prompt?: string;
}

export interface TeamTaskDispatchBatchItemInput {
  taskId: string;
  ownerPath?: string;
  prompt?: string;
}

export interface TeamTaskDispatchBatchToolInput {
  teamId: string;
  tasks: TeamTaskDispatchBatchItemInput[];
  mode?: "background";
  maxConcurrency?: number;
}

export interface TeamTaskSyncToolInput {
  teamId: string;
  taskId: string;
}

export interface TeamTaskReconcileToolInput {
  teamId?: string;
  limit?: number;
}

export interface TeamDispatchAgentTaskRecord {
  taskId: TaskId | string;
  path?: AgentPath | string;
  runId?: string;
  childSessionId?: SessionId | string;
  childThreadId?: ThreadId | string;
  status: string;
  summary?: string;
  error?: string;
}

export interface TeamTaskDispatchRecord {
  status: TeamTaskDispatchStatus;
  teamTask: TeamTaskRecord;
  agentTask?: TeamDispatchAgentTaskRecord;
  reason?: string;
}

export interface TeamTaskCreateBatchRecord {
  count: number;
  tasks: TeamTaskRecord[];
}

export interface TeamTaskDispatchBatchErrorRecord {
  taskId: TaskId | string;
  ownerPath?: AgentPath | string;
  error: string;
}

export interface TeamTaskDispatchBatchRecord {
  count: number;
  dispatched: TeamTaskDispatchRecord[];
  errors: TeamTaskDispatchBatchErrorRecord[];
}

export interface TeamTaskSyncRecord {
  applied: boolean;
  teamTask: TeamTaskRecord;
  agentTask?: TeamDispatchAgentTaskRecord;
  reason?: string;
}

export interface TeamTaskReconcileErrorRecord {
  teamId: TeamId | string;
  taskId: TaskId | string;
  error: string;
}

export interface TeamTaskReconcileRecord {
  scanned: number;
  synced: TeamTaskSyncRecord[];
  skipped: TeamTaskSyncRecord[];
  errors: TeamTaskReconcileErrorRecord[];
}

export interface TeamRunLoopToolInput {
  teamId: string;
  mode?: TeamTaskDispatchMode;
  once?: boolean;
  maxCycles?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxConcurrentDispatches?: number;
}

export interface TeamRunLoopDispatchedTaskRecord {
  teamId: TeamId | string;
  taskId: TaskId | string;
  ownerPath?: AgentPath | string;
  agentTaskId?: TaskId | string;
  status: TeamTaskDispatchStatus;
}

export interface TeamRunLoopFinalTaskRecord {
  teamId: TeamId | string;
  taskId: TaskId | string;
  ownerPath?: AgentPath | string;
  status: Extract<TeamTaskStatus, "completed" | "failed" | "cancelled">;
  summary?: string;
  error?: string;
  agentTaskId?: TaskId | string;
}

export interface TeamRunLoopVerificationTaskRecord {
  teamId: TeamId | string;
  taskId: TaskId | string;
  ownerPath?: AgentPath | string;
  status: "passed" | "failed";
  feedback?: string;
  verifierTaskId?: TaskId | string;
}

export interface TeamRunLoopMergeTaskRecord {
  teamId: TeamId | string;
  taskId: TaskId | string;
  ownerPath?: AgentPath | string;
  status: "applied" | "failed" | "conflicted";
  diffSummary?: unknown;
  error?: string;
  conflicts?: string[];
}

export interface TeamRunLoopMergeSkippedTaskRecord {
  teamId: TeamId | string;
  taskId: TaskId | string;
  ownerPath?: AgentPath | string;
  reason: string;
  error?: string;
}

export interface TeamRunLoopSkippedTaskRecord {
  teamId: TeamId | string;
  taskId: TaskId | string;
  ownerPath?: AgentPath | string;
  reason: string;
  blockedBy?: (TaskId | string)[];
}

export interface TeamRunLoopRunningTaskRecord {
  teamId: TeamId | string;
  taskId: TaskId | string;
  ownerPath?: AgentPath | string;
  title: string;
  agentTaskId?: TaskId | string;
}

export interface TeamRunLoopErrorRecord {
  teamId: TeamId | string;
  taskId?: TaskId | string;
  error: string;
}

export interface TeamRunLoopRecord {
  teamId: TeamId | string;
  cycles: number;
  stopReason: string;
  startedAt: number;
  endedAt: number;
  dispatched: TeamRunLoopDispatchedTaskRecord[];
  completed: TeamRunLoopFinalTaskRecord[];
  accepted: TeamRunLoopFinalTaskRecord[];
  reopened: TeamRunLoopVerificationTaskRecord[];
  merged: TeamRunLoopMergeTaskRecord[];
  mergeFailed: TeamRunLoopMergeTaskRecord[];
  mergeConflicted: TeamRunLoopMergeTaskRecord[];
  mergeSkipped: TeamRunLoopMergeSkippedTaskRecord[];
  failed: TeamRunLoopFinalTaskRecord[];
  blocked: TeamRunLoopSkippedTaskRecord[];
  skipped: TeamRunLoopSkippedTaskRecord[];
  stillRunning: TeamRunLoopRunningTaskRecord[];
  errors: TeamRunLoopErrorRecord[];
}

export interface TeamMessageSendToolInput {
  teamId: string;
  messageId?: string;
  from: string;
  to: string | "*";
  content: string;
  kind?: TeamMessageKind;
  delivery?: TeamMessageDelivery;
  taskId?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface TeamMessageListToolInput {
  teamId: string;
  path?: string;
  taskId?: string;
  limit?: number;
}

export type TeamToolContext = ToolExecutionContext;

export interface TeamToolController {
  createTeam(input: TeamCreateToolInput, context: TeamToolContext): Promise<TeamRecord>;
  listTeams(input: TeamListToolInput, context: TeamToolContext): Promise<TeamRecord[]>;
  snapshotTeam(input: TeamSnapshotToolInput, context: TeamToolContext): Promise<TeamSnapshotRecord>;
  addMember(input: TeamMemberAddToolInput, context: TeamToolContext): Promise<TeamMemberRecord>;
  listMembers(input: TeamMemberListToolInput, context: TeamToolContext): Promise<TeamMemberRecord[]>;
  createTask(input: TeamTaskCreateToolInput, context: TeamToolContext): Promise<TeamTaskRecord>;
  listTasks(input: TeamTaskListToolInput, context: TeamToolContext): Promise<TeamTaskRecord[]>;
  assignTask(input: TeamTaskAssignToolInput, context: TeamToolContext): Promise<TeamTaskRecord>;
  claimTask(input: TeamTaskClaimToolInput, context: TeamToolContext): Promise<TeamTaskClaimRecord>;
  updateTask(input: TeamTaskUpdateToolInput, context: TeamToolContext): Promise<TeamTaskRecord>;
  sendMessage(input: TeamMessageSendToolInput, context: TeamToolContext): Promise<TeamMessageRecord>;
  listMessages(input: TeamMessageListToolInput, context: TeamToolContext): Promise<TeamMessageRecord[]>;
}

export interface TeamTaskDispatchToolController {
  dispatchTask(input: TeamTaskDispatchToolInput, context: TeamToolContext): Promise<TeamTaskDispatchRecord>;
  syncTask(input: TeamTaskSyncToolInput, context: TeamToolContext): Promise<TeamTaskSyncRecord>;
  reconcileTasks(input: TeamTaskReconcileToolInput, context: TeamToolContext): Promise<TeamTaskReconcileRecord>;
}

export interface TeamRunLoopToolController {
  runTeam(input: TeamRunLoopToolInput, context: TeamToolContext): Promise<TeamRunLoopRecord>;
}
