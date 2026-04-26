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

export type AgentEvent =
  | EventEnvelope<"agent.spawned", { runId: AgentRunId; path: AgentPath; parentPath?: AgentPath; taskName: string }>
  | EventEnvelope<"agent.message_queued", { path: AgentPath; from: AgentPath; triggerTurn: boolean }>
  | EventEnvelope<"agent.completed", { runId: AgentRunId; path: AgentPath; status: "completed" | "failed" | "cancelled" }>;

export type TeamEvent =
  | EventEnvelope<"team.created", { teamId: TeamId; name: string; leadPath: AgentPath }>
  | EventEnvelope<"team.task_created", { teamId: TeamId; taskId: TaskId; ownerPath?: AgentPath }>
  | EventEnvelope<"team.task_updated", { teamId: TeamId; taskId: TaskId; status: "pending" | "in_progress" | "blocked" | "completed" | "cancelled" }>;
