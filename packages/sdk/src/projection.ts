import type {
  ApprovalId,
  ApprovalDecisionAction,
  ApprovalScope,
  AssistantMessagePhase,
  ChiliEvent,
  DelegationPolicy,
  EventEnvelope,
  MessageId,
  Message,
  MessagePart,
  MessageRole,
  ModelMetadataPayload,
  ModelUsage,
  PartId,
  RuntimeInputQueue,
  RuntimeSessionStatus,
  SessionAgentMetadata,
  SessionId,
  ToolCallId,
  ToolCallStatus,
  ToolOutputStream,
  TurnId,
} from "@chili/protocol";
import { isTransientEvent } from "@chili/protocol";

type ToolPartStatus = Extract<MessagePart, { type: "tool_call" }>["status"];

export type ChatToolExecutionContext = NonNullable<Extract<MessagePart, { type: "tool_result" }>["executionContext"]>;

export interface ChiliRuntimeView {
  sessionIds: SessionId[];
  sessions: Record<string, RuntimeSessionView>;
  turnStatuses: Record<string, RuntimeTurnStatus>;
  turnStartedAt: Record<string, number>;
  messages: Record<string, RuntimeMessageView>;
  toolCalls: Record<string, RuntimeToolCallView>;
  approvals: Record<string, RuntimeApprovalView>;
  modelMetadataTurnIds: TurnId[];
  modelMetadataByTurn: Record<string, RuntimeModelMetadataView>;
  partIndex: Record<string, RuntimePartIndexEntry>;
  /** Confirmed completed parts reject obsolete streamed text. */
  committedPartIds: Record<string, true>;
  partStreamGaps: Record<string, RuntimePartStreamGap>;
  /** Stable durable/projection order for transcript rows across clock rollback. */
  transcriptOrder: Record<string, number>;
  nextTranscriptOrder: number;
  lastEventId?: string;
}

export type RuntimeTurnStatus = "running" | "completed" | "failed" | "cancelled";

export interface RuntimeSessionView {
  id: SessionId;
  /** A child Agent is this session, with its persisted identity and authority. */
  agent?: SessionAgentMetadata;
  inputQueue?: RuntimeInputQueue;
  cwd: string;
  title?: string;
  lifecycle: "active" | "archived";
  status: RuntimeSessionStatus;
  messageIds: MessageId[];
  toolCallIds: ToolCallId[];
  approvalIds: ApprovalId[];
  updatedAt: number;
  currentTurnId?: TurnId;
  statusReason?: string;
  /** Event that most recently established this session's projected lifecycle status. */
  statusEventId?: string;
  delegationPolicy?: DelegationPolicy;
  /** True once session.status_changed establishes the modern lifecycle source. */
  hasExplicitStatus?: boolean;
  retry?: RuntimeTurnRetryView;
}

/** Agent state derived from the same session and input events as ordinary chat. */
export interface RuntimeSessionAgentView extends SessionAgentMetadata {
  agentId: SessionId;
  sessionId: SessionId;
  state: "idle" | "running" | "paused";
  status: RuntimeSessionStatus;
  lifecycle: RuntimeSessionView["lifecycle"];
  inputQueue?: RuntimeInputQueue;
  updatedAt: number;
}

export interface RuntimeTurnRetryView {
  turnId: TurnId;
  attempt: number;
  delayMs: number;
  reason: string;
  scheduledAt: number;
}

export interface RuntimeMessageView {
  id: MessageId;
  sessionId: SessionId;
  role: MessageRole;
  parts: MessagePart[];
  createdAt: number;
  turnId?: TurnId;
  updatedAt?: number;
  lastTextAt?: number;
  completedAt?: number;
}

export interface RuntimeToolCallView {
  id: ToolCallId;
  parentCallId?: ToolCallId;
  status: ToolCallStatus | "completed" | "failed" | "cancelled";
  toolName: string;
  input: unknown;
  startedAt?: number;
  updatedAt: number;
  sessionId?: SessionId;
  turnId?: TurnId;
  output?: string;
  error?: string;
  synthetic?: boolean;
  metadata?: Record<string, unknown>;
  liveOutput?: RuntimeToolOutputDelta[];
}

export interface RuntimeToolOutputDelta {
  stream: ToolOutputStream;
  delta: string;
  time: number;
  bytes?: number;
  truncated?: boolean;
  /** Output was interrupted; missing transient text cannot be replayed. */
  gapBefore?: boolean;
  sequence?: number;
}

export interface RuntimeModelMetadataView extends ModelMetadataPayload {
  updatedAt: number;
  sessionId?: SessionId;
}

export interface RuntimeApprovalView {
  id: ApprovalId;
  permission: string;
  patterns: string[];
  maxApprovalScope?: ApprovalScope;
  status: "pending" | "resolved";
  createdAt: number;
  sessionId?: SessionId;
  callId?: ToolCallId;
  metadata?: Record<string, unknown>;
  decision?: ApprovalDecisionAction;
  feedback?: string;
  resolvedAt?: number;
}

export interface RuntimePartStreamGap {
  messageId: MessageId;
  expectedOffset: number;
  receivedOffset: number;
}

export interface RuntimePartIndexEntry {
  messageId: MessageId;
  index: number;
}

export interface ChatSessionInput {
  sessionId?: SessionId;
  limit?: number;
  generatedAt?: string;
  requireSession?: boolean;
}

export interface ChatSessionView {
  sessionId?: SessionId;
  cwd?: string;
  status: RuntimeSessionStatus | "unknown";
  statusReason?: string;
  /** Per-session status identity; unrelated sessions do not advance it. */
  statusEventId?: string;
  items: ChatTranscriptItem[];
  pendingApprovals: ChatApprovalRow[];
  activeTools: ChatToolCallRow[];
  generatedAt: string;
  latestModelMetadata?: ModelMetadataPayload;
  usageSummary?: ModelUsage;
  retry?: RuntimeTurnRetryView;
  lastEventId?: string;
}

export type ChatTranscriptItem =
  | ChatMessageRow
  | ChatToolCallRow
  | ChatApprovalRow;

export interface ChatMessageRow {
  id: MessageId;
  kind: "message";
  role: MessageRole;
  parts: ChatMessagePart[];
  createdAt: number;
  completedAt?: number;
}

export type ChatMessagePart =
  | { type: "text"; id: PartId; text: string; phase?: AssistantMessagePhase; completion?: Extract<MessagePart, { type: "text" }>["completion"]; rawText?: string; synthetic?: boolean }
  | { type: "image"; id: PartId; mimeType: string; filename?: string; sourcePath?: string; displayText?: string }
  | { type: "reasoning"; id: PartId; text: string; redacted?: boolean; completion?: Extract<MessagePart, { type: "reasoning" }>["completion"] }
  | { type: "tool_call"; id: PartId; callId: ToolCallId; toolName: string; status: ToolPartStatus; input?: unknown; displayStatus?: ChatToolDisplayStatus }
  | { type: "tool_result"; id: PartId; callId: ToolCallId; output: string; content?: Extract<MessagePart, { type: "tool_result" }>["content"]; error?: string; executionContext?: ChatToolExecutionContext; synthetic?: boolean }
  | { type: "summary"; id: PartId; text: string };

export type ChatToolDisplayStatus =
  | "queued"
  | "checking"
  | "waiting_permission"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled";

export interface ChatToolInputSummary {
  title: string;
  detail?: string;
  scope?: string;
  command?: string;
  path?: string;
  pattern?: string;
  diffSummary?: string;
}

type ChatToolInputSummaryDraft = {
  title: string;
  detail?: string | undefined;
  scope?: string | undefined;
  command?: string | undefined;
  path?: string | undefined;
  pattern?: string | undefined;
  diffSummary?: string | undefined;
};

export interface ChatToolCallRow {
  id: ToolCallId;
  parentCallId?: ToolCallId;
  kind: "tool";
  toolName: string;
  status: RuntimeToolCallView["status"];
  displayStatus: ChatToolDisplayStatus;
  waitingForApproval: boolean;
  updatedAt: number;
  inputSummary: ChatToolInputSummary;
  input?: unknown;
  output?: string;
  error?: string;
  executionContext?: ChatToolExecutionContext;
  liveOutput?: RuntimeToolOutputDelta[];
  sessionId?: SessionId;
  approvalId?: ApprovalId;
  approvalStatus?: RuntimeApprovalView["status"];
  approvalDecision?: RuntimeApprovalView["decision"];
}

export interface ChatApprovalRow {
  id: ApprovalId;
  kind: "approval";
  permission: string;
  patterns: string[];
  maxApprovalScope?: ApprovalScope;
  status: RuntimeApprovalView["status"];
  createdAt: number;
  sessionId?: SessionId;
  callId?: ToolCallId;
  toolName?: string;
  toolInput?: unknown;
  toolStatus?: RuntimeToolCallView["status"];
  toolDisplayStatus?: ChatToolDisplayStatus;
  inputSummary: ChatToolInputSummary;
  metadata?: Record<string, unknown>;
  decision?: RuntimeApprovalView["decision"];
  feedback?: string;
  resolvedAt?: number;
}

export function createRuntimeView(): ChiliRuntimeView {
  return {
    sessionIds: [],
    sessions: nullPrototypeRecord(),
    turnStatuses: nullPrototypeRecord(),
    turnStartedAt: nullPrototypeRecord(),
    messages: nullPrototypeRecord(),
    toolCalls: nullPrototypeRecord(),
    approvals: nullPrototypeRecord(),
    modelMetadataTurnIds: [],
    modelMetadataByTurn: nullPrototypeRecord(),
    partIndex: nullPrototypeRecord(),
    committedPartIds: nullPrototypeRecord(),
    partStreamGaps: nullPrototypeRecord(),
    transcriptOrder: nullPrototypeRecord(),
    nextTranscriptOrder: 0,
  };
}

function nullPrototypeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function reduceRuntimeEvents(
  events: Iterable<EventEnvelope>,
  view: ChiliRuntimeView = createRuntimeView(),
): ChiliRuntimeView {
  for (const event of events) {
    applyRuntimeEvent(view, event);
  }
  return view;
}

/**
 * A durable cursor restores state, but does not restore transient tool output.
 * Preserve the available preview and make that gap visible, even if no further
 * output arrives. Final durable tool results remain authoritative.
 */
export function markRuntimeOutputGap(view: ChiliRuntimeView): void {
  for (const toolCall of Object.values(view.toolCalls)) {
    if (isTerminalToolStatus(toolCall.status)) continue;
    const last = toolCall.liveOutput?.at(-1);
    if (last?.gapBefore && last.delta === "") continue;
    appendToolOutputDelta(toolCall, {
      stream: "stdout",
      delta: "",
      time: toolCall.updatedAt,
      truncated: true,
      gapBefore: true,
    });
  }
}

export function applyRuntimeEvent(view: ChiliRuntimeView, inputEvent: EventEnvelope): ChiliRuntimeView {
  normalizeRuntimeViewIndexes(view);
  if (!isTransientEvent(inputEvent)) view.lastEventId = inputEvent.id;

  const event = inputEvent as ChiliEvent;
  switch (event.type) {
    case "session.created": {
      const sessionId = matchingEnvelopeSessionId(event.sessionId, event.payload?.sessionId);
      if (!sessionId) break;
      const session = upsertSession(view, sessionId, event.time);
      session.cwd = event.payload.cwd;
      if (event.payload.agent) session.agent = structuredClone(event.payload.agent);
      session.lifecycle = "active";
      session.updatedAt = event.time;
      break;
    }
    case "session.input_queue_changed": {
      const queue = event.payload;
      const sessionId = matchingEnvelopeSessionId(event.sessionId, queue?.sessionId);
      if (!sessionId) break;
      const session = upsertSession(view, sessionId, event.time);
      if (session.inputQueue && queue.revision <= session.inputQueue.revision) break;
      session.inputQueue = structuredClone(queue);
      session.updatedAt = event.time;
      break;
    }
    case "session.renamed": {
      const sessionId = matchingEnvelopeSessionId(event.sessionId, event.payload?.sessionId);
      if (!sessionId) break;
      const session = upsertSession(view, sessionId, event.time);
      session.title = event.payload.title;
      session.updatedAt = event.time;
      break;
    }
    case "session.status_changed": {
      const sessionId = matchingEnvelopeSessionId(event.sessionId, event.payload?.sessionId);
      if (!sessionId) break;
      const session = upsertSession(view, sessionId, event.time);
      session.hasExplicitStatus = true;
      setSessionStatus(session, event.payload.status, event.payload.reason);
      session.statusEventId = event.id;
      clearSessionRetry(view, sessionId, event.payload.turnId);
      session.updatedAt = event.time;
      assignOptional(session, "currentTurnId", event.payload.turnId);
      if (event.payload.turnId && event.payload.status === "cancelled") {
        view.turnStatuses[event.payload.turnId] = "cancelled";
      }
      break;
    }
    case "session.delegation_changed": {
      const sessionId = matchingEnvelopeSessionId(event.sessionId, event.payload?.sessionId);
      if (!sessionId) break;
      const session = upsertSession(view, sessionId, event.time);
      session.delegationPolicy = event.payload.policy;
      session.updatedAt = event.time;
      break;
    }
    case "session.archived": {
      const sessionId = matchingEnvelopeSessionId(event.sessionId, event.payload?.sessionId);
      if (!sessionId) break;
      const session = upsertSession(view, sessionId, event.time);
      session.lifecycle = "archived";
      session.updatedAt = event.time;
      break;
    }
    case "turn.started": {
      view.turnStatuses[event.payload.turnId] = "running";
      view.turnStartedAt[event.payload.turnId] = event.time;
      if (event.sessionId) {
        const session = upsertSession(view, event.sessionId, event.time);
        if (!session.hasExplicitStatus) {
          setSessionStatus(session, "running");
          session.statusEventId = event.id;
        }
        clearSessionRetry(view, event.sessionId, event.payload.turnId);
        session.currentTurnId = event.payload.turnId;
        session.updatedAt = event.time;
      }
      break;
    }
    case "turn.completed": {
      view.turnStatuses[event.payload.turnId] = event.payload.status;
      if (event.sessionId) {
        const session = upsertSession(view, event.sessionId, event.time);
        const isCurrentTurn = session.currentTurnId === undefined || session.currentTurnId === event.payload.turnId;
        if (!session.hasExplicitStatus) {
          setSessionStatus(session, event.payload.status === "completed" ? "idle" : event.payload.status);
          session.statusEventId = event.id;
        } else if (
          isCurrentTurn
          && (event.payload.status === "failed" || event.payload.status === "cancelled")
          && !isTerminalSessionStatus(session.status)
        ) {
          // A turn terminal event is persisted before the matching session
          // terminal event. Preserve the session event as the normal source of
          // truth, but fail closed if a crash leaves only the turn terminal.
          setSessionStatus(session, event.payload.status);
          session.statusEventId = event.id;
        }
        clearSessionRetry(view, event.sessionId, event.payload.turnId);
        if (isCurrentTurn) session.currentTurnId = event.payload.turnId;
        session.updatedAt = event.time;
      }
      break;
    }
    case "turn.retry_scheduled": {
      if (event.sessionId) {
        const session = upsertSession(view, event.sessionId, event.time);
        session.retry = {
          turnId: event.payload.turnId,
          attempt: event.payload.attempt,
          delayMs: event.payload.delayMs,
          reason: event.payload.reason,
          scheduledAt: event.time,
        };
        session.updatedAt = event.time;
      }
      break;
    }
    case "turn.model_metadata": {
      const existing = view.modelMetadataByTurn[event.payload.turnId];
      if (!existing) {
        view.modelMetadataTurnIds.push(event.payload.turnId);
      }
      view.modelMetadataByTurn[event.payload.turnId] = runtimeModelMetadata(event.payload, event.time, event.sessionId, existing);
      const sessionId = event.sessionId ?? existing?.sessionId;
      if (sessionId) {
        clearSessionRetry(view, sessionId, event.payload.turnId);
        touchSession(view, sessionId, event.time);
      }
      break;
    }
    case "message.created": {
      if (!event.sessionId) break;
      const session = upsertSession(view, event.sessionId, event.time);
      if (!view.messages[event.payload.messageId]) {
        const message: RuntimeMessageView = {
          id: event.payload.messageId,
          sessionId: event.sessionId,
          role: event.payload.role,
          parts: [],
          createdAt: event.time,
          updatedAt: event.time,
        };
        assignOptional(message, "turnId", event.payload.turnId);
        view.messages[message.id] = message;
        assignTranscriptOrder(view, "message", message.id);
        session.messageIds.push(message.id);
      } else {
        const message = view.messages[event.payload.messageId]!;
        if (message.sessionId !== event.sessionId) break;
        message.role = event.payload.role;
        message.createdAt = event.time;
        assignOptional(message, "turnId", event.payload.turnId);
      }
      session.updatedAt = Math.max(session.updatedAt, event.time);
      break;
    }
    case "message.part_added": {
      const message = view.messages[event.payload.messageId];
      const part = event.payload.part;
      if (!message || !partBelongsToMessage(part, message, event.sessionId)) break;
      const existing = message.parts.find((item) => item.id === part.id);
      if (view.committedPartIds[part.id]) break;
      // A delayed creation/history event cannot erase a live prefix.
      if (isStreamingTextPart(existing) && isStreamingTextPart(part)
        && !part.completion && existing.text.length > part.text.length) break;
      replaceRuntimePart(view, message, part, event.time);
      if (isStreamingTextPart(part) && part.completion) view.committedPartIds[part.id] = true;
      break;
    }
    case "message.part_committed": {
      const message = ensureStreamMessage(view, event);
      if (!message || !partBelongsToMessage(event.payload.part, message, event.sessionId)) break;
      replaceRuntimePart(view, message, event.payload.part, event.time);
      view.committedPartIds[event.payload.part.id] = true;
      delete view.partStreamGaps[event.payload.part.id];
      break;
    }
    case "message.part_stream_snapshot": {
      const message = ensureStreamMessage(view, event);
      const part = event.payload.part;
      if (!message || !partBelongsToMessage(part, message, event.sessionId) || view.committedPartIds[part.id]) break;
      const existing = message.parts.find((item) => item.id === part.id);
      if (isStreamingTextPart(existing) && existing.text.length > part.text.length) break;
      replaceRuntimePart(view, message, part, event.time);
      delete view.partStreamGaps[part.id];
      break;
    }
    case "message.part_stream_delta": {
      const message = ensureStreamMessage(view, event);
      if (!message) break;
      const { partId, partType, offset, delta, ordinal, phase, redacted } = event.payload;
      if (view.committedPartIds[partId]) break;
      let part = message.parts.find((item) => item.id === partId);
      if (part && (!isStreamingTextPart(part) || part.type !== partType || part.completion)) break;
      const length = isStreamingTextPart(part) ? part.text.length : 0;
      if (offset > length) {
        view.partStreamGaps[partId] = { messageId: message.id, expectedOffset: length, receivedOffset: offset };
        break;
      }
      if (!part) {
        const identity = { id: partId as PartId, messageId: message.id, sessionId: message.sessionId,
          ...(ordinal === undefined ? {} : { ordinal }) };
        part = partType === "text"
          ? { ...identity, type: "text", text: "", ...(phase === undefined ? {} : { phase }) }
          : { ...identity, type: "reasoning", text: "", ...(redacted === undefined ? {} : { redacted }) };
        replaceRuntimePart(view, message, part, event.time);
        part = message.parts[view.partIndex[partId]!.index];
      }
      if (!isStreamingTextPart(part)) break;
      // An overlapping replay contributes only the suffix not already in the snapshot.
      part.text += delta.slice(Math.max(0, length - offset));
      if (part.type === "text" && phase !== undefined) part.phase = phase;
      if (part.type === "reasoning" && redacted !== undefined) part.redacted = redacted;
      message.updatedAt = event.time;
      if (part.type === "text" && part.text.trim()) message.lastTextAt = event.time;
      if (message.turnId) clearSessionRetry(view, message.sessionId, message.turnId);
      touchSession(view, message.sessionId, event.time);
      break;
    }
    case "message.part_delta": {
      const entry = view.partIndex[event.payload.partId];
      const message = entry ? view.messages[entry.messageId] : undefined;
      if (message?.turnId) clearSessionRetry(view, message.sessionId, message.turnId);
      applyPartDelta(view, event.payload.partId as PartId, event.payload.field, event.payload.delta);
      if (message && entry) {
        message.updatedAt = event.time;
        const part = message.parts[entry.index];
        if (part?.type === "text" && (part.displayText ?? part.text).trim().length > 0) message.lastTextAt = event.time;
      }
      if (event.sessionId) touchSession(view, event.sessionId, event.time);
      break;
    }
    case "tool.call_started": {
      if (event.sessionId) clearSessionRetry(view, event.sessionId, event.payload.turnId);
      // Transient output can arrive before its durable start is replayed. Fill
      // in that existing call instead of replacing its preview or terminal state.
      const toolCall = upsertToolCall(view, event.payload.callId, event.time);
      if (!isTerminalToolStatus(toolCall.status)) toolCall.status = "running";
      toolCall.toolName = event.payload.toolName;
      toolCall.input = event.payload.input;
      toolCall.startedAt ??= event.time;
      toolCall.updatedAt = Math.max(toolCall.updatedAt, event.time);
      assignOptional(toolCall, "sessionId", event.sessionId);
      assignOptional(toolCall, "turnId", event.payload.turnId);
      assignOptional(toolCall, "parentCallId", event.payload.parentCallId);
      view.toolCalls[toolCall.id] = toolCall;
      assignTranscriptOrder(view, "tool", toolCall.id);
      linkToolCallToSession(view, toolCall, event.time);
      setToolPartStatus(view, event.payload.callId, toolCall.status);
      break;
    }
    case "tool.call_updated": {
      const toolCall = upsertToolCall(view, event.payload.callId, event.time);
      toolCall.status = event.payload.status;
      if (event.payload.toolName !== undefined) toolCall.toolName = event.payload.toolName;
      if (hasOwn(event.payload, "input")) toolCall.input = event.payload.input;
      assignOptional(toolCall, "sessionId", event.sessionId);
      assignOptional(toolCall, "metadata", event.payload.metadata);
      toolCall.updatedAt = event.time;
      linkToolCallToSession(view, toolCall, event.time);
      setToolPartStatus(view, event.payload.callId, event.payload.status);
      if (event.payload.status === "waiting_for_approval" && toolCall.sessionId) {
        const session = upsertSession(view, toolCall.sessionId, event.time);
        if (!session.hasExplicitStatus) {
          setSessionStatus(session, "waiting_for_approval");
          session.statusEventId = event.id;
        }
        session.updatedAt = event.time;
      } else if (
        event.payload.status === "running"
        && toolCall.sessionId
        && !hasPendingApprovalForSession(view, toolCall.sessionId)
      ) {
        const session = upsertSession(view, toolCall.sessionId, event.time);
        if (!session.hasExplicitStatus && session.status === "waiting_for_approval") {
          setSessionStatus(session, "running");
          session.statusEventId = event.id;
          session.updatedAt = event.time;
        }
      }
      break;
    }
    case "tool.output_delta": {
      const toolCall = upsertToolCall(view, event.payload.callId, event.time);
      appendToolOutputDelta(toolCall, {
        stream: event.payload.stream,
        delta: event.payload.delta,
        time: event.time,
        ...(event.payload.bytes === undefined ? {} : { bytes: event.payload.bytes }),
        ...(event.payload.truncated === undefined ? {} : { truncated: event.payload.truncated }),
        ...(event.payload.sequence === undefined ? {} : { sequence: event.payload.sequence }),
      });
      assignOptional(toolCall, "sessionId", event.sessionId);
      toolCall.updatedAt = event.time;
      linkToolCallToSession(view, toolCall, event.time);
      break;
    }
    case "tool.call_finished": {
      const toolCall = upsertToolCall(view, event.payload.callId, event.time);
      toolCall.status = event.payload.status;
      toolCall.updatedAt = event.time;
      assignOptional(toolCall, "output", event.payload.output);
      assignOptional(toolCall, "error", event.payload.error);
      assignOptional(toolCall, "synthetic", event.payload.synthetic);
      setToolPartStatus(view, event.payload.callId, event.payload.status);
      if (toolCall.sessionId) touchSession(view, toolCall.sessionId, event.time);
      break;
    }
    case "approval.requested": {
      const approval: RuntimeApprovalView = {
        id: event.payload.approvalId,
        permission: event.payload.permission,
        patterns: event.payload.patterns,
        status: "pending",
        createdAt: event.time,
      };
      assignOptional(approval, "sessionId", event.sessionId);
      assignOptional(approval, "callId", event.payload.callId);
      assignOptional(approval, "maxApprovalScope", event.payload.maxApprovalScope);
      assignOptional(approval, "metadata", event.payload.metadata);
      view.approvals[approval.id] = approval;
      assignTranscriptOrder(view, "approval", approval.id);
      linkApprovalToSession(view, approval, event.time, event.id);
      break;
    }
    case "approval.resolved": {
      const approval = view.approvals[event.payload.approvalId];
      if (!approval) break;
      approval.status = "resolved";
      approval.decision = event.payload.decision;
      approval.resolvedAt = event.time;
      assignOptional(approval, "feedback", event.payload.feedback);
      if (approval.sessionId) touchSession(view, approval.sessionId, event.time);
      break;
    }
  }

  return view;
}

/** Full history is projection data; it never advances the live event cursor. */
export function hydrateRuntimeMessages(view: ChiliRuntimeView, messages: readonly Message[]): ChiliRuntimeView {
  normalizeRuntimeViewIndexes(view);
  const addedMessages = new Set<string>();
  for (const source of messages) {
    const session = upsertSession(view, source.sessionId, source.createdAt);
    let message = view.messages[source.id];
    if (message && message.sessionId !== source.sessionId) continue;
    if (!message) {
      message = { id: source.id, sessionId: source.sessionId, role: source.role, parts: [], createdAt: source.createdAt,
        ...(source.turnId === undefined ? {} : { turnId: source.turnId }) };
      view.messages[source.id] = message;
      session.messageIds.push(source.id);
      addedMessages.add(source.id);
    }
    for (const part of source.parts) {
      if (!partBelongsToMessage(part, message, source.sessionId)) continue;
      const existing = message.parts.find((item) => item.id === part.id);
      // A read started before commit may complete after it. Its stale body cannot win.
      if (isStreamingTextPart(existing) && isStreamingTextPart(part)) {
        if (view.committedPartIds[part.id] && existing.text.length >= part.text.length) continue;
        if (existing.text.length > part.text.length) continue;
      }
      replaceRuntimePart(view, message, part, message.updatedAt ?? source.createdAt, false);
      if (isStreamingTextPart(part)) {
        if (part.completion) view.committedPartIds[part.id] = true;
        delete view.partStreamGaps[part.id];
      }
    }
  }
  // Full history is ordered by storage, including when the system clock moved
  // backwards. Place newly discovered older messages before existing anchors.
  let previousOrder: number | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const source = messages[index]!;
    if (!addedMessages.has(source.id)) {
      previousOrder = view.transcriptOrder[transcriptOrderKey("message", source.id)] ?? previousOrder;
      continue;
    }
    let end = index;
    while (end < messages.length && addedMessages.has(messages[end]!.id)) end += 1;
    const nextSource = messages[end];
    const nextOrder = nextSource ? view.transcriptOrder[transcriptOrderKey("message", nextSource.id)] : undefined;
    const count = end - index;
    const lower = previousOrder ?? (nextOrder === undefined ? view.nextTranscriptOrder - 1 : nextOrder - count - 1);
    const upper = nextOrder ?? Math.max(view.nextTranscriptOrder, lower + count + 1);
    for (let offset = 0; offset < count; offset += 1) {
      const id = messages[index + offset]!.id;
      view.transcriptOrder[transcriptOrderKey("message", id)] = lower + (upper - lower) * (offset + 1) / (count + 1);
    }
    view.nextTranscriptOrder = Math.max(view.nextTranscriptOrder, Math.ceil(upper));
    previousOrder = view.transcriptOrder[transcriptOrderKey("message", messages[end - 1]!.id)];
    index = end - 1;
  }
  return view;
}

export function hasRuntimePartStreamGap(view: ChiliRuntimeView): boolean {
  return Object.keys(view.partStreamGaps ?? {}).length > 0;
}

function isStreamingTextPart(part: MessagePart | undefined): part is Extract<MessagePart, { type: "text" | "reasoning" }> {
  return part?.type === "text" || part?.type === "reasoning";
}

function partBelongsToMessage(part: MessagePart, message: RuntimeMessageView, sessionId: SessionId | undefined): boolean {
  return part.messageId === message.id && part.sessionId === message.sessionId
    && (sessionId === undefined || sessionId === message.sessionId);
}

function ensureStreamMessage(
  view: ChiliRuntimeView,
  event: Extract<ChiliEvent, { type: "message.part_stream_delta" | "message.part_stream_snapshot" | "message.part_committed" }>,
): RuntimeMessageView | undefined {
  if ("part" in event.payload && (event.payload.part.messageId !== event.payload.messageId
    || (event.sessionId !== undefined && event.payload.part.sessionId !== event.sessionId))) return undefined;
  let message = view.messages[event.payload.messageId];
  if (message) return event.sessionId === undefined || message.sessionId === event.sessionId ? message : undefined;
  if (!event.sessionId) return undefined;
  message = { id: event.payload.messageId, sessionId: event.sessionId, role: "assistant", parts: [],
    createdAt: event.time, updatedAt: event.time };
  view.messages[message.id] = message;
  upsertSession(view, event.sessionId, event.time).messageIds.push(message.id);
  assignTranscriptOrder(view, "message", message.id);
  return message;
}

function replaceRuntimePart(view: ChiliRuntimeView, message: RuntimeMessageView, source: MessagePart, time: number, live = true): void {
  const part = structuredClone(source);
  const existingIndex = message.parts.findIndex((item) => item.id === part.id);
  const previousOrdinal = message.parts[existingIndex]?.ordinal;
  if (part.ordinal === undefined && previousOrdinal !== undefined) part.ordinal = previousOrdinal;
  if (existingIndex >= 0) message.parts[existingIndex] = part;
  else message.parts.push(part);
  message.parts.sort((left, right) => (left.ordinal ?? Number.MAX_SAFE_INTEGER) - (right.ordinal ?? Number.MAX_SAFE_INTEGER));
  for (const [index, item] of message.parts.entries()) view.partIndex[item.id] = { messageId: message.id, index };
  if (live) {
    if (message.turnId) clearSessionRetry(view, message.sessionId, message.turnId);
    message.updatedAt = time;
    if (part.type === "text" && (part.displayText ?? part.text).trim()) message.lastTextAt = time;
    touchSession(view, message.sessionId, time);
  }
}

function normalizeRuntimeViewIndexes(view: ChiliRuntimeView): void {
  view.sessions = nullPrototypeIndex(view.sessions);
  view.turnStatuses = nullPrototypeIndex(view.turnStatuses);
  view.turnStartedAt = nullPrototypeIndex(view.turnStartedAt);
  view.messages = nullPrototypeIndex(view.messages);
  view.toolCalls = nullPrototypeIndex(view.toolCalls);
  view.approvals = nullPrototypeIndex(view.approvals);
  view.modelMetadataByTurn = nullPrototypeIndex(view.modelMetadataByTurn);
  view.partIndex = nullPrototypeIndex(view.partIndex);
  view.committedPartIds = nullPrototypeIndex(view.committedPartIds ?? {});
  view.partStreamGaps = nullPrototypeIndex(view.partStreamGaps ?? {});
  view.transcriptOrder = nullPrototypeIndex(view.transcriptOrder ?? {});
  if (!Number.isSafeInteger(view.nextTranscriptOrder) || view.nextTranscriptOrder < 0) {
    let nextOrder = 0;
    for (const order of Object.values(view.transcriptOrder)) {
      if (Number.isSafeInteger(order) && order >= nextOrder) nextOrder = order + 1;
    }
    view.nextTranscriptOrder = nextOrder;
  }
}

function nullPrototypeIndex<T>(index: Record<string, T>): Record<string, T> {
  if (Object.getPrototypeOf(index) === null) return index;
  return Object.assign(nullPrototypeRecord<T>(), index);
}

/** With a parent ID, return its direct children; omit it to inspect all known Agents. */
export function runtimeSessionAgents(view: ChiliRuntimeView, parentSessionId?: SessionId): RuntimeSessionAgentView[] {
  return view.sessionIds.flatMap((sessionId) => {
    const session = view.sessions[sessionId];
    const agent = session?.agent;
    if (!session || !agent || (parentSessionId && agent.parentSessionId !== parentSessionId)) return [];
    const state = session.inputQueue?.paused
      ? "paused"
      : session.status === "running" || session.status === "waiting_for_approval" || session.status === "cancelling"
        ? "running"
        : "idle";
    const result: RuntimeSessionAgentView = {
      ...structuredClone(agent),
      agentId: session.id,
      sessionId: session.id,
      state,
      status: session.status,
      lifecycle: session.lifecycle,
      updatedAt: session.updatedAt,
    };
    if (session.inputQueue) result.inputQueue = structuredClone(session.inputQueue);
    return [result];
  });
}

export function sessionMessages(view: ChiliRuntimeView, sessionId: SessionId): RuntimeMessageView[] {
  const session = view.sessions[sessionId];
  if (!session) return [];
  return session.messageIds.flatMap((messageId) => {
    const message = view.messages[messageId];
    return message ? [message] : [];
  });
}

export function pendingApprovals(view: ChiliRuntimeView, sessionId?: SessionId): RuntimeApprovalView[] {
  return Object.values(view.approvals).filter((approval) => {
    if (approval.status !== "pending") return false;
    return sessionId ? approval.sessionId === sessionId : true;
  });
}

export function chatSessionView(view: ChiliRuntimeView, input: ChatSessionInput = {}): ChatSessionView {
  const limit = Math.max(1, input.limit ?? 80);
  const session = input.sessionId ? view.sessions[input.sessionId] : input.requireSession ? undefined : latestSession(view);
  const sessionId = input.sessionId ?? session?.id;
  const hiddenTurnIds = session ? outputFreeCancelledTurnIds(view, session) : new Set<string>();
  const messages = session
    ? session.messageIds.flatMap((messageId) => {
      const message = view.messages[messageId];
      if (!message || (message.turnId && hiddenTurnIds.has(message.turnId))) return [];
      return [chatMessageRow(message)];
    })
    : [];
  const executionContexts = session
    ? toolResultExecutionContexts(view, session)
    : new Map<ToolCallId, ChatToolExecutionContext>();
  const tools = session
    ? session.toolCallIds.flatMap((callId) => {
      const toolCall = view.toolCalls[callId];
      if (!toolCall || (toolCall.turnId && hiddenTurnIds.has(toolCall.turnId))) return [];
      return [chatToolCallRow(view, toolCall, executionContexts.get(callId))];
    })
    : [];
  const approvals = session
    ? session.approvalIds.flatMap((approvalId) => {
      const approval = view.approvals[approvalId];
      if (!approval) return [];
      const turnId = approval.callId ? view.toolCalls[approval.callId]?.turnId : undefined;
      if (turnId && hiddenTurnIds.has(turnId)) return [];
      return [chatApprovalRow(view, approval)];
    })
    : [];
  const modelMetadata = session
    ? modelMetadataForSession(view, session.id)
    : [];
  const latestModelMetadata = modelMetadata.at(-1);
  const usageSummary = modelUsageSummary(modelMetadata);
  const items = [...messages, ...tools, ...approvals]
    .sort((left, right) => (
      chatTranscriptOrder(view, left) - chatTranscriptOrder(view, right)
      || chatItemTime(left) - chatItemTime(right)
    ))
    .slice(-limit);
  const pendingApprovalRows = approvals.filter((approval) => approval.status === "pending");
  const effectiveStatus = session?.status === "running"
    && (pendingApprovalRows.length > 0
      || tools.some((tool) => tool.status === "waiting_for_approval"))
    ? "waiting_for_approval"
    : session?.status ?? "unknown";
  const output: ChatSessionView = {
    status: effectiveStatus,
    items,
    pendingApprovals: pendingApprovalRows,
    activeTools: tools.filter((tool) => tool.status === "running" || tool.status === "waiting_for_approval" || tool.status === "validating"),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
  assignOptional(output, "sessionId", sessionId);
  assignOptional(output, "cwd", session?.cwd || undefined);
  assignOptional(output, "statusReason", session?.statusReason);
  assignOptional(output, "statusEventId", session?.statusEventId);
  assignOptional(output, "latestModelMetadata", latestModelMetadata ? chatModelMetadata(latestModelMetadata) : undefined);
  assignOptional(output, "usageSummary", usageSummary);
  assignOptional(output, "retry", session?.retry ? { ...session.retry } : undefined);
  assignOptional(output, "lastEventId", view.lastEventId);
  return output;
}

function outputFreeCancelledTurnIds(
  view: ChiliRuntimeView,
  session: RuntimeSessionView,
): Set<string> {
  const cancelledTurnIds = new Set(
    Object.entries(view.turnStatuses)
      .filter(([, status]) => status === "cancelled")
      .map(([turnId]) => turnId),
  );
  if (session.status === "cancelled" && session.currentTurnId) {
    cancelledTurnIds.add(session.currentTurnId);
  }
  if (cancelledTurnIds.size === 0) return cancelledTurnIds;

  for (const messageId of session.messageIds) {
    const message = view.messages[messageId];
    if (
      !message?.turnId
      || message.role === "user"
      || !cancelledTurnIds.has(message.turnId)
    ) {
      continue;
    }
    if (message.parts.some(isMeaningfulAssistantOutput)) cancelledTurnIds.delete(message.turnId);
  }
  for (const callId of session.toolCallIds) {
    const toolCall = view.toolCalls[callId];
    if (toolCall?.turnId) {
      cancelledTurnIds.delete(toolCall.turnId);
    }
  }
  return cancelledTurnIds;
}

function isMeaningfulAssistantOutput(part: MessagePart): boolean {
  if (part.type === "reasoning") return false;
  if (part.type === "text") return part.text.trim().length > 0;
  if (part.type === "tool_result") {
    return (
      part.output.trim().length > 0
      || (part.error?.trim().length ?? 0) > 0
      || (part.content?.length ?? 0) > 0
      || (part.artifactIds?.length ?? 0) > 0
    );
  }
  return true;
}

function latestSession(view: ChiliRuntimeView): RuntimeSessionView | undefined {
  for (let index = view.sessionIds.length - 1; index >= 0; index -= 1) {
    const session = view.sessions[view.sessionIds[index] ?? ""];
    if (session) return session;
  }
  return undefined;
}

function runtimeModelMetadata(
  payload: ModelMetadataPayload,
  updatedAt: number,
  sessionId: SessionId | undefined,
  existing: RuntimeModelMetadataView | undefined,
): RuntimeModelMetadataView {
  const output: RuntimeModelMetadataView = {
    turnId: payload.turnId,
    updatedAt,
  };
  assignOptional(output, "provider", payload.provider ?? existing?.provider);
  assignOptional(output, "model", payload.model ?? existing?.model);
  assignOptional(output, "responseId", payload.responseId ?? existing?.responseId);
  assignOptional(output, "usage", payload.usage ? cloneModelUsage(payload.usage) : existing?.usage ? cloneModelUsage(existing.usage) : undefined);
  assignOptional(output, "contextWindowTokens", payload.contextWindowTokens ?? existing?.contextWindowTokens);
  assignOptional(output, "maxOutputTokens", payload.maxOutputTokens ?? existing?.maxOutputTokens);
  assignOptional(output, "sessionId", sessionId ?? existing?.sessionId);
  return output;
}

function chatModelMetadata(metadata: RuntimeModelMetadataView): ModelMetadataPayload {
  const output: ModelMetadataPayload = {
    turnId: metadata.turnId,
  };
  assignOptional(output, "provider", metadata.provider);
  assignOptional(output, "model", metadata.model);
  assignOptional(output, "responseId", metadata.responseId);
  assignOptional(output, "usage", metadata.usage ? cloneModelUsage(metadata.usage) : undefined);
  assignOptional(output, "contextWindowTokens", metadata.contextWindowTokens);
  assignOptional(output, "maxOutputTokens", metadata.maxOutputTokens);
  return output;
}

function modelMetadataForSession(
  view: ChiliRuntimeView,
  sessionId: SessionId,
): RuntimeModelMetadataView[] {
  return view.modelMetadataTurnIds
    .flatMap((turnId) => {
      const metadata = view.modelMetadataByTurn[turnId];
      return metadata ? [metadata] : [];
    })
    .filter((metadata) => metadata.sessionId === sessionId)
    .sort((left, right) => left.updatedAt - right.updatedAt);
}

function modelUsageSummary(metadata: readonly RuntimeModelMetadataView[]): ModelUsage | undefined {
  const summary: ModelUsage = {};
  let hasUsage = false;

  for (const item of metadata) {
    const usage = item.usage;
    if (!usage) continue;
    hasUsage = addUsageField(summary, "inputTokens", usage.inputTokens) || hasUsage;
    hasUsage = addUsageField(summary, "outputTokens", usage.outputTokens) || hasUsage;
    hasUsage = addUsageField(summary, "cacheReadInputTokens", usage.cacheReadInputTokens) || hasUsage;
    hasUsage = addUsageField(summary, "cacheCreationInputTokens", usage.cacheCreationInputTokens) || hasUsage;
    const total = usage.totalTokens ?? usageTokenTotal(usage);
    hasUsage = addUsageField(summary, "totalTokens", total) || hasUsage;
  }

  return hasUsage ? summary : undefined;
}

function usageTokenTotal(usage: ModelUsage): number | undefined {
  const parts = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadInputTokens,
    usage.cacheCreationInputTokens,
  ].filter(isFiniteNumber);
  if (parts.length === 0) return undefined;
  return parts.reduce((total, value) => total + value, 0);
}

function addUsageField(summary: ModelUsage, field: keyof Omit<ModelUsage, "raw">, value: number | undefined): boolean {
  if (!isFiniteNumber(value)) return false;
  summary[field] = (summary[field] ?? 0) + value;
  return true;
}

function cloneModelUsage(usage: ModelUsage): ModelUsage {
  const output: ModelUsage = {};
  assignOptional(output, "inputTokens", usage.inputTokens);
  assignOptional(output, "outputTokens", usage.outputTokens);
  assignOptional(output, "cacheReadInputTokens", usage.cacheReadInputTokens);
  assignOptional(output, "cacheCreationInputTokens", usage.cacheCreationInputTokens);
  assignOptional(output, "totalTokens", usage.totalTokens);
  assignOptional(output, "raw", usage.raw);
  return output;
}

function matchingEnvelopeSessionId(
  envelopeSessionId: SessionId | undefined,
  duplicateSessionId: unknown,
): SessionId | undefined {
  return envelopeSessionId && duplicateSessionId === envelopeSessionId ? envelopeSessionId : undefined;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function chatMessageRow(message: RuntimeMessageView): ChatMessageRow {
  const row: ChatMessageRow = {
    id: message.id,
    kind: "message",
    role: message.role,
    parts: message.parts.map((part) => chatMessagePart(part)),
    createdAt: message.createdAt,
  };
  assignOptional(row, "completedAt", message.completedAt);
  return row;
}

function chatMessagePart(part: MessagePart): ChatMessagePart {
  if (part.type === "text") {
    const output: ChatMessagePart = { type: "text", id: part.id, text: part.displayText ?? part.text };
    if (part.displayText && part.displayText !== part.text) output.rawText = part.text;
    assignOptional(output, "phase", part.phase);
    assignOptional(output, "completion", part.completion);
    assignOptional(output, "synthetic", part.synthetic);
    return output;
  }
  if (part.type === "image") {
    const output: ChatMessagePart = { type: "image", id: part.id, mimeType: part.mimeType };
    assignOptional(output, "filename", part.filename);
    assignOptional(output, "sourcePath", part.sourcePath);
    assignOptional(output, "displayText", part.displayText);
    return output;
  }
  if (part.type === "reasoning") {
    const output: ChatMessagePart = { type: "reasoning", id: part.id, text: part.text };
    assignOptional(output, "redacted", part.redacted);
    assignOptional(output, "completion", part.completion);
    return output;
  }
  if (part.type === "tool_call") {
    return {
      type: "tool_call",
      id: part.id,
      callId: part.callId,
      toolName: part.toolName,
      status: part.status,
      input: part.input,
      displayStatus: chatToolDisplayStatus(part.status),
    };
  }
  if (part.type === "tool_result") {
    const output: ChatMessagePart = { type: "tool_result", id: part.id, callId: part.callId, output: part.output };
    assignOptional(output, "content", part.content);
    assignOptional(output, "error", part.error);
    assignOptional(output, "executionContext", chatToolExecutionContext(part.executionContext));
    assignOptional(output, "synthetic", part.synthetic);
    return output;
  }
  if (part.type === "patch") return { type: "summary", id: part.id, text: `patch: ${part.files.join(", ")}` };
  if (part.type === "artifact") return { type: "summary", id: part.id, text: `artifact: ${part.artifactId}` };
  if (part.type === "compaction") return { type: "summary", id: part.id, text: part.summary ?? `compaction: ${part.reason}` };
  return { type: "summary", id: part.id, text: `agent handoff: ${part.agentPath}` };
}

function chatToolCallRow(
  view: ChiliRuntimeView,
  toolCall: RuntimeToolCallView,
  executionContext: ChatToolExecutionContext | undefined,
): ChatToolCallRow {
  const linkedApprovals = approvalsForToolCall(view, toolCall.id);
  const pendingApproval = linkedApprovals.find((approval) => approval.status === "pending");
  const latestApproval = latestApprovalForToolCall(linkedApprovals);
  const status = pendingApproval ? "waiting_for_approval" : toolCall.status;
  const row: ChatToolCallRow = {
    id: toolCall.id,
    kind: "tool",
    toolName: toolCall.toolName,
    status,
    displayStatus: status === "completed" && chatToolExecutionFailed(executionContext)
      ? "failed"
      : chatToolDisplayStatus(status, latestApproval),
    waitingForApproval: Boolean(pendingApproval),
    updatedAt: toolCall.updatedAt,
    inputSummary: chatToolInputSummary(toolCall.toolName, toolCall.input, pendingApproval?.patterns ?? latestApproval?.patterns ?? []),
  };
  assignOptional(row, "input", toolCall.input);
  assignOptional(row, "parentCallId", toolCall.parentCallId);
  assignOptional(row, "output", toolCall.output);
  assignOptional(row, "error", toolCall.error);
  assignOptional(row, "executionContext", executionContext);
  assignOptional(row, "liveOutput", toolCall.liveOutput ? toolCall.liveOutput.map((delta) => ({ ...delta })) : undefined);
  assignOptional(row, "sessionId", toolCall.sessionId);
  assignOptional(row, "approvalId", pendingApproval?.id ?? latestApproval?.id);
  assignOptional(row, "approvalStatus", pendingApproval?.status ?? latestApproval?.status);
  assignOptional(row, "approvalDecision", latestApproval?.decision);
  return row;
}

function chatToolExecutionFailed(context: ChatToolExecutionContext | undefined): boolean {
  if (!context) return false;
  return (typeof context.exitCode === "number" && context.exitCode !== 0)
    || context.timedOut === true
    || context.aborted === true
    || (typeof context.signal === "string" && context.signal.length > 0);
}

function toolResultExecutionContexts(
  view: ChiliRuntimeView,
  session: RuntimeSessionView,
): Map<ToolCallId, ChatToolExecutionContext> {
  const contexts = new Map<ToolCallId, ChatToolExecutionContext>();
  for (const messageId of session.messageIds) {
    const message = view.messages[messageId];
    if (!message) continue;
    for (const part of message.parts) {
      if (part.type !== "tool_result") continue;
      const context = chatToolExecutionContext(part.executionContext);
      if (context) contexts.set(part.callId, context);
    }
  }
  return contexts;
}

function chatToolExecutionContext(value: unknown): ChatToolExecutionContext | undefined {
  const record = recordObjectValue(value);
  if (!record) return undefined;
  const context: ChatToolExecutionContext = {};
  if (record.sandbox === "macos-seatbelt" || record.sandbox === "none") context.sandbox = record.sandbox;
  if (record.executionMode === "sandboxed" || record.executionMode === "unsandboxed") context.executionMode = record.executionMode;
  if (record.exitCode === null || (typeof record.exitCode === "number" && Number.isFinite(record.exitCode))) {
    context.exitCode = record.exitCode;
  }
  if (typeof record.timedOut === "boolean") context.timedOut = record.timedOut;
  if (typeof record.aborted === "boolean") context.aborted = record.aborted;
  if (record.signal === null || typeof record.signal === "string") context.signal = record.signal;
  return Object.keys(context).length > 0 ? context : undefined;
}

function chatApprovalRow(view: ChiliRuntimeView, approval: RuntimeApprovalView): ChatApprovalRow {
  const toolCall = approval.callId ? view.toolCalls[approval.callId] : undefined;
  const toolName = toolCall?.toolName ?? permissionToolName(approval.permission);
  const toolStatus = toolCall?.status;
  const row: ChatApprovalRow = {
    id: approval.id,
    kind: "approval",
    permission: approval.permission,
    patterns: approval.patterns,
    status: approval.status,
    createdAt: approval.createdAt,
    inputSummary: chatToolInputSummary(toolName, toolCall?.input, approval.patterns),
  };
  assignOptional(row, "sessionId", approval.sessionId);
  assignOptional(row, "callId", approval.callId);
  assignOptional(row, "maxApprovalScope", approval.maxApprovalScope);
  assignOptional(row, "toolName", toolName);
  assignOptional(row, "toolInput", toolCall?.input);
  assignOptional(row, "toolStatus", toolStatus);
  assignOptional(row, "toolDisplayStatus", toolStatus ? chatToolDisplayStatus(approval.status === "pending" ? "waiting_for_approval" : toolStatus, approval) : undefined);
  assignOptional(row, "metadata", approval.metadata);
  assignOptional(row, "decision", approval.decision);
  assignOptional(row, "feedback", approval.feedback);
  assignOptional(row, "resolvedAt", approval.resolvedAt);
  return row;
}

function approvalsForToolCall(view: ChiliRuntimeView, callId: ToolCallId): RuntimeApprovalView[] {
  return Object.values(view.approvals)
    .filter((approval) => approval.callId === callId)
    .sort((left, right) => approvalTime(left) - approvalTime(right));
}

function latestApprovalForToolCall(approvals: readonly RuntimeApprovalView[]): RuntimeApprovalView | undefined {
  return approvals[approvals.length - 1];
}

function approvalTime(approval: RuntimeApprovalView): number {
  return approval.resolvedAt ?? approval.createdAt;
}

function chatToolDisplayStatus(
  status: RuntimeToolCallView["status"] | ToolPartStatus,
  approval?: RuntimeApprovalView,
): ChatToolDisplayStatus {
  if (approval?.status === "pending") return "waiting_permission";
  if (approval?.decision === "deny" && (status === "waiting_for_approval" || status === "cancelled" || status === "failed")) {
    return "rejected";
  }
  if (status === "pending") return "queued";
  if (status === "validating") return "checking";
  if (status === "waiting_for_approval") return "waiting_permission";
  if (status === "running") return "running";
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  return "cancelled";
}

function chatToolInputSummary(toolName: string | undefined, input: unknown, patterns: readonly string[]): ChatToolInputSummary {
  const name = toolName && toolName.length > 0 ? toolName : "tool";
  const record = recordValue(input);
  const normalized = name.toLowerCase();
  const path = record ? firstString(record, ["filePath", "file_path", "path"]) : undefined;
  const pattern = record ? firstString(record, ["pattern", "query"]) : undefined;
  const paths = record ? firstStringArray(record, ["paths", "filePaths", "file_paths"]) : undefined;
  const scope = scopeSummary(patterns, path, paths);

  if (normalized === "bash" || normalized === "run_shell_command") {
    const command = record ? firstString(record, ["command", "cmd"]) : undefined;
    return compactSummary({
      title: "bash",
      detail: command ?? scope,
      command,
      scope: record ? firstString(record, ["cwd"]) : undefined,
    });
  }

  if (normalized === "edit" || normalized === "replace") {
    const oldText = record ? firstString(record, ["oldString", "old_string", "oldText"]) : undefined;
    const newText = record ? firstString(record, ["newString", "new_string", "newText"]) : undefined;
    return compactSummary({
      title: "edit",
      detail: path ?? scope,
      path: path ?? firstPattern(patterns),
      scope,
      diffSummary: editDiffSummary(oldText, newText, record ? booleanRecordValue(record, "replaceAll", "allow_multiple", "replace_all") : undefined),
    });
  }

  if (normalized === "write" || normalized === "write_file") {
    const content = record ? firstString(record, ["content"]) : undefined;
    return compactSummary({
      title: "write",
      detail: path ?? scope,
      path: path ?? firstPattern(patterns),
      scope,
      diffSummary: content === undefined ? undefined : `write ${lineCount(content)} line(s), ${content.length} chars`,
    });
  }

  if (normalized === "apply_patch") {
    const operations = record && Array.isArray(record.operations) ? record.operations : [];
    const operationSummary = applyPatchSummary(operations);
    return compactSummary({
      title: "apply_patch",
      detail: operationSummary.paths.join(", ") || scope,
      path: operationSummary.paths[0] ?? firstPattern(patterns),
      scope,
      diffSummary: operationSummary.summary,
    });
  }

  if (normalized === "read" || normalized === "read_file") {
    return compactSummary({
      title: "read",
      detail: path ?? scope,
      path: path ?? firstPattern(patterns),
      scope,
    });
  }

  if (normalized === "grep") {
    return compactSummary({
      title: "grep",
      detail: pattern ? `${pattern}${path ? ` in ${path}` : ""}` : scope,
      pattern,
      path,
      scope: path ?? scope,
    });
  }

  if (normalized === "glob") {
    return compactSummary({
      title: "glob",
      detail: pattern ? `${pattern}${path ? ` under ${path}` : ""}` : scope,
      pattern,
      path,
      scope: path ?? scope,
    });
  }

  return compactSummary({
    title: name,
    detail: scope ?? previewUnknown(input, 120),
    path: path ?? firstPattern(patterns),
    pattern,
    scope,
  });
}

function permissionToolName(permission: string): string | undefined {
  const trimmed = permission.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("tool.") ? trimmed.slice("tool.".length) : trimmed;
}

function compactSummary(summary: ChatToolInputSummaryDraft): ChatToolInputSummary {
  const output: ChatToolInputSummary = { title: summary.title };
  assignOptional(output, "detail", emptyToUndefined(summary.detail));
  assignOptional(output, "scope", emptyToUndefined(summary.scope));
  assignOptional(output, "command", emptyToUndefined(summary.command));
  assignOptional(output, "path", emptyToUndefined(summary.path));
  assignOptional(output, "pattern", emptyToUndefined(summary.pattern));
  assignOptional(output, "diffSummary", emptyToUndefined(summary.diffSummary));
  return output;
}

function scopeSummary(patterns: readonly string[], path: string | undefined, paths: readonly string[] | undefined): string | undefined {
  if (paths?.length) return paths.join(", ");
  if (path) return path;
  return patterns.length > 0 ? patterns.join(", ") : undefined;
}

function firstPattern(patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => pattern.length > 0);
}

function editDiffSummary(oldText: string | undefined, newText: string | undefined, replaceAll: boolean | undefined): string | undefined {
  if (oldText === undefined || newText === undefined) return undefined;
  const mode = replaceAll ? "replace all" : "replace";
  return `${mode} ${lineCount(oldText)} line(s) with ${lineCount(newText)} line(s): ${previewText(oldText, 32)} -> ${previewText(newText, 32)}`;
}

function applyPatchSummary(operations: readonly unknown[]): { paths: string[]; summary?: string } {
  const rows = operations.flatMap((operation): Array<{ type: string; path: string; movePath?: string }> => {
    const record = recordValue(operation);
    if (!record) return [];
    const type = firstString(record, ["type"]) ?? "update";
    const path = firstString(record, ["path"]);
    if (!path) return [];
    const movePath = firstString(record, ["movePath", "move_path"]);
    return [{ type, path, ...(movePath ? { movePath } : {}) }];
  });
  const paths = [...new Set(rows.flatMap((row) => row.movePath ? [row.path, row.movePath] : [row.path]))];
  if (rows.length === 0) return { paths };
  const preview = rows
    .slice(0, 4)
    .map((row) => row.movePath ? `${row.type} ${row.path} -> ${row.movePath}` : `${row.type} ${row.path}`)
    .join(", ");
  const suffix = rows.length > 4 ? `, +${rows.length - 4} more` : "";
  return { paths, summary: `${rows.length} operation(s): ${preview}${suffix}` };
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstStringArray(record: Record<string, unknown>, keys: readonly string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
    if (items.length > 0) return items;
  }
  return undefined;
}

function booleanRecordValue(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function previewText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return JSON.stringify(normalized);
  return JSON.stringify(`${normalized.slice(0, Math.max(0, maxLength - 1))}...`);
}

function previewUnknown(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  try {
    return previewRaw(JSON.stringify(value), maxLength);
  } catch {
    return previewRaw(String(value), maxLength);
  }
}

function previewRaw(text: string | undefined, maxLength: number): string | undefined {
  if (!text) return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function chatItemTime(item: ChatTranscriptItem): number {
  if (item.kind === "message") return item.createdAt;
  if (item.kind === "tool") return item.updatedAt;
  return item.resolvedAt ?? item.createdAt;
}

function upsertSession(view: ChiliRuntimeView, sessionId: SessionId, time: number): RuntimeSessionView {
  const existing = view.sessions[sessionId];
  if (existing) return existing;

  const session: RuntimeSessionView = {
    id: sessionId,
    cwd: "",
    lifecycle: "active",
    status: "idle",
    messageIds: [],
    toolCallIds: [],
    approvalIds: [],
    updatedAt: time,
    hasExplicitStatus: false,
  };
  view.sessions[sessionId] = session;
  view.sessionIds.push(sessionId);
  return session;
}

function setSessionStatus(
  session: RuntimeSessionView,
  status: RuntimeSessionStatus,
  reason?: string,
): void {
  session.status = status;
  if (reason === undefined) {
    delete session.statusReason;
  } else {
    session.statusReason = reason;
  }
}

function isTerminalSessionStatus(status: RuntimeSessionStatus): boolean {
  return status === "idle" || status === "failed" || status === "cancelled";
}

function upsertToolCall(view: ChiliRuntimeView, callId: ToolCallId, time: number): RuntimeToolCallView {
  const existing = view.toolCalls[callId];
  if (existing) return existing;

  const toolCall: RuntimeToolCallView = {
    id: callId,
    status: "pending",
    toolName: "",
    input: undefined,
    updatedAt: time,
  };
  view.toolCalls[callId] = toolCall;
  assignTranscriptOrder(view, "tool", callId);
  return toolCall;
}

const MAX_TOOL_OUTPUT_DELTAS = 80;
/** UTF-8 text budget per tool preview, independent of sender-provided bytes. */
export const MAX_TOOL_OUTPUT_PREVIEW_BYTES = 64 * 1024;
const toolOutputEncoder = new TextEncoder();
const toolOutputDecoder = new TextDecoder();

function isTerminalToolStatus(status: RuntimeToolCallView["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function appendToolOutputDelta(toolCall: RuntimeToolCallView, delta: RuntimeToolOutputDelta): void {
  if (!delta.delta && !delta.gapBefore) return;
  const previousSequence = toolCall.liveOutput?.findLast((entry) => entry.sequence !== undefined)?.sequence;
  if (delta.sequence !== undefined && previousSequence !== undefined) {
    if (delta.sequence <= previousSequence) return;
    if (delta.sequence > previousSequence + 1) delta = { ...delta, truncated: true, gapBefore: true };
  }
  const encoded = toolOutputEncoder.encode(delta.delta);
  if (encoded.byteLength > MAX_TOOL_OUTPUT_PREVIEW_BYTES) {
    let start = encoded.byteLength - MAX_TOOL_OUTPUT_PREVIEW_BYTES;
    // Keep a valid UTF-8 suffix rather than splitting a multibyte code point.
    while ((encoded[start]! & 0xc0) === 0x80) start += 1;
    delta = { ...delta, delta: toolOutputDecoder.decode(encoded.subarray(start)), truncated: true };
  }
  const liveOutput = toolCall.liveOutput ? [...toolCall.liveOutput, delta] : [delta];
  let bytes = liveOutput.reduce((total, entry) => total + toolOutputEncoder.encode(entry.delta).byteLength, 0);
  let dropped = false;
  let droppedGap = false;
  while (liveOutput.length > MAX_TOOL_OUTPUT_DELTAS || bytes > MAX_TOOL_OUTPUT_PREVIEW_BYTES) {
    const removed = liveOutput.shift()!;
    bytes -= toolOutputEncoder.encode(removed.delta).byteLength;
    dropped = true;
    droppedGap ||= removed.gapBefore === true;
  }
  const first = liveOutput[0];
  if (dropped && first) {
    liveOutput[0] = { ...first, truncated: true, ...(droppedGap ? { gapBefore: true } : {}) };
  }
  toolCall.liveOutput = liveOutput;
}

function assignTranscriptOrder(
  view: ChiliRuntimeView,
  kind: "message" | "tool" | "approval",
  id: string,
): void {
  const key = transcriptOrderKey(kind, id);
  if (view.transcriptOrder[key] !== undefined) return;
  view.transcriptOrder[key] = view.nextTranscriptOrder;
  view.nextTranscriptOrder += 1;
}

function chatTranscriptOrder(view: ChiliRuntimeView, item: ChatTranscriptItem): number {
  const kind = item.kind === "message" ? "message" : item.kind === "tool" ? "tool" : "approval";
  return view.transcriptOrder[transcriptOrderKey(kind, String(item.id))] ?? Number.MAX_SAFE_INTEGER;
}

function transcriptOrderKey(kind: "message" | "tool" | "approval", id: string): string {
  return `${kind}\u0000${id}`;
}

function touchSession(view: ChiliRuntimeView, sessionId: SessionId, time: number): void {
  const session = upsertSession(view, sessionId, time);
  session.updatedAt = time;
}

function linkToolCallToSession(view: ChiliRuntimeView, toolCall: RuntimeToolCallView, time: number): void {
  if (!toolCall.sessionId) return;
  const session = upsertSession(view, toolCall.sessionId, time);
  if (!session.toolCallIds.includes(toolCall.id)) session.toolCallIds.push(toolCall.id);
  session.updatedAt = time;
}

function linkApprovalToSession(
  view: ChiliRuntimeView,
  approval: RuntimeApprovalView,
  time: number,
  eventId?: string,
): void {
  if (!approval.sessionId) return;
  const session = upsertSession(view, approval.sessionId, time);
  if (!session.approvalIds.includes(approval.id)) session.approvalIds.push(approval.id);
  if (!session.hasExplicitStatus) {
    setSessionStatus(session, "waiting_for_approval");
    assignOptional(session, "statusEventId", eventId);
  }
  session.updatedAt = time;
}

function clearSessionRetry(view: ChiliRuntimeView, sessionId: SessionId, turnId?: TurnId): void {
  const session = view.sessions[sessionId];
  if (!session?.retry) return;
  if (turnId !== undefined && session.retry.turnId !== turnId) return;
  delete session.retry;
}

function hasPendingApprovalForSession(view: ChiliRuntimeView, sessionId: SessionId): boolean {
  return Object.values(view.approvals).some(
    (approval) => approval.sessionId === sessionId && approval.status === "pending",
  );
}

function applyPartDelta(view: ChiliRuntimeView, partId: PartId, field: string, delta: string): void {
  const entry = view.partIndex[partId];
  if (!entry) return;
  const message = view.messages[entry.messageId];
  const part = message?.parts[entry.index];
  if (!part || view.committedPartIds[partId]) return;

  if (field === "text" && (part.type === "text" || part.type === "reasoning")) {
    part.text += delta;
    return;
  }

  if (field === "output" && part.type === "tool_result") {
    part.output += delta;
  }
}

function setToolPartStatus(
  view: ChiliRuntimeView,
  callId: ToolCallId,
  status: RuntimeToolCallView["status"],
): void {
  for (const message of Object.values(view.messages)) {
    for (const part of message.parts) {
      if (part.type === "tool_call" && part.callId === callId) {
        part.status = normalizeToolPartStatus(status);
      }
    }
  }
}

function normalizeToolPartStatus(status: RuntimeToolCallView["status"]): ToolPartStatus {
  if (status === "validating" || status === "waiting_for_approval") return "running";
  if (status === "completed" || status === "failed" || status === "cancelled" || status === "running") return status;
  return "pending";
}

function assignOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function hasOwn<T extends object, K extends PropertyKey>(target: T, key: K): target is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function recordObjectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
