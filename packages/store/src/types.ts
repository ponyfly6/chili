import type {
  AgentPath,
  AgentRunId,
  AgentMailboxPayload,
  AgentMailboxStatus,
  AgentTaskMode,
  AgentTaskStatus,
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  SessionId,
  TaskId,
  TeamId,
  TeamMemberStatus,
  TeamMessageKind,
  TeamTaskStatus,
  ThreadId,
  ToolCallStatus,
} from "@chili/protocol";

export interface EventQuery {
  sessionId?: SessionId;
  threadId?: ThreadId;
  type?: string;
  afterEventId?: string;
  limit?: number;
}

export interface SessionRow {
  id: SessionId;
  cwd: string;
  title?: string;
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
  status: "pending" | "resolved";
  decision?: "allow_once" | "allow_always" | "deny";
  feedback?: string;
  createdAt: number;
  resolvedAt?: number;
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
  status: "running" | "completed" | "failed" | "cancelled";
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
  runId?: AgentRunId;
  generation?: number;
  owner?: string;
  summary?: string;
  error?: string;
  agentEventId?: string;
  sessionId?: SessionId;
  threadId?: ThreadId;
  time?: number;
}

export interface AgentTaskCloseCasInput {
  taskId: TaskId;
  status: AgentTaskFinalStatus;
  eventId: string;
  summary?: string;
  error?: string;
  agentEventId?: string;
  sessionId?: SessionId;
  threadId?: ThreadId;
  time?: number;
}

export interface AgentTaskFinalizationResult {
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
  teamId?: TeamId;
  path?: AgentPath;
  taskId?: TaskId;
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
  reason?: "not_found" | "already_claimed" | "already_resolved" | "blocked";
}

export interface EventStore {
  append(event: ChiliEvent): Promise<void>;
  appendMany(events: readonly ChiliEvent[]): Promise<void>;
  events(query?: EventQuery): Promise<EventEnvelope[]>;
  sessions(): Promise<SessionRow[]>;
  messages(sessionId: SessionId): Promise<Message[]>;
  pendingApprovals(sessionId?: SessionId): Promise<ApprovalRow[]>;
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

export interface AgentMailboxDeliveryStore {
  claimAgentMailboxMessage(input: AgentMailboxClaimInput): Promise<AgentMailboxMutationResult>;
  consumeAgentMailboxMessage(input: AgentMailboxConsumeInput): Promise<AgentMailboxMutationResult>;
  requeueAgentMailboxMessage(input: AgentMailboxRequeueInput): Promise<AgentMailboxMutationResult>;
}

export interface TeamProjectionStore {
  teams(query?: TeamQuery): Promise<TeamRow[]>;
  teamMembers(query?: TeamMemberQuery): Promise<TeamMemberRow[]>;
  teamTasks(query?: TeamTaskQuery): Promise<TeamTaskRow[]>;
  teamMessages(query?: TeamMessageQuery): Promise<TeamMessageRow[]>;
}

export interface TeamTaskClaimStore {
  claimTeamTask(input: TeamTaskClaimInput): Promise<TeamTaskMutationResult>;
}

export interface EventMirror {
  write(event: ChiliEvent): Promise<void>;
}
