import type { McpServerConfig } from "./config.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface McpClientInfo {
  name: string;
  version: string;
}

export interface McpClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: Record<string, never>;
  elicitation?: Record<string, never>;
}

export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  logging?: Record<string, never>;
  experimental?: Record<string, unknown>;
}

export interface McpInitializeResult {
  protocolVersion?: string;
  capabilities?: McpServerCapabilities;
  serverInfo?: McpClientInfo;
  instructions?: string;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: McpToolAnnotations;
  [key: string]: unknown;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  [key: string]: unknown;
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
}

export interface McpPromptMessage {
  role: "user" | "assistant" | "system";
  content: unknown;
}

export interface McpCallToolResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface McpListToolsResult {
  tools: McpTool[];
  nextCursor?: string;
}

export interface McpListPromptsResult {
  prompts: McpPrompt[];
  nextCursor?: string;
}

export interface McpListResourcesResult {
  resources: McpResource[];
  nextCursor?: string;
}

export interface McpReadResourceResult {
  contents: McpResourceContent[];
}

export interface McpGetPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

export type McpNotificationHandler = (method: string, params: unknown) => void;
export type McpUnsubscribe = () => void;

export interface McpJsonRpcTransport {
  start?(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<T>;
  notify?(method: string, params?: unknown): Promise<void>;
  onNotification?(handler: McpNotificationHandler): McpUnsubscribe;
  close(): Promise<void>;
}

export interface McpClient {
  readonly server: McpServerConfig;
  initialize(options?: McpInitializeOptions): Promise<McpInitializeResult>;
  listTools(options?: McpCursorOptions): Promise<McpListToolsResult>;
  callTool(name: string, arguments_: unknown, options?: McpCallOptions): Promise<McpCallToolResult>;
  listPrompts(options?: McpCursorOptions): Promise<McpListPromptsResult>;
  listResources(options?: McpCursorOptions): Promise<McpListResourcesResult>;
  readResource(uri: string, options?: McpRequestOptions): Promise<McpReadResourceResult>;
  getPrompt(name: string, arguments_?: Record<string, string>, options?: McpRequestOptions): Promise<McpGetPromptResult>;
  onToolsChanged?(handler: () => void): McpUnsubscribe;
  onPromptsChanged?(handler: () => void): McpUnsubscribe;
  onResourcesChanged?(handler: () => void): McpUnsubscribe;
  close(): Promise<void>;
}

export interface McpRequestOptions {
  signal?: AbortSignal;
}

export interface McpCursorOptions extends McpRequestOptions {
  cursor?: string;
}

export interface McpCallOptions extends McpRequestOptions {
  progressToken?: string | number;
}

export interface McpInitializeOptions extends McpRequestOptions {
  clientInfo?: McpClientInfo;
  capabilities?: McpClientCapabilities;
  protocolVersion?: string;
}

export class JsonRpcMcpClient implements McpClient {
  constructor(
    readonly server: McpServerConfig,
    private readonly transport: McpJsonRpcTransport,
  ) {}

  async initialize(options: McpInitializeOptions = {}): Promise<McpInitializeResult> {
    await this.transport.start?.();
    const result = await this.transport.request<McpInitializeResult>("initialize", {
      protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION,
      capabilities: options.capabilities ?? {},
      clientInfo: options.clientInfo ?? { name: "chili", version: "0.0.0" },
    }, requestOptions(options));
    await this.transport.notify?.("notifications/initialized");
    return result;
  }

  listTools(options: McpCursorOptions = {}): Promise<McpListToolsResult> {
    return this.transport.request<McpListToolsResult>("tools/list", cursorParams(options), requestOptions(options));
  }

  callTool(name: string, arguments_: unknown, options: McpCallOptions = {}): Promise<McpCallToolResult> {
    return this.transport.request<McpCallToolResult>("tools/call", {
      name,
      arguments: arguments_,
      ...(options.progressToken === undefined ? {} : { _meta: { progressToken: options.progressToken } }),
    }, requestOptions(options));
  }

  listPrompts(options: McpCursorOptions = {}): Promise<McpListPromptsResult> {
    return this.transport.request<McpListPromptsResult>("prompts/list", cursorParams(options), requestOptions(options));
  }

  listResources(options: McpCursorOptions = {}): Promise<McpListResourcesResult> {
    return this.transport.request<McpListResourcesResult>("resources/list", cursorParams(options), requestOptions(options));
  }

  readResource(uri: string, options: McpRequestOptions = {}): Promise<McpReadResourceResult> {
    return this.transport.request<McpReadResourceResult>("resources/read", { uri }, requestOptions(options));
  }

  getPrompt(name: string, arguments_?: Record<string, string>, options: McpRequestOptions = {}): Promise<McpGetPromptResult> {
    return this.transport.request<McpGetPromptResult>("prompts/get", {
      name,
      ...(arguments_ ? { arguments: arguments_ } : {}),
    }, requestOptions(options));
  }

  onToolsChanged(handler: () => void): McpUnsubscribe {
    return this.onNotification(["notifications/tools/list_changed", "tools/list_changed"], handler);
  }

  onPromptsChanged(handler: () => void): McpUnsubscribe {
    return this.onNotification(["notifications/prompts/list_changed", "prompts/list_changed"], handler);
  }

  onResourcesChanged(handler: () => void): McpUnsubscribe {
    return this.onNotification(["notifications/resources/list_changed", "resources/list_changed"], handler);
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  private onNotification(methods: string[], handler: () => void): McpUnsubscribe {
    if (!this.transport.onNotification) return () => {};
    return this.transport.onNotification((method) => {
      if (methods.includes(method)) handler();
    });
  }
}

function cursorParams(options: McpCursorOptions): Record<string, string> | undefined {
  return options.cursor ? { cursor: options.cursor } : undefined;
}

function requestOptions(options: McpRequestOptions): { signal?: AbortSignal } {
  return options.signal ? { signal: options.signal } : {};
}
