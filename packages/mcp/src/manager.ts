import type { McpConfig, McpDiagnostic, McpServerConfig } from "./config.js";
import type {
  McpCallToolResult,
  McpClient,
  McpGetPromptResult,
  McpListPromptsResult,
  McpListResourcesResult,
  McpListToolsResult,
  McpPrompt,
  McpReadResourceResult,
  McpResource,
  McpTool,
  McpUnsubscribe,
} from "./client.js";

export type McpServerStatus = "disabled" | "disconnected" | "connecting" | "connected" | "failed";

export interface McpClientManagerOptions {
  config: McpConfig;
  createClient: McpClientFactory;
  diagnostics?: readonly McpDiagnostic[];
  onDiagnostic?: (diagnostic: McpDiagnostic) => void;
  onToolsChanged?: (event: McpToolsChangedEvent) => void;
  onPromptsChanged?: (event: McpPromptsChangedEvent) => void;
  onResourcesChanged?: (event: McpResourcesChangedEvent) => void;
}

export type McpClientFactory = (server: McpServerConfig) => McpClient;

export interface McpManagedTool {
  server: McpServerConfig;
  tool: McpTool;
}

export interface McpManagedPrompt {
  server: McpServerConfig;
  prompt: McpPrompt;
}

export interface McpManagedResource {
  server: McpServerConfig;
  resource: McpResource;
}

export interface McpToolsChangedEvent {
  server: McpServerConfig;
  tools: McpManagedTool[];
}

export interface McpPromptsChangedEvent {
  server: McpServerConfig;
  prompts: McpManagedPrompt[];
}

export interface McpResourcesChangedEvent {
  server: McpServerConfig;
  resources: McpManagedResource[];
}

export interface McpServerState {
  server: McpServerConfig;
  status: McpServerStatus;
  client?: McpClient;
  error?: Error;
  tools: McpTool[];
  prompts: McpPrompt[];
  resources: McpResource[];
}

export class McpClientManager {
  private config: McpConfig;
  private readonly states = new Map<string, McpServerState>();
  private readonly subscriptions = new Map<string, McpUnsubscribe[]>();

  constructor(private readonly options: McpClientManagerOptions) {
    this.config = options.config;
    for (const diagnostic of options.diagnostics ?? []) {
      options.onDiagnostic?.(diagnostic);
    }
    this.resetStates();
  }

  getState(serverName: string): McpServerState | undefined {
    return this.states.get(serverName);
  }

  listStates(): McpServerState[] {
    return [...this.states.values()];
  }

  async connect(serverName?: string): Promise<void> {
    const states = serverName ? [this.requireState(serverName)] : [...this.states.values()];
    await Promise.all(states.map((state) => this.connectState(state)));
  }

  async disconnect(serverName?: string): Promise<void> {
    const states = serverName ? [this.requireState(serverName)] : [...this.states.values()];
    await Promise.all(states.map((state) => this.disconnectState(state)));
  }

  async reload(config: McpConfig): Promise<void> {
    await this.disconnect();
    this.config = config;
    this.resetStates();
    await this.connect();
  }

  listTools(): McpManagedTool[] {
    return [...this.states.values()].flatMap((state) => state.tools.map((tool) => ({ server: state.server, tool })));
  }

  async refreshTools(serverName?: string): Promise<McpManagedTool[]> {
    const states = serverName ? [this.requireState(serverName)] : [...this.states.values()];
    await Promise.all(states.map((state) => this.refreshStateTools(state)));
    return this.listTools();
  }

  listPrompts(): McpManagedPrompt[] {
    return [...this.states.values()].flatMap((state) => state.prompts.map((prompt) => ({ server: state.server, prompt })));
  }

  async refreshPrompts(serverName?: string): Promise<McpManagedPrompt[]> {
    const states = serverName ? [this.requireState(serverName)] : [...this.states.values()];
    await Promise.all(states.map((state) => this.refreshStatePrompts(state)));
    return this.listPrompts();
  }

  listResources(): McpManagedResource[] {
    return [...this.states.values()].flatMap((state) => state.resources.map((resource) => ({ server: state.server, resource })));
  }

  async refreshResources(serverName?: string): Promise<McpManagedResource[]> {
    const states = serverName ? [this.requireState(serverName)] : [...this.states.values()];
    await Promise.all(states.map((state) => this.refreshStateResources(state)));
    return this.listResources();
  }

  async callTool(serverName: string, toolName: string, input: unknown, signal?: AbortSignal): Promise<McpCallToolResult> {
    const state = this.requireConnectedState(serverName);
    return withTimeout(state.client.callTool(toolName, input, signal ? { signal } : {}), state.server.toolTimeoutMs, signal);
  }

  async readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<McpReadResourceResult> {
    const state = this.requireConnectedState(serverName);
    return state.client.readResource(uri, signal ? { signal } : {});
  }

  async getPrompt(serverName: string, name: string, arguments_?: Record<string, string>, signal?: AbortSignal): Promise<McpGetPromptResult> {
    const state = this.requireConnectedState(serverName);
    return state.client.getPrompt(name, arguments_, signal ? { signal } : {});
  }

  private resetStates(): void {
    this.states.clear();
    for (const server of Object.values(this.config.servers)) {
      this.states.set(server.name, {
        server,
        status: server.enabled ? "disconnected" : "disabled",
        tools: [],
        prompts: [],
        resources: [],
      });
    }
  }

  private async connectState(state: McpServerState): Promise<void> {
    if (!state.server.enabled) {
      state.status = "disabled";
      return;
    }
    if (state.status === "connected" || state.status === "connecting") return;

    state.status = "connecting";
    delete state.error;
    try {
      const client = this.options.createClient(state.server);
      state.client = client;
      await withTimeout(client.initialize(), state.server.startupTimeoutMs);
      this.subscribe(state);
      await withTimeout(Promise.all([
        this.refreshStateTools(state),
        this.refreshStatePrompts(state),
        this.refreshStateResources(state),
      ]), state.server.startupTimeoutMs);
      state.status = "connected";
    } catch (error) {
      state.status = "failed";
      state.error = toError(error);
      await this.closeFailedStateClient(state);
      this.emitDiagnostic(state.server, "connect_failed", `MCP server "${state.server.name}" failed to connect: ${state.error.message}`);
      if (state.server.required) throw state.error;
    }
  }

  private async disconnectState(state: McpServerState): Promise<void> {
    this.unsubscribe(state.server.name);
    if (state.client) {
      await state.client.close();
    }
    delete state.client;
    state.tools = [];
    state.prompts = [];
    state.resources = [];
    delete state.error;
    state.status = state.server.enabled ? "disconnected" : "disabled";
  }

  private async closeFailedStateClient(state: McpServerState): Promise<void> {
    this.unsubscribe(state.server.name);
    const client = state.client;
    delete state.client;
    state.tools = [];
    state.prompts = [];
    state.resources = [];
    if (!client) return;
    try {
      await client.close();
    } catch (error) {
      this.emitDiagnostic(state.server, "close_failed", `MCP server "${state.server.name}" failed to close after connection error: ${toError(error).message}`);
    }
  }

  private subscribe(state: McpServerState): void {
    this.unsubscribe(state.server.name);
    const subscriptions: McpUnsubscribe[] = [];
    if (state.client?.onToolsChanged) {
      subscriptions.push(state.client.onToolsChanged(() => {
        void this.refreshStateTools(state).then(() => {
          this.options.onToolsChanged?.({
            server: state.server,
            tools: state.tools.map((tool) => ({ server: state.server, tool })),
          });
        }).catch((error: unknown) => {
          this.emitDiagnostic(state.server, "tools_refresh_failed", `MCP tools refresh failed for "${state.server.name}": ${toError(error).message}`);
        });
      }));
    }
    if (state.client?.onPromptsChanged) {
      subscriptions.push(state.client.onPromptsChanged(() => {
        void this.refreshStatePrompts(state).then(() => {
          this.options.onPromptsChanged?.({
            server: state.server,
            prompts: state.prompts.map((prompt) => ({ server: state.server, prompt })),
          });
        }).catch((error: unknown) => {
          this.emitDiagnostic(state.server, "prompts_refresh_failed", `MCP prompts refresh failed for "${state.server.name}": ${toError(error).message}`);
        });
      }));
    }
    if (state.client?.onResourcesChanged) {
      subscriptions.push(state.client.onResourcesChanged(() => {
        void this.refreshStateResources(state).then(() => {
          this.options.onResourcesChanged?.({
            server: state.server,
            resources: state.resources.map((resource) => ({ server: state.server, resource })),
          });
        }).catch((error: unknown) => {
          this.emitDiagnostic(state.server, "resources_refresh_failed", `MCP resources refresh failed for "${state.server.name}": ${toError(error).message}`);
        });
      }));
    }
    this.subscriptions.set(state.server.name, subscriptions);
  }

  private unsubscribe(serverName: string): void {
    const subscriptions = this.subscriptions.get(serverName) ?? [];
    for (const unsubscribe of subscriptions) unsubscribe();
    this.subscriptions.delete(serverName);
  }

  private async refreshStateTools(state: McpServerState): Promise<void> {
    if (!state.client) return;
    state.tools = filterTools(state.server, await listAllTools(state.client));
  }

  private async refreshStatePrompts(state: McpServerState): Promise<void> {
    if (!state.client) return;
    try {
      state.prompts = await listAllPrompts(state.client);
    } catch (error) {
      if (!isUnsupportedCapabilityError(error)) throw error;
      state.prompts = [];
    }
  }

  private async refreshStateResources(state: McpServerState): Promise<void> {
    if (!state.client) return;
    try {
      state.resources = await listAllResources(state.client);
    } catch (error) {
      if (!isUnsupportedCapabilityError(error)) throw error;
      state.resources = [];
    }
  }

  private requireState(serverName: string): McpServerState {
    const state = this.states.get(serverName);
    if (!state) throw new Error(`Unknown MCP server: ${serverName}`);
    return state;
  }

  private requireConnectedState(serverName: string): Required<Pick<McpServerState, "client">> & McpServerState {
    const state = this.requireState(serverName);
    if (!state.client || state.status !== "connected") {
      throw new Error(`MCP server is not connected: ${serverName}`);
    }
    return state as Required<Pick<McpServerState, "client">> & McpServerState;
  }

  private emitDiagnostic(server: McpServerConfig, code: string, message: string): void {
    this.options.onDiagnostic?.({
      severity: "error",
      code,
      message,
      path: `servers.${server.name}`,
      source: server.source,
    });
  }
}

function filterTools(server: McpServerConfig, tools: readonly McpTool[]): McpTool[] {
  const include = server.includeTools ? new Set(server.includeTools) : undefined;
  const exclude = server.excludeTools ? new Set(server.excludeTools) : undefined;
  return tools.filter((tool) => {
    if (include && !include.has(tool.name)) return false;
    if (exclude?.has(tool.name)) return false;
    return true;
  });
}

async function listAllTools(client: McpClient): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listTools(cursor ? { cursor } : {});
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);
  return tools;
}

async function listAllPrompts(client: McpClient): Promise<McpPrompt[]> {
  const prompts: McpPrompt[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listPrompts(cursor ? { cursor } : {});
    prompts.push(...result.prompts);
    cursor = result.nextCursor;
  } while (cursor);
  return prompts;
}

async function listAllResources(client: McpClient): Promise<McpResource[]> {
  const resources: McpResource[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listResources(cursor ? { cursor } : {});
    resources.push(...result.resources);
    cursor = result.nextCursor;
  } while (cursor);
  return resources;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  if (!timeoutMs) return promise;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`MCP operation timed out after ${timeoutMs}ms`)), timeoutMs);
        signal?.addEventListener("abort", () => reject(new Error("MCP operation aborted")), { once: true });
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isUnsupportedCapabilityError(error: unknown): boolean {
  if (isRecord(error)) {
    const code = error.code;
    if (code === -32601 || code === "MethodNotFound" || code === "method_not_found") return true;
    const data = error.data;
    if (isRecord(data)) {
      const dataCode = data.code;
      if (dataCode === -32601 || dataCode === "MethodNotFound" || dataCode === "method_not_found") return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return /method not found|not implemented|unsupported/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
