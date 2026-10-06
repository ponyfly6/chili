import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { mcpDefinitionFingerprint, mcpServerIdentity } from "./identity.js";
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
  private readonly identity = randomUUID();
  private generation = 0;
  private readonly connections = new Map<McpServerState, Promise<void>>();
  private readonly connectionAborts = new Map<McpServerState, AbortController>();
  private readonly revisions = new Map<McpServerState, number>();
  private readonly refreshes = new Map<McpServerState, { tools: number; prompts: number; resources: number }>();
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

  getToolRevision(serverName: string, toolName: string): string | undefined {
    const state = this.requireState(serverName);
    const tool = state.tools.find((candidate) => candidate.name === toolName);
    if (state.status !== "connected" || !tool) return undefined;
    return `${this.identity}:${mcpServerIdentity(state.server)}:${this.revisions.get(state) ?? 0}:${mcpDefinitionFingerprint(tool)}`;
  }

  async callTool(serverName: string, toolName: string, input: unknown, signal?: AbortSignal, revision?: string): Promise<McpCallToolResult> {
    const state = this.requireConnectedState(serverName);
    const client = state.client;
    return withTimeout((operationSignal) => {
      if (state.client !== client || state.status !== "connected"
        || revision !== undefined && this.getToolRevision(serverName, toolName) !== revision) {
        throw new Error("MCP tool definition or connection changed; prepare the call again");
      }
      return client.callTool(toolName, input, { signal: operationSignal });
    }, state.server.toolTimeoutMs, signal, this.connectionAborts.get(state)?.signal);
  }

  getResourceRevision(serverName: string, uri: string): string | undefined {
    const state = this.requireState(serverName);
    if (state.status !== "connected") return undefined;
    const resource = state.resources.find((candidate) => candidate.uri === uri);
    return `${this.identity}:${mcpServerIdentity(state.server)}:${this.revisions.get(state) ?? 0}:resource:${this.refreshes.get(state)?.resources ?? 0}:${mcpDefinitionFingerprint({ uri, resource })}`;
  }

  getPromptRevision(serverName: string, name: string): string | undefined {
    const state = this.requireState(serverName);
    if (state.status !== "connected") return undefined;
    const prompt = state.prompts.find((candidate) => candidate.name === name);
    return `${this.identity}:${mcpServerIdentity(state.server)}:${this.revisions.get(state) ?? 0}:prompt:${this.refreshes.get(state)?.prompts ?? 0}:${mcpDefinitionFingerprint({ name, prompt })}`;
  }

  async readResource(serverName: string, uri: string, signal?: AbortSignal, revision?: string): Promise<McpReadResourceResult> {
    const state = this.requireConnectedState(serverName);
    const client = state.client;
    return withTimeout((operationSignal) => {
      if (state.client !== client || revision !== undefined && revision !== this.getResourceRevision(serverName, uri)) {
        throw new Error("MCP resource definition or connection changed; prepare the read again");
      }
      return client.readResource(uri, { signal: operationSignal });
    }, state.server.toolTimeoutMs, signal, this.connectionAborts.get(state)?.signal);
  }

  async getPrompt(serverName: string, name: string, arguments_?: Record<string, string>, signal?: AbortSignal, revision?: string): Promise<McpGetPromptResult> {
    const state = this.requireConnectedState(serverName);
    const client = state.client;
    return withTimeout((operationSignal) => {
      if (state.client !== client || revision !== undefined && revision !== this.getPromptRevision(serverName, name)) {
        throw new Error("MCP prompt definition or connection changed; prepare the command again");
      }
      return client.getPrompt(name, arguments_, { signal: operationSignal });
    }, state.server.toolTimeoutMs, signal, this.connectionAborts.get(state)?.signal);
  }

  private resetStates(): void {
    this.states.clear();
    this.revisions.clear();
    this.refreshes.clear();
    for (const server of Object.values(this.config.servers)) {
      this.states.set(server.name, {
        server: server.type === "stdio" ? { ...server, cwd: resolve(server.cwd ?? process.cwd()) } : server,
        status: server.enabled ? "disconnected" : "disabled",
        tools: [],
        prompts: [],
        resources: [],
      });
    }
  }

  private connectState(state: McpServerState): Promise<void> {
    const active = this.connections.get(state);
    if (active) return active;
    const operation = this.initializeState(state);
    this.connections.set(state, operation);
    void operation.finally(() => {
      if (this.connections.get(state) === operation) this.connections.delete(state);
    }).catch(() => undefined);
    return operation;
  }

  private async initializeState(state: McpServerState): Promise<void> {
    if (!state.server.enabled) {
      state.status = "disabled";
      return;
    }
    if (state.status === "connected" || state.status === "connecting") return;

    state.status = "connecting";
    this.revisions.set(state, ++this.generation);
    const controller = new AbortController();
    this.connectionAborts.set(state, controller);
    delete state.error;
    let client: McpClient | undefined;
    try {
      client = this.options.createClient(state.server);
      state.client = client;
      const connectingClient = client;
      await withTimeout((signal) => connectingClient.initialize({ signal }), state.server.startupTimeoutMs, controller.signal);
      if (state.client !== client) return;
      this.subscribe(state);
      await withTimeout((signal) => Promise.all([
        this.refreshStateTools(state, signal),
        this.refreshStatePrompts(state, signal),
        this.refreshStateResources(state, signal),
      ]), state.server.startupTimeoutMs, controller.signal);
      if (state.client !== client) return;
      state.status = "connected";
    } catch (error) {
      if (client && state.client !== client) return;
      state.status = "failed";
      state.error = toError(error);
      await this.closeFailedStateClient(state);
      this.emitDiagnostic(state.server, "connect_failed", `MCP server "${state.server.name}" failed to connect: ${state.error.message}`);
      if (state.server.required) throw state.error;
    }
  }

  private async disconnectState(state: McpServerState): Promise<void> {
    this.unsubscribe(state.server.name);
    const client = state.client;
    // Invalidate before awaiting close: late initialization/catalog responses
    // cannot resurrect the old connection or overwrite its replacement.
    delete state.client;
    this.connectionAborts.get(state)?.abort(new Error("MCP server disconnected"));
    this.connectionAborts.delete(state);
    this.connections.delete(state);
    this.revisions.set(state, ++this.generation);
    state.tools = [];
    state.prompts = [];
    state.resources = [];
    delete state.error;
    state.status = state.server.enabled ? "disconnected" : "disabled";
    if (client) await client.close();
  }

  private async closeFailedStateClient(state: McpServerState): Promise<void> {
    this.unsubscribe(state.server.name);
    this.connectionAborts.get(state)?.abort(state.error);
    this.connectionAborts.delete(state);
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
    const subscribedClient = state.client;
    if (subscribedClient?.onClose) {
      subscriptions.push(subscribedClient.onClose(() => {
        if (state.client !== subscribedClient) return;
        void this.disconnectState(state).catch((error: unknown) => {
          this.emitDiagnostic(state.server, "close_failed", toError(error).message);
        });
        this.options.onToolsChanged?.({ server: state.server, tools: [] });
      }));
    }
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

  private async refreshStateTools(state: McpServerState, signal?: AbortSignal): Promise<void> {
    const client = state.client;
    if (!client) return;
    const generation = this.beginRefresh(state, "tools");
    const tools = signal ? await listAllTools(client, signal) : await withTimeout((operationSignal) => listAllTools(client, operationSignal),
      state.server.toolTimeoutMs, signal, this.connectionAborts.get(state)?.signal);
    signal?.throwIfAborted();
    if (state.client === client && this.refreshes.get(state)?.tools === generation) {
      state.tools = filterTools(state.server, tools);
    }
  }

  private async refreshStatePrompts(state: McpServerState, signal?: AbortSignal): Promise<void> {
    const client = state.client;
    if (!client) return;
    const generation = this.beginRefresh(state, "prompts");
    try {
      const prompts = signal ? await listAllPrompts(client, signal) : await withTimeout((operationSignal) => listAllPrompts(client, operationSignal),
        state.server.toolTimeoutMs, signal, this.connectionAborts.get(state)?.signal);
      signal?.throwIfAborted();
      if (state.client === client && this.refreshes.get(state)?.prompts === generation) state.prompts = prompts;
    } catch (error) {
      signal?.throwIfAborted();
      if (!isUnsupportedCapabilityError(error)) throw error;
      if (state.client === client && this.refreshes.get(state)?.prompts === generation) state.prompts = [];
    }
  }

  private async refreshStateResources(state: McpServerState, signal?: AbortSignal): Promise<void> {
    const client = state.client;
    if (!client) return;
    const generation = this.beginRefresh(state, "resources");
    try {
      const resources = signal ? await listAllResources(client, signal) : await withTimeout((operationSignal) => listAllResources(client, operationSignal),
        state.server.toolTimeoutMs, signal, this.connectionAborts.get(state)?.signal);
      signal?.throwIfAborted();
      if (state.client === client && this.refreshes.get(state)?.resources === generation) state.resources = resources;
    } catch (error) {
      signal?.throwIfAborted();
      if (!isUnsupportedCapabilityError(error)) throw error;
      if (state.client === client && this.refreshes.get(state)?.resources === generation) state.resources = [];
    }
  }

  private beginRefresh(state: McpServerState, kind: "tools" | "prompts" | "resources"): number {
    const versions = this.refreshes.get(state) ?? { tools: 0, prompts: 0, resources: 0 };
    versions[kind] += 1;
    this.refreshes.set(state, versions);
    if (kind === "tools") this.revisions.set(state, ++this.generation);
    return versions[kind];
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

async function listAllTools(client: McpClient, signal?: AbortSignal): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const result = await client.listTools({ ...(cursor ? { cursor } : {}), ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);
  return tools;
}

async function listAllPrompts(client: McpClient, signal?: AbortSignal): Promise<McpPrompt[]> {
  const prompts: McpPrompt[] = [];
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const result = await client.listPrompts({ ...(cursor ? { cursor } : {}), ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    prompts.push(...result.prompts);
    cursor = result.nextCursor;
  } while (cursor);
  return prompts;
}

async function listAllResources(client: McpClient, signal?: AbortSignal): Promise<McpResource[]> {
  const resources: McpResource[] = [];
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const result = await client.listResources({ ...(cursor ? { cursor } : {}), ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    resources.push(...result.resources);
    cursor = result.nextCursor;
  } while (cursor);
  return resources;
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs?: number, signal?: AbortSignal, lifetime?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel: (error: Error) => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    cancel = (error) => {
      // Settle the manager's stable error before SDK abort listeners reject.
      reject(error);
      controller.abort(error);
    };
  });
  const onAbort = () => cancel(new Error("MCP operation aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  lifetime?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted || lifetime?.aborted) onAbort();
  if (timeoutMs) {
    timeout = setTimeout(() => cancel(new Error(`MCP operation timed out after ${timeoutMs}ms`)), timeoutMs);
  }
  try {
    return await Promise.race([
      cancelled,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
    ]);
  } catch (error) {
    // Stop sibling initialization requests if one operation failed first.
    controller.abort(error);
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    lifetime?.removeEventListener("abort", onAbort);
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
