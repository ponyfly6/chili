import type {
  ApprovalId,
  ChiliEvent,
  EventEnvelope,
  MessageId,
  MessagePart,
  MessageRole,
  PartId,
  RuntimeSessionStatus,
  SessionId,
  ThreadId,
  ToolCallId,
  ToolCallStatus,
  TurnId,
} from "@chili/protocol";

type ToolPartStatus = Extract<MessagePart, { type: "tool_call" }>["status"];

export interface ChiliRuntimeView {
  sessionIds: SessionId[];
  sessions: Record<string, RuntimeSessionView>;
  messages: Record<string, RuntimeMessageView>;
  toolCalls: Record<string, RuntimeToolCallView>;
  approvals: Record<string, RuntimeApprovalView>;
  partIndex: Record<string, RuntimePartIndexEntry>;
  lastEventId?: string;
}

export interface RuntimeSessionView {
  id: SessionId;
  cwd: string;
  lifecycle: "active" | "archived";
  status: RuntimeSessionStatus;
  messageIds: MessageId[];
  toolCallIds: ToolCallId[];
  approvalIds: ApprovalId[];
  updatedAt: number;
  currentTurnId?: TurnId;
  statusReason?: string;
}

export interface RuntimeMessageView {
  id: MessageId;
  sessionId: SessionId;
  role: MessageRole;
  parts: MessagePart[];
  createdAt: number;
  threadId?: ThreadId;
  completedAt?: number;
}

export interface RuntimeToolCallView {
  id: ToolCallId;
  status: ToolCallStatus | "completed" | "failed" | "cancelled";
  toolName: string;
  input: unknown;
  updatedAt: number;
  sessionId?: SessionId;
  threadId?: ThreadId;
  turnId?: TurnId;
  output?: string;
  error?: string;
  synthetic?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RuntimeApprovalView {
  id: ApprovalId;
  permission: string;
  patterns: string[];
  status: "pending" | "resolved";
  createdAt: number;
  sessionId?: SessionId;
  threadId?: ThreadId;
  callId?: ToolCallId;
  decision?: "allow_once" | "allow_always" | "deny";
  feedback?: string;
  resolvedAt?: number;
}

export interface RuntimePartIndexEntry {
  messageId: MessageId;
  index: number;
}

export function createRuntimeView(): ChiliRuntimeView {
  return {
    sessionIds: [],
    sessions: {},
    messages: {},
    toolCalls: {},
    approvals: {},
    partIndex: {},
  };
}

export function reduceRuntimeEvents(
  events: Iterable<EventEnvelope>,
  view: ChiliRuntimeView = createRuntimeView(),
): ChiliRuntimeView {
  for (const event of events) {
    applyRuntimeEvent(view, event as ChiliEvent);
  }
  return view;
}

export function applyRuntimeEvent(view: ChiliRuntimeView, event: ChiliEvent): ChiliRuntimeView {
  view.lastEventId = event.id;

  switch (event.type) {
    case "session.created": {
      const session = upsertSession(view, event.payload.sessionId, event.time);
      session.cwd = event.payload.cwd;
      session.lifecycle = "active";
      session.updatedAt = event.time;
      break;
    }
    case "session.status_changed": {
      const session = upsertSession(view, event.payload.sessionId, event.time);
      session.status = event.payload.status;
      session.updatedAt = event.time;
      assignOptional(session, "currentTurnId", event.payload.turnId);
      assignOptional(session, "statusReason", event.payload.reason);
      break;
    }
    case "session.archived": {
      const session = upsertSession(view, event.payload.sessionId, event.time);
      session.lifecycle = "archived";
      session.updatedAt = event.time;
      break;
    }
    case "turn.started": {
      if (event.sessionId) {
        const session = upsertSession(view, event.sessionId, event.time);
        session.status = "running";
        session.currentTurnId = event.payload.turnId;
        session.updatedAt = event.time;
      }
      break;
    }
    case "turn.completed": {
      if (event.sessionId) {
        const session = upsertSession(view, event.sessionId, event.time);
        session.status = event.payload.status === "completed" ? "idle" : event.payload.status;
        session.currentTurnId = event.payload.turnId;
        session.updatedAt = event.time;
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
        };
        assignOptional(message, "threadId", event.threadId);
        view.messages[message.id] = message;
        session.messageIds.push(message.id);
      }
      session.updatedAt = event.time;
      break;
    }
    case "message.part_added": {
      const message = view.messages[event.payload.messageId];
      if (!message) break;
      const existingIndex = message.parts.findIndex((part) => part.id === event.payload.part.id);
      if (existingIndex >= 0) {
        message.parts[existingIndex] = event.payload.part;
        view.partIndex[event.payload.part.id] = { messageId: message.id, index: existingIndex };
      } else {
        message.parts.push(event.payload.part);
        view.partIndex[event.payload.part.id] = { messageId: message.id, index: message.parts.length - 1 };
      }
      touchSession(view, message.sessionId, event.time);
      break;
    }
    case "message.part_delta": {
      applyPartDelta(view, event.payload.partId as PartId, event.payload.field, event.payload.delta);
      if (event.sessionId) touchSession(view, event.sessionId, event.time);
      break;
    }
    case "tool.call_started": {
      const toolCall: RuntimeToolCallView = {
        id: event.payload.callId,
        status: "running",
        toolName: event.payload.toolName,
        input: event.payload.input,
        updatedAt: event.time,
      };
      assignOptional(toolCall, "sessionId", event.sessionId);
      assignOptional(toolCall, "threadId", event.threadId);
      assignOptional(toolCall, "turnId", event.payload.turnId);
      view.toolCalls[toolCall.id] = toolCall;
      linkToolCallToSession(view, toolCall, event.time);
      setToolPartStatus(view, event.payload.callId, "running");
      break;
    }
    case "tool.call_updated": {
      const toolCall = upsertToolCall(view, event.payload.callId, event.time);
      toolCall.status = event.payload.status;
      toolCall.updatedAt = event.time;
      assignOptional(toolCall, "metadata", event.payload.metadata);
      setToolPartStatus(view, event.payload.callId, event.payload.status);
      if (event.payload.status === "waiting_for_approval" && toolCall.sessionId) {
        const session = upsertSession(view, toolCall.sessionId, event.time);
        session.status = "waiting_for_approval";
        session.updatedAt = event.time;
      }
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
      assignOptional(approval, "threadId", event.threadId);
      assignOptional(approval, "callId", event.payload.callId);
      view.approvals[approval.id] = approval;
      linkApprovalToSession(view, approval, event.time);
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
  };
  view.sessions[sessionId] = session;
  view.sessionIds.push(sessionId);
  return session;
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
  return toolCall;
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

function linkApprovalToSession(view: ChiliRuntimeView, approval: RuntimeApprovalView, time: number): void {
  if (!approval.sessionId) return;
  const session = upsertSession(view, approval.sessionId, time);
  if (!session.approvalIds.includes(approval.id)) session.approvalIds.push(approval.id);
  session.status = "waiting_for_approval";
  session.updatedAt = time;
}

function applyPartDelta(view: ChiliRuntimeView, partId: PartId, field: string, delta: string): void {
  const entry = view.partIndex[partId];
  if (!entry) return;
  const message = view.messages[entry.messageId];
  const part = message?.parts[entry.index];
  if (!part) return;

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
