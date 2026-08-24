import type {
  AgentPath,
  AgentRunId,
  AgentTaskMode,
  AgentTaskStatus,
  ApprovalId,
  ApprovalDecisionAction,
  ApprovalScope,
  AssistantMessagePhase,
  ChiliEvent,
  DelegationPolicy,
  DelegationPolicySource,
  EventEnvelope,
  MessageId,
  MessagePart,
  MessageRole,
  ModelMetadataPayload,
  ModelUsage,
  PartId,
  RuntimeDelegationConfig,
  RuntimeSessionStatus,
  SessionId,
  TaskCompletionPolicy,
  TaskId,
  TeamId,
  TeamMemberStatus,
  TeamMessageDelivery,
  TeamMessageDeliveryStatus,
  TeamMessageKind,
  TeamRunLifecyclePhase,
  TeamRunStopReason,
  TeamRunSummaryCounts,
  SessionGoal,
  ToolCallId,
  ToolCallStatus,
  ToolOutputStream,
  TurnId,
} from "@chili/protocol";
import { isTransientEvent } from "@chili/protocol";

type ToolPartStatus = Extract<MessagePart, { type: "tool_call" }>["status"];

export type ChatToolExecutionContext = NonNullable<Extract<MessagePart, { type: "tool_result" }>["executionContext"]>;

export interface ChiliRuntimeView {
  sessionIds: SessionId[];
  sessions: Record<string, RuntimeSessionView>;
  turnStatuses: Record<string, RuntimeTurnStatus>;
  turnStartedAt: Record<string, number>;
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
  teamIdByDelegatedTaskId: Record<string, TeamId>;
  teamIds: TeamId[];
  teams: Record<string, RuntimeTeamView>;
  teamMemberIds: string[];
  teamMembers: Record<string, RuntimeTeamMemberView>;
  teamMessageIds: string[];
  teamMessages: Record<string, RuntimeTeamMessageView>;
  teamRunIds: string[];
  teamRuns: Record<string, RuntimeTeamRunView>;
  teamRunIdsByTeam: Record<string, string[]>;
  modelMetadataTurnIds: TurnId[];
  modelMetadataByTurn: Record<string, RuntimeModelMetadataView>;
  goalsBySession: Record<string, RuntimeSessionGoalView>;
  partIndex: Record<string, RuntimePartIndexEntry>;
  lastEventId?: string;
}

export type RuntimeTurnStatus = "running" | "completed" | "failed" | "cancelled";

export interface RuntimeSessionView {
  id: SessionId;
  cwd: string;
  title?: string;
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
  delegationPolicy?: DelegationPolicy;
  /** True once session.status_changed establishes the modern lifecycle source. */
  hasExplicitStatus?: boolean;
  retry?: RuntimeTurnRetryView;
}

export interface RuntimeTurnRetryView {
  turnId: TurnId;
  attempt: number;
  delayMs: number;
  reason: string;
  scheduledAt: number;
}

export interface RuntimeMessageView {
  id: MessageId;
  sessionId: SessionId;
  role: MessageRole;
  parts: MessagePart[];
  createdAt: number;
  turnId?: TurnId;
  updatedAt?: number;
  lastTextAt?: number;
  completedAt?: number;
}

export interface RuntimeToolCallView {
  id: ToolCallId;
  status: ToolCallStatus | "completed" | "failed" | "cancelled";
  toolName: string;
  input: unknown;
  startedAt?: number;
  updatedAt: number;
  sessionId?: SessionId;
  turnId?: TurnId;
  output?: string;
  error?: string;
  synthetic?: boolean;
  metadata?: Record<string, unknown>;
  liveOutput?: RuntimeToolOutputDelta[];
}

export interface RuntimeToolOutputDelta {
  stream: ToolOutputStream;
  delta: string;
  time: number;
  bytes?: number;
  truncated?: boolean;
  sequence?: number;
}

export interface RuntimeModelMetadataView extends ModelMetadataPayload {
  updatedAt: number;
  sessionId?: SessionId;
}

export interface RuntimeSessionGoalView extends SessionGoal {}

export interface RuntimeApprovalView {
  id: ApprovalId;
  permission: string;
  patterns: string[];
  maxApprovalScope?: ApprovalScope;
  status: "pending" | "resolved";
  createdAt: number;
  sessionId?: SessionId;
  callId?: ToolCallId;
  metadata?: Record<string, unknown>;
  decision?: ApprovalDecisionAction;
  feedback?: string;
  resolvedAt?: number;
}

export type RuntimeAgentStatus = Exclude<AgentTaskStatus, "pending">;

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
  mode?: AgentTaskMode;
  childSessionId?: SessionId;
  summary?: string;
  error?: string;
  completedAt?: number;
}

export interface RuntimeAgentMailboxMessageView {
  id: string;
  path: AgentPath;
  from: AgentPath;
  triggerTurn: boolean;
  status: "queued" | "delivering" | "consumed" | "discarded";
  queuedAt: number;
  sessionId?: SessionId;
  teamId?: TeamId;
  teamMessageId?: string;
  taskId?: TaskId;
  recipientSessionId?: SessionId;
  role?: MessageRole;
  messageKind?: string;
  preview?: string;
  metadataSummary?: RuntimeAgentMailboxMetadataSummary;
  error?: string;
  claimedAt?: number;
  consumedAt?: number;
}

export interface RuntimeAgentMailboxMetadataSummary {
  kind?: string;
  batchId?: string;
  completionPolicy?: RuntimeTaskCompletionPolicy;
  taskIds?: TaskId[];
  total?: number;
  expectedBatchSize?: number;
}

export type RuntimeTaskStatus = AgentTaskStatus | "in_progress" | "blocked";

export type RuntimeTaskCompletionPolicy = TaskCompletionPolicy;

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
  metadata?: Record<string, unknown>;
  summary?: string;
  error?: string;
  sessionId?: SessionId;
  createdBy?: AgentPath;
  ownerPath?: AgentPath;
  path?: AgentPath;
  childSessionId?: SessionId;
  mode?: AgentTaskMode;
  taskPrompt?: string;
  sourceCallId?: ToolCallId;
  batchId?: string;
  batchIndex?: number;
  expectedBatchSize?: number;
  completionPolicy?: RuntimeTaskCompletionPolicy;
  maxConcurrency?: number;
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
  runIds: string[];
  createdAt: number;
  updatedAt: number;
  sessionId?: SessionId;
  description?: string;
  activeRunId?: string;
  lastCompletedRunId?: string;
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
  taskId?: TaskId;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeAgentsSnapshot {
  agents: RuntimeAgentView[];
  tasks: RuntimeTaskView[];
  mailbox: RuntimeAgentMailboxMessageView[];
  lastEventId?: string;
}

export interface RuntimeDelegationStatusInput {
  sessionId?: SessionId;
  teamId?: TeamId;
  delegationConfig?: RuntimeDelegationConfig;
  generatedAt?: string;
}

export interface RuntimeDelegationStatusView {
  delegation: RuntimeDelegationCapabilityView;
  parent: RuntimeParentExecutionView;
  agents: RuntimeDelegatedAgentsView;
  team: RuntimeDelegationTeamView;
  lastBatch?: RuntimeAgentBatchView;
  generatedAt: string;
  lastEventId?: string;
}

export interface RuntimeDelegationCapabilityView {
  supported?: boolean;
  observed: boolean;
  policy?: DelegationPolicy;
  source?: DelegationPolicySource;
}

export interface RuntimeParentExecutionView {
  sessionId?: SessionId;
  status: RuntimeSessionStatus | "unknown";
  active: boolean;
  statusReason?: string;
}

export interface RuntimeDelegatedAgentCounts {
  total: number;
  pending: number;
  running: number;
  active: number;
  completed: number;
  incomplete: number;
  failed: number;
  cancelled: number;
}

export interface RuntimeDelegatedAgentsView {
  counts: RuntimeDelegatedAgentCounts;
  items: RuntimeDelegatedAgent[];
  active: RuntimeDelegatedAgent[];
  errors: RuntimeDelegatedAgentError[];
}

export interface RuntimeDelegatedAgent {
  taskId: TaskId;
  runId?: AgentRunId;
  path: AgentPath;
  taskName: string;
  status: AgentTaskStatus;
  mode?: AgentTaskMode;
  childSessionId?: SessionId;
  sourceCallId?: ToolCallId;
  batchId?: string;
  batchIndex?: number;
  expectedBatchSize?: number;
  completionPolicy?: RuntimeTaskCompletionPolicy;
  maxConcurrency?: number;
  summary?: string;
  error?: string;
  activity?: RuntimeDelegatedAgentActivity;
  updatedAt: number;
  completedAt?: number;
}

export interface RuntimeDelegatedAgentActivity {
  kind: "tool" | "approval" | "task" | "waiting";
  label: string;
  status: string;
  updatedAt: number;
}

export interface RuntimeDelegatedAgentError {
  taskId: TaskId;
  runId?: AgentRunId;
  path: AgentPath;
  status: Extract<AgentTaskStatus, "incomplete" | "failed" | "cancelled">;
  message: string;
  updatedAt: number;
}

export interface RuntimeDelegationTeamView {
  count: number;
  activeCount: number;
  selectedTeamId?: TeamId;
  selectedName?: string;
}

export type RuntimeAgentBatchStatus = "running" | "completed" | "incomplete" | "failed" | "cancelled" | "mixed" | "partial";

export interface RuntimeAgentBatchView extends RuntimeDelegatedAgentCounts {
  callId: ToolCallId;
  batchId?: string;
  taskIds: TaskId[];
  expected: number;
  untracked: number;
  spawnedCount?: number;
  spawnFailureCount?: number;
  spawnFailures?: RuntimeAgentBatchSpawnFailure[];
  completionPolicy?: RuntimeTaskCompletionPolicy;
  maxConcurrency?: number;
  mixed: boolean;
  partial: boolean;
  status: RuntimeAgentBatchStatus;
  updatedAt: number;
  error?: string;
}

export interface RuntimeAgentBatchSpawnFailure {
  batchIndex?: number;
  description?: string;
  error: string;
}

export interface RuntimePartIndexEntry {
  messageId: MessageId;
  index: number;
}

export type RuntimeTeamRunStatus = "running" | "completed";

export interface RuntimeTeamRunView {
  id: string;
  teamId: TeamId;
  status: RuntimeTeamRunStatus;
  cycle: number;
  counts: TeamRunSummaryCounts;
  createdAt: number;
  updatedAt: number;
  sessionId?: SessionId;
  mode?: AgentTaskMode;
  once?: boolean;
  maxCycles?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxConcurrentDispatches?: number;
  maxConcurrentVerifications?: number;
  phase?: TeamRunLifecyclePhase;
  stopReason?: TeamRunStopReason;
  startedAt?: number;
  endedAt?: number;
}

export interface TeamLiveCockpitInput {
  teamId?: TeamId;
  sessionId?: SessionId;
  limit?: number;
  connection?: TeamLiveConnectionState;
  generatedAt?: string;
}

export interface TeamLiveCockpitView {
  teamIds: TeamId[];
  teams: TeamLiveTeamSummary[];
  team?: RuntimeTeamView;
  lead?: TeamLiveMemberRow;
  members: TeamLiveMemberRow[];
  tasks: TeamLiveTaskRow[];
  runs: RuntimeTeamRunView[];
  activeRun?: RuntimeTeamRunView;
  pendingApprovals: RuntimeApprovalView[];
  mailbox: TeamLiveMailboxDeliveryView[];
  metadata: TeamLiveMetadataSummary;
  toolCounts: TeamLiveToolCount[];
  recentActivity: TeamLiveActivityItem[];
  lastEventId?: string;
}

export interface TeamLiveTeamSummary {
  id: TeamId;
  name: string;
  status: RuntimeTeamView["status"];
  leadPath: AgentPath;
  memberCount: number;
  taskCount: number;
  runningTaskCount: number;
  pendingTaskCount: number;
  pendingApprovalCount: number;
  updatedAt: number;
  activeRunId?: string;
}

export interface TeamLiveMemberRow {
  id: string;
  teamId: TeamId;
  path: AgentPath;
  name: string;
  role: string;
  status: TeamMemberStatus;
  isLead: boolean;
  depth: number;
  taskIds: TaskId[];
  deliveryIds: string[];
  updatedAt: number;
  childSessionId?: SessionId;
  model?: string;
  toolScope?: string[];
  writeScope?: string[];
  currentTaskId?: TaskId;
  currentTaskTitle?: string;
}

export interface TeamLiveTaskMetadata {
  dispatch?: Record<string, unknown>;
  verification?: Record<string, unknown>;
  worktree?: Record<string, unknown>;
  merge?: Record<string, unknown>;
}

export interface TeamLiveTaskRow {
  id: TaskId;
  teamId?: TeamId;
  title: string;
  description?: string;
  status: RuntimeTaskStatus;
  ownerPath?: AgentPath;
  ownerName?: string;
  dependsOn?: TaskId[];
  summary?: string;
  error?: string;
  metadata: TeamLiveTaskMetadata;
  updatedAt: number;
  completedAt?: number;
}

export interface TeamLiveMailboxDeliveryView {
  id: string;
  path: AgentPath;
  from: AgentPath;
  status: RuntimeAgentMailboxMessageView["status"];
  triggerTurn: boolean;
  queuedAt: number;
  teamId?: TeamId;
  teamMessageId?: string;
  taskId?: TaskId;
  deliveryStatus?: TeamMessageDeliveryStatus;
  deliveryError?: string;
  claimedAt?: number;
  consumedAt?: number;
}

export interface TeamLiveMetadataSummary {
  dispatches: TeamLiveMetadataEntry[];
  verifications: TeamLiveMetadataEntry[];
  worktrees: TeamLiveMetadataEntry[];
  merges: TeamLiveMetadataEntry[];
}

export interface TeamLiveMetadataEntry {
  taskId: TaskId;
  title: string;
  status: RuntimeTaskStatus;
  ownerPath?: AgentPath;
  value: Record<string, unknown>;
}

export interface TeamLiveToolCount {
  toolName: string;
  total: number;
  running: number;
  completed: number;
  failed: number;
}

export type TeamLiveActivityKind =
  | "run"
  | "message"
  | "mailbox"
  | "tool"
  | "approval"
  | "task"
  | "member"
  | "verifier"
  | "merge";

export interface TeamLiveActivityItem {
  id: string;
  kind: TeamLiveActivityKind;
  time: number;
  label: string;
  status?: string;
  detail?: string;
  toolName?: string;
  taskId?: TaskId;
  teamId?: TeamId;
  teamMessageId?: string;
  from?: AgentPath;
  to?: AgentPath | "*";
}

export type TeamLiveConnectionStatus = "unknown" | "connecting" | "streaming" | "reconnecting" | "offline" | "error";

export interface TeamLiveConnectionState {
  status: TeamLiveConnectionStatus;
  lastEventId?: string;
  error?: string;
}

export interface TeamLiveScope {
  teamId?: TeamId;
  sessionId?: SessionId;
  teamIds: TeamId[];
  sessionIds: SessionId[];
}

export interface TeamLiveView {
  connection: TeamLiveConnectionState;
  scope: TeamLiveScope;
  selectedTeamId?: TeamId;
  teams: TeamLiveTeamSummary[];
  selected?: TeamLiveSelectedTeam;
  globalActivity: TeamLiveActivityItem[];
  availableActions: TeamLiveAction[];
  generatedAt: string;
  lastEventId?: string;
}

export interface TeamLiveSelectedTeam {
  team: TeamLiveTeamSummary;
  members: TeamLiveMemberSummary[];
  tasks: TeamLiveTaskSummary[];
  runs: TeamLiveRunSummary[];
  activeTools: TeamLiveToolSummary[];
  pendingApprovals: TeamLiveApprovalSummary[];
  mergeQueue: TeamLiveMergeSummary[];
  recentActivity: TeamLiveActivityItem[];
  availableActions: TeamLiveAction[];
  health: TeamLiveHealth;
}

export interface TeamLiveMemberSummary extends TeamLiveMemberRow {
  sessionId?: SessionId;
  currentTaskStatus?: RuntimeTaskStatus;
}

export interface TeamLiveTaskSummary extends Omit<TeamLiveTaskRow, "metadata"> {
  metadata: TeamLiveTaskMetadata;
  verifier?: TeamLiveVerifierSummary;
  merge?: TeamLiveMergeSummary;
  worktree?: TeamLiveWorktreeSummary;
  dispatch?: TeamLiveDispatchSummary;
  blocked: boolean;
  final: boolean;
}

export type TeamLiveVerifierStatus = "none" | "pending" | "passed" | "failed";

export interface TeamLiveVerifierSummary {
  status: TeamLiveVerifierStatus;
  verifierTaskId?: TaskId;
  verifierRunId?: AgentRunId;
  verifierPath?: AgentPath;
  checkedAt?: number;
  startedAt?: number;
  feedback?: string;
}

export type TeamLiveMergeStatus = "none" | "pending" | "applied" | "failed" | "conflicted" | "skipped";

export interface TeamLiveMergeSummary {
  teamId?: TeamId;
  taskId: TaskId;
  title: string;
  ownerPath?: AgentPath;
  status: TeamLiveMergeStatus;
  worktreePath?: string;
  baseRef?: string;
  diffSummary?: Record<string, unknown>;
  error?: string;
  conflicts?: string[];
  reason?: string;
  createdAt?: number;
  mergedAt?: number;
}

export interface TeamLiveWorktreeSummary {
  path: string;
  baseRef?: string;
  status?: string;
  createdAt?: number;
}

export interface TeamLiveDispatchSummary {
  agentTaskId?: TaskId;
  agentPath?: AgentPath;
  runId?: AgentRunId;
  childSessionId?: SessionId;
  mode?: string;
  agentStatus?: string;
  dispatchedAt?: number;
  syncedAt?: number;
  policy?: Record<string, unknown>;
}

export interface TeamLiveToolSummary {
  id: ToolCallId;
  toolName: string;
  status: RuntimeToolCallView["status"];
  updatedAt: number;
  sessionId?: SessionId;
  turnId?: TurnId;
  waitingForApproval: boolean;
  error?: string;
}

export interface TeamLiveApprovalSummary {
  id: ApprovalId;
  permission: string;
  patterns: string[];
  maxApprovalScope?: ApprovalScope;
  status: RuntimeApprovalView["status"];
  createdAt: number;
  sessionId?: SessionId;
  callId?: ToolCallId;
  toolName?: string;
  decision?: RuntimeApprovalView["decision"];
  feedback?: string;
  resolvedAt?: number;
}

export interface TeamLiveRunSummary {
  id: string;
  teamId: TeamId;
  status: RuntimeTeamRunStatus;
  cycle: number;
  phase?: TeamRunLifecyclePhase;
  stopReason?: TeamRunStopReason;
  counts: TeamRunSummaryCounts;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
  mode?: AgentTaskMode;
  once?: boolean;
  maxConcurrentDispatches?: number;
  maxConcurrentVerifications?: number;
}

export type TeamLiveHealthStatus = "ok" | "attention" | "blocked" | "error";

export interface TeamLiveHealth {
  status: TeamLiveHealthStatus;
  reasons: string[];
  counts: {
    runningTasks: number;
    pendingTasks: number;
    blockedTasks: number;
    failedTasks: number;
    pendingApprovals: number;
    activeTools: number;
    pendingMerges: number;
    conflictedMerges: number;
    errors: number;
  };
}

export type TeamLiveAction =
  | { type: "run_loop"; teamId?: TeamId; enabled: boolean; reason?: string }
  | { type: "merge"; teamId?: TeamId; taskId?: TaskId; enabled: boolean; reason?: string }
  | { type: "approve"; approvalId?: ApprovalId; sessionId?: SessionId; enabled: boolean; reason?: string }
  | { type: "reject"; approvalId?: ApprovalId; sessionId?: SessionId; enabled: boolean; reason?: string }
  | { type: "interrupt"; sessionId?: SessionId; enabled: boolean; reason?: string };

export interface ChatSessionInput {
  sessionId?: SessionId;
  limit?: number;
  generatedAt?: string;
  requireSession?: boolean;
}

export interface ChatAgentBatchesInput {
  sessionId?: SessionId;
  limit?: number;
}

export interface RuntimeInlineAgentBatchView {
  id: string;
  callId: ToolCallId;
  batchId?: string;
  toolStatus?: RuntimeToolCallView["status"];
  status: RuntimeAgentBatchStatus;
  expected: number;
  tracked: number;
  terminal: boolean;
  progress: RuntimeInlineAgentBatchProgress;
  counts: RuntimeDelegatedAgentCounts;
  completionPolicy?: RuntimeTaskCompletionPolicy;
  requestedMaxConcurrency?: number;
  observedPeakConcurrency?: number;
  spawnedCount?: number;
  spawnFailureCount?: number;
  spawnFailures: RuntimeInlineAgentSpawnFailure[];
  agents: RuntimeInlineAgentView[];
  messages: RuntimeInlineAgentMessage[];
  integration: RuntimeInlineAgentIntegrationView;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface RuntimeInlineAgentBatchProgress {
  terminal: number;
  expected: number;
}

export interface RuntimeInlineAgentSpawnFailure {
  name: string;
  task: string;
  error: string;
  batchIndex?: number;
}

export interface RuntimeInlineAgentView {
  taskId: TaskId;
  runId?: AgentRunId;
  path: AgentPath;
  name: string;
  task: string;
  taskPrompt?: string;
  description?: string;
  status: AgentTaskStatus;
  turns: number;
  followupCount: number;
  activity?: RuntimeDelegatedAgentActivity;
  summary?: string;
  error?: string;
  messages: RuntimeInlineAgentMessage[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export type RuntimeInlineAgentMessageDirection = "parent_to_agent" | "agent_to_parent" | "agent_to_agent" | "related";

export interface RuntimeInlineAgentMessage {
  id: string;
  direction: RuntimeInlineAgentMessageDirection;
  from: AgentPath;
  to: AgentPath;
  status: RuntimeAgentMailboxMessageView["status"];
  text: string;
  time: number;
  triggerTurn: boolean;
  kind?: string;
  metadataSummary?: RuntimeAgentMailboxMetadataSummary;
}

export type RuntimeInlineAgentIntegrationStatus =
  | "pending"
  | "ready"
  | "integrating"
  | "responded"
  | "integrated"
  | "not_required";

export interface RuntimeInlineAgentIntegrationView {
  required: boolean;
  status: RuntimeInlineAgentIntegrationStatus;
  updatedAt: number;
  completionPolicy?: RuntimeTaskCompletionPolicy;
  evidence?:
    | "agent_work"
    | "results_ready"
    | "tool_result"
    | "mailbox_queued"
    | "mailbox_delivered"
    | "parent_turn_started"
    | "assistant_response_after_terminal_result"
    | "explicit_integration";
  turnId?: TurnId;
  messageId?: string;
}

export interface ChatSessionView {
  sessionId?: SessionId;
  cwd?: string;
  status: RuntimeSessionStatus | "unknown";
  statusReason?: string;
  items: ChatTranscriptItem[];
  pendingApprovals: ChatApprovalRow[];
  activeTools: ChatToolCallRow[];
  goal?: SessionGoal;
  generatedAt: string;
  latestModelMetadata?: ModelMetadataPayload;
  usageSummary?: ModelUsage;
  retry?: RuntimeTurnRetryView;
  lastEventId?: string;
}

export type ChatTranscriptItem =
  | ChatMessageRow
  | ChatToolCallRow
  | ChatApprovalRow;

export interface ChatMessageRow {
  id: MessageId;
  kind: "message";
  role: MessageRole;
  parts: ChatMessagePart[];
  createdAt: number;
  completedAt?: number;
}

export type ChatMessagePart =
  | { type: "text"; id: PartId; text: string; phase?: AssistantMessagePhase; rawText?: string; synthetic?: boolean }
  | { type: "image"; id: PartId; mimeType: string; filename?: string; sourcePath?: string; displayText?: string }
  | { type: "reasoning"; id: PartId; text: string; redacted?: boolean }
  | { type: "tool_call"; id: PartId; callId: ToolCallId; toolName: string; status: ToolPartStatus; input?: unknown; displayStatus?: ChatToolDisplayStatus }
  | { type: "tool_result"; id: PartId; callId: ToolCallId; output: string; content?: Extract<MessagePart, { type: "tool_result" }>["content"]; error?: string; executionContext?: ChatToolExecutionContext; synthetic?: boolean }
  | { type: "summary"; id: PartId; text: string };

export type ChatToolDisplayStatus =
  | "queued"
  | "checking"
  | "waiting_permission"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled";

export interface ChatToolInputSummary {
  title: string;
  detail?: string;
  scope?: string;
  command?: string;
  path?: string;
  pattern?: string;
  diffSummary?: string;
}

type ChatToolInputSummaryDraft = {
  title: string;
  detail?: string | undefined;
  scope?: string | undefined;
  command?: string | undefined;
  path?: string | undefined;
  pattern?: string | undefined;
  diffSummary?: string | undefined;
};

export interface ChatToolCallRow {
  id: ToolCallId;
  kind: "tool";
  toolName: string;
  status: RuntimeToolCallView["status"];
  displayStatus: ChatToolDisplayStatus;
  waitingForApproval: boolean;
  updatedAt: number;
  inputSummary: ChatToolInputSummary;
  input?: unknown;
  output?: string;
  error?: string;
  executionContext?: ChatToolExecutionContext;
  liveOutput?: RuntimeToolOutputDelta[];
  sessionId?: SessionId;
  approvalId?: ApprovalId;
  approvalStatus?: RuntimeApprovalView["status"];
  approvalDecision?: RuntimeApprovalView["decision"];
}

export interface ChatApprovalRow {
  id: ApprovalId;
  kind: "approval";
  permission: string;
  patterns: string[];
  maxApprovalScope?: ApprovalScope;
  status: RuntimeApprovalView["status"];
  createdAt: number;
  sessionId?: SessionId;
  callId?: ToolCallId;
  toolName?: string;
  toolInput?: unknown;
  toolStatus?: RuntimeToolCallView["status"];
  toolDisplayStatus?: ChatToolDisplayStatus;
  inputSummary: ChatToolInputSummary;
  metadata?: Record<string, unknown>;
  decision?: RuntimeApprovalView["decision"];
  feedback?: string;
  resolvedAt?: number;
}

export function createRuntimeView(): ChiliRuntimeView {
  return {
    sessionIds: [],
    sessions: {},
    turnStatuses: {},
    turnStartedAt: {},
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
    teamIdByDelegatedTaskId: {},
    teamIds: [],
    teams: {},
    teamMemberIds: [],
    teamMembers: {},
    teamMessageIds: [],
    teamMessages: {},
    teamRunIds: [],
    teamRuns: {},
    teamRunIdsByTeam: {},
    modelMetadataTurnIds: [],
    modelMetadataByTurn: {},
    goalsBySession: {},
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
  if (!isTransientEvent(inputEvent)) view.lastEventId = inputEvent.id;
  applyTeamProjectionEvent(view, inputEvent);
  applySubagentProjectionEvent(view, inputEvent);

  const event = inputEvent as ChiliEvent;
  switch (event.type) {
    case "session.created": {
      const sessionId = matchingEnvelopeSessionId(event.sessionId, event.payload?.sessionId);
      if (!sessionId) break;
      const session = upsertSession(view, sessionId, event.time);
      session.cwd = event.payload.cwd;
      session.lifecycle = "active";
      session.updatedAt = event.time;
      break;
    }
    case "session.renamed": {
      const sessionId = matchingEnvelopeSessionId(event.sessionId, event.payload?.sessionId);
      if (!sessionId) break;
      const session = upsertSession(view, sessionId, event.time);
      session.title = event.payload.title;
      session.updatedAt = event.time;
      break;
    }
    case "session.status_changed": {
      const sessionId = matchingEnvelopeSessionId(event.sessionId, event.payload?.sessionId);
      if (!sessionId) break;
      const session = upsertSession(view, sessionId, event.time);
      session.hasExplicitStatus = true;
      setSessionStatus(session, event.payload.status, event.payload.reason);
      clearSessionRetry(view, sessionId, event.payload.turnId);
      session.updatedAt = event.time;
      assignOptional(session, "currentTurnId", event.payload.turnId);
      if (event.payload.turnId && event.payload.status === "cancelled") {
        view.turnStatuses[event.payload.turnId] = "cancelled";
      }
      break;
    }
    case "session.delegation_changed": {
      const sessionId = matchingEnvelopeSessionId(event.sessionId, event.payload?.sessionId);
      if (!sessionId) break;
      const session = upsertSession(view, sessionId, event.time);
      session.delegationPolicy = event.payload.policy;
      session.updatedAt = event.time;
      break;
    }
    case "session.archived": {
      const sessionId = matchingEnvelopeSessionId(event.sessionId, event.payload?.sessionId);
      if (!sessionId) break;
      const session = upsertSession(view, sessionId, event.time);
      session.lifecycle = "archived";
      session.updatedAt = event.time;
      break;
    }
    case "turn.started": {
      view.turnStatuses[event.payload.turnId] = "running";
      view.turnStartedAt[event.payload.turnId] = event.time;
      if (event.sessionId) {
        const session = upsertSession(view, event.sessionId, event.time);
        if (!session.hasExplicitStatus) setSessionStatus(session, "running");
        clearSessionRetry(view, event.sessionId, event.payload.turnId);
        session.currentTurnId = event.payload.turnId;
        session.updatedAt = event.time;
      }
      break;
    }
    case "turn.completed": {
      view.turnStatuses[event.payload.turnId] = event.payload.status;
      if (event.sessionId) {
        const session = upsertSession(view, event.sessionId, event.time);
        const isCurrentTurn = session.currentTurnId === undefined || session.currentTurnId === event.payload.turnId;
        if (!session.hasExplicitStatus) {
          setSessionStatus(session, event.payload.status === "completed" ? "idle" : event.payload.status);
        } else if (
          isCurrentTurn
          && (event.payload.status === "failed" || event.payload.status === "cancelled")
          && !isTerminalSessionStatus(session.status)
        ) {
          // A turn terminal event is persisted before the matching session
          // terminal event. Preserve the session event as the normal source of
          // truth, but fail closed if a crash leaves only the turn terminal.
          setSessionStatus(session, event.payload.status);
        }
        clearSessionRetry(view, event.sessionId, event.payload.turnId);
        if (isCurrentTurn) session.currentTurnId = event.payload.turnId;
        session.updatedAt = event.time;
      }
      break;
    }
    case "turn.retry_scheduled": {
      if (event.sessionId) {
        const session = upsertSession(view, event.sessionId, event.time);
        session.retry = {
          turnId: event.payload.turnId,
          attempt: event.payload.attempt,
          delayMs: event.payload.delayMs,
          reason: event.payload.reason,
          scheduledAt: event.time,
        };
        session.updatedAt = event.time;
      }
      break;
    }
    case "turn.model_metadata": {
      const existing = view.modelMetadataByTurn[event.payload.turnId];
      if (!existing) {
        view.modelMetadataTurnIds.push(event.payload.turnId);
      }
      view.modelMetadataByTurn[event.payload.turnId] = runtimeModelMetadata(event.payload, event.time, event.sessionId, existing);
      const sessionId = event.sessionId ?? existing?.sessionId;
      if (sessionId) {
        clearSessionRetry(view, sessionId, event.payload.turnId);
        touchSession(view, sessionId, event.time);
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
          updatedAt: event.time,
        };
        assignOptional(message, "turnId", event.payload.turnId);
        view.messages[message.id] = message;
        session.messageIds.push(message.id);
      }
      session.updatedAt = event.time;
      break;
    }
    case "message.part_added": {
      const message = view.messages[event.payload.messageId];
      if (!message) break;
      if (message.turnId) clearSessionRetry(view, message.sessionId, message.turnId);
      const existingIndex = message.parts.findIndex((part) => part.id === event.payload.part.id);
      if (existingIndex >= 0) {
        message.parts[existingIndex] = event.payload.part;
        view.partIndex[event.payload.part.id] = { messageId: message.id, index: existingIndex };
      } else {
        message.parts.push(event.payload.part);
        view.partIndex[event.payload.part.id] = { messageId: message.id, index: message.parts.length - 1 };
      }
      message.updatedAt = event.time;
      if (event.payload.part.type === "text" && (event.payload.part.displayText ?? event.payload.part.text).trim().length > 0) {
        message.lastTextAt = event.time;
      }
      touchSession(view, message.sessionId, event.time);
      break;
    }
    case "message.part_delta": {
      const entry = view.partIndex[event.payload.partId];
      const message = entry ? view.messages[entry.messageId] : undefined;
      if (message?.turnId) clearSessionRetry(view, message.sessionId, message.turnId);
      applyPartDelta(view, event.payload.partId as PartId, event.payload.field, event.payload.delta);
      if (message && entry) {
        message.updatedAt = event.time;
        const part = message.parts[entry.index];
        if (part?.type === "text" && (part.displayText ?? part.text).trim().length > 0) message.lastTextAt = event.time;
      }
      if (event.sessionId) touchSession(view, event.sessionId, event.time);
      break;
    }
    case "tool.call_started": {
      if (event.sessionId) clearSessionRetry(view, event.sessionId, event.payload.turnId);
      const toolCall: RuntimeToolCallView = {
        id: event.payload.callId,
        status: "running",
        toolName: event.payload.toolName,
        input: event.payload.input,
        startedAt: event.time,
        updatedAt: event.time,
      };
      assignOptional(toolCall, "sessionId", event.sessionId);
      assignOptional(toolCall, "turnId", event.payload.turnId);
      view.toolCalls[toolCall.id] = toolCall;
      linkToolCallToSession(view, toolCall, event.time);
      setToolPartStatus(view, event.payload.callId, "running");
      break;
    }
    case "tool.call_updated": {
      const toolCall = upsertToolCall(view, event.payload.callId, event.time);
      toolCall.status = event.payload.status;
      if (event.payload.toolName !== undefined) toolCall.toolName = event.payload.toolName;
      if (hasOwn(event.payload, "input")) toolCall.input = event.payload.input;
      assignOptional(toolCall, "sessionId", event.sessionId);
      assignOptional(toolCall, "metadata", event.payload.metadata);
      toolCall.updatedAt = event.time;
      linkToolCallToSession(view, toolCall, event.time);
      setToolPartStatus(view, event.payload.callId, event.payload.status);
      if (event.payload.status === "waiting_for_approval" && toolCall.sessionId) {
        const session = upsertSession(view, toolCall.sessionId, event.time);
        if (!session.hasExplicitStatus) setSessionStatus(session, "waiting_for_approval");
        session.updatedAt = event.time;
      } else if (
        event.payload.status === "running"
        && toolCall.sessionId
        && !hasPendingApprovalForSession(view, toolCall.sessionId)
      ) {
        const session = upsertSession(view, toolCall.sessionId, event.time);
        if (!session.hasExplicitStatus && session.status === "waiting_for_approval") {
          setSessionStatus(session, "running");
          session.updatedAt = event.time;
        }
      }
      break;
    }
    case "tool.output_delta": {
      const toolCall = upsertToolCall(view, event.payload.callId, event.time);
      appendToolOutputDelta(toolCall, {
        stream: event.payload.stream,
        delta: event.payload.delta,
        time: event.time,
        ...(event.payload.bytes === undefined ? {} : { bytes: event.payload.bytes }),
        ...(event.payload.truncated === undefined ? {} : { truncated: event.payload.truncated }),
        ...(event.payload.sequence === undefined ? {} : { sequence: event.payload.sequence }),
      });
      assignOptional(toolCall, "sessionId", event.sessionId);
      toolCall.updatedAt = event.time;
      linkToolCallToSession(view, toolCall, event.time);
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
      assignOptional(approval, "callId", event.payload.callId);
      assignOptional(approval, "maxApprovalScope", event.payload.maxApprovalScope);
      assignOptional(approval, "metadata", event.payload.metadata);
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
    case "goal.updated": {
      const sourceGoal = event.payload?.goal;
      const sessionId = matchingEnvelopeSessionId(event.sessionId, sourceGoal?.sessionId);
      if (!sessionId || !sourceGoal) break;
      const goal = cloneSessionGoal(sourceGoal);
      goal.sessionId = sessionId;
      view.goalsBySession[sessionId] = goal;
      touchSession(view, sessionId, event.time);
      break;
    }
    case "goal.cleared": {
      const sessionId = matchingEnvelopeSessionId(event.sessionId, event.payload?.sessionId);
      if (!sessionId) break;
      delete view.goalsBySession[sessionId];
      touchSession(view, sessionId, event.time);
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

/**
 * Projects parent execution, ad-hoc delegation, and persistent teams without
 * conflating their lifecycles. Parent execution may be idle while background
 * agents remain active.
 */
export function runtimeDelegationStatus(
  view: ChiliRuntimeView,
  input: RuntimeDelegationStatusInput = {},
): RuntimeDelegationStatusView {
  const requestedSessionId = input.sessionId ?? input.delegationConfig?.sessionId;
  const session = requestedSessionId
    ? view.sessions[requestedSessionId]
    : latestDelegationParentSession(view);
  const sessionId = requestedSessionId ?? session?.id;
  const items = delegatedAgentsForScope(view, sessionId);
  const counts = delegatedAgentCounts(items.map((item) => item.status));
  const active = items.filter((item) => item.status === "pending" || item.status === "running");
  const errors = delegatedAgentErrors(items);
  const teams = visibleTeamSummaries(view, sessionId);
  const selectedTeam = input.teamId ? teams.find((team) => team.id === input.teamId) : teams[0];
  const lastBatch = latestAgentBatch(view, sessionId);
  const configured = input.delegationConfig?.sessionId === sessionId ? input.delegationConfig : undefined;
  const policy = configured?.policy ?? session?.delegationPolicy;
  const observed = items.length > 0 || teams.length > 0 || lastBatch !== undefined;
  const delegation: RuntimeDelegationCapabilityView = { observed };
  if (configured || policy || observed) delegation.supported = true;
  assignOptional(delegation, "policy", policy);
  assignOptional(delegation, "source", configured?.source ?? (session?.delegationPolicy ? "session" : undefined));

  const parent: RuntimeParentExecutionView = {
    status: session?.status ?? "unknown",
    active: isActiveParentStatus(session?.status),
  };
  assignOptional(parent, "sessionId", sessionId);
  assignOptional(parent, "statusReason", session?.statusReason);

  const team: RuntimeDelegationTeamView = {
    count: teams.length,
    activeCount: teams.filter((item) => item.status === "active").length,
  };
  assignOptional(team, "selectedTeamId", selectedTeam?.id);
  assignOptional(team, "selectedName", selectedTeam?.name || undefined);

  const output: RuntimeDelegationStatusView = {
    delegation,
    parent,
    agents: { counts, items, active, errors },
    team,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
  assignOptional(output, "lastBatch", lastBatch);
  assignOptional(output, "lastEventId", view.lastEventId);
  return output;
}

/**
 * Projects ad-hoc task lifecycles for inline chat cards. The result is kept
 * separate from ChatSessionView.items so callers can attach a card to the
 * originating tool call without changing persisted transcript item shapes.
 */
export function chatAgentBatches(
  view: ChiliRuntimeView,
  input: ChatAgentBatchesInput = {},
): RuntimeInlineAgentBatchView[] {
  const session = input.sessionId
    ? view.sessions[input.sessionId]
    : latestDelegationParentSession(view);
  const sessionId = input.sessionId ?? session?.id;
  const candidates = agentBatchCandidates(view, sessionId);
  const delegatedByTaskId = new Map(
    delegatedAgentsForScope(view, sessionId).map((agent) => [agent.taskId, agent]),
  );
  const limit = Math.max(1, input.limit ?? 20);
  return candidates
    .slice(0, limit)
    .map((candidate, index) => inlineAgentBatchView(
      view,
      candidate,
      delegatedByTaskId,
      candidates[index - 1]?.startedAt,
    ))
    .sort((left, right) => left.createdAt - right.createdAt || left.callId.localeCompare(right.callId));
}

export function chatSessionView(view: ChiliRuntimeView, input: ChatSessionInput = {}): ChatSessionView {
  const limit = Math.max(1, input.limit ?? 80);
  const session = input.sessionId ? view.sessions[input.sessionId] : input.requireSession ? undefined : latestSession(view);
  const sessionId = input.sessionId ?? session?.id;
  const hiddenTurnIds = session ? outputFreeCancelledTurnIds(view, session) : new Set<string>();
  const messages = session
    ? session.messageIds.flatMap((messageId) => {
      const message = view.messages[messageId];
      if (!message || (message.turnId && hiddenTurnIds.has(message.turnId))) return [];
      return [chatMessageRow(message)];
    })
    : [];
  const executionContexts = session
    ? toolResultExecutionContexts(view, session)
    : new Map<ToolCallId, ChatToolExecutionContext>();
  const tools = session
    ? session.toolCallIds.flatMap((callId) => {
      const toolCall = view.toolCalls[callId];
      if (!toolCall || (toolCall.turnId && hiddenTurnIds.has(toolCall.turnId))) return [];
      return [chatToolCallRow(view, toolCall, executionContexts.get(callId))];
    })
    : [];
  const approvals = session
    ? session.approvalIds.flatMap((approvalId) => {
      const approval = view.approvals[approvalId];
      if (!approval) return [];
      const turnId = approval.callId ? view.toolCalls[approval.callId]?.turnId : undefined;
      if (turnId && hiddenTurnIds.has(turnId)) return [];
      return [chatApprovalRow(view, approval)];
    })
    : [];
  const modelMetadata = session
    ? modelMetadataForSession(view, session.id)
    : [];
  const latestModelMetadata = modelMetadata.at(-1);
  const usageSummary = modelUsageSummary(modelMetadata);
  const goal = sessionId ? view.goalsBySession[sessionId] : undefined;
  const items = [...messages, ...tools, ...approvals]
    .sort((left, right) => chatItemTime(left) - chatItemTime(right))
    .slice(-limit);
  const pendingApprovalRows = approvals.filter((approval) => approval.status === "pending");
  const effectiveStatus = session?.status === "running"
    && (pendingApprovalRows.length > 0
      || tools.some((tool) => tool.status === "waiting_for_approval"))
    ? "waiting_for_approval"
    : session?.status ?? "unknown";
  const output: ChatSessionView = {
    status: effectiveStatus,
    items,
    pendingApprovals: pendingApprovalRows,
    activeTools: tools.filter((tool) => tool.status === "running" || tool.status === "waiting_for_approval" || tool.status === "validating"),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
  assignOptional(output, "sessionId", sessionId);
  assignOptional(output, "cwd", session?.cwd || undefined);
  assignOptional(output, "statusReason", session?.statusReason);
  assignOptional(output, "goal", goal ? cloneSessionGoal(goal) : undefined);
  assignOptional(output, "latestModelMetadata", latestModelMetadata ? chatModelMetadata(latestModelMetadata) : undefined);
  assignOptional(output, "usageSummary", usageSummary);
  assignOptional(output, "retry", session?.retry ? { ...session.retry } : undefined);
  assignOptional(output, "lastEventId", view.lastEventId);
  return output;
}

function outputFreeCancelledTurnIds(
  view: ChiliRuntimeView,
  session: RuntimeSessionView,
): Set<string> {
  const cancelledTurnIds = new Set(
    Object.entries(view.turnStatuses)
      .filter(([, status]) => status === "cancelled")
      .map(([turnId]) => turnId),
  );
  if (session.status === "cancelled" && session.currentTurnId) {
    cancelledTurnIds.add(session.currentTurnId);
  }
  if (cancelledTurnIds.size === 0) return cancelledTurnIds;

  for (const messageId of session.messageIds) {
    const message = view.messages[messageId];
    if (
      !message?.turnId
      || message.role === "user"
      || !cancelledTurnIds.has(message.turnId)
    ) {
      continue;
    }
    if (message.parts.some(isMeaningfulAssistantOutput)) cancelledTurnIds.delete(message.turnId);
  }
  for (const callId of session.toolCallIds) {
    const toolCall = view.toolCalls[callId];
    if (toolCall?.turnId) {
      cancelledTurnIds.delete(toolCall.turnId);
    }
  }
  return cancelledTurnIds;
}

function isMeaningfulAssistantOutput(part: MessagePart): boolean {
  if (part.type === "reasoning") return false;
  if (part.type === "text") return part.text.trim().length > 0;
  if (part.type === "tool_result") {
    return (
      part.output.trim().length > 0
      || (part.error?.trim().length ?? 0) > 0
      || (part.content?.length ?? 0) > 0
      || (part.artifactIds?.length ?? 0) > 0
    );
  }
  return true;
}

function latestSession(view: ChiliRuntimeView): RuntimeSessionView | undefined {
  for (let index = view.sessionIds.length - 1; index >= 0; index -= 1) {
    const session = view.sessions[view.sessionIds[index] ?? ""];
    if (session) return session;
  }
  return undefined;
}

function latestDelegationParentSession(view: ChiliRuntimeView): RuntimeSessionView | undefined {
  const childSessionIds = new Set<SessionId>();
  for (const task of Object.values(view.tasks)) {
    if (task.childSessionId) childSessionIds.add(task.childSessionId);
  }
  for (const member of Object.values(view.teamMembers)) {
    if (member.childSessionId) childSessionIds.add(member.childSessionId);
  }
  for (let index = view.sessionIds.length - 1; index >= 0; index -= 1) {
    const session = view.sessions[view.sessionIds[index] ?? ""];
    if (session && !childSessionIds.has(session.id)) return session;
  }
  return latestSession(view);
}

function isActiveParentStatus(status: RuntimeSessionStatus | undefined): boolean {
  return status === "running" || status === "waiting_for_approval" || status === "cancelling";
}

function delegatedAgentsForScope(
  view: ChiliRuntimeView,
  sessionId: SessionId | undefined,
): RuntimeDelegatedAgent[] {
  const teamAgentTaskIds = linkedTeamAgentTaskIds(view);
  const agentsByTaskId = new Map<TaskId, RuntimeAgentView>();
  for (const runId of view.agentRunIds) {
    const agent = view.agents[runId];
    if (!agent || !matchesSessionScope(agent.sessionId, sessionId)) continue;
    for (const taskId of agent.taskIds) {
      if (teamAgentTaskIds.has(taskId)) continue;
      const current = agentsByTaskId.get(taskId);
      if (
        !current
        || agent.generation > current.generation
        || (agent.generation === current.generation && agent.updatedAt > current.updatedAt)
      ) {
        agentsByTaskId.set(taskId, agent);
      }
    }
  }

  const items = view.taskIds.flatMap((taskId) => {
    const task = view.tasks[taskId];
    const agent = agentsByTaskId.get(taskId);
    if (
      !task
      || task.teamId
      || teamAgentTaskIds.has(taskId)
      || (!task.childSessionId && !agent)
      || !matchesSessionScope(task.sessionId ?? agent?.sessionId, sessionId)
    ) {
      return [];
    }
    const path = task.path ?? task.ownerPath ?? agent?.path;
    if (!path) return [];
    const status = delegatedAgentStatus(task, agent);
    if (!status) return [];
    const item: RuntimeDelegatedAgent = {
      taskId,
      path,
      taskName: task.title ?? agent?.taskName ?? taskId,
      status,
      updatedAt: Math.max(task.updatedAt, agent?.updatedAt ?? 0),
    };
    assignOptional(item, "runId", agent?.id);
    assignOptional(item, "mode", task.mode ?? agent?.mode);
    assignOptional(item, "childSessionId", task.childSessionId ?? agent?.childSessionId);
    assignOptional(item, "sourceCallId", task.sourceCallId);
    assignOptional(item, "batchId", task.batchId);
    assignOptional(item, "batchIndex", task.batchIndex);
    assignOptional(item, "expectedBatchSize", task.expectedBatchSize);
    assignOptional(item, "completionPolicy", task.completionPolicy);
    assignOptional(item, "maxConcurrency", task.maxConcurrency);
    assignOptional(item, "summary", task.summary ?? agent?.summary);
    assignOptional(item, "error", task.error ?? agent?.error);
    assignOptional(item, "completedAt", task.completedAt ?? agent?.completedAt);
    if (status === "pending" || status === "running") {
      assignOptional(item, "activity", delegatedAgentActivity(view, item));
    }
    return [item];
  });

  return items.sort((left, right) => {
    const activeRank = (item: RuntimeDelegatedAgent) => item.status === "pending" || item.status === "running" ? 0 : 1;
    return activeRank(left) - activeRank(right) || right.updatedAt - left.updatedAt || left.taskId.localeCompare(right.taskId);
  });
}

function matchesSessionScope(valueSessionId: SessionId | undefined, sessionId: SessionId | undefined): boolean {
  return sessionId ? valueSessionId === sessionId : true;
}

function linkedTeamAgentTaskIds(view: ChiliRuntimeView): Set<TaskId> {
  const ids = new Set<TaskId>(Object.keys(view.teamIdByDelegatedTaskId) as TaskId[]);
  for (const team of Object.values(view.teams)) {
    for (const teamTaskId of team.taskIds) {
      const task = view.tasks[teamTaskId];
      if (!task) continue;
      ids.add(teamTaskId);
      if (!task.metadata) continue;
      for (const linkedTaskId of metadataLinkedTaskIds(task.metadata)) ids.add(linkedTaskId);
    }
  }
  return ids;
}

function delegatedAgentStatus(
  task: RuntimeTaskView,
  agent: RuntimeAgentView | undefined,
): AgentTaskStatus | undefined {
  if (isAgentTaskStatus(task.status) && task.status !== "pending" && task.status !== "running") return task.status;
  const sameGenerationAgent = agent?.generation === task.generation ? agent : undefined;
  if (sameGenerationAgent?.status && sameGenerationAgent.status !== "running") return sameGenerationAgent.status;
  if (task.status === "pending") return sameGenerationAgent?.status === "running" ? "running" : "pending";
  return task.status === "running" ? "running" : undefined;
}

function delegatedAgentActivity(
  view: ChiliRuntimeView,
  agent: RuntimeDelegatedAgent,
): RuntimeDelegatedAgentActivity {
  const childSessionId = agent.childSessionId;
  if (childSessionId) {
    const childSession = view.sessions[childSessionId];
    const currentTurnId = childSession?.currentTurnId;
    const approval = Object.values(view.approvals)
      .filter((item) => {
        if (item.sessionId !== childSessionId || item.status !== "pending") return false;
        if (!currentTurnId || !item.callId) return true;
        return view.toolCalls[item.callId]?.turnId === currentTurnId;
      })
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (approval) {
      return { kind: "approval", label: approval.permission, status: "pending", updatedAt: approval.createdAt };
    }
    const tool = Object.values(view.toolCalls)
      .filter((item) => {
        return item.sessionId === childSessionId
          && (!currentTurnId || item.turnId === currentTurnId)
          && !isFinalToolStatus(item.status);
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (tool) {
      return { kind: "tool", label: tool.toolName || "tool", status: tool.status, updatedAt: tool.updatedAt };
    }
    if (childSession?.status === "waiting_for_approval") {
      return { kind: "waiting", label: "approval", status: childSession.status, updatedAt: childSession.updatedAt };
    }
    if (childSession && childSession.status !== "running") {
      return { kind: "waiting", label: "worker", status: childSession.status, updatedAt: childSession.updatedAt };
    }
  }
  return { kind: "task", label: agent.taskName, status: agent.status, updatedAt: agent.updatedAt };
}

function delegatedAgentCounts(statuses: readonly AgentTaskStatus[]): RuntimeDelegatedAgentCounts {
  const counts: RuntimeDelegatedAgentCounts = {
    total: statuses.length,
    pending: 0,
    running: 0,
    active: 0,
    completed: 0,
    incomplete: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const status of statuses) {
    counts[status] += 1;
    if (status === "pending" || status === "running") counts.active += 1;
  }
  return counts;
}

function delegatedAgentErrors(items: readonly RuntimeDelegatedAgent[]): RuntimeDelegatedAgentError[] {
  return items.flatMap((item) => {
    if (!isAgentErrorStatus(item.status)) return [];
    const error: RuntimeDelegatedAgentError = {
      taskId: item.taskId,
      path: item.path,
      status: item.status,
      message: item.error ?? item.summary ?? `${item.taskName} ${item.status}`,
      updatedAt: item.updatedAt,
    };
    assignOptional(error, "runId", item.runId);
    return [error];
  });
}

function isAgentErrorStatus(
  status: AgentTaskStatus,
): status is Extract<AgentTaskStatus, "incomplete" | "failed" | "cancelled"> {
  return status === "incomplete" || status === "failed" || status === "cancelled";
}

function latestAgentBatch(
  view: ChiliRuntimeView,
  sessionId: SessionId | undefined,
): RuntimeAgentBatchView | undefined {
  const latest = agentBatchCandidates(view, sessionId)[0];
  return latest ? agentBatchFromTasks(view, latest.callId, latest.tasks, latest.call) : undefined;
}

interface RuntimeAgentBatchCandidate {
  callId: ToolCallId;
  call: RuntimeToolCallView | undefined;
  tasks: RuntimeTaskView[];
  startedAt: number;
}

function agentBatchCandidates(
  view: ChiliRuntimeView,
  sessionId: SessionId | undefined,
): RuntimeAgentBatchCandidate[] {
  const provenanceGroups = new Map<string, RuntimeTaskView[]>();
  for (const taskId of view.taskIds) {
    const task = view.tasks[taskId];
    if (!task?.sourceCallId || task.teamId || view.teamIdByDelegatedTaskId[taskId]) continue;
    if (!matchesSessionScope(task.sessionId, sessionId)) continue;
    const key = `${task.sourceCallId}\0${task.batchId ?? "single"}`;
    const tasks = provenanceGroups.get(key) ?? [];
    tasks.push(task);
    provenanceGroups.set(key, tasks);
  }

  const candidates: RuntimeAgentBatchCandidate[] = [];
  const callsWithProvenance = new Set<ToolCallId>();
  for (const tasks of provenanceGroups.values()) {
    const callId = tasks[0]?.sourceCallId;
    if (!callId) continue;
    const call = view.toolCalls[callId];
    callsWithProvenance.add(callId);
    candidates.push({ callId, call, tasks, startedAt: batchStartedAt(call, tasks) });
  }
  for (const call of Object.values(view.toolCalls)) {
    if (
      callsWithProvenance.has(call.id)
      || !isTaskDelegationTool(call.toolName)
      || !matchesSessionScope(call.sessionId, sessionId)
    ) {
      continue;
    }
    const tasks = taskIdsFromBatchToolCall(call).flatMap((taskId) => {
      const task = view.tasks[taskId];
      return task && !task.teamId && !view.teamIdByDelegatedTaskId[taskId] ? [task] : [];
    });
    candidates.push({ callId: call.id, call, tasks, startedAt: batchStartedAt(call, tasks) });
  }
  return candidates.sort((left, right) => {
    return right.startedAt - left.startedAt || right.callId.localeCompare(left.callId);
  });
}

function inlineAgentBatchView(
  view: ChiliRuntimeView,
  candidate: RuntimeAgentBatchCandidate,
  delegatedByTaskId: ReadonlyMap<TaskId, RuntimeDelegatedAgent>,
  nextBatchStartedAt: number | undefined,
): RuntimeInlineAgentBatchView {
  const batch = agentBatchFromTasks(view, candidate.callId, candidate.tasks, candidate.call);
  const taskIds = new Set(candidate.tasks.map((task) => task.id));
  const taskPaths = new Set(candidate.tasks.flatMap((task) => {
    const delegated = delegatedByTaskId.get(task.id);
    const path = task.path ?? task.ownerPath ?? delegated?.path;
    return path ? [path] : [];
  }));
  const rawMessages = inlineBatchMailboxMessages(
    view,
    candidate,
    taskIds,
    taskPaths,
    batch.batchId,
    nextBatchStartedAt,
  );
  const messages = rawMessages.map((message) => inlineAgentMessage(message, taskPaths));
  const agents = candidate.tasks
    .map((task) => inlineAgentView(view, task, delegatedByTaskId.get(task.id), messages))
    .sort((left, right) => {
      const leftTask = view.tasks[left.taskId];
      const rightTask = view.tasks[right.taskId];
      return (leftTask?.batchIndex ?? Number.MAX_SAFE_INTEGER) - (rightTask?.batchIndex ?? Number.MAX_SAFE_INTEGER)
        || left.createdAt - right.createdAt
        || left.taskId.localeCompare(right.taskId);
    });
  const spawnFailures = inlineSpawnFailures(candidate.call, batch.spawnFailures ?? []);
  const terminalTaskCount = batch.completed + batch.incomplete + batch.failed + batch.cancelled;
  const outputStatus = delegatedTaskStatusFromToolOutput(candidate.call);
  const structuralFailureCount = candidate.tasks.length === 0
    && (candidate.call?.status === "failed" || candidate.call?.status === "cancelled")
    ? batch.expected
    : 0;
  const outputTerminalCount = candidate.tasks.length === 0 && outputStatus && isFinalTaskStatus(outputStatus)
    ? batch.expected
    : 0;
  const resolved = Math.min(
    batch.expected,
    Math.max(
      terminalTaskCount + (batch.spawnFailureCount ?? 0),
      structuralFailureCount,
      outputTerminalCount,
    ),
  );
  const terminal = batch.active === 0
    && batch.expected > 0
    && resolved >= batch.expected;
  const status = !terminal && (
    batch.status === "completed"
    || outputStatus === "pending"
    || outputStatus === "running"
  ) ? "running" : batch.status;
  const completionPolicy = batch.completionPolicy ?? defaultCompletionPolicy(candidate.call);
  const integration = inlineAgentIntegration(
    view,
    candidate,
    terminal,
    completionPolicy,
    rawMessages,
  );
  const updatedAt = Math.max(
    batch.updatedAt,
    integration.updatedAt,
    ...messages.map((message) => message.time),
  );
  const output: RuntimeInlineAgentBatchView = {
    id: `agent_batch:${candidate.callId}:${batch.batchId ?? "single"}`,
    callId: candidate.callId,
    status,
    expected: batch.expected,
    tracked: batch.total,
    terminal,
    progress: { terminal: resolved, expected: batch.expected },
    counts: inlineAgentCounts(batch),
    spawnFailures,
    agents,
    messages,
    integration,
    createdAt: candidate.startedAt,
    updatedAt,
  };
  assignOptional(output, "batchId", batch.batchId);
  assignOptional(output, "toolStatus", candidate.call?.status);
  assignOptional(output, "completionPolicy", completionPolicy);
  assignOptional(output, "requestedMaxConcurrency", batch.maxConcurrency ?? maxConcurrencyFromToolCall(candidate.call));
  assignOptional(output, "observedPeakConcurrency", observedPeakConcurrency(view, taskIds));
  assignOptional(output, "spawnedCount", batch.spawnedCount);
  assignOptional(output, "spawnFailureCount", batch.spawnFailureCount);
  assignOptional(output, "error", batch.error);
  return output;
}

function inlineAgentCounts(batch: RuntimeAgentBatchView): RuntimeDelegatedAgentCounts {
  return {
    total: batch.total,
    pending: batch.pending,
    running: batch.running,
    active: batch.active,
    completed: batch.completed,
    incomplete: batch.incomplete,
    failed: batch.failed,
    cancelled: batch.cancelled,
  };
}

function inlineAgentView(
  view: ChiliRuntimeView,
  task: RuntimeTaskView,
  delegated: RuntimeDelegatedAgent | undefined,
  batchMessages: readonly RuntimeInlineAgentMessage[],
): RuntimeInlineAgentView {
  const path = task.path ?? task.ownerPath ?? delegated?.path ?? (`/root/${task.id}` as AgentPath);
  const taskRuns = view.agentRunIds.flatMap((runId) => {
    const run = view.agents[runId];
    return run?.taskIds.includes(task.id) ? [run] : [];
  });
  const turns = Math.max(1, taskRuns.length);
  const status = delegated?.status ?? inlineTaskStatus(task.status);
  const name = task.title ?? delegated?.taskName ?? agentPathLeaf(path);
  const taskText = task.taskPrompt ?? task.description ?? task.title ?? delegated?.taskName ?? task.id;
  const output: RuntimeInlineAgentView = {
    taskId: task.id,
    path,
    name,
    task: taskText,
    status,
    turns,
    followupCount: Math.max(0, turns - 1),
    messages: batchMessages.filter((message) => {
      const metadataTaskIds = message.metadataSummary?.taskIds;
      return (metadataTaskIds?.length === 1 && metadataTaskIds[0] === task.id)
        || message.from === path
        || message.to === path;
    }),
    createdAt: task.createdAt,
    updatedAt: Math.max(task.updatedAt, delegated?.updatedAt ?? 0),
  };
  assignOptional(output, "runId", delegated?.runId);
  assignOptional(output, "taskPrompt", task.taskPrompt);
  assignOptional(output, "description", task.description ?? task.taskPrompt);
  assignOptional(output, "activity", delegated?.activity);
  assignOptional(output, "summary", task.summary ?? delegated?.summary);
  assignOptional(output, "error", task.error ?? delegated?.error);
  assignOptional(output, "completedAt", task.completedAt ?? delegated?.completedAt);
  return output;
}

function inlineTaskStatus(status: RuntimeTaskStatus): AgentTaskStatus {
  if (isAgentTaskStatus(status)) return status;
  return status === "in_progress" ? "running" : "pending";
}

function agentPathLeaf(path: AgentPath): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function inlineBatchMailboxMessages(
  view: ChiliRuntimeView,
  candidate: RuntimeAgentBatchCandidate,
  taskIds: ReadonlySet<TaskId>,
  taskPaths: ReadonlySet<AgentPath>,
  batchId: string | undefined,
  nextBatchStartedAt: number | undefined,
): RuntimeAgentMailboxMessageView[] {
  const firstTask = candidate.tasks[0];
  return view.mailboxMessageIds.flatMap((messageId) => {
    const message = view.mailboxMessages[messageId];
    if (!message || message.teamId) return [];
    if (!matchesSessionScope(message.sessionId, firstTask?.sessionId ?? candidate.call?.sessionId)) return [];
    const metadata = message.metadataSummary;
    const strongMatch = (message.taskId !== undefined && taskIds.has(message.taskId))
      || (batchId !== undefined && metadata?.batchId === batchId)
      || metadata?.taskIds?.some((taskId) => taskIds.has(taskId)) === true
      || candidate.tasks.some(
        (task) => task.childSessionId === message.recipientSessionId && message.recipientSessionId !== undefined,
      );
    const pathMatch = taskPaths.has(message.path) || taskPaths.has(message.from);
    const withinWindow = message.queuedAt >= candidate.startedAt
      && (nextBatchStartedAt === undefined || message.queuedAt < nextBatchStartedAt);
    return strongMatch || (pathMatch && withinWindow) ? [message] : [];
  }).sort((left, right) => left.queuedAt - right.queuedAt || left.id.localeCompare(right.id));
}

function inlineAgentMessage(
  message: RuntimeAgentMailboxMessageView,
  taskPaths: ReadonlySet<AgentPath>,
): RuntimeInlineAgentMessage {
  const fromAgent = taskPaths.has(message.from);
  const toAgent = taskPaths.has(message.path);
  const direction: RuntimeInlineAgentMessageDirection = fromAgent && toAgent
    ? "agent_to_agent"
    : fromAgent
      ? "agent_to_parent"
      : toAgent
        ? "parent_to_agent"
        : "related";
  const output: RuntimeInlineAgentMessage = {
    id: message.id,
    direction,
    from: message.from,
    to: message.path,
    status: message.status,
    text: message.preview ?? message.messageKind ?? "Agent message",
    time: message.queuedAt,
    triggerTurn: message.triggerTurn,
  };
  assignOptional(output, "kind", message.messageKind);
  assignOptional(output, "metadataSummary", message.metadataSummary);
  return output;
}

function inlineSpawnFailures(
  call: RuntimeToolCallView | undefined,
  failures: readonly RuntimeAgentBatchSpawnFailure[],
): RuntimeInlineAgentSpawnFailure[] {
  const requests = taskRequestsFromToolCall(call);
  return failures.map((failure, index) => {
    const batchIndex = failure.batchIndex ?? index;
    const request = requests[batchIndex];
    const name = failure.description ?? request?.description ?? `agent ${batchIndex + 1}`;
    const output: RuntimeInlineAgentSpawnFailure = {
      name,
      task: request?.prompt ?? request?.description ?? failure.description ?? name,
      error: failure.error,
    };
    assignOptional(output, "batchIndex", failure.batchIndex);
    return output;
  });
}

function taskRequestsFromToolCall(
  call: RuntimeToolCallView | undefined,
): Array<{ description?: string; prompt?: string }> {
  const input = recordObjectValue(call?.input);
  const raw = Array.isArray(input?.tasks) ? input.tasks : input ? [input] : [];
  return raw.map((item) => {
    const record = recordObjectValue(item);
    const request: { description?: string; prompt?: string } = {};
    assignOptional(request, "description", stringValue(record?.description));
    assignOptional(request, "prompt", stringValue(record?.prompt));
    return request;
  });
}

function observedPeakConcurrency(
  view: ChiliRuntimeView,
  taskIds: ReadonlySet<TaskId>,
): number | undefined {
  const intervals = view.agentRunIds.flatMap((runId) => {
    const run = view.agents[runId];
    if (!run || !run.taskIds.some((taskId) => taskIds.has(taskId))) return [];
    return [{ start: run.createdAt, end: Math.max(run.completedAt ?? Number.POSITIVE_INFINITY, run.createdAt + 1) }];
  });
  if (intervals.length === 0) return undefined;
  let peak = 0;
  for (const point of intervals.map((interval) => interval.start)) {
    peak = Math.max(peak, intervals.filter((interval) => interval.start <= point && point < interval.end).length);
  }
  return peak;
}

function inlineAgentIntegration(
  view: ChiliRuntimeView,
  candidate: RuntimeAgentBatchCandidate,
  terminal: boolean,
  completionPolicy: RuntimeTaskCompletionPolicy | undefined,
  messages: readonly RuntimeAgentMailboxMessageView[],
): RuntimeInlineAgentIntegrationView {
  const batchUpdatedAt = Math.max(
    candidate.call?.updatedAt ?? 0,
    batchTasksUpdatedAt(candidate.tasks),
    candidate.startedAt,
  );
  const required = completionPolicy !== "detached";
  if (!required) {
    const output: RuntimeInlineAgentIntegrationView = {
      required: false,
      status: "not_required",
      updatedAt: batchUpdatedAt,
    };
    assignOptional(output, "completionPolicy", completionPolicy);
    return output;
  }
  if (!terminal) {
    const output: RuntimeInlineAgentIntegrationView = {
      required: true,
      status: "pending",
      updatedAt: batchUpdatedAt,
      evidence: "agent_work",
    };
    assignOptional(output, "completionPolicy", completionPolicy);
    return output;
  }

  const taskIds = new Set(candidate.tasks.map((task) => task.id));
  const batchId = candidate.tasks.find((task) => task.batchId)?.batchId ?? batchIdFromToolCall(candidate.call);
  const completionMessage = [...messages]
    .filter((message) => message.metadataSummary?.kind === "subagent_completion_batch")
    .sort((left, right) => right.queuedAt - left.queuedAt)[0];
  const waitCall = latestMatchingTaskWaitCall(view, candidate, taskIds, batchId, completionPolicy);
  const terminalTasksAt = candidate.tasks.reduce((latest, task) => {
    if (!isFinalTaskStatus(task.status)) return latest;
    return Math.max(latest, task.completedAt ?? task.updatedAt);
  }, candidate.startedAt);
  const waitResultAt = waitCall && waitCall.updatedAt >= terminalTasksAt ? waitCall.updatedAt : undefined;
  if (completionPolicy === "supervised" && waitResultAt === undefined) {
    return {
      required: true,
      status: "pending",
      updatedAt: terminalTasksAt,
      evidence: "results_ready",
      completionPolicy,
    };
  }
  const followupCall = latestMatchingTaskFollowupCall(view, candidate, taskIds, terminalTasksAt);
  const followupResultAt = followupCall?.updatedAt;
  const candidateOutputStatus = delegatedTaskStatusFromToolOutput(candidate.call);
  const candidateReturnedTerminalResults = candidate.call
    && isFinalToolStatus(candidate.call.status)
    && (
      (candidateOutputStatus !== undefined && isFinalTaskStatus(candidateOutputStatus))
      || (
        completionPolicy === "join"
        && candidate.tasks.length > 0
        && candidate.tasks.every((task) => isFinalTaskStatus(task.status) && (task.completedAt ?? task.updatedAt) <= candidate.call!.updatedAt)
      )
      || ((batchSpawnInfo(candidate.call).spawnFailureCount ?? 0) > 0 && batchSpawnInfo(candidate.call).spawnedCount === 0)
      || ((candidate.call.status === "failed" || candidate.call.status === "cancelled") && candidate.tasks.length === 0)
    );
  const candidateResultAt = candidateReturnedTerminalResults
    && candidate.call
    && candidate.call.updatedAt >= terminalTasksAt
    ? candidate.call.updatedAt
    : undefined;
  const evidenceCalls = [
    followupCall && followupResultAt !== undefined ? { call: followupCall, time: followupResultAt } : undefined,
    waitCall && waitResultAt !== undefined ? { call: waitCall, time: waitResultAt } : undefined,
    candidate.call && candidateResultAt !== undefined ? { call: candidate.call, time: candidateResultAt } : undefined,
  ].filter((item): item is { call: RuntimeToolCallView; time: number } => item !== undefined)
    .sort((left, right) => right.time - left.time || right.call.id.localeCompare(left.call.id));
  const evidenceCall = evidenceCalls[0];
  const toolResultAt = evidenceCall?.time;
  const readyAt = Math.max(
    terminalTasksAt,
    completionMessage?.queuedAt ?? 0,
    toolResultAt ?? 0,
  );
  const firstTask = candidate.tasks[0];
  const sessionId = firstTask?.sessionId ?? candidate.call?.sessionId;
  const prompt = completionMessage
    ? matchingCompletionPrompt(view, completionMessage, sessionId)
    : undefined;
  const turnId = prompt?.turnId
    ?? evidenceCall?.call.turnId;
  const responseInEvidenceTurn = turnId
    ? matchingAssistantResponse(view, turnId, sessionId, readyAt)
    : undefined;
  const continuationCall = evidenceCall?.call;
  const continuationEligible = !completionMessage && (continuationCall !== undefined || completionPolicy === "supervised");
  const response = responseInEvidenceTurn ?? (
    continuationEligible
      ? matchingToolContinuationResponse(
        view,
        sessionId,
        readyAt,
      )
      : undefined
  );
  if (response) {
    const output: RuntimeInlineAgentIntegrationView = {
      required: true,
      status: "responded",
      updatedAt: response.lastTextAt ?? response.updatedAt ?? response.createdAt,
      evidence: "assistant_response_after_terminal_result",
      messageId: response.id,
    };
    assignOptional(output, "completionPolicy", completionPolicy);
    assignOptional(output, "turnId", response.turnId ?? turnId);
    return output;
  }
  if (turnId && view.turnStatuses[turnId] === "running") {
    const output: RuntimeInlineAgentIntegrationView = {
      required: true,
      status: "integrating",
      updatedAt: Math.max(readyAt, prompt?.updatedAt ?? prompt?.createdAt ?? readyAt),
      evidence: "parent_turn_started",
      turnId,
    };
    assignOptional(output, "completionPolicy", completionPolicy);
    assignOptional(output, "messageId", prompt?.id);
    return output;
  }
  const continuationTurnId = continuationEligible
    ? matchingToolContinuationTurn(view, sessionId, readyAt)
    : undefined;
  if (continuationTurnId) {
    const output: RuntimeInlineAgentIntegrationView = {
      required: true,
      status: "integrating",
      updatedAt: view.turnStartedAt[continuationTurnId] ?? readyAt,
      evidence: "parent_turn_started",
      turnId: continuationTurnId,
    };
    assignOptional(output, "completionPolicy", completionPolicy);
    return output;
  }

  const output: RuntimeInlineAgentIntegrationView = {
    required: true,
    status: "ready",
    updatedAt: readyAt,
    evidence: completionMessage
      ? completionMessage.status === "consumed" || completionMessage.status === "delivering"
        ? "mailbox_delivered"
        : "mailbox_queued"
      : toolResultAt !== undefined
        ? "tool_result"
        : "results_ready",
  };
  assignOptional(output, "completionPolicy", completionPolicy);
  assignOptional(output, "turnId", turnId);
  assignOptional(output, "messageId", completionMessage?.id);
  return output;
}

function latestMatchingTaskWaitCall(
  view: ChiliRuntimeView,
  candidate: RuntimeAgentBatchCandidate,
  taskIds: ReadonlySet<TaskId>,
  batchId: string | undefined,
  completionPolicy: RuntimeTaskCompletionPolicy | undefined,
): RuntimeToolCallView | undefined {
  return Object.values(view.toolCalls)
    .filter((call) => {
      if (!isTaskWaitTool(call.toolName) || !isFinalToolStatus(call.status)) return false;
      if (completionPolicy === "supervised" && !isSupervisedAllWait(call)) return false;
      if (!matchesSessionScope(call.sessionId, candidate.tasks[0]?.sessionId ?? candidate.call?.sessionId)) return false;
      const input = recordObjectValue(call.input);
      const inputBatchId = stringValue(input?.batchId) ?? stringValue(input?.batch_id);
      const waitedTaskIds = taskIdsFromWaitCall(call);
      if (completionPolicy === "supervised" && ![...taskIds].every((taskId) => waitedTaskIds.includes(taskId))) {
        return false;
      }
      if (batchId && inputBatchId === batchId) return true;
      return waitedTaskIds.some((taskId) => taskIds.has(taskId));
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))[0];
}

function latestMatchingTaskFollowupCall(
  view: ChiliRuntimeView,
  candidate: RuntimeAgentBatchCandidate,
  taskIds: ReadonlySet<TaskId>,
  terminalTasksAt: number,
): RuntimeToolCallView | undefined {
  return Object.values(view.toolCalls)
    .filter((call) => {
      if (!isTaskFollowupTool(call.toolName) || call.status !== "completed" || call.updatedAt < terminalTasksAt) return false;
      if (!matchesSessionScope(call.sessionId, candidate.tasks[0]?.sessionId ?? candidate.call?.sessionId)) return false;
      const input = recordObjectValue(call.input);
      const inputTaskId = stringValue(input?.taskId) ?? stringValue(input?.task_id) ?? stringValue(input?.id);
      if (!inputTaskId || !taskIds.has(inputTaskId as TaskId)) return false;
      const task = view.tasks[inputTaskId];
      const output = jsonRecord(call.output);
      const outputTaskId = stringValue(output?.taskId) ?? stringValue(output?.task_id);
      const outputStatus = taskStatusValue(output?.status);
      if (!task || outputTaskId !== inputTaskId || !outputStatus || !isFinalTaskStatus(outputStatus)) return false;
      if (!isFinalTaskStatus(task.status) || outputStatus !== task.status) return false;
      const outputGeneration = finiteNumberValue(output?.generation);
      return outputGeneration === undefined || outputGeneration === task.generation;
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))[0];
}

function matchingCompletionPrompt(
  view: ChiliRuntimeView,
  completionMessage: RuntimeAgentMailboxMessageView,
  sessionId: SessionId | undefined,
): RuntimeMessageView | undefined {
  const preview = completionMessage.preview;
  const needle = preview?.slice(0, Math.min(96, preview.length));
  if (!needle) return undefined;
  return Object.values(view.messages)
    .filter((message) => {
      if (message.role === "assistant" || !message.turnId) return false;
      if (!matchesSessionScope(message.sessionId, sessionId)) return false;
      if ((message.updatedAt ?? message.createdAt) < completionMessage.queuedAt) return false;
      const text = boundedSingleLine(runtimeMessageText(message), 320);
      return text?.includes(needle) === true;
    })
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
}

function matchingAssistantResponse(
  view: ChiliRuntimeView,
  turnId: TurnId,
  sessionId: SessionId | undefined,
  readyAt: number,
): RuntimeMessageView | undefined {
  return Object.values(view.messages)
    .filter((message) => {
      if (message.role !== "assistant" || message.turnId !== turnId) return false;
      if (!matchesSessionScope(message.sessionId, sessionId)) return false;
      if (!runtimeMessageHasFinalResponse(view, message)) return false;
      return (message.lastTextAt ?? message.updatedAt ?? message.createdAt) >= readyAt;
    })
    .sort((left, right) => {
      return (left.lastTextAt ?? left.updatedAt ?? left.createdAt) - (right.lastTextAt ?? right.updatedAt ?? right.createdAt)
        || left.id.localeCompare(right.id);
    })[0];
}

function matchingToolContinuationResponse(
  view: ChiliRuntimeView,
  sessionId: SessionId | undefined,
  readyAt: number,
): RuntimeMessageView | undefined {
  const nextUserAt = Object.values(view.messages).reduce((earliest, message) => {
    if (message.role !== "user" || message.createdAt <= readyAt) return earliest;
    if (!matchesSessionScope(message.sessionId, sessionId)) return earliest;
    return Math.min(earliest, message.createdAt);
  }, Number.POSITIVE_INFINITY);
  const boundary = nextUserAt;
  return Object.values(view.messages)
    .filter((message) => {
      if (message.role !== "assistant" || !runtimeMessageHasFinalResponse(view, message)) return false;
      if (!matchesSessionScope(message.sessionId, sessionId)) return false;
      const outputAt = message.lastTextAt ?? message.updatedAt ?? message.createdAt;
      return outputAt >= readyAt && outputAt < boundary;
    })
    .sort((left, right) => {
      return (left.lastTextAt ?? left.updatedAt ?? left.createdAt) - (right.lastTextAt ?? right.updatedAt ?? right.createdAt)
        || left.id.localeCompare(right.id);
    })[0];
}

function matchingToolContinuationTurn(
  view: ChiliRuntimeView,
  sessionId: SessionId | undefined,
  readyAt: number,
): TurnId | undefined {
  const nextUserAt = Object.values(view.messages).reduce((earliest, message) => {
    if (message.role !== "user" || message.createdAt <= readyAt) return earliest;
    if (!matchesSessionScope(message.sessionId, sessionId)) return earliest;
    return Math.min(earliest, message.createdAt);
  }, Number.POSITIVE_INFINITY);
  const boundary = nextUserAt;
  const session = sessionId ? view.sessions[sessionId] : undefined;
  return (Object.entries(view.turnStartedAt) as Array<[TurnId, number]>)
    .filter(([turnId, startedAt]) => {
      if (view.turnStatuses[turnId] !== "running" || startedAt < readyAt || startedAt >= boundary) return false;
      if (session?.currentTurnId === turnId) return true;
      return Object.values(view.messages).some((message) => {
        return message.turnId === turnId
          && matchesSessionScope(message.sessionId, sessionId);
      });
    })
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function runtimeMessageHasFinalResponse(view: ChiliRuntimeView, message: RuntimeMessageView): boolean {
  if (!message.turnId) return false;
  const turnStatus = view.turnStatuses[message.turnId];
  if (!turnStatus || turnStatus === "running") return false;
  return message.parts.some((part) => {
    if (part.type !== "text" || (part.displayText ?? part.text).trim().length === 0) return false;
    return part.phase === "final_answer" || part.phase === undefined;
  });
}

function runtimeMessageText(message: RuntimeMessageView): string | undefined {
  const text = message.parts.flatMap((part) => {
    if (part.type !== "text") return [];
    const value = part.displayText ?? part.text;
    return value.trim().length > 0 ? [value] : [];
  }).join(" ");
  return text || undefined;
}

function taskIdsFromWaitCall(call: RuntimeToolCallView): TaskId[] {
  const input = recordObjectValue(call.input);
  const list = taskIdArrayValue(input?.taskIds) ?? taskIdArrayValue(input?.task_ids);
  if (list) return list;
  const single = stringValue(input?.taskId) ?? stringValue(input?.task_id) ?? stringValue(input?.id);
  return single ? [single as TaskId] : [];
}

function agentBatchFromTasks(
  view: ChiliRuntimeView,
  callId: ToolCallId,
  tasks: readonly RuntimeTaskView[],
  inputCall?: RuntimeToolCallView,
): RuntimeAgentBatchView {
  const call = inputCall ?? view.toolCalls[callId];
  const orderedTasks = [...tasks].sort((left, right) => {
    return (left.batchIndex ?? Number.MAX_SAFE_INTEGER) - (right.batchIndex ?? Number.MAX_SAFE_INTEGER)
      || left.createdAt - right.createdAt;
  });
  const statuses = orderedTasks.flatMap((task) => isAgentTaskStatus(task.status) ? [task.status] : []);
  const counts = delegatedAgentCounts(statuses);
  const statusGroups = [counts.active, counts.completed, counts.incomplete, counts.failed, counts.cancelled]
    .filter((count) => count > 0).length;
  const mixed = statusGroups > 1;
  const first = orderedTasks[0];
  const provenanceExpected = orderedTasks.reduce((expected, task) => {
    return Math.max(expected, task.expectedBatchSize ?? 0);
  }, 0);
  const expected = Math.max(counts.total, provenanceExpected, expectedBatchSizeFromToolCall(call) ?? 0);
  const untracked = Math.max(0, expected - counts.total);
  const spawn = batchSpawnInfo(call);
  const allSpawnsFailed = (spawn.spawnFailureCount ?? 0) > 0 && spawn.spawnedCount === 0;
  const partialSpawn = (spawn.spawnFailureCount ?? 0) > 0 && (spawn.spawnedCount ?? counts.total) > 0;
  const partial = partialSpawn || (
    untracked > 0
    && counts.total > 0
    && counts.active === 0
    && (call ? isFinalToolStatus(call.status) : true)
  );
  const status = agentBatchStatus(counts, call?.status, { allSpawnsFailed, mixed, partial, untracked });
  const batch: RuntimeAgentBatchView = {
    callId,
    taskIds: orderedTasks.map((task) => task.id),
    expected,
    untracked,
    ...counts,
    mixed,
    partial,
    status,
    updatedAt: Math.max(call?.updatedAt ?? 0, batchTasksUpdatedAt(orderedTasks)),
  };
  assignOptional(batch, "batchId", first?.batchId ?? batchIdFromToolCall(call));
  assignOptional(batch, "spawnedCount", spawn.spawnedCount);
  assignOptional(batch, "spawnFailureCount", spawn.spawnFailureCount);
  assignOptional(batch, "spawnFailures", spawn.spawnFailures.length > 0 ? spawn.spawnFailures : undefined);
  assignOptional(batch, "completionPolicy", first?.completionPolicy ?? completionPolicyFromToolCall(call));
  assignOptional(batch, "maxConcurrency", first?.maxConcurrency ?? maxConcurrencyFromToolCall(call));
  assignOptional(batch, "error", call?.error ?? spawnFailureSummary(spawn, expected));
  return batch;
}

function agentBatchStatus(
  counts: RuntimeDelegatedAgentCounts,
  toolStatus: RuntimeToolCallView["status"] | undefined,
  state: { allSpawnsFailed: boolean; mixed: boolean; partial: boolean; untracked: number },
): RuntimeAgentBatchStatus {
  if (state.allSpawnsFailed) return "failed";
  if (state.partial) return "partial";
  if (counts.active > 0) return "running";
  if (state.untracked > 0 && toolStatus !== undefined && !isFinalToolStatus(toolStatus)) return "running";
  if (state.mixed) return "mixed";
  if (counts.completed > 0) return "completed";
  if (counts.incomplete > 0) return "incomplete";
  if (counts.failed > 0) return "failed";
  if (counts.cancelled > 0) return "cancelled";
  if (toolStatus === "failed") return "failed";
  if (toolStatus === "cancelled") return "cancelled";
  if (toolStatus === "completed") return "completed";
  return "running";
}

interface RuntimeAgentBatchSpawnInfo {
  spawnedCount: number | undefined;
  spawnFailureCount: number | undefined;
  spawnFailures: RuntimeAgentBatchSpawnFailure[];
}

function batchSpawnInfo(call: RuntimeToolCallView | undefined): RuntimeAgentBatchSpawnInfo {
  if (!call) return { spawnedCount: undefined, spawnFailureCount: undefined, spawnFailures: [] };
  const output = jsonRecord(call.output);
  const spawnFailures = spawnFailureArrayValue(
    call.metadata?.spawnFailures
      ?? call.metadata?.spawn_failures
      ?? output?.spawnFailures
      ?? output?.spawn_failures,
  );
  const declaredSpawnFailureCount = firstBatchCount(
    call.metadata?.spawnFailureCount,
    call.metadata?.spawn_failure_count,
    output?.spawnFailureCount,
    output?.spawn_failure_count,
  );
  const spawnFailureCount = declaredSpawnFailureCount === undefined && spawnFailures.length === 0
    ? undefined
    : Math.max(declaredSpawnFailureCount ?? 0, spawnFailures.length);
  const outputTaskCount = Array.isArray(output?.tasks) ? output.tasks.length : undefined;
  const metadataTaskCount = taskIdArrayValue(call.metadata?.taskIds ?? call.metadata?.task_ids)?.length;
  const spawnedCount = firstBatchCount(
    call.metadata?.spawnedCount,
    call.metadata?.spawned_count,
    output?.spawnedCount,
    output?.spawned_count,
    outputTaskCount,
    metadataTaskCount,
  );
  return { spawnedCount, spawnFailureCount, spawnFailures };
}

function firstBatchCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    const count = finiteNumberValue(value);
    if (count !== undefined && count >= 0) return Math.floor(count);
  }
  return undefined;
}

function spawnFailureArrayValue(value: unknown): RuntimeAgentBatchSpawnFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = recordObjectValue(item);
    if (!record) return [];
    const error = stringValue(record.error) ?? "spawn failed";
    const failure: RuntimeAgentBatchSpawnFailure = { error };
    const batchIndex = firstBatchCount(record.batchIndex, record.batch_index);
    assignOptional(failure, "batchIndex", batchIndex);
    assignOptional(failure, "description", stringValue(record.description));
    return [failure];
  });
}

function spawnFailureSummary(spawn: RuntimeAgentBatchSpawnInfo, expected: number): string | undefined {
  const count = spawn.spawnFailureCount ?? 0;
  if (count <= 0) return undefined;
  const scope = expected > 0 ? `${count} of ${expected}` : String(count);
  const details = [...new Set(spawn.spawnFailures.map((failure) => {
    return failure.description ? `${failure.description}: ${failure.error}` : failure.error;
  }))].slice(0, 3);
  return `${scope} agent ${count === 1 ? "task" : "tasks"} failed to spawn${details.length > 0 ? `: ${details.join("; ")}` : ""}`;
}

function batchStartedAt(
  call: RuntimeToolCallView | undefined,
  tasks: readonly RuntimeTaskView[],
): number {
  if (call?.startedAt !== undefined) return call.startedAt;
  const firstTaskAt = tasks.reduce((earliest, task) => Math.min(earliest, task.createdAt), Number.POSITIVE_INFINITY);
  return Number.isFinite(firstTaskAt) ? firstTaskAt : call?.updatedAt ?? 0;
}

function batchTasksUpdatedAt(tasks: readonly RuntimeTaskView[]): number {
  return tasks.reduce((latest, task) => Math.max(latest, task.updatedAt), 0);
}

function isTaskBatchTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase().split(/[./:]/).at(-1);
  return normalized === "task_batch" || normalized === "agent_batch" || normalized === "spawn_tasks" || normalized === "spawn_agents";
}

function isSingleTaskTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase().split(/[./:]/).at(-1);
  return normalized === "task" || normalized === "agent";
}

function isTaskDelegationTool(toolName: string): boolean {
  return isTaskBatchTool(toolName) || isSingleTaskTool(toolName);
}

function isTaskWaitTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase().split(/[./:]/).at(-1);
  return normalized === "task_wait"
    || normalized === "wait_task"
    || normalized === "agent_wait"
    || normalized === "task_wait_batch"
    || normalized === "wait_tasks"
    || normalized === "agent_wait_batch";
}

function isTaskFollowupTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase().split(/[./:]/).at(-1);
  return normalized === "task_followup" || normalized === "followup_task" || normalized === "agent_followup";
}

function isSupervisedAllWait(call: RuntimeToolCallView): boolean {
  const normalized = call.toolName.trim().toLowerCase().split(/[./:]/).at(-1);
  if (normalized !== "task_wait_batch" && normalized !== "wait_tasks" && normalized !== "agent_wait_batch") {
    return false;
  }
  const input = recordObjectValue(call.input);
  const waitFor = stringValue(input?.waitFor) ?? stringValue(input?.wait_for) ?? "all";
  return waitFor === "all";
}

function taskIdsFromBatchToolCall(call: RuntimeToolCallView): TaskId[] {
  const metadataIds = taskIdArrayValue(call.metadata?.taskIds) ?? taskIdArrayValue(call.metadata?.task_ids);
  if (metadataIds) return metadataIds;
  const metadataTaskId = stringValue(call.metadata?.taskId) ?? stringValue(call.metadata?.task_id);
  if (metadataTaskId) return [metadataTaskId as TaskId];
  const output = jsonRecord(call.output);
  const tasks = Array.isArray(output?.tasks) ? output.tasks : [];
  const taskIds = tasks.flatMap((item) => {
    const record = recordObjectValue(item);
    const taskId = stringValue(record?.taskId) ?? stringValue(record?.task_id);
    return taskId ? [taskId as TaskId] : [];
  });
  if (taskIds.length > 0) return taskIds;
  const outputTaskId = stringValue(output?.taskId) ?? stringValue(output?.task_id);
  return outputTaskId ? [outputTaskId as TaskId] : [];
}

function batchIdFromToolCall(call: RuntimeToolCallView | undefined): string | undefined {
  if (!call) return undefined;
  const input = recordObjectValue(call.input);
  const output = jsonRecord(call.output);
  return stringValue(call.metadata?.batchId)
    ?? stringValue(call.metadata?.batch_id)
    ?? stringValue(input?.batchId)
    ?? stringValue(input?.batch_id)
    ?? stringValue(output?.batchId)
    ?? stringValue(output?.batch_id);
}

function completionPolicyFromToolCall(call: RuntimeToolCallView | undefined): RuntimeTaskCompletionPolicy | undefined {
  if (!call) return undefined;
  const input = recordObjectValue(call.input);
  const output = jsonRecord(call.output);
  return taskCompletionPolicyValue(call.metadata?.completionPolicy)
    ?? taskCompletionPolicyValue(call.metadata?.completion_policy)
    ?? taskCompletionPolicyValue(input?.completionPolicy)
    ?? taskCompletionPolicyValue(input?.completion_policy)
    ?? taskCompletionPolicyValue(output?.completionPolicy)
    ?? taskCompletionPolicyValue(output?.completion_policy);
}

function defaultCompletionPolicy(call: RuntimeToolCallView | undefined): RuntimeTaskCompletionPolicy | undefined {
  if (!call || !isTaskDelegationTool(call.toolName)) return undefined;
  if (isTaskBatchTool(call.toolName)) return "join";
  const input = recordObjectValue(call.input);
  const mode = stringValue(input?.mode) ?? stringValue(input?.subagent_type);
  return mode === "background" ? "notify" : "join";
}

function delegatedTaskStatusFromToolOutput(call: RuntimeToolCallView | undefined): AgentTaskStatus | undefined {
  const output = jsonRecord(call?.output);
  const status = taskStatusValue(output?.status);
  return status && isAgentTaskStatus(status) ? status : undefined;
}

function maxConcurrencyFromToolCall(call: RuntimeToolCallView | undefined): number | undefined {
  if (!call) return undefined;
  const input = recordObjectValue(call.input);
  const output = jsonRecord(call.output);
  return finiteNumberValue(call.metadata?.maxConcurrency)
    ?? finiteNumberValue(call.metadata?.max_concurrency)
    ?? finiteNumberValue(input?.maxConcurrency)
    ?? finiteNumberValue(input?.max_concurrency)
    ?? finiteNumberValue(output?.maxConcurrency)
    ?? finiteNumberValue(output?.max_concurrency);
}

function expectedBatchSizeFromToolCall(call: RuntimeToolCallView | undefined): number | undefined {
  if (!call) return undefined;
  const input = recordObjectValue(call.input);
  const output = jsonRecord(call.output);
  const inputTasks = Array.isArray(input?.tasks) ? input.tasks.length : undefined;
  return finiteNumberValue(call.metadata?.expectedBatchSize)
    ?? finiteNumberValue(call.metadata?.expected_batch_size)
    ?? finiteNumberValue(input?.expectedBatchSize)
    ?? finiteNumberValue(input?.expected_batch_size)
    ?? finiteNumberValue(output?.expectedBatchSize)
    ?? finiteNumberValue(output?.expected_batch_size)
    ?? finiteNumberValue(output?.count)
    ?? inputTasks
    ?? (isSingleTaskTool(call.toolName) ? 1 : undefined);
}

function jsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return recordObjectValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function runtimeModelMetadata(
  payload: ModelMetadataPayload,
  updatedAt: number,
  sessionId: SessionId | undefined,
  existing: RuntimeModelMetadataView | undefined,
): RuntimeModelMetadataView {
  const output: RuntimeModelMetadataView = {
    turnId: payload.turnId,
    updatedAt,
  };
  assignOptional(output, "provider", payload.provider ?? existing?.provider);
  assignOptional(output, "model", payload.model ?? existing?.model);
  assignOptional(output, "responseId", payload.responseId ?? existing?.responseId);
  assignOptional(output, "usage", payload.usage ? cloneModelUsage(payload.usage) : existing?.usage ? cloneModelUsage(existing.usage) : undefined);
  assignOptional(output, "contextWindowTokens", payload.contextWindowTokens ?? existing?.contextWindowTokens);
  assignOptional(output, "maxOutputTokens", payload.maxOutputTokens ?? existing?.maxOutputTokens);
  assignOptional(output, "sessionId", sessionId ?? existing?.sessionId);
  return output;
}

function chatModelMetadata(metadata: RuntimeModelMetadataView): ModelMetadataPayload {
  const output: ModelMetadataPayload = {
    turnId: metadata.turnId,
  };
  assignOptional(output, "provider", metadata.provider);
  assignOptional(output, "model", metadata.model);
  assignOptional(output, "responseId", metadata.responseId);
  assignOptional(output, "usage", metadata.usage ? cloneModelUsage(metadata.usage) : undefined);
  assignOptional(output, "contextWindowTokens", metadata.contextWindowTokens);
  assignOptional(output, "maxOutputTokens", metadata.maxOutputTokens);
  return output;
}

function modelMetadataForSession(
  view: ChiliRuntimeView,
  sessionId: SessionId,
): RuntimeModelMetadataView[] {
  return view.modelMetadataTurnIds
    .flatMap((turnId) => {
      const metadata = view.modelMetadataByTurn[turnId];
      return metadata ? [metadata] : [];
    })
    .filter((metadata) => metadata.sessionId === sessionId)
    .sort((left, right) => left.updatedAt - right.updatedAt);
}

function modelUsageSummary(metadata: readonly RuntimeModelMetadataView[]): ModelUsage | undefined {
  const summary: ModelUsage = {};
  let hasUsage = false;

  for (const item of metadata) {
    const usage = item.usage;
    if (!usage) continue;
    hasUsage = addUsageField(summary, "inputTokens", usage.inputTokens) || hasUsage;
    hasUsage = addUsageField(summary, "outputTokens", usage.outputTokens) || hasUsage;
    hasUsage = addUsageField(summary, "cacheReadInputTokens", usage.cacheReadInputTokens) || hasUsage;
    hasUsage = addUsageField(summary, "cacheCreationInputTokens", usage.cacheCreationInputTokens) || hasUsage;
    const total = usage.totalTokens ?? usageTokenTotal(usage);
    hasUsage = addUsageField(summary, "totalTokens", total) || hasUsage;
  }

  return hasUsage ? summary : undefined;
}

function usageTokenTotal(usage: ModelUsage): number | undefined {
  const parts = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadInputTokens,
    usage.cacheCreationInputTokens,
  ].filter(isFiniteNumber);
  if (parts.length === 0) return undefined;
  return parts.reduce((total, value) => total + value, 0);
}

function addUsageField(summary: ModelUsage, field: keyof Omit<ModelUsage, "raw">, value: number | undefined): boolean {
  if (!isFiniteNumber(value)) return false;
  summary[field] = (summary[field] ?? 0) + value;
  return true;
}

function cloneModelUsage(usage: ModelUsage): ModelUsage {
  const output: ModelUsage = {};
  assignOptional(output, "inputTokens", usage.inputTokens);
  assignOptional(output, "outputTokens", usage.outputTokens);
  assignOptional(output, "cacheReadInputTokens", usage.cacheReadInputTokens);
  assignOptional(output, "cacheCreationInputTokens", usage.cacheCreationInputTokens);
  assignOptional(output, "totalTokens", usage.totalTokens);
  assignOptional(output, "raw", usage.raw);
  return output;
}

function cloneSessionGoal(goal: SessionGoal): SessionGoal {
  const output: SessionGoal = {
    sessionId: goal.sessionId,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
  assignOptional(output, "tokenBudget", goal.tokenBudget);
  assignOptional(output, "completedAt", goal.completedAt);
  assignOptional(output, "lastReason", goal.lastReason);
  return output;
}

function matchingEnvelopeSessionId(
  envelopeSessionId: SessionId | undefined,
  duplicateSessionId: unknown,
): SessionId | undefined {
  return envelopeSessionId && duplicateSessionId === envelopeSessionId ? envelopeSessionId : undefined;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function chatMessageRow(message: RuntimeMessageView): ChatMessageRow {
  const row: ChatMessageRow = {
    id: message.id,
    kind: "message",
    role: message.role,
    parts: message.parts.map((part) => chatMessagePart(part)),
    createdAt: message.createdAt,
  };
  assignOptional(row, "completedAt", message.completedAt);
  return row;
}

function chatMessagePart(part: MessagePart): ChatMessagePart {
  if (part.type === "text") {
    const output: ChatMessagePart = { type: "text", id: part.id, text: part.displayText ?? part.text };
    if (part.displayText && part.displayText !== part.text) output.rawText = part.text;
    assignOptional(output, "phase", part.phase);
    assignOptional(output, "synthetic", part.synthetic);
    return output;
  }
  if (part.type === "image") {
    const output: ChatMessagePart = { type: "image", id: part.id, mimeType: part.mimeType };
    assignOptional(output, "filename", part.filename);
    assignOptional(output, "sourcePath", part.sourcePath);
    assignOptional(output, "displayText", part.displayText);
    return output;
  }
  if (part.type === "reasoning") {
    const output: ChatMessagePart = { type: "reasoning", id: part.id, text: part.text };
    assignOptional(output, "redacted", part.redacted);
    return output;
  }
  if (part.type === "tool_call") {
    return {
      type: "tool_call",
      id: part.id,
      callId: part.callId,
      toolName: part.toolName,
      status: part.status,
      input: part.input,
      displayStatus: chatToolDisplayStatus(part.status),
    };
  }
  if (part.type === "tool_result") {
    const output: ChatMessagePart = { type: "tool_result", id: part.id, callId: part.callId, output: part.output };
    assignOptional(output, "content", part.content);
    assignOptional(output, "error", part.error);
    assignOptional(output, "executionContext", chatToolExecutionContext(part.executionContext));
    assignOptional(output, "synthetic", part.synthetic);
    return output;
  }
  if (part.type === "patch") return { type: "summary", id: part.id, text: `patch: ${part.files.join(", ")}` };
  if (part.type === "artifact") return { type: "summary", id: part.id, text: `artifact: ${part.artifactId}` };
  if (part.type === "compaction") return { type: "summary", id: part.id, text: part.summary ?? `compaction: ${part.reason}` };
  return { type: "summary", id: part.id, text: `agent handoff: ${part.agentPath}` };
}

function chatToolCallRow(
  view: ChiliRuntimeView,
  toolCall: RuntimeToolCallView,
  executionContext: ChatToolExecutionContext | undefined,
): ChatToolCallRow {
  const linkedApprovals = approvalsForToolCall(view, toolCall.id);
  const pendingApproval = linkedApprovals.find((approval) => approval.status === "pending");
  const latestApproval = latestApprovalForToolCall(linkedApprovals);
  const status = pendingApproval ? "waiting_for_approval" : toolCall.status;
  const row: ChatToolCallRow = {
    id: toolCall.id,
    kind: "tool",
    toolName: toolCall.toolName,
    status,
    displayStatus: status === "completed" && chatToolExecutionFailed(executionContext)
      ? "failed"
      : chatToolDisplayStatus(status, latestApproval),
    waitingForApproval: Boolean(pendingApproval),
    updatedAt: toolCall.updatedAt,
    inputSummary: chatToolInputSummary(toolCall.toolName, toolCall.input, pendingApproval?.patterns ?? latestApproval?.patterns ?? []),
  };
  assignOptional(row, "input", toolCall.input);
  assignOptional(row, "output", toolCall.output);
  assignOptional(row, "error", toolCall.error);
  assignOptional(row, "executionContext", executionContext);
  assignOptional(row, "liveOutput", toolCall.liveOutput ? toolCall.liveOutput.map((delta) => ({ ...delta })) : undefined);
  assignOptional(row, "sessionId", toolCall.sessionId);
  assignOptional(row, "approvalId", pendingApproval?.id ?? latestApproval?.id);
  assignOptional(row, "approvalStatus", pendingApproval?.status ?? latestApproval?.status);
  assignOptional(row, "approvalDecision", latestApproval?.decision);
  return row;
}

function chatToolExecutionFailed(context: ChatToolExecutionContext | undefined): boolean {
  if (!context) return false;
  return (typeof context.exitCode === "number" && context.exitCode !== 0)
    || context.timedOut === true
    || context.aborted === true
    || (typeof context.signal === "string" && context.signal.length > 0);
}

function toolResultExecutionContexts(
  view: ChiliRuntimeView,
  session: RuntimeSessionView,
): Map<ToolCallId, ChatToolExecutionContext> {
  const contexts = new Map<ToolCallId, ChatToolExecutionContext>();
  for (const messageId of session.messageIds) {
    const message = view.messages[messageId];
    if (!message) continue;
    for (const part of message.parts) {
      if (part.type !== "tool_result") continue;
      const context = chatToolExecutionContext(part.executionContext);
      if (context) contexts.set(part.callId, context);
    }
  }
  return contexts;
}

function chatToolExecutionContext(value: unknown): ChatToolExecutionContext | undefined {
  const record = recordObjectValue(value);
  if (!record) return undefined;
  const context: ChatToolExecutionContext = {};
  if (record.sandbox === "macos-seatbelt" || record.sandbox === "none") context.sandbox = record.sandbox;
  if (record.executionMode === "sandboxed" || record.executionMode === "unsandboxed") context.executionMode = record.executionMode;
  if (record.exitCode === null || (typeof record.exitCode === "number" && Number.isFinite(record.exitCode))) {
    context.exitCode = record.exitCode;
  }
  if (typeof record.timedOut === "boolean") context.timedOut = record.timedOut;
  if (typeof record.aborted === "boolean") context.aborted = record.aborted;
  if (record.signal === null || typeof record.signal === "string") context.signal = record.signal;
  return Object.keys(context).length > 0 ? context : undefined;
}

function chatApprovalRow(view: ChiliRuntimeView, approval: RuntimeApprovalView): ChatApprovalRow {
  const toolCall = approval.callId ? view.toolCalls[approval.callId] : undefined;
  const toolName = toolCall?.toolName ?? permissionToolName(approval.permission);
  const toolStatus = toolCall?.status;
  const row: ChatApprovalRow = {
    id: approval.id,
    kind: "approval",
    permission: approval.permission,
    patterns: approval.patterns,
    status: approval.status,
    createdAt: approval.createdAt,
    inputSummary: chatToolInputSummary(toolName, toolCall?.input, approval.patterns),
  };
  assignOptional(row, "sessionId", approval.sessionId);
  assignOptional(row, "callId", approval.callId);
  assignOptional(row, "maxApprovalScope", approval.maxApprovalScope);
  assignOptional(row, "toolName", toolName);
  assignOptional(row, "toolInput", toolCall?.input);
  assignOptional(row, "toolStatus", toolStatus);
  assignOptional(row, "toolDisplayStatus", toolStatus ? chatToolDisplayStatus(approval.status === "pending" ? "waiting_for_approval" : toolStatus, approval) : undefined);
  assignOptional(row, "metadata", approval.metadata);
  assignOptional(row, "decision", approval.decision);
  assignOptional(row, "feedback", approval.feedback);
  assignOptional(row, "resolvedAt", approval.resolvedAt);
  return row;
}

function approvalsForToolCall(view: ChiliRuntimeView, callId: ToolCallId): RuntimeApprovalView[] {
  return Object.values(view.approvals)
    .filter((approval) => approval.callId === callId)
    .sort((left, right) => approvalTime(left) - approvalTime(right));
}

function latestApprovalForToolCall(approvals: readonly RuntimeApprovalView[]): RuntimeApprovalView | undefined {
  return approvals[approvals.length - 1];
}

function approvalTime(approval: RuntimeApprovalView): number {
  return approval.resolvedAt ?? approval.createdAt;
}

function chatToolDisplayStatus(
  status: RuntimeToolCallView["status"] | ToolPartStatus,
  approval?: RuntimeApprovalView,
): ChatToolDisplayStatus {
  if (approval?.status === "pending") return "waiting_permission";
  if (approval?.decision === "deny" && (status === "waiting_for_approval" || status === "cancelled" || status === "failed")) {
    return "rejected";
  }
  if (status === "pending") return "queued";
  if (status === "validating") return "checking";
  if (status === "waiting_for_approval") return "waiting_permission";
  if (status === "running") return "running";
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  return "cancelled";
}

function chatToolInputSummary(toolName: string | undefined, input: unknown, patterns: readonly string[]): ChatToolInputSummary {
  const name = toolName && toolName.length > 0 ? toolName : "tool";
  const record = recordValue(input);
  const normalized = name.toLowerCase();
  const path = record ? firstString(record, ["filePath", "file_path", "path"]) : undefined;
  const pattern = record ? firstString(record, ["pattern", "query"]) : undefined;
  const paths = record ? firstStringArray(record, ["paths", "filePaths", "file_paths"]) : undefined;
  const scope = scopeSummary(patterns, path, paths);

  if (normalized === "bash" || normalized === "run_shell_command") {
    const command = record ? firstString(record, ["command", "cmd"]) : undefined;
    return compactSummary({
      title: "bash",
      detail: command ?? scope,
      command,
      scope: record ? firstString(record, ["cwd"]) : undefined,
    });
  }

  if (normalized === "edit" || normalized === "replace") {
    const oldText = record ? firstString(record, ["oldString", "old_string", "oldText"]) : undefined;
    const newText = record ? firstString(record, ["newString", "new_string", "newText"]) : undefined;
    return compactSummary({
      title: "edit",
      detail: path ?? scope,
      path: path ?? firstPattern(patterns),
      scope,
      diffSummary: editDiffSummary(oldText, newText, record ? booleanRecordValue(record, "replaceAll", "allow_multiple", "replace_all") : undefined),
    });
  }

  if (normalized === "write" || normalized === "write_file") {
    const content = record ? firstString(record, ["content"]) : undefined;
    return compactSummary({
      title: "write",
      detail: path ?? scope,
      path: path ?? firstPattern(patterns),
      scope,
      diffSummary: content === undefined ? undefined : `write ${lineCount(content)} line(s), ${content.length} chars`,
    });
  }

  if (normalized === "apply_patch") {
    const operations = record && Array.isArray(record.operations) ? record.operations : [];
    const operationSummary = applyPatchSummary(operations);
    return compactSummary({
      title: "apply_patch",
      detail: operationSummary.paths.join(", ") || scope,
      path: operationSummary.paths[0] ?? firstPattern(patterns),
      scope,
      diffSummary: operationSummary.summary,
    });
  }

  if (normalized === "read" || normalized === "read_file") {
    return compactSummary({
      title: "read",
      detail: path ?? scope,
      path: path ?? firstPattern(patterns),
      scope,
    });
  }

  if (normalized === "grep") {
    return compactSummary({
      title: "grep",
      detail: pattern ? `${pattern}${path ? ` in ${path}` : ""}` : scope,
      pattern,
      path,
      scope: path ?? scope,
    });
  }

  if (normalized === "glob") {
    return compactSummary({
      title: "glob",
      detail: pattern ? `${pattern}${path ? ` under ${path}` : ""}` : scope,
      pattern,
      path,
      scope: path ?? scope,
    });
  }

  return compactSummary({
    title: name,
    detail: scope ?? previewUnknown(input, 120),
    path: path ?? firstPattern(patterns),
    pattern,
    scope,
  });
}

function permissionToolName(permission: string): string | undefined {
  const trimmed = permission.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("tool.") ? trimmed.slice("tool.".length) : trimmed;
}

function compactSummary(summary: ChatToolInputSummaryDraft): ChatToolInputSummary {
  const output: ChatToolInputSummary = { title: summary.title };
  assignOptional(output, "detail", emptyToUndefined(summary.detail));
  assignOptional(output, "scope", emptyToUndefined(summary.scope));
  assignOptional(output, "command", emptyToUndefined(summary.command));
  assignOptional(output, "path", emptyToUndefined(summary.path));
  assignOptional(output, "pattern", emptyToUndefined(summary.pattern));
  assignOptional(output, "diffSummary", emptyToUndefined(summary.diffSummary));
  return output;
}

function scopeSummary(patterns: readonly string[], path: string | undefined, paths: readonly string[] | undefined): string | undefined {
  if (paths?.length) return paths.join(", ");
  if (path) return path;
  return patterns.length > 0 ? patterns.join(", ") : undefined;
}

function firstPattern(patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => pattern.length > 0);
}

function editDiffSummary(oldText: string | undefined, newText: string | undefined, replaceAll: boolean | undefined): string | undefined {
  if (oldText === undefined || newText === undefined) return undefined;
  const mode = replaceAll ? "replace all" : "replace";
  return `${mode} ${lineCount(oldText)} line(s) with ${lineCount(newText)} line(s): ${previewText(oldText, 32)} -> ${previewText(newText, 32)}`;
}

function applyPatchSummary(operations: readonly unknown[]): { paths: string[]; summary?: string } {
  const rows = operations.flatMap((operation): Array<{ type: string; path: string; movePath?: string }> => {
    const record = recordValue(operation);
    if (!record) return [];
    const type = firstString(record, ["type"]) ?? "update";
    const path = firstString(record, ["path"]);
    if (!path) return [];
    const movePath = firstString(record, ["movePath", "move_path"]);
    return [{ type, path, ...(movePath ? { movePath } : {}) }];
  });
  const paths = [...new Set(rows.flatMap((row) => row.movePath ? [row.path, row.movePath] : [row.path]))];
  if (rows.length === 0) return { paths };
  const preview = rows
    .slice(0, 4)
    .map((row) => row.movePath ? `${row.type} ${row.path} -> ${row.movePath}` : `${row.type} ${row.path}`)
    .join(", ");
  const suffix = rows.length > 4 ? `, +${rows.length - 4} more` : "";
  return { paths, summary: `${rows.length} operation(s): ${preview}${suffix}` };
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstStringArray(record: Record<string, unknown>, keys: readonly string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
    if (items.length > 0) return items;
  }
  return undefined;
}

function booleanRecordValue(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function previewText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return JSON.stringify(normalized);
  return JSON.stringify(`${normalized.slice(0, Math.max(0, maxLength - 1))}...`);
}

function previewUnknown(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  try {
    return previewRaw(JSON.stringify(value), maxLength);
  } catch {
    return previewRaw(String(value), maxLength);
  }
}

function previewRaw(text: string | undefined, maxLength: number): string | undefined {
  if (!text) return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function chatItemTime(item: ChatTranscriptItem): number {
  if (item.kind === "message") return item.createdAt;
  if (item.kind === "tool") return item.updatedAt;
  return item.resolvedAt ?? item.createdAt;
}

export function teamLiveView(view: ChiliRuntimeView, input: TeamLiveCockpitInput = {}): TeamLiveView {
  const limit = Math.max(1, input.limit ?? 24);
  const teams = visibleTeamSummaries(view, input.sessionId);
  const selectedTeamSummary = input.teamId ? teams.find((team) => team.id === input.teamId) : teams[0];
  const team = selectedTeamSummary ? view.teams[selectedTeamSummary.id] : undefined;
  const selected = team && selectedTeamSummary
    ? teamLiveSelectedTeam(view, team, selectedTeamSummary, input.sessionId, limit)
    : undefined;
  const scope = teamLiveScope(view, input.sessionId, team, teams);
  const globalActivity = teams
    .flatMap((summary) => {
      const item = view.teams[summary.id];
      return item ? teamLiveRecentActivity(view, item, scopedSessionIdsForTeam(view, item, input.sessionId), Math.max(4, Math.ceil(limit / 2))) : [];
    })
    .sort((left, right) => right.time - left.time)
    .slice(0, limit);

  const connection: TeamLiveConnectionState = input.connection ? { ...input.connection } : { status: "unknown" };
  if (!connection.lastEventId && view.lastEventId) connection.lastEventId = view.lastEventId;
  const output: TeamLiveView = {
    connection,
    scope,
    teams,
    globalActivity,
    availableActions: selected?.availableActions ?? teamLiveActions(view, undefined, new Set(), [], []),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
  assignOptional(output, "selectedTeamId", team?.id);
  assignOptional(output, "selected", selected);
  assignOptional(output, "lastEventId", view.lastEventId);
  return output;
}

export function teamLiveCockpit(view: ChiliRuntimeView, input: TeamLiveCockpitInput = {}): TeamLiveCockpitView {
  const limit = Math.max(1, input.limit ?? 16);
  const teams = visibleTeamSummaries(view, input.sessionId);
  const selectedTeamSummary = input.teamId ? teams.find((team) => team.id === input.teamId) : teams[0];
  const selectedTeam = selectedTeamSummary ? view.teams[selectedTeamSummary.id] : undefined;
  const team = selectedTeam;
  const runs = team ? teamRunsForTeam(view, team.id) : [];
  const activeRun = team ? activeTeamRun(view, team) : undefined;
  const tasks = team ? teamTaskRows(view, team) : [];
  const members = team ? teamMemberRows(view, team, tasks) : [];
  const lead = members.find((member) => member.isLead);
  const sessionScope = team ? scopedSessionIdsForTeam(view, team, input.sessionId) : input.sessionId ? new Set([input.sessionId]) : new Set<SessionId>();
  const approvals = pendingApprovalsForScope(view, sessionScope);
  const mailbox = team ? teamMailboxRows(view, team.id) : [];
  const metadata = teamLiveMetadata(tasks);
  const toolCounts = toolCountsForScope(view, sessionScope);
  const recentActivity = team ? teamRecentActivity(view, team, sessionScope, limit) : [];

  const output: TeamLiveCockpitView = {
    teamIds: teams.map((item) => item.id),
    teams,
    members,
    tasks,
    runs,
    pendingApprovals: approvals,
    mailbox,
    metadata,
    toolCounts,
    recentActivity,
  };
  assignOptional(output, "team", team);
  assignOptional(output, "lead", lead);
  assignOptional(output, "activeRun", activeRun);
  assignOptional(output, "lastEventId", view.lastEventId);
  return output;
}

function visibleTeamSummaries(view: ChiliRuntimeView, sessionId: SessionId | undefined): TeamLiveTeamSummary[] {
  return view.teamIds.flatMap((teamId) => {
    const team = view.teams[teamId];
    if (!team || !teamInSessionScope(view, team, sessionId)) return [];
    return [teamLiveTeamSummary(view, team, sessionId)];
  });
}

function teamLiveSelectedTeam(
  view: ChiliRuntimeView,
  team: RuntimeTeamView,
  summary: TeamLiveTeamSummary,
  inputSessionId: SessionId | undefined,
  limit: number,
): TeamLiveSelectedTeam {
  const sessionScope = scopedSessionIdsForTeam(view, team, inputSessionId);
  const taskRows = teamTaskRows(view, team);
  const taskSummaries = taskRows.map((task) => teamTaskSummary(task));
  const memberRows = teamMemberRows(view, team, taskRows);
  const members = memberRows.map((member) => teamMemberSummary(team, member, taskRows));
  const pendingApprovals = approvalSummariesForScope(view, sessionScope).filter((approval) => approval.status === "pending");
  const activeTools = activeToolSummariesForScope(view, sessionScope);
  const mergeQueue = taskSummaries.flatMap((task) => (task.merge ? [task.merge] : []));
  const runs = teamRunsForTeam(view, team.id).map((run) => teamRunSummary(run));
  const health = teamLiveHealth(taskSummaries, pendingApprovals, activeTools, mergeQueue);
  const selected: TeamLiveSelectedTeam = {
    team: summary,
    members,
    tasks: taskSummaries,
    runs,
    activeTools,
    pendingApprovals,
    mergeQueue,
    recentActivity: teamLiveRecentActivity(view, team, sessionScope, limit),
    availableActions: teamLiveActions(view, team, sessionScope, pendingApprovals, mergeQueue),
    health,
  };
  return selected;
}

function teamLiveScope(
  view: ChiliRuntimeView,
  sessionId: SessionId | undefined,
  selectedTeam: RuntimeTeamView | undefined,
  teams: readonly TeamLiveTeamSummary[],
): TeamLiveScope {
  const sessionIds = selectedTeam
    ? scopedSessionIdsForTeam(view, selectedTeam, sessionId)
    : new Set(sessionId ? [sessionId] : []);
  const scope: TeamLiveScope = {
    teamIds: teams.map((team) => team.id),
    sessionIds: [...sessionIds],
  };
  assignOptional(scope, "sessionId", sessionId);
  assignOptional(scope, "teamId", selectedTeam?.id);
  return scope;
}

function teamLiveTeamSummary(
  view: ChiliRuntimeView,
  team: RuntimeTeamView,
  sessionId: SessionId | undefined,
): TeamLiveTeamSummary {
  const tasks = team.taskIds.flatMap((taskId) => {
    const task = view.tasks[taskId];
    return task ? [task] : [];
  });
  const pendingApprovalCount = pendingApprovalsForScope(view, scopedSessionIdsForTeam(view, team, sessionId)).length;
  const summary: TeamLiveTeamSummary = {
    id: team.id,
    name: team.name,
    status: team.status,
    leadPath: team.leadPath,
    memberCount: team.memberIds.length,
    taskCount: tasks.length,
    runningTaskCount: tasks.filter((task) => task.status === "running" || task.status === "in_progress").length,
    pendingTaskCount: tasks.filter((task) => task.status === "pending" || task.status === "blocked").length,
    pendingApprovalCount,
    updatedAt: team.updatedAt,
  };
  assignOptional(summary, "activeRunId", team.activeRunId);
  return summary;
}

function teamMemberRows(view: ChiliRuntimeView, team: RuntimeTeamView, tasks: readonly TeamLiveTaskRow[]): TeamLiveMemberRow[] {
  const leadDepth = pathDepth(team.leadPath);
  return team.memberIds
    .flatMap((memberId) => {
      const member = view.teamMembers[memberId];
      return member ? [member] : [];
    })
    .map((member) => {
      const ownedTasks = tasks.filter((task) => task.ownerPath === member.path);
      const deliveries = Object.values(view.mailboxMessages).filter((message) => message.teamId === team.id && message.path === member.path);
      const currentTask = currentTaskForMember(member, ownedTasks);
      const row: TeamLiveMemberRow = {
        id: member.id,
        teamId: member.teamId,
        path: member.path,
        name: member.name,
        role: member.role,
        status: member.status,
        isLead: member.path === team.leadPath,
        depth: Math.max(0, pathDepth(member.path) - leadDepth),
        taskIds: ownedTasks.map((task) => task.id),
        deliveryIds: deliveries.map((delivery) => delivery.id),
        updatedAt: member.updatedAt,
      };
      assignOptional(row, "childSessionId", member.childSessionId);
      assignOptional(row, "model", member.model);
      assignOptional(row, "toolScope", member.toolScope);
      assignOptional(row, "writeScope", member.writeScope);
      assignOptional(row, "currentTaskId", currentTask?.id ?? member.currentTaskId);
      assignOptional(row, "currentTaskTitle", currentTask?.title);
      return row;
    });
}

function teamTaskRows(view: ChiliRuntimeView, team: RuntimeTeamView): TeamLiveTaskRow[] {
  return team.taskIds
    .flatMap((taskId) => {
      const task = view.tasks[taskId];
      return task ? [task] : [];
    })
    .map((task) => {
      const owner = task.ownerPath ? view.teamMembers[teamMemberKey(team.id, task.ownerPath)] : undefined;
      const row: TeamLiveTaskRow = {
        id: task.id,
        title: task.title ?? task.id,
        status: task.status,
        metadata: teamLiveTaskMetadata(task.metadata),
        updatedAt: task.updatedAt,
      };
      assignOptional(row, "teamId", task.teamId);
      assignOptional(row, "description", task.description);
      assignOptional(row, "ownerPath", task.ownerPath);
      assignOptional(row, "ownerName", owner?.name);
      assignOptional(row, "dependsOn", task.dependsOn);
      assignOptional(row, "summary", task.summary);
      assignOptional(row, "error", task.error);
      assignOptional(row, "completedAt", task.completedAt);
      return row;
    })
    .sort((left, right) => taskSortRank(left.status) - taskSortRank(right.status) || right.updatedAt - left.updatedAt);
}

function teamRunsForTeam(view: ChiliRuntimeView, teamId: TeamId): RuntimeTeamRunView[] {
  return (view.teamRunIdsByTeam[teamId] ?? [])
    .flatMap((runId) => {
      const run = view.teamRuns[runId];
      return run ? [run] : [];
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function activeTeamRun(view: ChiliRuntimeView, team: RuntimeTeamView): RuntimeTeamRunView | undefined {
  if (team.activeRunId) {
    const run = view.teamRuns[team.activeRunId];
    if (run) return run;
  }
  return teamRunsForTeam(view, team.id).find((run) => run.status === "running") ?? teamRunsForTeam(view, team.id)[0];
}

function teamMailboxRows(view: ChiliRuntimeView, teamId: TeamId): TeamLiveMailboxDeliveryView[] {
  return Object.values(view.mailboxMessages)
    .filter((message) => message.teamId === teamId)
    .map((message) => {
      const teamMessage = message.teamMessageId ? view.teamMessages[message.teamMessageId] : undefined;
      const row: TeamLiveMailboxDeliveryView = {
        id: message.id,
        path: message.path,
        from: message.from,
        status: message.status,
        triggerTurn: message.triggerTurn,
        queuedAt: message.queuedAt,
      };
      assignOptional(row, "teamId", message.teamId);
      assignOptional(row, "teamMessageId", message.teamMessageId);
      assignOptional(row, "taskId", message.taskId ?? teamMessage?.taskId);
      assignOptional(row, "deliveryStatus", teamMessage?.deliveryStatus);
      assignOptional(row, "deliveryError", teamMessage?.deliveryError ?? message.error);
      assignOptional(row, "claimedAt", message.claimedAt);
      assignOptional(row, "consumedAt", message.consumedAt);
      return row;
    })
    .sort((left, right) => right.queuedAt - left.queuedAt);
}

function teamLiveMetadata(tasks: readonly TeamLiveTaskRow[]): TeamLiveMetadataSummary {
  const summary: TeamLiveMetadataSummary = {
    dispatches: [],
    verifications: [],
    worktrees: [],
    merges: [],
  };
  for (const task of tasks) {
    if (task.metadata.dispatch) summary.dispatches.push(metadataEntry(task, task.metadata.dispatch));
    if (task.metadata.verification) summary.verifications.push(metadataEntry(task, task.metadata.verification));
    if (task.metadata.worktree) summary.worktrees.push(metadataEntry(task, task.metadata.worktree));
    if (task.metadata.merge) summary.merges.push(metadataEntry(task, task.metadata.merge));
  }
  return summary;
}

function teamLiveTaskMetadata(metadata: Record<string, unknown> | undefined): TeamLiveTaskMetadata {
  const output: TeamLiveTaskMetadata = {};
  assignOptional(output, "dispatch", metadataRecord(metadata, "chiliTeamDispatch"));
  assignOptional(output, "verification", metadataRecord(metadata, "verification"));
  assignOptional(output, "worktree", metadataRecord(metadata, "worktree"));
  assignOptional(output, "merge", metadataRecord(metadata, "merge"));
  return output;
}

function metadataEntry(task: TeamLiveTaskRow, value: Record<string, unknown>): TeamLiveMetadataEntry {
  const entry: TeamLiveMetadataEntry = {
    taskId: task.id,
    title: task.title,
    status: task.status,
    value,
  };
  assignOptional(entry, "ownerPath", task.ownerPath);
  return entry;
}

function teamTaskSummary(task: TeamLiveTaskRow): TeamLiveTaskSummary {
  const verifier = verifierSummary(task.metadata.verification);
  const merge = mergeSummary(task, task.metadata.merge);
  const worktree = worktreeSummary(task.metadata.worktree);
  const dispatch = dispatchSummary(task.metadata.dispatch);
  const summary: TeamLiveTaskSummary = {
    ...task,
    blocked: task.status === "blocked",
    final: isFinalTaskStatus(task.status),
  };
  assignOptional(summary, "verifier", verifier);
  assignOptional(summary, "merge", merge);
  assignOptional(summary, "worktree", worktree);
  assignOptional(summary, "dispatch", dispatch);
  return summary;
}

function teamMemberSummary(
  team: RuntimeTeamView,
  member: TeamLiveMemberRow,
  tasks: readonly TeamLiveTaskRow[],
): TeamLiveMemberSummary {
  const currentTask = member.currentTaskId ? tasks.find((task) => task.id === member.currentTaskId) : undefined;
  const summary: TeamLiveMemberSummary = {
    ...member,
  };
  assignOptional(summary, "sessionId", member.childSessionId ?? (member.isLead ? team.sessionId : undefined));
  assignOptional(summary, "currentTaskStatus", currentTask?.status);
  return summary;
}

function teamRunSummary(run: RuntimeTeamRunView): TeamLiveRunSummary {
  const summary: TeamLiveRunSummary = {
    id: run.id,
    teamId: run.teamId,
    status: run.status,
    cycle: run.cycle,
    counts: run.counts,
    updatedAt: run.updatedAt,
  };
  assignOptional(summary, "phase", run.phase);
  assignOptional(summary, "stopReason", run.stopReason);
  assignOptional(summary, "startedAt", run.startedAt);
  assignOptional(summary, "endedAt", run.endedAt);
  assignOptional(summary, "mode", run.mode);
  assignOptional(summary, "once", run.once);
  assignOptional(summary, "maxConcurrentDispatches", run.maxConcurrentDispatches);
  assignOptional(summary, "maxConcurrentVerifications", run.maxConcurrentVerifications);
  return summary;
}

function approvalSummariesForScope(view: ChiliRuntimeView, sessionScope: ReadonlySet<SessionId>): TeamLiveApprovalSummary[] {
  if (sessionScope.size === 0) return [];
  return Object.values(view.approvals)
    .filter((approval) => Boolean(approval.sessionId && sessionScope.has(approval.sessionId)))
    .map((approval) => {
      const toolCall = approval.callId ? view.toolCalls[approval.callId] : undefined;
      const summary: TeamLiveApprovalSummary = {
        id: approval.id,
        permission: approval.permission,
        patterns: approval.patterns,
        status: approval.status,
        createdAt: approval.createdAt,
      };
      assignOptional(summary, "sessionId", approval.sessionId);
      assignOptional(summary, "callId", approval.callId);
      assignOptional(summary, "maxApprovalScope", approval.maxApprovalScope);
      assignOptional(summary, "toolName", toolCall?.toolName);
      assignOptional(summary, "decision", approval.decision);
      assignOptional(summary, "feedback", approval.feedback);
      assignOptional(summary, "resolvedAt", approval.resolvedAt);
      return summary;
    })
    .sort((left, right) => (right.resolvedAt ?? right.createdAt) - (left.resolvedAt ?? left.createdAt));
}

function activeToolSummariesForScope(view: ChiliRuntimeView, sessionScope: ReadonlySet<SessionId>): TeamLiveToolSummary[] {
  if (sessionScope.size === 0) return [];
  return Object.values(view.toolCalls)
    .filter((toolCall) => Boolean(toolCall.sessionId && sessionScope.has(toolCall.sessionId)))
    .filter((toolCall) => !isFinalToolStatus(toolCall.status))
    .map((toolCall) => {
      const summary: TeamLiveToolSummary = {
        id: toolCall.id,
        toolName: toolCall.toolName || "(unknown)",
        status: toolCall.status,
        updatedAt: toolCall.updatedAt,
        waitingForApproval: toolCall.status === "waiting_for_approval",
      };
      assignOptional(summary, "sessionId", toolCall.sessionId);
      assignOptional(summary, "turnId", toolCall.turnId);
      assignOptional(summary, "error", toolCall.error);
      return summary;
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function teamLiveActions(
  view: ChiliRuntimeView,
  team: RuntimeTeamView | undefined,
  sessionScope: ReadonlySet<SessionId>,
  pendingApprovals: readonly TeamLiveApprovalSummary[],
  mergeQueue: readonly TeamLiveMergeSummary[],
): TeamLiveAction[] {
  if (!team) {
    return [
      { type: "run_loop", enabled: false, reason: "no_team" },
      { type: "merge", enabled: false, reason: "no_team" },
      { type: "interrupt", enabled: false, reason: "no_session" },
    ];
  }

  const activeRun = team.activeRunId ? view.teamRuns[team.activeRunId] : undefined;
  const runLoop: TeamLiveAction = {
    type: "run_loop",
    teamId: team.id,
    enabled: team.status === "active" && activeRun?.status !== "running",
  };
  if (team.status !== "active") runLoop.reason = "team_inactive";
  else if (activeRun?.status === "running") runLoop.reason = "run_active";
  const actions: TeamLiveAction[] = [runLoop];

  const pendingMerges = mergeQueue.filter((merge) => merge.status === "pending");
  if (pendingMerges.length === 0) {
    actions.push({ type: "merge", teamId: team.id, enabled: false, reason: "no_pending_merge" });
  } else {
    for (const merge of pendingMerges) {
      actions.push({
        type: "merge",
        teamId: team.id,
        taskId: merge.taskId,
        enabled: team.status === "active",
        ...(team.status === "active" ? {} : { reason: "team_inactive" }),
      });
    }
  }

  for (const approval of pendingApprovals) {
    const approve: TeamLiveAction = {
      type: "approve",
      approvalId: approval.id,
      enabled: approval.status === "pending" && Boolean(approval.sessionId),
      ...(approval.sessionId ? {} : { reason: "missing_session" }),
    };
    assignOptional(approve, "sessionId", approval.sessionId);
    actions.push(approve);
    const reject: TeamLiveAction = {
      type: "reject",
      approvalId: approval.id,
      enabled: approval.status === "pending" && Boolean(approval.sessionId),
      ...(approval.sessionId ? {} : { reason: "missing_session" }),
    };
    assignOptional(reject, "sessionId", approval.sessionId);
    actions.push(reject);
  }

  const sessions = [...sessionScope].flatMap((sessionId) => {
    const session = view.sessions[sessionId];
    return session ? [session] : [];
  });
  const interruptible = sessions.filter((session) => session.status === "running" || session.status === "waiting_for_approval");
  if (interruptible.length === 0) {
    const interrupt: TeamLiveAction = {
      type: "interrupt",
      enabled: false,
      reason: sessions.length === 0 ? "no_session" : "session_idle",
    };
    assignOptional(interrupt, "sessionId", sessions[0]?.id ?? team.sessionId);
    actions.push(interrupt);
  } else {
    for (const session of interruptible) {
      actions.push({ type: "interrupt", sessionId: session.id, enabled: true });
    }
  }

  return actions;
}

function teamLiveHealth(
  tasks: readonly TeamLiveTaskSummary[],
  pendingApprovals: readonly TeamLiveApprovalSummary[],
  activeTools: readonly TeamLiveToolSummary[],
  mergeQueue: readonly TeamLiveMergeSummary[],
): TeamLiveHealth {
  const counts = {
    runningTasks: tasks.filter((task) => task.status === "running" || task.status === "in_progress").length,
    pendingTasks: tasks.filter((task) => task.status === "pending").length,
    blockedTasks: tasks.filter((task) => task.status === "blocked").length,
    failedTasks: tasks.filter((task) => task.status === "failed" || task.status === "cancelled").length,
    pendingApprovals: pendingApprovals.length,
    activeTools: activeTools.length,
    pendingMerges: mergeQueue.filter((merge) => merge.status === "pending").length,
    conflictedMerges: mergeQueue.filter((merge) => merge.status === "conflicted").length,
    errors: tasks.filter((task) => Boolean(task.error)).length + mergeQueue.filter((merge) => Boolean(merge.error)).length,
  };
  const reasons: string[] = [];
  if (counts.failedTasks > 0 || counts.errors > 0) reasons.push("errors");
  if (counts.conflictedMerges > 0) reasons.push("merge_conflicts");
  if (counts.blockedTasks > 0) reasons.push("blocked_tasks");
  if (counts.pendingApprovals > 0) reasons.push("pending_approvals");
  if (counts.pendingMerges > 0) reasons.push("pending_merge");
  const status: TeamLiveHealthStatus =
    counts.failedTasks > 0 || counts.errors > 0
      ? "error"
      : counts.conflictedMerges > 0 || counts.blockedTasks > 0
        ? "blocked"
        : counts.pendingApprovals > 0 || counts.pendingMerges > 0
          ? "attention"
          : "ok";
  return { status, reasons, counts };
}

function verifierSummary(value: Record<string, unknown> | undefined): TeamLiveVerifierSummary | undefined {
  if (!value) return undefined;
  const status = stringValue(value.status);
  const normalized: TeamLiveVerifierStatus =
    status === "pending" || status === "passed" || status === "failed" ? status : "none";
  const summary: TeamLiveVerifierSummary = { status: normalized };
  assignOptional(summary, "verifierTaskId", stringValue(value.verifierTaskId) as TaskId | undefined);
  assignOptional(summary, "verifierRunId", stringValue(value.verifierRunId) as AgentRunId | undefined);
  assignOptional(summary, "verifierPath", stringValue(value.verifierPath) as AgentPath | undefined);
  assignOptional(summary, "checkedAt", finiteNumberValue(value.checkedAt));
  assignOptional(summary, "startedAt", finiteNumberValue(value.startedAt));
  assignOptional(summary, "feedback", stringValue(value.feedback));
  return summary;
}

function mergeSummary(task: TeamLiveTaskRow, value: Record<string, unknown> | undefined): TeamLiveMergeSummary | undefined {
  if (!value) return undefined;
  const status = stringValue(value.status);
  const normalized: TeamLiveMergeStatus =
    status === "pending" || status === "applied" || status === "failed" || status === "conflicted" || status === "skipped"
      ? status
      : "none";
  const summary: TeamLiveMergeSummary = {
    taskId: task.id,
    title: task.title,
    status: normalized,
  };
  assignOptional(summary, "teamId", task.teamId);
  assignOptional(summary, "ownerPath", task.ownerPath);
  assignOptional(summary, "worktreePath", stringValue(value.worktreePath));
  assignOptional(summary, "baseRef", stringValue(value.baseRef));
  assignOptional(summary, "diffSummary", recordObjectValue(value.diffSummary));
  assignOptional(summary, "error", stringValue(value.error));
  assignOptional(summary, "conflicts", stringArrayValue(value.conflicts));
  assignOptional(summary, "reason", stringValue(value.reason));
  assignOptional(summary, "createdAt", finiteNumberValue(value.createdAt));
  assignOptional(summary, "mergedAt", finiteNumberValue(value.mergedAt));
  return summary;
}

function worktreeSummary(value: Record<string, unknown> | undefined): TeamLiveWorktreeSummary | undefined {
  const path = stringValue(value?.path);
  if (!value || !path) return undefined;
  const summary: TeamLiveWorktreeSummary = { path };
  assignOptional(summary, "baseRef", stringValue(value.baseRef));
  assignOptional(summary, "status", stringValue(value.status));
  assignOptional(summary, "createdAt", finiteNumberValue(value.createdAt));
  return summary;
}

function dispatchSummary(value: Record<string, unknown> | undefined): TeamLiveDispatchSummary | undefined {
  if (!value) return undefined;
  const summary: TeamLiveDispatchSummary = {};
  assignOptional(summary, "agentTaskId", stringValue(value.agentTaskId) as TaskId | undefined);
  assignOptional(summary, "agentPath", stringValue(value.agentPath) as AgentPath | undefined);
  assignOptional(summary, "runId", stringValue(value.runId) as AgentRunId | undefined);
  assignOptional(summary, "childSessionId", stringValue(value.childSessionId) as SessionId | undefined);
  assignOptional(summary, "mode", stringValue(value.mode));
  assignOptional(summary, "agentStatus", stringValue(value.agentStatus));
  assignOptional(summary, "dispatchedAt", finiteNumberValue(value.dispatchedAt));
  assignOptional(summary, "syncedAt", finiteNumberValue(value.syncedAt));
  assignOptional(summary, "policy", recordObjectValue(value.policy));
  return summary;
}

function teamLiveRecentActivity(
  view: ChiliRuntimeView,
  team: RuntimeTeamView,
  sessionScope: ReadonlySet<SessionId>,
  limit: number,
): TeamLiveActivityItem[] {
  const items = teamRecentActivity(view, team, sessionScope, limit * 2);
  for (const memberId of team.memberIds) {
    const member = view.teamMembers[memberId];
    if (!member) continue;
    items.push(activityItem({
      id: `member:${member.id}`,
      kind: "member",
      time: member.updatedAt,
      label: `${member.name || member.path}`,
      status: member.status,
      teamId: member.teamId,
      taskId: member.currentTaskId,
    }));
  }
  for (const task of teamTaskRows(view, team)) {
    const verifier = verifierSummary(task.metadata.verification);
    if (verifier && verifier.status !== "none") {
      items.push(activityItem({
        id: `verifier:${task.id}`,
        kind: "verifier",
        time: verifier.checkedAt ?? verifier.startedAt ?? task.updatedAt,
        label: task.title,
        status: verifier.status,
        detail: verifier.feedback,
        taskId: task.id,
        teamId: task.teamId,
      }));
    }
    const merge = mergeSummary(task, task.metadata.merge);
    if (merge && merge.status !== "none") {
      items.push(activityItem({
        id: `merge:${task.id}`,
        kind: "merge",
        time: merge.mergedAt ?? merge.createdAt ?? task.updatedAt,
        label: task.title,
        status: merge.status,
        detail: merge.error ?? merge.reason,
        taskId: task.id,
        teamId: task.teamId,
      }));
    }
  }
  return items.sort((left, right) => right.time - left.time).slice(0, limit);
}

function toolCountsForScope(view: ChiliRuntimeView, sessionScope: ReadonlySet<SessionId>): TeamLiveToolCount[] {
  if (sessionScope.size === 0) return [];
  const counts = new Map<string, TeamLiveToolCount>();
  for (const toolCall of Object.values(view.toolCalls)) {
    if (!toolCall.sessionId || !sessionScope.has(toolCall.sessionId)) continue;
    const toolName = toolCall.toolName || "(unknown)";
    const current = counts.get(toolName) ?? { toolName, total: 0, running: 0, completed: 0, failed: 0 };
    current.total++;
    if (toolCall.status === "completed") current.completed++;
    else if (toolCall.status === "failed" || toolCall.status === "cancelled") current.failed++;
    else current.running++;
    counts.set(toolName, current);
  }
  return [...counts.values()].sort((left, right) => right.total - left.total || left.toolName.localeCompare(right.toolName));
}

function teamRecentActivity(
  view: ChiliRuntimeView,
  team: RuntimeTeamView,
  sessionScope: ReadonlySet<SessionId>,
  limit: number,
): TeamLiveActivityItem[] {
  const items: TeamLiveActivityItem[] = [];
  for (const run of teamRunsForTeam(view, team.id)) {
    const label = run.phase ? `run ${run.phase}` : `run ${run.status}`;
    items.push(activityItem({
      id: run.id,
      kind: "run",
      time: run.updatedAt,
      label,
      status: run.stopReason ?? run.status,
      detail: teamRunActivityDetail(run),
      teamId: team.id,
    }));
  }
  for (const messageId of team.messageIds) {
    const message = view.teamMessages[messageId];
    if (!message) continue;
    items.push(activityItem({
      id: message.id,
      kind: "message",
      time: message.createdAt,
      label: `${message.kind}: ${message.from} -> ${message.to}`,
      status: message.deliveryStatus ?? message.delivery,
      detail: message.summary ?? message.content,
      taskId: message.taskId,
      teamId: message.teamId,
      teamMessageId: message.id,
      from: message.from,
      to: message.to,
    }));
  }
  for (const mailbox of teamMailboxRows(view, team.id)) {
    items.push(activityItem({
      id: mailbox.id,
      kind: "mailbox",
      time: mailbox.consumedAt ?? mailbox.claimedAt ?? mailbox.queuedAt,
      label: `mailbox ${mailbox.from} -> ${mailbox.path}`,
      status: mailbox.status,
      taskId: mailbox.taskId,
      teamId: mailbox.teamId,
      teamMessageId: mailbox.teamMessageId,
      from: mailbox.from,
      to: mailbox.path,
    }));
  }
  for (const task of team.taskIds.flatMap((taskId) => (view.tasks[taskId] ? [view.tasks[taskId]] : []))) {
    items.push(activityItem({
      id: task.id,
      kind: "task",
      time: task.updatedAt,
      label: task.title ?? task.id,
      status: task.status,
      detail: task.error ?? task.summary,
      taskId: task.id,
      teamId: task.teamId,
    }));
  }
  for (const toolCall of Object.values(view.toolCalls)) {
    if (sessionScope.size === 0 || !toolCall.sessionId || !sessionScope.has(toolCall.sessionId)) continue;
    items.push(activityItem({
      id: toolCall.id,
      kind: "tool",
      time: toolCall.updatedAt,
      label: toolCall.toolName || "(unknown tool)",
      status: toolCall.status,
      detail: toolCall.error ?? toolCall.output,
      toolName: toolCall.toolName,
    }));
  }
  for (const approval of approvalsForScope(view, sessionScope)) {
    items.push(activityItem({
      id: approval.id,
      kind: "approval",
      time: approval.resolvedAt ?? approval.createdAt,
      label: approval.permission,
      status: approval.status,
      detail: approval.patterns.join(", "),
    }));
  }
  return items.sort((left, right) => right.time - left.time).slice(0, limit);
}

function teamRunActivityDetail(run: RuntimeTeamRunView): string {
  const parts = [`cycle:${run.cycle}`];
  if (run.maxConcurrentDispatches) parts.push(`fanout:${run.maxConcurrentDispatches}`);
  if (run.maxConcurrentVerifications) parts.push(`verify:${run.maxConcurrentVerifications}`);
  appendActivityCount(parts, "dispatched", run.counts.dispatched);
  appendActivityCount(parts, "completed", run.counts.completed);
  appendActivityCount(parts, "accepted", run.counts.accepted);
  appendActivityCount(parts, "merged", run.counts.merged);
  appendActivityCount(parts, "failed", run.counts.failed);
  appendActivityCount(parts, "blocked", run.counts.blocked);
  appendActivityCount(parts, "running", run.counts.stillRunning);
  appendActivityCount(parts, "errors", run.counts.errors);
  return parts.join(" ");
}

function appendActivityCount(parts: string[], label: string, value: number): void {
  if (value > 0) parts.push(`${label}:${value}`);
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
    assignOptional(task, "createdBy", stringValue(payload.createdBy) as AgentPath | undefined);
    assignOptional(task, "dependsOn", taskIdArrayValue(payload.dependsOn));
    assignOptional(task, "metadata", recordObjectValue(payload.metadata));
    assignOptional(task, "summary", stringValue(payload.summary));
    assignOptional(task, "error", stringValue(payload.error));
    if (task.metadata) recordTeamDelegatedTasks(view, teamId, task.metadata);

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
    assignOptional(message, "taskId", stringValue(payload.taskId) as TaskId | undefined);
    assignOptional(message, "summary", stringValue(payload.summary));
    assignOptional(message, "metadata", recordObjectValue(payload.metadata));
    view.teamMessages[messageId] = message;
    refreshTeamMessageDeliveryStatus(view, messageId, event.time);
    if (!view.teamMessageIds.includes(messageId)) view.teamMessageIds.push(messageId);

    const team = upsertTeam(view, teamId, event.time);
    if (!team.messageIds.includes(messageId)) team.messageIds.push(messageId);
    team.updatedAt = event.time;
    return;
  }

  if (event.type === "team.run_started") {
    const teamId = stringValue(payload.teamId) as TeamId | undefined;
    const runId = stringValue(payload.runId);
    if (!teamId || !runId) return;

    const run = upsertTeamRun(view, teamId, runId, event.time);
    run.status = "running";
    run.cycle = 0;
    run.counts = emptyTeamRunCounts();
    run.updatedAt = event.time;
    assignOptional(run, "sessionId", event.sessionId);
    assignOptional(run, "mode", agentTaskModeValue(payload.mode));
    assignOptional(run, "once", booleanValue(payload.once));
    assignOptional(run, "maxCycles", finiteNumberValue(payload.maxCycles));
    assignOptional(run, "timeoutMs", finiteNumberValue(payload.timeoutMs));
    assignOptional(run, "pollIntervalMs", finiteNumberValue(payload.pollIntervalMs));
    assignOptional(run, "maxConcurrentDispatches", finiteNumberValue(payload.maxConcurrentDispatches));
    assignOptional(run, "maxConcurrentVerifications", finiteNumberValue(payload.maxConcurrentVerifications));
    delete run.phase;
    delete run.stopReason;
    delete run.endedAt;
    linkTeamRunToTeam(view, run, event.time);
    const team = upsertTeam(view, teamId, event.time);
    team.activeRunId = runId;
    team.updatedAt = event.time;
    return;
  }

  if (event.type === "team.run_progress") {
    const teamId = stringValue(payload.teamId) as TeamId | undefined;
    const runId = stringValue(payload.runId);
    if (!teamId || !runId) return;

    const run = upsertTeamRun(view, teamId, runId, event.time);
    run.status = "running";
    run.cycle = finiteNumberValue(payload.cycle) ?? run.cycle;
    run.counts = teamRunSummaryCountsValue(payload.counts) ?? run.counts;
    run.updatedAt = event.time;
    assignOptional(run, "sessionId", event.sessionId);
    assignOptional(run, "phase", teamRunLifecyclePhaseValue(payload.phase));
    assignOptional(run, "stopReason", teamRunStopReasonValue(payload.stopReason));
    linkTeamRunToTeam(view, run, event.time);
    const team = upsertTeam(view, teamId, event.time);
    team.activeRunId = runId;
    team.updatedAt = event.time;
    return;
  }

  if (event.type === "team.run_completed") {
    const teamId = stringValue(payload.teamId) as TeamId | undefined;
    const runId = stringValue(payload.runId);
    if (!teamId || !runId) return;

    const run = upsertTeamRun(view, teamId, runId, event.time);
    run.status = "completed";
    run.cycle = finiteNumberValue(payload.cycles) ?? run.cycle;
    run.counts = teamRunSummaryCountsValue(payload.counts) ?? run.counts;
    run.updatedAt = event.time;
    assignOptional(run, "sessionId", event.sessionId);
    assignOptional(run, "stopReason", teamRunStopReasonValue(payload.stopReason));
    assignOptional(run, "startedAt", finiteNumberValue(payload.startedAt));
    assignOptional(run, "endedAt", finiteNumberValue(payload.endedAt));
    linkTeamRunToTeam(view, run, event.time);
    const team = upsertTeam(view, teamId, event.time);
    if (team.activeRunId === runId) delete team.activeRunId;
    team.lastCompletedRunId = runId;
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
    delete agent.completedAt;
    agent.updatedAt = event.time;
    assignOptional(agent, "parentPath", stringValue(payload.parentPath) as AgentPath | undefined);
    assignOptional(agent, "sessionId", event.sessionId);
    assignOptional(agent, "mode", agentTaskModeValue(payload.mode));
    assignOptional(agent, "childSessionId", stringValue(payload.childSessionId) as SessionId | undefined);
    delete agent.summary;
    delete agent.error;
    if (taskId) {
      if (!agent.taskIds.includes(taskId)) agent.taskIds.push(taskId);
      const task = upsertTask(view, taskId, event.time);
      const previousGeneration = task.generation;
      const nextGeneration = generation ?? task.generation;
      task.status = "running";
      task.generation = nextGeneration;
      delete task.completedAt;
      if (nextGeneration > previousGeneration) {
        delete task.summary;
        delete task.error;
      }
      task.updatedAt = event.time;
      task.path = path;
      task.ownerPath = path;
      assignOptional(task, "sessionId", (stringValue(payload.parentSessionId) as SessionId | undefined) ?? event.sessionId);
      assignOptional(task, "childSessionId", stringValue(payload.childSessionId) as SessionId | undefined);
      assignOptional(task, "title", stringValue(payload.taskName));
      assignOptional(task, "mode", agentTaskModeValue(payload.mode));
      applyAgentTaskProvenance(task, payload);
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
    if (agent.completedAt !== undefined && (generation === undefined || generation <= agent.generation)) return;
    if (generation !== undefined && generation < agent.generation) return;
    agent.path = path;
    agent.status = status;
    agent.generation = generation ?? agent.generation;
    agent.completedAt = event.time;
    agent.updatedAt = event.time;
    assignOptional(agent, "sessionId", event.sessionId);
    assignOptional(agent, "summary", stringValue(payload.summary));
    assignOptional(agent, "error", stringValue(payload.error));
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
    assignOptional(message, "taskId", stringValue(payload.taskId) as TaskId | undefined);
    assignOptional(
      message,
      "recipientSessionId",
      stringValue(payload.recipientSessionId ?? payload.childSessionId) as SessionId | undefined,
    );
    const mailboxPayload = runtimeAgentMailboxPayload(payload.message);
    assignOptional(message, "role", mailboxPayload.role);
    assignOptional(message, "messageKind", mailboxPayload.messageKind);
    assignOptional(message, "preview", mailboxPayload.preview);
    assignOptional(message, "metadataSummary", mailboxPayload.metadataSummary);
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
    assignOptional(message, "error", stringValue(payload.error));
    if (message.teamMessageId) applyTeamMessageDeliveryStatus(view, message.teamMessageId, "failed", event.time, stringValue(payload.error));
    return;
  }

  if (event.type === "agent.task_created") {
    const taskId = stringValue(payload.taskId) as TaskId | undefined;
    const path = stringValue(payload.path) as AgentPath | undefined;
    if (!taskId || !path) return;

    const existing = view.tasks[taskId];
    const task = existing ?? upsertTask(view, taskId, event.time);
    task.createdAt = Math.min(task.createdAt, event.time);
    if (!existing) {
      task.status = "pending";
      task.generation = 0;
      task.updatedAt = event.time;
    }
    task.path = path;
    task.ownerPath = path;
    assignOptional(task, "sessionId", stringValue(payload.parentSessionId) as SessionId | undefined);
    assignOptional(task, "childSessionId", stringValue(payload.childSessionId) as SessionId | undefined);
    assignOptional(task, "title", stringValue(payload.taskName));
    assignOptional(task, "taskPrompt", stringValue(payload.prompt));
    assignOptional(task, "mode", agentTaskModeValue(payload.mode));
    applyAgentTaskProvenance(task, payload);
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
    assignOptional(task, "metadata", recordObjectValue(payload.metadata));
    if (task.status === "completed" || task.status === "incomplete" || task.status === "failed" || task.status === "cancelled") task.completedAt = event.time;
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
      if (existing && isFinalTaskStatus(existing.status) && (generation === undefined || generation <= existing.generation)) return;
      if (existing && generation !== undefined && generation < existing.generation) return;
      if (existing && generation !== undefined && generation > existing.generation) {
        delete task.summary;
        delete task.error;
      }
    }
    if (teamId) task.teamId = teamId;
    task.status = status;
    if (generation !== undefined) task.generation = Math.max(task.generation, generation);
    task.updatedAt = event.time;
    if (status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled") task.completedAt = event.time;
    assignOptional(task, "sessionId", event.sessionId);
    assignOptional(task, "ownerPath", stringValue(payload.ownerPath) as AgentPath | undefined);
    assignOptional(task, "path", stringValue(payload.path) as AgentPath | undefined);
    assignOptional(task, "title", stringValue(payload.title));
    assignOptional(task, "description", stringValue(payload.description));
    assignOptional(task, "dependsOn", taskIdArrayValue(payload.dependsOn));
    assignOptional(task, "metadata", recordObjectValue(payload.metadata));
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
    hasExplicitStatus: false,
  };
  view.sessions[sessionId] = session;
  view.sessionIds.push(sessionId);
  return session;
}

function setSessionStatus(
  session: RuntimeSessionView,
  status: RuntimeSessionStatus,
  reason?: string,
): void {
  session.status = status;
  if (reason === undefined) {
    delete session.statusReason;
  } else {
    session.statusReason = reason;
  }
}

function isTerminalSessionStatus(status: RuntimeSessionStatus): boolean {
  return status === "idle" || status === "failed" || status === "cancelled";
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
    runIds: [],
    createdAt: time,
    updatedAt: time,
  };
  view.teams[teamId] = team;
  view.teamIds.push(teamId);
  return team;
}

function upsertTeamRun(view: ChiliRuntimeView, teamId: TeamId, runId: string, time: number): RuntimeTeamRunView {
  const existing = view.teamRuns[runId];
  if (existing) return existing;

  const run: RuntimeTeamRunView = {
    id: runId,
    teamId,
    status: "running",
    cycle: 0,
    counts: emptyTeamRunCounts(),
    createdAt: time,
    updatedAt: time,
  };
  view.teamRuns[runId] = run;
  view.teamRunIds.push(runId);
  return run;
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

const MAX_TOOL_OUTPUT_DELTAS = 80;

function appendToolOutputDelta(toolCall: RuntimeToolCallView, delta: RuntimeToolOutputDelta): void {
  if (!delta.delta) return;
  const liveOutput = toolCall.liveOutput ? [...toolCall.liveOutput, delta] : [delta];
  if (liveOutput.length > MAX_TOOL_OUTPUT_DELTAS) {
    liveOutput.splice(0, liveOutput.length - MAX_TOOL_OUTPUT_DELTAS);
  }
  toolCall.liveOutput = liveOutput;
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
  if (!session.hasExplicitStatus) setSessionStatus(session, "waiting_for_approval");
  session.updatedAt = time;
}

function clearSessionRetry(view: ChiliRuntimeView, sessionId: SessionId, turnId?: TurnId): void {
  const session = view.sessions[sessionId];
  if (!session?.retry) return;
  if (turnId !== undefined && session.retry.turnId !== turnId) return;
  delete session.retry;
}

function hasPendingApprovalForSession(view: ChiliRuntimeView, sessionId: SessionId): boolean {
  return Object.values(view.approvals).some(
    (approval) => approval.sessionId === sessionId && approval.status === "pending",
  );
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

function linkTeamRunToTeam(view: ChiliRuntimeView, run: RuntimeTeamRunView, time: number): void {
  const team = upsertTeam(view, run.teamId, time);
  if (!team.runIds.includes(run.id)) team.runIds.push(run.id);
  const teamRunIds = view.teamRunIdsByTeam[run.teamId] ?? [];
  if (!teamRunIds.includes(run.id)) teamRunIds.push(run.id);
  view.teamRunIdsByTeam[run.teamId] = teamRunIds;
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

function hasOwn<T extends object, K extends PropertyKey>(target: T, key: K): target is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(target, key);
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

function finiteNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function generationValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function recordObjectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function metadataRecord(metadata: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return metadata ? recordObjectValue(metadata[key]) : undefined;
}

function agentTaskModeValue(value: unknown): AgentTaskMode | undefined {
  return value === "one_shot" || value === "resumable" || value === "background" ? value : undefined;
}

function taskCompletionPolicyValue(value: unknown): RuntimeTaskCompletionPolicy | undefined {
  return value === "join" || value === "notify" || value === "detached" || value === "supervised" ? value : undefined;
}

function applyAgentTaskProvenance(task: RuntimeTaskView, payload: Record<string, unknown>): void {
  assignOptional(task, "sourceCallId", stringValue(payload.sourceCallId) as ToolCallId | undefined);
  assignOptional(task, "batchId", stringValue(payload.batchId));
  const batchIndex = finiteNumberValue(payload.batchIndex);
  if (batchIndex !== undefined && batchIndex >= 0) task.batchIndex = batchIndex;
  const expectedBatchSize = finiteNumberValue(payload.expectedBatchSize);
  if (expectedBatchSize !== undefined && expectedBatchSize >= 0) task.expectedBatchSize = expectedBatchSize;
  assignOptional(task, "completionPolicy", taskCompletionPolicyValue(payload.completionPolicy));
  const maxConcurrency = finiteNumberValue(payload.maxConcurrency);
  if (maxConcurrency !== undefined && maxConcurrency > 0) task.maxConcurrency = maxConcurrency;
}

function agentStatusValue(value: unknown): RuntimeAgentStatus | undefined {
  return value === "running" || value === "completed" || value === "incomplete" || value === "failed" || value === "cancelled" ? value : undefined;
}

function taskStatusValue(value: unknown): RuntimeTaskStatus | undefined {
  return value === "pending" || value === "running" || value === "in_progress" || value === "blocked" || value === "completed" || value === "incomplete" || value === "failed" || value === "cancelled"
    ? value
    : undefined;
}

function isAgentTaskStatus(status: RuntimeTaskStatus): status is AgentTaskStatus {
  return status === "pending" || status === "running" || status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled";
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

function teamRunLifecyclePhaseValue(value: unknown): TeamRunLifecyclePhase | undefined {
  return value === "reconcile" || value === "load" || value === "verify" || value === "merge" || value === "dispatch" || value === "wait" || value === "drain"
    ? value
    : undefined;
}

function teamRunStopReasonValue(value: unknown): TeamRunStopReason | undefined {
  return value === "drained" ||
    value === "once" ||
    value === "max_cycles" ||
    value === "timeout" ||
    value === "aborted" ||
    value === "team_inactive"
    ? value
    : undefined;
}

function teamRunSummaryCountsValue(value: unknown): TeamRunSummaryCounts | undefined {
  const record = recordObjectValue(value);
  if (!record) return undefined;
  const counts = emptyTeamRunCounts();
  for (const key of teamRunCountKeys) {
    const item = finiteNumberValue(record[key]);
    if (item !== undefined) counts[key] = item;
  }
  return counts;
}

const teamRunCountKeys = [
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
] as const;

function emptyTeamRunCounts(): TeamRunSummaryCounts {
  return {
    dispatched: 0,
    completed: 0,
    accepted: 0,
    reopened: 0,
    merged: 0,
    mergeFailed: 0,
    mergeConflicted: 0,
    mergeSkipped: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    stillRunning: 0,
    errors: 0,
  };
}

function taskSortRank(status: RuntimeTaskStatus): number {
  if (status === "running" || status === "in_progress") return 0;
  if (status === "blocked") return 1;
  if (status === "pending") return 2;
  if (status === "failed" || status === "cancelled") return 3;
  return 4;
}

function pathDepth(path: AgentPath): number {
  return path.split("/").filter(Boolean).length;
}

function currentTaskForMember(
  member: RuntimeTeamMemberView,
  ownedTasks: readonly TeamLiveTaskRow[],
): TeamLiveTaskRow | undefined {
  if (member.currentTaskId) {
    const current = ownedTasks.find((task) => task.id === member.currentTaskId);
    if (current) return current;
  }
  return [...ownedTasks]
    .filter((task) => task.status === "running" || task.status === "in_progress" || task.status === "pending")
    .sort((left, right) => taskSortRank(left.status) - taskSortRank(right.status) || right.updatedAt - left.updatedAt)[0];
}

function scopedSessionIdsForTeam(
  view: ChiliRuntimeView,
  team: RuntimeTeamView,
  inputSessionId: SessionId | undefined,
): Set<SessionId> {
  const ids = new Set<SessionId>();
  if (inputSessionId) ids.add(inputSessionId);
  if (team.sessionId) ids.add(team.sessionId);
  for (const memberId of team.memberIds) {
    const member = view.teamMembers[memberId];
    if (member?.childSessionId) ids.add(member.childSessionId);
  }
  for (const taskId of team.taskIds) {
    const task = view.tasks[taskId];
    if (task?.sessionId) ids.add(task.sessionId);
    if (task?.childSessionId) ids.add(task.childSessionId);
    if (!task?.metadata) continue;
    for (const metadataTaskId of metadataLinkedTaskIds(task.metadata)) {
      const linkedTask: RuntimeTaskView | undefined = view.tasks[metadataTaskId];
      if (linkedTask?.sessionId) ids.add(linkedTask.sessionId);
      if (linkedTask?.childSessionId) ids.add(linkedTask.childSessionId);
    }
    for (const metadataSessionId of metadataLinkedSessionIds(task.metadata)) ids.add(metadataSessionId);
  }
  for (const messageId of team.messageIds) {
    const message = view.teamMessages[messageId];
    if (message?.sessionId) ids.add(message.sessionId);
  }
  for (const runId of team.runIds) {
    const run = view.teamRuns[runId];
    if (run?.sessionId) ids.add(run.sessionId);
  }
  return ids;
}

function approvalsForScope(view: ChiliRuntimeView, sessionScope: ReadonlySet<SessionId>): RuntimeApprovalView[] {
  if (sessionScope.size === 0) return [];
  return Object.values(view.approvals).filter((approval) => {
    return Boolean(approval.sessionId && sessionScope.has(approval.sessionId));
  });
}

function pendingApprovalsForScope(view: ChiliRuntimeView, sessionScope: ReadonlySet<SessionId>): RuntimeApprovalView[] {
  return approvalsForScope(view, sessionScope).filter((approval) => approval.status === "pending");
}

function teamInSessionScope(
  view: ChiliRuntimeView,
  team: RuntimeTeamView,
  sessionId: SessionId | undefined,
): boolean {
  if (!sessionId) return true;
  if (team.sessionId === sessionId) return true;
  for (const memberId of team.memberIds) {
    const member = view.teamMembers[memberId];
    if (member?.childSessionId === sessionId) return true;
  }
  for (const taskId of team.taskIds) {
    const task = view.tasks[taskId];
    if (task?.sessionId === sessionId || task?.childSessionId === sessionId) return true;
    if (!task?.metadata) continue;
    if (metadataLinkedSessionIds(task.metadata).some((item) => item === sessionId)) return true;
    const linkedTaskIds: TaskId[] = metadataLinkedTaskIds(task.metadata);
    for (const metadataTaskId of linkedTaskIds) {
      const linkedTask: RuntimeTaskView | undefined = view.tasks[metadataTaskId];
      if (linkedTask?.sessionId === sessionId || linkedTask?.childSessionId === sessionId) return true;
    }
  }
  for (const messageId of team.messageIds) {
    const message = view.teamMessages[messageId];
    if (message?.sessionId === sessionId) return true;
  }
  for (const runId of team.runIds) {
    const run = view.teamRuns[runId];
    if (run?.sessionId === sessionId) return true;
  }
  return false;
}

function metadataLinkedTaskIds(metadata: Record<string, unknown>): TaskId[] {
  const ids: TaskId[] = [];
  const dispatch = metadataRecord(metadata, "chiliTeamDispatch");
  const verification = metadataRecord(metadata, "verification");
  const agentTaskId = stringValue(dispatch?.agentTaskId) as TaskId | undefined;
  const verifierTaskId = stringValue(verification?.verifierTaskId) as TaskId | undefined;
  if (agentTaskId) ids.push(agentTaskId);
  if (verifierTaskId) ids.push(verifierTaskId);
  return ids;
}

function recordTeamDelegatedTasks(
  view: ChiliRuntimeView,
  teamId: TeamId,
  metadata: Record<string, unknown>,
): void {
  for (const taskId of metadataLinkedTaskIds(metadata)) {
    view.teamIdByDelegatedTaskId[taskId] = teamId;
  }
}

function metadataLinkedSessionIds(metadata: Record<string, unknown>): SessionId[] {
  const ids: SessionId[] = [];
  const dispatch = metadataRecord(metadata, "chiliTeamDispatch");
  const childSessionId = stringValue(dispatch?.childSessionId) as SessionId | undefined;
  if (childSessionId) ids.push(childSessionId);
  return ids;
}

function activityItem(input: {
  id: string;
  kind: TeamLiveActivityKind;
  time: number;
  label: string;
  status?: string | undefined;
  detail?: string | undefined;
  toolName?: string | undefined;
  taskId?: TaskId | undefined;
  teamId?: TeamId | undefined;
  teamMessageId?: string | undefined;
  from?: AgentPath | undefined;
  to?: AgentPath | "*" | undefined;
}): TeamLiveActivityItem {
  const item: TeamLiveActivityItem = {
    id: input.id,
    kind: input.kind,
    time: input.time,
    label: input.label,
  };
  assignOptional(item, "status", input.status);
  assignOptional(item, "detail", input.detail);
  assignOptional(item, "toolName", input.toolName);
  assignOptional(item, "taskId", input.taskId);
  assignOptional(item, "teamId", input.teamId);
  assignOptional(item, "teamMessageId", input.teamMessageId);
  assignOptional(item, "from", input.from);
  assignOptional(item, "to", input.to);
  return item;
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

function runtimeAgentMailboxPayload(value: unknown): {
  role: MessageRole | undefined;
  messageKind: string | undefined;
  preview: string | undefined;
  metadataSummary: RuntimeAgentMailboxMetadataSummary | undefined;
} {
  const message = recordObjectValue(value);
  if (!message) return { role: undefined, messageKind: undefined, preview: undefined, metadataSummary: undefined };
  const metadata = recordObjectValue(message.metadata);
  const role = messageRoleValue(message.role);
  const messageKind = stringValue(metadata?.kind);
  const preview = boundedSingleLine(mailboxPayloadText(message), 320);
  return {
    role,
    messageKind,
    preview,
    metadataSummary: runtimeAgentMailboxMetadataSummary(metadata),
  };
}

function mailboxPayloadText(message: Record<string, unknown>): string | undefined {
  const content = stringValue(message.content);
  if (content) return content;
  if (!Array.isArray(message.parts)) return undefined;
  const text = message.parts.flatMap((part) => {
    const record = recordObjectValue(part);
    if (!record) return [];
    const value = stringValue(record.text)
      ?? stringValue(record.output)
      ?? stringValue(record.displayText)
      ?? stringValue(record.filename);
    return value ? [value] : [];
  }).join(" ");
  return text || undefined;
}

function runtimeAgentMailboxMetadataSummary(
  metadata: Record<string, unknown> | undefined,
): RuntimeAgentMailboxMetadataSummary | undefined {
  if (!metadata) return undefined;
  const summary: RuntimeAgentMailboxMetadataSummary = {};
  assignOptional(summary, "kind", stringValue(metadata.kind));
  assignOptional(summary, "batchId", stringValue(metadata.batchId) ?? stringValue(metadata.batch_id));
  assignOptional(summary, "completionPolicy", taskCompletionPolicyValue(metadata.completionPolicy ?? metadata.completion_policy));
  assignOptional(summary, "taskIds", taskIdArrayValue(metadata.taskIds) ?? taskIdArrayValue(metadata.task_ids));
  const total = finiteNumberValue(metadata.total);
  if (total !== undefined && total >= 0) summary.total = total;
  const expectedBatchSize = finiteNumberValue(metadata.expectedBatchSize ?? metadata.expected_batch_size);
  if (expectedBatchSize !== undefined && expectedBatchSize >= 0) summary.expectedBatchSize = expectedBatchSize;
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function messageRoleValue(value: unknown): MessageRole | undefined {
  return value === "system" || value === "user" || value === "assistant" || value === "tool" ? value : undefined;
}

function boundedSingleLine(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function teamMemberKey(teamId: TeamId, path: AgentPath): string {
  return `${teamId}:${path}`;
}

function isStaleTaskSpawn(task: RuntimeTaskView, generation: number | undefined): boolean {
  if (generation !== undefined && generation < task.generation) return true;
  return isFinalTaskStatus(task.status) && (generation === undefined || generation <= task.generation);
}

function isFinalTaskStatus(status: RuntimeTaskStatus): boolean {
  return status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled";
}

function isFinalToolStatus(status: RuntimeToolCallView["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
