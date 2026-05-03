import type {
  ChiliEvent,
  AgentPath,
  AgentMailboxStatus,
  AgentTaskMode,
  AgentTaskStatus,
  Message,
  ApprovalId,
  ApprovalDecisionAction,
  RuntimeApprovalResolveResult,
  RuntimeInterruptResult,
  RuntimeModelConfig,
  RuntimeModelDescriptor,
  RuntimePermissionConfig,
  RuntimePermissionProfileId,
  RuntimePromptCommandInvocation,
  RuntimePromptCommandList,
  RuntimePromptAccepted,
  RuntimePromptResult,
  RuntimeSessionRef,
  RuntimeSkillMention,
  ModelSelection,
  ReasoningLevel,
  SessionId,
  TaskId,
  TeamId,
  TeamMemberStatus,
  TeamMessageDelivery,
  TeamMessageDeliveryStatus,
  TeamMessageKind,
  TeamTaskStatus,
  ThreadId,
} from "@chili/protocol";
import type { RuntimeAgentsSnapshot } from "./projection.js";

export interface RuntimeClient {
  createSession(input?: CreateSessionRequest): Promise<RuntimeSessionRef>;
  listModels(input?: ListModelsRequest): Promise<RuntimeModelDescriptor[]>;
  getModelConfig(input: GetModelConfigRequest): Promise<RuntimeModelConfig>;
  setModel(input: SetModelRequest): Promise<RuntimeModelConfig>;
  setReasoning(input: SetReasoningRequest): Promise<RuntimeModelConfig>;
  getPermissionConfig(input?: GetPermissionConfigRequest): Promise<RuntimePermissionConfig>;
  setPermissionProfile(input: SetPermissionProfileRequest): Promise<RuntimePermissionConfig>;
  listCommands(input?: ListCommandsRequest): Promise<RuntimePromptCommandList>;
  reloadCommands(input?: ReloadCommandsRequest): Promise<RuntimePromptCommandList>;
  submitPrompt(input: SubmitPromptRequest): Promise<RuntimePromptResult>;
  submitPromptAsync(input: SubmitPromptRequest): Promise<RuntimePromptAccepted>;
  submitCommandAsync(input: SubmitCommandRequest): Promise<RuntimePromptAccepted>;
  interruptSession(input: InterruptSessionRequest): Promise<RuntimeInterruptResult>;
  resolveApproval(input: ResolveApprovalRequest): Promise<RuntimeApprovalResolveResult>;
  approveApproval(input: ApproveApprovalRequest): Promise<RuntimeApprovalResolveResult>;
  rejectApproval(input: RejectApprovalRequest): Promise<RuntimeApprovalResolveResult>;
  archiveSession(sessionId: SessionId): Promise<void>;
  listSessions(): Promise<RuntimeSessionSummary[]>;
  listAgents(input?: ListAgentsRequest): Promise<RuntimeAgentsSnapshot>;
  agentTree(input?: AgentTreeRequest): Promise<RuntimeAgentTreeSnapshot>;
  listAgentRuns(input?: ListAgentRunsRequest): Promise<RuntimeAgentRunRecord[]>;
  mailbox(input?: ListMailboxRequest): Promise<RuntimeAgentMailboxRecord[]>;
  consumeMailbox(messageId: string): Promise<RuntimeAgentMailboxRecord>;
  listTeams(): Promise<RuntimeTeamRecord[]>;
  createTeam(input: CreateTeamRequest): Promise<RuntimeTeamRecord>;
  teamSnapshot(teamId: TeamId): Promise<RuntimeTeamSnapshot>;
  listTeamMembers(teamId: TeamId): Promise<RuntimeTeamMemberRecord[]>;
  addTeamMember(input: AddTeamMemberRequest): Promise<RuntimeTeamMemberRecord>;
  listTeamTasks(teamId: TeamId): Promise<RuntimeTeamTaskRecord[]>;
  createTeamTask(input: CreateTeamTaskRequest): Promise<RuntimeTeamTaskRecord>;
  assignTeamTask(input: AssignTeamTaskRequest): Promise<RuntimeTeamTaskRecord>;
  claimTeamTask(input: ClaimTeamTaskRequest): Promise<RuntimeTeamTaskClaimResult>;
  dispatchTeamTask(input: DispatchTeamTaskRequest): Promise<RuntimeTeamTaskDispatchResult>;
  syncTeamTask(input: SyncTeamTaskRequest): Promise<RuntimeTeamTaskSyncResult>;
  reconcileTeamTasks(input?: ReconcileTeamTasksRequest): Promise<RuntimeTeamTaskReconcileResult>;
  mergeTeamTasks(input: MergeTeamTasksRequest): Promise<RuntimeTeamMergeResult>;
  runTeamLoop(input: RunTeamLoopRequest): Promise<RuntimeTeamExecutionRunSummary>;
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
  signal?: AbortSignal;
}

export interface SubmitPromptRequest {
  sessionId: SessionId;
  threadId: ThreadId;
  text: string;
  skillMentions?: RuntimeSkillMention[];
  cwd?: string;
  maxTurns?: number;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  signal?: AbortSignal;
}

export interface ListModelsRequest {
  provider?: string;
}

export interface GetModelConfigRequest {
  sessionId: SessionId;
  signal?: AbortSignal;
}

export interface SetModelRequest {
  sessionId: SessionId;
  threadId?: ThreadId;
  modelSelection: ModelSelection;
  signal?: AbortSignal;
}

export interface SetReasoningRequest {
  sessionId: SessionId;
  threadId?: ThreadId;
  reasoningLevel: ReasoningLevel;
  signal?: AbortSignal;
}

export interface GetPermissionConfigRequest {
  signal?: AbortSignal;
}

export interface SetPermissionProfileRequest {
  profile: RuntimePermissionProfileId;
  signal?: AbortSignal;
}

export interface ListCommandsRequest {
  signal?: AbortSignal;
}

export interface ReloadCommandsRequest {
  signal?: AbortSignal;
}

export interface SubmitCommandRequest extends RuntimePromptCommandInvocation {
  sessionId: SessionId;
  threadId: ThreadId;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  signal?: AbortSignal;
}

export interface InterruptSessionRequest {
  sessionId: SessionId;
  reason?: string;
  signal?: AbortSignal;
}

export interface ResolveApprovalRequest {
  approvalId: ApprovalId;
  decision: ApprovalDecisionAction;
  feedback?: string;
  signal?: AbortSignal;
}

export type ApprovalGrantScope = "once" | "session" | "persistent";

export interface ApproveApprovalRequest {
  approvalId: ApprovalId;
  scope?: ApprovalGrantScope;
  feedback?: string;
  signal?: AbortSignal;
}

export interface RejectApprovalRequest {
  approvalId: ApprovalId;
  feedback?: string;
  signal?: AbortSignal;
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
  delivery?: TeamMessageDelivery;
  deliveryStatus?: TeamMessageDeliveryStatus;
  deliveryError?: string;
  deliveryUpdatedAt?: number;
  deliveredAt?: number;
  taskId?: TaskId;
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface RuntimeTeamMessageDeliveryRecord {
  mailboxMessageId: string;
  teamId: TeamId;
  teamMessageId: string;
  path: AgentPath;
  status: TeamMessageDeliveryStatus;
  triggerTurn: boolean;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  error?: string;
  queuedAt: number;
  updatedAt: number;
  deliveredAt?: number;
}

export interface RuntimeTeamSnapshot {
  team: RuntimeTeamRecord;
  members: RuntimeTeamSnapshotMember[];
  tasks: RuntimeTeamSnapshotTask[];
  messages: RuntimeTeamSnapshotMessage[];
  messageDeliveries: RuntimeTeamMessageDeliveryRecord[];
  stats: RuntimeTeamSnapshotStats;
  generatedAt: number;
}

export interface RuntimeTeamSnapshotMember extends RuntimeTeamMemberRecord {
  taskIds: TaskId[];
  deliveryIds: string[];
  currentTask?: RuntimeTeamTaskRecord;
}

export interface RuntimeTeamSnapshotTask extends RuntimeTeamTaskRecord {
  blockedBy: TaskId[];
  blocks: TaskId[];
  ready: boolean;
  messageIds: string[];
  owner?: RuntimeTeamMemberRecord;
  dispatch?: unknown;
}

export interface RuntimeTeamSnapshotMessage extends RuntimeTeamMessageRecord {
  deliveries: RuntimeTeamMessageDeliveryRecord[];
}

export interface RuntimeTeamSnapshotStats {
  memberCount: number;
  taskCount: number;
  messageCount: number;
  deliveryCount: number;
  membersByStatus: Record<TeamMemberStatus, number>;
  tasksByStatus: Record<TeamTaskStatus, number>;
  messagesByDeliveryStatus: Record<string, number>;
  deliveriesByStatus: Record<string, number>;
  readyTaskIds: TaskId[];
  blockedTaskIds: TaskId[];
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
  messageDelivery?: TeamMessageDelivery;
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
    | "scope_mismatch"
    | "write_conflict";
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

export interface MergeTeamTasksRequest extends TeamRequestContext {
  teamId: TeamId;
  taskId?: TaskId;
  cwd?: string;
  signal?: AbortSignal;
}

export interface RunTeamLoopRequest extends TeamRequestContext {
  teamId: TeamId;
  cwd?: string;
  mode?: AgentTaskMode;
  once?: boolean;
  maxCycles?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export type RuntimeTeamExecutionStopReason = "drained" | "once" | "max_cycles" | "timeout" | "aborted" | "team_inactive";

export type RuntimeTeamExecutionSkipReason =
  | "dependency_incomplete"
  | "missing_owner"
  | "missing_session"
  | "missing_member"
  | "member_unavailable"
  | "scope_mismatch"
  | "write_conflict"
  | "blocked"
  | "already_claimed"
  | "already_resolved"
  | "not_dispatched"
  | "agent_task_not_found"
  | "team_already_final";

export interface RuntimeTeamExecutionDispatchedTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  agentTaskId?: TaskId;
  status: RuntimeTeamTaskDispatchResult["status"];
}

export interface RuntimeTeamExecutionFinalTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  status: Extract<TeamTaskStatus, "completed" | "failed" | "cancelled">;
  summary?: string;
  error?: string;
  agentTaskId?: TaskId;
}

export interface RuntimeTeamExecutionVerificationTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  status: "passed" | "failed";
  feedback?: string;
  verifierTaskId?: TaskId;
}

export interface RuntimeTeamMergeDiffSummary {
  filesChanged: number;
  paths: string[];
  truncatedPaths: boolean;
  diffBytes: number;
}

export interface RuntimeTeamMergeTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  status: "applied" | "failed" | "conflicted";
  diffSummary?: RuntimeTeamMergeDiffSummary | unknown;
  error?: string;
  conflicts?: string[];
}

export type RuntimeTeamMergeSkippedReason = "not_passed" | "missing_merge_metadata" | "not_pending" | "missing_worktree";

export interface RuntimeTeamMergeSkippedTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  reason: RuntimeTeamMergeSkippedReason;
  error?: string;
}

export interface RuntimeTeamExecutionSkippedTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  reason: RuntimeTeamExecutionSkipReason;
  blockedBy?: TaskId[];
}

export interface RuntimeTeamExecutionRunningTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  title: string;
  agentTaskId?: TaskId;
}

export interface RuntimeTeamExecutionError {
  teamId: TeamId;
  taskId?: TaskId;
  error: string;
}

export interface RuntimeTeamExecutionRunSummary {
  teamId: TeamId;
  cycles: number;
  stopReason: RuntimeTeamExecutionStopReason;
  startedAt: number;
  endedAt: number;
  dispatched: RuntimeTeamExecutionDispatchedTask[];
  completed: RuntimeTeamExecutionFinalTask[];
  accepted: RuntimeTeamExecutionFinalTask[];
  reopened: RuntimeTeamExecutionVerificationTask[];
  merged: RuntimeTeamMergeTask[];
  mergeFailed: RuntimeTeamMergeTask[];
  mergeConflicted: RuntimeTeamMergeTask[];
  mergeSkipped: RuntimeTeamMergeSkippedTask[];
  failed: RuntimeTeamExecutionFinalTask[];
  blocked: RuntimeTeamExecutionSkippedTask[];
  skipped: RuntimeTeamExecutionSkippedTask[];
  stillRunning: RuntimeTeamExecutionRunningTask[];
  errors: RuntimeTeamExecutionError[];
}

export interface RuntimeTeamMergeTaskResult {
  status: "applied" | "failed" | "conflicted";
  teamTask: RuntimeTeamTaskRecord;
  diffSummary?: RuntimeTeamMergeDiffSummary;
  error?: string;
  conflicts?: string[];
}

export interface RuntimeTeamMergeTaskSkipped {
  status: "skipped";
  teamTask: RuntimeTeamTaskRecord;
  reason: RuntimeTeamMergeSkippedReason;
  error?: string;
}

export interface RuntimeTeamMergeError {
  teamId: TeamId;
  taskId: TaskId;
  error: string;
}

export interface RuntimeTeamMergeResult {
  scanned: number;
  applied: RuntimeTeamMergeTaskResult[];
  failed: RuntimeTeamMergeTaskResult[];
  conflicted: RuntimeTeamMergeTaskResult[];
  skipped: RuntimeTeamMergeTaskSkipped[];
  errors: RuntimeTeamMergeError[];
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
  delivery?: TeamMessageDelivery;
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
    const { signal, ...body } = input;
    return this.post("sessions", body, signal);
  }

  listModels(input: ListModelsRequest = {}): Promise<RuntimeModelDescriptor[]> {
    const params = new URLSearchParams();
    if (input.provider) params.set("provider", input.provider);
    const query = params.toString();
    return this.get(`models${query ? `?${query}` : ""}`);
  }

  getModelConfig(input: GetModelConfigRequest): Promise<RuntimeModelConfig> {
    return this.get(`sessions/${encodeURIComponent(input.sessionId)}/model`, input.signal);
  }

  setModel(input: SetModelRequest): Promise<RuntimeModelConfig> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/model`, {
      threadId: input.threadId,
      modelSelection: input.modelSelection,
    }, input.signal);
  }

  setReasoning(input: SetReasoningRequest): Promise<RuntimeModelConfig> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/reasoning`, {
      threadId: input.threadId,
      reasoningLevel: input.reasoningLevel,
    }, input.signal);
  }

  getPermissionConfig(input: GetPermissionConfigRequest = {}): Promise<RuntimePermissionConfig> {
    return this.get("permissions", input.signal);
  }

  setPermissionProfile(input: SetPermissionProfileRequest): Promise<RuntimePermissionConfig> {
    return this.post("permissions", { profile: input.profile }, input.signal);
  }

  listCommands(input: ListCommandsRequest = {}): Promise<RuntimePromptCommandList> {
    return this.get("commands", input.signal);
  }

  reloadCommands(input: ReloadCommandsRequest = {}): Promise<RuntimePromptCommandList> {
    return this.post("commands/reload", {}, input.signal);
  }

  submitPrompt(input: SubmitPromptRequest): Promise<RuntimePromptResult> {
    const { signal, ...body } = input;
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/prompt`, body, signal);
  }

  submitPromptAsync(input: SubmitPromptRequest): Promise<RuntimePromptAccepted> {
    const { signal, ...body } = input;
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/prompt_async`, body, signal);
  }

  submitCommandAsync(input: SubmitCommandRequest): Promise<RuntimePromptAccepted> {
    const { signal, ...body } = input;
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/command_async`, body, signal);
  }

  interruptSession(input: InterruptSessionRequest): Promise<RuntimeInterruptResult> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/interrupt`, { reason: input.reason }, input.signal);
  }

  resolveApproval(input: ResolveApprovalRequest): Promise<RuntimeApprovalResolveResult> {
    return this.post(`approvals/${encodeURIComponent(input.approvalId)}/resolve`, {
      decision: input.decision,
      feedback: input.feedback,
    }, input.signal);
  }

  approveApproval(input: ApproveApprovalRequest): Promise<RuntimeApprovalResolveResult> {
    const request: ResolveApprovalRequest = {
      approvalId: input.approvalId,
      decision: approvalDecisionForApproveRequest(input),
    };
    if (input.feedback !== undefined) request.feedback = input.feedback;
    if (input.signal) request.signal = input.signal;
    return this.resolveApproval(request);
  }

  rejectApproval(input: RejectApprovalRequest): Promise<RuntimeApprovalResolveResult> {
    const request: ResolveApprovalRequest = {
      approvalId: input.approvalId,
      decision: "deny",
    };
    if (input.feedback !== undefined) request.feedback = input.feedback;
    if (input.signal) request.signal = input.signal;
    return this.resolveApproval(request);
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

  teamSnapshot(teamId: TeamId): Promise<RuntimeTeamSnapshot> {
    return this.get(`teams/${encodeURIComponent(teamId)}/snapshot`);
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

  mergeTeamTasks(input: MergeTeamTasksRequest): Promise<RuntimeTeamMergeResult> {
    const { signal, ...body } = input;
    return this.post(`teams/${encodeURIComponent(input.teamId)}/merge`, body, signal);
  }

  runTeamLoop(input: RunTeamLoopRequest): Promise<RuntimeTeamExecutionRunSummary> {
    const { signal, ...body } = input;
    return this.post(`teams/${encodeURIComponent(input.teamId)}/run_loop`, body, signal);
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

  private get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const init: RequestInit = { method: "GET" };
    if (signal) init.signal = signal;
    return this.request(path, init);
  }

  private post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    if (signal) init.signal = signal;
    return this.request(path, init);
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

function approvalDecisionForApproveRequest(input: ApproveApprovalRequest): ApprovalDecisionAction {
  if (input.scope === undefined || input.scope === "once") return "allow_once";
  if (input.scope === "session") return "allow_session";
  if (input.scope === "persistent") return "allow_always";
  throw new Error("approval scope must be one of once, session, persistent");
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
