import type {
  AgentMailboxStatus,
  AgentMessageConsumedPayload,
  AgentPath,
  AgentTaskStatus,
  ChiliEvent,
  EventEnvelope,
  SessionId,
  TaskId,
  ThreadId,
  TimestampMs,
} from "@chili/protocol";
import { normalizeAgentPath, parentAgentPath, timestampNow } from "@chili/protocol";
import type {
  AgentMailboxQuery,
  AgentMailboxRow,
  AgentRunQuery,
  AgentRunRow,
  AgentTaskRow,
  EventStore,
  SubagentProjectionStore,
} from "@chili/store";

export interface AgentTreeControlServiceOptions {
  store: EventStore & SubagentProjectionStore;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
}

export interface AgentTreeSnapshotQuery {
  rootPath?: AgentPath;
  sessionId?: SessionId;
  includeConsumedMailbox?: boolean;
  limit?: number;
}

export interface AgentTreeSnapshot {
  rootPath?: AgentPath;
  nodes: AgentTreeNode[];
  agents: AgentRunRow[];
  tasks: AgentTaskRow[];
  mailbox: AgentMailboxRow[];
}

export interface AgentTreeNode {
  path: AgentPath;
  parentPath?: AgentPath;
  taskName: string;
  status: AgentRunRow["status"] | AgentTaskStatus | AgentMailboxStatus | "empty";
  runIds: string[];
  runs: AgentRunRow[];
  tasks: AgentTaskRow[];
  mailbox: AgentMailboxRow[];
  children: AgentTreeNode[];
  createdAt: number;
  updatedAt: number;
}

export interface ConsumeAgentMailboxInput {
  messageId: string;
  consumedBy?: AgentPath;
}

export class AgentMailboxNotFoundError extends Error {
  constructor(readonly messageId: string) {
    super(`Agent mailbox message not found: ${messageId}`);
    this.name = "AgentMailboxNotFoundError";
  }
}

export class AgentTreeControlService {
  constructor(private readonly options: AgentTreeControlServiceOptions) {}

  async snapshot(query: AgentTreeSnapshotQuery = {}): Promise<AgentTreeSnapshot> {
    const limit = query.limit ?? 1000;
    const rootPath = query.rootPath ? normalizeAgentPath(query.rootPath) : undefined;
    const runQuery: AgentRunQuery = { limit };
    if (query.sessionId) runQuery.sessionId = query.sessionId;
    const agents = (await this.options.store.agentRuns(runQuery)).filter((run) =>
      rootPath ? isPathWithin(run.path, rootPath) : true,
    );
    const tasks = (await this.options.store.agentTasks({ limit })).filter((task) => {
      if (query.sessionId && task.parentSessionId !== query.sessionId) return false;
      return rootPath ? isPathWithin(task.path, rootPath) : true;
    });
    const mailbox = (await this.options.store.agentMailbox({ limit })).filter((message) => {
      if (!query.includeConsumedMailbox && message.status === "consumed") return false;
      if (query.sessionId && !tasks.some((task) => task.id === message.taskId)) return false;
      return rootPath ? isPathWithin(message.path, rootPath) : true;
    });

    const treeInput: {
      agents: AgentRunRow[];
      tasks: AgentTaskRow[];
      mailbox: AgentMailboxRow[];
      rootPath?: AgentPath;
    } = { agents, tasks, mailbox };
    if (rootPath) treeInput.rootPath = rootPath;
    const snapshot: AgentTreeSnapshot = {
      nodes: buildTreeNodes(treeInput),
      agents,
      tasks,
      mailbox,
    };
    if (rootPath) snapshot.rootPath = rootPath;
    return snapshot;
  }

  agentRuns(query: AgentRunQuery = {}): Promise<AgentRunRow[]> {
    return this.options.store.agentRuns(query);
  }

  mailbox(query: AgentMailboxQuery = {}): Promise<AgentMailboxRow[]> {
    return this.options.store.agentMailbox(query);
  }

  async consumeMailbox(input: ConsumeAgentMailboxInput): Promise<AgentMailboxRow> {
    const message = await this.requireMailbox(input.messageId);
    if (message.status === "consumed") return message;

    const task = message.taskId ? await this.options.store.agentTask(message.taskId) : undefined;
    const consumedBy = input.consumedBy ?? message.path;
    const payload: AgentMessageConsumedPayload = {
      messageId: input.messageId,
      path: message.path,
      consumedBy,
    };
    if (message.taskId) payload.taskId = message.taskId;
    const event: EventEnvelope<"agent.message_consumed", AgentMessageConsumedPayload> = {
      id: this.id("event"),
      type: "agent.message_consumed",
      time: this.now(),
      payload,
    };
    const sessionId = task?.parentSessionId ?? message.childSessionId;
    if (sessionId) event.sessionId = sessionId;
    const threadId = task?.parentThreadId ?? message.childThreadId;
    if (threadId) event.threadId = threadId;
    await this.options.store.append(event as ChiliEvent);

    return this.requireMailbox(input.messageId);
  }

  private async requireMailbox(messageId: string): Promise<AgentMailboxRow> {
    const message = (await this.options.store.agentMailbox({ messageId, limit: 1 }))[0];
    if (!message) throw new AgentMailboxNotFoundError(messageId);
    return message;
  }

  private id<T extends string>(prefix: string): T {
    const create = this.options.createId ?? defaultCreateId;
    return create(prefix) as T;
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

function buildTreeNodes(input: {
  agents: AgentRunRow[];
  tasks: AgentTaskRow[];
  mailbox: AgentMailboxRow[];
  rootPath?: AgentPath;
}): AgentTreeNode[] {
  const nodes = new Map<string, AgentTreeNode>();

  for (const run of input.agents) {
    const node = upsertNode(nodes, run.path, run.createdAt);
    node.runs.push(run);
    node.runIds.push(run.id);
    node.taskName = run.taskName;
    node.status = run.status;
    if (run.parentPath) node.parentPath = run.parentPath;
    node.createdAt = Math.min(node.createdAt, run.createdAt);
    node.updatedAt = Math.max(node.updatedAt, run.completedAt ?? run.createdAt);
  }

  for (const task of input.tasks) {
    const node = upsertNode(nodes, task.path, task.createdAt);
    node.tasks.push(task);
    if (node.taskName.length === 0) node.taskName = task.taskName;
    if (node.status === "empty") node.status = task.status === "running" ? "running" : task.status;
    if (task.parentPath) node.parentPath = task.parentPath;
    node.createdAt = Math.min(node.createdAt, task.createdAt);
    node.updatedAt = Math.max(node.updatedAt, task.updatedAt);
  }

  for (const message of input.mailbox) {
    const node = upsertNode(nodes, message.path, message.createdAt);
    node.mailbox.push(message);
    if (node.status === "empty") node.status = message.status;
    const parentPath = parentAgentPath(message.path);
    if (!node.parentPath && parentPath) node.parentPath = parentPath;
    node.createdAt = Math.min(node.createdAt, message.createdAt);
    node.updatedAt = Math.max(node.updatedAt, message.consumedAt ?? message.createdAt);
  }

  const roots: AgentTreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentPath && nodes.has(node.parentPath)) {
      nodes.get(node.parentPath)?.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortedRoots = sortTree(roots);
  if (!input.rootPath) return sortedRoots;
  return sortedRoots.filter((node) => isPathWithin(node.path, input.rootPath as AgentPath));
}

function upsertNode(nodes: Map<string, AgentTreeNode>, path: AgentPath, time: number): AgentTreeNode {
  const existing = nodes.get(path);
  if (existing) return existing;

  const node: AgentTreeNode = {
    path,
    taskName: "",
    status: "empty",
    runIds: [],
    runs: [],
    tasks: [],
    mailbox: [],
    children: [],
    createdAt: time,
    updatedAt: time,
  };
  nodes.set(path, node);
  return node;
}

function sortTree(nodes: AgentTreeNode[]): AgentTreeNode[] {
  nodes.sort((left, right) => left.createdAt - right.createdAt || left.path.localeCompare(right.path));
  for (const node of nodes) {
    sortTree(node.children);
  }
  return nodes;
}

function isPathWithin(path: AgentPath, rootPath: AgentPath): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}
