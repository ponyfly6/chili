import type { AgentPath, TaskId, TeamId, ThreadId, SessionId, ToolExecutionContext } from "@chili/protocol";

export type TeamMemberStatus = "idle" | "running" | "waiting" | "blocked" | "closed";
export type TeamTaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";
export type TeamMessageKind = "text" | "task_assignment" | "system";

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
  taskId?: TaskId | string;
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export interface TeamTaskClaimRecord {
  applied: boolean;
  task?: TeamTaskRecord;
  reason?: "not_found" | "already_claimed" | "already_resolved" | "blocked";
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

export interface TeamMessageSendToolInput {
  teamId: string;
  messageId?: string;
  from: string;
  to: string | "*";
  content: string;
  kind?: TeamMessageKind;
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
