import type {
  AgentPath,
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  SessionId,
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
  path: AgentPath;
  parentPath?: AgentPath;
  taskName: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  completedAt?: number;
}

export interface EventStore {
  append(event: ChiliEvent): Promise<void>;
  appendMany(events: readonly ChiliEvent[]): Promise<void>;
  events(query?: EventQuery): Promise<EventEnvelope[]>;
  sessions(): Promise<SessionRow[]>;
  messages(sessionId: SessionId): Promise<Message[]>;
  pendingApprovals(sessionId?: SessionId): Promise<ApprovalRow[]>;
}

export interface EventMirror {
  write(event: ChiliEvent): Promise<void>;
}
