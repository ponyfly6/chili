import type {
  ChiliEvent,
  RuntimeInputMode,
  RuntimeInputQueue,
  RuntimeSessionInput,
  SessionAgentMetadata,
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
  RuntimeStateSnapshot,
  RuntimeSkillMention,
  ModelSelection,
  ReasoningLevel,
  ServiceTier,
  SessionId,
  SessionGoal,
  SessionGoalStatus,
  UserInputAnswers as ProtocolUserInputAnswers,
  UserInputId,
  UserInputQuestion as ProtocolUserInputQuestion,
} from "@chili/protocol";
import {
  RUNTIME_STATE_SNAPSHOT_MAX_BYTES,
  normalizePersistedError,
  parseRuntimeInputQueue,
  parseSessionAgentMetadata,
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
  parseRuntimeStateSnapshot,
  parseRuntimeString,
  parseRuntimeStringArray,
  type RuntimeParser,
} from "@chili/protocol";
import type { RuntimeAgentRecord, RuntimeAgentSubmission, RuntimeAgentWaitResult, RuntimeAgentControlRequest } from "@chili/protocol";
export type { RuntimeAgentRecord, RuntimeAgentSubmission, RuntimeAgentWaitResult } from "@chili/protocol";

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
  listAgents(input: ListAgentsRequest): Promise<RuntimeAgentRecord[]>;
  spawnAgent(input: SpawnAgentRequest): Promise<RuntimeAgentSubmission>;
  sendAgent(input: SendAgentRequest): Promise<RuntimeAgentSubmission>;
  waitAgent(input: WaitAgentRequest): Promise<RuntimeAgentWaitResult>;
  stopAgent(input: TargetAgentRequest): Promise<{ agentId: string }>;
  resumeAgent(input: TargetAgentRequest): Promise<{ agentId: string; inputId?: string }>;
  messages(sessionId: SessionId): Promise<Message[]>;
  streamEvents(input?: StreamEventsRequest): AsyncIterable<ChiliEvent>;
  /** Atomic projected state and its durable stream watermark. */
  eventSnapshot(input?: EventSnapshotRequest): Promise<RuntimeStateSnapshot>;
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
  agent?: SessionAgentMetadata;
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

export interface ListAgentsRequest extends RuntimeAgentControlRequest {}

export interface SpawnAgentRequest extends RuntimeAgentControlRequest {
  name: string;
  prompt: string;
  cwd?: string;
}

export interface TargetAgentRequest extends RuntimeAgentControlRequest {
  agentId: string;
}

export interface SendAgentRequest extends TargetAgentRequest {
  text: string;
  mode?: "queue" | "steer";
}

export interface WaitAgentRequest extends TargetAgentRequest {
  inputId: string;
  timeoutMs?: number;
}

export interface StreamEventsRequest {
  sessionId?: SessionId;
  afterEventId?: string;
  /** Resume an empty snapshot from the beginning, without an initial tail limit. */
  fromStart?: boolean;
  signal?: AbortSignal;
}

export interface EventSnapshotRequest {
  sessionId?: SessionId;
  signal?: AbortSignal;
}

export class EventCursorResyncRequiredError extends Error {
  readonly code = "EVENT_CURSOR_RESYNC_REQUIRED";
  readonly status = 409;

  constructor(
    message: string,
    readonly afterEventId: string | undefined,
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
    /** Diagnostic only. Recover state through eventSnapshot before advancing. */
    readonly resumeAfterEventId?: string,
    readonly reason: "event_transport_limit" | "transient_buffer_overflow" = "event_transport_limit",
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

  listAgents(input: ListAgentsRequest): Promise<RuntimeAgentRecord[]> {
    return this.get(agentControlPath(input.sessionId), input.signal, (value, path) => parseRuntimeArray(value, parseAgentRecord, path));
  }

  spawnAgent(input: SpawnAgentRequest): Promise<RuntimeAgentSubmission> {
    const { sessionId, signal, ...body } = input;
    return this.post(agentControlPath(sessionId), body, signal, parseAgentSubmission);
  }

  sendAgent(input: SendAgentRequest): Promise<RuntimeAgentSubmission> {
    const { sessionId, agentId, signal, ...body } = input;
    return this.post(agentControlPath(sessionId, agentId, "send"), body, signal, parseAgentSubmission);
  }

  waitAgent(input: WaitAgentRequest): Promise<RuntimeAgentWaitResult> {
    const { sessionId, agentId, signal, ...body } = input;
    return this.post(agentControlPath(sessionId, agentId, "wait"), body, signal, parseAgentWaitResult);
  }

  stopAgent(input: TargetAgentRequest): Promise<{ agentId: string }> {
    return this.post(agentControlPath(input.sessionId, input.agentId, "stop"), {}, input.signal, parseAgentTarget);
  }

  resumeAgent(input: TargetAgentRequest): Promise<{ agentId: string; inputId?: string }> {
    return this.post(agentControlPath(input.sessionId, input.agentId, "resume"), {}, input.signal, parseAgentResumeResult);
  }

  messages(sessionId: SessionId): Promise<Message[]> {
    return this.get(`sessions/${encodeURIComponent(sessionId)}/messages`, undefined, parseRuntimeMessageArray);
  }

  eventSnapshot(input: EventSnapshotRequest = {}): Promise<RuntimeStateSnapshot> {
    return this.get(
      sessionScopedRequestPath("events/snapshot", input.sessionId), input.signal, parseRuntimeStateSnapshot,
      false, RUNTIME_STATE_SNAPSHOT_MAX_BYTES,
    );
  }

  async *streamEvents(input: StreamEventsRequest = {}): AsyncIterable<ChiliEvent> {
    const url = this.url("events");
    if (input.sessionId) url.searchParams.set("sessionId", input.sessionId);
    if (input.afterEventId) url.searchParams.set("afterEventId", input.afterEventId);
    if (input.fromStart) url.searchParams.set("fromStart", "true");

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
      if (response.status === 409 && (input.afterEventId || input.fromStart)) {
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
              throw new EventTransportResyncRequiredError(`Runtime SSE frame exceeds ${MAX_SSE_CLIENT_BUFFER_BYTES} bytes`);
            }
            const parsed = parseSseFrame(buffer, this.#authorization);
            if (parsed?.kind === "resync") {
              throw new EventTransportResyncRequiredError(parsed.message, parsed.afterEventId, parsed.reason);
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
            throw new EventTransportResyncRequiredError(`Runtime SSE frame exceeds ${MAX_SSE_CLIENT_BUFFER_BYTES} bytes`);
          }
          const parsed = parseSseFrame(frame, this.#authorization);
          if (parsed?.kind === "resync") {
            throw new EventTransportResyncRequiredError(parsed.message, parsed.afterEventId, parsed.reason);
          }
          if (parsed) yield parsed.event;
        }
        if (new TextEncoder().encode(buffer).byteLength > MAX_SSE_CLIENT_BUFFER_BYTES) {
          throw new EventTransportResyncRequiredError(`Runtime SSE frame exceeds ${MAX_SSE_CLIENT_BUFFER_BYTES} bytes`);
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
    maxResponseBytes?: number,
  ): Promise<T> {
    const init: RequestInit = { method: "GET" };
    if (signal) init.signal = signal;
    return this.request(path, init, parser, allowNoContent, maxResponseBytes);
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
    maxResponseBytes?: number,
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
    // Limit snapshot bytes before JSON parsing or creating the projection.
    // Content-Length alone cannot bound chunked or dishonest response bodies.
    const text = maxResponseBytes === undefined ? undefined : await readBoundedResponseText(response, maxResponseBytes, init.signal);
    if (maxResponseBytes !== undefined && text === undefined) {
      throw new TypeError(`Runtime response for ${path} exceeds ${maxResponseBytes} bytes`);
    }
    let value: unknown;
    try {
      value = text === undefined ? await response.json() as unknown : JSON.parse(text) as unknown;
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
  if (record.agent !== undefined) parseSessionAgentMetadata(record.agent, `${path}.agent`);
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

function agentControlPath(sessionId: SessionId, agentId?: string, action?: string): string {
  const root = parseRuntimeIdentifier(sessionId, "sessionId");
  const base = `sessions/${encodeURIComponent(root)}/agents`;
  return agentId === undefined ? base : `${base}/${encodeURIComponent(parseRuntimeIdentifier(agentId, "agentId"))}/${action}`;
}

function parseAgentRecord(value: unknown, path = "agent"): RuntimeAgentRecord {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.agentId, `${path}.agentId`);
  parseRuntimeString(record.name, `${path}.name`);
  parseRuntimeString(record.path, `${path}.path`);
  optionalIdentifier(record.parentAgentId, `${path}.parentAgentId`);
  parseRuntimeEnum(record.state, ["idle", "running", "paused"] as const, `${path}.state`);
  return record as unknown as RuntimeAgentRecord;
}

function parseAgentTarget(value: unknown, path = "response"): { agentId: string } {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.agentId, `${path}.agentId`);
  return record as unknown as { agentId: string };
}

function parseAgentSubmission(value: unknown, path = "response"): RuntimeAgentSubmission {
  const record = parseRuntimeRecord(value, path);
  parseAgentTarget(record, path);
  parseRuntimeIdentifier(record.inputId, `${path}.inputId`);
  return record as unknown as RuntimeAgentSubmission;
}

function parseAgentResumeResult(value: unknown, path = "response"): { agentId: string; inputId?: string } {
  const record = parseRuntimeRecord(value, path);
  parseAgentTarget(record, path);
  optionalIdentifier(record.inputId, `${path}.inputId`);
  return record as unknown as { agentId: string; inputId?: string };
}

function parseAgentWaitResult(value: unknown, path = "response"): RuntimeAgentWaitResult {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeSessionInput(record.input, `${path}.input`);
  parseRuntimeBoolean(record.timedOut, `${path}.timedOut`);
  return record as unknown as RuntimeAgentWaitResult;
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
  | { kind: "resync"; afterEventId?: string; message: string; reason: EventTransportResyncRequiredError["reason"] };

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
    const afterEventId = record.afterEventId === undefined ? undefined : requireSseControlText(record.afterEventId, "afterEventId", 512);
    if (afterEventId !== undefined && boundedRemoteDiagnostic(afterEventId, 512, authorization) !== afterEventId) {
      throw new TypeError("Invalid event resync afterEventId");
    }
    const message = boundedRemoteDiagnostic(
      requireSseControlText(record.message, "message", MAX_SSE_CONTROL_MESSAGE_BYTES),
      MAX_SSE_CONTROL_MESSAGE_BYTES,
      authorization,
    );
    if (record.reason !== "event_transport_limit" && record.reason !== "transient_buffer_overflow") {
      throw new TypeError("Invalid event resync reason");
    }
    return { kind: "resync", ...(afterEventId === undefined ? {} : { afterEventId }), message, reason: record.reason };
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

async function readBoundedResponseText(response: Response, maxBytes: number, signal?: AbortSignal | null): Promise<string | undefined> {
  if (signal?.aborted) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
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
  // A mocked/custom fetch need not connect its body to the request's signal.
  // Cancelling the reader also releases an outstanding read in that case.
  const onAbort = (): void => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
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
  } finally {
    signal?.removeEventListener("abort", onAbort);
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
