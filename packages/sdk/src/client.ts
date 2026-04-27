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
  TeamId,
  TeamMemberStatus,
  TeamMessageKind,
  TeamTaskStatus,
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
  listTeams(): Promise<RuntimeTeamRecord[]>;
  createTeam(input: CreateTeamRequest): Promise<RuntimeTeamRecord>;
  listTeamMembers(teamId: TeamId): Promise<RuntimeTeamMemberRecord[]>;
  addTeamMember(input: AddTeamMemberRequest): Promise<RuntimeTeamMemberRecord>;
  listTeamTasks(teamId: TeamId): Promise<RuntimeTeamTaskRecord[]>;
  createTeamTask(input: CreateTeamTaskRequest): Promise<RuntimeTeamTaskRecord>;
  assignTeamTask(input: AssignTeamTaskRequest): Promise<RuntimeTeamTaskRecord>;
  claimTeamTask(input: ClaimTeamTaskRequest): Promise<RuntimeTeamTaskClaimResult>;
  dispatchTeamTask(input: DispatchTeamTaskRequest): Promise<RuntimeTeamTaskDispatchResult>;
  syncTeamTask(input: SyncTeamTaskRequest): Promise<RuntimeTeamTaskSyncResult>;
  reconcileTeamTasks(input?: ReconcileTeamTasksRequest): Promise<RuntimeTeamTaskReconcileResult>;
  updateTeamTask(input: UpdateTeamTaskRequest): Promise<RuntimeTeamTaskRecord>;
  listTeamMessages(teamId: TeamId): Promise<RuntimeTeamMessageRecord[]>;
  sendTeamMessage(input: SendTeamMessageRequest): Promise<RuntimeTeamMessageRecord>;
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

export interface RuntimeTeamRecord {
  id: TeamId;
  sessionId?: SessionId;
  name: string;
  leadPath: AgentPath;
  status: "active" | "archived";
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeTeamMemberRecord {
  teamId: TeamId;
  path: AgentPath;
  name: string;
  role: string;
  status: TeamMemberStatus;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  model?: string;
  toolScope?: string[];
  writeScope?: string[];
  currentTaskId?: TaskId;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface RuntimeTeamTaskRecord {
  id: TaskId;
  teamId: TeamId;
  sessionId?: SessionId;
  title: string;
  description?: string;
  status: TeamTaskStatus;
  ownerPath?: AgentPath;
  createdBy?: AgentPath;
  dependsOn: TaskId[];
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface RuntimeTeamMessageRecord {
  id: string;
  teamId: TeamId;
  fromPath: AgentPath;
  toPath: AgentPath | "*";
  content: string;
  kind: TeamMessageKind;
  taskId?: TaskId;
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface TeamRequestContext {
  sessionId?: SessionId;
  threadId?: ThreadId;
}

export interface CreateTeamRequest extends TeamRequestContext {
  teamId?: TeamId;
  name: string;
  leadPath: AgentPath;
  description?: string;
  leadName?: string;
  leadRole?: string;
  leadStatus?: TeamMemberStatus;
  leadWriteScope?: string[];
}

export interface AddTeamMemberRequest extends TeamRequestContext {
  teamId: TeamId;
  path: AgentPath;
  name: string;
  role: string;
  status?: TeamMemberStatus;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  model?: string;
  toolScope?: string[];
  writeScope?: string[];
}

export interface CreateTeamTaskRequest extends TeamRequestContext {
  teamId: TeamId;
  taskId?: TaskId;
  title: string;
  description?: string;
  createdBy?: AgentPath;
  ownerPath?: AgentPath;
  dependsOn?: TaskId[];
  status?: TeamTaskStatus;
  metadata?: Record<string, unknown>;
}

export interface AssignTeamTaskRequest extends TeamRequestContext {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath: AgentPath;
  assignedBy?: AgentPath;
  message?: string;
  messageSummary?: string;
}

export interface ClaimTeamTaskRequest extends TeamRequestContext {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath: AgentPath;
  claimedBy?: AgentPath;
}

export interface RuntimeTeamTaskClaimResult {
  applied: boolean;
  task?: RuntimeTeamTaskRecord;
  events: ChiliEvent[];
  reason?: "not_found" | "already_claimed" | "already_resolved" | "blocked";
}

export interface RuntimeLocalSubagentTaskRecord {
  taskId: TaskId;
  runId: string;
  path: AgentPath;
  parentPath: AgentPath;
  childSessionId: SessionId;
  childThreadId: ThreadId;
  status: AgentTaskStatus;
  summary?: string;
  error?: string;
}

export interface RuntimeTeamTaskDispatchResult {
  status: "running" | "completed" | "failed" | "cancelled" | "skipped";
  teamTask: RuntimeTeamTaskRecord;
  team_task: RuntimeTeamTaskRecord;
  agentTask?: RuntimeLocalSubagentTaskRecord;
  agent_task?: RuntimeLocalSubagentTaskRecord;
  reason?:
    | RuntimeTeamTaskClaimResult["reason"]
    | "missing_owner"
    | "missing_session"
    | "missing_member"
    | "member_unavailable"
    | "scope_mismatch";
}

export interface RuntimeTeamTaskSyncResult {
  applied: boolean;
  teamTask: RuntimeTeamTaskRecord;
  agentTask?: RuntimeAgentTaskRecord;
  reason?: "not_dispatched" | "agent_task_not_found" | "agent_running" | "team_already_final";
}

export interface RuntimeTeamTaskReconcileError {
  teamId: TeamId;
  taskId: TaskId;
  error: string;
}

export interface RuntimeTeamTaskReconcileResult {
  scanned: number;
  synced: RuntimeTeamTaskSyncResult[];
  skipped: RuntimeTeamTaskSyncResult[];
  errors: RuntimeTeamTaskReconcileError[];
}

export interface DispatchTeamTaskRequest extends TeamRequestContext {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  cwd?: string;
  mode?: AgentTaskMode;
  prompt?: string;
}

export interface SyncTeamTaskRequest extends TeamRequestContext {
  teamId: TeamId;
  taskId: TaskId;
}

export interface ReconcileTeamTasksRequest extends TeamRequestContext {
  teamId?: TeamId;
  limit?: number;
}

export interface UpdateTeamTaskRequest extends TeamRequestContext {
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

export interface SendTeamMessageRequest extends TeamRequestContext {
  teamId: TeamId;
  messageId?: string;
  from: AgentPath;
  to: AgentPath | "*";
  content: string;
  kind?: TeamMessageKind;
  taskId?: TaskId;
  summary?: string;
  metadata?: Record<string, unknown>;
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

  listTeams(): Promise<RuntimeTeamRecord[]> {
    return this.get("teams");
  }

  createTeam(input: CreateTeamRequest): Promise<RuntimeTeamRecord> {
    return this.post("teams", input);
  }

  listTeamMembers(teamId: TeamId): Promise<RuntimeTeamMemberRecord[]> {
    return this.get(`teams/${encodeURIComponent(teamId)}/members`);
  }

  addTeamMember(input: AddTeamMemberRequest): Promise<RuntimeTeamMemberRecord> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/members`, input);
  }

  listTeamTasks(teamId: TeamId): Promise<RuntimeTeamTaskRecord[]> {
    return this.get(`teams/${encodeURIComponent(teamId)}/tasks`);
  }

  createTeamTask(input: CreateTeamTaskRequest): Promise<RuntimeTeamTaskRecord> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/tasks`, input);
  }

  assignTeamTask(input: AssignTeamTaskRequest): Promise<RuntimeTeamTaskRecord> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/tasks/${encodeURIComponent(input.taskId)}/assign`, input);
  }

  claimTeamTask(input: ClaimTeamTaskRequest): Promise<RuntimeTeamTaskClaimResult> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/tasks/${encodeURIComponent(input.taskId)}/claim`, input);
  }

  dispatchTeamTask(input: DispatchTeamTaskRequest): Promise<RuntimeTeamTaskDispatchResult> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/tasks/${encodeURIComponent(input.taskId)}/dispatch`, input);
  }

  syncTeamTask(input: SyncTeamTaskRequest): Promise<RuntimeTeamTaskSyncResult> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/tasks/${encodeURIComponent(input.taskId)}/sync`, input);
  }

  reconcileTeamTasks(input: ReconcileTeamTasksRequest = {}): Promise<RuntimeTeamTaskReconcileResult> {
    const path = input.teamId
      ? `teams/${encodeURIComponent(input.teamId)}/reconcile_dispatches`
      : "teams/reconcile_dispatches";
    return this.post(path, input);
  }

  updateTeamTask(input: UpdateTeamTaskRequest): Promise<RuntimeTeamTaskRecord> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/tasks/${encodeURIComponent(input.taskId)}/update`, input);
  }

  listTeamMessages(teamId: TeamId): Promise<RuntimeTeamMessageRecord[]> {
    return this.get(`teams/${encodeURIComponent(teamId)}/messages`);
  }

  sendTeamMessage(input: SendTeamMessageRequest): Promise<RuntimeTeamMessageRecord> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/messages`, input);
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
