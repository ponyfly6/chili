import type {
  AgentMailboxStatus,
  AgentMailboxPayload,
  AgentMessageConsumedPayload,
  AgentPath,
  AgentTaskStatus,
  ChiliEvent,
  EventEnvelope,
  MessagePart,
  SessionId,
  TaskId,
  ThreadId,
  TimestampMs,
} from "@chili/protocol";
import { normalizeAgentPath, parentAgentPath, timestampNow } from "@chili/protocol";
import type {
  AgentMailboxDeliveryStore,
  AgentMailboxQuery,
  AgentMailboxRow,
  AgentRunQuery,
  AgentRunRow,
  AgentTaskRow,
  EventStore,
  SubagentProjectionStore,
} from "@chili/store";
import type { SubmitPromptInput, SubmitPromptResult } from "./runtime-service.js";

export interface AgentTreeControlServiceOptions {
  store: EventStore & SubagentProjectionStore & Partial<AgentMailboxDeliveryStore>;
  runtime?: AgentMailboxRuntime;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
}

export interface AgentMailboxRuntime {
  appendUserMessage(input: { sessionId: SessionId; threadId: ThreadId; text: string }): Promise<unknown>;
  submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult>;
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

export class AgentMailboxNotDeliverableError extends Error {
  constructor(readonly messageId: string, message: string) {
    super(message);
    this.name = "AgentMailboxNotDeliverableError";
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

    const deliveryStore = this.mailboxDeliveryStore();
    if (!deliveryStore) {
      await this.deliverMailbox(message, task);
      await this.appendMailboxConsumed(message, task, input.consumedBy);
      return this.requireMailbox(input.messageId);
    }

    const context = mailboxEventContext(message, task);
    const claim = await deliveryStore.claimAgentMailboxMessage({
      messageId: input.messageId,
      eventId: this.id("event"),
      claimedBy: input.consumedBy ?? message.path,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.threadId ? { threadId: context.threadId } : {}),
      time: this.now(),
    });
    if (!claim.applied) {
      const current = claim.message ?? (await this.requireMailbox(input.messageId));
      if (current.status === "consumed") return current;
      throw new AgentMailboxNotDeliverableError(input.messageId, `Mailbox message is already being delivered: ${input.messageId}`);
    }

    const claimedMessage = claim.message ?? (await this.requireMailbox(input.messageId));
    try {
      await this.deliverMailbox(claimedMessage, task);
    } catch (error) {
      await deliveryStore.requeueAgentMailboxMessage({
        messageId: input.messageId,
        eventId: this.id("event"),
        error: toError(error).message,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        ...(context.threadId ? { threadId: context.threadId } : {}),
        time: this.now(),
      });
      throw error;
    }

    const consumed = await deliveryStore.consumeAgentMailboxMessage({
      messageId: input.messageId,
      eventId: this.id("event"),
      consumedBy: input.consumedBy ?? claimedMessage.path,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.threadId ? { threadId: context.threadId } : {}),
      time: this.now(),
    });
    if (consumed.message) return consumed.message;
    return this.requireMailbox(input.messageId);
  }

  private async appendMailboxConsumed(
    message: AgentMailboxRow,
    task: AgentTaskRow | undefined,
    consumedBy: AgentPath | undefined,
  ): Promise<void> {
    const payload: AgentMessageConsumedPayload = {
      messageId: message.id,
      path: message.path,
      consumedBy: consumedBy ?? message.path,
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
  }

  private async deliverMailbox(message: AgentMailboxRow, task: AgentTaskRow | undefined): Promise<void> {
    const runtime = this.options.runtime;
    if (!runtime || !message.message) return;

    const sessionId = task?.childSessionId ?? message.childSessionId;
    const threadId = task?.childThreadId ?? message.childThreadId;
    if (!sessionId || !threadId) {
      throw new AgentMailboxNotDeliverableError(message.id, `Mailbox message is missing child session metadata: ${message.id}`);
    }

    const text = textFromMailboxPayload(message.message);
    if (!text) {
      throw new AgentMailboxNotDeliverableError(message.id, `Mailbox message has no deliverable text: ${message.id}`);
    }

    if (message.triggerTurn) {
      const input: SubmitPromptInput = {
        sessionId,
        threadId,
        text,
      };
      if (task?.cwd) input.cwd = task.cwd;
      await runtime.submitPrompt(input);
      return;
    }

    await runtime.appendUserMessage({ sessionId, threadId, text });
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

  private mailboxDeliveryStore(): AgentMailboxDeliveryStore | undefined {
    const store = this.options.store;
    if (store.claimAgentMailboxMessage && store.consumeAgentMailboxMessage && store.requeueAgentMailboxMessage) {
      return store as EventStore & SubagentProjectionStore & AgentMailboxDeliveryStore;
    }
    return undefined;
  }
}

function mailboxEventContext(
  message: AgentMailboxRow,
  task: AgentTaskRow | undefined,
): { sessionId?: SessionId; threadId?: ThreadId } {
  const context: { sessionId?: SessionId; threadId?: ThreadId } = {};
  const sessionId = task?.parentSessionId ?? message.childSessionId;
  if (sessionId) context.sessionId = sessionId;
  const threadId = task?.parentThreadId ?? message.childThreadId;
  if (threadId) context.threadId = threadId;
  return context;
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

  for (const node of [...nodes.values()]) {
    synthesizeAncestors(nodes, node.path, node.createdAt, input.rootPath);
  }
  if (input.rootPath && !nodes.has(input.rootPath)) {
    upsertNode(nodes, input.rootPath, 0);
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
  const explicitRoot = nodes.get(input.rootPath);
  return explicitRoot ? [explicitRoot] : sortedRoots.filter((node) => isPathWithin(node.path, input.rootPath as AgentPath));
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

function synthesizeAncestors(
  nodes: Map<string, AgentTreeNode>,
  path: AgentPath,
  time: number,
  rootPath: AgentPath | undefined,
): void {
  let childPath: AgentPath | undefined = path;
  while (childPath) {
    if (rootPath && childPath === rootPath) return;
    const parentPath = parentAgentPath(childPath);
    if (!parentPath) return;
    if (rootPath && !isPathWithin(childPath, rootPath)) return;

    const child = nodes.get(childPath);
    if (child && !child.parentPath) child.parentPath = parentPath;
    const parent = upsertNode(nodes, parentPath, time);
    parent.createdAt = Math.min(parent.createdAt, time);
    parent.updatedAt = Math.max(parent.updatedAt, child?.updatedAt ?? time);
    childPath = parentPath;
  }
}

function sortTree(nodes: AgentTreeNode[]): AgentTreeNode[] {
  nodes.sort((left, right) => left.createdAt - right.createdAt || left.path.localeCompare(right.path));
  for (const node of nodes) {
    sortTree(node.children);
  }
  return nodes;
}

function textFromMailboxPayload(payload: AgentMailboxPayload): string | undefined {
  const text =
    "content" in payload
      ? payload.content
      : payload.parts
          .map(textFromPart)
          .filter(Boolean)
          .join("\n");
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function textFromPart(part: MessagePart): string {
  if (part.type === "text" || part.type === "reasoning") return part.text;
  if (part.type === "tool_result") return part.error ? part.error : part.output;
  if (part.type === "agent_handoff") return part.summary;
  return "";
}

function isPathWithin(path: AgentPath, rootPath: AgentPath): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
