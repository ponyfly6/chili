import type {
  AgentRunId,
  ApprovalId,
  MessageId,
  SessionId,
  TaskId,
  TeamId,
  TimestampMs,
  SnapshotId,
  ToolCallId,
  TurnId,
  UserInputId,
} from "./ids.js";
import type { AgentPath } from "./agent-path.js";
import type { SessionGoal, SessionGoalUpdateReason, SessionGoalUsageDelta } from "./goal.js";
import type { MessagePart } from "./message.js";
import type {
  McpDiagnosticPayload,
  McpProgressPayload,
  McpPromptsChangedPayload,
  McpResourcesChangedPayload,
  McpServerStatusChangedPayload,
  McpToolsChangedPayload,
} from "./mcp.js";
import type { DelegationPolicy, ModelSelection, ReasoningLevel, ServiceTier, ModelMetadataPayload, RuntimeStatusPayload } from "./runtime.js";
import type { ApprovalDecisionAction, ApprovalScope, ToolCallStatus, ToolOutputStream } from "./tool.js";
import type { PersistedErrorDetails } from "./persisted-error.js";
import type { RuntimeInputQueue } from "./session-input.js";

export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  id: string;
  type: TType;
  time: TimestampMs;
  sessionId?: SessionId;
  payload: TPayload;
}

export type SessionScopedEventEnvelope<TType extends string, TPayload> =
  EventEnvelope<TType, TPayload> & { sessionId: SessionId };

export type ChiliEvent =
  | SessionEvent
  | TurnEvent
  | MessageEvent
  | ToolEvent
  | ApprovalEvent
  | UserInputEvent
  | GoalEvent
  | RecoveryEvent
  | AgentEvent
  | TeamEvent
  | McpEvent;

export function isTransientEvent(event: Pick<EventEnvelope, "type">): boolean {
  return event.type === "tool.output_delta";
}

export type SessionEvent =
  | SessionScopedEventEnvelope<"session.input_queue_changed", RuntimeInputQueue>
  | SessionScopedEventEnvelope<"session.created", { sessionId: SessionId; cwd: string }>
  | SessionScopedEventEnvelope<"session.renamed", { sessionId: SessionId; title: string }>
  | SessionScopedEventEnvelope<"session.status_changed", RuntimeStatusPayload>
  | SessionScopedEventEnvelope<"session.model_changed", { sessionId: SessionId; modelSelection: ModelSelection }>
  | SessionScopedEventEnvelope<"session.reasoning_changed", { sessionId: SessionId; reasoningLevel: ReasoningLevel }>
  | SessionScopedEventEnvelope<"session.service_tier_changed", { sessionId: SessionId; serviceTier: ServiceTier }>
  | SessionScopedEventEnvelope<"session.delegation_changed", { sessionId: SessionId; policy: DelegationPolicy }>
  | SessionScopedEventEnvelope<"session.archived", { sessionId: SessionId }>;

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
  | EventEnvelope<"tool.call_finished", { callId: ToolCallId; status: "completed" | "failed" | "cancelled"; output?: string; error?: string; errorDetails?: PersistedErrorDetails; synthetic?: boolean }>;

export type ApprovalEvent =
  | EventEnvelope<"approval.requested", { approvalId: ApprovalId; callId?: ToolCallId; permission: string; patterns: string[]; maxApprovalScope?: ApprovalScope; metadata?: Record<string, unknown> }>
  | EventEnvelope<"approval.resolved", { approvalId: ApprovalId; decision: ApprovalDecisionAction; feedback?: string }>;

export const USER_INPUT_LIMITS = {
  questions: 3,
  questionIdChars: 64,
  headerChars: 12,
  questionChars: 2_000,
  options: 3,
  optionLabelChars: 120,
  optionDescriptionChars: 1_000,
  answersPerQuestion: 20,
  answerChars: 8_000,
  totalAnswerChars: 24_000,
} as const;

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: UserInputOption[];
  multiple?: boolean;
}

export type UserInputAnswers = Record<string, string[]>;

export interface PendingUserInputRequest {
  id: UserInputId;
  sessionId: SessionId;
  callId: ToolCallId;
  questions: UserInputQuestion[];
  createdAt: number;
}

export type UserInputEvent =
  | SessionScopedEventEnvelope<"user_input.requested", {
      inputId: UserInputId;
      callId: ToolCallId;
      questions: UserInputQuestion[];
    }>
  | SessionScopedEventEnvelope<"user_input.resolved", {
      inputId: UserInputId;
      answers: UserInputAnswers;
    }>
  | SessionScopedEventEnvelope<"user_input.cancelled", {
      inputId: UserInputId;
      reason?: string;
    }>;

/** Parse and defensively copy a request_user_input question list. */
export function parseUserInputQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) throw new TypeError("questions must be an array");
  if (value.length < 1 || value.length > USER_INPUT_LIMITS.questions) {
    throw new TypeError(`questions must contain between 1 and ${USER_INPUT_LIMITS.questions} items`);
  }

  const ids = new Set<string>();
  return value.map((candidate, questionIndex) => {
    const field = `questions[${questionIndex}]`;
    const question = userInputRecord(candidate, field);
    userInputOnlyKeys(question, ["id", "header", "question", "options", "multiple"], field);
    const id = userInputIdentifier(question.id, `${field}.id`);
    if (ids.has(id)) throw new TypeError(`question id must be unique: ${id}`);
    ids.add(id);

    const optionsValue = question.options;
    if (!Array.isArray(optionsValue)) throw new TypeError(`${field}.options must be an array`);
    if (optionsValue.length < 2 || optionsValue.length > USER_INPUT_LIMITS.options) {
      throw new TypeError(`${field}.options must contain between 2 and ${USER_INPUT_LIMITS.options} items`);
    }
    const optionLabels = new Set<string>();
    const options = optionsValue.map((candidateOption, optionIndex) => {
      const optionField = `${field}.options[${optionIndex}]`;
      const option = userInputRecord(candidateOption, optionField);
      userInputOnlyKeys(option, ["label", "description"], optionField);
      const label = userInputText(option.label, `${optionField}.label`, USER_INPUT_LIMITS.optionLabelChars);
      if (optionLabels.has(label)) throw new TypeError(`${field}.options labels must be unique`);
      optionLabels.add(label);
      return {
        label,
        description: userInputText(
          option.description,
          `${optionField}.description`,
          USER_INPUT_LIMITS.optionDescriptionChars,
        ),
      };
    });
    if (question.multiple !== undefined && typeof question.multiple !== "boolean") {
      throw new TypeError(`${field}.multiple must be a boolean when provided`);
    }

    return {
      id,
      header: userInputText(question.header, `${field}.header`, USER_INPUT_LIMITS.headerChars),
      question: userInputText(question.question, `${field}.question`, USER_INPUT_LIMITS.questionChars),
      options,
      ...(question.multiple === true ? { multiple: true } : {}),
    };
  });
}

/** Parse answer arrays, optionally requiring an exact match to a question list. */
export function parseUserInputAnswers(
  value: unknown,
  questions?: readonly UserInputQuestion[],
): UserInputAnswers {
  const record = userInputRecord(value, "answers");
  const entries = Object.entries(record);
  if (entries.length < 1 || entries.length > USER_INPUT_LIMITS.questions) {
    throw new TypeError(`answers must contain between 1 and ${USER_INPUT_LIMITS.questions} question ids`);
  }

  const expected = questions ? new Map(questions.map((question) => [question.id, question])) : undefined;
  if (expected && entries.length !== expected.size) throw new TypeError("answers must include every question exactly once");
  const answerEntries: Array<[string, string[]]> = [];
  let totalChars = 0;
  for (const [rawId, rawAnswers] of entries) {
    const id = userInputIdentifier(rawId, "answer question id");
    const question = expected?.get(id);
    if (expected && !question) throw new TypeError(`answers contains an unknown question id: ${id}`);
    if (!Array.isArray(rawAnswers)) throw new TypeError(`answers.${id} must be an array`);
    const maxAnswers = question
      ? (question.multiple === true ? USER_INPUT_LIMITS.answersPerQuestion : 1)
      : USER_INPUT_LIMITS.answersPerQuestion;
    if (rawAnswers.length < 1 || rawAnswers.length > maxAnswers) {
      throw new TypeError(`answers.${id} must contain between 1 and ${maxAnswers} items`);
    }
    const parsedAnswers = rawAnswers.map((answer, answerIndex) => {
      const text = userInputText(answer, `answers.${id}[${answerIndex}]`, USER_INPUT_LIMITS.answerChars);
      totalChars += text.length;
      if (totalChars > USER_INPUT_LIMITS.totalAnswerChars) {
        throw new TypeError(`answers must not exceed ${USER_INPUT_LIMITS.totalAnswerChars} total characters`);
      }
      return text;
    });
    answerEntries.push([id, parsedAnswers]);
  }
  const answers = Object.fromEntries(answerEntries) as UserInputAnswers;
  if (expected) {
    const missing = [...expected.keys()].find((id) => !Object.prototype.hasOwnProperty.call(answers, id));
    if (missing) throw new TypeError(`answers is missing question id: ${missing}`);
  }
  return answers;
}

function userInputRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function userInputOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const supported = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !supported.has(key));
  if (unknown) throw new TypeError(`${field} contains an unexpected field: ${unknown}`);
}

function userInputIdentifier(value: unknown, field: string): string {
  const identifier = userInputText(value, field, USER_INPUT_LIMITS.questionIdChars);
  if (identifier === "__proto__" || identifier === "prototype" || identifier === "constructor") {
    throw new TypeError(`${field} must not use a prototype property name`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(identifier)) {
    throw new TypeError(`${field} must use letters, numbers, dots, underscores, or hyphens`);
  }
  return identifier;
}

function userInputText(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const text = value.trim();
  if (text.length === 0) throw new TypeError(`${field} must not be empty`);
  if (value.length > maxChars) throw new TypeError(`${field} must not exceed ${maxChars} characters`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${field} must not contain control characters`);
  return text;
}

export type GoalEvent =
  | SessionScopedEventEnvelope<"goal.updated", { goal: SessionGoal; reason?: SessionGoalUpdateReason; usageDelta?: SessionGoalUsageDelta }>
  | SessionScopedEventEnvelope<"goal.cleared", { sessionId: SessionId; previousGoal?: SessionGoal; reason?: SessionGoalUpdateReason }>;

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

export type AgentTaskStatus = "pending" | "running" | "completed" | "incomplete" | "failed" | "cancelled";
export type AgentTaskMode = "one_shot" | "resumable" | "background";
export type TaskCompletionPolicy = "join" | "notify" | "detached" | "supervised";
export type AgentMailboxStatus = "queued" | "delivering" | "consumed" | "discarded";

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
export type TeamMessageDeliveryStatus = "queued" | "delivering" | "delivered" | "failed";

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

/**
 * Team task metadata owned by the scheduler/runtime rather than a scoped
 * worker. Scoped progress updates must neither replace nor remove these
 * fields. Aliases are included because dispatch policy readers accept them.
 */
export const TEAM_TASK_RUNTIME_METADATA_KEYS = [
  "verification",
  "merge",
  "worktree",
  "chiliTeamDispatch",
  "writeScope",
  "write_scope",
  "writeScopes",
  "write_scopes",
  "executeScope",
  "execute_scope",
  "executionScope",
  "execution_scope",
  "requiredTools",
  "required_tools",
  "toolScope",
  "tool_scope",
  "suggestedTestCommands",
  "suggested_test_commands",
  "priority",
] as const;

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
