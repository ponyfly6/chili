/**
 * Read-only compatibility schema for retired Agent Task/Run/Mailbox and Team
 * events. These types describe persisted history, never current runtime state
 * or commands. Import this explicit legacy entry point only when decoding or
 * displaying old records; new writes must use RuntimeEvent.
 */
import type { AgentPath } from "./agent-path.js";
import type { ChiliEvent, EventEnvelope } from "./event.js";
import type { Brand, SessionId, ToolCallId } from "./ids.js";
import type { MessagePart } from "./message.js";

export type AgentRunId = Brand<string, "AgentRunId">;
export type TeamId = Brand<string, "TeamId">;
export type TaskId = Brand<string, "TaskId">;

export type AgentTaskStatus = "pending" | "running" | "completed" | "incomplete" | "failed" | "cancelled";
export type AgentTaskMode = "one_shot" | "resumable" | "background";
export type TaskCompletionPolicy = "join" | "notify" | "detached" | "supervised";

export interface AgentTaskCreatedPayload {
  taskId: TaskId;
  /** Stable identity used to make crash-retried task creation idempotent. */
  dispatchId?: string;
  /** Run id reserved by the dispatcher before the task is durably created. */
  reservedRunId?: AgentRunId;
  path: AgentPath;
  parentPath: AgentPath;
  parentSessionId: SessionId;
  childSessionId: SessionId;
  taskName: string;
  cwd: string;
  prompt: string;
  mode?: AgentTaskMode;
  workerPolicy?: Record<string, unknown>;
  sourceCallId?: ToolCallId;
  batchId?: string;
  batchIndex?: number;
  expectedBatchSize?: number;
  completionPolicy?: TaskCompletionPolicy;
  maxConcurrency?: number;
}

export interface AgentSpawnedPayload {
  runId: AgentRunId;
  path: AgentPath;
  taskName: string;
  generation?: number;
  parentPath?: AgentPath;
  taskId?: TaskId;
  parentSessionId?: SessionId;
  childSessionId?: SessionId;
  cwd?: string;
  mode?: AgentTaskMode;
  workerPolicy?: Record<string, unknown>;
  sourceCallId?: ToolCallId;
  batchId?: string;
  batchIndex?: number;
  expectedBatchSize?: number;
  completionPolicy?: TaskCompletionPolicy;
  maxConcurrency?: number;
}

export type AgentMailboxPayload =
  | { role?: "system" | "user" | "assistant" | "tool"; content: string; metadata?: Record<string, unknown> }
  | { role?: "system" | "user" | "assistant" | "tool"; parts: MessagePart[]; metadata?: Record<string, unknown> };

export interface AgentMessageQueuedPayload {
  path: AgentPath;
  from: AgentPath;
  triggerTurn: boolean;
  taskId?: TaskId;
  recipientSessionId?: SessionId;
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

export interface AgentMessageDiscardedPayload {
  messageId: string;
  path?: AgentPath;
  taskId?: TaskId;
  discardedBy?: AgentPath;
  reason: string;
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
  | EventEnvelope<"agent.message_discarded", AgentMessageDiscardedPayload>
  | EventEnvelope<"agent.message_consumed", AgentMessageConsumedPayload>
  | EventEnvelope<"agent.task_completed", AgentCompleteTaskPayload>
  | EventEnvelope<"agent.completed", AgentCompletedPayload>;

export type TeamMemberStatus = "idle" | "running" | "waiting" | "blocked" | "closed";
export type TeamTaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";
export type TeamMessageKind = "text" | "task_assignment" | "system";
export type TeamMessageDelivery = "queueOnly" | "triggerTurn";

export interface TeamCreatedPayload {
  teamId: TeamId;
  name: string;
  leadPath: AgentPath;
  description?: string;
}

export interface TeamOwnerSessionBoundPayload {
  teamId: TeamId;
  ownerSessionId: SessionId;
}

export interface TeamMemberAddedPayload {
  teamId: TeamId;
  path: AgentPath;
  name: string;
  role: string;
  status?: TeamMemberStatus;
  childSessionId?: SessionId;
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
  /** Scheduler-owned metadata committed atomically with the claim. */
  metadata?: Record<string, unknown>;
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
  | EventEnvelope<"team.owner_session_bound", TeamOwnerSessionBoundPayload>
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

/** Historical wire union; no current Agent identity or lifecycle lives here. */
export type LegacyWorkflowEvent = AgentEvent | TeamEvent;

export const LEGACY_WORKFLOW_EVENT_TYPES = [
  "agent.task_created",
  "agent.spawned",
  "agent.message_queued",
  "agent.message_claimed",
  "agent.message_requeued",
  "agent.message_discarded",
  "agent.message_consumed",
  "agent.task_completed",
  "agent.completed",
  "team.created",
  "team.owner_session_bound",
  "team.member_added",
  "team.member_status_changed",
  "team.task_created",
  "team.task_assigned",
  "team.task_claimed",
  "team.task_updated",
  "team.message_sent",
  "team.run_started",
  "team.run_progress",
  "team.run_completed",
] as const satisfies readonly LegacyWorkflowEvent["type"][];

const legacyEventTypes = new Set<string>(LEGACY_WORKFLOW_EVENT_TYPES);

export function isLegacyWorkflowEventType(type: string): type is LegacyWorkflowEvent["type"] {
  return legacyEventTypes.has(type);
}

export function isLegacyWorkflowEvent(event: ChiliEvent): event is LegacyWorkflowEvent {
  return isLegacyWorkflowEventType(event.type);
}
