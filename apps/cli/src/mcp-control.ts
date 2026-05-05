import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { projectStdioServerRequiresApproval } from "@chili/core";
import {
  createCommandRegistry,
  createMcpPromptCommands,
  resolveCommand,
  type CommandDefinition,
  type McpPromptDefinition,
  type McpPromptController,
  type McpPromptRenderRequest,
  type McpPromptRenderResult,
} from "@chili/commands";
import {
  McpClientManager,
  createMcpChiliTools,
  createSdkMcpClient,
  parseMcpConfig,
  type McpConfig,
  type McpDiagnostic,
  type McpPrompt,
  type McpReadResourceResult,
  type McpResource,
  type McpServerConfig,
  type McpServerState,
  type McpTool,
} from "@chili/mcp";
import type {
  ChiliEvent,
  RuntimeMcpAddServerRequest,
  RuntimeMcpAuthRequest,
  RuntimeMcpAuthResponse,
  RuntimeMcpListResponse,
  RuntimeMcpLogoutResponse,
  RuntimeMcpReloadError,
  RuntimeMcpReloadResponse,
  RuntimeMcpRemoveServerResponse,
  RuntimeMcpServerDescriptor,
  RuntimeMcpServerStatus,
  RuntimeMcpStatusResponse,
  RuntimeMcpToolsResponse,
  TimestampMs,
} from "@chili/protocol";
import type { RuntimeMcpControlService } from "@chili/server";
import type { McpResourceReadResult, McpResourceSummary, McpResourcesController, MutableToolRegistry } from "@chili/tools";
import type { PromptCommandControl, PromptCommandRunResult } from "@chili/server";

export interface CliMcpRuntimeOptions {
  cwd: string;
  chiliHome: string;
  registries: readonly MutableToolRegistry[];
  events?: { publish(event: ChiliEvent): Promise<void> };
  createId?: (prefix: string) => string;
}

export interface CliMcpRuntime {
  control: RuntimeMcpControlService;
  resources: McpResourcesController;
  prompts: McpPromptController;
  commands: PromptCommandControl;
  close(): Promise<void>;
}

interface LoadedMcpConfig {
  config: McpConfig;
  diagnostics: McpDiagnostic[];
  errors: RuntimeMcpReloadError[];
}

class CliMcpRuntimeImpl implements CliMcpRuntime, RuntimeMcpControlService, McpResourcesController, McpPromptController {
  private manager: McpClientManager;
  private diagnostics: McpDiagnostic[] = [];
  private loadErrors: RuntimeMcpReloadError[] = [];
  private registeredToolSources = new Set<string>();
  private generation = 0;

  constructor(
    private readonly options: CliMcpRuntimeOptions,
    private readonly baseCommands: PromptCommandControl,
  ) {
    this.manager = this.createManager({ servers: {} }, []);
  }

  get control(): RuntimeMcpControlService {
    return this;
  }

  get resources(): McpResourcesController {
    return this;
  }

  get prompts(): McpPromptController {
    return this;
  }

  get commands(): PromptCommandControl {
    return createCompositePromptCommandControl(this.baseCommands, this);
  }

  async start(): Promise<void> {
    const loaded = await loadMcpConfig(this.options.cwd, this.options.chiliHome);
    await this.applyLoadedConfig(loaded);
  }

  async close(): Promise<void> {
    await this.manager.disconnect();
  }

  async list(): Promise<RuntimeMcpListResponse> {
    return { servers: this.manager.listStates().map(toRuntimeServerDescriptor) };
  }

  async status(): Promise<RuntimeMcpStatusResponse> {
    const servers = (await this.list()).servers;
    return { servers, summary: mcpSummary(servers) };
  }

  async get(server: string): Promise<RuntimeMcpServerDescriptor | undefined> {
    const state = this.manager.getState(server);
    return state ? toRuntimeServerDescriptor(state) : undefined;
  }

  async reload(): Promise<RuntimeMcpReloadResponse> {
    const loaded = await loadMcpConfig(this.options.cwd, this.options.chiliHome);
    await this.applyLoadedConfig(loaded);
    return {
      reloaded: true,
      servers: (await this.list()).servers,
      errors: [...this.loadErrors],
    };
  }

  async add(input: RuntimeMcpAddServerRequest): Promise<RuntimeMcpServerDescriptor> {
    await upsertUserMcpServer(this.options.chiliHome, input);
    await this.reload();
    const descriptor = await this.get(input.name);
    if (!descriptor) throw new Error(`MCP server was not added: ${input.name}`);
    return descriptor;
  }

  async remove(server: string): Promise<RuntimeMcpRemoveServerResponse> {
    const removed = await removeUserMcpServer(this.options.chiliHome, server);
    await this.reload();
    return { server, removed };
  }

  async tools(server: string): Promise<RuntimeMcpToolsResponse> {
    const state = this.manager.getState(server);
    if (!state) throw new Error(`MCP server not found: ${server}`);
    return {
      server,
      tools: state.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
    };
  }

  auth(server: string, _input?: RuntimeMcpAuthRequest): Promise<RuntimeMcpAuthResponse> {
    return Promise.resolve({
      server,
      status: "unsupported",
      message: "OAuth authorization flow is not wired yet for Chili MCP servers.",
    });
  }

  logout(server: string): Promise<RuntimeMcpLogoutResponse> {
    return Promise.resolve({ server, loggedOut: false });
  }

  listResources(input: { serverName?: string }): readonly McpResourceSummary[] {
    return this.manager.listResources()
      .filter((resource) => input.serverName ? resource.server.name === input.serverName : true)
      .map(toResourceSummary);
  }

  async readResource(input: { serverName: string; uri: string }): Promise<McpResourceReadResult> {
    const result = await this.manager.readResource(input.serverName, input.uri);
    const content = firstResourceContent(result, input.uri);
    return {
      serverName: input.serverName,
      uri: content.uri,
      ...(content.mimeType ? { mimeType: content.mimeType } : {}),
      ...(content.text !== undefined ? { text: content.text } : {}),
      ...(content.blob !== undefined ? { blob: content.blob } : {}),
    };
  }

  async renderPrompt(request: McpPromptRenderRequest): Promise<McpPromptRenderResult> {
    const result = await this.manager.getPrompt(request.serverName, request.promptName, request.arguments);
    return {
      messages: result.messages.map((message) => ({
        role: message.role,
        content: mcpPromptContentText(message.content),
      })),
      metadata: {
        serverName: request.serverName,
        promptName: request.promptName,
      },
    };
  }

  promptCommands(): CommandDefinition[] {
    return createMcpPromptCommands(this.manager.listPrompts().map(toPromptDefinition), this);
  }

  private async applyLoadedConfig(loaded: LoadedMcpConfig): Promise<void> {
    await this.manager.disconnect();
    this.diagnostics = loaded.diagnostics;
    this.loadErrors = loaded.errors;
    const generation = this.generation + 1;
    this.generation = generation;
    this.manager = this.createManager(loaded.config, loaded.diagnostics, generation);
    try {
      await this.manager.connect();
    } finally {
      this.registerAllMcpTools();
    }
  }

  private createManager(config: McpConfig, diagnostics: readonly McpDiagnostic[], generation = this.generation): McpClientManager {
    return new McpClientManager({
      config,
      diagnostics,
      createClient: (server) => createSdkMcpClient(server),
      onDiagnostic: (diagnostic) => {
        this.diagnostics = [...this.diagnostics, diagnostic];
        this.loadErrors = [...this.loadErrors, diagnosticError(diagnostic)];
        this.publish("mcp.diagnostic", {
          serverName: diagnostic.path.startsWith("servers.") ? diagnostic.path.slice("servers.".length) : "unknown",
          level: diagnostic.severity,
          message: diagnostic.message,
          code: diagnostic.code,
          source: diagnostic.source,
        });
      },
      onToolsChanged: (event) => {
        if (generation !== this.generation) return;
        this.registerServerTools(event.server, event.tools.map((tool) => tool.tool));
      },
      onPromptsChanged: (event) => {
        if (generation !== this.generation) return;
        this.publishPromptsChanged(event.server, event.prompts.map((prompt) => prompt.prompt));
      },
      onResourcesChanged: (event) => {
        if (generation !== this.generation) return;
        this.publishResourcesChanged(event.server, event.resources.map((resource) => resource.resource));
      },
    });
  }

  private registerAllMcpTools(): void {
    const nextSources = new Set(this.manager.listStates().map((state) => mcpToolSource(state.server.name)));
    for (const staleSource of this.registeredToolSources) {
      if (nextSources.has(staleSource)) continue;
      for (const registry of this.options.registries) registry.unregisterSource(staleSource);
    }
    for (const state of this.manager.listStates()) this.registerServerTools(state.server, state.tools);
    this.registeredToolSources = nextSources;
    this.publishStatusSnapshot();
    for (const state of this.manager.listStates()) {
      this.publishPromptsChanged(state.server, state.prompts);
      this.publishResourcesChanged(state.server, state.resources);
    }
  }

  private registerServerTools(server: McpServerConfig, tools: readonly McpTool[]): void {
    const source = mcpToolSource(server.name);
    const definitions = createMcpChiliTools(server, tools, this.manager);
    for (const registry of this.options.registries) registry.replaceSource(source, definitions);
    this.publishToolsChanged(server, tools);
  }

  private publishStatusSnapshot(): void {
    for (const state of this.manager.listStates()) {
      this.publish("mcp.server_status_changed", {
        serverName: state.server.name,
        status: protocolStatus(state.status),
        toolCount: state.tools.length,
        promptCount: state.prompts.length,
        resourceCount: state.resources.length,
        config: serverConfigSummary(state.server),
        ...(state.error ? { error: { message: state.error.message, recoverable: !state.server.required } } : {}),
      });
    }
  }

  private publishToolsChanged(server: McpServerConfig, tools: readonly McpTool[]): void {
    const state = this.manager.getState(server.name);
    this.publish("mcp.tools_changed", {
      serverName: server.name,
      tools: tools.map((tool) => ({
        serverName: server.name,
        name: tool.name,
        ...(typeof tool.title === "string" ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
      toolCount: tools.length,
      ...(state ? { status: protocolStatus(state.status) } : {}),
    });
  }

  private publishPromptsChanged(server: McpServerConfig, prompts: readonly McpPrompt[]): void {
    const state = this.manager.getState(server.name);
    this.publish("mcp.prompts_changed", {
      serverName: server.name,
      prompts: prompts.map((prompt) => ({
        serverName: server.name,
        name: prompt.name,
        ...(typeof prompt.title === "string" ? { title: prompt.title } : {}),
        ...(prompt.description ? { description: prompt.description } : {}),
        ...(prompt.arguments ? {
          arguments: prompt.arguments.map((argument) => ({
            name: argument.name,
            required: argument.required === true,
            ...(argument.description ? { description: argument.description } : {}),
          })),
        } : {}),
      })),
      promptCount: prompts.length,
      ...(state ? { status: protocolStatus(state.status) } : {}),
    });
  }

  private publishResourcesChanged(server: McpServerConfig, resources: readonly McpResource[]): void {
    const state = this.manager.getState(server.name);
    this.publish("mcp.resources_changed", {
      serverName: server.name,
      resources: resources.map((resource) => ({
        serverName: server.name,
        uri: resource.uri,
        ...(resource.name ? { name: resource.name } : {}),
        ...(typeof resource.title === "string" ? { title: resource.title } : {}),
        ...(resource.description ? { description: resource.description } : {}),
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      })),
      resourceCount: resources.length,
      ...(state ? { status: protocolStatus(state.status) } : {}),
    });
  }

  private publish<TType extends ChiliEvent["type"]>(
    type: TType,
    payload: Extract<ChiliEvent, { type: TType }>["payload"],
  ): void {
    if (!this.options.events) return;
    const event = {
      id: this.options.createId?.("event") ?? `event_${globalThis.crypto.randomUUID().replaceAll("-", "")}`,
      type,
      time: Date.now() as TimestampMs,
      payload,
    } as Extract<ChiliEvent, { type: TType }>;
    void this.options.events.publish(event as ChiliEvent).catch(() => undefined);
  }
}

export async function createCliMcpRuntime(
  options: CliMcpRuntimeOptions,
  baseCommands: PromptCommandControl,
): Promise<CliMcpRuntime> {
  const runtime = new CliMcpRuntimeImpl(options, baseCommands);
  await runtime.start();
  return runtime;
}

function createCompositePromptCommandControl(
  base: PromptCommandControl,
  mcp: CliMcpRuntimeImpl,
): PromptCommandControl {
  return {
    async list() {
      const snapshot = await base.list();
      const mcpCommands = mcp.promptCommands();
      return {
        commands: [...snapshot.commands, ...mcpCommands.map(descriptorForCommand)],
        diagnostics: snapshot.diagnostics,
        directories: snapshot.directories,
        skippedConflicts: snapshot.skippedConflicts,
      };
    },
    async reload() {
      await base.reload();
      return this.list();
    },
    async run(input) {
      const command = resolveMcpCommand(mcp.promptCommands(), input.name, input.args);
      if (command) return command;
      return base.run(input);
    },
  };
}

function resolveMcpCommand(commands: readonly CommandDefinition[], name: string, args: string | undefined): PromiseCommandRunResult | undefined {
  if (commands.length === 0) return undefined;
  const invocation = args?.trim() ? `/${name.trim()} ${args.trim()}` : `/${name.trim()}`;
  const registry = createCommandRegistry(commands);
  const resolved = resolveCommand(registry, invocation, { includeHidden: true });
  if (resolved.status !== "matched") return undefined;
  const run = async (): Promise<PromptCommandRunResult> => {
    const result = await resolved.command.run({}, resolved.args);
    return { prompt: result.prompt, command: descriptorForCommand(resolved.command) };
  };
  return run();
}

type PromiseCommandRunResult = Promise<PromptCommandRunResult>;

async function loadMcpConfig(cwd: string, chiliHome: string): Promise<LoadedMcpConfig> {
  const errors: RuntimeMcpReloadError[] = [];
  const [userRaw, projectRaw] = await Promise.all([
    readJsonIfExists(userMcpConfigPath(chiliHome), errors),
    readJsonIfExists(await findProjectMcpConfigPath(cwd, chiliHome), errors),
  ]);
  const parsed = parseMcpConfig(userRaw, projectRaw);
  return {
    config: enforceProjectMcpTrustPolicy(parsed.config, parsed.diagnostics),
    diagnostics: parsed.diagnostics,
    errors,
  };
}

function enforceProjectMcpTrustPolicy(config: McpConfig, diagnostics: McpDiagnostic[]): McpConfig {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.enabled && projectStdioServerRequiresApproval({ scope: server.source, transport: server.type })) {
      diagnostics.push({
        severity: "warning",
        code: "project_stdio_requires_user_approval",
        message: `Project MCP server "${server.name}" uses stdio and will not be started until it is trusted from user configuration.`,
        path: `servers.${server.name}`,
        source: server.source,
      });
      servers[name] = { ...server, enabled: false };
      continue;
    }
    servers[name] = server;
  }
  return { servers };
}

async function readJsonIfExists(path: string | undefined, errors: RuntimeMcpReloadError[]): Promise<unknown> {
  if (!path) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    errors.push({ message: `${path}: ${errorMessage(error)}` });
    return undefined;
  }
}

async function upsertUserMcpServer(chiliHome: string, input: RuntimeMcpAddServerRequest): Promise<void> {
  const path = userMcpConfigPath(chiliHome);
  const root = await readMutableMcpConfig(path);
  const mcpServers = mutableServerContainer(root);
  mcpServers[input.name] = rawServerFromAddInput(input);
  await writeJsonAtomic(path, root);
}

async function removeUserMcpServer(chiliHome: string, server: string): Promise<boolean> {
  const path = userMcpConfigPath(chiliHome);
  const root = await readMutableMcpConfig(path);
  const mcpServers = mutableServerContainer(root);
  const removed = Object.prototype.hasOwnProperty.call(mcpServers, server);
  delete mcpServers[server];
  await writeJsonAtomic(path, root);
  return removed;
}

async function readMutableMcpConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(parsed)) return parsed;
    throw new Error("MCP config must be a JSON object.");
  } catch (error) {
    if (isNotFound(error)) return { mcpServers: {} };
    throw error;
  }
}

function mutableServerContainer(root: Record<string, unknown>): Record<string, Record<string, unknown>> {
  if (root.mcpServers === undefined) root.mcpServers = {};
  if (!isRecord(root.mcpServers)) throw new Error("mcpServers must be an object.");
  return root.mcpServers as Record<string, Record<string, unknown>>;
}

function rawServerFromAddInput(input: RuntimeMcpAddServerRequest): Record<string, unknown> {
  const transport = input.transport ?? (input.command ? "stdio" : undefined) ?? (input.url ? "http" : undefined);
  if (transport === "stdio") {
    if (!input.command) throw new Error("stdio MCP server requires --command");
    return {
      type: "stdio",
      command: input.command,
      args: input.args ?? [],
      ...(input.env ? { env: input.env } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    };
  }
  if (transport === "http" || transport === "sse") {
    if (!input.url) throw new Error(`${transport} MCP server requires --url`);
    return {
      type: transport,
      url: input.url,
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    };
  }
  throw new Error("MCP server requires --command or --url");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function userMcpConfigPath(chiliHome: string): string {
  return join(chiliHome, "mcp.json");
}

async function findProjectMcpConfigPath(cwd: string, chiliHome: string): Promise<string | undefined> {
  const ignoredUserConfig = resolve(userMcpConfigPath(chiliHome));
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".chili", "mcp.json");
    if (resolve(candidate) !== ignoredUserConfig) {
      try {
        await access(candidate);
        return candidate;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function toRuntimeServerDescriptor(state: McpServerState): RuntimeMcpServerDescriptor {
  const server = state.server;
  const descriptor: RuntimeMcpServerDescriptor = {
    name: server.name,
    status: toRuntimeStatus(state.status),
    enabled: server.enabled,
    transport: server.type,
    auth: serverAuthDescriptor(server),
    toolCount: state.tools.length,
    updatedAt: Date.now(),
  };
  if (server.type === "stdio") {
    descriptor.command = server.command;
    descriptor.args = server.args;
  } else {
    descriptor.url = server.url;
  }
  if (typeof server.raw.description === "string") descriptor.description = server.raw.description;
  if (state.error) descriptor.error = state.error.message;
  return descriptor;
}

function toRuntimeStatus(status: McpServerState["status"]): RuntimeMcpServerStatus {
  if (status === "disabled") return "disabled";
  if (status === "disconnected") return "stopped";
  if (status === "connecting") return "starting";
  if (status === "connected") return "running";
  return "error";
}

function protocolStatus(status: McpServerState["status"]): Extract<ChiliEvent, { type: "mcp.server_status_changed" }>["payload"]["status"] {
  if (status === "disabled") return "disabled";
  if (status === "disconnected") return "stopped";
  if (status === "connecting") return "starting";
  if (status === "connected") return "running";
  return "failed";
}

function serverConfigSummary(server: McpServerConfig): NonNullable<Extract<ChiliEvent, { type: "mcp.server_status_changed" }>["payload"]["config"]> {
  const summary: NonNullable<Extract<ChiliEvent, { type: "mcp.server_status_changed" }>["payload"]["config"]> = {
    name: server.name,
    enabled: server.enabled,
    transport: server.type,
  };
  if (server.type === "stdio") {
    summary.command = server.command;
    summary.args = server.args;
    if (server.env) summary.envKeys = Object.keys(server.env).sort();
  } else {
    summary.url = server.url;
  }
  if (server.startupTimeoutMs !== undefined) summary.timeoutMs = server.startupTimeoutMs;
  return summary;
}

function mcpSummary(servers: readonly RuntimeMcpServerDescriptor[]): RuntimeMcpStatusResponse["summary"] {
  return {
    total: servers.length,
    running: servers.filter((server) => server.status === "running").length,
    disabled: servers.filter((server) => !server.enabled || server.status === "disabled").length,
    authRequired: servers.filter((server) => server.status === "auth_required" || server.auth?.required && !server.auth.authenticated).length,
    errored: servers.filter((server) => server.status === "error").length,
  };
}

function toResourceSummary(resource: ReturnType<McpClientManager["listResources"]>[number]): McpResourceSummary {
  return {
    serverName: resource.server.name,
    uri: resource.resource.uri,
    ...(resource.resource.name ? { name: resource.resource.name } : {}),
    ...(resource.resource.description ? { description: resource.resource.description } : {}),
    ...(resource.resource.mimeType ? { mimeType: resource.resource.mimeType } : {}),
  };
}

function firstResourceContent(result: McpReadResourceResult, fallbackUri: string): McpReadResourceResult["contents"][number] {
  const first = result.contents[0];
  if (!first) return { uri: fallbackUri, text: "" };
  return first;
}

function toPromptDefinition(prompt: { server: McpServerConfig; prompt: McpPrompt }): McpPromptDefinition {
  const definition: McpPromptDefinition = {
    serverName: prompt.server.name,
    name: prompt.prompt.name,
  };
  if (prompt.prompt.description !== undefined) definition.description = prompt.prompt.description;
  if (prompt.prompt.arguments !== undefined) definition.arguments = prompt.prompt.arguments;
  if (typeof prompt.prompt.title === "string") definition.title = prompt.prompt.title;
  return definition;
}

function mcpPromptContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return JSON.stringify(content);
}

function descriptorForCommand(command: CommandDefinition) {
  return {
    name: command.name,
    aliases: [...command.aliases],
    description: command.description,
    category: command.category,
    source: command.source,
    argumentHint: command.argumentHint,
    hidden: command.hidden,
  };
}

function mcpToolSource(serverName: string): string {
  return `mcp:${serverName}`;
}

function diagnosticError(diagnostic: McpDiagnostic): RuntimeMcpReloadError {
  const error: RuntimeMcpReloadError = { message: diagnostic.message };
  if (diagnostic.path.startsWith("servers.")) error.server = diagnostic.path.slice("servers.".length);
  return error;
}

function serverAuthDescriptor(server: McpServerConfig): NonNullable<RuntimeMcpServerDescriptor["auth"]> {
  if (!("oauth" in server) || !server.oauth) return { required: false };
  return {
    required: true,
    authenticated: false,
    ...(server.oauth.scopes ? { scopes: server.oauth.scopes } : {}),
  };
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
