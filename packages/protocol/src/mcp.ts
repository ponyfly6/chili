export type McpServerTransport = "stdio" | "http" | "sse";

export type McpServerStatus =
  | "disabled"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "auth_required";

export type McpAuthStatus =
  | "unknown"
  | "not_required"
  | "required"
  | "pending"
  | "authenticated"
  | "expired"
  | "failed";

export type McpDiagnosticLevel = "debug" | "info" | "warning" | "error";

export type McpProgressStatus = "started" | "running" | "completed" | "failed" | "cancelled";

export type McpProgressOperation =
  | "initialize"
  | "connect"
  | "authenticate"
  | "list_tools"
  | "list_prompts"
  | "list_resources"
  | "call_tool"
  | "read_resource"
  | "get_prompt"
  | "shutdown";

export interface McpServerCapabilities {
  tools: boolean;
  prompts: boolean;
  resources: boolean;
  logging?: boolean;
  progress?: boolean;
  sampling?: boolean;
  roots?: boolean;
}

export interface McpCapabilityCounts {
  toolCount: number;
  promptCount: number;
  resourceCount: number;
}

export interface McpErrorSummary {
  message: string;
  code?: string;
  recoverable?: boolean;
}

export interface McpServerConfigSummary {
  name: string;
  enabled: boolean;
  transport: McpServerTransport;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  timeoutMs?: number;
  capabilities?: Partial<McpServerCapabilities>;
  metadata?: Record<string, unknown>;
}

export interface McpAuthState {
  status: McpAuthStatus;
  required: boolean;
  provider?: string;
  scopes?: string[];
  expiresAt?: number;
  error?: McpErrorSummary;
}

export interface McpToolRef {
  serverName: string;
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  enabled?: boolean;
}

export interface McpResourceRef {
  serverName: string;
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  uriTemplate?: string;
}

export interface McpPromptArgumentRef {
  name: string;
  required: boolean;
  title?: string;
  description?: string;
}

export interface McpPromptRef {
  serverName: string;
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgumentRef[];
}

export interface McpDiagnostic {
  serverName: string;
  level: McpDiagnosticLevel;
  message: string;
  code?: string;
  source?: string;
  error?: McpErrorSummary;
  metadata?: Record<string, unknown>;
}

export interface McpServerStatusChangedPayload {
  serverName: string;
  status: McpServerStatus;
  toolCount: number;
  promptCount: number;
  resourceCount: number;
  previousStatus?: McpServerStatus;
  config?: McpServerConfigSummary;
  auth?: McpAuthState;
  capabilities?: McpServerCapabilities;
  error?: McpErrorSummary;
}

export interface McpToolsChangedPayload {
  serverName: string;
  tools: McpToolRef[];
  toolCount: number;
  status?: McpServerStatus;
  revision?: string;
  error?: McpErrorSummary;
}

export interface McpPromptsChangedPayload {
  serverName: string;
  prompts: McpPromptRef[];
  promptCount: number;
  status?: McpServerStatus;
  revision?: string;
  error?: McpErrorSummary;
}

export interface McpResourcesChangedPayload {
  serverName: string;
  resources: McpResourceRef[];
  resourceCount: number;
  status?: McpServerStatus;
  revision?: string;
  error?: McpErrorSummary;
}

export interface McpDiagnosticPayload extends McpDiagnostic {
  status?: McpServerStatus;
}

export interface McpProgressPayload {
  serverName: string;
  operation: McpProgressOperation;
  status: McpProgressStatus;
  message?: string;
  operationId?: string;
  toolName?: string;
  resourceUri?: string;
  promptName?: string;
  completed?: number;
  total?: number;
  error?: McpErrorSummary;
  metadata?: Record<string, unknown>;
}
