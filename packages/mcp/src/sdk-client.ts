import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ClientCapabilities,
  GetPromptResult,
  Implementation,
  ListPromptsResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.js";
import type {
  McpCallOptions,
  McpCallToolResult,
  McpClient,
  McpClientCapabilities,
  McpClientInfo,
  McpCursorOptions,
  McpGetPromptResult,
  McpInitializeOptions,
  McpInitializeResult,
  McpListPromptsResult,
  McpListResourcesResult,
  McpListToolsResult,
  McpReadResourceResult,
  McpRequestOptions,
  McpServerCapabilities,
  McpUnsubscribe,
} from "./client.js";
import {
  createBoundedMcpFetch,
  type McpHttpIngressLimitError,
  type McpHttpIngressLimits,
} from "./http-ingress.js";
import {
  BoundedStdioClientTransport,
  type McpStdioFrameTooLargeError,
} from "./stdio-client-transport.js";

export interface SdkMcpClientOptions {
  clientInfo?: McpClientInfo;
  capabilities?: McpClientCapabilities;
  fetch?: typeof fetch;
  ingressLimits?: Partial<McpHttpIngressLimits>;
}

export interface SdkMcpTransportOptions {
  fetch?: typeof fetch;
  ingressLimits?: Partial<McpHttpIngressLimits>;
  onIngressLimit?: (error: McpHttpIngressLimitError) => void;
  onStdioIngressLimit?: (error: McpStdioFrameTooLargeError) => void;
}

type ListChangedKind = "tools" | "prompts" | "resources";
type McpFatalIngressError = McpHttpIngressLimitError | McpStdioFrameTooLargeError;

export class SdkMcpClient implements McpClient {
  private readonly client: Client;
  private readonly changedHandlers = new Map<ListChangedKind, Set<() => void>>();
  private readonly fetchImplementation: typeof fetch;
  private readonly ingressLimits: Partial<McpHttpIngressLimits> | undefined;
  private activeTransport: Transport | undefined;
  private fatalIngressError: McpFatalIngressError | undefined;
  private connected = false;

  constructor(
    readonly server: McpServerConfig,
    options: SdkMcpClientOptions = {},
  ) {
    this.client = new Client(toImplementation(options.clientInfo ?? { name: "chili", version: "0.0.0" }), {
      capabilities: toSdkClientCapabilities(options.capabilities),
      listChanged: {
        tools: { onChanged: () => this.emitChanged("tools") },
        prompts: { onChanged: () => this.emitChanged("prompts") },
        resources: { onChanged: () => this.emitChanged("resources") },
      },
    });
    this.fetchImplementation = options.fetch ?? fetch;
    this.ingressLimits = options.ingressLimits;
    this.client.onclose = () => {
      this.connected = false;
      this.activeTransport = undefined;
    };
  }

  async initialize(options: McpInitializeOptions = {}): Promise<McpInitializeResult> {
    return this.withIngressError(async () => {
      if (!this.connected) {
        this.fatalIngressError = undefined;
        let transport: Transport;
        transport = createSdkMcpTransport(this.server, {
          fetch: this.fetchImplementation,
          ...(this.ingressLimits ? { ingressLimits: this.ingressLimits } : {}),
          onIngressLimit: (error) => this.handleFatalIngress(error, transport),
          onStdioIngressLimit: (error) => this.handleFatalIngress(error, transport),
        });
        this.activeTransport = transport;
        await this.client.connect(transport, requestOptions(options));
        this.connected = true;
      }
      const result: McpInitializeResult = {};
      if (options.protocolVersion !== undefined) result.protocolVersion = options.protocolVersion;
      const capabilities = fromSdkServerCapabilities(this.client.getServerCapabilities());
      if (capabilities !== undefined) result.capabilities = capabilities;
      const serverInfo = fromImplementation(this.client.getServerVersion());
      if (serverInfo !== undefined) result.serverInfo = serverInfo;
      const instructions = this.client.getInstructions();
      if (instructions !== undefined) result.instructions = instructions;
      return result;
    });
  }

  async listTools(options: McpCursorOptions = {}): Promise<McpListToolsResult> {
    return this.withIngressError(
      () => this.client.listTools(cursorParams(options), requestOptions(options)) as Promise<ListToolsResult & McpListToolsResult>,
    );
  }

  async callTool(name: string, arguments_: unknown, options: McpCallOptions = {}): Promise<McpCallToolResult> {
    return this.withIngressError(async () => {
      const result = await this.client.callTool({
        name,
        arguments: callArguments(arguments_),
        ...(options.progressToken === undefined ? {} : { _meta: { progressToken: options.progressToken } }),
      }, undefined, requestOptions(options));
      return result as CallToolResult & McpCallToolResult;
    });
  }

  async listPrompts(options: McpCursorOptions = {}): Promise<McpListPromptsResult> {
    return this.withIngressError(
      () => this.client.listPrompts(cursorParams(options), requestOptions(options)) as Promise<ListPromptsResult & McpListPromptsResult>,
    );
  }

  async listResources(options: McpCursorOptions = {}): Promise<McpListResourcesResult> {
    return this.withIngressError(
      () => this.client.listResources(cursorParams(options), requestOptions(options)) as Promise<ListResourcesResult & McpListResourcesResult>,
    );
  }

  async readResource(uri: string, options: McpRequestOptions = {}): Promise<McpReadResourceResult> {
    return this.withIngressError(
      () => this.client.readResource({ uri }, requestOptions(options)) as Promise<ReadResourceResult & McpReadResourceResult>,
    );
  }

  async getPrompt(name: string, arguments_?: Record<string, string>, options: McpRequestOptions = {}): Promise<McpGetPromptResult> {
    return this.withIngressError(async () => {
      const result = await this.client.getPrompt({
        name,
        ...(arguments_ ? { arguments: arguments_ } : {}),
      }, requestOptions(options));
      return result as GetPromptResult & McpGetPromptResult;
    });
  }

  onToolsChanged(handler: () => void): McpUnsubscribe {
    return this.addChangedHandler("tools", handler);
  }

  onPromptsChanged(handler: () => void): McpUnsubscribe {
    return this.addChangedHandler("prompts", handler);
  }

  onResourcesChanged(handler: () => void): McpUnsubscribe {
    return this.addChangedHandler("resources", handler);
  }

  async close(): Promise<void> {
    this.connected = false;
    await this.client.close();
  }

  private addChangedHandler(kind: ListChangedKind, handler: () => void): McpUnsubscribe {
    const handlers = this.changedHandlers.get(kind) ?? new Set<() => void>();
    handlers.add(handler);
    this.changedHandlers.set(kind, handlers);
    return () => handlers.delete(handler);
  }

  private emitChanged(kind: ListChangedKind): void {
    for (const handler of this.changedHandlers.get(kind) ?? []) handler();
  }

  private async withIngressError<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.fatalIngressError ?? error;
    }
  }

  private handleFatalIngress(error: McpFatalIngressError, transport: Transport): void {
    if (transport !== this.activeTransport) {
      void transport.close().catch(() => undefined);
      return;
    }
    if (this.fatalIngressError) return;
    this.fatalIngressError = error;
    this.connected = false;
    void transport.close().catch(() => undefined);
  }
}

export function createSdkMcpClient(server: McpServerConfig, options: SdkMcpClientOptions = {}): SdkMcpClient {
  return new SdkMcpClient(server, options);
}

export function createSdkMcpTransport(server: McpServerConfig, options: SdkMcpTransportOptions = {}): Transport {
  if (server.type === "stdio") {
    return new BoundedStdioClientTransport({
      command: server.command,
      args: server.args,
      // MCP stdio uses stdout for protocol messages; server diagnostics commonly go to stderr.
      // Keep child stderr out of Chili's CLI/TUI output so noisy MCP startups (for example uv/uvx
      // dependency resolution or Python logging) do not pollute user-visible agent responses.
      stderr: "ignore",
      ...(server.env ? { env: server.env } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    }, {
      ...(options.onStdioIngressLimit ? { onFatalError: options.onStdioIngressLimit } : {}),
    }) as unknown as Transport;
  }

  const boundedFetch = createBoundedMcpFetch(options.fetch ?? fetch, {
    ...(options.ingressLimits ? { limits: options.ingressLimits } : {}),
    ...(options.onIngressLimit ? { onLimit: options.onIngressLimit } : {}),
  });

  if (server.type === "http") {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      fetch: boundedFetch,
      requestInit: { headers: server.headers },
    }) as unknown as Transport;
  }

  const sseFetch = fetchWithHeaders(server.headers, boundedFetch);
  return new SSEClientTransport(new URL(server.url), {
    fetch: sseFetch,
    eventSourceInit: { fetch: sseFetch },
    requestInit: { headers: server.headers },
  }) as unknown as Transport;
}

function requestOptions(options: McpRequestOptions): RequestOptions {
  return options.signal ? { signal: options.signal } : {};
}

function cursorParams(options: McpCursorOptions): { cursor?: string } | undefined {
  return options.cursor ? { cursor: options.cursor } : undefined;
}

function callArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (isRecord(value)) return value;
  return { value };
}

function toImplementation(info: McpClientInfo): Implementation {
  return { name: info.name, version: info.version };
}

function fromImplementation(info: Implementation | undefined): McpClientInfo | undefined {
  return info ? { name: info.name, version: info.version } : undefined;
}

function toSdkClientCapabilities(capabilities: McpClientCapabilities | undefined): ClientCapabilities {
  return capabilities ? capabilities as ClientCapabilities : {};
}

function fromSdkServerCapabilities(capabilities: ServerCapabilities | undefined): McpServerCapabilities | undefined {
  return capabilities ? capabilities as McpServerCapabilities : undefined;
}

function fetchWithHeaders(headers: Record<string, string>, baseFetch: typeof fetch): typeof fetch {
  return ((input, init) => {
    const mergedHeaders = new Headers(init?.headers);
    for (const [key, value] of Object.entries(headers)) mergedHeaders.set(key, value);
    return baseFetch(input, { ...init, headers: mergedHeaders });
  }) as typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
