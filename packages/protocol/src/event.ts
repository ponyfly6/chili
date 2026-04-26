import type {
  AgentRunId,
  ApprovalId,
  MessageId,
  SessionId,
  TaskId,
  TeamId,
  ThreadId,
  TimestampMs,
  SnapshotId,
  ToolCallId,
  TurnId,
} from "./ids.js";
import type { AgentPath } from "./agent-path.js";
import type { MessagePart } from "./message.js";
import type { ModelMetadataPayload, RuntimeStatusPayload } from "./runtime.js";
import type { ToolCallStatus } from "./tool.js";

export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  id: string;
  type: TType;
  time: TimestampMs;
  sessionId?: SessionId;
  threadId?: ThreadId;
  payload: TPayload;
}

export type ChiliEvent =
  | SessionEvent
  | TurnEvent
  | MessageEvent
  | ToolEvent
  | ApprovalEvent
  | RecoveryEvent
  | AgentEvent
  | TeamEvent;

export type SessionEvent =
  | EventEnvelope<"session.created", { sessionId: SessionId; cwd: string }>
  | EventEnvelope<"session.status_changed", RuntimeStatusPayload>
  | EventEnvelope<"session.archived", { sessionId: SessionId }>;

export type TurnEvent =
  | EventEnvelope<"turn.started", { turnId: TurnId }>
  | EventEnvelope<"turn.model_metadata", ModelMetadataPayload>
  | EventEnvelope<"turn.completed", { turnId: TurnId; status: "completed" | "failed" | "cancelled" }>
  | EventEnvelope<"turn.compaction_requested", { turnId: TurnId; reason: "manual" | "token_budget" | "recovery"; boundaryMessageId?: MessageId; estimatedChars?: number; budgetChars?: number }>
  | EventEnvelope<"turn.retry_scheduled", { turnId: TurnId; attempt: number; delayMs: number; reason: string }>
  | EventEnvelope<"turn.guard_triggered", { turnId: TurnId; reason: "repeated_tool_call" | "tool_call_limit"; toolName?: string; count: number }>;

export type MessageEvent =
  | EventEnvelope<"message.created", { messageId: MessageId; role: "system" | "user" | "assistant" | "tool" }>
  | EventEnvelope<"message.part_added", { messageId: MessageId; part: MessagePart }>
  | EventEnvelope<"message.part_delta", { messageId: MessageId; partId: string; field: string; delta: string }>;

export type ToolEvent =
  | EventEnvelope<"tool.call_started", { turnId: TurnId; callId: ToolCallId; toolName: string; input: unknown }>
  | EventEnvelope<"tool.call_updated", { callId: ToolCallId; status: ToolCallStatus; metadata?: Record<string, unknown> }>
  | EventEnvelope<"tool.call_finished", { callId: ToolCallId; status: "completed" | "failed" | "cancelled"; output?: string; error?: string; synthetic?: boolean }>;

export type ApprovalEvent =
  | EventEnvelope<"approval.requested", { approvalId: ApprovalId; callId?: ToolCallId; permission: string; patterns: string[] }>
  | EventEnvelope<"approval.resolved", { approvalId: ApprovalId; decision: "allow_once" | "allow_always" | "deny"; feedback?: string }>;

export type RecoveryEvent =
  | EventEnvelope<"snapshot.created", { snapshotId: SnapshotId; callId?: ToolCallId; toolName?: string; paths: string[]; reason: string }>
  | EventEnvelope<"snapshot.reverted", { snapshotId: SnapshotId; status: "completed" | "failed"; paths: string[]; error?: string }>;

export type AgentTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type AgentTaskMode = "one_shot" | "resumable" | "background";
export type AgentMailboxStatus = "queued" | "consumed";

export interface AgentTaskCreatedPayload {
  taskId: TaskId;
  path: AgentPath;
  parentPath: AgentPath;
  parentSessionId: SessionId;
  childSessionId: SessionId;
  childThreadId: ThreadId;
  taskName: string;
  cwd: string;
  prompt: string;
  parentThreadId?: ThreadId;
  mode?: AgentTaskMode;
}

export interface AgentSpawnedPayload {
  runId: AgentRunId;
  path: AgentPath;
  taskName: string;
  parentPath?: AgentPath;
  taskId?: TaskId;
  parentSessionId?: SessionId;
  parentThreadId?: ThreadId;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  cwd?: string;
  mode?: AgentTaskMode;
}

export type AgentMailboxPayload =
  | { role?: "system" | "user" | "assistant" | "tool"; content: string; metadata?: Record<string, unknown> }
  | { role?: "system" | "user" | "assistant" | "tool"; parts: MessagePart[]; metadata?: Record<string, unknown> };

export interface AgentMessageQueuedPayload {
  path: AgentPath;
  from: AgentPath;
  triggerTurn: boolean;
  taskId?: TaskId;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  message?: AgentMailboxPayload;
}

export interface AgentMessageConsumedPayload {
  messageId: string;
  path?: AgentPath;
  taskId?: TaskId;
  consumedBy?: AgentPath;
}

export interface AgentCompleteTaskPayload {
  taskId: TaskId;
  path: AgentPath;
  status: Exclude<AgentTaskStatus, "pending" | "running">;
  runId?: AgentRunId;
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentCompletedPayload {
  runId: AgentRunId;
  path: AgentPath;
  status: Exclude<AgentTaskStatus, "pending" | "running">;
  taskId?: TaskId;
  summary?: string;
  error?: string;
}

export type AgentEvent =
  | EventEnvelope<"agent.task_created", AgentTaskCreatedPayload>
  | EventEnvelope<"agent.spawned", AgentSpawnedPayload>
  | EventEnvelope<"agent.message_queued", AgentMessageQueuedPayload>
  | EventEnvelope<"agent.message_consumed", AgentMessageConsumedPayload>
  | EventEnvelope<"agent.task_completed", AgentCompleteTaskPayload>
  | EventEnvelope<"agent.completed", AgentCompletedPayload>;

export type TeamEvent =
  | EventEnvelope<"team.created", { teamId: TeamId; name: string; leadPath: AgentPath }>
  | EventEnvelope<"team.task_created", { teamId: TeamId; taskId: TaskId; ownerPath?: AgentPath }>
  | EventEnvelope<"team.task_updated", { teamId: TeamId; taskId: TaskId; status: "pending" | "in_progress" | "blocked" | "completed" | "cancelled" }>;
