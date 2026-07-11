import type {
  AgentPath,
  AgentRunId,
  AgentTaskMode,
  ApprovalId,
  ApprovalDecisionAction,
  ChiliEvent,
  EventEnvelope,
  MessageId,
  MessagePart,
  MessageRole,
  ModelMetadataPayload,
  ModelUsage,
  PartId,
  RuntimeSessionStatus,
  SessionId,
  TaskId,
  TeamId,
  TeamMemberStatus,
  TeamMessageDelivery,
  TeamMessageDeliveryStatus,
  TeamMessageKind,
  TeamRunLifecyclePhase,
  TeamRunStopReason,
  TeamRunSummaryCounts,
  ThreadGoal,
  ThreadId,
  ToolCallId,
  ToolCallStatus,
  ToolOutputStream,
  TurnId,
} from "@chili/protocol";
import { isTransientEvent } from "@chili/protocol";

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
  teamRunIds: string[];
  teamRuns: Record<string, RuntimeTeamRunView>;
  teamRunIdsByTeam: Record<string, string[]>;
  modelMetadataTurnIds: TurnId[];
  modelMetadataByTurn: Record<string, RuntimeModelMetadataView>;
  goalsByThread: Record<string, RuntimeThreadGoalView>;
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
  threadId?: ThreadId;
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
  turnId?: TurnId;
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
  threadId?: ThreadId;
}

export interface RuntimeThreadGoalView extends ThreadGoal {}

export interface RuntimeApprovalView {
  id: ApprovalId;
  permission: string;
  patterns: string[];
  status: "pending" | "resolved";
  createdAt: number;
  sessionId?: SessionId;
  threadId?: ThreadId;
  callId?: ToolCallId;
  metadata?: Record<string, unknown>;
  decision?: ApprovalDecisionAction;
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
  taskId?: TaskId;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  error?: string;
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
  metadata?: Record<string, unknown>;
  summary?: string;
  error?: string;
  sessionId?: SessionId;
  createdBy?: AgentPath;
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
  metadata?: Record<string, unknown>;
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
  threadId?: ThreadId;
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
  childThreadId?: ThreadId;
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
  childThreadId?: ThreadId;
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
  threadId?: ThreadId;
  turnId?: TurnId;
  waitingForApproval: boolean;
  error?: string;
}

export interface TeamLiveApprovalSummary {
  id: ApprovalId;
  permission: string;
  patterns: string[];
  status: RuntimeApprovalView["status"];
  createdAt: number;
  sessionId?: SessionId;
  threadId?: ThreadId;
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
  threadId?: ThreadId;
  limit?: number;
  generatedAt?: string;
  requireSession?: boolean;
}

export interface ChatSessionView {
  sessionId?: SessionId;
  threadId?: ThreadId;
  status: RuntimeSessionStatus | "unknown";
  items: ChatTranscriptItem[];
  pendingApprovals: ChatApprovalRow[];
  activeTools: ChatToolCallRow[];
  goal?: ThreadGoal;
  generatedAt: string;
  latestModelMetadata?: ModelMetadataPayload;
  usageSummary?: ModelUsage;
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
  threadId?: ThreadId;
  completedAt?: number;
}

export type ChatMessagePart =
  | { type: "text"; id: PartId; text: string; rawText?: string; synthetic?: boolean }
  | { type: "image"; id: PartId; mimeType: string; filename?: string; sourcePath?: string; displayText?: string }
  | { type: "reasoning"; id: PartId; text: string; redacted?: boolean }
  | { type: "tool_call"; id: PartId; callId: ToolCallId; toolName: string; status: ToolPartStatus; input?: unknown; displayStatus?: ChatToolDisplayStatus }
  | { type: "tool_result"; id: PartId; callId: ToolCallId; output: string; content?: Extract<MessagePart, { type: "tool_result" }>["content"]; error?: string; synthetic?: boolean }
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
  liveOutput?: RuntimeToolOutputDelta[];
  sessionId?: SessionId;
  threadId?: ThreadId;
  approvalId?: ApprovalId;
  approvalStatus?: RuntimeApprovalView["status"];
  approvalDecision?: RuntimeApprovalView["decision"];
}

export interface ChatApprovalRow {
  id: ApprovalId;
  kind: "approval";
  permission: string;
  patterns: string[];
  status: RuntimeApprovalView["status"];
  createdAt: number;
  sessionId?: SessionId;
  threadId?: ThreadId;
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
    teamRunIds: [],
    teamRuns: {},
    teamRunIdsByTeam: {},
    modelMetadataTurnIds: [],
    modelMetadataByTurn: {},
    goalsByThread: {},
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
      const session = upsertSession(view, event.payload.sessionId, event.time);
      session.cwd = event.payload.cwd;
      session.lifecycle = "active";
      session.updatedAt = event.time;
      assignOptional(session, "threadId", event.threadId);
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
    case "turn.model_metadata": {
      const existing = view.modelMetadataByTurn[event.payload.turnId];
      if (!existing) {
        view.modelMetadataTurnIds.push(event.payload.turnId);
      }
      view.modelMetadataByTurn[event.payload.turnId] = runtimeModelMetadata(event.payload, event.time, event.sessionId, event.threadId, existing);
      const sessionId = event.sessionId ?? existing?.sessionId;
      if (sessionId) touchSession(view, sessionId, event.time);
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
      if (event.payload.toolName !== undefined) toolCall.toolName = event.payload.toolName;
      if (hasOwn(event.payload, "input")) toolCall.input = event.payload.input;
      assignOptional(toolCall, "sessionId", event.sessionId);
      assignOptional(toolCall, "threadId", event.threadId);
      assignOptional(toolCall, "metadata", event.payload.metadata);
      toolCall.updatedAt = event.time;
      linkToolCallToSession(view, toolCall, event.time);
      setToolPartStatus(view, event.payload.callId, event.payload.status);
      if (event.payload.status === "waiting_for_approval" && toolCall.sessionId) {
        const session = upsertSession(view, toolCall.sessionId, event.time);
        session.status = "waiting_for_approval";
        session.updatedAt = event.time;
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
      assignOptional(toolCall, "threadId", event.threadId);
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
      assignOptional(approval, "threadId", event.threadId);
      assignOptional(approval, "callId", event.payload.callId);
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
      const goal = cloneThreadGoal(event.payload.goal);
      view.goalsByThread[goal.threadId] = goal;
      const sessionId = goal.sessionId ?? event.sessionId;
      if (sessionId) touchSession(view, sessionId, event.time);
      break;
    }
    case "goal.cleared": {
      delete view.goalsByThread[event.payload.threadId];
      if (event.sessionId) touchSession(view, event.sessionId, event.time);
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

export function chatSessionView(view: ChiliRuntimeView, input: ChatSessionInput = {}): ChatSessionView {
  const limit = Math.max(1, input.limit ?? 80);
  const session = input.sessionId ? view.sessions[input.sessionId] : input.requireSession ? undefined : latestSession(view);
  const sessionId = input.sessionId ?? session?.id;
  const messages = session
    ? session.messageIds.flatMap((messageId) => {
      const message = view.messages[messageId];
      if (!message || !matchesThread(message.threadId, input.threadId)) return [];
      return [chatMessageRow(message)];
    })
    : [];
  const tools = session
    ? session.toolCallIds.flatMap((callId) => {
      const toolCall = view.toolCalls[callId];
      if (!toolCall || !matchesThread(toolCall.threadId, input.threadId)) return [];
      return [chatToolCallRow(view, toolCall)];
    })
    : [];
  const approvals = session
    ? session.approvalIds.flatMap((approvalId) => {
      const approval = view.approvals[approvalId];
      if (!approval || !matchesThread(approval.threadId, input.threadId)) return [];
      return [chatApprovalRow(view, approval)];
    })
    : [];
  const modelMetadata = session
    ? modelMetadataForSession(view, session.id, input.threadId)
    : [];
  const latestModelMetadata = modelMetadata.at(-1);
  const usageSummary = modelUsageSummary(modelMetadata);
  const threadId = input.threadId ?? session?.threadId;
  const goal = threadId ? view.goalsByThread[threadId] : undefined;
  const items = [...messages, ...tools, ...approvals]
    .sort((left, right) => chatItemTime(left) - chatItemTime(right))
    .slice(-limit);
  const output: ChatSessionView = {
    status: session?.status ?? "unknown",
    items,
    pendingApprovals: approvals.filter((approval) => approval.status === "pending"),
    activeTools: tools.filter((tool) => tool.status === "running" || tool.status === "waiting_for_approval" || tool.status === "validating"),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
  assignOptional(output, "sessionId", sessionId);
  assignOptional(output, "threadId", threadId);
  assignOptional(output, "goal", goal ? cloneThreadGoal(goal) : undefined);
  assignOptional(output, "latestModelMetadata", latestModelMetadata ? chatModelMetadata(latestModelMetadata) : undefined);
  assignOptional(output, "usageSummary", usageSummary);
  assignOptional(output, "lastEventId", view.lastEventId);
  return output;
}

function latestSession(view: ChiliRuntimeView): RuntimeSessionView | undefined {
  for (let index = view.sessionIds.length - 1; index >= 0; index -= 1) {
    const session = view.sessions[view.sessionIds[index] ?? ""];
    if (session) return session;
  }
  return undefined;
}

function runtimeModelMetadata(
  payload: ModelMetadataPayload,
  updatedAt: number,
  sessionId: SessionId | undefined,
  threadId: ThreadId | undefined,
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
  assignOptional(output, "threadId", threadId ?? existing?.threadId);
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
  threadId: ThreadId | undefined,
): RuntimeModelMetadataView[] {
  return view.modelMetadataTurnIds
    .flatMap((turnId) => {
      const metadata = view.modelMetadataByTurn[turnId];
      return metadata ? [metadata] : [];
    })
    .filter((metadata) => metadata.sessionId === sessionId && matchesThread(metadata.threadId, threadId))
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
  const parts = [usage.inputTokens, usage.outputTokens].filter(isFiniteNumber);
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

function cloneThreadGoal(goal: ThreadGoal): ThreadGoal {
  const output: ThreadGoal = {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
  assignOptional(output, "sessionId", goal.sessionId);
  assignOptional(output, "tokenBudget", goal.tokenBudget);
  assignOptional(output, "completedAt", goal.completedAt);
  assignOptional(output, "lastReason", goal.lastReason);
  return output;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function matchesThread(value: ThreadId | undefined, requested: ThreadId | undefined): boolean {
  return requested ? !value || value === requested : true;
}

function chatMessageRow(message: RuntimeMessageView): ChatMessageRow {
  const row: ChatMessageRow = {
    id: message.id,
    kind: "message",
    role: message.role,
    parts: message.parts.map((part) => chatMessagePart(part)),
    createdAt: message.createdAt,
  };
  assignOptional(row, "threadId", message.threadId);
  assignOptional(row, "completedAt", message.completedAt);
  return row;
}

function chatMessagePart(part: MessagePart): ChatMessagePart {
  if (part.type === "text") {
    const output: ChatMessagePart = { type: "text", id: part.id, text: part.displayText ?? part.text };
    if (part.displayText && part.displayText !== part.text) output.rawText = part.text;
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
    assignOptional(output, "synthetic", part.synthetic);
    return output;
  }
  if (part.type === "patch") return { type: "summary", id: part.id, text: `patch: ${part.files.join(", ")}` };
  if (part.type === "artifact") return { type: "summary", id: part.id, text: `artifact: ${part.artifactId}` };
  if (part.type === "compaction") return { type: "summary", id: part.id, text: part.summary ?? `compaction: ${part.reason}` };
  return { type: "summary", id: part.id, text: `agent handoff: ${part.agentPath}` };
}

function chatToolCallRow(view: ChiliRuntimeView, toolCall: RuntimeToolCallView): ChatToolCallRow {
  const linkedApprovals = approvalsForToolCall(view, toolCall.id);
  const pendingApproval = linkedApprovals.find((approval) => approval.status === "pending");
  const latestApproval = latestApprovalForToolCall(linkedApprovals);
  const status = pendingApproval ? "waiting_for_approval" : toolCall.status;
  const row: ChatToolCallRow = {
    id: toolCall.id,
    kind: "tool",
    toolName: toolCall.toolName,
    status,
    displayStatus: chatToolDisplayStatus(status, latestApproval),
    waitingForApproval: Boolean(pendingApproval),
    updatedAt: toolCall.updatedAt,
    inputSummary: chatToolInputSummary(toolCall.toolName, toolCall.input, pendingApproval?.patterns ?? latestApproval?.patterns ?? []),
  };
  assignOptional(row, "input", toolCall.input);
  assignOptional(row, "output", toolCall.output);
  assignOptional(row, "error", toolCall.error);
  assignOptional(row, "liveOutput", toolCall.liveOutput ? toolCall.liveOutput.map((delta) => ({ ...delta })) : undefined);
  assignOptional(row, "sessionId", toolCall.sessionId);
  assignOptional(row, "threadId", toolCall.threadId);
  assignOptional(row, "approvalId", pendingApproval?.id ?? latestApproval?.id);
  assignOptional(row, "approvalStatus", pendingApproval?.status ?? latestApproval?.status);
  assignOptional(row, "approvalDecision", latestApproval?.decision);
  return row;
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
  assignOptional(row, "threadId", approval.threadId);
  assignOptional(row, "callId", approval.callId);
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
      assignOptional(row, "childThreadId", member.childThreadId);
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
      assignOptional(summary, "threadId", approval.threadId);
      assignOptional(summary, "callId", approval.callId);
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
      assignOptional(summary, "threadId", toolCall.threadId);
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
  assignOptional(summary, "childThreadId", stringValue(value.childThreadId) as ThreadId | undefined);
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
    assignOptional(task, "createdBy", stringValue(payload.createdBy) as AgentPath | undefined);
    assignOptional(task, "dependsOn", taskIdArrayValue(payload.dependsOn));
    assignOptional(task, "metadata", recordObjectValue(payload.metadata));
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
    assignOptional(run, "threadId", event.threadId);
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
    assignOptional(run, "threadId", event.threadId);
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
    assignOptional(run, "threadId", event.threadId);
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
    assignOptional(message, "taskId", stringValue(payload.taskId) as TaskId | undefined);
    assignOptional(message, "childSessionId", stringValue(payload.childSessionId) as SessionId | undefined);
    assignOptional(message, "childThreadId", stringValue(payload.childThreadId) as ThreadId | undefined);
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
    assignOptional(task, "metadata", recordObjectValue(payload.metadata));
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

function isFinalToolStatus(status: RuntimeToolCallView["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
