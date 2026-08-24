import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { projectStdioServerRequiresApproval } from "@chili/core";
import {
  createCommandRunInput,
  createCommandRegistry,
  createMcpPromptCommands,
  serializeCommandCatalog,
  type CommandContext,
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
  RuntimeCommandCatalog,
  RuntimeCommandNode,
  TimestampMs,
} from "@chili/protocol";
import type { RuntimeMcpControlService } from "@chili/server";
import type {
  McpResourceReadResult,
  McpResourceSummary,
  McpResourcesController,
  McpToolControllerContext,
  MutableToolRegistry,
} from "@chili/tools";
import type { PromptCommandControl, PromptCommandRunResult } from "@chili/server";

export interface CliMcpRuntimeOptions {
  cwd: string;
  chiliHome: string;
  registries: readonly MutableToolRegistry[];
  events?: { publish(event: ChiliEvent): Promise<void> };
  createId?: (prefix: string) => string;
  deferConnect?: boolean;
  connectMode?: "eager" | "background" | "manual";
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

interface McpScopeInput {
  cwd?: string;
}

interface McpManagerScope {
  kind: "user" | "project";
  cwd?: string;
  manager: McpClientManager;
  diagnostics: McpDiagnostic[];
  loadErrors: RuntimeMcpReloadError[];
  active: boolean;
}

interface McpScopeView {
  user: McpManagerScope;
  project?: McpManagerScope;
}

class CliMcpRuntimeImpl implements CliMcpRuntime, RuntimeMcpControlService, McpResourcesController, McpPromptController {
  private userScope: McpManagerScope | undefined;
  private readonly projectScopes = new Map<string, Promise<McpManagerScope>>();
  private closed = false;
  private connectMode: "eager" | "background" | "manual" = "eager";

  constructor(
    private readonly options: CliMcpRuntimeOptions,
    private readonly baseCommands: PromptCommandControl,
  ) {}

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
    this.closed = false;
    this.connectMode = this.options.connectMode ?? (this.options.deferConnect === true ? "background" : "eager");
    await this.reloadUserScope();
    this.registerMcpToolProviders();
  }

  async close(): Promise<void> {
    this.closed = true;
    const userScope = this.userScope;
    this.userScope = undefined;
    const projectScopes = [...this.projectScopes.values()];
    this.projectScopes.clear();
    if (userScope) userScope.active = false;
    this.unregisterMcpToolProviders();
    await Promise.allSettled([
      ...(userScope ? [userScope.manager.disconnect()] : []),
      ...projectScopes.map(async (pending) => {
        const scope = await pending;
        scope.active = false;
        await scope.manager.disconnect();
      }),
    ]);
  }

  async list(input: McpScopeInput = {}): Promise<RuntimeMcpListResponse> {
    const view = await this.scopeView(input.cwd);
    return { servers: scopedStates(view).map(toRuntimeServerDescriptor) };
  }

  async status(input: McpScopeInput = {}): Promise<RuntimeMcpStatusResponse> {
    const servers = (await this.list(input)).servers;
    return { servers, summary: mcpSummary(servers) };
  }

  async get(server: string, input: McpScopeInput = {}): Promise<RuntimeMcpServerDescriptor | undefined> {
    const state = scopedState(await this.scopeView(input.cwd), server);
    return state ? toRuntimeServerDescriptor(state) : undefined;
  }

  async reload(input: McpScopeInput = {}): Promise<RuntimeMcpReloadResponse> {
    await this.reloadUserScope();
    await this.invalidateProjectScopes();
    const view = await this.scopeView(input.cwd);
    return {
      reloaded: true,
      servers: scopedStates(view).map(toRuntimeServerDescriptor),
      errors: scopedLoadErrors(view),
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

  async tools(server: string, input: McpScopeInput = {}): Promise<RuntimeMcpToolsResponse> {
    const state = scopedState(await this.scopeView(input.cwd), server);
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

  async listResources(
    input: { serverName?: string },
    context: McpToolControllerContext,
  ): Promise<readonly McpResourceSummary[]> {
    return scopedResources(await this.scopeView(context.cwd))
      .filter((resource) => input.serverName ? resource.server.name === input.serverName : true)
      .map(toResourceSummary);
  }

  async readResource(
    input: { serverName: string; uri: string },
    context: McpToolControllerContext,
  ): Promise<McpResourceReadResult> {
    const manager = scopedManagerForServer(await this.scopeView(context.cwd), input.serverName);
    if (!manager) throw new Error(`MCP server not found: ${input.serverName}`);
    const result = await manager.readResource(input.serverName, input.uri, context.signal);
    const content = firstResourceContent(result, input.uri);
    return {
      serverName: input.serverName,
      uri: content.uri,
      ...(content.mimeType ? { mimeType: content.mimeType } : {}),
      ...(content.text !== undefined ? { text: content.text } : {}),
      ...(content.blob !== undefined ? { blob: content.blob } : {}),
    };
  }

  async renderPrompt(request: McpPromptRenderRequest, context: CommandContext): Promise<McpPromptRenderResult> {
    const manager = scopedManagerForServer(await this.scopeView(context.cwd), request.serverName);
    if (!manager) throw new Error(`MCP server not found: ${request.serverName}`);
    const result = await manager.getPrompt(request.serverName, request.promptName, request.arguments);
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

  async promptCommands(cwd?: string): Promise<CommandDefinition[]> {
    const prompts = scopedPrompts(await this.scopeView(cwd));
    return createMcpPromptCommands(prompts.map(toPromptDefinition), this);
  }

  private async reloadUserScope(): Promise<void> {
    const previous = this.userScope;
    if (previous) {
      previous.active = false;
      await previous.manager.disconnect();
    }
    this.userScope = await this.createScope("user", await loadUserMcpConfig(this.options.chiliHome));
  }

  private async invalidateProjectScopes(): Promise<void> {
    const scopes = [...this.projectScopes.values()];
    this.projectScopes.clear();
    await Promise.allSettled(scopes.map(async (pending) => {
      const scope = await pending;
      scope.active = false;
      await scope.manager.disconnect();
    }));
  }

  private async scopeView(cwd?: string): Promise<McpScopeView> {
    const user = this.requireUserScope();
    if (cwd === undefined) return { user };
    return { user, project: await this.projectScope(cwd) };
  }

  private async projectScope(cwd: string): Promise<McpManagerScope> {
    const canonicalCwd = await canonicalMcpWorkspace(cwd);
    const existing = this.projectScopes.get(canonicalCwd);
    if (existing) return existing;
    const pending = loadProjectMcpConfig(canonicalCwd, this.options.chiliHome)
      .then((loaded) => this.createScope("project", loaded, canonicalCwd));
    this.projectScopes.set(canonicalCwd, pending);
    void pending.catch(() => {
      if (this.projectScopes.get(canonicalCwd) === pending) this.projectScopes.delete(canonicalCwd);
    });
    return pending;
  }

  private requireUserScope(): McpManagerScope {
    if (!this.userScope) throw new Error("MCP runtime is not started");
    return this.userScope;
  }

  private async createScope(
    kind: McpManagerScope["kind"],
    loaded: LoadedMcpConfig,
    cwd?: string,
  ): Promise<McpManagerScope> {
    const scope = {
      kind,
      ...(cwd ? { cwd } : {}),
      manager: undefined as unknown as McpClientManager,
      diagnostics: [...loaded.diagnostics],
      loadErrors: [...loaded.errors, ...loaded.diagnostics.map(diagnosticError)],
      active: true,
    } satisfies McpManagerScope;
    scope.manager = this.createManager(scope, loaded.config);
    if (kind === "user") {
      for (const diagnostic of loaded.diagnostics) this.publishDiagnostic(diagnostic);
    }

    if (this.connectMode === "manual") {
      if (kind === "user") this.publishUserScopeSnapshot(scope);
      return scope;
    }
    if (this.connectMode === "background") {
      if (kind === "user") this.publishUserScopeSnapshot(scope);
      this.connectManagerInBackground(scope);
      return scope;
    }
    try {
      await scope.manager.connect();
    } finally {
      if (kind === "user") this.publishUserScopeSnapshot(scope);
    }
    return scope;
  }

  private connectManagerInBackground(scope: McpManagerScope): void {
    void scope.manager.connect()
      .catch((error: unknown) => {
        if (!scope.active || this.closed) return;
        scope.loadErrors = [...scope.loadErrors, { message: errorMessage(error) }];
      })
      .finally(() => {
        if (!scope.active || this.closed) {
          void scope.manager.disconnect().catch(() => undefined);
          return;
        }
        if (scope.kind === "user") this.publishUserScopeSnapshot(scope);
      });
  }

  private createManager(scope: McpManagerScope, config: McpConfig): McpClientManager {
    return new McpClientManager({
      config,
      createClient: (server) => createSdkMcpClient(server),
      onDiagnostic: (diagnostic) => {
        if (!scope.active) return;
        scope.diagnostics = [...scope.diagnostics, diagnostic];
        scope.loadErrors = [...scope.loadErrors, diagnosticError(diagnostic)];
        if (scope.kind === "user") this.publishDiagnostic(diagnostic);
      },
      onToolsChanged: (event) => {
        if (!scope.active || scope.kind !== "user") return;
        this.publishServerTools(scope, event.server, event.tools.map((tool) => tool.tool));
      },
      onPromptsChanged: (event) => {
        if (!scope.active || scope.kind !== "user") return;
        this.publishPromptsChanged(event.server, event.prompts.map((prompt) => prompt.prompt));
      },
      onResourcesChanged: (event) => {
        if (!scope.active || scope.kind !== "user") return;
        this.publishResourcesChanged(event.server, event.resources.map((resource) => resource.resource));
      },
    });
  }

  private publishUserScopeSnapshot(scope: McpManagerScope): void {
    if (!scope.active || scope.kind !== "user") return;
    for (const state of scope.manager.listStates()) this.publishToolsChanged(state.server, state.tools);
    this.publishStatusSnapshot(scope);
    for (const state of scope.manager.listStates()) {
      this.publishPromptsChanged(state.server, state.prompts);
      this.publishResourcesChanged(state.server, state.resources);
    }
  }

  private unregisterMcpToolProviders(): void {
    for (const registry of this.options.registries) registry.unregisterContextualSource(MCP_TOOL_SOURCE);
  }

  private publishServerTools(scope: McpManagerScope, server: McpServerConfig, tools: readonly McpTool[]): void {
    if (!scope.active || scope.kind !== "user") return;
    this.publishToolsChanged(server, tools);
  }

  private registerMcpToolProviders(): void {
    for (const registry of this.options.registries) {
      registry.replaceContextualSource(MCP_TOOL_SOURCE, async (context) => {
        const view = await this.scopeView(context.cwd);
        return scopedToolDefinitions(view);
      });
    }
  }

  private publishStatusSnapshot(scope: McpManagerScope): void {
    if (!scope.active || scope.kind !== "user") return;
    for (const state of scope.manager.listStates()) {
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
    const state = this.userScope?.manager.getState(server.name);
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
    const state = this.userScope?.manager.getState(server.name);
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
    const state = this.userScope?.manager.getState(server.name);
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

  private publishDiagnostic(diagnostic: McpDiagnostic): void {
    this.publish("mcp.diagnostic", {
      serverName: diagnostic.path.startsWith("servers.") ? diagnostic.path.slice("servers.".length) : "unknown",
      level: diagnostic.severity,
      message: diagnostic.message,
      code: diagnostic.code,
      source: diagnostic.source,
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
    async list(input) {
      const [baseCatalog, dynamicCommands] = await Promise.all([
        base.list(input),
        mcp.promptCommands(input?.cwd),
      ]);
      return mergeRuntimeCommandCatalogs(baseCatalog, mcpCommandCatalog(dynamicCommands));
    },
    async reload(input) {
      const [baseCatalog, dynamicCommands] = await Promise.all([
        base.reload(input),
        mcp.promptCommands(input?.cwd),
      ]);
      return mergeRuntimeCommandCatalogs(baseCatalog, mcpCommandCatalog(dynamicCommands));
    },
    async run(input) {
      const baseCatalog = await base.list(input.cwd ? { cwd: input.cwd } : undefined);
      if (findRuntimeCommandNode(baseCatalog.roots, input.commandId)) return base.run(input);

      const dynamicCommands = await mcp.promptCommands(input.cwd);
      const dynamicCatalog = mcpCommandCatalog(dynamicCommands);
      const mergedCatalog = mergeRuntimeCommandCatalogs(baseCatalog, dynamicCatalog);
      if (!findRuntimeCommandNode(mergedCatalog.roots, input.commandId)) return base.run(input);

      const command = runMcpCommand(dynamicCommands, input.commandId, input.args, input.cwd);
      if (command) return command;
      return base.run(input);
    },
  };
}

function runMcpCommand(
  commands: readonly CommandDefinition[],
  commandId: string,
  args: string | undefined,
  cwd: string | undefined,
): PromiseCommandRunResult | undefined {
  if (commands.length === 0) return undefined;
  const registry = createCommandRegistry(commands);
  const command = registry.findById(commandId);
  if (!command?.run || command.executionTarget !== "prompt") return undefined;
  const commandRun = command.run;
  const run = async (): Promise<PromptCommandRunResult> => {
    const raw = args?.trim() ?? "";
    const context = cwd === undefined ? {} : { cwd };
    const result = await commandRun(context, createCommandRunInput(
      raw ? `${command.path} ${raw}` : command.path,
      raw,
      command.path,
    ));
    const descriptor = findRuntimeCommandNode(serializeCommandCatalog(registry, context).roots, command.id);
    if (!descriptor) throw new Error(`MCP command descriptor is missing: ${command.id}`);
    return { prompt: result.prompt, command: descriptor, metadata: result.metadata };
  };
  return run();
}

type PromiseCommandRunResult = Promise<PromptCommandRunResult>;

async function loadUserMcpConfig(chiliHome: string): Promise<LoadedMcpConfig> {
  const errors: RuntimeMcpReloadError[] = [];
  const userRaw = await readJsonIfExists(userMcpConfigPath(chiliHome), errors);
  const parsed = parseMcpConfig(userRaw);
  return {
    config: parsed.config,
    diagnostics: parsed.diagnostics,
    errors,
  };
}

async function loadProjectMcpConfig(cwd: string, chiliHome: string): Promise<LoadedMcpConfig> {
  const errors: RuntimeMcpReloadError[] = [];
  const [userRaw, projectRaw] = await Promise.all([
    readJsonIfExists(userMcpConfigPath(chiliHome), []),
    readJsonIfExists(await findProjectMcpConfigPath(cwd, chiliHome), errors),
  ]);
  const userConfig = parseMcpConfig(userRaw).config;
  const parsed = parseMcpConfig(userRaw, projectRaw);
  const diagnostics = parsed.diagnostics.filter((diagnostic) => diagnostic.source === "project");
  const config: McpConfig = {
    servers: Object.fromEntries(
      Object.entries(parsed.config.servers).filter(([, server]) => server.source === "project"),
    ),
  };
  return {
    config: enforceProjectMcpTrustPolicy(config, diagnostics, explicitlyTrustedUserServers(userConfig)),
    diagnostics,
    errors,
  };
}

function enforceProjectMcpTrustPolicy(
  config: McpConfig,
  diagnostics: McpDiagnostic[],
  trustedUserServers: ReadonlySet<string>,
): McpConfig {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.enabled && projectStdioServerRequiresApproval({
      scope: server.source,
      transport: server.type,
      trustedByUser: trustedUserServers.has(name),
    })) {
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

function explicitlyTrustedUserServers(config: McpConfig): ReadonlySet<string> {
  return new Set(Object.values(config.servers)
    .filter((server) => server.source === "user" && server.trust === true)
    .map((server) => server.name));
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

function scopedStates(view: McpScopeView): McpServerState[] {
  const projectNames = new Set(view.project?.manager.listStates().map((state) => state.server.name) ?? []);
  return [
    ...view.user.manager.listStates().filter((state) => !projectNames.has(state.server.name)),
    ...(view.project?.manager.listStates() ?? []),
  ];
}

function scopedToolDefinitions(view: McpScopeView): ReturnType<typeof createMcpChiliTools> {
  const project = view.project;
  const projectNames = new Set(project?.manager.listStates().map((state) => state.server.name) ?? []);
  return [
    ...view.user.manager.listStates()
      .filter((state) => !projectNames.has(state.server.name))
      .flatMap((state) => createMcpChiliTools(state.server, state.tools, view.user.manager)),
    ...(project?.manager.listStates()
      .flatMap((state) => createMcpChiliTools(state.server, state.tools, project.manager)) ?? []),
  ];
}

function scopedState(view: McpScopeView, serverName: string): McpServerState | undefined {
  return view.project?.manager.getState(serverName) ?? view.user.manager.getState(serverName);
}

function scopedManagerForServer(view: McpScopeView, serverName: string): McpClientManager | undefined {
  if (view.project?.manager.getState(serverName)) return view.project.manager;
  if (view.user.manager.getState(serverName)) return view.user.manager;
  return undefined;
}

function scopedPrompts(view: McpScopeView): ReturnType<McpClientManager["listPrompts"]> {
  const projectNames = new Set(view.project?.manager.listStates().map((state) => state.server.name) ?? []);
  return [
    ...view.user.manager.listPrompts().filter((prompt) => !projectNames.has(prompt.server.name)),
    ...(view.project?.manager.listPrompts() ?? []),
  ];
}

function scopedResources(view: McpScopeView): ReturnType<McpClientManager["listResources"]> {
  const projectNames = new Set(view.project?.manager.listStates().map((state) => state.server.name) ?? []);
  return [
    ...view.user.manager.listResources().filter((resource) => !projectNames.has(resource.server.name)),
    ...(view.project?.manager.listResources() ?? []),
  ];
}

function scopedLoadErrors(view: McpScopeView): RuntimeMcpReloadError[] {
  return [
    ...view.user.loadErrors.map((error) => ({ ...error })),
    ...(view.project?.loadErrors.map((error) => ({ ...error })) ?? []),
  ];
}

async function canonicalMcpWorkspace(cwd: string): Promise<string> {
  if (typeof cwd !== "string" || cwd.trim().length === 0 || cwd.includes("\0")) {
    throw new Error("MCP workspace cwd must be a non-empty valid filesystem path");
  }
  const absolute = resolve(cwd);
  const missingSegments: string[] = [];
  let candidate = absolute;

  while (true) {
    let canonicalBase: string;
    try {
      canonicalBase = await realpath(candidate);
    } catch (error) {
      if (!isMissingPath(error)) throw new Error("MCP workspace cwd could not be resolved");
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new Error("MCP workspace cwd could not be resolved");
      }
      missingSegments.unshift(basename(candidate));
      candidate = parent;
      continue;
    }

    let isDirectory: boolean;
    try {
      isDirectory = (await stat(canonicalBase)).isDirectory();
    } catch {
      throw new Error("MCP workspace cwd could not be resolved");
    }
    if (!isDirectory) throw new Error("MCP workspace cwd is not a directory");
    return resolve(canonicalBase, ...missingSegments);
  }
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

function mcpCommandCatalog(commands: readonly CommandDefinition[]): RuntimeCommandCatalog {
  return serializeCommandCatalog(createCommandRegistry(commands), {});
}

function mergeRuntimeCommandCatalogs(
  base: RuntimeCommandCatalog,
  dynamic: RuntimeCommandCatalog,
): RuntimeCommandCatalog {
  const roots = base.roots.map(cloneRuntimeCommandNode);
  const diagnostics = [...base.diagnostics, ...dynamic.diagnostics].map(cloneRuntimeCommandDiagnostic);
  const ids = new Map<string, RuntimeCommandNode>();
  const paths = new Map<string, RuntimeCommandNode>();
  indexRuntimeCommandNodes(roots, ids, paths);

  mergeRuntimeCommandNodes(roots, dynamic.roots, ids, paths, diagnostics);
  return {
    roots,
    diagnostics,
  };
}

function mergeRuntimeCommandNodes(
  target: RuntimeCommandNode[],
  incoming: readonly RuntimeCommandNode[],
  ids: Map<string, RuntimeCommandNode>,
  paths: Map<string, RuntimeCommandNode>,
  diagnostics: RuntimeCommandCatalog["diagnostics"],
): void {
  for (const candidate of incoming) {
    const pathOwner = paths.get(candidate.path);
    const idOwner = ids.get(candidate.id);
    const mergeTarget = pathOwner && idOwner === pathOwner && isMergeableCommandEnvelope(pathOwner, candidate)
      ? pathOwner
      : undefined;

    if (mergeTarget) {
      mergeRuntimeCommandNodes(mergeTarget.children, candidate.children, ids, paths, diagnostics);
      continue;
    }
    if (pathOwner) {
      diagnostics.push(commandConflictDiagnostic("duplicate_command_path", candidate, pathOwner));
      continue;
    }
    if (idOwner) {
      diagnostics.push(commandConflictDiagnostic("duplicate_command_id", candidate, idOwner));
      continue;
    }

    const accepted = { ...candidate, children: [] };
    target.push(accepted);
    ids.set(accepted.id, accepted);
    paths.set(accepted.path, accepted);
    mergeRuntimeCommandNodes(accepted.children, candidate.children, ids, paths, diagnostics);
  }
}

function isMergeableCommandEnvelope(existing: RuntimeCommandNode, incoming: RuntimeCommandNode): boolean {
  return existing.id === incoming.id
    && existing.path === incoming.path
    && existing.name === incoming.name
    && existing.selectionMode === "drilldown"
    && incoming.selectionMode === "drilldown";
}

function commandConflictDiagnostic(
  code: "duplicate_command_path" | "duplicate_command_id",
  rejected: RuntimeCommandNode,
  existing: RuntimeCommandNode,
): RuntimeCommandCatalog["diagnostics"][number] {
  const subject = code === "duplicate_command_path" ? rejected.path : rejected.id;
  return {
    level: "error",
    code,
    message: `Rejected ${rejected.id} because ${subject} is already owned by ${existing.id}.`,
    path: rejected.path,
    commandIds: [existing.id, rejected.id],
  };
}

function indexRuntimeCommandNodes(
  commands: readonly RuntimeCommandNode[],
  ids: Map<string, RuntimeCommandNode>,
  paths: Map<string, RuntimeCommandNode>,
): void {
  for (const command of commands) {
    ids.set(command.id, command);
    paths.set(command.path, command);
    indexRuntimeCommandNodes(command.children, ids, paths);
  }
}

function findRuntimeCommandNode(
  commands: readonly RuntimeCommandNode[],
  commandId: string,
): RuntimeCommandNode | undefined {
  for (const command of commands) {
    if (command.id === commandId) return command;
    const child = findRuntimeCommandNode(command.children, commandId);
    if (child) return child;
  }
  return undefined;
}

function cloneRuntimeCommandNode(command: RuntimeCommandNode): RuntimeCommandNode {
  return { ...command, children: command.children.map(cloneRuntimeCommandNode) };
}

function cloneRuntimeCommandDiagnostic(
  diagnostic: RuntimeCommandCatalog["diagnostics"][number],
): RuntimeCommandCatalog["diagnostics"][number] {
  return {
    ...diagnostic,
    ...(diagnostic.commandIds ? { commandIds: [...diagnostic.commandIds] } : {}),
    ...(diagnostic.origins ? { origins: [...diagnostic.origins] } : {}),
  };
}

const MCP_TOOL_SOURCE = "mcp:scoped";

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

function isMissingPath(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
