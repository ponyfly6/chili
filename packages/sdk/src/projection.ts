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
  TeamMemberStatus,
  TeamMessageDelivery,
  TeamMessageDeliveryStatus,
  TeamMessageKind,
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
  teamIds: TeamId[];
  teams: Record<string, RuntimeTeamView>;
  teamMemberIds: string[];
  teamMembers: Record<string, RuntimeTeamMemberView>;
  teamMessageIds: string[];
  teamMessages: Record<string, RuntimeTeamMessageView>;
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
  generation: number;
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
  status: "queued" | "delivering" | "consumed";
  queuedAt: number;
  sessionId?: SessionId;
  threadId?: ThreadId;
  teamId?: TeamId;
  teamMessageId?: string;
  claimedAt?: number;
  consumedAt?: number;
}

export type RuntimeTaskStatus = "pending" | "running" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";

export interface RuntimeTaskView {
  id: TaskId;
  status: RuntimeTaskStatus;
  generation: number;
  createdAt: number;
  updatedAt: number;
  teamId?: TeamId;
  title?: string;
  description?: string;
  dependsOn?: TaskId[];
  summary?: string;
  error?: string;
  sessionId?: SessionId;
  ownerPath?: AgentPath;
  path?: AgentPath;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  completedAt?: number;
}

export interface RuntimeTeamView {
  id: TeamId;
  name: string;
  leadPath: AgentPath;
  status: "active" | "archived";
  memberIds: string[];
  taskIds: TaskId[];
  messageIds: string[];
  createdAt: number;
  updatedAt: number;
  sessionId?: SessionId;
  description?: string;
}

export interface RuntimeTeamMemberView {
  id: string;
  teamId: TeamId;
  path: AgentPath;
  name: string;
  role: string;
  status: TeamMemberStatus;
  createdAt: number;
  updatedAt: number;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  model?: string;
  toolScope?: string[];
  writeScope?: string[];
  currentTaskId?: TaskId;
  closedAt?: number;
}

export interface RuntimeTeamMessageView {
  id: string;
  teamId: TeamId;
  from: AgentPath;
  to: AgentPath | "*";
  content: string;
  kind: TeamMessageKind;
  delivery?: TeamMessageDelivery;
  deliveryStatus?: TeamMessageDeliveryStatus;
  deliveryError?: string;
  deliveryUpdatedAt?: number;
  deliveredAt?: number;
  createdAt: number;
  sessionId?: SessionId;
  threadId?: ThreadId;
  taskId?: TaskId;
  summary?: string;
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
    teamIds: [],
    teams: {},
    teamMemberIds: [],
    teamMembers: {},
    teamMessageIds: [],
    teamMessages: {},
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
  applyTeamProjectionEvent(view, inputEvent);
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

function applyTeamProjectionEvent(view: ChiliRuntimeView, event: EventEnvelope): void {
  const payload = recordPayload(event);
  if (!payload) return;

  if (event.type === "team.created") {
    const teamId = stringValue(payload.teamId) as TeamId | undefined;
    const name = stringValue(payload.name);
    const leadPath = stringValue(payload.leadPath) as AgentPath | undefined;
    if (!teamId || !name || !leadPath) return;

    const team = upsertTeam(view, teamId, event.time);
    team.name = name;
    team.leadPath = leadPath;
    team.status = "active";
    team.updatedAt = event.time;
    assignOptional(team, "sessionId", event.sessionId);
    assignOptional(team, "description", stringValue(payload.description));
    return;
  }

  if (event.type === "team.member_added") {
    const teamId = stringValue(payload.teamId) as TeamId | undefined;
    const path = stringValue(payload.path) as AgentPath | undefined;
    const name = stringValue(payload.name);
    const role = stringValue(payload.role);
    if (!teamId || !path || !name || !role) return;

    const member = upsertTeamMember(view, teamId, path, event.time);
    member.name = name;
    member.role = role;
    member.status = teamMemberStatusValue(payload.status) ?? "idle";
    member.updatedAt = event.time;
    assignOptional(member, "childSessionId", stringValue(payload.childSessionId) as SessionId | undefined);
    assignOptional(member, "childThreadId", stringValue(payload.childThreadId) as ThreadId | undefined);
    assignOptional(member, "model", stringValue(payload.model));
    assignOptional(member, "toolScope", stringArrayValue(payload.toolScope));
    assignOptional(member, "writeScope", stringArrayValue(payload.writeScope));
    linkMemberToTeam(view, member, event.time);
    return;
  }

  if (event.type === "team.member_status_changed") {
    const teamId = stringValue(payload.teamId) as TeamId | undefined;
    const path = stringValue(payload.path) as AgentPath | undefined;
    const status = teamMemberStatusValue(payload.status);
    if (!teamId || !path || !status) return;

    const member = upsertTeamMember(view, teamId, path, event.time);
    member.status = status;
    member.updatedAt = event.time;
    assignOptional(member, "currentTaskId", stringValue(payload.taskId) as TaskId | undefined);
    if (!payload.taskId) delete member.currentTaskId;
    if (status === "closed") member.closedAt = event.time;
    linkMemberToTeam(view, member, event.time);
    return;
  }

  if (
    event.type === "team.task_created" ||
    event.type === "team.task_assigned" ||
    event.type === "team.task_claimed" ||
    event.type === "team.task_updated"
  ) {
    const teamId = stringValue(payload.teamId) as TeamId | undefined;
    const taskId = stringValue(payload.taskId) as TaskId | undefined;
    if (!teamId || !taskId) return;

    const team = upsertTeam(view, teamId, event.time);
    if (!team.taskIds.includes(taskId)) team.taskIds.push(taskId);
    team.updatedAt = event.time;

    const task = upsertTask(view, taskId, event.time);
    task.teamId = teamId;
    task.updatedAt = event.time;
    assignOptional(task, "sessionId", event.sessionId);
    assignOptional(task, "title", stringValue(payload.title));
    assignOptional(task, "description", stringValue(payload.description));
    assignOptional(task, "dependsOn", taskIdArrayValue(payload.dependsOn));
    assignOptional(task, "summary", stringValue(payload.summary));
    assignOptional(task, "error", stringValue(payload.error));

    const ownerPath = stringValue(payload.ownerPath) as AgentPath | undefined;
    if (ownerPath) {
      task.ownerPath = ownerPath;
      const member = view.teamMembers[teamMemberKey(teamId, ownerPath)];
      if (member && (event.type === "team.task_assigned" || event.type === "team.task_claimed")) {
        member.currentTaskId = taskId;
        member.status = event.type === "team.task_claimed" ? "running" : member.status;
        member.updatedAt = event.time;
      }
    }
    return;
  }

  if (event.type === "team.message_sent") {
    const teamId = stringValue(payload.teamId) as TeamId | undefined;
    const messageId = stringValue(payload.messageId);
    const from = stringValue(payload.from) as AgentPath | undefined;
    const to = stringValue(payload.to) as AgentPath | "*" | undefined;
    const content = stringValue(payload.content);
    if (!teamId || !messageId || !from || !to || !content) return;

    const message: RuntimeTeamMessageView = {
      id: messageId,
      teamId,
      from,
      to,
      content,
      kind: teamMessageKindValue(payload.kind) ?? "text",
      createdAt: event.time,
    };
    assignOptional(message, "delivery", teamMessageDeliveryValue(payload.delivery));
    assignOptional(message, "sessionId", event.sessionId);
    assignOptional(message, "threadId", event.threadId);
    assignOptional(message, "taskId", stringValue(payload.taskId) as TaskId | undefined);
    assignOptional(message, "summary", stringValue(payload.summary));
    view.teamMessages[messageId] = message;
    refreshTeamMessageDeliveryStatus(view, messageId, event.time);
    if (!view.teamMessageIds.includes(messageId)) view.teamMessageIds.push(messageId);

    const team = upsertTeam(view, teamId, event.time);
    if (!team.messageIds.includes(messageId)) team.messageIds.push(messageId);
    team.updatedAt = event.time;
  }
}

function applySubagentProjectionEvent(view: ChiliRuntimeView, event: EventEnvelope): void {
  const payload = recordPayload(event);
  if (!payload) return;

  if (event.type === "agent.spawned") {
    const runId = stringValue(payload.runId) as AgentRunId | undefined;
    const path = stringValue(payload.path) as AgentPath | undefined;
    const taskName = stringValue(payload.taskName);
    if (!runId || !path || !taskName) return;
    const generation = generationValue(payload.generation);
    const taskId = stringValue(payload.taskId) as TaskId | undefined;
    const existingTask = taskId ? view.tasks[taskId] : undefined;
    if (existingTask && isStaleTaskSpawn(existingTask, generation)) return;

    const agent = upsertAgentRun(view, runId, path, event.time);
    if (agent.completedAt !== undefined && (generation === undefined || generation <= agent.generation)) return;
    agent.path = path;
    agent.taskName = taskName;
    agent.status = "running";
    agent.generation = generation ?? agent.generation;
    agent.updatedAt = event.time;
    assignOptional(agent, "parentPath", stringValue(payload.parentPath) as AgentPath | undefined);
    assignOptional(agent, "sessionId", event.sessionId);
    assignOptional(agent, "threadId", event.threadId);
    if (taskId) {
      if (!agent.taskIds.includes(taskId)) agent.taskIds.push(taskId);
      const task = upsertTask(view, taskId, event.time);
      task.status = "running";
      task.generation = generation ?? task.generation;
      delete task.completedAt;
      task.updatedAt = event.time;
      task.path = path;
      task.ownerPath = path;
      assignOptional(task, "sessionId", (stringValue(payload.parentSessionId) as SessionId | undefined) ?? event.sessionId);
      assignOptional(task, "childSessionId", stringValue(payload.childSessionId) as SessionId | undefined);
      assignOptional(task, "childThreadId", stringValue(payload.childThreadId) as ThreadId | undefined);
      linkTaskToSession(view, task, event.time);
      linkTaskToOwnerAgent(view, task, event.time);
    }
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
    const generation = generationValue(payload.generation);

    const agent = upsertAgentRun(view, runId, path, event.time);
    if (agent.completedAt !== undefined) return;
    if (generation !== undefined && generation < agent.generation) return;
    agent.path = path;
    agent.status = status;
    agent.generation = generation ?? agent.generation;
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
      status: "queued",
      queuedAt: event.time,
    };
    assignOptional(message, "sessionId", event.sessionId);
    assignOptional(message, "threadId", event.threadId);
    const teamMetadata = teamMailboxMetadata(payload.message);
    if (teamMetadata) {
      message.teamId = teamMetadata.teamId;
      message.teamMessageId = teamMetadata.teamMessageId;
      applyTeamMessageDeliveryStatus(view, teamMetadata.teamMessageId, "queued", event.time);
    }
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

  if (event.type === "agent.message_consumed") {
    const messageId = stringValue(payload.messageId);
    if (!messageId) return;
    const message = view.mailboxMessages[messageId];
    if (!message) return;
    message.status = "consumed";
    message.consumedAt = event.time;
    if (message.teamMessageId) applyTeamMessageDeliveryStatus(view, message.teamMessageId, "delivered", event.time);
    return;
  }

  if (event.type === "agent.message_claimed") {
    const messageId = stringValue(payload.messageId);
    if (!messageId) return;
    const message = view.mailboxMessages[messageId];
    if (!message) return;
    message.status = "delivering";
    message.claimedAt = event.time;
    if (message.teamMessageId) applyTeamMessageDeliveryStatus(view, message.teamMessageId, "delivering", event.time);
    return;
  }

  if (event.type === "agent.message_requeued") {
    const messageId = stringValue(payload.messageId);
    if (!messageId) return;
    const message = view.mailboxMessages[messageId];
    if (!message) return;
    message.status = "queued";
    delete message.claimedAt;
    delete message.consumedAt;
    if (message.teamMessageId) applyTeamMessageDeliveryStatus(view, message.teamMessageId, "failed", event.time, stringValue(payload.error));
    return;
  }

  if (event.type === "agent.task_created") {
    const taskId = stringValue(payload.taskId) as TaskId | undefined;
    const path = stringValue(payload.path) as AgentPath | undefined;
    if (!taskId || !path) return;

    const task = upsertTask(view, taskId, event.time);
    task.status = "pending";
    task.generation = 0;
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
    task.status = taskStatusValue(payload.status) ?? "pending";
    task.updatedAt = event.time;
    assignOptional(task, "sessionId", event.sessionId);
    assignOptional(task, "ownerPath", stringValue(payload.ownerPath) as AgentPath | undefined);
    assignOptional(task, "title", stringValue(payload.title));
    assignOptional(task, "description", stringValue(payload.description));
    assignOptional(task, "dependsOn", taskIdArrayValue(payload.dependsOn));
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") task.completedAt = event.time;
    linkTaskToSession(view, task, event.time);
    linkTaskToOwnerAgent(view, task, event.time);
    return;
  }

  if (event.type === "team.task_assigned" || event.type === "team.task_claimed") {
    const teamId = stringValue(payload.teamId) as TeamId | undefined;
    const taskId = stringValue(payload.taskId) as TaskId | undefined;
    if (!teamId || !taskId) return;

    const task = upsertTask(view, taskId, event.time);
    task.teamId = teamId;
    task.updatedAt = event.time;
    if (event.type === "team.task_claimed") {
      task.status = "in_progress";
      delete task.completedAt;
    }
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
    const generation = generationValue(payload.generation);
    if (event.type === "agent.task_completed") {
      if (existing && isFinalTaskStatus(existing.status)) return;
      if (existing && generation !== undefined && generation < existing.generation) return;
    }
    if (teamId) task.teamId = teamId;
    task.status = status;
    if (generation !== undefined) task.generation = Math.max(task.generation, generation);
    task.updatedAt = event.time;
    if (status === "completed" || status === "failed" || status === "cancelled") task.completedAt = event.time;
    assignOptional(task, "sessionId", event.sessionId);
    assignOptional(task, "ownerPath", stringValue(payload.ownerPath) as AgentPath | undefined);
    assignOptional(task, "path", stringValue(payload.path) as AgentPath | undefined);
    assignOptional(task, "title", stringValue(payload.title));
    assignOptional(task, "description", stringValue(payload.description));
    assignOptional(task, "dependsOn", taskIdArrayValue(payload.dependsOn));
    assignOptional(task, "summary", stringValue(payload.summary));
    assignOptional(task, "error", stringValue(payload.error));
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
    generation: 0,
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
    generation: 0,
    createdAt: time,
    updatedAt: time,
  };
  view.tasks[taskId] = task;
  view.taskIds.push(taskId);
  return task;
}

function upsertTeam(view: ChiliRuntimeView, teamId: TeamId, time: number): RuntimeTeamView {
  const existing = view.teams[teamId];
  if (existing) return existing;

  const team: RuntimeTeamView = {
    id: teamId,
    name: "",
    leadPath: "" as AgentPath,
    status: "active",
    memberIds: [],
    taskIds: [],
    messageIds: [],
    createdAt: time,
    updatedAt: time,
  };
  view.teams[teamId] = team;
  view.teamIds.push(teamId);
  return team;
}

function upsertTeamMember(
  view: ChiliRuntimeView,
  teamId: TeamId,
  path: AgentPath,
  time: number,
): RuntimeTeamMemberView {
  const id = teamMemberKey(teamId, path);
  const existing = view.teamMembers[id];
  if (existing) return existing;

  const member: RuntimeTeamMemberView = {
    id,
    teamId,
    path,
    name: "",
    role: "",
    status: "idle",
    createdAt: time,
    updatedAt: time,
  };
  view.teamMembers[id] = member;
  view.teamMemberIds.push(id);
  return member;
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

function linkMemberToTeam(view: ChiliRuntimeView, member: RuntimeTeamMemberView, time: number): void {
  const team = upsertTeam(view, member.teamId, time);
  if (!team.memberIds.includes(member.id)) team.memberIds.push(member.id);
  team.updatedAt = time;
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

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length > 0 ? items : undefined;
}

function taskIdArrayValue(value: unknown): TaskId[] | undefined {
  const items = stringArrayValue(value);
  return items ? (items as TaskId[]) : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function generationValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function agentStatusValue(value: unknown): RuntimeAgentStatus | undefined {
  return value === "running" || value === "completed" || value === "failed" || value === "cancelled" ? value : undefined;
}

function taskStatusValue(value: unknown): RuntimeTaskStatus | undefined {
  return value === "pending" || value === "running" || value === "in_progress" || value === "blocked" || value === "completed" || value === "failed" || value === "cancelled"
    ? value
    : undefined;
}

function teamMemberStatusValue(value: unknown): TeamMemberStatus | undefined {
  return value === "idle" || value === "running" || value === "waiting" || value === "blocked" || value === "closed" ? value : undefined;
}

function teamMessageKindValue(value: unknown): TeamMessageKind | undefined {
  return value === "text" || value === "task_assignment" || value === "system" ? value : undefined;
}

function teamMessageDeliveryValue(value: unknown): TeamMessageDelivery | undefined {
  return value === "queueOnly" || value === "triggerTurn" ? value : undefined;
}

function applyTeamMessageDeliveryStatus(
  view: ChiliRuntimeView,
  teamMessageId: string,
  status: TeamMessageDeliveryStatus,
  time: number,
  error?: string,
): void {
  const message = view.teamMessages[teamMessageId];
  if (!message) return;
  message.deliveryStatus = status;
  message.deliveryUpdatedAt = time;
  if (status === "delivered") {
    message.deliveredAt = time;
    delete message.deliveryError;
    return;
  }
  if (status === "failed" && error) {
    message.deliveryError = error;
    return;
  }
  if (status === "queued" || status === "delivering") {
    delete message.deliveryError;
  }
}

function refreshTeamMessageDeliveryStatus(view: ChiliRuntimeView, teamMessageId: string, time: number): void {
  const deliveries = Object.values(view.mailboxMessages).filter((message) => message.teamMessageId === teamMessageId);
  if (deliveries.length === 0) return;
  if (deliveries.some((message) => message.status === "delivering")) {
    applyTeamMessageDeliveryStatus(view, teamMessageId, "delivering", time);
    return;
  }
  if (deliveries.some((message) => message.status === "queued")) {
    applyTeamMessageDeliveryStatus(view, teamMessageId, "queued", time);
    return;
  }
  applyTeamMessageDeliveryStatus(view, teamMessageId, "delivered", time);
}

function teamMailboxMetadata(value: unknown): { teamId: TeamId; teamMessageId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as Record<string, unknown>;
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const record = metadata as Record<string, unknown>;
  const teamId = stringValue(record.teamId) as TeamId | undefined;
  const teamMessageId = stringValue(record.teamMessageId);
  if (!teamId || !teamMessageId) return undefined;
  return { teamId, teamMessageId };
}

function teamMemberKey(teamId: TeamId, path: AgentPath): string {
  return `${teamId}:${path}`;
}

function isStaleTaskSpawn(task: RuntimeTaskView, generation: number | undefined): boolean {
  if (generation !== undefined && generation < task.generation) return true;
  return isFinalTaskStatus(task.status) && (generation === undefined || generation <= task.generation);
}

function isFinalTaskStatus(status: RuntimeTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
