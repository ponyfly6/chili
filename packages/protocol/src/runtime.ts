import type { ApprovalId, MessageId, SessionId, ThreadId, TurnId } from "./ids.js";
import type { ApprovalDecisionAction } from "./tool.js";

export type RuntimeSessionStatus =
  | "idle"
  | "running"
  | "waiting_for_approval"
  | "cancelling"
  | "cancelled"
  | "failed";

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const THINKING_LEVELS = REASONING_LEVELS;

export type ThinkingLevel = ReasoningLevel;

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

export interface RuntimeModelDescriptor extends ModelSelection {
  displayName?: string;
  providerDisplayName?: string;
  available?: boolean;
  capabilities?: RuntimeModelCapabilities;
  inputCapabilities?: string[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  default?: boolean;
}

export interface RuntimeModelConfig {
  sessionId: SessionId;
  availableReasoningLevels: ReasoningLevel[];
  models: RuntimeModelDescriptor[];
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
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

export type RuntimePromptCommandSource = "project" | "user" | "mcp";

export interface RuntimePromptCommandDescriptor {
  name: string;
  aliases: string[];
  description: string;
  category: string;
  source: RuntimePromptCommandSource;
  argumentHint: string;
  hidden: boolean;
}

export interface RuntimePromptCommandDiagnostic {
  level: "warning" | "error";
  code: string;
  message: string;
  filePath?: string;
}

export interface RuntimePromptCommandList {
  commands: RuntimePromptCommandDescriptor[];
  diagnostics: RuntimePromptCommandDiagnostic[];
  directories: string[];
  skippedConflicts: string[];
}

export interface RuntimePromptCommandInvocation {
  name: string;
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
  threadId?: ThreadId;
  cwd: string;
}

export interface RuntimeSubmitPromptCommand {
  type: "session.prompt";
  sessionId: SessionId;
  threadId: ThreadId;
  text: string;
  skillMentions?: RuntimeSkillMention[];
  maxTurns?: number;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
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
  threadId: ThreadId;
}

export interface RuntimePromptAccepted {
  status: "accepted";
  sessionId: SessionId;
  threadId: ThreadId;
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
