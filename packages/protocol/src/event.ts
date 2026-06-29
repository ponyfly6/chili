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
import type { ThreadGoal, ThreadGoalUpdateReason, ThreadGoalUsageDelta } from "./goal.js";
import type { MessagePart } from "./message.js";
import type {
  McpDiagnosticPayload,
  McpProgressPayload,
  McpPromptsChangedPayload,
  McpResourcesChangedPayload,
  McpServerStatusChangedPayload,
  McpToolsChangedPayload,
} from "./mcp.js";
import type { ModelSelection, ReasoningLevel, ServiceTier, ModelMetadataPayload, RuntimeStatusPayload } from "./runtime.js";
import type { ApprovalDecisionAction, ToolCallStatus, ToolOutputStream } from "./tool.js";

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
  | GoalEvent
  | RecoveryEvent
  | AgentEvent
  | TeamEvent
  | McpEvent;

export type SessionEvent =
  | EventEnvelope<"session.created", { sessionId: SessionId; cwd: string }>
  | EventEnvelope<"session.status_changed", RuntimeStatusPayload>
  | EventEnvelope<"session.model_changed", { sessionId: SessionId; modelSelection: ModelSelection }>
  | EventEnvelope<"session.reasoning_changed", { sessionId: SessionId; reasoningLevel: ReasoningLevel }>
  | EventEnvelope<"session.service_tier_changed", { sessionId: SessionId; serviceTier: ServiceTier }>
  | EventEnvelope<"session.archived", { sessionId: SessionId }>;

export type TurnEvent =
  | EventEnvelope<"turn.started", { turnId: TurnId }>
  | EventEnvelope<"turn.model_metadata", ModelMetadataPayload>
  | EventEnvelope<"turn.completed", { turnId: TurnId; status: "completed" | "failed" | "cancelled" }>
  | EventEnvelope<"turn.compaction_requested", { turnId: TurnId; reason: "manual" | "token_budget" | "recovery"; boundaryMessageId?: MessageId; estimatedChars?: number; budgetChars?: number }>
  | EventEnvelope<"turn.compaction_started", { turnId: TurnId; reason: "manual" | "token_budget" | "recovery"; boundaryMessageId?: MessageId; sourceMessageCount?: number; estimatedChars?: number; budgetChars?: number }>
  | EventEnvelope<"turn.compaction_completed", { turnId: TurnId; messageId: MessageId; boundaryMessageId: MessageId; summaryChars: number; sourceMessageCount: number; estimatedCharsBefore: number; estimatedCharsAfter: number }>
  | EventEnvelope<"turn.compaction_failed", { turnId: TurnId; reason: "manual" | "token_budget" | "recovery"; boundaryMessageId?: MessageId; error: string }>
  | EventEnvelope<"turn.retry_scheduled", { turnId: TurnId; attempt: number; delayMs: number; reason: string }>
  | EventEnvelope<"turn.guard_triggered", { turnId: TurnId; reason: "repeated_tool_call" | "tool_call_limit"; toolName?: string; count: number }>;

export type MessageEvent =
  | EventEnvelope<"message.created", { messageId: MessageId; role: "system" | "user" | "assistant" | "tool"; turnId?: TurnId }>
  | EventEnvelope<"message.part_added", { messageId: MessageId; part: MessagePart }>
  | EventEnvelope<"message.part_delta", { messageId: MessageId; partId: string; field: string; delta: string }>;

export type ToolEvent =
  | EventEnvelope<"tool.call_started", { turnId: TurnId; callId: ToolCallId; toolName: string; input: unknown }>
  | EventEnvelope<"tool.call_updated", { callId: ToolCallId; status: ToolCallStatus; toolName?: string; input?: unknown; metadata?: Record<string, unknown> }>
  | EventEnvelope<"tool.output_delta", { callId: ToolCallId; stream: ToolOutputStream; delta: string; bytes?: number; truncated?: boolean; sequence?: number }>
  | EventEnvelope<"tool.call_finished", { callId: ToolCallId; status: "completed" | "failed" | "cancelled"; output?: string; error?: string; synthetic?: boolean }>;

export type ApprovalEvent =
  | EventEnvelope<"approval.requested", { approvalId: ApprovalId; callId?: ToolCallId; permission: string; patterns: string[]; metadata?: Record<string, unknown> }>
  | EventEnvelope<"approval.resolved", { approvalId: ApprovalId; decision: ApprovalDecisionAction; feedback?: string }>;

export type GoalEvent =
  | EventEnvelope<"goal.updated", { goal: ThreadGoal; reason?: ThreadGoalUpdateReason; usageDelta?: ThreadGoalUsageDelta }>
  | EventEnvelope<"goal.cleared", { threadId: ThreadId; previousGoal?: ThreadGoal; reason?: ThreadGoalUpdateReason }>;

export type RecoveryEvent =
  | EventEnvelope<"snapshot.created", { snapshotId: SnapshotId; callId?: ToolCallId; toolName?: string; paths: string[]; reason: string }>
  | EventEnvelope<"snapshot.reverted", { snapshotId: SnapshotId; status: "completed" | "failed"; paths: string[]; error?: string }>;

export type McpEvent =
  | EventEnvelope<"mcp.server_status_changed", McpServerStatusChangedPayload>
  | EventEnvelope<"mcp.tools_changed", McpToolsChangedPayload>
  | EventEnvelope<"mcp.prompts_changed", McpPromptsChangedPayload>
  | EventEnvelope<"mcp.resources_changed", McpResourcesChangedPayload>
  | EventEnvelope<"mcp.diagnostic", McpDiagnosticPayload>
  | EventEnvelope<"mcp.progress", McpProgressPayload>;

export type AgentTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type AgentTaskMode = "one_shot" | "resumable" | "background";
export type AgentMailboxStatus = "queued" | "delivering" | "consumed";

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
  workerPolicy?: Record<string, unknown>;
}

export interface AgentSpawnedPayload {
  runId: AgentRunId;
  path: AgentPath;
  taskName: string;
  generation?: number;
  parentPath?: AgentPath;
  taskId?: TaskId;
  parentSessionId?: SessionId;
  parentThreadId?: ThreadId;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  cwd?: string;
  mode?: AgentTaskMode;
  workerPolicy?: Record<string, unknown>;
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

export interface AgentMessageClaimedPayload {
  messageId: string;
  path?: AgentPath;
  taskId?: TaskId;
  claimedBy?: AgentPath;
}

export interface AgentMessageRequeuedPayload {
  messageId: string;
  path?: AgentPath;
  taskId?: TaskId;
  error?: string;
}

export interface AgentCompleteTaskPayload {
  taskId: TaskId;
  path: AgentPath;
  status: Exclude<AgentTaskStatus, "pending" | "running">;
  runId?: AgentRunId;
  generation?: number;
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentCompletedPayload {
  runId: AgentRunId;
  path: AgentPath;
  status: Exclude<AgentTaskStatus, "pending" | "running">;
  taskId?: TaskId;
  generation?: number;
  summary?: string;
  error?: string;
}

export type AgentEvent =
  | EventEnvelope<"agent.task_created", AgentTaskCreatedPayload>
  | EventEnvelope<"agent.spawned", AgentSpawnedPayload>
  | EventEnvelope<"agent.message_queued", AgentMessageQueuedPayload>
  | EventEnvelope<"agent.message_claimed", AgentMessageClaimedPayload>
  | EventEnvelope<"agent.message_requeued", AgentMessageRequeuedPayload>
  | EventEnvelope<"agent.message_consumed", AgentMessageConsumedPayload>
  | EventEnvelope<"agent.task_completed", AgentCompleteTaskPayload>
  | EventEnvelope<"agent.completed", AgentCompletedPayload>;

export type TeamMemberStatus = "idle" | "running" | "waiting" | "blocked" | "closed";
export type TeamTaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";
export type TeamMessageKind = "text" | "task_assignment" | "system";
export type TeamMessageDelivery = "queueOnly" | "triggerTurn";
export type TeamMessageDeliveryStatus = "queued" | "delivering" | "delivered" | "failed";

export interface TeamCreatedPayload {
  teamId: TeamId;
  name: string;
  leadPath: AgentPath;
  description?: string;
}

export interface TeamMemberAddedPayload {
  teamId: TeamId;
  path: AgentPath;
  name: string;
  role: string;
  status?: TeamMemberStatus;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  model?: string;
  toolScope?: string[];
  writeScope?: string[];
}

export interface TeamMemberStatusChangedPayload {
  teamId: TeamId;
  path: AgentPath;
  status: TeamMemberStatus;
  taskId?: TaskId;
  reason?: string;
}

export interface TeamTaskCreatedPayload {
  teamId: TeamId;
  taskId: TaskId;
  title?: string;
  description?: string;
  createdBy?: AgentPath;
  ownerPath?: AgentPath;
  dependsOn?: TaskId[];
  status?: TeamTaskStatus;
  metadata?: Record<string, unknown>;
}

export interface TeamTaskAssignedPayload {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath: AgentPath;
  assignedBy?: AgentPath;
  previousOwnerPath?: AgentPath;
  messageId?: string;
}

export interface TeamTaskClaimedPayload {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath: AgentPath;
  claimedBy?: AgentPath;
}

export interface TeamTaskUpdatedPayload {
  teamId: TeamId;
  taskId: TaskId;
  status?: TeamTaskStatus;
  ownerPath?: AgentPath;
  title?: string;
  description?: string;
  dependsOn?: TaskId[];
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TeamMessageSentPayload {
  teamId: TeamId;
  messageId: string;
  from: AgentPath;
  to: AgentPath | "*";
  content: string;
  kind?: TeamMessageKind;
  delivery?: TeamMessageDelivery;
  taskId?: TaskId;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export type TeamRunStopReason = "drained" | "once" | "max_cycles" | "timeout" | "aborted" | "team_inactive";
export type TeamRunLifecyclePhase = "reconcile" | "load" | "verify" | "merge" | "dispatch" | "wait" | "drain";

export interface TeamRunSummaryCounts {
  dispatched: number;
  completed: number;
  accepted: number;
  reopened: number;
  merged: number;
  mergeFailed: number;
  mergeConflicted: number;
  mergeSkipped: number;
  failed: number;
  blocked: number;
  skipped: number;
  stillRunning: number;
  errors: number;
}

export interface TeamRunStartedPayload {
  teamId: TeamId;
  runId: string;
  mode: AgentTaskMode;
  once: boolean;
  maxCycles: number;
  timeoutMs: number;
  pollIntervalMs: number;
  maxConcurrentDispatches?: number;
  maxConcurrentVerifications?: number;
}

export interface TeamRunProgressPayload {
  teamId: TeamId;
  runId: string;
  cycle: number;
  phase: TeamRunLifecyclePhase;
  counts: TeamRunSummaryCounts;
  stopReason?: TeamRunStopReason;
}

export interface TeamRunCompletedPayload {
  teamId: TeamId;
  runId: string;
  cycles: number;
  stopReason: TeamRunStopReason;
  startedAt: number;
  endedAt: number;
  counts: TeamRunSummaryCounts;
}

export type TeamEvent =
  | EventEnvelope<"team.created", TeamCreatedPayload>
  | EventEnvelope<"team.member_added", TeamMemberAddedPayload>
  | EventEnvelope<"team.member_status_changed", TeamMemberStatusChangedPayload>
  | EventEnvelope<"team.task_created", TeamTaskCreatedPayload>
  | EventEnvelope<"team.task_assigned", TeamTaskAssignedPayload>
  | EventEnvelope<"team.task_claimed", TeamTaskClaimedPayload>
  | EventEnvelope<"team.task_updated", TeamTaskUpdatedPayload>
  | EventEnvelope<"team.message_sent", TeamMessageSentPayload>
  | EventEnvelope<"team.run_started", TeamRunStartedPayload>
  | EventEnvelope<"team.run_progress", TeamRunProgressPayload>
  | EventEnvelope<"team.run_completed", TeamRunCompletedPayload>;
