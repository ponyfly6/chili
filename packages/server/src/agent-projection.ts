import type { AgentPath, AgentRunId, EventEnvelope, SessionId, TaskId, TeamId, ThreadId } from "@chili/protocol";

export type RuntimeAgentStatus = "running" | "completed" | "failed" | "cancelled";
export type RuntimeTaskStatus = "pending" | "running" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";

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
  claimedAt?: number;
  consumedAt?: number;
}

export interface RuntimeTaskView {
  id: TaskId;
  status: RuntimeTaskStatus;
  generation: number;
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

interface MutableAgentsView {
  agentRunIds: AgentRunId[];
  agents: Record<string, RuntimeAgentView>;
  agentRunIdsByPath: Record<string, AgentRunId>;
  mailboxMessageIds: string[];
  mailboxMessages: Record<string, RuntimeAgentMailboxMessageView>;
  taskIds: TaskId[];
  tasks: Record<string, RuntimeTaskView>;
  lastEventId?: string;
}

export function projectRuntimeAgents(events: Iterable<EventEnvelope>, sessionId?: SessionId): RuntimeAgentsSnapshot {
  const view: MutableAgentsView = {
    agentRunIds: [],
    agents: {},
    agentRunIdsByPath: {},
    mailboxMessageIds: [],
    mailboxMessages: {},
    taskIds: [],
    tasks: {},
  };

  for (const event of events) {
    view.lastEventId = event.id;
    applyAgentEvent(view, event);
  }

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

function applyAgentEvent(view: MutableAgentsView, event: EventEnvelope): void {
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
      linkTaskToOwnerAgent(view, task, event.time);
    }
    view.agentRunIdsByPath[path] = runId;
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
    return;
  }

  if (event.type === "agent.message_claimed") {
    const messageId = stringValue(payload.messageId);
    if (!messageId) return;
    const message = view.mailboxMessages[messageId];
    if (!message) return;
    message.status = "delivering";
    message.claimedAt = event.time;
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
    linkTaskToOwnerAgent(view, task, event.time);
  }
}

function upsertAgentRun(view: MutableAgentsView, runId: AgentRunId, path: AgentPath, time: number): RuntimeAgentView {
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

function upsertTask(view: MutableAgentsView, taskId: TaskId, time: number): RuntimeTaskView {
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

function linkAgentToParent(view: MutableAgentsView, agent: RuntimeAgentView, time: number): void {
  if (!agent.parentPath) return;
  const parentRunId = view.agentRunIdsByPath[agent.parentPath];
  const parent = parentRunId ? view.agents[parentRunId] : undefined;
  if (!parent || parent.childRunIds.includes(agent.id)) return;
  parent.childRunIds.push(agent.id);
  parent.updatedAt = time;
}

function linkTaskToOwnerAgent(view: MutableAgentsView, task: RuntimeTaskView, time: number): void {
  if (!task.ownerPath) return;
  const runId = view.agentRunIdsByPath[task.ownerPath];
  const agent = runId ? view.agents[runId] : undefined;
  if (!agent) return;
  if (!task.sessionId && agent.sessionId) task.sessionId = agent.sessionId;
  if (!agent.taskIds.includes(task.id)) agent.taskIds.push(task.id);
  agent.updatedAt = time;
}

function linkOwnedTasksToAgent(view: MutableAgentsView, agent: RuntimeAgentView, time: number): void {
  for (const task of Object.values(view.tasks)) {
    if (task.ownerPath !== agent.path) continue;
    if (!task.sessionId && agent.sessionId) task.sessionId = agent.sessionId;
    if (!agent.taskIds.includes(task.id)) agent.taskIds.push(task.id);
    agent.updatedAt = time;
  }
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

function isStaleTaskSpawn(task: RuntimeTaskView, generation: number | undefined): boolean {
  if (generation !== undefined && generation < task.generation) return true;
  return isFinalTaskStatus(task.status) && (generation === undefined || generation <= task.generation);
}

function isFinalTaskStatus(status: RuntimeTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
