import type { ReadingPreferences } from "./reading-preferences.js";
import type { DesktopTheme } from "./appearance.js";
import {
  normalizeSessionTitle,
  parseChiliEvent,
  parseRuntimeExecutionIdentity,
  parseRuntimeInputQueue,
  parseSessionAgentMetadata,
  type RuntimeInputQueue,
  type RuntimeAgentRecord,
  parseRuntimeDelegationConfig as parseProtocolDelegationConfig,
  parseRuntimeMcpReloadResponse as parseProtocolMcpReloadResponse,
  parseRuntimeMcpStatusResponse as parseProtocolMcpStatusResponse,
  parseRuntimeModelConfig as parseProtocolModelConfig,
  parseRuntimeModelDescriptor as parseProtocolModelDescriptor,
  parseRuntimePermissionConfig as parseProtocolPermissionConfig,
  type ChiliEvent,
  type DelegationPolicy,
  type ModelSelection,
  type ReasoningLevel,
  type RuntimeDelegationConfig,
  type RuntimeMcpReloadResponse,
  type RuntimeMcpStatusResponse,
  type RuntimeModelConfig,
  type RuntimeModelDescriptor,
  type RuntimePermissionConfig,
  type RuntimePermissionProfileId,
  type ServiceTier,
} from "@chili/protocol";
import type {
  RuntimePendingApprovalRequest,
  RuntimeSessionSummary,
} from "@chili/sdk";

export const DESKTOP_INVOKE_CHANNEL = "chili:desktop:invoke";
export const DESKTOP_EVENT_CHANNEL = "chili:desktop:event";
export const DESKTOP_EVENT_READY_CHANNEL = "chili:desktop:event-ready";
export const DESKTOP_EVENT_ACK_CHANNEL = "chili:desktop:event-ack";
export const DESKTOP_INVOKE_CLOSING_RESPONSE = Object.freeze({
  __chiliDesktopInvoke: "closing" as const,
});

const MAX_DESKTOP_JSON_BYTES = 12_000_000;
const MAX_PENDING_APPROVAL_BYTES = 1_000_000;
const MAX_PENDING_APPROVAL_ROW_BYTES = 64_000;

export type SidecarPhase = "idle" | "starting" | "healthy" | "recovering" | "stopping" | "error";
export type SendMode = "queue" | "steer";
export type DiffScope = "turn" | "workspace";
export type SessionListStatus = "active" | "archived" | "all";
export type DesktopCreateSessionStage =
  | "rename"
  | "model"
  | "reasoning"
  | "service_tier"
  | "delegation"
  | "permission"
  | "prompt";
export type DesktopResyncReason =
  | "renderer_ready"
  | "source_cursor"
  | "outbox_overflow"
  | "ack_timeout"
  | "sequence_gap"
  | "delivery_error";

export interface DesktopProject {
  id: string;
  path: string;
  phase: SidecarPhase;
  runningCount: number;
  attentionCount: number;
  tasksLoaded: boolean;
  recentTasks: Array<{ id: string; title: string; status: "active" | "archived"; updatedAt: number }>;
}

export interface DesktopState {
  projectId?: string;
  projects?: DesktopProject[];
  workspace?: string;
  sidecar: {
    phase: SidecarPhase;
    attempt: number;
    error?: string;
  };
  queuedBySession: Record<string, number>;
}

export interface RuntimeSnapshot {
  inputQueue?: RuntimeInputQueue;
  sessionId: string;
  events: ChiliEvent[];
  agents: RuntimeAgentRecord[];
  /** Authoritative replacement set from the runtime approval store. */
  pendingApprovals: RuntimePendingApprovalRequest[];
  pendingInputs: UserInputRequest[];
  /** Renderer-only projection metadata; never used as a durable event or cursor. */
  omittedMessageParts?: RuntimeMessagePartOmission[];
  truncated?: boolean;
  warning?: string;
}

export interface RuntimeMessagePartOmission {
  messageId: string;
  partId: string;
  field: "text" | "output";
}

export interface UserInputChoice {
  label: string;
  description?: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: UserInputChoice[];
  multiple?: boolean;
}

export interface UserInputRequest {
  id: string;
  sessionId: string;
  callId: string;
  questions: UserInputQuestion[];
  createdAt: number;
}

/**
 * All values needed to create and launch a top-level desktop task. Permission
 * profiles are runtime-global; the renderer must label them accordingly.
 */
export interface DesktopCreateSessionOptions {
  title?: string;
  prompt?: string;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  permissionProfile?: RuntimePermissionProfileId;
  delegationPolicy?: DelegationPolicy;
}

export interface DesktopCreateSessionFailure {
  stage: DesktopCreateSessionStage;
  message: string;
  /** True when a pre-start global permission mutation was restored. */
  permissionRestored?: boolean;
  /** The final launch request may have committed before its response failed. */
  launchMayHaveCommitted?: boolean;
}

export interface DesktopCreateSessionResult {
  sessionId: string;
  status: "created" | "started" | "partial";
  startState: "not_started" | "started" | "unknown";
  /** Compatibility convenience: true only when startState is started. */
  started: boolean;
  /** A created session is deliberately retained so the user can recover it. */
  failure?: DesktopCreateSessionFailure;
}

export interface DesktopSessionConfig {
  model: RuntimeModelConfig;
  permission: RuntimePermissionConfig;
  delegation: RuntimeDelegationConfig;
  mcp: RuntimeMcpStatusResponse;
}

type DesktopOperation =
  | { type: "reading.get" }
  | ({ type: "reading.set" } & ReadingPreferences)
  | { type: "appearance.get" }
  | { type: "appearance.set"; theme: DesktopTheme }
  | { type: "app.state" }
  | { type: "workspace.select" }
  | { type: "workspace.activate"; id: string }
  | { type: "sessions.list"; query?: string; status?: SessionListStatus }
  | ({ type: "sessions.create" } & DesktopCreateSessionOptions)
  | { type: "models.list"; provider?: string }
  | { type: "session.snapshot"; sessionId: string }
  | { type: "session.resume"; sessionId: string }
  | { type: "session.rename"; sessionId: string; title: string }
  | { type: "session.archive"; sessionId: string }
  | { type: "session.config.get"; sessionId: string }
  | { type: "session.model.set"; sessionId: string; modelSelection: ModelSelection }
  | { type: "session.reasoning.set"; sessionId: string; reasoningLevel: ReasoningLevel }
  | { type: "session.service-tier.set"; sessionId: string; serviceTier: ServiceTier }
  | { type: "permissions.get" }
  | { type: "permissions.set"; profile: RuntimePermissionProfileId }
  | { type: "session.delegation.get"; sessionId: string }
  | { type: "session.delegation.set"; sessionId: string; policy: DelegationPolicy }
  | { type: "mcp.status"; sessionId?: string }
  | { type: "mcp.reload"; sessionId?: string }
  | { type: "session.send"; sessionId: string; text: string; mode: SendMode; submissionId?: string }
  | { type: "session.stop"; sessionId: string }
  | { type: "agent.send"; sessionId: string; agentId: string; text: string; mode?: SendMode }
  | { type: "agent.stop"; sessionId: string; agentId: string }
  | { type: "agent.resume"; sessionId: string; agentId: string }
  | {
      type: "approval.resolve";
      approvalId: string;
      decision: "allow_once" | "allow_session" | "allow_always" | "deny";
      feedback?: string;
    }
  | { type: "user-input.resolve"; inputId: string; answers: Record<string, string[]> }
  | { type: "events.resync.complete"; barrierId: string }
  | { type: "diff.get"; scope: DiffScope; sessionId: string; turnId?: string };

/** Every runtime operation can name its owning project independently of the visible project. */
export type DesktopRequest = DesktopOperation & { projectId?: string };

export interface DesktopResponseMap {
  "reading.get": ReadingPreferences;
  "reading.set": ReadingPreferences;
  "appearance.get": { theme: DesktopTheme };
  "appearance.set": { theme: DesktopTheme };
  "app.state": DesktopState;
  "workspace.select": DesktopState;
  "workspace.activate": DesktopState;
  "sessions.list": RuntimeSessionSummary[];
  "sessions.create": DesktopCreateSessionResult;
  "models.list": RuntimeModelDescriptor[];
  "session.snapshot": RuntimeSnapshot;
  "session.resume": RuntimeSnapshot;
  "session.rename": RuntimeSessionSummary;
  "session.archive": { archived: boolean };
  "session.config.get": DesktopSessionConfig;
  "session.model.set": RuntimeModelConfig;
  "session.reasoning.set": RuntimeModelConfig;
  "session.service-tier.set": RuntimeModelConfig;
  "permissions.get": RuntimePermissionConfig;
  "permissions.set": RuntimePermissionConfig;
  "session.delegation.get": RuntimeDelegationConfig;
  "session.delegation.set": RuntimeDelegationConfig;
  "mcp.status": RuntimeMcpStatusResponse;
  "mcp.reload": RuntimeMcpReloadResponse;
  "session.send": { status: "accepted" | "queued"; position?: number };
  "session.stop": { interrupted: boolean };
  "agent.send": { agentId: string; inputId: string };
  "agent.stop": { agentId: string };
  "agent.resume": { agentId: string; inputId?: string };
  "approval.resolve": { resolved: boolean };
  "user-input.resolve": { resolved: boolean };
  "events.resync.complete": { status: "completed" | "retry" };
  "diff.get": { scope: DiffScope; text: string; truncated: boolean };
}

export type DesktopResponse<Request extends DesktopRequest> = DesktopResponseMap[Request["type"]];

export type DesktopEvent =
  | { type: "state.changed"; state: DesktopState }
  | { type: "runtime.event"; event: ChiliEvent; projectId?: string }
  | { type: "queue.changed"; sessionId: string; count: number; projectId?: string }
  | { type: "runtime.resync"; barrierId: string; reason: DesktopResyncReason };

export interface DesktopEventEnvelope {
  version: 1;
  streamId: string;
  sequence: number;
  event: DesktopEvent;
}

export interface DesktopEventAck {
  version: 1;
  streamId: string;
  sequence: number;
}

export interface DesktopEventReady {
  version: 1;
  streamId: string;
}

export interface ChiliDesktopApi {
  invoke<Request extends DesktopRequest>(request: Request): Promise<DesktopResponse<Request>>;
  subscribe(listener: (event: DesktopEventEnvelope) => void): () => void;
}

export function parseDesktopRequest(value: unknown): DesktopRequest {
  const record = requireRecord(value, "Desktop request");
  const { projectId, ...operation } = record;
  const request = parseDesktopOperation(operation);
  return projectId === undefined ? request : { ...request, projectId: requireProjectId(projectId, "projectId") };
}

function parseDesktopOperation(value: unknown): DesktopOperation {
  const record = requireRecord(value, "Desktop request");
  const type = requireString(record.type, "type", 80);
  assertOnlyKeys(record, requestKeys(type));

  if (type === "workspace.activate") return { type, id: requireProjectId(record.id, "id") };
  if (type === "reading.get") return { type };
  if (type === "reading.set") return { type, expandWork: requireBoolean(record.expandWork, "expandWork") };
  if (type === "appearance.get") return { type };
  if (type === "appearance.set") {
    return { type, theme: requireEnum(record.theme, ["system", "dark", "light"], "theme") as DesktopTheme };
  }
  if (type === "app.state" || type === "workspace.select" || type === "permissions.get") {
    return { type };
  }
  if (type === "sessions.list") {
    const request: Extract<DesktopRequest, { type: "sessions.list" }> = { type };
    if (record.query !== undefined) request.query = requireString(record.query, "query", 500, true).trim();
    if (record.status !== undefined) {
      request.status = requireEnum(record.status, ["active", "archived", "all"], "status") as SessionListStatus;
    }
    return request;
  }
  if (type === "sessions.create") return parseCreateSessionRequest(record);
  if (type === "models.list") {
    const request: Extract<DesktopRequest, { type: "models.list" }> = { type };
    if (record.provider !== undefined) request.provider = requireString(record.provider, "provider", 200);
    return request;
  }
  if (
    type === "session.snapshot"
    || type === "session.resume"
    || type === "session.stop"
    || type === "session.config.get"
    || type === "session.delegation.get"
  ) {
    return { type, sessionId: requireIdentifier(record.sessionId, "sessionId") };
  }
  if (type === "session.rename") {
    return {
      type,
      sessionId: requireIdentifier(record.sessionId, "sessionId"),
      title: normalizeSessionTitle(requireString(record.title, "title", 2_000)),
    };
  }
  if (type === "session.archive") {
    return { type, sessionId: requireIdentifier(record.sessionId, "sessionId") };
  }
  if (type === "session.model.set") {
    return {
      type,
      sessionId: requireIdentifier(record.sessionId, "sessionId"),
      modelSelection: parseModelSelection(record.modelSelection, "modelSelection"),
    };
  }
  if (type === "session.reasoning.set") {
    return {
      type,
      sessionId: requireIdentifier(record.sessionId, "sessionId"),
      reasoningLevel: requireReasoningLevel(record.reasoningLevel, "reasoningLevel"),
    };
  }
  if (type === "session.service-tier.set") {
    return {
      type,
      sessionId: requireIdentifier(record.sessionId, "sessionId"),
      serviceTier: requireServiceTier(record.serviceTier, "serviceTier"),
    };
  }
  if (type === "permissions.set") {
    return { type, profile: requirePermissionProfile(record.profile, "profile") };
  }
  if (type === "session.delegation.set") {
    return {
      type,
      sessionId: requireIdentifier(record.sessionId, "sessionId"),
      policy: requireDelegationPolicy(record.policy, "policy"),
    };
  }
  if (type === "mcp.status" || type === "mcp.reload") {
    const request: Extract<DesktopRequest, { type: typeof type }> = { type };
    if (record.sessionId !== undefined) request.sessionId = requireIdentifier(record.sessionId, "sessionId");
    return request;
  }
  if (type === "session.send") {
    const mode = record.mode;
    if (mode !== "queue" && mode !== "steer") throw new TypeError("mode must be queue or steer");
    return {
      type,
      sessionId: requireIdentifier(record.sessionId, "sessionId"),
      text: requireString(record.text, "text", 200_000),
      mode,
      ...(record.submissionId !== undefined ? { submissionId: requireIdentifier(record.submissionId, "submissionId") } : {}),
    };
  }
  if (type === "agent.send") {
    return {
      type,
      sessionId: requireIdentifier(record.sessionId, "sessionId"),
      agentId: requireIdentifier(record.agentId, "agentId"),
      text: requireString(record.text, "text", 200_000),
      ...(record.mode !== undefined ? { mode: requireEnum(record.mode, ["queue", "steer"], "mode") as SendMode } : {}),
    };
  }
  if (type === "agent.stop" || type === "agent.resume") {
    return { type, sessionId: requireIdentifier(record.sessionId, "sessionId"), agentId: requireIdentifier(record.agentId, "agentId") };
  }
  if (type === "approval.resolve") {
    const decision = record.decision;
    if (decision !== "allow_once" && decision !== "allow_session" && decision !== "allow_always" && decision !== "deny") {
      throw new TypeError("Unsupported approval decision");
    }
    const request: Extract<DesktopRequest, { type: "approval.resolve" }> = {
      type,
      approvalId: requireIdentifier(record.approvalId, "approvalId"),
      decision,
    };
    if (record.feedback !== undefined) request.feedback = requireString(record.feedback, "feedback", 8_000, true);
    return request;
  }
  if (type === "user-input.resolve") {
    const rawAnswers = requireRecord(record.answers, "answers");
    const entries = Object.entries(rawAnswers);
    if (entries.length === 0 || entries.length > 3) throw new TypeError("answers must contain between 1 and 3 question ids");
    const answerEntries: Array<[string, string[]]> = [];
    let totalAnswerChars = 0;
    for (const [rawKey, answer] of entries) {
      const key = requireSafeMapKey(rawKey, "answer key");
      if (!Array.isArray(answer) || answer.length === 0 || answer.length > 20) {
        throw new TypeError("Each answer must be a non-empty string array");
      }
      const parsedAnswers = answer.map((item) => {
        const parsed = requireString(item, "answer", 8_000);
        totalAnswerChars += parsed.length;
        if (totalAnswerChars > 24_000) throw new TypeError("answers exceed the total character limit");
        return parsed;
      });
      answerEntries.push([key, parsedAnswers]);
    }
    const answers = Object.fromEntries(answerEntries) as Record<string, string[]>;
    return { type, inputId: requireIdentifier(record.inputId, "inputId"), answers };
  }
  if (type === "events.resync.complete") {
    return { type, barrierId: requireIdentifier(record.barrierId, "barrierId") };
  }
  if (type === "diff.get") {
    if (record.scope !== "turn" && record.scope !== "workspace") throw new TypeError("Unsupported diff scope");
    const request: Extract<DesktopRequest, { type: "diff.get" }> = {
      type,
      scope: record.scope,
      sessionId: requireIdentifier(record.sessionId, "sessionId"),
    };
    if (record.turnId !== undefined) request.turnId = requireIdentifier(record.turnId, "turnId");
    return request;
  }
  throw new TypeError(`Unsupported desktop request: ${type}`);
}

function parseCreateSessionRequest(
  record: Record<string, unknown>,
): Extract<DesktopRequest, { type: "sessions.create" }> {
  const request: Extract<DesktopRequest, { type: "sessions.create" }> = { type: "sessions.create" };
  if (record.title !== undefined) {
    request.title = normalizeSessionTitle(requireString(record.title, "title", 2_000));
  }
  if (record.prompt !== undefined) request.prompt = requireString(record.prompt, "prompt", 200_000);
  if (record.modelSelection !== undefined) {
    request.modelSelection = parseModelSelection(record.modelSelection, "modelSelection");
  }
  if (record.reasoningLevel !== undefined) {
    request.reasoningLevel = requireReasoningLevel(record.reasoningLevel, "reasoningLevel");
  }
  if (record.serviceTier !== undefined) request.serviceTier = requireServiceTier(record.serviceTier, "serviceTier");
  if (record.permissionProfile !== undefined) {
    request.permissionProfile = requirePermissionProfile(record.permissionProfile, "permissionProfile");
  }
  if (record.delegationPolicy !== undefined) {
    request.delegationPolicy = requireDelegationPolicy(record.delegationPolicy, "delegationPolicy");
  }
  return request;
}

function parseModelSelection(value: unknown, field: string): ModelSelection {
  const selection = requireRecord(value, field);
  assertOnlyKeys(selection, ["provider", "model"]);
  return {
    provider: requireString(selection.provider, `${field}.provider`, 200),
    model: requireString(selection.model, `${field}.model`, 500),
  };
}

function requireReasoningLevel(value: unknown, field: string): ReasoningLevel {
  return requireEnum(
    value,
    ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    field,
  ) as ReasoningLevel;
}

function requireServiceTier(value: unknown, field: string): ServiceTier {
  return requireEnum(value, ["standard", "fast"], field) as ServiceTier;
}

function requireDelegationPolicy(value: unknown, field: string): DelegationPolicy {
  return requireEnum(value, ["off", "explicit", "proactive"], field) as DelegationPolicy;
}

function requirePermissionProfile(value: unknown, field: string): RuntimePermissionProfileId {
  return requireEnum(value, ["default", "auto-review", "full-access"], field) as RuntimePermissionProfileId;
}

export function parseDesktopEvent(value: unknown): DesktopEvent {
  assertDesktopJsonValue(value, "Desktop event");
  const record = requireRecord(value, "Desktop event");
  if (record.type === "state.changed") {
    assertOnlyKeys(record, ["type", "state"]);
    return { type: "state.changed", state: parseDesktopState(record.state) };
  }
  if (record.type === "queue.changed") {
    assertOnlyKeys(record, ["type", "sessionId", "count", "projectId"]);
    const count = record.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new TypeError("Invalid queue count");
    return { type: "queue.changed", sessionId: requireSafeMapKey(record.sessionId, "sessionId"), count,
      ...(record.projectId === undefined ? {} : { projectId: requireProjectId(record.projectId, "projectId") }) };
  }
  if (record.type === "runtime.resync") {
    assertOnlyKeys(record, ["type", "barrierId", "reason"]);
    return {
      type: "runtime.resync",
      barrierId: requireIdentifier(record.barrierId, "barrierId"),
      reason: requireResyncReason(record.reason),
    };
  }
  if (record.type === "runtime.event") {
    assertOnlyKeys(record, ["type", "event", "projectId"]);
    return { type: "runtime.event", event: parseRuntimeEvent(record.event),
      ...(record.projectId === undefined ? {} : { projectId: requireProjectId(record.projectId, "projectId") }) };
  }
  throw new TypeError("Unsupported desktop event");
}

export function parseDesktopEventEnvelope(value: unknown): DesktopEventEnvelope {
  assertDesktopJsonValue(value, "Desktop event envelope");
  const record = requireRecord(value, "Desktop event envelope");
  assertOnlyKeys(record, ["version", "streamId", "sequence", "event"]);
  if (record.version !== 1) throw new TypeError("Unsupported desktop event envelope version");
  return {
    version: 1,
    streamId: requireIdentifier(record.streamId, "streamId"),
    sequence: requirePositiveInteger(record.sequence, "sequence"),
    event: parseDesktopEvent(record.event),
  };
}

export function parseDesktopEventAck(value: unknown): DesktopEventAck {
  const record = requireRecord(value, "Desktop event ACK");
  assertOnlyKeys(record, ["version", "streamId", "sequence"]);
  if (record.version !== 1) throw new TypeError("Unsupported desktop event ACK version");
  return {
    version: 1,
    streamId: requireIdentifier(record.streamId, "streamId"),
    sequence: requirePositiveInteger(record.sequence, "sequence"),
  };
}

export function parseDesktopEventReady(value: unknown): DesktopEventReady {
  const record = requireRecord(value, "Desktop event ready response");
  assertOnlyKeys(record, ["version", "streamId"]);
  if (record.version !== 1) throw new TypeError("Unsupported desktop event ready version");
  return { version: 1, streamId: requireIdentifier(record.streamId, "streamId") };
}

export function parseDesktopResponse<Request extends DesktopRequest>(
  request: Request,
  value: unknown,
): DesktopResponse<Request> {
  assertDesktopJsonValue(value, "Desktop response");
  let response: unknown;
  if (request.type === "reading.get" || request.type === "reading.set") {
    const record = requireRecord(value, "reading preferences");
    assertOnlyKeys(record, ["expandWork"]);
    response = { expandWork: requireBoolean(record.expandWork, "expandWork") };
  } else if (request.type === "appearance.get" || request.type === "appearance.set") {
    const record = requireRecord(value, "appearance response");
    assertOnlyKeys(record, ["theme"]);
    response = { theme: requireEnum(record.theme, ["system", "dark", "light"], "theme") };
  } else if (request.type === "app.state" || request.type === "workspace.select" || request.type === "workspace.activate") {
    response = parseDesktopState(value);
  } else if (request.type === "sessions.list") {
    if (!Array.isArray(value) || value.length > 10_000) throw new TypeError("Invalid session list");
    response = value.map((item) => parseSessionSummary(item));
  } else if (request.type === "sessions.create") {
    response = parseCreateSessionResult(value);
  } else if (request.type === "models.list") {
    if (!Array.isArray(value) || value.length > 1_000) throw new TypeError("Invalid model list");
    response = value.map((item, index) => parseRuntimeModelDescriptor(item, `models[${index}]`));
  } else if (request.type === "session.snapshot" || request.type === "session.resume") {
    response = parseRuntimeSnapshot(value);
  } else if (request.type === "session.rename") {
    response = parseSessionSummary(value);
  } else if (request.type === "session.archive") {
    const record = requireRecord(value, "archive response");
    assertOnlyKeys(record, ["archived"]);
    response = { archived: requireBoolean(record.archived, "archived") };
  } else if (request.type === "session.config.get") {
    response = parseDesktopSessionConfig(value);
  } else if (
    request.type === "session.model.set"
    || request.type === "session.reasoning.set"
    || request.type === "session.service-tier.set"
  ) {
    response = parseRuntimeModelConfig(value, "model config");
  } else if (request.type === "permissions.get" || request.type === "permissions.set") {
    response = parseRuntimePermissionConfig(value, "permission config");
  } else if (request.type === "session.delegation.get" || request.type === "session.delegation.set") {
    response = parseRuntimeDelegationConfig(value, "delegation config");
  } else if (request.type === "mcp.status") {
    response = parseRuntimeMcpStatus(value, "MCP status");
  } else if (request.type === "mcp.reload") {
    response = parseRuntimeMcpReload(value, "MCP reload");
  } else if (request.type === "session.send") {
    const record = requireRecord(value, "send response");
    if (record.status !== "accepted" && record.status !== "queued") throw new TypeError("Invalid send status");
    const result: DesktopResponseMap["session.send"] = { status: record.status };
    if (record.position !== undefined) result.position = requireNonNegativeInteger(record.position, "position");
    response = result;
  } else if (request.type === "session.stop") {
    response = { interrupted: requireBoolean(requireRecord(value, "stop response").interrupted, "interrupted") };
  } else if (request.type === "agent.send" || request.type === "agent.stop" || request.type === "agent.resume") {
    const record = requireRecord(value, "agent response");
    assertOnlyKeys(record, request.type === "agent.stop" ? ["agentId"] : ["agentId", "inputId"]);
    response = {
      agentId: requireIdentifier(record.agentId, "agentId"),
      ...(request.type === "agent.send" || record.inputId !== undefined ? { inputId: requireIdentifier(record.inputId, "inputId") } : {}),
    };
  } else if (request.type === "approval.resolve" || request.type === "user-input.resolve") {
    response = { resolved: requireBoolean(requireRecord(value, "resolve response").resolved, "resolved") };
  } else if (request.type === "events.resync.complete") {
    const status = requireRecord(value, "resync completion response").status;
    if (status !== "completed" && status !== "retry") throw new TypeError("Invalid resync completion status");
    response = { status };
  } else if (request.type === "diff.get") {
    const record = requireRecord(value, "diff response");
    if (record.scope !== "turn" && record.scope !== "workspace") throw new TypeError("Invalid diff scope");
    response = {
      scope: record.scope,
      text: requireString(record.text, "diff text", 600_000, true),
      truncated: requireBoolean(record.truncated, "truncated"),
    };
  } else {
    throw new TypeError("Unsupported desktop response");
  }
  assertDesktopResponseScope(request, response);
  return response as DesktopResponse<Request>;
}

export function parseDesktopInvokeResponse<Request extends DesktopRequest>(
  request: Request,
  value: unknown,
): DesktopResponse<Request> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)
    && "__chiliDesktopInvoke" in value) {
    const record = value as Record<string, unknown>;
    assertOnlyKeys(record, ["__chiliDesktopInvoke"]);
    if (record.__chiliDesktopInvoke !== "closing") {
      throw new TypeError("Invalid desktop invoke lifecycle response");
    }
    throw new Error("Desktop is closing");
  }
  return parseDesktopResponse(request, value);
}

function assertDesktopResponseScope(request: DesktopRequest, response: unknown): void {
  if (request.type === "agent.send" || request.type === "agent.stop" || request.type === "agent.resume") {
    if ((response as { agentId: string }).agentId !== request.agentId) throw new TypeError("Agent response belongs to a different agentId");
    return;
  }
  if (request.type === "session.snapshot" || request.type === "session.resume") {
    requireMatchingSessionId(request.sessionId, (response as RuntimeSnapshot).sessionId, "snapshot.sessionId");
    return;
  }
  if (request.type === "session.rename") {
    requireMatchingSessionId(request.sessionId, String((response as RuntimeSessionSummary).id), "session.id");
    return;
  }
  if (request.type === "session.config.get") {
    const config = response as DesktopSessionConfig;
    requireMatchingSessionId(request.sessionId, String(config.model.sessionId), "model.sessionId");
    requireMatchingSessionId(request.sessionId, String(config.delegation.sessionId), "delegation.sessionId");
    return;
  }
  if (
    request.type === "session.model.set"
    || request.type === "session.reasoning.set"
    || request.type === "session.service-tier.set"
  ) {
    requireMatchingSessionId(request.sessionId, String((response as RuntimeModelConfig).sessionId), "model.sessionId");
    return;
  }
  if (request.type === "session.delegation.get" || request.type === "session.delegation.set") {
    requireMatchingSessionId(
      request.sessionId,
      String((response as RuntimeDelegationConfig).sessionId),
      "delegation.sessionId",
    );
    return;
  }
}

function requireMatchingSessionId(expected: string, actual: string, field: string): void {
  if (expected !== actual) throw new TypeError(`${field} does not match the requested session`);
}

export function parseDesktopState(value: unknown): DesktopState {
  const record = requireRecord(value, "Desktop state");
  const sidecar = requireRecord(record.sidecar, "sidecar");
  const phase = sidecar.phase;
  if (phase !== "idle" && phase !== "starting" && phase !== "healthy" && phase !== "recovering" && phase !== "stopping" && phase !== "error") {
    throw new TypeError("Invalid sidecar phase");
  }
  if (typeof sidecar.attempt !== "number" || !Number.isSafeInteger(sidecar.attempt) || sidecar.attempt < 0) {
    throw new TypeError("Invalid sidecar attempt");
  }
  const queued = requireRecord(record.queuedBySession, "queuedBySession");
  const queuedEntries: Array<[string, number]> = [];
  for (const [rawSessionId, count] of Object.entries(queued)) {
    const sessionId = requireSafeMapKey(rawSessionId, "queued session id");
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new TypeError("Invalid queued count");
    queuedEntries.push([sessionId, count]);
  }
  const queuedBySession = Object.fromEntries(queuedEntries) as Record<string, number>;
  const state: DesktopState = { sidecar: { phase, attempt: sidecar.attempt }, queuedBySession };
  if (record.projectId !== undefined) state.projectId = requireProjectId(record.projectId, "projectId");
  if (record.projects !== undefined) {
    if (!Array.isArray(record.projects) || record.projects.length > 64) throw new TypeError("Invalid project list");
    state.projects = record.projects.map((value) => {
      const project = requireRecord(value, "project");
      assertOnlyKeys(project, ["id", "path", "phase", "runningCount", "attentionCount", "tasksLoaded", "recentTasks"]);
      if (!Array.isArray(project.recentTasks) || project.recentTasks.length > 8) throw new TypeError("Invalid project tasks");
      return {
        id: requireProjectId(project.id, "project.id"),
        path: requireString(project.path, "project.path", 16_384),
        phase: requireEnum(project.phase, ["idle", "starting", "healthy", "recovering", "stopping", "error"], "project.phase") as SidecarPhase,
        runningCount: requireNonNegativeInteger(project.runningCount, "project.runningCount"),
        attentionCount: requireNonNegativeInteger(project.attentionCount, "project.attentionCount"),
        tasksLoaded: requireBoolean(project.tasksLoaded, "project.tasksLoaded"),
        recentTasks: project.recentTasks.map((value) => {
          const task = requireRecord(value, "project task");
          assertOnlyKeys(task, ["id", "title", "status", "updatedAt"]);
          return { id: requireIdentifier(task.id, "task.id"), title: requireString(task.title, "task.title", 160),
            status: requireEnum(task.status, ["active", "archived"], "task.status") as "active" | "archived",
            updatedAt: requireNonNegativeInteger(task.updatedAt, "task.updatedAt") };
        }),
      };
    });
    if (new Set(state.projects.map((project) => project.id)).size !== state.projects.length) throw new TypeError("Duplicate projects");
    if (state.projectId && !state.projects.some((project) => project.id === state.projectId && project.path === record.workspace)) {
      throw new TypeError("Active project does not match the workspace");
    }
  }
  if (record.workspace !== undefined) state.workspace = requireString(record.workspace, "workspace", 16_384);
  if (sidecar.error !== undefined) state.sidecar.error = requireString(sidecar.error, "sidecar.error", 8_000);
  return state;
}

function parseRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  const record = requireRecord(value, "runtime snapshot");
  assertOnlyKeys(record, ["sessionId", "events", "agents", "pendingApprovals", "pendingInputs", "inputQueue", "omittedMessageParts", "truncated", "warning"]);
  if (!Array.isArray(record.events) || record.events.length > 20_000) throw new TypeError("Invalid snapshot events");
  if (!Array.isArray(record.agents) || record.agents.length > 2_000) throw new TypeError("Invalid snapshot agents");
  if (!Array.isArray(record.pendingApprovals) || record.pendingApprovals.length > 2_000) {
    throw new TypeError("Invalid pending approvals");
  }
  if (desktopJsonUtf8Bytes(record.pendingApprovals) > MAX_PENDING_APPROVAL_BYTES) {
    throw new TypeError("Pending approvals exceed the JSON byte budget");
  }
  if (!Array.isArray(record.pendingInputs) || record.pendingInputs.length > 2_000) throw new TypeError("Invalid pending inputs");
  const snapshot: RuntimeSnapshot = {
    sessionId: requireIdentifier(record.sessionId, "sessionId"),
    events: record.events.map((event) => parseRuntimeEvent(event)),
    agents: record.agents.map((agent) => parseAgentRecord(agent)),
    pendingApprovals: record.pendingApprovals.map((approval) => parsePendingApprovalRequest(approval)),
    pendingInputs: record.pendingInputs.map((input) => parseUserInputRequest(input)),
  };
  if (record.inputQueue !== undefined) {
    snapshot.inputQueue = parseRuntimeInputQueue(record.inputQueue);
    requireMatchingSessionId(snapshot.sessionId, snapshot.inputQueue.sessionId, "snapshot.inputQueue.sessionId");
    assertInputQueueIdentifiers(snapshot.inputQueue);
  }
  if (record.truncated !== undefined) snapshot.truncated = requireBoolean(record.truncated, "snapshot.truncated");
  if (record.warning !== undefined) snapshot.warning = requireString(record.warning, "snapshot.warning", 2_000);
  return snapshot;
}

function parsePendingApprovalRequest(value: unknown): RuntimePendingApprovalRequest {
  if (desktopJsonUtf8Bytes(value) > MAX_PENDING_APPROVAL_ROW_BYTES) {
    throw new TypeError("Pending approval exceeds the JSON byte budget");
  }
  const approval = requireRecord(value, "pending approval");
  const patterns = approval.patterns;
  if (!Array.isArray(patterns) || patterns.length > 64) {
    throw new TypeError("pending approval patterns must be an array of at most 64 strings");
  }
  const parsed: RuntimePendingApprovalRequest = {
    id: requireIdentifier(approval.id, "pending approval.id"),
    permission: requireString(approval.permission, "pending approval.permission", 512),
    patterns: patterns.map((pattern) => requireString(pattern, "pending approval.pattern", 2_000, true)),
    createdAt: requireFiniteNumber(approval.createdAt, "pending approval.createdAt"),
  };
  if (approval.sessionId !== undefined) {
    parsed.sessionId = requireIdentifier(approval.sessionId, "pending approval.sessionId") as never;
  }
  if (approval.callId !== undefined) {
    parsed.callId = requireIdentifier(approval.callId, "pending approval.callId");
  }
  if (approval.maxApprovalScope !== undefined) {
    parsed.maxApprovalScope = requireEnum(
      approval.maxApprovalScope,
      ["once", "session", "persistent"],
      "pending approval.maxApprovalScope",
    ) as NonNullable<RuntimePendingApprovalRequest["maxApprovalScope"]>;
  }
  if (approval.metadata !== undefined) {
    const metadata = requireRecord(approval.metadata, "pending approval.metadata");
    assertJsonValue(metadata, "pending approval.metadata", 0, { remaining: 64_000 });
    parsed.metadata = metadata;
  }
  return parsed;
}

function parseRuntimeEvent(value: unknown): ChiliEvent {
  const event = requireRecord(value, "runtime event");
  requireIdentifier(event.id, "event.id");
  const type = requireString(event.type, "event.type", 200);
  if (typeof event.time !== "number" || !Number.isFinite(event.time) || event.time < 0) throw new TypeError("Invalid event time");
  const payload = requireRecord(event.payload, "event.payload");
  if (event.sessionId !== undefined) requireIdentifier(event.sessionId, "event.sessionId");
  assertJsonValue(payload, "event.payload", 0);
  if (type === "session.created" || type === "session.input_queue_changed") {
    const parsed = parseChiliEvent(value);
    assertRuntimePayloadIdentifiers(type, payload);
    if (parsed.type === "session.created" && parsed.payload.agent) {
      requireIdentifier(parsed.payload.agent.parentSessionId, "event.payload.agent.parentSessionId");
    }
    if (parsed.type === "session.input_queue_changed") assertInputQueueIdentifiers(parsed.payload);
    return parsed;
  }
  if (type === "model.request_prepared" || type === "model.request_identity" || type === "session.identity_bound") {
    return parseChiliEvent(value);
  }
  if (type === "message.part_stream_delta" || type === "message.part_stream_snapshot" || type === "message.part_committed") {
    const parsed = parseChiliEvent(value);
    assertRuntimePayloadIdentifiers(type, payload);
    if (type !== "message.part_stream_delta") {
      assertMessagePartIdentifiers(requireRecord(payload.part, "event.payload.part"), "event.payload.part");
    }
    return parsed;
  }
  assertRuntimePayloadSchema(type, payload);
  assertRuntimePayloadIdentifiers(type, payload);
  if (type === "message.part_added") {
    assertMessagePartIdentifiers(requireRecord(payload.part, "event.payload.part"), "event.payload.part");
  }
  if (type === "user_input.requested") {
    const questions = payload.questions;
    if (Array.isArray(questions)) {
      for (const [index, question] of questions.entries()) {
        requireIdentifier(requireRecord(question, `event.payload.questions[${index}]`).id, `event.payload.questions[${index}].id`);
      }
    }
  }
  if (type === "user_input.resolved") {
    const answers = requireRecord(payload.answers, "event.payload.answers");
    for (const questionId of Object.keys(answers)) requireSafeMapKey(questionId, "event.payload answer key");
  }
  return value as ChiliEvent;
}

function parseSessionSummary(value: unknown): RuntimeSessionSummary {
  const record = requireRecord(value, "session summary");
  if (record.status !== "active" && record.status !== "archived") throw new TypeError("Invalid session lifecycle");
  const summary: RuntimeSessionSummary = {
    id: requireIdentifier(record.id, "session id") as RuntimeSessionSummary["id"],
    cwd: requireString(record.cwd, "session cwd", 16_384),
    status: record.status,
    createdAt: requireFiniteNumber(record.createdAt, "createdAt"),
    updatedAt: requireFiniteNumber(record.updatedAt, "updatedAt"),
  };
  if (record.title !== undefined) summary.title = requireString(record.title, "title", 2_000, true);
  if (record.preview !== undefined) summary.preview = requireString(record.preview, "preview", 20_000, true);
  if (record.agent !== undefined) {
    summary.agent = parseSessionAgentMetadata(record.agent, "session agent");
    requireIdentifier(summary.agent.parentSessionId, "session agent.parentSessionId");
  }
  return summary;
}

function parseCreateSessionResult(value: unknown): DesktopCreateSessionResult {
  const record = requireRecord(value, "create session response");
  assertOnlyKeys(record, ["sessionId", "status", "startState", "started", "failure"]);
  const status = requireEnum(record.status, ["created", "started", "partial"], "status") as DesktopCreateSessionResult["status"];
  const startState = requireEnum(
    record.startState,
    ["not_started", "started", "unknown"],
    "startState",
  ) as DesktopCreateSessionResult["startState"];
  const started = requireBoolean(record.started, "started");
  if (started !== (startState === "started")) {
    throw new TypeError("Create session started is inconsistent with startState");
  }
  if (
    (status === "created" && startState !== "not_started")
    || (status === "started" && startState !== "started")
    || (status === "partial" && startState === "started")
  ) {
    throw new TypeError("Create session status is inconsistent with started");
  }
  const result: DesktopCreateSessionResult = {
    sessionId: requireIdentifier(record.sessionId, "sessionId"),
    status,
    startState,
    started,
  };
  if (record.failure !== undefined) {
    const failure = requireRecord(record.failure, "failure");
    assertOnlyKeys(failure, ["stage", "message", "permissionRestored", "launchMayHaveCommitted"]);
    result.failure = {
      stage: requireEnum(
        failure.stage,
        ["rename", "model", "reasoning", "service_tier", "delegation", "permission", "prompt"],
        "failure.stage",
      ) as DesktopCreateSessionStage,
      message: requireString(failure.message, "failure.message", 8_000),
    };
    if (failure.permissionRestored !== undefined) {
      result.failure.permissionRestored = requireBoolean(failure.permissionRestored, "failure.permissionRestored");
    }
    if (failure.launchMayHaveCommitted !== undefined) {
      result.failure.launchMayHaveCommitted = requireBoolean(
        failure.launchMayHaveCommitted,
        "failure.launchMayHaveCommitted",
      );
    }
  }
  if (status === "partial" && !result.failure) throw new TypeError("Partial create response requires failure details");
  if (status !== "partial" && result.failure) throw new TypeError("Only a partial create response can contain failure details");
  if (startState === "unknown" && result.failure?.launchMayHaveCommitted !== true) {
    throw new TypeError("Unknown launch state must identify a possibly committed launch");
  }
  if (startState !== "unknown" && result.failure?.launchMayHaveCommitted === true) {
    throw new TypeError("Possibly committed launch requires unknown startState");
  }
  return result;
}

function parseDesktopSessionConfig(value: unknown): DesktopSessionConfig {
  const record = requireRecord(value, "session config");
  assertOnlyKeys(record, ["model", "permission", "delegation", "mcp"]);
  return {
    model: parseRuntimeModelConfig(record.model, "session config.model"),
    permission: parseRuntimePermissionConfig(record.permission, "session config.permission"),
    delegation: parseRuntimeDelegationConfig(record.delegation, "session config.delegation"),
    mcp: parseRuntimeMcpStatus(record.mcp, "session config.mcp"),
  };
}

function parseRuntimeModelConfig(value: unknown, field: string): RuntimeModelConfig {
  const record = requireRecord(value, field);
  if (!Array.isArray(record.models) || record.models.length > 1_000) {
    throw new TypeError(`${field}.models must be an array of at most 1000 models`);
  }
  const parsed = parseProtocolModelConfig(value, field);
  requireIdentifier(parsed.sessionId, `${field}.sessionId`);
  return parsed;
}

function parseRuntimeModelDescriptor(value: unknown, field: string): RuntimeModelDescriptor {
  return parseProtocolModelDescriptor(value, field);
}

function parseRuntimePermissionConfig(value: unknown, field: string): RuntimePermissionConfig {
  const record = requireRecord(value, field);
  if (!Array.isArray(record.profiles) || record.profiles.length === 0 || record.profiles.length > 16) {
    throw new TypeError(`${field}.profiles must contain between 1 and 16 profiles`);
  }
  const parsed = parseProtocolPermissionConfig(value, field);
  const current = parsed.profiles.filter((candidate) => candidate.current);
  if (current.length !== 1 || current[0]?.id !== parsed.profile) {
    throw new TypeError(`${field} has inconsistent current profile metadata`);
  }
  return parsed;
}

function parseRuntimeDelegationConfig(value: unknown, field: string): RuntimeDelegationConfig {
  const parsed = parseProtocolDelegationConfig(value, field);
  requireIdentifier(parsed.sessionId, `${field}.sessionId`);
  return parsed;
}

function parseRuntimeMcpStatus(value: unknown, field: string): RuntimeMcpStatusResponse {
  const record = requireRecord(value, field);
  if (!Array.isArray(record.servers) || record.servers.length > 1_000) {
    throw new TypeError(`${field}.servers must be an array of at most 1000 servers`);
  }
  const parsed = parseProtocolMcpStatusResponse(value, field);
  if (
    parsed.summary.running + parsed.summary.disabled + parsed.summary.authRequired + parsed.summary.errored
    > parsed.summary.total
  ) throw new TypeError(`${field}.summary counts exceed total`);
  return parsed;
}

function parseRuntimeMcpReload(value: unknown, field: string): RuntimeMcpReloadResponse {
  const record = requireRecord(value, field);
  if (!Array.isArray(record.servers) || record.servers.length > 1_000) {
    throw new TypeError(`${field}.servers must be an array of at most 1000 servers`);
  }
  if (!Array.isArray(record.errors) || record.errors.length > 1_000) {
    throw new TypeError(`${field}.errors must be an array of at most 1000 errors`);
  }
  return parseProtocolMcpReloadResponse(value, field);
}

function parseAgentRecord(value: unknown): RuntimeAgentRecord {
  const agent = requireRecord(value, "agent");
  assertOnlyKeys(agent, ["agentId", "name", "path", "parentAgentId", "state"]);
  return {
    agentId: requireIdentifier(agent.agentId, "agent.agentId"),
    name: requireString(agent.name, "agent.name", 2_000),
    path: requireString(agent.path, "agent.path", 4_096),
    state: requireEnum(agent.state, ["idle", "running", "paused"], "agent.state") as RuntimeAgentRecord["state"],
    ...(agent.parentAgentId !== undefined ? { parentAgentId: requireIdentifier(agent.parentAgentId, "agent.parentAgentId") } : {}),
  };
}

function parseUserInputRequest(value: unknown): UserInputRequest {
  const input = requireRecord(value, "user input request");
  if (!Array.isArray(input.questions) || input.questions.length === 0 || input.questions.length > 3) {
    throw new TypeError("Invalid user input questions");
  }
  return {
    id: requireIdentifier(input.id, "input.id"),
    sessionId: requireIdentifier(input.sessionId, "input.sessionId"),
    callId: requireIdentifier(input.callId, "input.callId"),
    questions: input.questions.map((question) => parseUserInputQuestion(question)),
    createdAt: requireFiniteNumber(input.createdAt, "input.createdAt"),
  };
}

function parseUserInputQuestion(value: unknown): UserInputQuestion {
  const question = requireRecord(value, "user input question");
  if (!Array.isArray(question.options) || question.options.length > 3) throw new TypeError("Invalid question options");
  const parsed: UserInputQuestion = {
    id: requireSafeMapKey(question.id, "question.id"),
    header: requireString(question.header, "question.header", 80),
    question: requireString(question.question, "question.question", 2_000),
    options: question.options.map((option) => {
      const item = requireRecord(option, "question option");
      const result: UserInputChoice = { label: requireString(item.label, "option.label", 200) };
      if (item.description !== undefined) result.description = requireString(item.description, "option.description", 2_000, true);
      return result;
    }),
  };
  if (question.multiple !== undefined) parsed.multiple = requireBoolean(question.multiple, "question.multiple");
  return parsed;
}

function requestKeys(type: string): readonly string[] {
  if (type === "workspace.activate") return ["type", "id"];
  if (type === "reading.get") return ["type"];
  if (type === "reading.set") return ["type", "expandWork"];
  if (type === "appearance.get") return ["type"];
  if (type === "appearance.set") return ["type", "theme"];
  if (type === "app.state" || type === "workspace.select" || type === "permissions.get") return ["type"];
  if (type === "sessions.list") return ["type", "query", "status"];
  if (type === "sessions.create") {
    return [
      "type",
      "title",
      "prompt",
      "modelSelection",
      "reasoningLevel",
      "serviceTier",
      "permissionProfile",
      "delegationPolicy",
    ];
  }
  if (type === "models.list") return ["type", "provider"];
  if (
    type === "session.snapshot"
    || type === "session.resume"
    || type === "session.stop"
    || type === "session.archive"
    || type === "session.config.get"
    || type === "session.delegation.get"
  ) return ["type", "sessionId"];
  if (type === "session.rename") return ["type", "sessionId", "title"];
  if (type === "session.model.set") return ["type", "sessionId", "modelSelection"];
  if (type === "session.reasoning.set") return ["type", "sessionId", "reasoningLevel"];
  if (type === "session.service-tier.set") return ["type", "sessionId", "serviceTier"];
  if (type === "permissions.set") return ["type", "profile"];
  if (type === "session.delegation.set") return ["type", "sessionId", "policy"];
  if (type === "mcp.status" || type === "mcp.reload") return ["type", "sessionId"];
  if (type === "session.send") return ["type", "sessionId", "text", "mode", "submissionId"];
  if (type === "agent.send") return ["type", "sessionId", "agentId", "text", "mode"];
  if (type === "agent.stop" || type === "agent.resume") return ["type", "sessionId", "agentId"];
  if (type === "approval.resolve") return ["type", "approvalId", "decision", "feedback"];
  if (type === "user-input.resolve") return ["type", "inputId", "answers"];
  if (type === "events.resync.complete") return ["type", "barrierId"];
  if (type === "diff.get") return ["type", "scope", "sessionId", "turnId"];
  return ["type"];
}

export function desktopJsonUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Value is not JSON serializable");
  return new TextEncoder().encode(serialized).byteLength;
}

function assertDesktopJsonValue(value: unknown, field: string): void {
  assertJsonValue(value, field, 0, { remaining: MAX_DESKTOP_JSON_BYTES });
  if (desktopJsonUtf8Bytes(value) > MAX_DESKTOP_JSON_BYTES) {
    throw new TypeError(`${field} exceeds the JSON byte budget`);
  }
}

function requireResyncReason(value: unknown): DesktopResyncReason {
  if (value === "renderer_ready" || value === "source_cursor" || value === "outbox_overflow"
    || value === "ack_timeout" || value === "sequence_gap" || value === "delivery_error") return value;
  throw new TypeError("Invalid desktop resync reason");
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const text = value.trim();
  if (!allowEmpty && text.length === 0) throw new TypeError(`${field} must not be empty`);
  if (value.length > max) throw new TypeError(`${field} exceeds ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new TypeError(`${field} contains control characters`);
  return allowEmpty ? value : text;
}

function requireProjectId(value: unknown, field: string): string {
  const id = requireIdentifier(value, field);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new TypeError(`Invalid ${field}`);
  return id;
}

function requireIdentifier(value: unknown, field: string): string {
  return requireSafeMapKey(value, field);
}

function requireSafeMapKey(value: unknown, field: string): string {
  const key = requireString(value, field, 512);
  if (key === "__proto__" || key === "prototype" || key === "constructor") {
    throw new TypeError(`${field} must not use a prototype property name`);
  }
  return key;
}

function assertRuntimePayloadSchema(type: string, payload: Record<string, unknown>): void {
  if (type === "session.input_queue_changed") {
    parseRuntimeInputQueue(payload);
    return;
  }
  if (type === "session.created") {
    requirePayloadString(payload.sessionId, "event.payload.sessionId");
    requirePayloadString(payload.cwd, "event.payload.cwd", true);
    if (payload.identity !== undefined) parseRuntimeExecutionIdentity(payload.identity, "event.payload.identity");
    return;
  }
  if (type === "session.renamed") {
    requirePayloadString(payload.sessionId, "event.payload.sessionId");
    requirePayloadString(payload.title, "event.payload.title", true);
    return;
  }
  if (type === "session.status_changed") {
    requirePayloadString(payload.sessionId, "event.payload.sessionId");
    requireEnum(payload.status, ["idle", "running", "waiting_for_approval", "cancelling", "cancelled", "failed"], "event.payload.status");
    optionalPayloadString(payload.turnId, "event.payload.turnId");
    optionalPayloadString(payload.reason, "event.payload.reason", true);
    return;
  }
  if (type === "session.model_changed") {
    requirePayloadString(payload.sessionId, "event.payload.sessionId");
    assertModelSelection(requireRecord(payload.modelSelection, "event.payload.modelSelection"), "event.payload.modelSelection");
    return;
  }
  if (type === "session.reasoning_changed") {
    requirePayloadString(payload.sessionId, "event.payload.sessionId");
    requireEnum(payload.reasoningLevel, ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], "event.payload.reasoningLevel");
    return;
  }
  if (type === "session.service_tier_changed") {
    requirePayloadString(payload.sessionId, "event.payload.sessionId");
    requireEnum(payload.serviceTier, ["standard", "fast"], "event.payload.serviceTier");
    return;
  }
  if (type === "session.delegation_changed") {
    requirePayloadString(payload.sessionId, "event.payload.sessionId");
    requireEnum(payload.policy, ["off", "explicit", "proactive"], "event.payload.policy");
    return;
  }
  if (type === "session.archived") {
    requirePayloadString(payload.sessionId, "event.payload.sessionId");
    return;
  }

  if (type === "turn.started") {
    requirePayloadString(payload.turnId, "event.payload.turnId");
    return;
  }
  if (type === "turn.model_metadata") {
    requirePayloadString(payload.turnId, "event.payload.turnId");
    optionalPayloadString(payload.provider, "event.payload.provider", true);
    optionalPayloadString(payload.model, "event.payload.model", true);
    optionalPayloadString(payload.responseId, "event.payload.responseId", true);
    optionalNonNegativeNumber(payload.contextWindowTokens, "event.payload.contextWindowTokens");
    optionalNonNegativeNumber(payload.maxOutputTokens, "event.payload.maxOutputTokens");
    if (payload.usage !== undefined) assertModelUsage(requireRecord(payload.usage, "event.payload.usage"));
    return;
  }
  if (type === "turn.completed") {
    requirePayloadString(payload.turnId, "event.payload.turnId");
    requireEnum(payload.status, ["completed", "failed", "cancelled"], "event.payload.status");
    return;
  }
  if (type === "turn.compaction_requested" || type === "turn.compaction_started" || type === "turn.compaction_failed") {
    requirePayloadString(payload.turnId, "event.payload.turnId");
    requireEnum(payload.reason, ["manual", "token_budget", "recovery"], "event.payload.reason");
    optionalPayloadString(payload.boundaryMessageId, "event.payload.boundaryMessageId");
    optionalNonNegativeNumber(payload.sourceMessageCount, "event.payload.sourceMessageCount");
    optionalNonNegativeNumber(payload.estimatedChars, "event.payload.estimatedChars");
    optionalNonNegativeNumber(payload.budgetChars, "event.payload.budgetChars");
    if (type === "turn.compaction_failed") requirePayloadString(payload.error, "event.payload.error", true);
    return;
  }
  if (type === "turn.compaction_completed") {
    requirePayloadString(payload.turnId, "event.payload.turnId");
    requirePayloadString(payload.messageId, "event.payload.messageId");
    requirePayloadString(payload.boundaryMessageId, "event.payload.boundaryMessageId");
    requireNonNegativeNumber(payload.summaryChars, "event.payload.summaryChars");
    requireNonNegativeNumber(payload.sourceMessageCount, "event.payload.sourceMessageCount");
    requireNonNegativeNumber(payload.estimatedCharsBefore, "event.payload.estimatedCharsBefore");
    requireNonNegativeNumber(payload.estimatedCharsAfter, "event.payload.estimatedCharsAfter");
    return;
  }
  if (type === "turn.retry_scheduled") {
    requirePayloadString(payload.turnId, "event.payload.turnId");
    requireNonNegativeNumber(payload.attempt, "event.payload.attempt");
    requireNonNegativeNumber(payload.delayMs, "event.payload.delayMs");
    requirePayloadString(payload.reason, "event.payload.reason", true);
    return;
  }
  if (type === "turn.guard_triggered") {
    requirePayloadString(payload.turnId, "event.payload.turnId");
    requireEnum(payload.reason, ["repeated_tool_call", "tool_call_limit"], "event.payload.reason");
    optionalPayloadString(payload.toolName, "event.payload.toolName", true);
    requireNonNegativeNumber(payload.count, "event.payload.count");
    return;
  }

  if (type === "message.created") {
    requirePayloadString(payload.messageId, "event.payload.messageId");
    requireEnum(payload.role, ["system", "user", "assistant", "tool"], "event.payload.role");
    optionalPayloadString(payload.turnId, "event.payload.turnId");
    return;
  }
  if (type === "message.part_added") {
    requirePayloadString(payload.messageId, "event.payload.messageId");
    assertMessagePartSchema(requireRecord(payload.part, "event.payload.part"), "event.payload.part");
    return;
  }
  if (type === "message.part_delta") {
    requirePayloadString(payload.messageId, "event.payload.messageId");
    requirePayloadString(payload.partId, "event.payload.partId");
    requirePayloadString(payload.field, "event.payload.field");
    requirePayloadString(payload.delta, "event.payload.delta", true);
    return;
  }

  if (type === "tool.call_started") {
    requirePayloadString(payload.turnId, "event.payload.turnId");
    requirePayloadString(payload.callId, "event.payload.callId");
    requirePayloadString(payload.toolName, "event.payload.toolName");
    requireOwnField(payload, "input", "event.payload");
    return;
  }
  if (type === "tool.call_updated") {
    requirePayloadString(payload.callId, "event.payload.callId");
    requireToolCallStatus(payload.status, "event.payload.status");
    optionalPayloadString(payload.toolName, "event.payload.toolName", true);
    if (payload.metadata !== undefined) requireRecord(payload.metadata, "event.payload.metadata");
    return;
  }
  if (type === "tool.output_delta") {
    requirePayloadString(payload.callId, "event.payload.callId");
    requireEnum(payload.stream, ["stdout", "stderr"], "event.payload.stream");
    requirePayloadString(payload.delta, "event.payload.delta", true);
    optionalNonNegativeNumber(payload.bytes, "event.payload.bytes");
    optionalBoolean(payload.truncated, "event.payload.truncated");
    optionalNonNegativeNumber(payload.sequence, "event.payload.sequence");
    return;
  }
  if (type === "tool.call_finished") {
    requirePayloadString(payload.callId, "event.payload.callId");
    requireEnum(payload.status, ["completed", "failed", "cancelled"], "event.payload.status");
    optionalPayloadString(payload.output, "event.payload.output", true);
    optionalPayloadString(payload.error, "event.payload.error", true);
    optionalBoolean(payload.synthetic, "event.payload.synthetic");
    if (payload.errorDetails !== undefined) assertPersistedErrorDetails(requireRecord(payload.errorDetails, "event.payload.errorDetails"));
    return;
  }

  if (type === "approval.requested") {
    requirePayloadString(payload.approvalId, "event.payload.approvalId");
    optionalPayloadString(payload.callId, "event.payload.callId");
    requirePayloadString(payload.permission, "event.payload.permission", true);
    requirePayloadStringArray(payload.patterns, "event.payload.patterns", false);
    if (payload.maxApprovalScope !== undefined) requireEnum(payload.maxApprovalScope, ["once", "session", "persistent"], "event.payload.maxApprovalScope");
    if (payload.metadata !== undefined) requireRecord(payload.metadata, "event.payload.metadata");
    return;
  }
  if (type === "approval.resolved") {
    requirePayloadString(payload.approvalId, "event.payload.approvalId");
    requireEnum(payload.decision, ["allow_once", "allow_session", "allow_always", "deny"], "event.payload.decision");
    optionalPayloadString(payload.feedback, "event.payload.feedback", true);
    return;
  }

  if (type === "user_input.requested") {
    requirePayloadString(payload.inputId, "event.payload.inputId");
    requirePayloadString(payload.callId, "event.payload.callId");
    if (!Array.isArray(payload.questions) || payload.questions.length === 0 || payload.questions.length > 3) {
      throw new TypeError("event.payload.questions must contain between 1 and 3 items");
    }
    payload.questions.forEach((question) => parseUserInputQuestion(question));
    return;
  }
  if (type === "user_input.resolved") {
    requirePayloadString(payload.inputId, "event.payload.inputId");
    assertUserInputAnswers(payload.answers, "event.payload.answers");
    return;
  }
  if (type === "user_input.cancelled") {
    requirePayloadString(payload.inputId, "event.payload.inputId");
    optionalPayloadString(payload.reason, "event.payload.reason", true);
    return;
  }

  if (type === "snapshot.created") {
    requirePayloadString(payload.snapshotId, "event.payload.snapshotId");
    optionalPayloadString(payload.callId, "event.payload.callId");
    optionalPayloadString(payload.toolName, "event.payload.toolName", true);
    requirePayloadStringArray(payload.paths, "event.payload.paths", false);
    requirePayloadString(payload.reason, "event.payload.reason", true);
    return;
  }
  if (type === "snapshot.reverted") {
    requirePayloadString(payload.snapshotId, "event.payload.snapshotId");
    requireEnum(payload.status, ["completed", "failed"], "event.payload.status");
    requirePayloadStringArray(payload.paths, "event.payload.paths", false);
    optionalPayloadString(payload.error, "event.payload.error", true);
    return;
  }

  if (type.startsWith("mcp.")) {
    assertMcpEventPayload(type, payload);
    return;
  }
  throw new TypeError(`Unsupported runtime event type: ${type}`);
}

function assertMessagePartSchema(part: Record<string, unknown>, field: string): void {
  requirePayloadString(part.id, `${field}.id`);
  requirePayloadString(part.messageId, `${field}.messageId`);
  requirePayloadString(part.sessionId, `${field}.sessionId`);
  if (part.ordinal !== undefined) requireNonNegativeInteger(part.ordinal, `${field}.ordinal`);
  const type = requirePayloadString(part.type, `${field}.type`);
  if (type === "text") {
    requirePayloadString(part.text, `${field}.text`, true);
    if (part.completion !== undefined) requireEnum(part.completion, ["completed", "cancelled", "failed"], `${field}.completion`);
    if (part.phase !== undefined) requireEnum(part.phase, ["commentary", "final_answer"], `${field}.phase`);
    optionalPayloadString(part.displayText, `${field}.displayText`, true);
    optionalBoolean(part.synthetic, `${field}.synthetic`);
    return;
  }
  if (type === "image") {
    requirePayloadString(part.data, `${field}.data`, true);
    requirePayloadString(part.mimeType, `${field}.mimeType`);
    optionalPayloadString(part.filename, `${field}.filename`, true);
    optionalPayloadString(part.sourcePath, `${field}.sourcePath`, true);
    optionalPayloadString(part.displayText, `${field}.displayText`, true);
    return;
  }
  if (type === "reasoning") {
    requirePayloadString(part.text, `${field}.text`, true);
    if (part.completion !== undefined) requireEnum(part.completion, ["completed", "cancelled", "failed"], `${field}.completion`);
    optionalBoolean(part.redacted, `${field}.redacted`);
    if (part.modelOutput !== undefined) {
      const output = requireRecord(part.modelOutput, `${field}.modelOutput`);
      requirePayloadString(output.apiFamily, `${field}.modelOutput.apiFamily`);
      optionalNonNegativeNumber(output.outputIndex, `${field}.modelOutput.outputIndex`);
      requireRecord(output.item, `${field}.modelOutput.item`);
    }
    return;
  }
  if (type === "tool_call") {
    requirePayloadString(part.callId, `${field}.callId`);
    requirePayloadString(part.toolName, `${field}.toolName`);
    requireOwnField(part, "input", field);
    requireEnum(part.status, ["pending", "running", "completed", "failed", "cancelled"], `${field}.status`);
    return;
  }
  if (type === "tool_result") {
    requirePayloadString(part.callId, `${field}.callId`);
    requirePayloadString(part.output, `${field}.output`, true);
    optionalPayloadString(part.error, `${field}.error`, true);
    optionalBoolean(part.synthetic, `${field}.synthetic`);
    if (part.content !== undefined) assertToolResultContent(part.content, `${field}.content`);
    if (part.executionContext !== undefined) assertExecutionContext(requireRecord(part.executionContext, `${field}.executionContext`), `${field}.executionContext`);
    if (part.artifactIds !== undefined) requirePayloadStringArray(part.artifactIds, `${field}.artifactIds`, true);
    return;
  }
  if (type === "patch") {
    requirePayloadStringArray(part.files, `${field}.files`, false);
    optionalPayloadString(part.artifactId, `${field}.artifactId`);
    return;
  }
  if (type === "artifact") {
    requirePayloadString(part.artifactId, `${field}.artifactId`);
    return;
  }
  if (type === "compaction") {
    requirePayloadString(part.boundaryMessageId, `${field}.boundaryMessageId`);
    requireEnum(part.reason, ["manual", "token_budget", "recovery"], `${field}.reason`);
    optionalPayloadString(part.summary, `${field}.summary`, true);
    if (part.sourceMessageIds !== undefined) requirePayloadStringArray(part.sourceMessageIds, `${field}.sourceMessageIds`, true);
    optionalNonNegativeNumber(part.estimatedCharsBefore, `${field}.estimatedCharsBefore`);
    optionalNonNegativeNumber(part.estimatedCharsAfter, `${field}.estimatedCharsAfter`);
    return;
  }
  if (type === "agent_handoff") {
    requirePayloadString(part.agentPath, `${field}.agentPath`);
    requirePayloadString(part.summary, `${field}.summary`, true);
    return;
  }
  throw new TypeError(`Unsupported message part type: ${type}`);
}

function assertMcpEventPayload(type: string, payload: Record<string, unknown>): void {
  requirePayloadString(payload.serverName, "event.payload.serverName");
  if (type === "mcp.server_status_changed") {
    requireMcpStatus(payload.status, "event.payload.status");
    for (const key of ["toolCount", "promptCount", "resourceCount"] as const) requireNonNegativeNumber(payload[key], `event.payload.${key}`);
    if (payload.previousStatus !== undefined) requireMcpStatus(payload.previousStatus, "event.payload.previousStatus");
    for (const key of ["config", "auth", "capabilities", "error"] as const) {
      if (payload[key] !== undefined) requireRecord(payload[key], `event.payload.${key}`);
    }
    return;
  }
  if (type === "mcp.tools_changed" || type === "mcp.prompts_changed" || type === "mcp.resources_changed") {
    const arrayKey = type === "mcp.tools_changed" ? "tools" : type === "mcp.prompts_changed" ? "prompts" : "resources";
    const countKey = type === "mcp.tools_changed" ? "toolCount" : type === "mcp.prompts_changed" ? "promptCount" : "resourceCount";
    if (!Array.isArray(payload[arrayKey])) throw new TypeError(`event.payload.${arrayKey} must be an array`);
    for (const [index, item] of payload[arrayKey].entries()) {
      const record = requireRecord(item, `event.payload.${arrayKey}[${index}]`);
      requirePayloadString(record.serverName, `event.payload.${arrayKey}[${index}].serverName`);
      requirePayloadString(type === "mcp.resources_changed" ? record.uri : record.name, `event.payload.${arrayKey}[${index}].${type === "mcp.resources_changed" ? "uri" : "name"}`);
    }
    requireNonNegativeNumber(payload[countKey], `event.payload.${countKey}`);
    if (payload.status !== undefined) requireMcpStatus(payload.status, "event.payload.status");
    optionalPayloadString(payload.revision, "event.payload.revision", true);
    if (payload.error !== undefined) requireRecord(payload.error, "event.payload.error");
    return;
  }
  if (type === "mcp.diagnostic") {
    requireEnum(payload.level, ["debug", "info", "warning", "error"], "event.payload.level");
    requirePayloadString(payload.message, "event.payload.message", true);
    optionalPayloadString(payload.code, "event.payload.code", true);
    optionalPayloadString(payload.source, "event.payload.source", true);
    if (payload.status !== undefined) requireMcpStatus(payload.status, "event.payload.status");
    if (payload.error !== undefined) requireRecord(payload.error, "event.payload.error");
    if (payload.metadata !== undefined) requireRecord(payload.metadata, "event.payload.metadata");
    return;
  }
  if (type === "mcp.progress") {
    requireEnum(payload.operation, ["initialize", "connect", "authenticate", "list_tools", "list_prompts", "list_resources", "call_tool", "read_resource", "get_prompt", "shutdown"], "event.payload.operation");
    requireEnum(payload.status, ["started", "running", "completed", "failed", "cancelled"], "event.payload.status");
    for (const key of ["message", "operationId", "toolName", "resourceUri", "promptName"] as const) optionalPayloadString(payload[key], `event.payload.${key}`, true);
    optionalNonNegativeNumber(payload.completed, "event.payload.completed");
    optionalNonNegativeNumber(payload.total, "event.payload.total");
    if (payload.error !== undefined) requireRecord(payload.error, "event.payload.error");
    if (payload.metadata !== undefined) requireRecord(payload.metadata, "event.payload.metadata");
    return;
  }
  throw new TypeError(`Unsupported runtime event type: ${type}`);
}

function assertModelSelection(value: Record<string, unknown>, field: string): void {
  requirePayloadString(value.provider, `${field}.provider`);
  requirePayloadString(value.model, `${field}.model`);
}

function assertModelUsage(value: Record<string, unknown>): void {
  for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "totalTokens"] as const) {
    optionalNonNegativeNumber(value[key], `event.payload.usage.${key}`);
  }
  // usage.raw is provider-owned bounded JSON and intentionally opaque.
}

function assertPersistedErrorDetails(value: Record<string, unknown>): void {
  requirePayloadString(value.name, "event.payload.errorDetails.name");
  if (value.code !== undefined && typeof value.code !== "string" && typeof value.code !== "number") {
    throw new TypeError("event.payload.errorDetails.code must be a string or number");
  }
  if (typeof value.code === "number" && !Number.isFinite(value.code)) {
    throw new TypeError("event.payload.errorDetails.code must be finite");
  }
  if (value.truncated !== undefined && value.truncated !== true) {
    throw new TypeError("event.payload.errorDetails.truncated must be true when present");
  }
  optionalNonNegativeNumber(value.originalMessageBytes, "event.payload.errorDetails.originalMessageBytes");
}

function assertToolResultContent(value: unknown, field: string): void {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  for (const [index, item] of value.entries()) {
    const record = requireRecord(item, `${field}[${index}]`);
    if (record.type === "text") {
      requirePayloadString(record.text, `${field}[${index}].text`, true);
    } else if (record.type === "image") {
      requirePayloadString(record.data, `${field}[${index}].data`, true);
      requirePayloadString(record.mimeType, `${field}[${index}].mimeType`);
    } else {
      throw new TypeError(`${field}[${index}].type is unsupported`);
    }
  }
}

function assertExecutionContext(value: Record<string, unknown>, field: string): void {
  if (value.sandbox !== undefined) requireEnum(value.sandbox, ["macos-seatbelt", "none"], `${field}.sandbox`);
  if (value.executionMode !== undefined) requireEnum(value.executionMode, ["sandboxed", "unsandboxed"], `${field}.executionMode`);
  if (value.exitCode !== undefined && value.exitCode !== null) requireFiniteNumber(value.exitCode, `${field}.exitCode`);
  optionalBoolean(value.timedOut, `${field}.timedOut`);
  optionalBoolean(value.aborted, `${field}.aborted`);
  if (value.signal !== undefined && value.signal !== null) requirePayloadString(value.signal, `${field}.signal`, true);
}

function assertUserInputAnswers(value: unknown, field: string): void {
  const answers = requireRecord(value, field);
  const entries = Object.entries(answers);
  if (entries.length === 0 || entries.length > 3) throw new TypeError(`${field} must contain between 1 and 3 question ids`);
  for (const [questionId, answer] of entries) {
    requireSafeMapKey(questionId, `${field} key`);
    requirePayloadStringArray(answer, `${field}.${questionId}`, false);
  }
}

function requireToolCallStatus(value: unknown, field: string): void {
  requireEnum(value, ["pending", "validating", "waiting_for_approval", "running", "completed", "failed", "cancelled"], field);
}

function requireMcpStatus(value: unknown, field: string): void {
  requireEnum(value, ["disabled", "starting", "running", "stopping", "stopped", "failed", "auth_required"], field);
}

function requireEnum(value: unknown, allowed: readonly string[], field: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) throw new TypeError(`${field} has an unsupported value`);
  return value;
}

function requirePayloadString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  if (!allowEmpty && value.trim().length === 0) throw new TypeError(`${field} must not be empty`);
  return value;
}

function optionalPayloadString(value: unknown, field: string, allowEmpty = false): void {
  if (value !== undefined) requirePayloadString(value, field, allowEmpty);
}

function requirePayloadStringArray(value: unknown, field: string, safeIdentifiers: boolean): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((item, index) => safeIdentifiers
    ? requireSafeMapKey(item, `${field}[${index}]`)
    : requirePayloadString(item, `${field}[${index}]`, true));
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite number`);
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown, field: string): void {
  if (value !== undefined) requireNonNegativeNumber(value, field);
}

function optionalBoolean(value: unknown, field: string): void {
  if (value !== undefined) requireBoolean(value, field);
}

function requireOwnField(record: Record<string, unknown>, key: string, field: string): void {
  if (!Object.prototype.hasOwnProperty.call(record, key)) throw new TypeError(`${field}.${key} is required`);
}

const RUNTIME_EVENT_ID_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "session.created": ["sessionId"],
  "session.identity_bound": ["sessionId"],
  "session.input_queue_changed": ["sessionId"],
  "session.renamed": ["sessionId"],
  "session.status_changed": ["sessionId", "turnId"],
  "session.model_changed": ["sessionId"],
  "session.reasoning_changed": ["sessionId"],
  "session.service_tier_changed": ["sessionId"],
  "session.delegation_changed": ["sessionId"],
  "session.archived": ["sessionId"],
  "turn.started": ["turnId"],
  "model.request_prepared": ["turnId", "requestId", "contentVersion"],
  "model.request_identity": ["turnId", "requestId"],
  "turn.model_metadata": ["turnId", "responseId"],
  "turn.completed": ["turnId"],
  "turn.compaction_requested": ["turnId", "boundaryMessageId"],
  "turn.compaction_started": ["turnId", "boundaryMessageId"],
  "turn.compaction_completed": ["turnId", "messageId", "boundaryMessageId"],
  "turn.compaction_failed": ["turnId", "boundaryMessageId"],
  "turn.retry_scheduled": ["turnId"],
  "turn.guard_triggered": ["turnId"],
  "message.created": ["messageId", "turnId"],
  "message.part_added": ["messageId"],
  "message.part_committed": ["messageId"],
  "message.part_stream_snapshot": ["messageId"],
  "message.part_stream_delta": ["messageId", "partId"],
  "message.part_delta": ["messageId", "partId"],
  "tool.call_started": ["turnId", "callId"],
  "tool.call_updated": ["callId"],
  "tool.output_delta": ["callId"],
  "tool.call_finished": ["callId"],
  "approval.requested": ["approvalId", "callId"],
  "approval.resolved": ["approvalId"],
  "user_input.requested": ["inputId", "callId"],
  "user_input.resolved": ["inputId"],
  "user_input.cancelled": ["inputId"],
  "snapshot.created": ["snapshotId", "callId"],
  "snapshot.reverted": ["snapshotId"],
  "mcp.progress": ["operationId"],
};

function assertRuntimePayloadIdentifiers(type: string, payload: Record<string, unknown>): void {
  requireKnownIdentifiers(
    payload,
    "event.payload",
    RUNTIME_EVENT_ID_FIELDS[type] ?? [],
  );
}

function assertMessagePartIdentifiers(part: Record<string, unknown>, field: string): void {
  requireKnownIdentifiers(part, field, ["id", "messageId", "sessionId"]);
  if (part.type === "tool_call" || part.type === "tool_result") {
    requireKnownIdentifiers(part, field, ["callId"]);
  } else if (part.type === "patch" || part.type === "artifact") {
    requireKnownIdentifiers(part, field, ["artifactId"]);
  } else if (part.type === "compaction") {
    requireKnownIdentifiers(part, field, ["boundaryMessageId"], ["sourceMessageIds"]);
  }
  if (part.type === "tool_result") requireKnownIdentifiers(part, field, [], ["artifactIds"]);
}

function assertInputQueueIdentifiers(queue: RuntimeInputQueue): void {
  requireIdentifier(queue.sessionId, "inputQueue.sessionId");
  if (queue.executionRef !== undefined) requireIdentifier(queue.executionRef, "inputQueue.executionRef");
  for (const [index, input] of queue.items.entries()) {
    requireKnownIdentifiers(input as unknown as Record<string, unknown>, `inputQueue.items[${index}]`, [
      "inputId", "submissionId", "sessionId", "executionRef", "messageId", "turnId", "resultMessageId",
    ]);
    requireMatchingSessionId(queue.sessionId, input.sessionId, `inputQueue.items[${index}].sessionId`);
  }
}

function requireKnownIdentifiers(
  record: Record<string, unknown>,
  field: string,
  scalarFields: readonly string[],
  arrayFields: readonly string[] = [],
): void {
  for (const key of scalarFields) {
    if (record[key] !== undefined) requireSafeMapKey(record[key], `${field}.${key}`);
  }
  for (const key of arrayFields) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new TypeError(`${field}.${key} must be an array`);
    for (const [index, identifier] of value.entries()) {
      requireSafeMapKey(identifier, `${field}.${key}[${index}]`);
    }
  }
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`);
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

interface JsonByteBudget {
  remaining: number;
}

function assertJsonValue(
  value: unknown,
  field: string,
  depth: number,
  budget: JsonByteBudget = { remaining: MAX_DESKTOP_JSON_BYTES },
): void {
  if (depth > 20) throw new TypeError(`${field} exceeds the nesting limit`);
  if (value === null) {
    consumeJsonBytes(budget, 4, field);
    return;
  }
  if (typeof value === "string") {
    consumeUtf8String(value, budget, field);
    return;
  }
  if (typeof value === "boolean") {
    consumeJsonBytes(budget, value ? 4 : 5, field);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${field} contains a non-finite number`);
    consumeJsonBytes(budget, 24, field);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new TypeError(`${field} contains an oversized array`);
    consumeJsonBytes(budget, value.length + 2, field);
    for (const item of value) assertJsonValue(item, field, depth + 1, budget);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    let entries = 0;
    consumeJsonBytes(budget, 2, field);
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      entries += 1;
      if (entries > 10_000) throw new TypeError(`${field} contains an oversized object`);
      if (key.length > 512) throw new TypeError(`${field} contains an oversized key`);
      consumeUtf8String(key, budget, field);
      consumeJsonBytes(budget, 1, field);
      assertJsonValue(record[key], field, depth + 1, budget);
    }
    return;
  }
  throw new TypeError(`${field} contains an unsupported value`);
}

function consumeJsonBytes(budget: JsonByteBudget, bytes: number, field: string): void {
  budget.remaining -= bytes;
  if (budget.remaining < 0) throw new TypeError(`${field} exceeds the JSON byte budget`);
}

function consumeUtf8String(value: string, budget: JsonByteBudget, field: string): void {
  consumeJsonBytes(budget, 2, field);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      consumeJsonBytes(budget, 1, field);
    } else if (code <= 0x7ff) {
      consumeJsonBytes(budget, 2, field);
    } else if (code >= 0xd800 && code <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff) {
      consumeJsonBytes(budget, 4, field);
      index += 1;
    } else {
      consumeJsonBytes(budget, 3, field);
    }
  }
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const supported = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !supported.has(key));
  if (unknown) throw new TypeError(`Unexpected request field: ${unknown}`);
}
