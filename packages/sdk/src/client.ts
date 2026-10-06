import type {
  ChiliEvent,
  RuntimeInputMode,
  RuntimeInputQueue,
  RuntimeSessionInput,
  AgentPath,
  AgentRunId,
  AgentMailboxStatus,
  AgentTaskMode,
  AgentTaskStatus,
  Message,
  MessageImageContent,
  PendingUserInputRequest as ProtocolPendingUserInputRequest,
  ApprovalId,
  ApprovalDecisionAction,
  ApprovalScope,
  DelegationPolicy,
  RuntimeApprovalResolveResult,
  RuntimeInterruptResult,
  RuntimeDelegationConfig,
  RuntimeModelConfig,
  RuntimeModelDescriptor,
  RuntimeMcpAddServerRequest,
  RuntimeMcpAuthRequest,
  RuntimeMcpAuthResponse,
  RuntimeMcpListResponse,
  RuntimeMcpLogoutResponse,
  RuntimeMcpReloadResponse,
  RuntimeMcpRemoveServerResponse,
  RuntimeMcpServerDescriptor,
  RuntimeMcpStatusResponse,
  RuntimeMcpToolsResponse,
  RuntimePermissionConfig,
  RuntimePermissionProfileId,
  RuntimeCommandCatalog,
  RuntimeCommandInvocation,
  RuntimePromptAccepted,
  RuntimePromptResult,
  RuntimeSessionRef,
  RuntimeSkillMention,
  ModelSelection,
  ReasoningLevel,
  ServiceTier,
  SessionId,
  TaskId,
  TeamId,
  TeamMemberStatus,
  TeamMessageDelivery,
  TeamMessageDeliveryStatus,
  TeamMessageKind,
  TeamTaskStatus,
  SessionGoal,
  SessionGoalStatus,
  UserInputAnswers as ProtocolUserInputAnswers,
  UserInputId,
  UserInputQuestion as ProtocolUserInputQuestion,
} from "@chili/protocol";
import {
  normalizePersistedError,
  parseRuntimeInputQueue,
  parseRuntimeSessionInput,
  parseChiliEvent,
  parseChiliEventArray,
  parsePendingUserInputRequestArray,
  parseRuntimeApprovalResolveResult,
  parseRuntimeArray,
  parseRuntimeBoolean,
  parseRuntimeDelegationConfig,
  parseRuntimeEnum,
  parseRuntimeIdentifier,
  parseRuntimeInterruptResult,
  parseRuntimeMcpAuthResponse,
  parseRuntimeMcpListResponse,
  parseRuntimeMcpLogoutResponse,
  parseRuntimeMcpReloadResponse,
  parseRuntimeMcpRemoveServerResponse,
  parseRuntimeMcpServerDescriptor,
  parseRuntimeMcpStatusResponse,
  parseRuntimeMcpToolsResponse,
  parseRuntimeMessageArray,
  parseRuntimeModelConfig,
  parseRuntimeModelDescriptorArray,
  parseRuntimeNonNegativeInteger,
  parseRuntimeObject,
  parseRuntimePermissionConfig,
  parseRuntimePromptAccepted,
  parseRuntimePromptResult,
  parseRuntimeRecord,
  parseRuntimeSessionGoal,
  parseRuntimeSessionRef,
  parseRuntimeString,
  parseRuntimeStringArray,
  type RuntimeParser,
} from "@chili/protocol";
import type { RuntimeAgentsSnapshot } from "./projection.js";

export interface RuntimeClient {
  createSession(input?: CreateSessionRequest): Promise<RuntimeSessionRef>;
  listModels(input?: ListModelsRequest): Promise<RuntimeModelDescriptor[]>;
  getModelConfig(input: GetModelConfigRequest): Promise<RuntimeModelConfig>;
  setModel(input: SetModelRequest): Promise<RuntimeModelConfig>;
  setReasoning(input: SetReasoningRequest): Promise<RuntimeModelConfig>;
  setServiceTier(input: SetServiceTierRequest): Promise<RuntimeModelConfig>;
  getDelegationConfig(input: GetDelegationConfigRequest): Promise<RuntimeDelegationConfig>;
  setDelegationPolicy(input: SetDelegationPolicyRequest): Promise<RuntimeDelegationConfig>;
  getPermissionConfig(input?: GetPermissionConfigRequest): Promise<RuntimePermissionConfig>;
  setPermissionProfile(input: SetPermissionProfileRequest): Promise<RuntimePermissionConfig>;
  getGoal(input: GetGoalRequest): Promise<SessionGoal | undefined>;
  setGoal(input: SetGoalRequest): Promise<SessionGoal>;
  updateGoal(input: UpdateGoalRequest): Promise<SessionGoal>;
  clearGoal(input: ClearGoalRequest): Promise<ClearGoalResult>;
  listCommands(input?: ListCommandsRequest): Promise<RuntimeCommandCatalog>;
  reloadCommands(input?: ReloadCommandsRequest): Promise<RuntimeCommandCatalog>;
  listMcpServers(input?: ListMcpServersRequest): Promise<RuntimeMcpListResponse>;
  mcpStatus(input?: McpStatusRequest): Promise<RuntimeMcpStatusResponse>;
  mcpServer(input: McpServerRequest): Promise<RuntimeMcpServerDescriptor>;
  reloadMcp(input?: ReloadMcpRequest): Promise<RuntimeMcpReloadResponse>;
  connectMcpServer(input: McpServerRequest): Promise<RuntimeMcpServerDescriptor>;
  disconnectMcpServer(input: McpServerRequest): Promise<RuntimeMcpServerDescriptor>;
  addMcpServer(input: AddMcpServerRequest): Promise<RuntimeMcpServerDescriptor>;
  removeMcpServer(input: RemoveMcpServerRequest): Promise<RuntimeMcpRemoveServerResponse>;
  listMcpTools(input: ListMcpToolsRequest): Promise<RuntimeMcpToolsResponse>;
  authMcpServer(input: AuthMcpServerRequest): Promise<RuntimeMcpAuthResponse>;
  logoutMcpServer(input: LogoutMcpServerRequest): Promise<RuntimeMcpLogoutResponse>;
  submitPrompt(input: SubmitPromptRequest): Promise<RuntimePromptResult>;
  submitPromptAsync(input: SubmitPromptRequest): Promise<RuntimePromptAccepted>;
  inputQueue(input: { sessionId: SessionId; signal?: AbortSignal }): Promise<RuntimeInputQueue>;
  getInput(input: { sessionId: SessionId; submissionId: string; signal?: AbortSignal }): Promise<RuntimeSessionInput | undefined>;
  resumeInputs(input: { sessionId: SessionId; signal?: AbortSignal }): Promise<RuntimeInputQueue>;
  cancelInput(input: { sessionId: SessionId; inputId: string; expectedRevision: number; signal?: AbortSignal }): Promise<RuntimeInputQueue>;
  cancelInputsFromSource(input: { sessionId: SessionId; source: string; signal?: AbortSignal }): Promise<RuntimeInputQueue>;
  submitCommand(input: SubmitCommandRequest): Promise<RuntimePromptResult>;
  submitCommandAsync(input: SubmitCommandRequest): Promise<RuntimePromptAccepted>;
  interruptSession(input: InterruptSessionRequest): Promise<RuntimeInterruptResult>;
  resolveApproval(input: ResolveApprovalRequest): Promise<RuntimeApprovalResolveResult>;
  approveApproval(input: ApproveApprovalRequest): Promise<RuntimeApprovalResolveResult>;
  rejectApproval(input: RejectApprovalRequest): Promise<RuntimeApprovalResolveResult>;
  listPendingApprovals?(input?: ListPendingApprovalsRequest): Promise<RuntimePendingApprovalRequest[]>;
  pendingApprovalWindow?(input?: ListPendingApprovalsRequest): Promise<RuntimePendingApprovalWindow>;
  listUserInputs(input?: ListUserInputsRequest): Promise<RuntimeUserInputRequest[]>;
  pendingUserInputs(input?: ListUserInputsRequest): Promise<RuntimeUserInputRequest[]>;
  resolveUserInput(input: ResolveUserInputRequest): Promise<RuntimeUserInputResolveResult>;
  archiveSession(sessionId: SessionId): Promise<void>;
  listSessions(input?: { signal?: AbortSignal }): Promise<RuntimeSessionSummary[]>;
  sessionEvents(input: SessionEventsRequest): Promise<ChiliEvent[]>;
  /** Dependency-complete bounded replay window with explicit truncation metadata. */
  sessionEventWindow?(input: SessionEventsRequest): Promise<RuntimeSessionEventWindow>;
  renameSession(input: RenameSessionRequest): Promise<RuntimeSessionSummary>;
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
  cwd?: string;
  signal?: AbortSignal;
}

export interface SubmitPromptRequest {
  submissionId?: string;
  mode?: RuntimeInputMode;
  expectedExecutionRef?: string;
  inputSource?: string;
  sessionId: SessionId;
  text: string;
  displayText?: string;
  images?: MessageImageContent[];
  skillMentions?: RuntimeSkillMention[];
  cwd?: string;
  maxTurns?: number;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
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
  modelSelection: ModelSelection;
  signal?: AbortSignal;
}

export interface SetReasoningRequest {
  sessionId: SessionId;
  reasoningLevel: ReasoningLevel;
  signal?: AbortSignal;
}

export interface SetServiceTierRequest {
  sessionId: SessionId;
  serviceTier: ServiceTier;
  signal?: AbortSignal;
}

export interface GetDelegationConfigRequest {
  sessionId: SessionId;
  signal?: AbortSignal;
}

export interface SetDelegationPolicyRequest {
  sessionId: SessionId;
  policy: DelegationPolicy;
  signal?: AbortSignal;
}

export interface GetPermissionConfigRequest {
  signal?: AbortSignal;
}

export interface SetPermissionProfileRequest {
  profile: RuntimePermissionProfileId;
  signal?: AbortSignal;
}

export interface GetGoalRequest {
  sessionId: SessionId;
  signal?: AbortSignal;
}

export interface SetGoalRequest {
  sessionId: SessionId;
  objective: string;
  tokenBudget?: number;
  replace?: boolean;
  signal?: AbortSignal;
}

export interface UpdateGoalRequest {
  sessionId: SessionId;
  status?: SessionGoalStatus;
  objective?: string;
  tokenBudget?: number;
  signal?: AbortSignal;
}

export interface ClearGoalRequest {
  sessionId: SessionId;
  signal?: AbortSignal;
}

export interface ClearGoalResult {
  cleared: boolean;
  previousGoal?: SessionGoal;
}

export interface ListCommandsRequest {
  sessionId?: SessionId;
  signal?: AbortSignal;
}

export interface ReloadCommandsRequest {
  sessionId?: SessionId;
  signal?: AbortSignal;
}

export interface ListMcpServersRequest {
  sessionId?: SessionId;
  signal?: AbortSignal;
}

export interface McpStatusRequest {
  sessionId?: SessionId;
  signal?: AbortSignal;
}

export interface McpServerRequest {
  server: string;
  sessionId?: SessionId;
  signal?: AbortSignal;
}

export interface ReloadMcpRequest {
  sessionId?: SessionId;
  signal?: AbortSignal;
}

export interface AddMcpServerRequest extends RuntimeMcpAddServerRequest {
  signal?: AbortSignal;
}

export interface RemoveMcpServerRequest {
  server: string;
  signal?: AbortSignal;
}

export interface ListMcpToolsRequest {
  server: string;
  sessionId?: SessionId;
  signal?: AbortSignal;
}

export interface AuthMcpServerRequest extends RuntimeMcpAuthRequest {
  server: string;
  sessionId?: SessionId;
  signal?: AbortSignal;
}

export interface LogoutMcpServerRequest {
  server: string;
  sessionId?: SessionId;
  signal?: AbortSignal;
}

export interface SubmitCommandRequest extends RuntimeCommandInvocation {
  submissionId?: string;
  mode?: RuntimeInputMode;
  sessionId: SessionId;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  signal?: AbortSignal;
}

export interface InterruptSessionRequest {
  expectedExecutionRef?: string;
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

export type RuntimeUserInputQuestion = ProtocolUserInputQuestion;
export type RuntimeUserInputAnswers = ProtocolUserInputAnswers;
export type RuntimeUserInputRequest = ProtocolPendingUserInputRequest;

export interface ListUserInputsRequest {
  sessionId?: SessionId;
  signal?: AbortSignal;
}

export interface ResolveUserInputRequest {
  inputId: UserInputId;
  answers: RuntimeUserInputAnswers;
  signal?: AbortSignal;
}

export interface RuntimeUserInputResolveResult {
  resolved: boolean;
}

export type ApprovalGrantScope = ApprovalScope;

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
  preview?: string;
  source?: "interactive" | "subagent";
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
}

export interface SessionEventsRequest {
  sessionId: SessionId;
  limit?: number;
  signal?: AbortSignal;
}

export interface ListPendingApprovalsRequest {
  sessionId?: SessionId;
  signal?: AbortSignal;
}

export interface RuntimePendingApprovalRequest {
  id: string;
  sessionId?: SessionId;
  callId?: string;
  permission: string;
  patterns: string[];
  maxApprovalScope?: ApprovalScope;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface RuntimePendingApprovalWindow {
  approvals: RuntimePendingApprovalRequest[];
  truncated: boolean;
  /** Exact UTF-8 bytes of JSON.stringify(approvals). */
  bytes: number;
  warning?: string;
}

export interface RuntimeSessionEventWindow {
  events: ChiliEvent[];
  /** Authoritative replacement set; never infer pending state from omitted history. */
  pendingApprovals: RuntimePendingApprovalRequest[];
  truncated: boolean;
  /** Exact UTF-8 bytes of JSON.stringify(events). */
  bytes: number;
  pinnedEventIds: string[];
  warning?: string;
}

export interface RenameSessionRequest {
  sessionId: SessionId;
  title: string;
  signal?: AbortSignal;
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
  runIds: AgentRunId[];
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
  id: AgentRunId;
  sessionId?: SessionId;
  taskId?: TaskId;
  path: AgentPath;
  parentPath?: AgentPath;
  parentSessionId?: SessionId;
  childSessionId?: SessionId;
  taskName: string;
  cwd?: string;
  mode?: AgentTaskMode;
  status: "running" | "completed" | "incomplete" | "failed" | "cancelled";
  createdAt: number;
  completedAt?: number;
}

export interface ListMailboxRequest {
  messageId?: string;
  taskId?: TaskId;
  path?: AgentPath;
  recipientSessionId?: SessionId;
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
  recipientSessionId?: SessionId;
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
  runId: AgentRunId;
  path: AgentPath;
  parentPath: AgentPath;
  childSessionId: SessionId;
  status: AgentTaskStatus;
  summary?: string;
  error?: string;
}

export interface RuntimeTeamTaskDispatchResult {
  status: "running" | "completed" | "incomplete" | "failed" | "cancelled" | "skipped";
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
  maxConcurrentDispatches?: number;
  maxConcurrentVerifications?: number;
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
  childSessionId?: SessionId;
  cwd?: string;
  prompt?: string;
  mode?: AgentTaskMode;
  currentRunId?: AgentRunId;
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
  status?: Extract<AgentTaskStatus, "completed" | "incomplete" | "failed" | "cancelled">;
  summary?: string;
  error?: string;
  interrupt?: boolean;
}

export interface ReconcileStaleTasksRequest {
  parentSessionId?: SessionId;
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
  afterEventId?: string;
  signal?: AbortSignal;
}

export class EventCursorResyncRequiredError extends Error {
  readonly code = "EVENT_CURSOR_RESYNC_REQUIRED";
  readonly status = 409;

  constructor(
    message: string,
    readonly afterEventId: string,
  ) {
    super(message);
    this.name = "EventCursorResyncRequiredError";
  }
}

export function isEventCursorResyncRequiredError(error: unknown): error is EventCursorResyncRequiredError {
  return error instanceof EventCursorResyncRequiredError;
}

export class EventTransportResyncRequiredError extends Error {
  readonly code = "EVENT_TRANSPORT_RESYNC_REQUIRED";

  constructor(
    message: string,
    readonly resumeAfterEventId: string,
  ) {
    super(message);
    this.name = "EventTransportResyncRequiredError";
  }
}

export function isEventTransportResyncRequiredError(error: unknown): error is EventTransportResyncRequiredError {
  return error instanceof EventTransportResyncRequiredError;
}

export interface HttpRuntimeClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Bearer token used by authenticated runtime HTTP servers. */
  authToken?: string;
}

export class HttpRuntimeClient implements RuntimeClient {
  private readonly fetchImpl: typeof fetch;
  #baseUrl: URL;
  #authorization?: string;

  constructor(options: HttpRuntimeClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    if (typeof options.baseUrl !== "string" || options.baseUrl.length === 0
      || /[\u0000-\u001f\u007f]/u.test(options.baseUrl)) {
      throw new TypeError("baseUrl must be a credential-free absolute HTTP(S) URL");
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch {
      throw new TypeError("baseUrl must be a credential-free absolute HTTP(S) URL");
    }
    if ((baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") || baseUrl.username || baseUrl.password
      || baseUrl.search || baseUrl.hash) {
      throw new TypeError("baseUrl must be a credential-free absolute HTTP(S) URL");
    }
    if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
    this.#baseUrl = baseUrl;
    if (options.authToken !== undefined) {
      if (typeof options.authToken !== "string" || options.authToken.length === 0
        || /[\s\u0000-\u001f\u007f]/u.test(options.authToken)) {
        throw new TypeError("authToken must be a non-empty string without whitespace when provided");
      }
      if (baseUrl.protocol === "http:" && !isLoopbackUrlHostname(baseUrl.hostname)) {
        throw new TypeError("authToken requires HTTPS for a non-loopback runtime server");
      }
      this.#authorization = `Bearer ${options.authToken}`;
    }
  }

  createSession(input: CreateSessionRequest = {}): Promise<RuntimeSessionRef> {
    const { signal, ...body } = input;
    return this.post("sessions", body, signal, parseRuntimeSessionRef);
  }

  listModels(input: ListModelsRequest = {}): Promise<RuntimeModelDescriptor[]> {
    const params = new URLSearchParams();
    if (input.provider) params.set("provider", input.provider);
    const query = params.toString();
    return this.get(`models${query ? `?${query}` : ""}`, undefined, parseRuntimeModelDescriptorArray);
  }

  getModelConfig(input: GetModelConfigRequest): Promise<RuntimeModelConfig> {
    return this.get(`sessions/${encodeURIComponent(input.sessionId)}/model`, input.signal, parseRuntimeModelConfig);
  }

  setModel(input: SetModelRequest): Promise<RuntimeModelConfig> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/model`, {
      modelSelection: input.modelSelection,
    }, input.signal, parseRuntimeModelConfig);
  }

  setReasoning(input: SetReasoningRequest): Promise<RuntimeModelConfig> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/reasoning`, {
      reasoningLevel: input.reasoningLevel,
    }, input.signal, parseRuntimeModelConfig);
  }

  setServiceTier(input: SetServiceTierRequest): Promise<RuntimeModelConfig> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/service-tier`, {
      serviceTier: input.serviceTier,
    }, input.signal, parseRuntimeModelConfig);
  }

  getDelegationConfig(input: GetDelegationConfigRequest): Promise<RuntimeDelegationConfig> {
    return this.get(`sessions/${encodeURIComponent(input.sessionId)}/delegation`, input.signal, parseRuntimeDelegationConfig);
  }

  setDelegationPolicy(input: SetDelegationPolicyRequest): Promise<RuntimeDelegationConfig> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/delegation`, {
      policy: input.policy,
    }, input.signal, parseRuntimeDelegationConfig);
  }

  getPermissionConfig(input: GetPermissionConfigRequest = {}): Promise<RuntimePermissionConfig> {
    return this.get("permissions", input.signal, parseRuntimePermissionConfig);
  }

  setPermissionProfile(input: SetPermissionProfileRequest): Promise<RuntimePermissionConfig> {
    return this.post("permissions", { profile: input.profile }, input.signal, parseRuntimePermissionConfig);
  }

  getGoal(input: GetGoalRequest): Promise<SessionGoal | undefined> {
    return this.get(`sessions/${encodeURIComponent(input.sessionId)}/goal`, input.signal, parseRuntimeSessionGoal, true);
  }

  setGoal(input: SetGoalRequest): Promise<SessionGoal> {
    const { sessionId, signal, ...body } = input;
    return this.post(`sessions/${encodeURIComponent(sessionId)}/goal`, body, signal, parseRuntimeSessionGoal);
  }

  updateGoal(input: UpdateGoalRequest): Promise<SessionGoal> {
    const { sessionId, signal, ...body } = input;
    return this.patch(`sessions/${encodeURIComponent(sessionId)}/goal`, body, signal, parseRuntimeSessionGoal);
  }

  clearGoal(input: ClearGoalRequest): Promise<ClearGoalResult> {
    return this.delete(`sessions/${encodeURIComponent(input.sessionId)}/goal`, input.signal, parseClearGoalResult);
  }

  listCommands(input: ListCommandsRequest = {}): Promise<RuntimeCommandCatalog> {
    const path = input.sessionId === undefined
      ? "commands"
      : `sessions/${encodeURIComponent(commandCatalogSessionId(input.sessionId))}/commands`;
    return this.get(path, input.signal, parseRuntimeCommandCatalog);
  }

  reloadCommands(input: ReloadCommandsRequest = {}): Promise<RuntimeCommandCatalog> {
    const path = input.sessionId === undefined
      ? "commands/reload"
      : `sessions/${encodeURIComponent(commandCatalogSessionId(input.sessionId))}/commands/reload`;
    return this.post(path, {}, input.signal, parseRuntimeCommandCatalog);
  }

  listMcpServers(input: ListMcpServersRequest = {}): Promise<RuntimeMcpListResponse> {
    return this.get(sessionScopedRequestPath("mcp", input.sessionId), input.signal, parseRuntimeMcpListResponse);
  }

  mcpStatus(input: McpStatusRequest = {}): Promise<RuntimeMcpStatusResponse> {
    return this.get(sessionScopedRequestPath("mcp/status", input.sessionId), input.signal, parseRuntimeMcpStatusResponse);
  }

  mcpServer(input: McpServerRequest): Promise<RuntimeMcpServerDescriptor> {
    return this.get(sessionScopedRequestPath(`mcp/${encodeURIComponent(input.server)}`, input.sessionId), input.signal, parseRuntimeMcpServerDescriptor);
  }

  reloadMcp(input: ReloadMcpRequest = {}): Promise<RuntimeMcpReloadResponse> {
    return this.post(sessionScopedRequestPath("mcp/reload", input.sessionId), {}, input.signal, parseRuntimeMcpReloadResponse);
  }

  connectMcpServer(input: McpServerRequest): Promise<RuntimeMcpServerDescriptor> {
    return this.post(sessionScopedRequestPath(`mcp/${encodeURIComponent(input.server)}/connect`, input.sessionId), {}, input.signal, parseRuntimeMcpServerDescriptor);
  }

  disconnectMcpServer(input: McpServerRequest): Promise<RuntimeMcpServerDescriptor> {
    return this.post(sessionScopedRequestPath(`mcp/${encodeURIComponent(input.server)}/disconnect`, input.sessionId), {}, input.signal, parseRuntimeMcpServerDescriptor);
  }

  addMcpServer(input: AddMcpServerRequest): Promise<RuntimeMcpServerDescriptor> {
    const { signal, ...body } = input;
    return this.post("mcp", body, signal, parseRuntimeMcpServerDescriptor);
  }

  removeMcpServer(input: RemoveMcpServerRequest): Promise<RuntimeMcpRemoveServerResponse> {
    return this.delete(`mcp/${encodeURIComponent(input.server)}`, input.signal, parseRuntimeMcpRemoveServerResponse);
  }

  listMcpTools(input: ListMcpToolsRequest): Promise<RuntimeMcpToolsResponse> {
    return this.get(sessionScopedRequestPath(`mcp/${encodeURIComponent(input.server)}/tools`, input.sessionId), input.signal, parseRuntimeMcpToolsResponse);
  }

  authMcpServer(input: AuthMcpServerRequest): Promise<RuntimeMcpAuthResponse> {
    const { server, signal, sessionId, ...body } = input;
    return this.post(sessionScopedRequestPath(`mcp/${encodeURIComponent(server)}/auth`, sessionId), body, signal, parseRuntimeMcpAuthResponse);
  }

  logoutMcpServer(input: LogoutMcpServerRequest): Promise<RuntimeMcpLogoutResponse> {
    return this.post(sessionScopedRequestPath(`mcp/${encodeURIComponent(input.server)}/logout`, input.sessionId), {}, input.signal, parseRuntimeMcpLogoutResponse);
  }

  submitPrompt(input: SubmitPromptRequest): Promise<RuntimePromptResult> {
    const { sessionId, signal, ...body } = input;
    return this.post(`sessions/${encodeURIComponent(sessionId)}/prompt`, body, signal, parseRuntimePromptResult);
  }

  submitPromptAsync(input: SubmitPromptRequest): Promise<RuntimePromptAccepted> {
    const { sessionId, signal, ...body } = input;
    return this.post(`sessions/${encodeURIComponent(sessionId)}/prompt_async`, body, signal, parseRuntimePromptAccepted);
  }

  inputQueue(input: { sessionId: SessionId; signal?: AbortSignal }): Promise<RuntimeInputQueue> {
    return this.get(`sessions/${encodeURIComponent(input.sessionId)}/input_queue`, input.signal, parseRuntimeInputQueue);
  }

  getInput(input: { sessionId: SessionId; submissionId: string; signal?: AbortSignal }): Promise<RuntimeSessionInput | undefined> {
    return this.get(`sessions/${encodeURIComponent(input.sessionId)}/input_queue?submissionId=${encodeURIComponent(input.submissionId)}`, input.signal, (value) => {
      const record = parseRuntimeRecord(value);
      return record.input === null ? undefined : parseRuntimeSessionInput(record.input);
    });
  }

  resumeInputs(input: { sessionId: SessionId; signal?: AbortSignal }): Promise<RuntimeInputQueue> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/resume_inputs`, {}, input.signal, parseRuntimeInputQueue);
  }

  cancelInput(input: { sessionId: SessionId; inputId: string; expectedRevision: number; signal?: AbortSignal }): Promise<RuntimeInputQueue> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/cancel_input`, { inputId: input.inputId, expectedRevision: input.expectedRevision }, input.signal, parseRuntimeInputQueue);
  }

  cancelInputsFromSource(input: { sessionId: SessionId; source: string; signal?: AbortSignal }): Promise<RuntimeInputQueue> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/cancel_input_source`, { source: input.source }, input.signal, parseRuntimeInputQueue);
  }

  submitCommand(input: SubmitCommandRequest): Promise<RuntimePromptResult> {
    const { sessionId, signal, ...body } = input;
    return this.post(`sessions/${encodeURIComponent(sessionId)}/command`, body, signal, parseRuntimePromptResult);
  }

  submitCommandAsync(input: SubmitCommandRequest): Promise<RuntimePromptAccepted> {
    const { sessionId, signal, ...body } = input;
    return this.post(`sessions/${encodeURIComponent(sessionId)}/command_async`, body, signal, parseRuntimePromptAccepted);
  }

  interruptSession(input: InterruptSessionRequest): Promise<RuntimeInterruptResult> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/interrupt`, { reason: input.reason, expectedExecutionRef: input.expectedExecutionRef }, input.signal, parseRuntimeInterruptResult);
  }

  resolveApproval(input: ResolveApprovalRequest): Promise<RuntimeApprovalResolveResult> {
    return this.post(`approvals/${encodeURIComponent(input.approvalId)}/resolve`, {
      decision: input.decision,
      feedback: input.feedback,
    }, input.signal, parseRuntimeApprovalResolveResult);
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

  listPendingApprovals(input: ListPendingApprovalsRequest = {}): Promise<RuntimePendingApprovalRequest[]> {
    const params = new URLSearchParams();
    if (input.sessionId) params.set("sessionId", input.sessionId);
    const query = params.toString();
    return this.get(`approvals${query ? `?${query}` : ""}`, input.signal, parsePendingApprovalArray);
  }

  pendingApprovalWindow(input: ListPendingApprovalsRequest = {}): Promise<RuntimePendingApprovalWindow> {
    const params = new URLSearchParams({ window: "bounded" });
    if (input.sessionId) params.set("sessionId", input.sessionId);
    return this.get(`approvals?${params.toString()}`, input.signal, parsePendingApprovalWindow);
  }

  listUserInputs(input: ListUserInputsRequest = {}): Promise<RuntimeUserInputRequest[]> {
    return this.get(sessionScopedRequestPath("user-inputs", input.sessionId), input.signal, parsePendingUserInputRequestArray);
  }

  pendingUserInputs(input: ListUserInputsRequest = {}): Promise<RuntimeUserInputRequest[]> {
    return this.listUserInputs(input);
  }

  resolveUserInput(input: ResolveUserInputRequest): Promise<RuntimeUserInputResolveResult> {
    return this.post(`user-inputs/${encodeURIComponent(input.inputId)}/resolve`, {
      answers: input.answers,
    }, input.signal, parseUserInputResolveResult);
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.post(`sessions/${encodeURIComponent(sessionId)}/archive`, {}, undefined, undefined, true);
  }

  listSessions(input: { signal?: AbortSignal } = {}): Promise<RuntimeSessionSummary[]> {
    return this.get("sessions", input.signal, parseRuntimeSessionSummaryArray);
  }

  sessionEvents(input: SessionEventsRequest): Promise<ChiliEvent[]> {
    const params = new URLSearchParams();
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const query = params.toString();
    return this.get(`sessions/${encodeURIComponent(input.sessionId)}/events${query ? `?${query}` : ""}`, input.signal, parseChiliEventArray);
  }

  sessionEventWindow(input: SessionEventsRequest): Promise<RuntimeSessionEventWindow> {
    const params = new URLSearchParams({ window: "replayable" });
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    return this.get(
      `sessions/${encodeURIComponent(input.sessionId)}/events?${params.toString()}`,
      input.signal,
      parseSessionEventWindow,
    );
  }

  renameSession(input: RenameSessionRequest): Promise<RuntimeSessionSummary> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/rename`, { title: input.title }, input.signal, parseRuntimeSessionSummary);
  }

  listAgents(input: ListAgentsRequest = {}): Promise<RuntimeAgentsSnapshot> {
    if (input.sessionId) return this.get(`sessions/${encodeURIComponent(input.sessionId)}/agents`, undefined, parseRuntimeAgentsSnapshot);
    return this.get("agents", undefined, parseRuntimeAgentsSnapshot);
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
    return this.get(`agents/tree${query ? `?${query}` : ""}`, undefined, parseAgentTreeSnapshot);
  }

  listAgentRuns(input: ListAgentRunsRequest = {}): Promise<RuntimeAgentRunRecord[]> {
    const params = new URLSearchParams();
    if (input.path) params.set("path", input.path);
    if (input.sessionId) params.set("sessionId", input.sessionId);
    if (input.childSessionId) params.set("childSessionId", input.childSessionId);
    if (input.status) params.set("status", input.status);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const query = params.toString();
    return this.get(`agent_runs${query ? `?${query}` : ""}`, undefined, parseAgentRunArray);
  }

  mailbox(input: ListMailboxRequest = {}): Promise<RuntimeAgentMailboxRecord[]> {
    const params = new URLSearchParams();
    if (input.messageId) params.set("messageId", input.messageId);
    if (input.taskId) params.set("taskId", input.taskId);
    if (input.path) params.set("path", input.path);
    if (input.recipientSessionId) params.set("recipientSessionId", input.recipientSessionId);
    if (input.status) params.set("status", input.status);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const query = params.toString();
    return this.get(`mailbox${query ? `?${query}` : ""}`, undefined, parseAgentMailboxArray);
  }

  consumeMailbox(messageId: string): Promise<RuntimeAgentMailboxRecord> {
    return this.post(`mailbox/${encodeURIComponent(messageId)}/consume`, {}, undefined, parseAgentMailboxRecord);
  }

  listTeams(): Promise<RuntimeTeamRecord[]> {
    return this.get("teams", undefined, parseTeamRecordArray);
  }

  createTeam(input: CreateTeamRequest): Promise<RuntimeTeamRecord> {
    return this.post("teams", input, undefined, parseTeamRecord);
  }

  teamSnapshot(teamId: TeamId): Promise<RuntimeTeamSnapshot> {
    return this.get(`teams/${encodeURIComponent(teamId)}/snapshot`, undefined, parseTeamSnapshot);
  }

  listTeamMembers(teamId: TeamId): Promise<RuntimeTeamMemberRecord[]> {
    return this.get(`teams/${encodeURIComponent(teamId)}/members`, undefined, parseTeamMemberArray);
  }

  addTeamMember(input: AddTeamMemberRequest): Promise<RuntimeTeamMemberRecord> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/members`, input, undefined, parseTeamMemberRecord);
  }

  listTeamTasks(teamId: TeamId): Promise<RuntimeTeamTaskRecord[]> {
    return this.get(`teams/${encodeURIComponent(teamId)}/tasks`, undefined, parseTeamTaskArray);
  }

  createTeamTask(input: CreateTeamTaskRequest): Promise<RuntimeTeamTaskRecord> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/tasks`, input, undefined, parseTeamTaskRecord);
  }

  assignTeamTask(input: AssignTeamTaskRequest): Promise<RuntimeTeamTaskRecord> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/tasks/${encodeURIComponent(input.taskId)}/assign`, input, undefined, parseTeamTaskRecord);
  }

  claimTeamTask(input: ClaimTeamTaskRequest): Promise<RuntimeTeamTaskClaimResult> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/tasks/${encodeURIComponent(input.taskId)}/claim`, input, undefined, parseTeamTaskClaimResult);
  }

  dispatchTeamTask(input: DispatchTeamTaskRequest): Promise<RuntimeTeamTaskDispatchResult> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/tasks/${encodeURIComponent(input.taskId)}/dispatch`, input, undefined, parseTeamTaskDispatchResult);
  }

  syncTeamTask(input: SyncTeamTaskRequest): Promise<RuntimeTeamTaskSyncResult> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/tasks/${encodeURIComponent(input.taskId)}/sync`, input, undefined, parseTeamTaskSyncResult);
  }

  reconcileTeamTasks(input: ReconcileTeamTasksRequest = {}): Promise<RuntimeTeamTaskReconcileResult> {
    const path = input.teamId
      ? `teams/${encodeURIComponent(input.teamId)}/reconcile_dispatches`
      : "teams/reconcile_dispatches";
    return this.post(path, input, undefined, parseTeamTaskReconcileResult);
  }

  mergeTeamTasks(input: MergeTeamTasksRequest): Promise<RuntimeTeamMergeResult> {
    const { signal, ...body } = input;
    return this.post(`teams/${encodeURIComponent(input.teamId)}/merge`, body, signal, parseTeamMergeResult);
  }

  runTeamLoop(input: RunTeamLoopRequest): Promise<RuntimeTeamExecutionRunSummary> {
    const { signal, ...body } = input;
    return this.post(`teams/${encodeURIComponent(input.teamId)}/run_loop`, body, signal, parseTeamExecutionRunSummary);
  }

  updateTeamTask(input: UpdateTeamTaskRequest): Promise<RuntimeTeamTaskRecord> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/tasks/${encodeURIComponent(input.taskId)}/update`, input, undefined, parseTeamTaskRecord);
  }

  listTeamMessages(teamId: TeamId): Promise<RuntimeTeamMessageRecord[]> {
    return this.get(`teams/${encodeURIComponent(teamId)}/messages`, undefined, parseTeamMessageArray);
  }

  sendTeamMessage(input: SendTeamMessageRequest): Promise<RuntimeTeamMessageRecord> {
    return this.post(`teams/${encodeURIComponent(input.teamId)}/messages`, input, undefined, parseTeamMessageRecord);
  }

  listTasks(input: ListTasksRequest = {}): Promise<RuntimeAgentTaskRecord[]> {
    const params = new URLSearchParams();
    if (input.status) params.set("status", input.status);
    if (input.parentSessionId) params.set("parentSessionId", input.parentSessionId);
    if (input.childSessionId) params.set("childSessionId", input.childSessionId);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const query = params.toString();
    return this.get(`tasks${query ? `?${query}` : ""}`, undefined, parseAgentTaskArray);
  }

  task(taskId: TaskId): Promise<RuntimeAgentTaskRecord> {
    return this.get(`tasks/${encodeURIComponent(taskId)}`, undefined, parseAgentTaskRecord);
  }

  followupTask(input: FollowupTaskRequest): Promise<RuntimeTaskFollowupResult> {
    return this.post(`tasks/${encodeURIComponent(input.taskId)}/followup`, {
      text: input.text,
      maxTurns: input.maxTurns,
    }, undefined, parseTaskFollowupResult);
  }

  waitTask(input: WaitTaskRequest): Promise<RuntimeAgentTaskRecord> {
    return this.post(`tasks/${encodeURIComponent(input.taskId)}/wait`, {
      timeoutMs: input.timeoutMs,
    }, undefined, parseAgentTaskRecord);
  }

  closeTask(input: CloseTaskRequest): Promise<RuntimeAgentTaskRecord> {
    return this.post(`tasks/${encodeURIComponent(input.taskId)}/close`, {
      status: input.status,
      summary: input.summary,
      error: input.error,
      interrupt: input.interrupt,
    }, undefined, parseAgentTaskRecord);
  }

  reconcileStaleTasks(input: ReconcileStaleTasksRequest = {}): Promise<RuntimeTaskReconcileStaleResult> {
    return this.post("tasks/reconcile_stale", input, undefined, parseTaskReconcileStaleResult);
  }

  messages(sessionId: SessionId): Promise<Message[]> {
    return this.get(`sessions/${encodeURIComponent(sessionId)}/messages`, undefined, parseRuntimeMessageArray);
  }

  async *streamEvents(input: StreamEventsRequest = {}): AsyncIterable<ChiliEvent> {
    const url = this.url("events");
    if (input.sessionId) url.searchParams.set("sessionId", input.sessionId);
    if (input.afterEventId) url.searchParams.set("afterEventId", input.afterEventId);

    const init: RequestInit = {
      headers: { accept: "text/event-stream" },
    };
    if (this.#authorization) {
      init.headers = { ...init.headers, authorization: this.#authorization };
    }
    if (input.signal) init.signal = input.signal;
    const response = await this.fetchImpl(url, init);
    if (!response.ok || !response.body) {
      const error = await responseError(response, this.#authorization);
      if (response.status === 409 && input.afterEventId) {
        throw new EventCursorResyncRequiredError(error.message, input.afterEventId);
      }
      throw error;
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      throw new TypeError("Runtime event stream must use a text/event-stream content type");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          buffer += decoder.decode();
          if (buffer.trim().length > 0) {
            if (new TextEncoder().encode(buffer).byteLength > MAX_SSE_CLIENT_BUFFER_BYTES) {
              throw new TypeError(`Runtime SSE frame exceeds ${MAX_SSE_CLIENT_BUFFER_BYTES} bytes`);
            }
            const parsed = parseSseFrame(buffer, this.#authorization);
            if (parsed?.kind === "resync") {
              throw new EventTransportResyncRequiredError(parsed.message, parsed.afterEventId);
            }
            if (parsed) yield parsed.event;
          }
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });

        while (true) {
          const boundary = sseFrameBoundary(buffer);
          if (!boundary) break;
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          if (new TextEncoder().encode(frame).byteLength > MAX_SSE_CLIENT_BUFFER_BYTES) {
            throw new TypeError(`Runtime SSE frame exceeds ${MAX_SSE_CLIENT_BUFFER_BYTES} bytes`);
          }
          const parsed = parseSseFrame(frame, this.#authorization);
          if (parsed?.kind === "resync") {
            throw new EventTransportResyncRequiredError(parsed.message, parsed.afterEventId);
          }
          if (parsed) yield parsed.event;
        }
        if (new TextEncoder().encode(buffer).byteLength > MAX_SSE_CLIENT_BUFFER_BYTES) {
          throw new TypeError(`Runtime SSE frame exceeds ${MAX_SSE_CLIENT_BUFFER_BYTES} bytes`);
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed or errored.
      }
      reader.releaseLock();
    }
  }

  private get<T>(
    path: string,
    signal?: AbortSignal,
    parser?: RuntimeParser<T>,
    allowNoContent = false,
  ): Promise<T> {
    const init: RequestInit = { method: "GET" };
    if (signal) init.signal = signal;
    return this.request(path, init, parser, allowNoContent);
  }

  private post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    parser?: RuntimeParser<T>,
    allowNoContent = false,
  ): Promise<T> {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    if (signal) init.signal = signal;
    return this.request(path, init, parser, allowNoContent);
  }

  private patch<T>(path: string, body: unknown, signal?: AbortSignal, parser?: RuntimeParser<T>): Promise<T> {
    const init: RequestInit = {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    if (signal) init.signal = signal;
    return this.request(path, init, parser);
  }

  private delete<T>(path: string, signal?: AbortSignal, parser?: RuntimeParser<T>): Promise<T> {
    const init: RequestInit = { method: "DELETE" };
    if (signal) init.signal = signal;
    return this.request(path, init, parser);
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    parser?: RuntimeParser<T>,
    allowNoContent = false,
  ): Promise<T> {
    if (this.#authorization) {
      const headers = new Headers(init.headers);
      headers.set("authorization", this.#authorization);
      init.headers = headers;
    }
    const response = await this.fetchImpl(this.url(path), init);
    if (!response.ok) throw await responseError(response, this.#authorization);
    if (response.status === 204) {
      if (allowNoContent) return undefined as T;
      throw new TypeError(`Runtime response for ${path} unexpectedly had no content`);
    }
    if (!isJsonContentType(response.headers.get("content-type"))) {
      throw new TypeError(`Runtime response for ${path} must use an application/json content type`);
    }
    let value: unknown;
    try {
      value = await response.json() as unknown;
    } catch {
      throw new TypeError(`Runtime response for ${path} must contain valid JSON`);
    }
    return parser ? parser(value, "response") : parseRuntimeObject<T & object>(value, "response") as T;
  }

  private url(path: string): URL {
    return new URL(path.replace(/^\/+/, ""), this.#baseUrl);
  }
}

function parseClearGoalResult(value: unknown, path = "response"): ClearGoalResult {
  const record = parseRuntimeRecord(value, path);
  const result: ClearGoalResult = {
    cleared: parseRuntimeBoolean(record.cleared, `${path}.cleared`),
  };
  if (record.previousGoal !== undefined) {
    result.previousGoal = parseRuntimeSessionGoal(record.previousGoal, `${path}.previousGoal`);
  }
  return result;
}

function parseRuntimeCommandCatalog(value: unknown, path = "response"): RuntimeCommandCatalog {
  const record = parseRuntimeRecord(value, path);
  return {
    roots: parseRuntimeArray(record.roots, parseCommandNode, `${path}.roots`),
    diagnostics: parseRuntimeArray(record.diagnostics, (item, itemPath) => {
      const diagnostic = parseRuntimeRecord(item, itemPath);
      parseRuntimeEnum(diagnostic.level, ["warning", "error"] as const, `${itemPath}.level`);
      parseRuntimeString(diagnostic.code, `${itemPath}.code`);
      parseRuntimeString(diagnostic.message, `${itemPath}.message`);
      return diagnostic as unknown as RuntimeCommandCatalog["diagnostics"][number];
    }, `${path}.diagnostics`),
  };
}

function parseCommandNode(value: unknown, path = "node"): RuntimeCommandCatalog["roots"][number] {
  const node = parseRuntimeRecord(value, path);
  for (const key of ["id", "name", "path", "title", "description", "group", "argumentHint"] as const) {
    parseRuntimeString(node[key], `${path}.${key}`, { allowEmpty: key === "description" || key === "argumentHint" });
  }
  parseRuntimeEnum(node.source, ["project", "user", "mcp", "builtin"] as const, `${path}.source`);
  parseRuntimeEnum(node.argumentMode, ["none", "optional", "required", "variadic"] as const, `${path}.argumentMode`);
  parseRuntimeEnum(node.selectionMode, ["execute", "complete", "drilldown"] as const, `${path}.selectionMode`);
  parseRuntimeEnum(node.concurrency, ["allow", "deny"] as const, `${path}.concurrency`);
  parseRuntimeEnum(node.executionTarget, ["client", "runtime", "prompt"] as const, `${path}.executionTarget`);
  parseRuntimeBoolean(node.hidden, `${path}.hidden`);
  parseRuntimeBoolean(node.enabled, `${path}.enabled`);
  parseRuntimeArray(node.children, parseCommandNode, `${path}.children`);
  return node as unknown as RuntimeCommandCatalog["roots"][number];
}

function parsePendingApproval(value: unknown, path = "approval"): RuntimePendingApprovalRequest {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.id, `${path}.id`);
  parseRuntimeString(record.permission, `${path}.permission`);
  parseRuntimeStringArray(record.patterns, `${path}.patterns`);
  parseRuntimeNonNegativeInteger(record.createdAt, `${path}.createdAt`);
  optionalIdentifier(record.sessionId, `${path}.sessionId`);
  optionalIdentifier(record.callId, `${path}.callId`);
  if (record.maxApprovalScope !== undefined) {
    parseRuntimeEnum(record.maxApprovalScope, ["once", "session", "persistent"] as const, `${path}.maxApprovalScope`);
  }
  if (record.metadata !== undefined) parseRuntimeRecord(record.metadata, `${path}.metadata`);
  return record as unknown as RuntimePendingApprovalRequest;
}

function parsePendingApprovalArray(value: unknown, path = "response"): RuntimePendingApprovalRequest[] {
  return parseRuntimeArray(value, parsePendingApproval, path);
}

function parsePendingApprovalWindow(value: unknown, path = "response"): RuntimePendingApprovalWindow {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeArray(record.approvals, parsePendingApproval, `${path}.approvals`);
  parseRuntimeBoolean(record.truncated, `${path}.truncated`);
  parseRuntimeNonNegativeInteger(record.bytes, `${path}.bytes`);
  optionalString(record.warning, `${path}.warning`);
  return record as unknown as RuntimePendingApprovalWindow;
}

function parseUserInputResolveResult(value: unknown, path = "response"): RuntimeUserInputResolveResult {
  const record = parseRuntimeRecord(value, path);
  return { resolved: parseRuntimeBoolean(record.resolved, `${path}.resolved`) };
}

function parseRuntimeSessionSummary(value: unknown, path = "session"): RuntimeSessionSummary {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.id, `${path}.id`);
  parseRuntimeString(record.cwd, `${path}.cwd`);
  parseRuntimeEnum(record.status, ["active", "archived"] as const, `${path}.status`);
  parseRuntimeNonNegativeInteger(record.createdAt, `${path}.createdAt`);
  parseRuntimeNonNegativeInteger(record.updatedAt, `${path}.updatedAt`);
  optionalString(record.title, `${path}.title`);
  optionalString(record.preview, `${path}.preview`);
  if (record.source !== undefined) parseRuntimeEnum(record.source, ["interactive", "subagent"] as const, `${path}.source`);
  return record as unknown as RuntimeSessionSummary;
}

function parseRuntimeSessionSummaryArray(value: unknown, path = "response"): RuntimeSessionSummary[] {
  return parseRuntimeArray(value, parseRuntimeSessionSummary, path);
}

function parseSessionEventWindow(value: unknown, path = "response"): RuntimeSessionEventWindow {
  const record = parseRuntimeRecord(value, path);
  parseChiliEventArray(record.events, `${path}.events`);
  parseRuntimeArray(record.pendingApprovals, parsePendingApproval, `${path}.pendingApprovals`);
  parseRuntimeBoolean(record.truncated, `${path}.truncated`);
  parseRuntimeNonNegativeInteger(record.bytes, `${path}.bytes`);
  parseRuntimeArray(
    record.pinnedEventIds,
    (item, itemPath) => parseRuntimeIdentifier(item, itemPath),
    `${path}.pinnedEventIds`,
  );
  optionalString(record.warning, `${path}.warning`);
  return record as unknown as RuntimeSessionEventWindow;
}

function parseRuntimeAgentsSnapshot(value: unknown, path = "response"): RuntimeAgentsSnapshot {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeArray(record.agents, (item, itemPath) => {
    const agent = parseRuntimeRecord(item, itemPath);
    parseRuntimeIdentifier(agent.id, `${itemPath}.id`);
    parseAgentPath(agent.path, `${itemPath}.path`);
    parseRuntimeString(agent.taskName, `${itemPath}.taskName`);
    parseRuntimeEnum(agent.status, ["running", "completed", "incomplete", "failed", "cancelled"] as const, `${itemPath}.status`);
    parseRuntimeNonNegativeInteger(agent.generation, `${itemPath}.generation`);
    return agent;
  }, `${path}.agents`);
  parseRuntimeArray(record.tasks, (item, itemPath) => {
    const task = parseRuntimeRecord(item, itemPath);
    parseRuntimeIdentifier(task.id, `${itemPath}.id`);
    parseRuntimeEnum(task.status, [
      "pending",
      "running",
      "completed",
      "incomplete",
      "failed",
      "cancelled",
      "in_progress",
      "blocked",
    ] as const, `${itemPath}.status`);
    return task;
  }, `${path}.tasks`);
  parseRuntimeArray(record.mailbox, (item, itemPath) => {
    const message = parseRuntimeRecord(item, itemPath);
    parseRuntimeIdentifier(message.id, `${itemPath}.id`);
    parseRuntimeEnum(message.status, ["queued", "delivering", "consumed", "discarded"] as const, `${itemPath}.status`);
    return message;
  }, `${path}.mailbox`);
  optionalIdentifier(record.lastEventId, `${path}.lastEventId`);
  return record as unknown as RuntimeAgentsSnapshot;
}

function parseAgentTreeSnapshot(value: unknown, path = "response"): RuntimeAgentTreeSnapshot {
  const record = parseRuntimeRecord(value, path);
  if (record.rootPath !== undefined) parseAgentPath(record.rootPath, `${path}.rootPath`);
  parseRuntimeArray(record.nodes, parseAgentTreeNode, `${path}.nodes`);
  parseRuntimeArray(record.agents, parseAgentRunRecord, `${path}.agents`);
  parseRuntimeArray(record.tasks, parseAgentTaskRecord, `${path}.tasks`);
  parseRuntimeArray(record.mailbox, parseAgentMailboxRecord, `${path}.mailbox`);
  return record as unknown as RuntimeAgentTreeSnapshot;
}

function parseAgentTreeNode(value: unknown, path = "node"): RuntimeAgentTreeNode {
  const record = parseRuntimeRecord(value, path);
  parseAgentPath(record.path, `${path}.path`);
  // Synthesized ancestors and mailbox-only nodes have no associated task.
  parseRuntimeString(record.taskName, `${path}.taskName`, { allowEmpty: true });
  parseRuntimeEnum(record.status, [
    "empty",
    "pending",
    "running",
    "completed",
    "incomplete",
    "failed",
    "cancelled",
    "queued",
    "delivering",
    "consumed",
    "discarded",
  ] as const, `${path}.status`);
  parseRuntimeArray(record.runs, parseAgentRunRecord, `${path}.runs`);
  parseRuntimeArray(record.tasks, parseAgentTaskRecord, `${path}.tasks`);
  parseRuntimeArray(record.mailbox, parseAgentMailboxRecord, `${path}.mailbox`);
  parseRuntimeArray(record.children, parseAgentTreeNode, `${path}.children`);
  return record as unknown as RuntimeAgentTreeNode;
}

function parseAgentRunRecord(value: unknown, path = "run"): RuntimeAgentRunRecord {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.id, `${path}.id`);
  parseAgentPath(record.path, `${path}.path`);
  parseRuntimeString(record.taskName, `${path}.taskName`);
  parseRuntimeEnum(record.status, ["running", "completed", "incomplete", "failed", "cancelled"] as const, `${path}.status`);
  parseRuntimeNonNegativeInteger(record.createdAt, `${path}.createdAt`);
  optionalNonNegativeInteger(record.completedAt, `${path}.completedAt`);
  return record as unknown as RuntimeAgentRunRecord;
}

function parseAgentRunArray(value: unknown, path = "response"): RuntimeAgentRunRecord[] {
  return parseRuntimeArray(value, parseAgentRunRecord, path);
}

function parseAgentMailboxRecord(value: unknown, path = "mailbox"): RuntimeAgentMailboxRecord {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.id, `${path}.id`);
  parseAgentPath(record.path, `${path}.path`);
  parseAgentPath(record.fromPath, `${path}.fromPath`);
  parseRuntimeBoolean(record.triggerTurn, `${path}.triggerTurn`);
  parseRuntimeEnum(record.status, ["queued", "delivering", "consumed", "discarded"] as const, `${path}.status`);
  parseRuntimeNonNegativeInteger(record.createdAt, `${path}.createdAt`);
  optionalNonNegativeInteger(record.consumedAt, `${path}.consumedAt`);
  return record as unknown as RuntimeAgentMailboxRecord;
}

function parseAgentMailboxArray(value: unknown, path = "response"): RuntimeAgentMailboxRecord[] {
  return parseRuntimeArray(value, parseAgentMailboxRecord, path);
}

function parseTeamRecord(value: unknown, path = "team"): RuntimeTeamRecord {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.id, `${path}.id`);
  optionalIdentifier(record.sessionId, `${path}.sessionId`);
  parseRuntimeString(record.name, `${path}.name`);
  parseAgentPath(record.leadPath, `${path}.leadPath`);
  parseRuntimeEnum(record.status, ["active", "archived"] as const, `${path}.status`);
  optionalString(record.description, `${path}.description`);
  parseRuntimeNonNegativeInteger(record.createdAt, `${path}.createdAt`);
  parseRuntimeNonNegativeInteger(record.updatedAt, `${path}.updatedAt`);
  return record as unknown as RuntimeTeamRecord;
}

function parseTeamRecordArray(value: unknown, path = "response"): RuntimeTeamRecord[] {
  return parseRuntimeArray(value, parseTeamRecord, path);
}

function parseTeamMemberRecord(value: unknown, path = "member"): RuntimeTeamMemberRecord {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.teamId, `${path}.teamId`);
  parseAgentPath(record.path, `${path}.path`);
  parseRuntimeString(record.name, `${path}.name`);
  parseRuntimeString(record.role, `${path}.role`);
  parseRuntimeEnum(record.status, ["idle", "running", "waiting", "blocked", "closed"] as const, `${path}.status`);
  optionalIdentifier(record.childSessionId, `${path}.childSessionId`);
  optionalString(record.model, `${path}.model`);
  if (record.toolScope !== undefined) parseRuntimeStringArray(record.toolScope, `${path}.toolScope`);
  if (record.writeScope !== undefined) parseRuntimeStringArray(record.writeScope, `${path}.writeScope`);
  optionalIdentifier(record.currentTaskId, `${path}.currentTaskId`);
  parseRuntimeNonNegativeInteger(record.createdAt, `${path}.createdAt`);
  parseRuntimeNonNegativeInteger(record.updatedAt, `${path}.updatedAt`);
  optionalNonNegativeInteger(record.closedAt, `${path}.closedAt`);
  return record as unknown as RuntimeTeamMemberRecord;
}

function parseTeamMemberArray(value: unknown, path = "response"): RuntimeTeamMemberRecord[] {
  return parseRuntimeArray(value, parseTeamMemberRecord, path);
}

function parseTeamTaskRecord(value: unknown, path = "task"): RuntimeTeamTaskRecord {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.id, `${path}.id`);
  parseRuntimeIdentifier(record.teamId, `${path}.teamId`);
  optionalIdentifier(record.sessionId, `${path}.sessionId`);
  parseRuntimeString(record.title, `${path}.title`);
  optionalString(record.description, `${path}.description`);
  parseRuntimeEnum(record.status, ["pending", "in_progress", "blocked", "completed", "failed", "cancelled"] as const, `${path}.status`);
  if (record.ownerPath !== undefined) parseAgentPath(record.ownerPath, `${path}.ownerPath`);
  if (record.createdBy !== undefined) parseAgentPath(record.createdBy, `${path}.createdBy`);
  parseRuntimeArray(record.dependsOn, (item, itemPath) => parseRuntimeIdentifier(item, itemPath), `${path}.dependsOn`);
  optionalString(record.summary, `${path}.summary`);
  optionalString(record.error, `${path}.error`);
  if (record.metadata !== undefined) parseRuntimeRecord(record.metadata, `${path}.metadata`);
  parseRuntimeNonNegativeInteger(record.createdAt, `${path}.createdAt`);
  parseRuntimeNonNegativeInteger(record.updatedAt, `${path}.updatedAt`);
  optionalNonNegativeInteger(record.completedAt, `${path}.completedAt`);
  return record as unknown as RuntimeTeamTaskRecord;
}

function parseTeamTaskArray(value: unknown, path = "response"): RuntimeTeamTaskRecord[] {
  return parseRuntimeArray(value, parseTeamTaskRecord, path);
}

function parseTeamMessageRecord(value: unknown, path = "message"): RuntimeTeamMessageRecord {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.id, `${path}.id`);
  parseRuntimeIdentifier(record.teamId, `${path}.teamId`);
  parseAgentPath(record.fromPath, `${path}.fromPath`);
  if (record.toPath !== "*") parseAgentPath(record.toPath, `${path}.toPath`);
  parseRuntimeString(record.content, `${path}.content`);
  parseRuntimeEnum(record.kind, ["text", "task_assignment", "system"] as const, `${path}.kind`);
  if (record.delivery !== undefined) {
    parseRuntimeEnum(record.delivery, ["queueOnly", "triggerTurn"] as const, `${path}.delivery`);
  }
  if (record.deliveryStatus !== undefined) {
    parseRuntimeEnum(
      record.deliveryStatus,
      ["queued", "delivering", "delivered", "failed"] as const,
      `${path}.deliveryStatus`,
    );
  }
  optionalString(record.deliveryError, `${path}.deliveryError`);
  optionalNonNegativeInteger(record.deliveryUpdatedAt, `${path}.deliveryUpdatedAt`);
  optionalNonNegativeInteger(record.deliveredAt, `${path}.deliveredAt`);
  optionalIdentifier(record.taskId, `${path}.taskId`);
  optionalString(record.summary, `${path}.summary`);
  if (record.metadata !== undefined) parseRuntimeRecord(record.metadata, `${path}.metadata`);
  parseRuntimeNonNegativeInteger(record.createdAt, `${path}.createdAt`);
  return record as unknown as RuntimeTeamMessageRecord;
}

function parseTeamMessageArray(value: unknown, path = "response"): RuntimeTeamMessageRecord[] {
  return parseRuntimeArray(value, parseTeamMessageRecord, path);
}

function parseTeamSnapshot(value: unknown, path = "response"): RuntimeTeamSnapshot {
  const record = parseRuntimeRecord(value, path);
  parseTeamRecord(record.team, `${path}.team`);
  parseRuntimeArray(record.members, parseTeamSnapshotMember, `${path}.members`);
  parseRuntimeArray(record.tasks, parseTeamSnapshotTask, `${path}.tasks`);
  parseRuntimeArray(record.messages, parseTeamSnapshotMessage, `${path}.messages`);
  parseRuntimeArray(record.messageDeliveries, parseTeamMessageDeliveryRecord, `${path}.messageDeliveries`);
  parseTeamSnapshotStats(record.stats, `${path}.stats`);
  parseRuntimeNonNegativeInteger(record.generatedAt, `${path}.generatedAt`);
  return record as unknown as RuntimeTeamSnapshot;
}

function parseTeamSnapshotMember(value: unknown, path: string): RuntimeTeamSnapshotMember {
  const record = parseRuntimeRecord(value, path);
  parseTeamMemberRecord(record, path);
  parseRuntimeArray(
    record.taskIds,
    (item, itemPath) => parseRuntimeIdentifier(item, itemPath),
    `${path}.taskIds`,
  );
  parseRuntimeArray(
    record.deliveryIds,
    (item, itemPath) => parseRuntimeIdentifier(item, itemPath),
    `${path}.deliveryIds`,
  );
  if (record.currentTask !== undefined) parseTeamTaskRecord(record.currentTask, `${path}.currentTask`);
  return record as unknown as RuntimeTeamSnapshotMember;
}

function parseTeamSnapshotTask(value: unknown, path: string): RuntimeTeamSnapshotTask {
  const record = parseRuntimeRecord(value, path);
  parseTeamTaskRecord(record, path);
  for (const field of ["blockedBy", "blocks", "messageIds"] as const) {
    parseRuntimeArray(
      record[field],
      (item, itemPath) => parseRuntimeIdentifier(item, itemPath),
      `${path}.${field}`,
    );
  }
  parseRuntimeBoolean(record.ready, `${path}.ready`);
  if (record.owner !== undefined) parseTeamMemberRecord(record.owner, `${path}.owner`);
  return record as unknown as RuntimeTeamSnapshotTask;
}

function parseTeamSnapshotMessage(value: unknown, path: string): RuntimeTeamSnapshotMessage {
  const record = parseRuntimeRecord(value, path);
  parseTeamMessageRecord(record, path);
  parseRuntimeArray(record.deliveries, parseTeamMessageDeliveryRecord, `${path}.deliveries`);
  return record as unknown as RuntimeTeamSnapshotMessage;
}

function parseTeamMessageDeliveryRecord(value: unknown, path: string): RuntimeTeamMessageDeliveryRecord {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.mailboxMessageId, `${path}.mailboxMessageId`);
  parseRuntimeIdentifier(record.teamId, `${path}.teamId`);
  parseRuntimeIdentifier(record.teamMessageId, `${path}.teamMessageId`);
  parseAgentPath(record.path, `${path}.path`);
  parseRuntimeEnum(record.status, ["queued", "delivering", "delivered", "failed"] as const, `${path}.status`);
  parseRuntimeBoolean(record.triggerTurn, `${path}.triggerTurn`);
  optionalIdentifier(record.childSessionId, `${path}.childSessionId`);
  optionalString(record.error, `${path}.error`);
  parseRuntimeNonNegativeInteger(record.queuedAt, `${path}.queuedAt`);
  parseRuntimeNonNegativeInteger(record.updatedAt, `${path}.updatedAt`);
  optionalNonNegativeInteger(record.deliveredAt, `${path}.deliveredAt`);
  return record as unknown as RuntimeTeamMessageDeliveryRecord;
}

function parseTeamSnapshotStats(value: unknown, path: string): RuntimeTeamSnapshotStats {
  const record = parseRuntimeRecord(value, path);
  for (const field of ["memberCount", "taskCount", "messageCount", "deliveryCount"] as const) {
    parseRuntimeNonNegativeInteger(record[field], `${path}.${field}`);
  }

  const membersByStatus = parseRuntimeRecord(record.membersByStatus, `${path}.membersByStatus`);
  for (const status of ["idle", "running", "waiting", "blocked", "closed"] as const) {
    parseRuntimeNonNegativeInteger(membersByStatus[status], `${path}.membersByStatus.${status}`);
  }
  parseNonNegativeCountRecord(membersByStatus, `${path}.membersByStatus`);

  const tasksByStatus = parseRuntimeRecord(record.tasksByStatus, `${path}.tasksByStatus`);
  for (const status of ["pending", "in_progress", "blocked", "completed", "failed", "cancelled"] as const) {
    parseRuntimeNonNegativeInteger(tasksByStatus[status], `${path}.tasksByStatus.${status}`);
  }
  parseNonNegativeCountRecord(tasksByStatus, `${path}.tasksByStatus`);

  parseNonNegativeCountRecord(record.messagesByDeliveryStatus, `${path}.messagesByDeliveryStatus`);
  parseNonNegativeCountRecord(record.deliveriesByStatus, `${path}.deliveriesByStatus`);
  parseRuntimeArray(
    record.readyTaskIds,
    (item, itemPath) => parseRuntimeIdentifier(item, itemPath),
    `${path}.readyTaskIds`,
  );
  parseRuntimeArray(
    record.blockedTaskIds,
    (item, itemPath) => parseRuntimeIdentifier(item, itemPath),
    `${path}.blockedTaskIds`,
  );
  return record as unknown as RuntimeTeamSnapshotStats;
}

function parseNonNegativeCountRecord(value: unknown, path: string): Record<string, unknown> {
  const record = parseRuntimeRecord(value, path);
  for (const [index, count] of Object.values(record).entries()) {
    parseRuntimeNonNegativeInteger(count, `${path}[${index}]`);
  }
  return record;
}

function parseTeamTaskClaimResult(value: unknown, path = "response"): RuntimeTeamTaskClaimResult {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeBoolean(record.applied, `${path}.applied`);
  if (record.task !== undefined) parseTeamTaskRecord(record.task, `${path}.task`);
  parseChiliEventArray(record.events, `${path}.events`);
  if (record.reason !== undefined) {
    parseRuntimeEnum(record.reason, ["not_found", "already_claimed", "already_resolved", "blocked"] as const, `${path}.reason`);
  }
  return record as unknown as RuntimeTeamTaskClaimResult;
}

function parseTeamTaskDispatchResult(value: unknown, path = "response"): RuntimeTeamTaskDispatchResult {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeEnum(record.status, ["running", "completed", "incomplete", "failed", "cancelled", "skipped"] as const, `${path}.status`);
  parseTeamTaskRecord(record.teamTask, `${path}.teamTask`);
  parseTeamTaskRecord(record.team_task, `${path}.team_task`);
  if (record.agentTask !== undefined) parseLocalSubagentTask(record.agentTask, `${path}.agentTask`);
  if (record.agent_task !== undefined) parseLocalSubagentTask(record.agent_task, `${path}.agent_task`);
  optionalString(record.reason, `${path}.reason`);
  return record as unknown as RuntimeTeamTaskDispatchResult;
}

function parseLocalSubagentTask(value: unknown, path: string): RuntimeLocalSubagentTaskRecord {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.taskId, `${path}.taskId`);
  parseRuntimeIdentifier(record.runId, `${path}.runId`);
  parseAgentPath(record.path, `${path}.path`);
  parseRuntimeEnum(record.status, ["pending", "running", "completed", "incomplete", "failed", "cancelled"] as const, `${path}.status`);
  return record as unknown as RuntimeLocalSubagentTaskRecord;
}

function parseTeamTaskSyncResult(value: unknown, path = "response"): RuntimeTeamTaskSyncResult {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeBoolean(record.applied, `${path}.applied`);
  parseTeamTaskRecord(record.teamTask, `${path}.teamTask`);
  if (record.agentTask !== undefined) parseAgentTaskRecord(record.agentTask, `${path}.agentTask`);
  optionalString(record.reason, `${path}.reason`);
  return record as unknown as RuntimeTeamTaskSyncResult;
}

function parseTeamTaskReconcileResult(value: unknown, path = "response"): RuntimeTeamTaskReconcileResult {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeNonNegativeInteger(record.scanned, `${path}.scanned`);
  parseRuntimeArray(record.synced, parseTeamTaskSyncResult, `${path}.synced`);
  parseRuntimeArray(record.skipped, parseTeamTaskSyncResult, `${path}.skipped`);
  parseRuntimeArray(record.errors, (item, itemPath) => {
    const error = parseRuntimeRecord(item, itemPath);
    parseRuntimeIdentifier(error.teamId, `${itemPath}.teamId`);
    parseRuntimeIdentifier(error.taskId, `${itemPath}.taskId`);
    parseRuntimeString(error.error, `${itemPath}.error`);
    return error;
  }, `${path}.errors`);
  return record as unknown as RuntimeTeamTaskReconcileResult;
}

function parseTeamMergeResult(value: unknown, path = "response"): RuntimeTeamMergeResult {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeNonNegativeInteger(record.scanned, `${path}.scanned`);
  for (const key of ["applied", "failed", "conflicted"] as const) {
    parseRuntimeArray(record[key], (item, itemPath) => {
      const result = parseRuntimeRecord(item, itemPath);
      parseRuntimeEnum(result.status, ["applied", "failed", "conflicted"] as const, `${itemPath}.status`);
      parseTeamTaskRecord(result.teamTask, `${itemPath}.teamTask`);
      return result;
    }, `${path}.${key}`);
  }
  parseRuntimeArray(record.skipped, (item, itemPath) => {
    const result = parseRuntimeRecord(item, itemPath);
    if (result.status !== "skipped") throw new TypeError(`${itemPath}.status must be skipped`);
    parseTeamTaskRecord(result.teamTask, `${itemPath}.teamTask`);
    parseRuntimeString(result.reason, `${itemPath}.reason`);
    return result;
  }, `${path}.skipped`);
  parseRuntimeArray(record.errors, (item, itemPath) => parseRuntimeRecord(item, itemPath), `${path}.errors`);
  return record as unknown as RuntimeTeamMergeResult;
}

function parseTeamExecutionRunSummary(value: unknown, path = "response"): RuntimeTeamExecutionRunSummary {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.teamId, `${path}.teamId`);
  parseRuntimeNonNegativeInteger(record.cycles, `${path}.cycles`);
  parseRuntimeEnum(record.stopReason, ["drained", "once", "max_cycles", "timeout", "aborted", "team_inactive"] as const, `${path}.stopReason`);
  parseRuntimeNonNegativeInteger(record.startedAt, `${path}.startedAt`);
  parseRuntimeNonNegativeInteger(record.endedAt, `${path}.endedAt`);
  for (const key of [
    "dispatched",
    "completed",
    "accepted",
    "reopened",
    "merged",
    "mergeFailed",
    "mergeConflicted",
    "mergeSkipped",
    "failed",
    "blocked",
    "skipped",
    "stillRunning",
    "errors",
  ] as const) {
    parseRuntimeArray(record[key], (item, itemPath) => {
      const entry = parseRuntimeRecord(item, itemPath);
      parseRuntimeIdentifier(entry.teamId, `${itemPath}.teamId`);
      if (entry.taskId !== undefined) parseRuntimeIdentifier(entry.taskId, `${itemPath}.taskId`);
      if (entry.status !== undefined) parseRuntimeString(entry.status, `${itemPath}.status`);
      if (entry.reason !== undefined) parseRuntimeString(entry.reason, `${itemPath}.reason`);
      return entry;
    }, `${path}.${key}`);
  }
  return record as unknown as RuntimeTeamExecutionRunSummary;
}

function parseAgentTaskRecord(value: unknown, path = "task"): RuntimeAgentTaskRecord {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.id, `${path}.id`);
  parseAgentPath(record.path, `${path}.path`);
  parseRuntimeEnum(record.status, ["pending", "running", "completed", "incomplete", "failed", "cancelled"] as const, `${path}.status`);
  parseRuntimeString(record.taskName, `${path}.taskName`);
  parseRuntimeNonNegativeInteger(record.generation, `${path}.generation`);
  parseRuntimeNonNegativeInteger(record.createdAt, `${path}.createdAt`);
  parseRuntimeNonNegativeInteger(record.updatedAt, `${path}.updatedAt`);
  return record as unknown as RuntimeAgentTaskRecord;
}

function parseAgentTaskArray(value: unknown, path = "response"): RuntimeAgentTaskRecord[] {
  return parseRuntimeArray(value, parseAgentTaskRecord, path);
}

function parseTaskFollowupResult(value: unknown, path = "response"): RuntimeTaskFollowupResult {
  const record = parseRuntimeRecord(value, path);
  parseAgentTaskRecord(record.task, `${path}.task`);
  parseRuntimePromptResult(record.result, `${path}.result`);
  return record as unknown as RuntimeTaskFollowupResult;
}

function parseTaskReconcileStaleResult(value: unknown, path = "response"): RuntimeTaskReconcileStaleResult {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeNonNegativeInteger(record.scanned, `${path}.scanned`);
  parseRuntimeArray(record.closed, parseAgentTaskRecord, `${path}.closed`);
  return record as unknown as RuntimeTaskReconcileStaleResult;
}

function parseAgentPath(value: unknown, path: string): AgentPath {
  const agentPath = parseRuntimeIdentifier(value, path);
  if (!agentPath.startsWith("/")) throw new TypeError(`${path} must be an absolute agent path`);
  return agentPath as AgentPath;
}

function optionalIdentifier(value: unknown, path: string): void {
  if (value !== undefined) parseRuntimeIdentifier(value, path);
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) parseRuntimeString(value, path, { allowEmpty: true });
}

function optionalNonNegativeInteger(value: unknown, path: string): void {
  if (value !== undefined) parseRuntimeNonNegativeInteger(value, path);
}

function commandCatalogSessionId(value: unknown): SessionId {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("sessionId must be a non-empty string when provided");
  }
  const sessionId = value.trim();
  if (sessionId.length > 512) throw new TypeError("sessionId must not exceed 512 characters");
  if (/[\u0000-\u001f\u007f]/u.test(sessionId)) throw new TypeError("sessionId must be valid text");
  return sessionId as SessionId;
}

function sessionScopedRequestPath(path: string, sessionId: SessionId | undefined): string {
  if (sessionId === undefined) return path;
  return `${path}?sessionId=${encodeURIComponent(commandCatalogSessionId(sessionId))}`;
}

function approvalDecisionForApproveRequest(input: ApproveApprovalRequest): ApprovalDecisionAction {
  if (input.scope === undefined || input.scope === "once") return "allow_once";
  if (input.scope === "session") return "allow_session";
  if (input.scope === "persistent") return "allow_always";
  throw new Error("approval scope must be one of once, session, persistent");
}

type ParsedSseFrame =
  | { kind: "event"; event: ChiliEvent }
  | { kind: "resync"; afterEventId: string; message: string };

function parseSseFrame(frame: string, authorization?: string): ParsedSseFrame | undefined {
  const data: string[] = [];
  let eventName = "message";
  for (const line of frame.replace(/\r\n/gu, "\n").split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (data.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data.join("\n")) as unknown;
  } catch {
    throw new TypeError("Runtime SSE data must contain valid JSON");
  }
  if (eventName === "chili.resync") {
    if (!value || typeof value !== "object") throw new TypeError("Invalid event resync control frame");
    const record = value as Record<string, unknown>;
    const afterEventId = requireSseControlText(record.afterEventId, "afterEventId", 512);
    if (boundedRemoteDiagnostic(afterEventId, 512, authorization) !== afterEventId) {
      throw new TypeError("Invalid event resync afterEventId");
    }
    const message = boundedRemoteDiagnostic(
      requireSseControlText(record.message, "message", MAX_SSE_CONTROL_MESSAGE_BYTES),
      MAX_SSE_CONTROL_MESSAGE_BYTES,
      authorization,
    );
    if (record.reason !== "event_transport_limit") throw new TypeError("Invalid event resync reason");
    return { kind: "resync", afterEventId, message };
  }
  if (eventName !== "message" && eventName !== "chili.event") {
    throw new TypeError("Invalid runtime SSE event name");
  }
  return { kind: "event", event: parseChiliEvent(value, "event") };
}

const MAX_SSE_CLIENT_BUFFER_BYTES = 4_100_000;
const MAX_SSE_CONTROL_MESSAGE_BYTES = 2_000;
const MAX_RUNTIME_HTTP_ERROR_RESPONSE_BYTES = 65_536;
const MAX_RUNTIME_HTTP_ERROR_MESSAGE_BYTES = 2_000;

function sseFrameBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function requireSseControlText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > maxLength
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid event resync ${field}`);
  }
  return value;
}

export class RuntimeHttpError extends Error {
  override readonly name = "RuntimeHttpError";
  constructor(readonly status: number, message: string) { super(message); }
}

async function responseError(response: Response, authorization?: string): Promise<Error> {
  const fallback = `Runtime request failed with HTTP ${response.status}`;
  try {
    const text = await readBoundedResponseText(response, MAX_RUNTIME_HTTP_ERROR_RESPONSE_BYTES);
    if (text === undefined) return new RuntimeHttpError(response.status, fallback);
    const body = parseRuntimeRecord(JSON.parse(text) as unknown, "error response");
    const nested = body.error === undefined ? undefined : parseRuntimeRecord(body.error, "error response.error");
    const candidate = nested?.message ?? body.message;
    if (typeof candidate === "string" && candidate.length > 0) {
      const message = boundedRemoteDiagnostic(candidate, MAX_RUNTIME_HTTP_ERROR_MESSAGE_BYTES, authorization);
      return new RuntimeHttpError(response.status, message || fallback);
    }
  } catch {
    // Keep the HTTP status fallback.
  }
  return new RuntimeHttpError(response.status, fallback);
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string | undefined> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/u.test(declaredLength)) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // The remote body may already be closed.
      }
      return undefined;
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The remote body may already be closed.
        }
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

function boundedRemoteDiagnostic(value: string, maxBytes: number, authorization?: string): string {
  const exactRedacted = redactExactAuthorization(value, authorization);
  const centrallyRedacted = normalizePersistedError(new Error(exactRedacted)).message;
  const redacted = redactExactAuthorization(centrallyRedacted, authorization);
  return truncateUtf8(redacted, maxBytes);
}

function redactExactAuthorization(value: string, authorization?: string): string {
  let redacted = value;
  if (authorization) {
    const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    for (const secret of [authorization, token]) {
      if (secret) redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isLoopbackUrlHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  const unbracketed = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  if (unbracketed === "localhost" || unbracketed.endsWith(".localhost") || unbracketed === "::1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(unbracketed);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}
