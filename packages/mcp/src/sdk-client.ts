import type { McpStdioGuardianOwner } from "./stdio-guardian.js";
import { Client, SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Transport, RequestOptions } from "@modelcontextprotocol/client";
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
} from "@modelcontextprotocol/client";
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
  createBoundedStdioClientTransport,
  type McpStdioFrameTooLargeError,
} from "./stdio-client-transport.js";

export interface SdkMcpClientOptions {
  stdioGuardian?: McpStdioGuardianOwner;
  clientInfo?: McpClientInfo;
  capabilities?: McpClientCapabilities;
  fetch?: typeof fetch;
  ingressLimits?: Partial<McpHttpIngressLimits>;
}

export interface SdkMcpTransportOptions {
  stdioGuardian?: McpStdioGuardianOwner;
  fetch?: typeof fetch;
  ingressLimits?: Partial<McpHttpIngressLimits>;
  onIngressLimit?: (error: McpHttpIngressLimitError) => void;
  onStdioIngressLimit?: (error: McpStdioFrameTooLargeError) => void;
}

type ListChangedKind = "tools" | "prompts" | "resources";
type McpFatalIngressError = McpHttpIngressLimitError | McpStdioFrameTooLargeError;

export class SdkMcpClient implements McpClient {
  private client: Client;
  private readonly changedHandlers = new Map<ListChangedKind, Set<() => void>>();
  private readonly fetchImplementation: typeof fetch;
  private readonly ingressLimits: Partial<McpHttpIngressLimits> | undefined;
  private activeTransport: Transport | undefined;
  private fatalIngressError: McpFatalIngressError | undefined;
  private connected = false;
  private readonly closeHandlers = new Set<() => void>();
  private connecting: Promise<McpInitializeResult> | undefined;
  private connectionAbort: AbortController | undefined;
  private connectionEpoch = 0;

  constructor(
    readonly server: McpServerConfig,
    private readonly options: SdkMcpClientOptions = {},
  ) {
    this.client = this.createClient();
    this.fetchImplementation = options.fetch ?? fetch;
    this.ingressLimits = options.ingressLimits;
  }

  private createClient(options: McpInitializeOptions = {}): Client {
    const version = options.protocolVersion;
    const client = new Client(toImplementation(options.clientInfo ?? this.options.clientInfo ?? { name: "chili", version: "0.0.0" }), {
      capabilities: toSdkClientCapabilities(options.capabilities ?? this.options.capabilities),
      versionNegotiation: {
        mode: this.server.type === "sse" ? "legacy" : version
          ? version >= "2026-07-28" ? { pin: version } : "legacy"
          : "auto",
        probe: { timeoutMs: 2_000, maxRetries: 0 },
      },
      ...(version ? { supportedProtocolVersions: [version] } : {}),
      // Interactive MCP requests need a host approval/input bridge before they
      // can run. Keep them explicit failures instead of silently retrying tools.
      inputRequired: { autoFulfill: false },
      listMaxPages: 64,
      listChanged: {
        tools: { onChanged: () => this.emitChanged("tools") },
        prompts: { onChanged: () => this.emitChanged("prompts") },
        resources: { onChanged: () => this.emitChanged("resources") },
      },
    });
    client.onclose = () => {
      if (this.client !== client) return;
      this.connected = false;
      this.activeTransport = undefined;
      for (const handler of this.closeHandlers) handler();
    };
    return client;
  }

  onClose(handler: () => void): McpUnsubscribe {
    this.closeHandlers.add(handler);
    return () => { this.closeHandlers.delete(handler); };
  }

  async initialize(options: McpInitializeOptions = {}): Promise<McpInitializeResult> {
    options.signal?.throwIfAborted();
    if (this.connecting) return this.connecting;
    const operation = this.initializeConnection(options);
    this.connecting = operation;
    try {
      return await operation;
    } finally {
      if (this.connecting === operation) this.connecting = undefined;
    }
  }

  private async initializeConnection(options: McpInitializeOptions): Promise<McpInitializeResult> {
    if (!this.connected) this.fatalIngressError = undefined;
    return this.withIngressError(async () => {
      if (!this.connected) {
        const client = this.createClient(options);
        this.client = client;
        const epoch = ++this.connectionEpoch;
        const controller = new AbortController();
        this.connectionAbort = controller;
        const onAbort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
        let transport: Transport;
        transport = createSdkMcpTransport(this.server, {
          ...(this.options.stdioGuardian ? { stdioGuardian: this.options.stdioGuardian } : {}),
          // Auto-discovery precedes the SDK's normal connection ownership.
          // Bind its HTTP probe to cancellation and explicit close as well.
          fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
            controller.signal.throwIfAborted();
            const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
            const signal = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
            return this.fetchImplementation(input, { ...init, signal });
          }) as typeof fetch,
          ...(this.ingressLimits ? { ingressLimits: this.ingressLimits } : {}),
          onIngressLimit: (error) => this.handleFatalIngress(error, transport),
          onStdioIngressLimit: (error) => this.handleFatalIngress(error, transport),
        });
        this.activeTransport = transport;
        try {
          await client.connect(transport, { ...requestOptions(options), signal: controller.signal });
          controller.signal.throwIfAborted();
          if (epoch !== this.connectionEpoch) throw new Error("MCP connection closed during initialization");
          if (this.fatalIngressError) throw this.fatalIngressError;
          this.connected = true;
        } catch (error) {
          controller.abort(error);
          await Promise.allSettled([client.close(), transport.close()]);
          throw error;
        } finally {
          options.signal?.removeEventListener("abort", onAbort);
        }
      }
      const result: McpInitializeResult = {};
      const protocolVersion = this.client.getNegotiatedProtocolVersion();
      if (protocolVersion !== undefined) result.protocolVersion = protocolVersion;
      const capabilities = fromSdkServerCapabilities(this.client.getServerCapabilities());
      if (capabilities !== undefined) result.capabilities = capabilities;
      const serverInfo = fromImplementation(this.client.getServerVersion());
      if (serverInfo !== undefined) result.serverInfo = serverInfo;
      const instructions = this.client.getInstructions();
      if (instructions !== undefined) result.instructions = instructions;
      return result;
    }, false);
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
      }, requestOptions(options));
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
    ++this.connectionEpoch;
    this.connectionAbort?.abort(new Error("MCP connection closed"));
    this.connectionAbort = undefined;
    this.connected = false;
    const transport = this.activeTransport;
    this.activeTransport = undefined;
    await Promise.all([this.client.close(), transport?.close()]);
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

  private async withIngressError<T>(operation: () => Promise<T>, requireConnection = true): Promise<T> {
    if (this.fatalIngressError) throw this.fatalIngressError;
    if (requireConnection && !this.connected) throw new Error("MCP client is not connected");
    try {
      const result = await operation();
      if (this.fatalIngressError) throw this.fatalIngressError;
      return result;
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
    const parameters = {
      command: server.command,
      args: server.args,
      // MCP stdio uses stdout for protocol messages; server diagnostics commonly go to stderr.
      // Keep child stderr out of Chili's CLI/TUI output so noisy MCP startups (for example uv/uvx
      // dependency resolution or Python logging) do not pollute user-visible agent responses.
      stderr: "ignore" as const,
      ...(server.env ? { env: server.env } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    };
    const guarded = options.stdioGuardian?.wrap(parameters);
    const transport = createBoundedStdioClientTransport(guarded?.parameters ?? parameters, {
      ...(options.onStdioIngressLimit ? { onFatalError: options.onStdioIngressLimit } : {}),
    });
    if (guarded) {
      const close = transport.close.bind(transport);
      transport.close = async () => {
        try { await close(); } finally { guarded.revoke(); }
      };
    }
    return transport as unknown as Transport;
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
