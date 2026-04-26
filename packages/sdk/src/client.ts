import type {
  ChiliEvent,
  AgentPath,
  AgentMailboxStatus,
  AgentTaskMode,
  AgentTaskStatus,
  Message,
  ApprovalId,
  RuntimeApprovalResolveResult,
  RuntimeInterruptResult,
  RuntimePromptAccepted,
  RuntimePromptResult,
  RuntimeSessionRef,
  SessionId,
  TaskId,
  ThreadId,
} from "@chili/protocol";
import type { RuntimeAgentsSnapshot } from "./projection.js";

export interface RuntimeClient {
  createSession(input?: CreateSessionRequest): Promise<RuntimeSessionRef>;
  submitPrompt(input: SubmitPromptRequest): Promise<RuntimePromptResult>;
  submitPromptAsync(input: SubmitPromptRequest): Promise<RuntimePromptAccepted>;
  interruptSession(input: InterruptSessionRequest): Promise<RuntimeInterruptResult>;
  resolveApproval(input: ResolveApprovalRequest): Promise<RuntimeApprovalResolveResult>;
  archiveSession(sessionId: SessionId): Promise<void>;
  listSessions(): Promise<RuntimeSessionSummary[]>;
  listAgents(input?: ListAgentsRequest): Promise<RuntimeAgentsSnapshot>;
  agentTree(input?: AgentTreeRequest): Promise<RuntimeAgentTreeSnapshot>;
  listAgentRuns(input?: ListAgentRunsRequest): Promise<RuntimeAgentRunRecord[]>;
  mailbox(input?: ListMailboxRequest): Promise<RuntimeAgentMailboxRecord[]>;
  consumeMailbox(messageId: string): Promise<RuntimeAgentMailboxRecord>;
  listTasks(input?: ListTasksRequest): Promise<RuntimeAgentTaskRecord[]>;
  task(taskId: TaskId): Promise<RuntimeAgentTaskRecord>;
  followupTask(input: FollowupTaskRequest): Promise<RuntimeTaskFollowupResult>;
  waitTask(input: WaitTaskRequest): Promise<RuntimeAgentTaskRecord>;
  closeTask(input: CloseTaskRequest): Promise<RuntimeAgentTaskRecord>;
  reconcileStaleTasks(input?: ReconcileStaleTasksRequest): Promise<RuntimeTaskReconcileStaleResult>;
  messages(sessionId: SessionId): Promise<Message[]>;
  streamEvents(input?: StreamEventsRequest): AsyncIterable<ChiliEvent>;
}

export interface CreateSessionRequest {
  sessionId?: SessionId;
  threadId?: ThreadId;
  cwd?: string;
}

export interface SubmitPromptRequest {
  sessionId: SessionId;
  threadId: ThreadId;
  text: string;
  cwd?: string;
  maxTurns?: number;
  system?: string[];
}

export interface InterruptSessionRequest {
  sessionId: SessionId;
  reason?: string;
}

export interface ResolveApprovalRequest {
  approvalId: ApprovalId;
  decision: "allow_once" | "allow_always" | "deny";
  feedback?: string;
}

export interface RuntimeSessionSummary {
  id: SessionId;
  cwd: string;
  title?: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
}

export interface ListAgentsRequest {
  sessionId?: SessionId;
}

export interface AgentTreeRequest {
  rootPath?: AgentPath;
  sessionId?: SessionId;
  includeConsumedMailbox?: boolean;
  limit?: number;
}

export interface RuntimeAgentTreeSnapshot {
  rootPath?: AgentPath;
  nodes: RuntimeAgentTreeNode[];
  agents: RuntimeAgentRunRecord[];
  tasks: RuntimeAgentTaskRecord[];
  mailbox: RuntimeAgentMailboxRecord[];
}

export interface RuntimeAgentTreeNode {
  path: AgentPath;
  parentPath?: AgentPath;
  taskName: string;
  status: RuntimeAgentRunRecord["status"] | AgentTaskStatus | AgentMailboxStatus | "empty";
  runIds: string[];
  runs: RuntimeAgentRunRecord[];
  tasks: RuntimeAgentTaskRecord[];
  mailbox: RuntimeAgentMailboxRecord[];
  children: RuntimeAgentTreeNode[];
  createdAt: number;
  updatedAt: number;
}

export interface ListAgentRunsRequest {
  path?: AgentPath;
  sessionId?: SessionId;
  childSessionId?: SessionId;
  status?: RuntimeAgentRunRecord["status"];
  limit?: number;
}

export interface RuntimeAgentRunRecord {
  id: string;
  sessionId?: SessionId;
  threadId?: ThreadId;
  taskId?: TaskId;
  path: AgentPath;
  parentPath?: AgentPath;
  parentSessionId?: SessionId;
  parentThreadId?: ThreadId;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  taskName: string;
  cwd?: string;
  mode?: AgentTaskMode;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  completedAt?: number;
}

export interface ListMailboxRequest {
  messageId?: string;
  taskId?: TaskId;
  path?: AgentPath;
  childSessionId?: SessionId;
  status?: AgentMailboxStatus;
  limit?: number;
}

export interface RuntimeAgentMailboxRecord {
  id: string;
  path: AgentPath;
  fromPath: AgentPath;
  triggerTurn: boolean;
  status: AgentMailboxStatus;
  taskId?: TaskId;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  message?: unknown;
  createdAt: number;
  consumedAt?: number;
}

export interface ListTasksRequest {
  status?: AgentTaskStatus;
  parentSessionId?: SessionId;
  childSessionId?: SessionId;
  limit?: number;
}

export interface RuntimeAgentTaskRecord {
  id: TaskId;
  path: AgentPath;
  status: AgentTaskStatus;
  taskName: string;
  generation: number;
  parentPath?: AgentPath;
  parentSessionId?: SessionId;
  parentThreadId?: ThreadId;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  cwd?: string;
  prompt?: string;
  mode?: AgentTaskMode;
  currentRunId?: string;
  summary?: string;
  error?: string;
  completion?: Record<string, unknown>;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  leaseHeartbeatAt?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface FollowupTaskRequest {
  taskId: TaskId;
  text: string;
  maxTurns?: number;
  system?: string[];
}

export interface RuntimeTaskFollowupResult {
  task: RuntimeAgentTaskRecord;
  result: RuntimePromptResult;
}

export interface WaitTaskRequest {
  taskId: TaskId;
  timeoutMs?: number;
}

export interface CloseTaskRequest {
  taskId: TaskId;
  status?: Extract<AgentTaskStatus, "completed" | "failed" | "cancelled">;
  summary?: string;
  error?: string;
  interrupt?: boolean;
}

export interface ReconcileStaleTasksRequest {
  staleAfterMs?: number;
  modes?: AgentTaskMode[];
  limit?: number;
  summary?: string;
  error?: string;
}

export interface RuntimeTaskReconcileStaleResult {
  scanned: number;
  closed: RuntimeAgentTaskRecord[];
}

export interface StreamEventsRequest {
  sessionId?: SessionId;
  threadId?: ThreadId;
  afterEventId?: string;
  signal?: AbortSignal;
}

export interface HttpRuntimeClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export class HttpRuntimeClient implements RuntimeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: URL;

  constructor(options: HttpRuntimeClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  }

  createSession(input: CreateSessionRequest = {}): Promise<RuntimeSessionRef> {
    return this.post("sessions", input);
  }

  submitPrompt(input: SubmitPromptRequest): Promise<RuntimePromptResult> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/prompt`, input);
  }

  submitPromptAsync(input: SubmitPromptRequest): Promise<RuntimePromptAccepted> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/prompt_async`, input);
  }

  interruptSession(input: InterruptSessionRequest): Promise<RuntimeInterruptResult> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/interrupt`, { reason: input.reason });
  }

  resolveApproval(input: ResolveApprovalRequest): Promise<RuntimeApprovalResolveResult> {
    return this.post(`approvals/${encodeURIComponent(input.approvalId)}/resolve`, {
      decision: input.decision,
      feedback: input.feedback,
    });
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.post(`sessions/${encodeURIComponent(sessionId)}/archive`, {});
  }

  listSessions(): Promise<RuntimeSessionSummary[]> {
    return this.get("sessions");
  }

  listAgents(input: ListAgentsRequest = {}): Promise<RuntimeAgentsSnapshot> {
    if (input.sessionId) return this.get(`sessions/${encodeURIComponent(input.sessionId)}/agents`);
    return this.get("agents");
  }

  agentTree(input: AgentTreeRequest = {}): Promise<RuntimeAgentTreeSnapshot> {
    const params = new URLSearchParams();
    if (input.rootPath) params.set("rootPath", input.rootPath);
    if (input.sessionId) params.set("sessionId", input.sessionId);
    if (input.includeConsumedMailbox !== undefined) {
      params.set("includeConsumedMailbox", String(input.includeConsumedMailbox));
    }
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const query = params.toString();
    return this.get(`agents/tree${query ? `?${query}` : ""}`);
  }

  listAgentRuns(input: ListAgentRunsRequest = {}): Promise<RuntimeAgentRunRecord[]> {
    const params = new URLSearchParams();
    if (input.path) params.set("path", input.path);
    if (input.sessionId) params.set("sessionId", input.sessionId);
    if (input.childSessionId) params.set("childSessionId", input.childSessionId);
    if (input.status) params.set("status", input.status);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const query = params.toString();
    return this.get(`agent_runs${query ? `?${query}` : ""}`);
  }

  mailbox(input: ListMailboxRequest = {}): Promise<RuntimeAgentMailboxRecord[]> {
    const params = new URLSearchParams();
    if (input.messageId) params.set("messageId", input.messageId);
    if (input.taskId) params.set("taskId", input.taskId);
    if (input.path) params.set("path", input.path);
    if (input.childSessionId) params.set("childSessionId", input.childSessionId);
    if (input.status) params.set("status", input.status);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const query = params.toString();
    return this.get(`mailbox${query ? `?${query}` : ""}`);
  }

  consumeMailbox(messageId: string): Promise<RuntimeAgentMailboxRecord> {
    return this.post(`mailbox/${encodeURIComponent(messageId)}/consume`, {});
  }

  listTasks(input: ListTasksRequest = {}): Promise<RuntimeAgentTaskRecord[]> {
    const params = new URLSearchParams();
    if (input.status) params.set("status", input.status);
    if (input.parentSessionId) params.set("parentSessionId", input.parentSessionId);
    if (input.childSessionId) params.set("childSessionId", input.childSessionId);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const query = params.toString();
    return this.get(`tasks${query ? `?${query}` : ""}`);
  }

  task(taskId: TaskId): Promise<RuntimeAgentTaskRecord> {
    return this.get(`tasks/${encodeURIComponent(taskId)}`);
  }

  followupTask(input: FollowupTaskRequest): Promise<RuntimeTaskFollowupResult> {
    return this.post(`tasks/${encodeURIComponent(input.taskId)}/followup`, {
      text: input.text,
      maxTurns: input.maxTurns,
      system: input.system,
    });
  }

  waitTask(input: WaitTaskRequest): Promise<RuntimeAgentTaskRecord> {
    return this.post(`tasks/${encodeURIComponent(input.taskId)}/wait`, {
      timeoutMs: input.timeoutMs,
    });
  }

  closeTask(input: CloseTaskRequest): Promise<RuntimeAgentTaskRecord> {
    return this.post(`tasks/${encodeURIComponent(input.taskId)}/close`, {
      status: input.status,
      summary: input.summary,
      error: input.error,
      interrupt: input.interrupt,
    });
  }

  reconcileStaleTasks(input: ReconcileStaleTasksRequest = {}): Promise<RuntimeTaskReconcileStaleResult> {
    return this.post("tasks/reconcile_stale", input);
  }

  messages(sessionId: SessionId): Promise<Message[]> {
    return this.get(`sessions/${encodeURIComponent(sessionId)}/messages`);
  }

  async *streamEvents(input: StreamEventsRequest = {}): AsyncIterable<ChiliEvent> {
    const url = this.url("events");
    if (input.sessionId) url.searchParams.set("sessionId", input.sessionId);
    if (input.threadId) url.searchParams.set("threadId", input.threadId);
    if (input.afterEventId) url.searchParams.set("afterEventId", input.afterEventId);

    const init: RequestInit = {
      headers: { accept: "text/event-stream" },
    };
    if (input.signal) init.signal = input.signal;
    const response = await this.fetchImpl(url, init);
    if (!response.ok || !response.body) {
      throw await responseError(response);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseFrame(frame);
          if (event) yield event;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private get<T>(path: string): Promise<T> {
    return this.request(path, { method: "GET" });
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(this.url(path), init);
    if (!response.ok) throw await responseError(response);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private url(path: string): URL {
    return new URL(path.replace(/^\/+/, ""), this.baseUrl);
  }
}

function parseSseFrame(frame: string): ChiliEvent | undefined {
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (data.length === 0) return undefined;
  return JSON.parse(data.join("\n")) as ChiliEvent;
}

async function responseError(response: Response): Promise<Error> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { message?: string }; message?: string };
    message = body.error?.message ?? body.message ?? message;
  } catch {
    // Keep the HTTP status fallback.
  }
  return new Error(message);
}
