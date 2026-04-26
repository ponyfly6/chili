import type {
  AgentPath,
  AgentRunId,
  ApprovalId,
  ChiliEvent,
  EventEnvelope,
  MessageId,
  MessagePart,
  MessageRole,
  PartId,
  RuntimeSessionStatus,
  SessionId,
  TaskId,
  TeamId,
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
  agentRunIds: AgentRunId[];
  agents: Record<string, RuntimeAgentView>;
  agentRunIdsByPath: Record<string, AgentRunId>;
  mailboxMessageIds: string[];
  mailboxMessages: Record<string, RuntimeAgentMailboxMessageView>;
  taskIds: TaskId[];
  tasks: Record<string, RuntimeTaskView>;
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
  agentRunIds: AgentRunId[];
  taskIds: TaskId[];
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

export type RuntimeAgentStatus = "running" | "completed" | "failed" | "cancelled";

export interface RuntimeAgentView {
  id: AgentRunId;
  path: AgentPath;
  taskName: string;
  status: RuntimeAgentStatus;
  mailboxMessageIds: string[];
  childRunIds: AgentRunId[];
  taskIds: TaskId[];
  createdAt: number;
  updatedAt: number;
  parentPath?: AgentPath;
  sessionId?: SessionId;
  threadId?: ThreadId;
  completedAt?: number;
}

export interface RuntimeAgentMailboxMessageView {
  id: string;
  path: AgentPath;
  from: AgentPath;
  triggerTurn: boolean;
  queuedAt: number;
  sessionId?: SessionId;
  threadId?: ThreadId;
}

export type RuntimeTaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";

export interface RuntimeTaskView {
  id: TaskId;
  status: RuntimeTaskStatus;
  createdAt: number;
  updatedAt: number;
  teamId?: TeamId;
  sessionId?: SessionId;
  ownerPath?: AgentPath;
  path?: AgentPath;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  completedAt?: number;
}

export interface RuntimeAgentsSnapshot {
  agents: RuntimeAgentView[];
  tasks: RuntimeTaskView[];
  mailbox: RuntimeAgentMailboxMessageView[];
  lastEventId?: string;
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
    agentRunIds: [],
    agents: {},
    agentRunIdsByPath: {},
    mailboxMessageIds: [],
    mailboxMessages: {},
    taskIds: [],
    tasks: {},
    partIndex: {},
  };
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

export function applyRuntimeEvent(view: ChiliRuntimeView, inputEvent: EventEnvelope): ChiliRuntimeView {
  view.lastEventId = inputEvent.id;
  applySubagentProjectionEvent(view, inputEvent);

  const event = inputEvent as ChiliEvent;
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

export function runtimeAgentsSnapshot(view: ChiliRuntimeView, sessionId?: SessionId): RuntimeAgentsSnapshot {
  const snapshot: RuntimeAgentsSnapshot = {
    agents: view.agentRunIds
      .flatMap((runId) => {
        const agent = view.agents[runId];
        return agent ? [agent] : [];
      })
      .filter((agent) => (sessionId ? agent.sessionId === sessionId : true)),
    tasks: view.taskIds
      .flatMap((taskId) => {
        const task = view.tasks[taskId];
        return task ? [task] : [];
      })
      .filter((task) => (sessionId ? task.sessionId === sessionId : true)),
    mailbox: view.mailboxMessageIds
      .flatMap((messageId) => {
        const message = view.mailboxMessages[messageId];
        return message ? [message] : [];
      })
      .filter((message) => (sessionId ? message.sessionId === sessionId : true)),
  };
  assignOptional(snapshot, "lastEventId", view.lastEventId);
  return snapshot;
}

function applySubagentProjectionEvent(view: ChiliRuntimeView, event: EventEnvelope): void {
  const payload = recordPayload(event);
  if (!payload) return;

  if (event.type === "agent.spawned") {
    const runId = stringValue(payload.runId) as AgentRunId | undefined;
    const path = stringValue(payload.path) as AgentPath | undefined;
    const taskName = stringValue(payload.taskName);
    if (!runId || !path || !taskName) return;

    const agent = upsertAgentRun(view, runId, path, event.time);
    agent.path = path;
    agent.taskName = taskName;
    agent.status = "running";
    agent.updatedAt = event.time;
    assignOptional(agent, "parentPath", stringValue(payload.parentPath) as AgentPath | undefined);
    assignOptional(agent, "sessionId", event.sessionId);
    assignOptional(agent, "threadId", event.threadId);
    const taskId = stringValue(payload.taskId) as TaskId | undefined;
    if (taskId && !agent.taskIds.includes(taskId)) agent.taskIds.push(taskId);
    view.agentRunIdsByPath[path] = runId;
    linkAgentToSession(view, agent, event.time);
    linkAgentToParent(view, agent, event.time);
    linkOwnedTasksToAgent(view, agent, event.time);
    return;
  }

  if (event.type === "agent.completed") {
    const runId = stringValue(payload.runId) as AgentRunId | undefined;
    const path = stringValue(payload.path) as AgentPath | undefined;
    const status = agentStatusValue(payload.status);
    if (!runId || !path || !status) return;

    const agent = upsertAgentRun(view, runId, path, event.time);
    agent.path = path;
    agent.status = status;
    agent.completedAt = event.time;
    agent.updatedAt = event.time;
    assignOptional(agent, "sessionId", event.sessionId);
    assignOptional(agent, "threadId", event.threadId);
    const taskId = stringValue(payload.taskId) as TaskId | undefined;
    if (taskId && !agent.taskIds.includes(taskId)) agent.taskIds.push(taskId);
    view.agentRunIdsByPath[path] = runId;
    linkAgentToSession(view, agent, event.time);
    return;
  }

  if (event.type === "agent.message_queued" || event.type === "agent.mailbox_message_queued") {
    const path = stringValue(payload.path) as AgentPath | undefined;
    const from = stringValue(payload.from) as AgentPath | undefined;
    if (!path || !from) return;

    const message: RuntimeAgentMailboxMessageView = {
      id: event.id,
      path,
      from,
      triggerTurn: booleanValue(payload.triggerTurn) ?? false,
      queuedAt: event.time,
    };
    assignOptional(message, "sessionId", event.sessionId);
    assignOptional(message, "threadId", event.threadId);
    view.mailboxMessages[message.id] = message;
    if (!view.mailboxMessageIds.includes(message.id)) view.mailboxMessageIds.push(message.id);

    const runId = view.agentRunIdsByPath[path];
    const agent = runId ? view.agents[runId] : undefined;
    if (agent && !agent.mailboxMessageIds.includes(message.id)) {
      agent.mailboxMessageIds.push(message.id);
      agent.updatedAt = event.time;
    }
    return;
  }

  if (event.type === "agent.task_created") {
    const taskId = stringValue(payload.taskId) as TaskId | undefined;
    const path = stringValue(payload.path) as AgentPath | undefined;
    if (!taskId || !path) return;

    const task = upsertTask(view, taskId, event.time);
    task.status = "pending";
    task.updatedAt = event.time;
    task.path = path;
    task.ownerPath = path;
    assignOptional(task, "sessionId", stringValue(payload.parentSessionId) as SessionId | undefined);
    assignOptional(task, "childSessionId", stringValue(payload.childSessionId) as SessionId | undefined);
    assignOptional(task, "childThreadId", stringValue(payload.childThreadId) as ThreadId | undefined);
    linkTaskToSession(view, task, event.time);
    linkTaskToOwnerAgent(view, task, event.time);
    return;
  }

  if (event.type === "team.task_created" || event.type === "task.created") {
    const teamId = stringValue(payload.teamId) as TeamId | undefined;
    const taskId = stringValue(payload.taskId) as TaskId | undefined;
    if (!teamId || !taskId) return;

    const task = upsertTask(view, taskId, event.time);
    task.teamId = teamId;
    task.status = "pending";
    task.updatedAt = event.time;
    assignOptional(task, "sessionId", event.sessionId);
    assignOptional(task, "ownerPath", stringValue(payload.ownerPath) as AgentPath | undefined);
    linkTaskToSession(view, task, event.time);
    linkTaskToOwnerAgent(view, task, event.time);
    return;
  }

  if (
    event.type === "agent.task_completed" ||
    event.type === "team.task_updated" ||
    event.type === "task.updated" ||
    event.type === "task.completed"
  ) {
    const taskId = stringValue(payload.taskId) as TaskId | undefined;
    const teamId = stringValue(payload.teamId) as TeamId | undefined;
    const status = event.type === "task.completed" ? "completed" : taskStatusValue(payload.status);
    if (!taskId || !status) return;

    const existing = view.tasks[taskId];
    const task = existing ?? upsertTask(view, taskId, event.time);
    if (teamId) task.teamId = teamId;
    task.status = status;
    task.updatedAt = event.time;
    if (status === "completed" || status === "failed" || status === "cancelled") task.completedAt = event.time;
    assignOptional(task, "sessionId", event.sessionId);
    assignOptional(task, "ownerPath", stringValue(payload.ownerPath) as AgentPath | undefined);
    assignOptional(task, "path", stringValue(payload.path) as AgentPath | undefined);
    linkTaskToSession(view, task, event.time);
    linkTaskToOwnerAgent(view, task, event.time);
  }
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
    agentRunIds: [],
    taskIds: [],
    updatedAt: time,
  };
  view.sessions[sessionId] = session;
  view.sessionIds.push(sessionId);
  return session;
}

function upsertAgentRun(view: ChiliRuntimeView, runId: AgentRunId, path: AgentPath, time: number): RuntimeAgentView {
  const existing = view.agents[runId];
  if (existing) return existing;

  const agent: RuntimeAgentView = {
    id: runId,
    path,
    taskName: "",
    status: "running",
    mailboxMessageIds: [],
    childRunIds: [],
    taskIds: [],
    createdAt: time,
    updatedAt: time,
  };
  view.agents[runId] = agent;
  view.agentRunIds.push(runId);
  view.agentRunIdsByPath[path] = runId;
  return agent;
}

function upsertTask(view: ChiliRuntimeView, taskId: TaskId, time: number): RuntimeTaskView {
  const existing = view.tasks[taskId];
  if (existing) return existing;

  const task: RuntimeTaskView = {
    id: taskId,
    status: "pending",
    createdAt: time,
    updatedAt: time,
  };
  view.tasks[taskId] = task;
  view.taskIds.push(taskId);
  return task;
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

function linkAgentToSession(view: ChiliRuntimeView, agent: RuntimeAgentView, time: number): void {
  if (!agent.sessionId) return;
  const session = upsertSession(view, agent.sessionId, time);
  if (!session.agentRunIds.includes(agent.id)) session.agentRunIds.push(agent.id);
  session.updatedAt = time;
}

function linkAgentToParent(view: ChiliRuntimeView, agent: RuntimeAgentView, time: number): void {
  if (!agent.parentPath) return;
  const parentRunId = view.agentRunIdsByPath[agent.parentPath];
  const parent = parentRunId ? view.agents[parentRunId] : undefined;
  if (!parent || parent.childRunIds.includes(agent.id)) return;
  parent.childRunIds.push(agent.id);
  parent.updatedAt = time;
}

function linkTaskToSession(view: ChiliRuntimeView, task: RuntimeTaskView, time: number): void {
  if (!task.sessionId) return;
  const session = upsertSession(view, task.sessionId, time);
  if (!session.taskIds.includes(task.id)) session.taskIds.push(task.id);
  session.updatedAt = time;
}

function linkTaskToOwnerAgent(view: ChiliRuntimeView, task: RuntimeTaskView, time: number): void {
  if (!task.ownerPath) return;
  const runId = view.agentRunIdsByPath[task.ownerPath];
  const agent = runId ? view.agents[runId] : undefined;
  if (!agent) return;
  if (!task.sessionId && agent.sessionId) task.sessionId = agent.sessionId;
  if (!agent.taskIds.includes(task.id)) agent.taskIds.push(task.id);
  agent.updatedAt = time;
}

function linkOwnedTasksToAgent(view: ChiliRuntimeView, agent: RuntimeAgentView, time: number): void {
  for (const task of Object.values(view.tasks)) {
    if (task.ownerPath !== agent.path) continue;
    if (!task.sessionId && agent.sessionId) task.sessionId = agent.sessionId;
    if (!agent.taskIds.includes(task.id)) agent.taskIds.push(task.id);
    agent.updatedAt = time;
    linkTaskToSession(view, task, time);
  }
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

function recordPayload(event: EventEnvelope): Record<string, unknown> | undefined {
  return event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function agentStatusValue(value: unknown): RuntimeAgentStatus | undefined {
  return value === "running" || value === "completed" || value === "failed" || value === "cancelled" ? value : undefined;
}

function taskStatusValue(value: unknown): RuntimeTaskStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "blocked" || value === "completed" || value === "failed" || value === "cancelled"
    ? value
    : undefined;
}
