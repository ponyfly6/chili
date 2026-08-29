import type { ApprovalId, MessageId, SessionId, TurnId } from "./ids.js";
import type { ApprovalDecisionAction } from "./tool.js";

export const SESSION_TITLE_MAX_CHARS = 120;

/** Normalize and validate a user-visible session title at every runtime boundary. */
export function normalizeSessionTitle(title: string): string {
  if (typeof title !== "string") throw new TypeError("Session title must be a string.");
  const normalized = title.trim().replace(/\s+/gu, " ");
  if (!normalized) throw new TypeError("Session title cannot be empty.");
  if (normalized.length > SESSION_TITLE_MAX_CHARS) {
    throw new TypeError(`Session title must be ${SESSION_TITLE_MAX_CHARS} characters or fewer.`);
  }
  return normalized;
}

export type RuntimeSessionStatus =
  | "idle"
  | "running"
  | "waiting_for_approval"
  | "cancelling"
  | "cancelled"
  | "failed";

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const THINKING_LEVELS = REASONING_LEVELS;

export type ThinkingLevel = ReasoningLevel;

export const DELEGATION_POLICIES = ["off", "explicit", "proactive"] as const;

export type DelegationPolicy = (typeof DELEGATION_POLICIES)[number];

export const DELEGATION_POLICY_SOURCES = ["default", "reasoning_legacy", "session"] as const;

export type DelegationPolicySource = (typeof DELEGATION_POLICY_SOURCES)[number];

export interface RuntimeDelegationConfig {
  sessionId: SessionId;
  policy: DelegationPolicy;
  source: DelegationPolicySource;
}

export const SERVICE_TIERS = ["standard", "fast"] as const;

export type ServiceTier = (typeof SERVICE_TIERS)[number];

export interface ModelSelection {
  provider: string;
  model: string;
}

export interface RuntimeSkillMention {
  name: string;
  path?: string;
}

export interface RuntimeModelCapabilities {
  streaming?: boolean;
  reasoning?: boolean;
  toolCalls?: boolean;
  toolCallDeltas?: boolean;
  usage?: boolean;
  responseId?: boolean;
}

export const RUNTIME_MODEL_AUTH_SOURCES = ["none", "environment", "api_key", "oauth"] as const;
export type RuntimeModelAuthSource = (typeof RUNTIME_MODEL_AUTH_SOURCES)[number];

export interface RuntimeModelDescriptor extends ModelSelection {
  displayName?: string;
  providerDisplayName?: string;
  /** A non-secret label for the effective model connection or profile. */
  connectionLabel?: string;
  /** The effective credential source, without credential material. */
  authSource?: RuntimeModelAuthSource;
  /** A sanitized endpoint origin. It must not contain userinfo, path, query, or fragment data. */
  endpoint?: string;
  available?: boolean;
  capabilities?: RuntimeModelCapabilities;
  inputCapabilities?: string[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  reasoningLevels?: ReasoningLevel[];
  serviceTiers?: ServiceTier[];
  default?: boolean;
}

export interface RuntimeModelConfig {
  sessionId: SessionId;
  availableReasoningLevels: ReasoningLevel[];
  models: RuntimeModelDescriptor[];
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
}

export const RUNTIME_PERMISSION_PROFILE_IDS = ["default", "auto-review", "full-access"] as const;

export type RuntimePermissionProfileId = (typeof RUNTIME_PERMISSION_PROFILE_IDS)[number];

export interface RuntimePermissionProfileDescriptor {
  id: RuntimePermissionProfileId;
  label: string;
  description: string;
  current: boolean;
  disabledReason?: string;
}

export interface RuntimePermissionConfig {
  profile: RuntimePermissionProfileId;
  profiles: RuntimePermissionProfileDescriptor[];
}

export type RuntimeCommandSource = "project" | "user" | "mcp" | "builtin";

export type RuntimeCommandArgumentMode = "none" | "optional" | "required" | "variadic";

export type RuntimeCommandSelectionMode = "execute" | "complete" | "drilldown";

export type RuntimeCommandConcurrency = "allow" | "deny";

export type RuntimeCommandExecutionTarget = "client" | "runtime" | "prompt";

export interface RuntimeCommandNode {
  id: string;
  name: string;
  path: string;
  title: string;
  description: string;
  group: string;
  source: RuntimeCommandSource;
  argumentMode: RuntimeCommandArgumentMode;
  argumentHint: string;
  selectionMode: RuntimeCommandSelectionMode;
  concurrency: RuntimeCommandConcurrency;
  hidden: boolean;
  enabled: boolean;
  disabledReason?: string;
  executionTarget: RuntimeCommandExecutionTarget;
  children: RuntimeCommandNode[];
}

export interface RuntimeCommandDiagnostic {
  level: "warning" | "error";
  code: string;
  message: string;
  path?: string;
  filePath?: string;
  commandIds?: string[];
  origins?: string[];
}

export interface RuntimeCommandCatalog {
  roots: RuntimeCommandNode[];
  diagnostics: RuntimeCommandDiagnostic[];
}

export interface RuntimeCommandInvocation {
  commandId: string;
  args?: string;
  cwd?: string;
}

export type RuntimeMcpServerStatus =
  | "unknown"
  | "disabled"
  | "stopped"
  | "starting"
  | "running"
  | "error"
  | "auth_required";

export type RuntimeMcpTransport = "stdio" | "http" | "sse";

export interface RuntimeMcpServerAuthState {
  required: boolean;
  authenticated?: boolean;
  provider?: string;
  scopes?: string[];
  error?: string;
}

export interface RuntimeMcpServerDescriptor {
  name: string;
  status: RuntimeMcpServerStatus;
  enabled: boolean;
  transport?: RuntimeMcpTransport;
  command?: string;
  args?: string[];
  url?: string;
  description?: string;
  auth?: RuntimeMcpServerAuthState;
  toolCount?: number;
  error?: string;
  updatedAt?: number;
}

export interface RuntimeMcpSummary {
  total: number;
  running: number;
  disabled: number;
  authRequired: number;
  errored: number;
}

export interface RuntimeMcpListResponse {
  servers: RuntimeMcpServerDescriptor[];
}

export interface RuntimeMcpStatusResponse {
  servers: RuntimeMcpServerDescriptor[];
  summary: RuntimeMcpSummary;
}

export interface RuntimeMcpReloadResponse {
  reloaded: boolean;
  servers: RuntimeMcpServerDescriptor[];
  errors: RuntimeMcpReloadError[];
}

export interface RuntimeMcpReloadError {
  server?: string;
  message: string;
}

export interface RuntimeMcpAddServerRequest {
  name: string;
  transport?: RuntimeMcpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  enabled?: boolean;
}

export interface RuntimeMcpRemoveServerResponse {
  server: string;
  removed: boolean;
}

export interface RuntimeMcpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export interface RuntimeMcpToolsResponse {
  server: string;
  tools: RuntimeMcpToolDescriptor[];
}

export interface RuntimeMcpAuthRequest {
  callbackUrl?: string;
  scopes?: string[];
}

export interface RuntimeMcpAuthResponse {
  server: string;
  status: "authenticated" | "pending" | "unsupported";
  url?: string;
  message?: string;
}

export interface RuntimeMcpLogoutResponse {
  server: string;
  loggedOut: boolean;
}

export type RuntimeCommand =
  | RuntimeCreateSessionCommand
  | RuntimeSubmitPromptCommand
  | RuntimeInterruptCommand
  | RuntimeResolveApprovalCommand
  | RuntimeArchiveSessionCommand;

export interface RuntimeCreateSessionCommand {
  type: "session.create";
  sessionId?: SessionId;
  cwd: string;
}

export interface RuntimeSubmitPromptCommand {
  type: "session.prompt";
  sessionId: SessionId;
  text: string;
  skillMentions?: RuntimeSkillMention[];
  maxTurns?: number;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
}

export interface RuntimeInterruptCommand {
  type: "session.interrupt";
  sessionId: SessionId;
  reason?: string;
}

export interface RuntimeResolveApprovalCommand {
  type: "approval.resolve";
  approvalId: ApprovalId;
  decision: ApprovalDecisionAction;
  feedback?: string;
}

export interface RuntimeArchiveSessionCommand {
  type: "session.archive";
  sessionId: SessionId;
}

export interface RuntimeStatusPayload {
  sessionId: SessionId;
  status: RuntimeSessionStatus;
  turnId?: TurnId;
  reason?: string;
}

export interface ModelUsage {
  /** Non-cached input tokens. Cached reads and writes are reported separately. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
  raw?: unknown;
}

export interface ModelMetadataPayload {
  turnId: TurnId;
  provider?: string;
  model?: string;
  responseId?: string;
  usage?: ModelUsage;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export interface RuntimeSessionRef {
  sessionId: SessionId;
}

export interface RuntimePromptAccepted {
  status: "accepted";
  sessionId: SessionId;
}

export interface RuntimeInterruptResult {
  interrupted: boolean;
}

export interface RuntimeApprovalResolveResult {
  resolved: boolean;
}

export type RuntimePromptResult =
  | {
      status: "completed";
      turns: RuntimeTurnResult[];
      finishReason?: string;
    }
  | {
      status: "failed" | "cancelled" | "max_turns";
      turns: RuntimeTurnResult[];
      error?: RuntimeError;
      finishReason?: string;
    };

export type RuntimeTurnResult =
  | {
      status: "completed";
      turnId: TurnId;
      assistantMessageId: MessageId;
      finishReason?: string;
    }
  | {
      status: "failed" | "cancelled";
      turnId: TurnId;
      assistantMessageId?: MessageId;
      error: RuntimeError;
    };

export interface RuntimeError {
  name: string;
  message: string;
}
