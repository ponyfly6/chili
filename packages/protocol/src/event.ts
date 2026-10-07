import type {
  ApprovalId,
  MessageId,
  SessionId,
  TimestampMs,
  SnapshotId,
  ToolCallId,
  TurnId,
  UserInputId,
} from "./ids.js";
import type { SessionAgentMetadata } from "./session-agent.js";
import type { Message, MessagePart } from "./message.js";
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
import type { PreparedModelIdentity, PreparedModelRequest } from "./prepared-request.js";
import type { ExecutionIdentity } from "./execution-identity.js";

export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  id: string;
  type: TType;
  time: TimestampMs;
  sessionId?: SessionId;
  payload: TPayload;
}

export type SessionScopedEventEnvelope<TType extends string, TPayload> =
  EventEnvelope<TType, TPayload> & { sessionId: SessionId };

/** Events emitted by the current Session-based runtime. */
export type RuntimeEvent =
  | SessionEvent
  | TurnEvent
  | MessageEvent
  | ToolEvent
  | ApprovalEvent
  | UserInputEvent
  | RecoveryEvent
  | McpEvent;

export type ChiliEvent = RuntimeEvent;

export function isTransientEvent(event: Pick<EventEnvelope, "type">): boolean {
  return event.type === "tool.output_delta";
}

/** Program results are read through storage; UI history carries their model/display form. */
export function compactRuntimeMessage(message: Message): Message {
  if (!message.parts.some((part) => part.type === "tool_result" && part.structuredData !== undefined)) return message;
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "tool_result" || part.structuredData === undefined) return part;
      const { structuredData: _, ...displayPart } = part;
      return displayPart;
    }),
  };
}

/** Keep the audit record in storage while transporting only its stable reference. */
export function compactRuntimeEvent(event: ChiliEvent): ChiliEvent {
  if (event.type === "message.part_added" && event.payload.part.type === "tool_result") {
    const { structuredData, ...part } = event.payload.part;
    if (structuredData === undefined) return event;
    return { ...event, payload: { ...event.payload, part } };
  }
  if (event.type !== "model.request_prepared") return event;
  const { request, ...payload } = event.payload;
  return {
    ...event,
    payload: {
      ...payload,
      // Full events written before the reference field was introduced remain replayable.
      contentVersion: payload.contentVersion ?? request?.contentVersion,
    },
  };
}

export type SessionEvent =
  | SessionScopedEventEnvelope<"session.tools_loaded", { sessionId: SessionId; turnId: TurnId; callId: ToolCallId; names: string[] }>
  | SessionScopedEventEnvelope<"session.input_queue_changed", RuntimeInputQueue>
  | SessionScopedEventEnvelope<"session.created", { sessionId: SessionId; cwd: string; identity?: ExecutionIdentity; agent?: SessionAgentMetadata }>
  | SessionScopedEventEnvelope<"session.identity_bound", { sessionId: SessionId; identity: ExecutionIdentity }>
  | SessionScopedEventEnvelope<"session.renamed", { sessionId: SessionId; title: string }>
  | SessionScopedEventEnvelope<"session.status_changed", RuntimeStatusPayload>
  | SessionScopedEventEnvelope<"session.model_changed", { sessionId: SessionId; modelSelection: ModelSelection }>
  | SessionScopedEventEnvelope<"session.reasoning_changed", { sessionId: SessionId; reasoningLevel: ReasoningLevel }>
  | SessionScopedEventEnvelope<"session.service_tier_changed", { sessionId: SessionId; serviceTier: ServiceTier }>
  | SessionScopedEventEnvelope<"session.delegation_changed", { sessionId: SessionId; policy: DelegationPolicy }>
  | SessionScopedEventEnvelope<"session.archived", { sessionId: SessionId }>;

export type TurnEvent =
  | EventEnvelope<"model.request_prepared", { turnId: TurnId; requestId: string; attempt: number; contentVersion: string; request?: PreparedModelRequest }>
  | EventEnvelope<"model.request_identity", { turnId: TurnId; requestId: string; attempt: number; identity: PreparedModelIdentity }>
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
  | EventEnvelope<"tool.call_started", { turnId: TurnId; callId: ToolCallId; providerCallId?: string; parentCallId?: ToolCallId; toolName: string; input: unknown }>
  | EventEnvelope<"tool.call_updated", { callId: ToolCallId; providerCallId?: string; status: ToolCallStatus; toolName?: string; input?: unknown; metadata?: Record<string, unknown> }>
  | EventEnvelope<"tool.output_delta", { callId: ToolCallId; stream: ToolOutputStream; delta: string; bytes?: number; truncated?: boolean; sequence?: number }>
  | EventEnvelope<"tool.call_finished", { callId: ToolCallId; providerCallId?: string; status: "completed" | "failed" | "cancelled"; output?: string; error?: string; errorDetails?: PersistedErrorDetails; synthetic?: boolean }>;

/** Historical manual approvals. New tool execution uses automatic review metadata. */
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
    if (optionsValue.length === 1 || optionsValue.length > USER_INPUT_LIMITS.options) {
      throw new TypeError(`${field}.options must be empty for free text, or contain between 2 and ${USER_INPUT_LIMITS.options} items`);
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
