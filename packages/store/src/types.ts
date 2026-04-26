import type {
  AgentPath,
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

export interface EventMirror {
  write(event: ChiliEvent): Promise<void>;
}
