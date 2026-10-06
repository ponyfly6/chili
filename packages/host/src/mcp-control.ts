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
  McpOAuthManager,
  type McpElicitationRequest,
  type McpElicitationResult,
  type McpToolElicitationHandler,
  McpStdioGuardianOwner,
  type McpGuardianLifecycleEvent,
  createMcpChiliTools,
  createSdkMcpClient,
  parseMcpConfig,
  mcpServerIdentity,
  mcpDefinitionFingerprint,
  type McpClient,
  type McpConfig,
  type McpDiagnostic,
  type McpPrompt,
  type McpReadResourceResult,
  type McpResource,
  type McpServerConfig,
  type McpServerState,
  type McpTool,
} from "@chili/mcp";
import { normalizePersistedError } from "@chili/protocol";
import type {
  RuntimeEvent,
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
  McpPromptRef,
  McpResourceRef,
  McpToolRef,
  RuntimeCommandCatalog,
  RuntimeCommandNode,
  TimestampMs,
} from "@chili/protocol";
import type { RuntimeMcpControlService } from "@chili/protocol";
import { type DeferredUserInputQueue, validateStructuredToolData } from "@chili/tools";
import type {
  McpResourceReadResult,
  McpResourceReadInput,
  ToolRegistryContext,
  McpResourceSummary,
  McpResourcesController,
  McpToolControllerContext,
  MutableToolRegistry,
} from "@chili/tools";
import type { PromptCommandControl, PromptCommandRunResult } from "@chili/commands";
import { elicitMcpInput, type McpElicitationContext } from "./mcp-elicitation.js";

export interface HostMcpRuntimeOptions {
  cwd: string;
  chiliHome: string;
  userInputQueue?: DeferredUserInputQueue;
  oauthFetch?: typeof fetch;
  registries: readonly MutableToolRegistry[];
  events?: { publish(event: RuntimeEvent): Promise<void> };
  createId?: (prefix: string) => string;
  deferConnect?: boolean;
  connectMode?: "eager" | "background" | "manual";
  createClient?: (server: McpServerConfig) => McpClient;
  guardianLifecycle?: (event: McpGuardianLifecycleEvent) => void;
}

export interface HostMcpRuntime {
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

type HostMcpRuntimeLifecycle = "open" | "closing" | "closed";

export class HostMcpRuntimeClosedError extends Error {
  constructor() {
    super("MCP runtime is closing or closed");
    this.name = "HostMcpRuntimeClosedError";
  }
}

class HostMcpRuntimeImpl implements HostMcpRuntime, RuntimeMcpControlService, McpResourcesController, McpPromptController {
  private readonly oauth: McpOAuthManager;
  private userScope: McpManagerScope | undefined;
  private stdioGuardian: McpStdioGuardianOwner | undefined;
  private readonly projectScopes = new Map<string, Promise<McpManagerScope>>();
  private readonly liveScopes = new Set<McpManagerScope>();
  private readonly activeDisconnects = new Map<McpManagerScope, Promise<void>>();
  private readonly persistentMutations = new Set<Promise<void>>();
  private readonly eventPublications = new Set<Promise<void>>();
  private lifecycle: HostMcpRuntimeLifecycle = "open";
  private closePromise: Promise<void> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private connectMode: "eager" | "background" | "manual" = "eager";

  constructor(
    private readonly options: HostMcpRuntimeOptions,
    private readonly baseCommands: PromptCommandControl,
  ) {
    this.oauth = new McpOAuthManager({
      directory: join(options.chiliHome, "mcp-auth"),
      ...(options.oauthFetch ? { fetch: options.oauthFetch } : {}),
      onAuthenticated: async (server, assertCurrent) => {
        this.assertOpen();
        for (const scope of this.liveScopes) {
          if (!scope.active) continue;
          for (const state of scope.manager.listStates()) {
            if (mcpServerIdentity(state.server) !== mcpServerIdentity(server)) continue;
            assertCurrent();
            await scope.manager.disconnect(state.server.name);
            assertCurrent();
            if (scope.active && state.server.enabled) await scope.manager.connect(state.server.name);
          }
        }
      },
    });
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
    this.assertOpen();
    this.connectMode = this.options.connectMode ?? (this.options.deferConnect === true ? "background" : "eager");
    if (!this.options.createClient && process.platform !== "win32") {
      this.stdioGuardian = await McpStdioGuardianOwner.create(this.options.guardianLifecycle);
    }
    await this.reloadUserScope();
    this.assertOpen();
    this.registerMcpToolProviders();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    const deferred = createDeferred<void>();
    this.closePromise = deferred.promise;
    this.lifecycle = "closing";
    this.userScope = undefined;
    this.projectScopes.clear();
    const scopes = [...this.liveScopes];
    for (const scope of scopes) scope.active = false;

    const cleanups: Promise<unknown>[] = [
      this.oauth.close(),
      ...this.options.registries.map((registry) => invokeObserved(() => {
        registry.unregisterContextualSource(MCP_TOOL_SOURCE);
      })),
      ...scopes.map((scope) => this.disconnectScope(scope)),
      ...this.persistentMutations,
      ...this.eventPublications,
      ...(this.stdioGuardian ? [this.stdioGuardian.close()] : []),
    ];
    void Promise.allSettled(cleanups).then((results) => {
      this.lifecycle = "closed";
      const errors = results.flatMap((result) => result.status === "rejected"
        ? [normalizePersistedError(result.reason)]
        : []);
      if (errors.length > 0) {
        deferred.reject(new AggregateError(errors, "MCP runtime close failed"));
      } else {
        deferred.resolve();
      }
    }, (error: unknown) => {
      this.lifecycle = "closed";
      deferred.reject(normalizePersistedError(error));
    });
    return this.closePromise;
  }

  async list(input: McpScopeInput = {}): Promise<RuntimeMcpListResponse> {
    const view = await this.scopeView(input.cwd);
    this.assertOpen();
    return { servers: await this.authDescriptors(scopedStates(view)) };
  }

  async status(input: McpScopeInput = {}): Promise<RuntimeMcpStatusResponse> {
    const servers = (await this.list(input)).servers;
    return { servers, summary: mcpSummary(servers) };
  }

  async get(server: string, input: McpScopeInput = {}): Promise<RuntimeMcpServerDescriptor | undefined> {
    const view = await this.scopeView(input.cwd);
    this.assertOpen();
    const state = scopedState(view, server);
    return state ? this.authDescriptor(state) : undefined;
  }

  async reload(input: McpScopeInput = {}): Promise<RuntimeMcpReloadResponse> {
    return this.enqueueMutation(async () => {
      await this.reloadUserScope();
      await this.invalidateProjectScopes();
      const view = await this.scopeView(input.cwd);
      this.assertOpen();
      return {
        reloaded: true,
        servers: await this.authDescriptors(scopedStates(view)),
        errors: scopedLoadErrors(view),
      };
    });
  }

  async connect(server: string, input: McpScopeInput = {}): Promise<RuntimeMcpServerDescriptor> {
    return this.enqueueMutation(async () => {
      const view = await this.scopeView(input.cwd);
      const manager = scopedManagerForServer(view, server);
      if (!manager) throw new Error("MCP server not found");
      await manager.connect(server);
      this.assertOpen();
      if (manager === view.user.manager) this.publishUserScopeSnapshot(view.user);
      return this.authDescriptor(manager.getState(server)!);
    });
  }

  async disconnect(server: string, input: McpScopeInput = {}): Promise<RuntimeMcpServerDescriptor> {
    return this.enqueueMutation(async () => {
      const view = await this.scopeView(input.cwd);
      const manager = scopedManagerForServer(view, server);
      if (!manager) throw new Error("MCP server not found");
      await manager.disconnect(server);
      this.assertOpen();
      if (manager === view.user.manager) this.publishUserScopeSnapshot(view.user);
      return this.authDescriptor(manager.getState(server)!);
    });
  }

  async add(input: RuntimeMcpAddServerRequest): Promise<RuntimeMcpServerDescriptor> {
    return this.enqueueMutation(async () => {
      await this.trackPersistentMutation(() => upsertUserMcpServer(this.options.chiliHome, input));
      this.assertOpen();
      await this.reloadUserScope();
      await this.invalidateProjectScopes();
      const descriptor = await this.get(input.name);
      if (!descriptor) throw new Error(`MCP server was not added: ${safeDisplayText(
        input.name,
        "MCP server name",
        MCP_DESCRIPTOR_LIMITS.identityBytes,
      )}`);
      return descriptor;
    });
  }

  async remove(server: string): Promise<RuntimeMcpRemoveServerResponse> {
    return this.enqueueMutation(async () => {
      const safeServer = safeIdentity(server, "MCP server name", MCP_DESCRIPTOR_LIMITS.identityBytes);
      const removedState = this.userScope?.manager.getState(server);
      const removed = await this.trackPersistentMutation(
        () => removeUserMcpServer(this.options.chiliHome, server),
      );
      this.assertOpen();
      await this.reloadUserScope();
      await this.invalidateProjectScopes();
      if (removed && removedState && ![...this.liveScopes].some((scope) => scope.active && scope.manager.listStates()
        .some((state) => mcpServerIdentity(state.server) === mcpServerIdentity(removedState.server)))) {
        await this.oauth.logout(removedState.server);
      }
      return { server: safeServer, removed };
    });
  }

  async tools(server: string, input: McpScopeInput = {}): Promise<RuntimeMcpToolsResponse> {
    const view = await this.scopeView(input.cwd);
    this.assertOpen();
    const state = scopedState(view, server);
    if (!state) throw new Error(`MCP server not found: ${safeDisplayText(
      server,
      "MCP server name",
      MCP_DESCRIPTOR_LIMITS.identityBytes,
    )}`);
    const catalog = boundMcpToolCatalog(state.server.name, state.tools);
    requireCompleteCatalog(catalog, "tool");
    return {
      server: safeIdentity(server, "MCP server name", MCP_DESCRIPTOR_LIMITS.identityBytes),
      tools: catalog.items.map(({ serverName: _serverName, title: _title, ...tool }) => tool),
    };
  }

  async auth(server: string, input: RuntimeMcpAuthRequest = {}, scope: McpScopeInput = {}): Promise<RuntimeMcpAuthResponse> {
    const view = await this.scopeView(scope.cwd);
    this.assertOpen();
    const state = scopedState(view, server);
    if (!state) throw new Error("MCP server not found");
    const provider = this.oauth.provider(state.server);
    if (!provider) return { server, status: "unsupported", message: "stdio MCP servers use local configuration, not OAuth." };
    const result = await provider.begin(input);
    this.assertOpen();
    return { server, ...result, ...(result.status === "pending" ? { message: "Open this URL to sign in. Waiting for the browser callback (5 minutes)." } : {}) };
  }

  async logout(server: string, scope: McpScopeInput = {}): Promise<RuntimeMcpLogoutResponse> {
    const view = await this.scopeView(scope.cwd);
    this.assertOpen();
    const state = scopedState(view, server);
    if (!state) throw new Error("MCP server not found");
    const identity = mcpServerIdentity(state.server);
    const loggedOut = await this.oauth.logout(state.server);
    for (const scope of this.liveScopes) {
      for (const current of scope.manager.listStates()) {
        if (mcpServerIdentity(current.server) === identity) await scope.manager.disconnect(current.server.name);
      }
    }
    return { server, loggedOut };
  }

  private async authDescriptor(state: McpServerState): Promise<RuntimeMcpServerDescriptor> {
    const descriptor = toRuntimeServerDescriptor(state);
    const provider = this.oauth.provider(state.server);
    if (provider) {
      const auth = await provider.status();
      descriptor.auth = { ...descriptor.auth, required: auth.required, authenticated: auth.authenticated, ...(auth.error ? { error: auth.error } : {}) };
      if (auth.required && !auth.authenticated && state.status === "failed") descriptor.status = "auth_required";
      if (auth.error) descriptor.error = auth.error;
    }
    return descriptor;
  }

  private async authDescriptors(states: readonly McpServerState[]): Promise<RuntimeMcpServerDescriptor[]> {
    boundedServerDescriptors(states);
    return Promise.all(states.map((state) => this.authDescriptor(state)));
  }

  private elicit(server: McpServerConfig, request: McpElicitationRequest, context: McpElicitationContext): Promise<McpElicitationResult> {
    this.assertOpen();
    if (!this.options.userInputQueue || !this.options.events) throw new Error("MCP input is unavailable without an interactive session.");
    return elicitMcpInput({ queue: this.options.userInputQueue, events: this.options.events }, server, request, context);
  }

  async listResources(
    input: { serverName?: string },
    context: McpToolControllerContext,
  ): Promise<readonly McpResourceSummary[]> {
    const view = await this.scopeView(context.cwd);
    this.assertOpen();
    const resources = scopedResources(view)
      .filter((resource) => input.serverName ? resource.server.name === input.serverName : true)
      .map(toResourceSummary);
    return requireBoundedFlatCatalog(resources, "resource");
  }

  async prepareRead(input: McpResourceReadInput, context: ToolRegistryContext): Promise<{ resourceIdentity: string; revision: string }> {
    const view = await this.scopeView(context.cwd);
    this.assertOpen();
    const manager = scopedManagerForServer(view, input.serverName);
    const state = manager?.getState(input.serverName);
    const revision = manager?.getResourceRevision(input.serverName, input.uri);
    if (!state || !revision) throw new Error("MCP resource server is not connected");
    return { resourceIdentity: mcpServerIdentity(state.server), revision };
  }

  async readResource(
    input: McpResourceReadInput,
    context: McpToolControllerContext,
  ): Promise<McpResourceReadResult> {
    const view = await this.scopeView(context.cwd);
    this.assertOpen();
    const manager = scopedManagerForServer(view, input.serverName);
    if (!manager) throw new Error(`MCP server not found: ${safeDisplayText(
      input.serverName,
      "MCP server name",
      MCP_DESCRIPTOR_LIMITS.identityBytes,
    )}`);
    if (input.resourceIdentity !== undefined && input.resourceIdentity !== mcpServerIdentity(manager.getState(input.serverName)!.server)) {
      throw new Error("MCP resource target changed; prepare the read again");
    }
    // Scope discovery can await filesystem or connection work after approval.
    // Revalidate policy at the effect boundary; manager also fences the revision.
    await context.assertCurrentAuthorization?.();
    this.assertOpen();
    const result = await manager.readResource(input.serverName, input.uri, context.signal, input.revision, {
      elicitation: (request, signal) => this.elicit(manager.getState(input.serverName)!.server, request, { ...context, signal }),
      beforeRetry: async () => { this.assertOpen(); await context.assertCurrentAuthorization?.(); },
    });
    const content = firstResourceContent(result, input.uri);
    return {
      serverName: safeIdentity(input.serverName, "MCP server name", MCP_DESCRIPTOR_LIMITS.identityBytes),
      uri: safeIdentity(content.uri, "MCP resource URI", MCP_DESCRIPTOR_LIMITS.uriBytes),
      ...(content.mimeType ? {
        mimeType: safeDisplayText(content.mimeType, "MCP resource MIME type", MCP_DESCRIPTOR_LIMITS.fieldBytes),
      } : {}),
      ...(content.text !== undefined ? { text: content.text } : {}),
      ...(content.blob !== undefined ? { blob: content.blob } : {}),
    };
  }

  async renderPrompt(request: McpPromptRenderRequest, context: CommandContext): Promise<McpPromptRenderResult> {
    const view = await this.scopeView(context.cwd);
    this.assertOpen();
    const manager = scopedManagerForServer(view, request.serverName);
    if (!manager) throw new Error(`MCP server not found: ${safeDisplayText(
      request.serverName,
      "MCP server name",
      MCP_DESCRIPTOR_LIMITS.identityBytes,
    )}`);
    const result = await manager.getPrompt(request.serverName, request.promptName, request.arguments);
    return {
      messages: result.messages.map((message) => ({
        role: message.role,
        content: mcpPromptContentText(message.content),
      })),
      metadata: {
        serverName: safeIdentity(request.serverName, "MCP server name", MCP_DESCRIPTOR_LIMITS.identityBytes),
        promptName: safeIdentity(request.promptName, "MCP prompt name", MCP_DESCRIPTOR_LIMITS.identityBytes),
      },
    };
  }

  async promptCommands(cwd?: string): Promise<CommandDefinition[]> {
    const view = await this.scopeView(cwd);
    this.assertOpen();
    const prompts = scopedPrompts(view);
    const catalog = boundMcpPromptDefinitions(prompts);
    requireCompleteCatalog(catalog, "prompt");
    const bindings = new Map(prompts.map(({ server, prompt }) => {
      const manager = scopedManagerForServer(view, server.name)!;
      return [`${server.name}\0${prompt.name}`, { manager, revision: manager.getPromptRevision(server.name, prompt.name) }] as const;
    }));
    return createMcpPromptCommands(catalog.items, {
      renderPrompt: async (request) => {
        this.assertOpen();
        const binding = bindings.get(`${request.serverName}\0${request.promptName}`);
        if (!binding) throw new Error("MCP prompt is no longer available");
        const result = await binding.manager.getPrompt(request.serverName, request.promptName, request.arguments, undefined, binding.revision);
        return { messages: result.messages.map((message) => ({ role: message.role, content: mcpPromptContentText(message.content) })) };
      },
    });
  }

  assertOpen(): void {
    if (this.lifecycle !== "open") throw new HostMcpRuntimeClosedError();
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = this.mutationTail.then(async () => {
      this.assertOpen();
      return operation();
    });
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private trackPersistentMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const settlement = createDeferred<void>();
    this.persistentMutations.add(settlement.promise);
    let result: Promise<T>;
    try {
      result = Promise.resolve(operation());
    } catch (error) {
      result = Promise.reject(error);
    }
    const settle = (): void => {
      this.persistentMutations.delete(settlement.promise);
      settlement.resolve();
    };
    void result.then(settle, settle);
    return result;
  }

  private disconnectScope(scope: McpManagerScope, retryAfterActive = false): Promise<void> {
    scope.active = false;
    const active = this.activeDisconnects.get(scope);
    if (active) {
      if (!retryAfterActive) return active;
      return active.then(
        () => this.disconnectScope(scope),
        () => this.disconnectScope(scope),
      );
    }

    const deferred = createDeferred<void>();
    this.activeDisconnects.set(scope, deferred.promise);
    let result: Promise<void>;
    try {
      result = Promise.resolve(scope.manager.disconnect());
    } catch (error) {
      result = Promise.reject(error);
    }
    void result.then(deferred.resolve, deferred.reject);
    void deferred.promise.then(() => {
      if (this.activeDisconnects.get(scope) === deferred.promise) this.activeDisconnects.delete(scope);
      this.liveScopes.delete(scope);
    }, () => {
      if (this.activeDisconnects.get(scope) === deferred.promise) this.activeDisconnects.delete(scope);
    });
    return deferred.promise;
  }

  private async reloadUserScope(): Promise<void> {
    this.assertOpen();
    const previous = this.userScope;
    if (previous) {
      previous.active = false;
      try {
        await this.disconnectScope(previous);
      } catch (error) {
        throw normalizePersistedError(error);
      }
    }
    this.assertOpen();
    await this.oauth.reset();
    this.assertOpen();
    const loaded = await loadUserMcpConfig(this.options.chiliHome);
    this.assertOpen();
    const next = await this.createScope("user", loaded);
    if (this.lifecycle !== "open") {
      next.active = false;
      await this.disconnectScope(next, true).catch(() => undefined);
      throw new HostMcpRuntimeClosedError();
    }
    this.userScope = next;
  }

  private async invalidateProjectScopes(): Promise<void> {
    this.assertOpen();
    const scopes = [...this.projectScopes.values()];
    this.projectScopes.clear();
    await Promise.allSettled(scopes.map(async (pending) => {
      const scope = await pending;
      scope.active = false;
      await this.disconnectScope(scope);
    }));
    this.assertOpen();
  }

  private async scopeView(cwd?: string): Promise<McpScopeView> {
    this.assertOpen();
    const user = this.requireUserScope();
    if (cwd === undefined) return { user };
    const project = await this.projectScope(cwd);
    this.assertOpen();
    return { user, project };
  }

  private async projectScope(cwd: string): Promise<McpManagerScope> {
    this.assertOpen();
    const canonicalCwd = await canonicalMcpWorkspace(cwd);
    this.assertOpen();
    const existing = this.projectScopes.get(canonicalCwd);
    if (existing) {
      const scope = await existing;
      this.assertOpen();
      return scope;
    }
    const pending = loadProjectMcpConfig(canonicalCwd, this.options.chiliHome)
      .then(async (loaded) => {
        this.assertOpen();
        const scope = await this.createScope("project", loaded, canonicalCwd);
        if (this.lifecycle !== "open") {
          scope.active = false;
          await this.disconnectScope(scope, true).catch(() => undefined);
          throw new HostMcpRuntimeClosedError();
        }
        return scope;
      });
    this.projectScopes.set(canonicalCwd, pending);
    void pending.catch(() => {
      if (this.projectScopes.get(canonicalCwd) === pending) this.projectScopes.delete(canonicalCwd);
    });
    const scope = await pending;
    this.assertOpen();
    return scope;
  }

  private requireUserScope(): McpManagerScope {
    this.assertOpen();
    if (!this.userScope) throw new Error("MCP runtime is not started");
    return this.userScope;
  }

  private async createScope(
    kind: McpManagerScope["kind"],
    loaded: LoadedMcpConfig,
    cwd?: string,
  ): Promise<McpManagerScope> {
    this.assertOpen();
    const diagnostics = boundMcpDiagnostics(loaded.diagnostics);
    const scope: McpManagerScope = {
      kind,
      ...(cwd ? { cwd } : {}),
      manager: undefined as unknown as McpClientManager,
      diagnostics,
      loadErrors: boundMcpLoadErrors(loaded.errors, diagnostics),
      active: true,
    };
    scope.manager = this.createManager(scope, loaded.config);
    this.liveScopes.add(scope);
    if (kind === "user") {
      for (const diagnostic of diagnostics) this.publishDiagnostic(diagnostic);
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
    } catch (error) {
      scope.active = false;
      const cleanup = await Promise.allSettled([this.disconnectScope(scope, true)]);
      const cleanupErrors = cleanup.flatMap((result) => result.status === "rejected"
        ? [normalizePersistedError(result.reason)]
        : []);
      const normalized = normalizePersistedError(error);
      if (cleanupErrors.length > 0) {
        throw new AggregateError([normalized, ...cleanupErrors], "MCP scope startup and cleanup failed");
      }
      throw normalized;
    } finally {
      if (kind === "user") this.publishUserScopeSnapshot(scope);
    }
    if (this.lifecycle !== "open" || !scope.active) {
      scope.active = false;
      await this.disconnectScope(scope, true).catch(() => undefined);
      throw new HostMcpRuntimeClosedError();
    }
    return scope;
  }

  private connectManagerInBackground(scope: McpManagerScope): void {
    void scope.manager.connect()
      .catch((error: unknown) => {
        if (!scope.active || this.lifecycle !== "open") return;
        scope.loadErrors = appendMcpLoadError(scope.loadErrors, { message: persistedDiagnosticMessage(error) });
      })
      .finally(() => {
        if (!scope.active || this.lifecycle !== "open") {
          void this.disconnectScope(scope, true).catch(() => undefined);
          return;
        }
        if (scope.kind === "user") this.publishUserScopeSnapshot(scope);
      });
  }

  private createManager(scope: McpManagerScope, config: McpConfig): McpClientManager {
    return new McpClientManager({
      config,
      createClient: (server) => {
        if (this.options.createClient) return this.options.createClient(server);
        if (server.type === "stdio" && !this.stdioGuardian) throw new Error("Managed MCP stdio is unavailable on this host");
        const authProvider = this.oauth.provider(server);
        return createSdkMcpClient(server, {
          ...(this.stdioGuardian ? { stdioGuardian: this.stdioGuardian } : {}),
          ...(authProvider ? { authProvider: authProvider.transportAuth() } : {}),
          enableElicitation: Boolean(this.options.userInputQueue && this.options.events),
        });
      },
      onDiagnostic: (diagnostic) => {
        if (!scope.active || this.lifecycle !== "open") return;
        const safeDiagnostic = sanitizeMcpDiagnostic(diagnostic);
        scope.diagnostics = appendMcpDiagnostic(scope.diagnostics, safeDiagnostic);
        scope.loadErrors = appendMcpLoadError(scope.loadErrors, diagnosticError(safeDiagnostic));
        if (scope.kind === "user") this.publishDiagnostic(safeDiagnostic);
      },
      onToolsChanged: (event) => {
        if (!scope.active || this.lifecycle !== "open" || scope.kind !== "user") return;
        const tools = unwrapManagedMcpItems<McpTool>(event.tools, "tool");
        this.publishServerTools(scope, event.server, tools.items, tools.originalCount);
      },
      onPromptsChanged: (event) => {
        if (!scope.active || this.lifecycle !== "open" || scope.kind !== "user") return;
        const prompts = unwrapManagedMcpItems<McpPrompt>(event.prompts, "prompt");
        this.publishPromptsChanged(event.server, prompts.items, prompts.originalCount);
      },
      onResourcesChanged: (event) => {
        if (!scope.active || this.lifecycle !== "open" || scope.kind !== "user") return;
        const resources = unwrapManagedMcpItems<McpResource>(event.resources, "resource");
        this.publishResourcesChanged(event.server, resources.items, resources.originalCount);
      },
    });
  }

  private publishUserScopeSnapshot(scope: McpManagerScope): void {
    if (!scope.active || this.lifecycle !== "open" || scope.kind !== "user") return;
    const states = scope.manager.listStates();
    const retainedStates = states.slice(0, MCP_DESCRIPTOR_LIMITS.catalogItems);
    if (states.length > retainedStates.length) {
      this.publishDescriptorLimitDiagnostic("unknown", "server", states.length, retainedStates.length);
    }
    for (const state of retainedStates) this.publishToolsChanged(state.server, state.tools);
    this.publishStatusSnapshot(scope);
    for (const state of retainedStates) {
      this.publishPromptsChanged(state.server, state.prompts);
      this.publishResourcesChanged(state.server, state.resources);
    }
  }

  private publishServerTools(
    scope: McpManagerScope,
    server: McpServerConfig,
    tools: readonly McpTool[],
    originalCount?: number,
  ): void {
    if (!scope.active || this.lifecycle !== "open" || scope.kind !== "user") return;
    this.publishToolsChanged(server, tools, originalCount);
  }

  private registerMcpToolProviders(): void {
    this.assertOpen();
    for (const registry of this.options.registries) {
      registry.replaceContextualSource(MCP_TOOL_SOURCE, async (context) => {
        const view = await this.scopeView(context.cwd);
        this.assertOpen();
        return scopedToolDefinitions(view, () => this.assertOpen(), (server, request, context) => this.elicit(server, request, context));
      });
    }
  }

  private publishStatusSnapshot(scope: McpManagerScope): void {
    if (!scope.active || this.lifecycle !== "open" || scope.kind !== "user") return;
    const states = scope.manager.listStates();
    const retainedStates = states.slice(0, MCP_DESCRIPTOR_LIMITS.catalogItems);
    if (states.length > retainedStates.length) {
      this.publishDescriptorLimitDiagnostic("unknown", "server", states.length, retainedStates.length);
    }
    for (const state of retainedStates) {
      let serverName: string;
      let config: ReturnType<typeof serverConfigSummary>;
      try {
        serverName = safeIdentity(state.server.name, "MCP server name", MCP_DESCRIPTOR_LIMITS.identityBytes);
        config = serverConfigSummary(state.server);
      } catch {
        this.publishDescriptorLimitDiagnostic("unknown", "server", 1, 0);
        continue;
      }
      this.publish("mcp.server_status_changed", {
        serverName,
        status: protocolStatus(state.status),
        toolCount: safeCollectionLength(state.tools),
        promptCount: safeCollectionLength(state.prompts),
        resourceCount: safeCollectionLength(state.resources),
        config,
        ...(state.error ? {
          error: {
            message: persistedDiagnosticMessage(state.error),
            recoverable: !state.server.required,
          },
        } : {}),
      });
    }
  }

  private publishToolsChanged(server: McpServerConfig, tools: readonly McpTool[], originalCount?: number): void {
    const state = this.userScope?.manager.getState(server.name);
    const catalog = boundMcpToolCatalog(server.name, tools, originalCount);
    if (catalog.truncated) {
      this.publishDescriptorLimitDiagnostic(catalog.serverName, "tool", catalog.originalCount, catalog.items.length);
    }
    this.publish("mcp.tools_changed", {
      serverName: catalog.serverName,
      tools: catalog.items,
      toolCount: catalog.originalCount,
      ...(state ? { status: protocolStatus(state.status) } : {}),
    });
  }

  private publishPromptsChanged(server: McpServerConfig, prompts: readonly McpPrompt[], originalCount?: number): void {
    const state = this.userScope?.manager.getState(server.name);
    const catalog = boundMcpPromptCatalog(server.name, prompts, originalCount);
    if (catalog.truncated) {
      this.publishDescriptorLimitDiagnostic(catalog.serverName, "prompt", catalog.originalCount, catalog.items.length);
    }
    this.publish("mcp.prompts_changed", {
      serverName: catalog.serverName,
      prompts: catalog.items,
      promptCount: catalog.originalCount,
      ...(state ? { status: protocolStatus(state.status) } : {}),
    });
  }

  private publishResourcesChanged(
    server: McpServerConfig,
    resources: readonly McpResource[],
    originalCount?: number,
  ): void {
    const state = this.userScope?.manager.getState(server.name);
    const catalog = boundMcpResourceCatalog(server.name, resources, originalCount);
    if (catalog.truncated) {
      this.publishDescriptorLimitDiagnostic(catalog.serverName, "resource", catalog.originalCount, catalog.items.length);
    }
    this.publish("mcp.resources_changed", {
      serverName: catalog.serverName,
      resources: catalog.items,
      resourceCount: catalog.originalCount,
      ...(state ? { status: protocolStatus(state.status) } : {}),
    });
  }

  private publishDiagnostic(diagnostic: McpDiagnostic): void {
    const code = safeOptionalDisplayText(diagnostic.code, "MCP diagnostic code", MCP_DESCRIPTOR_LIMITS.identityBytes);
    const source = safeOptionalDisplayText(
      diagnostic.source,
      "MCP diagnostic source",
      MCP_DESCRIPTOR_LIMITS.identityBytes,
    );
    this.publish("mcp.diagnostic", {
      serverName: safeDiagnosticServerName(diagnostic.path),
      level: diagnostic.severity,
      message: persistedDiagnosticMessage(diagnostic.message),
      ...(code === undefined ? {} : { code }),
      ...(source === undefined ? {} : { source }),
    });
  }

  private publishDescriptorLimitDiagnostic(
    serverName: string,
    kind: "server" | "tool" | "prompt" | "resource",
    originalCount: number,
    emittedCount: number,
  ): void {
    this.publish("mcp.diagnostic", {
      serverName,
      level: "warning",
      code: "descriptor_catalog_truncated",
      source: "runtime",
      message: `MCP ${kind} descriptors were truncated by safety limits (${emittedCount} of ${originalCount} retained).`,
    });
  }

  private publish<TType extends RuntimeEvent["type"]>(
    type: TType,
    payload: Extract<RuntimeEvent, { type: TType }>["payload"],
  ): void {
    if (!this.options.events || this.lifecycle !== "open") return;
    const event = {
      id: this.options.createId?.("event") ?? `event_${globalThis.crypto.randomUUID().replaceAll("-", "")}`,
      type,
      time: Date.now() as TimestampMs,
      payload,
    } as Extract<RuntimeEvent, { type: TType }>;
    const settlement = createDeferred<void>();
    this.eventPublications.add(settlement.promise);
    let publication: Promise<void>;
    try {
      publication = Promise.resolve(this.options.events.publish(event as RuntimeEvent));
    } catch {
      publication = Promise.resolve();
    }
    const settle = (): void => {
      this.eventPublications.delete(settlement.promise);
      settlement.resolve();
    };
    void publication.then(settle, settle);
  }
}

export async function createHostMcpRuntime(
  options: HostMcpRuntimeOptions,
  baseCommands: PromptCommandControl,
): Promise<HostMcpRuntime> {
  const runtime = new HostMcpRuntimeImpl(options, baseCommands);
  try {
    await runtime.start();
    return runtime;
  } catch (error) {
    const normalized = normalizePersistedError(error);
    try {
      await runtime.close();
    } catch (closeError) {
      throw new AggregateError(
        [normalized, normalizePersistedError(closeError)],
        "MCP runtime startup and cleanup failed",
      );
    }
    throw normalized;
  }
}

function createCompositePromptCommandControl(
  base: PromptCommandControl,
  mcp: HostMcpRuntimeImpl,
): PromptCommandControl {
  return {
    async list(input) {
      mcp.assertOpen();
      const [baseCatalog, dynamicCommands] = await Promise.all([
        base.list(input),
        mcp.promptCommands(input?.cwd),
      ]);
      mcp.assertOpen();
      return mergeRuntimeCommandCatalogs(baseCatalog, mcpCommandCatalog(dynamicCommands));
    },
    async reload(input) {
      mcp.assertOpen();
      const [baseCatalog, dynamicCommands] = await Promise.all([
        base.reload(input),
        mcp.promptCommands(input?.cwd),
      ]);
      mcp.assertOpen();
      return mergeRuntimeCommandCatalogs(baseCatalog, mcpCommandCatalog(dynamicCommands));
    },
    async run(input) {
      mcp.assertOpen();
      const baseCatalog = await base.list(input.cwd ? { cwd: input.cwd } : undefined);
      mcp.assertOpen();
      if (findRuntimeCommandNode(baseCatalog.roots, input.commandId)) {
        mcp.assertOpen();
        return base.run(input);
      }

      const dynamicCommands = await mcp.promptCommands(input.cwd);
      mcp.assertOpen();
      const dynamicCatalog = mcpCommandCatalog(dynamicCommands);
      const mergedCatalog = mergeRuntimeCommandCatalogs(baseCatalog, dynamicCatalog);
      if (!findRuntimeCommandNode(mergedCatalog.roots, input.commandId)) {
        mcp.assertOpen();
        return base.run(input);
      }

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
    const serialized = serializeCommandCatalog(registry, context);
    if (jsonUtf8Bytes(serialized) > MCP_DESCRIPTOR_LIMITS.catalogJsonBytes) {
      throw descriptorLimitError("prompt", "command catalog aggregate");
    }
    const descriptor = findRuntimeCommandNode(serialized.roots, command.id);
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
      trustedByUser: trustedUserServers.has(mcpServerIdentity(server)),
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
    .map((server) => mcpServerIdentity(server)));
}

async function readJsonIfExists(path: string | undefined, errors: RuntimeMcpReloadError[]): Promise<unknown> {
  if (!path) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    errors.push({ message: `MCP configuration could not be read: ${persistedDiagnosticMessage(error)}` });
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

const MCP_DESCRIPTOR_LIMITS = {
  catalogItems: 128,
  nestedItems: 32,
  structuredItems: 32,
  structuredDepth: 8,
  structuredNodes: 512,
  identityBytes: 512,
  uriBytes: 4 * 1024,
  fieldBytes: 2 * 1024,
  descriptionBytes: 8 * 1024,
  diagnosticMessageJsonBytes: 12 * 1024,
  structuredStringBytes: 4 * 1024,
  structuredJsonBytes: 32 * 1024,
  itemJsonBytes: 64 * 1024,
  catalogJsonBytes: 256 * 1024,
} as const;

const MCP_MIN_MARKER_JSON_BYTES = 16;

interface BoundedMcpCatalog<T> {
  serverName: string;
  items: T[];
  originalCount: number;
  truncated: boolean;
}

function unwrapManagedMcpItems<T>(
  source: readonly unknown[],
  field: "tool" | "prompt" | "resource",
): { items: T[]; originalCount: number } {
  const originalCount = safeCollectionLength(source);
  const items: T[] = [];
  for (let index = 0; index < Math.min(originalCount, MCP_DESCRIPTOR_LIMITS.catalogItems); index += 1) {
    const wrapper = safeArrayItem(source, index);
    if (!isRecord(wrapper)) continue;
    const item = safeGet(wrapper, field);
    if (item !== undefined) items.push(item as T);
  }
  return { items, originalCount };
}

function sanitizeMcpDiagnostic(diagnostic: McpDiagnostic): McpDiagnostic {
  return {
    severity: diagnostic.severity,
    code: safeDisplayText(diagnostic.code, "MCP diagnostic code", MCP_DESCRIPTOR_LIMITS.identityBytes),
    message: persistedDiagnosticMessage(diagnostic.message),
    path: safeDisplayText(diagnostic.path, "MCP diagnostic path", MCP_DESCRIPTOR_LIMITS.fieldBytes),
    source: diagnostic.source,
  };
}

function boundMcpDiagnostics(diagnostics: readonly McpDiagnostic[]): McpDiagnostic[] {
  const count = safeCollectionLength(diagnostics);
  const retained: McpDiagnostic[] = [];
  const limit = MCP_DESCRIPTOR_LIMITS.catalogItems - 1;
  for (let index = 0; index < Math.min(count, limit); index += 1) {
    const diagnostic = safeArrayItem(diagnostics, index);
    if (diagnostic) retained.push(sanitizeMcpDiagnostic(diagnostic));
  }
  if (count > retained.length) {
    retained.push({
      severity: "warning",
      code: "diagnostic_catalog_truncated",
      message: `Additional MCP diagnostics were omitted by safety limits (${retained.length} of ${count} retained).`,
      path: "$",
      source: retained[0]?.source ?? "user",
    });
  }
  return retained;
}

function appendMcpDiagnostic(current: readonly McpDiagnostic[], diagnostic: McpDiagnostic): McpDiagnostic[] {
  const limit = MCP_DESCRIPTOR_LIMITS.catalogItems;
  if (current.length >= limit) return [...current];
  if (current.length === limit - 1) {
    return [...current, {
      severity: "warning",
      code: "diagnostic_catalog_truncated",
      message: "Additional MCP diagnostics were omitted by safety limits.",
      path: "$",
      source: diagnostic.source,
    }];
  }
  return [...current, diagnostic];
}

function sanitizeMcpLoadError(error: RuntimeMcpReloadError): RuntimeMcpReloadError {
  const result: RuntimeMcpReloadError = { message: persistedDiagnosticMessage(error.message) };
  if (error.server !== undefined) {
    result.server = safeIdentity(error.server, "MCP server name", MCP_DESCRIPTOR_LIMITS.identityBytes);
  }
  return result;
}

function boundMcpLoadErrors(
  errors: readonly RuntimeMcpReloadError[],
  diagnostics: readonly McpDiagnostic[],
): RuntimeMcpReloadError[] {
  let result: RuntimeMcpReloadError[] = [];
  for (let index = 0; index < safeCollectionLength(errors); index += 1) {
    if (result.length >= MCP_DESCRIPTOR_LIMITS.catalogItems) break;
    const error = safeArrayItem(errors, index);
    if (error) result = appendMcpLoadError(result, sanitizeMcpLoadError(error));
  }
  for (const diagnostic of diagnostics) {
    if (result.length >= MCP_DESCRIPTOR_LIMITS.catalogItems) break;
    result = appendMcpLoadError(result, diagnosticError(diagnostic));
  }
  return result;
}

function appendMcpLoadError(
  current: readonly RuntimeMcpReloadError[],
  error: RuntimeMcpReloadError,
): RuntimeMcpReloadError[] {
  const limit = MCP_DESCRIPTOR_LIMITS.catalogItems;
  if (current.length >= limit) return [...current];
  if (current.length === limit - 1) {
    return [...current, { message: "Additional MCP reload diagnostics were omitted by safety limits." }];
  }
  return [...current, sanitizeMcpLoadError(error)];
}

function boundMcpToolCatalog(
  serverName: string,
  tools: readonly McpTool[],
  originalCount?: number,
): BoundedMcpCatalog<McpToolRef> {
  return boundMcpCatalog(serverName, tools, "tool", (tool, safeServerName) => {
    if (!isRecord(tool)) throw descriptorLimitError("tool", "item");
    const descriptor: McpToolRef = {
      serverName: safeServerName,
      name: safeIdentity(tool.name, "MCP tool name", MCP_DESCRIPTOR_LIMITS.identityBytes),
    };
    if (typeof tool.title === "string") {
      descriptor.title = safeDisplayText(tool.title, "MCP tool title", MCP_DESCRIPTOR_LIMITS.fieldBytes);
    }
    if (typeof tool.description === "string") {
      descriptor.description = safeDisplayText(
        tool.description,
        "MCP tool description",
        MCP_DESCRIPTOR_LIMITS.descriptionBytes,
      );
    }
    if (tool.inputSchema !== undefined) {
      const schema = boundMcpJsonValue(tool.inputSchema, "MCP tool input schema");
      if (!isRecord(schema)) throw descriptorLimitError("tool", "input schema");
      descriptor.inputSchema = schema;
    }
    if (tool.annotations !== undefined) {
      const annotations = boundMcpJsonValue(tool.annotations, "MCP tool annotations");
      if (!isRecord(annotations)) throw descriptorLimitError("tool", "annotations");
      descriptor.annotations = annotations;
    }
    return descriptor;
  }, originalCount);
}

function boundMcpPromptCatalog(
  serverName: string,
  prompts: readonly McpPrompt[],
  originalCount?: number,
): BoundedMcpCatalog<McpPromptRef> {
  return boundMcpCatalog(serverName, prompts, "prompt", (prompt, safeServerName) => {
    if (!isRecord(prompt)) throw descriptorLimitError("prompt", "item");
    const descriptor: McpPromptRef = {
      serverName: safeServerName,
      name: safeIdentity(prompt.name, "MCP prompt name", MCP_DESCRIPTOR_LIMITS.identityBytes),
    };
    if (typeof prompt.title === "string") {
      descriptor.title = safeDisplayText(prompt.title, "MCP prompt title", MCP_DESCRIPTOR_LIMITS.fieldBytes);
    }
    if (typeof prompt.description === "string") {
      descriptor.description = safeDisplayText(
        prompt.description,
        "MCP prompt description",
        MCP_DESCRIPTOR_LIMITS.descriptionBytes,
      );
    }
    if (prompt.arguments !== undefined) {
      const argumentCount = safeCollectionLength(prompt.arguments);
      if (argumentCount > MCP_DESCRIPTOR_LIMITS.nestedItems) throw descriptorLimitError("prompt", "nested count");
      descriptor.arguments = [];
      for (let index = 0; index < argumentCount; index += 1) {
        const argument = safeArrayItem(prompt.arguments, index);
        if (!isRecord(argument)) throw descriptorLimitError("prompt", "argument");
        descriptor.arguments.push({
          name: safeIdentity(argument.name, "MCP prompt argument name", MCP_DESCRIPTOR_LIMITS.identityBytes),
          required: argument.required === true,
          ...(typeof argument.description === "string" ? {
            description: safeDisplayText(
              argument.description,
              "MCP prompt argument description",
              MCP_DESCRIPTOR_LIMITS.fieldBytes,
            ),
          } : {}),
        });
      }
    }
    return descriptor;
  }, originalCount);
}

function boundMcpResourceCatalog(
  serverName: string,
  resources: readonly McpResource[],
  originalCount?: number,
): BoundedMcpCatalog<McpResourceRef> {
  return boundMcpCatalog(serverName, resources, "resource", (resource, safeServerName) => {
    if (!isRecord(resource)) throw descriptorLimitError("resource", "item");
    return {
      serverName: safeServerName,
      uri: safeIdentity(resource.uri, "MCP resource URI", MCP_DESCRIPTOR_LIMITS.uriBytes),
      ...(typeof resource.name === "string" ? {
        name: safeDisplayText(resource.name, "MCP resource name", MCP_DESCRIPTOR_LIMITS.fieldBytes),
      } : {}),
      ...(typeof resource.title === "string" ? {
        title: safeDisplayText(resource.title, "MCP resource title", MCP_DESCRIPTOR_LIMITS.fieldBytes),
      } : {}),
      ...(typeof resource.description === "string" ? {
        description: safeDisplayText(
          resource.description,
          "MCP resource description",
          MCP_DESCRIPTOR_LIMITS.descriptionBytes,
        ),
      } : {}),
      ...(typeof resource.mimeType === "string" ? {
        mimeType: safeDisplayText(resource.mimeType, "MCP resource MIME type", MCP_DESCRIPTOR_LIMITS.fieldBytes),
      } : {}),
    };
  }, originalCount);
}

function boundMcpPromptDefinitions(
  prompts: ReturnType<McpClientManager["listPrompts"]>,
): BoundedMcpCatalog<McpPromptDefinition> {
  const originalCount = safeCollectionLength(prompts);
  const items: McpPromptDefinition[] = [];
  let bytes = 2;
  let truncated = originalCount > MCP_DESCRIPTOR_LIMITS.catalogItems;
  for (let index = 0; index < Math.min(originalCount, MCP_DESCRIPTOR_LIMITS.catalogItems); index += 1) {
    const prompt = safeArrayItem(prompts, index);
    try {
      if (!prompt) throw descriptorLimitError("prompt", "item");
      const descriptor = toPromptDefinition(prompt);
      const itemBytes = jsonUtf8Bytes(descriptor);
      const nextBytes = bytes + (items.length === 0 ? 0 : 1) + itemBytes;
      if (itemBytes > MCP_DESCRIPTOR_LIMITS.itemJsonBytes || nextBytes > MCP_DESCRIPTOR_LIMITS.catalogJsonBytes) {
        truncated = true;
        break;
      }
      items.push(descriptor);
      bytes = nextBytes;
    } catch {
      truncated = true;
    }
  }
  return { serverName: "multiple", items, originalCount, truncated };
}

function boundMcpCatalog<TInput, TOutput>(
  serverName: string,
  source: readonly TInput[],
  kind: "tool" | "prompt" | "resource",
  convert: (input: TInput, safeServerName: string) => TOutput,
  declaredOriginalCount?: number,
): BoundedMcpCatalog<TOutput> {
  const sourceCount = safeCollectionLength(source);
  const originalCount = declaredOriginalCount === undefined
    ? sourceCount
    : (Number.isSafeInteger(declaredOriginalCount) && declaredOriginalCount >= sourceCount
      ? declaredOriginalCount
      : sourceCount);
  let safeServerName: string;
  try {
    safeServerName = safeIdentity(serverName, "MCP server name", MCP_DESCRIPTOR_LIMITS.identityBytes);
  } catch {
    return { serverName: "unknown", items: [], originalCount, truncated: true };
  }
  const items: TOutput[] = [];
  let bytes = 2;
  let truncated = originalCount !== sourceCount || originalCount > MCP_DESCRIPTOR_LIMITS.catalogItems;
  for (let index = 0; index < Math.min(sourceCount, MCP_DESCRIPTOR_LIMITS.catalogItems); index += 1) {
    const input = safeArrayItem(source, index);
    try {
      if (input === undefined) throw descriptorLimitError(kind, "item");
      const descriptor = convert(input, safeServerName);
      const itemBytes = jsonUtf8Bytes(descriptor);
      const nextBytes = bytes + (items.length === 0 ? 0 : 1) + itemBytes;
      if (itemBytes > MCP_DESCRIPTOR_LIMITS.itemJsonBytes || nextBytes > MCP_DESCRIPTOR_LIMITS.catalogJsonBytes) {
        truncated = true;
        break;
      }
      items.push(descriptor);
      bytes = nextBytes;
    } catch {
      truncated = true;
    }
  }
  return { serverName: safeServerName, items, originalCount, truncated };
}

function requireCompleteCatalog<T>(
  catalog: BoundedMcpCatalog<T>,
  kind: "tool" | "prompt" | "resource",
): void {
  if (catalog.truncated || catalog.items.length !== catalog.originalCount) {
    throw descriptorLimitError(kind, "catalog");
  }
}

function requireBoundedFlatCatalog<T>(items: readonly T[], kind: "resource" | "diagnostic"): T[] {
  if (items.length > MCP_DESCRIPTOR_LIMITS.catalogItems) throw descriptorLimitError(kind, "count");
  const result: T[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = jsonUtf8Bytes(item);
    const nextBytes = bytes + (result.length === 0 ? 0 : 1) + itemBytes;
    if (itemBytes > MCP_DESCRIPTOR_LIMITS.itemJsonBytes || nextBytes > MCP_DESCRIPTOR_LIMITS.catalogJsonBytes) {
      throw descriptorLimitError(kind, "aggregate");
    }
    result.push(item);
    bytes = nextBytes;
  }
  return result;
}

function boundMcpJsonValue(value: unknown, label: string): unknown {
  const limits = MCP_DESCRIPTOR_LIMITS;
  return visitMcpJsonValue(value, label, {
    nodes: 0,
    seen: new WeakSet<object>(),
  }, 0, limits.structuredJsonBytes);
}

function visitMcpJsonValue(
  value: unknown,
  label: string,
  state: { nodes: number; seen: WeakSet<object> },
  depth: number,
  budget: number,
): unknown {
  state.nodes += 1;
  if (state.nodes > MCP_DESCRIPTOR_LIMITS.structuredNodes) {
    return fitJsonString(`[omitted: ${label} node limit exceeded]`, budget, label);
  }
  if (typeof value === "string") {
    const sanitized = safeDisplayText(value, label, MCP_DESCRIPTOR_LIMITS.structuredStringBytes);
    return fitJsonString(sanitized, budget, label);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return fitJsonString(`[omitted: unsupported ${label} value]`, budget, label);
  if (depth >= MCP_DESCRIPTOR_LIMITS.structuredDepth) {
    return fitJsonString(`[omitted: ${label} depth limit exceeded]`, budget, label);
  }
  if (state.seen.has(value)) return fitJsonString(`[omitted: circular ${label}]`, budget, label);
  state.seen.add(value);

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    const length = safeCollectionLength(value);
    let bytes = 2;
    let omitted = length > MCP_DESCRIPTOR_LIMITS.structuredItems;
    for (let index = 0; index < Math.min(length, MCP_DESCRIPTOR_LIMITS.structuredItems); index += 1) {
      const separatorBytes = result.length === 0 ? 0 : 1;
      const childBudget = budget - bytes - separatorBytes;
      if (childBudget < MCP_MIN_MARKER_JSON_BYTES) {
        omitted = true;
        break;
      }
      const child = visitMcpJsonValue(safeArrayItem(value, index), label, state, depth + 1, childBudget);
      const childBytes = jsonUtf8Bytes(child);
      if (childBytes > childBudget) {
        omitted = true;
        break;
      }
      result.push(child);
      bytes += separatorBytes + childBytes;
    }
    if (omitted) appendMcpArrayMarker(result, `[omitted: additional ${label} items]`, budget);
    return result;
  }

  const result = Object.create(null) as Record<string, unknown>;
  let bytes = 2;
  let entries = 0;
  let omitted = false;
  try {
    for (const rawKey in value) {
      if (!safeHasOwn(value, rawKey)) continue;
      if (entries >= MCP_DESCRIPTOR_LIMITS.structuredItems) {
        omitted = true;
        break;
      }
      entries += 1;
      let key = safeDisplayText(rawKey, `${label} key`, MCP_DESCRIPTOR_LIMITS.identityBytes);
      if (Object.prototype.hasOwnProperty.call(result, key)) key = `field_${entries}`;
      const separatorBytes = Object.keys(result).length === 0 ? 0 : 1;
      const prefixBytes = separatorBytes + jsonUtf8Bytes(key) + 1;
      const childBudget = budget - bytes - prefixBytes;
      if (childBudget < MCP_MIN_MARKER_JSON_BYTES) {
        omitted = true;
        break;
      }
      const child = visitMcpJsonValue(safeGet(value, rawKey), label, state, depth + 1, childBudget);
      const childBytes = jsonUtf8Bytes(child);
      if (childBytes > childBudget) {
        omitted = true;
        break;
      }
      result[key] = child;
      bytes += prefixBytes + childBytes;
    }
  } catch {
    omitted = true;
  }
  if (omitted) appendMcpRecordMarker(result, `additional ${label} fields omitted`, budget);
  return result;
}

function appendMcpArrayMarker(result: unknown[], marker: string, budget: number): void {
  while (true) {
    const separatorBytes = result.length === 0 ? 0 : 1;
    const available = budget - jsonUtf8Bytes(result) - separatorBytes;
    const boundedMarker = jsonUtf8Bytes(marker) <= available ? marker : "[omitted]";
    if (jsonUtf8Bytes(boundedMarker) <= available) {
      result.push(boundedMarker);
      return;
    }
    if (result.length === 0) return;
    result.pop();
  }
}

function appendMcpRecordMarker(result: Record<string, unknown>, marker: string, budget: number): void {
  const key = Object.prototype.hasOwnProperty.call(result, "__omitted__") ? "__chili_omitted__" : "__omitted__";
  while (true) {
    const separatorBytes = Object.keys(result).length === 0 ? 0 : 1;
    const available = budget - jsonUtf8Bytes(result) - separatorBytes - jsonUtf8Bytes(key) - 1;
    const boundedMarker = jsonUtf8Bytes(marker) <= available ? marker : "[omitted]";
    if (jsonUtf8Bytes(boundedMarker) <= available) {
      result[key] = boundedMarker;
      return;
    }
    const lastKey = Object.keys(result).at(-1);
    if (lastKey === undefined) return;
    delete result[lastKey];
  }
}

function fitJsonString(value: string, budget: number, label: string): string {
  return fitJsonStringWithMarker(value, budget, `\n[${label} truncated]`);
}

function fitJsonStringWithMarker(value: string, budget: number, marker: string): string {
  if (budget < 2) return "";
  if (jsonUtf8Bytes(value) <= budget) return value;
  const minimumMarker = "\n[truncated]";
  const boundedMarker = jsonUtf8Bytes(marker) <= budget
    ? marker
    : (jsonUtf8Bytes(minimumMarker) <= budget ? minimumMarker : "");
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonUtf8Bytes(`${safeUtf16Prefix(value, middle)}${boundedMarker}`) <= budget) low = middle;
    else high = middle - 1;
  }
  return `${safeUtf16Prefix(value, low)}${boundedMarker}`;
}

function persistedDiagnosticMessage(value: unknown): string {
  const normalized = normalizePersistedError(value);
  const originalBytes = normalized.persistedErrorDetails.originalMessageBytes ?? utf8Bytes(normalized.message);
  return fitJsonStringWithMarker(
    normalized.message,
    MCP_DESCRIPTOR_LIMITS.diagnosticMessageJsonBytes,
    `\n[MCP diagnostic message truncated from ${originalBytes} bytes]`,
  );
}

function safeDisplayText(value: string, label: string, maxBytes: number): string {
  const normalized = normalizePersistedError(new Error(value));
  if (utf8Bytes(normalized.message) <= maxBytes) return normalized.message;
  const originalBytes = normalized.persistedErrorDetails.originalMessageBytes ?? utf8Bytes(value);
  const marker = `\n[${label} truncated from ${originalBytes} bytes]`;
  const markerBytes = utf8Bytes(marker);
  const prefix = truncateUtf8(normalized.message, Math.max(0, maxBytes - markerBytes));
  return `${prefix}${truncateUtf8(marker, Math.max(0, maxBytes - utf8Bytes(prefix)))}`;
}

function safeOptionalDisplayText(value: unknown, label: string, maxBytes: number): string | undefined {
  return typeof value === "string" ? safeDisplayText(value, label, maxBytes) : undefined;
}

function safeIdentity(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) throw descriptorLimitError(label, "identity");
  const normalized = normalizePersistedError(new Error(value));
  if (normalized.message !== value
    || normalized.persistedErrorDetails.truncated === true
    || utf8Bytes(value) > maxBytes
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw descriptorLimitError(label, "identity");
  }
  return value;
}

function safeDiagnosticServerName(path: unknown): string {
  if (typeof path !== "string" || !path.startsWith("servers.")) return "unknown";
  try {
    return safeIdentity(path.slice("servers.".length), "MCP server name", MCP_DESCRIPTOR_LIMITS.identityBytes);
  } catch {
    return "unknown";
  }
}

function boundStringList(values: readonly string[], label: string): string[] {
  const count = safeCollectionLength(values);
  if (count > MCP_DESCRIPTOR_LIMITS.nestedItems) throw descriptorLimitError(label, "count");
  const result: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = safeArrayItem(values, index);
    if (typeof value !== "string") throw descriptorLimitError(label, "item");
    result.push(safeDisplayText(value, label, MCP_DESCRIPTOR_LIMITS.fieldBytes));
  }
  if (jsonUtf8Bytes(result) > MCP_DESCRIPTOR_LIMITS.itemJsonBytes) throw descriptorLimitError(label, "aggregate");
  return result;
}

function boundedOwnStringKeys(value: object, label: string): string[] {
  const result: string[] = [];
  try {
    for (const rawKey in value) {
      if (!safeHasOwn(value, rawKey)) continue;
      if (result.length >= MCP_DESCRIPTOR_LIMITS.nestedItems) throw descriptorLimitError(label, "count");
      result.push(safeDisplayText(rawKey, label, MCP_DESCRIPTOR_LIMITS.fieldBytes));
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MCP ")) throw error;
    throw descriptorLimitError(label, "keys");
  }
  return result;
}

function descriptorLimitError(kind: string, limit: string): Error {
  return normalizePersistedError(new Error(`MCP ${kind} descriptor exceeds the safe ${limit} limit.`));
}

function safeCollectionLength(value: { readonly length: number }): number {
  try {
    const length = Reflect.get(value, "length");
    return typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : 0;
  } catch {
    return 0;
  }
}

function safeArrayItem<T>(value: readonly T[], index: number): T | undefined {
  try {
    return Reflect.get(value, String(index)) as T | undefined;
  } catch {
    return undefined;
  }
}

function safeGet(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return `[omitted: ${key} getter threw]`;
  }
}

function safeHasOwn(value: object, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    return false;
  }
}

function jsonUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? Number.POSITIVE_INFINITY : utf8Bytes(serialized);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(safeUtf16Prefix(value, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return safeUtf16Prefix(value, low);
}

function safeUtf16Prefix(value: string, end: number): string {
  let safeEnd = end;
  if (safeEnd > 0) {
    const code = value.charCodeAt(safeEnd - 1);
    if (code >= 0xd800 && code <= 0xdbff) safeEnd -= 1;
  }
  return value.slice(0, safeEnd);
}

function toRuntimeServerDescriptor(state: McpServerState): RuntimeMcpServerDescriptor {
  const server = state.server;
  const descriptor: RuntimeMcpServerDescriptor = {
    name: safeIdentity(server.name, "MCP server name", MCP_DESCRIPTOR_LIMITS.identityBytes),
    status: toRuntimeStatus(state.status),
    enabled: server.enabled,
    transport: server.type,
    auth: serverAuthDescriptor(server),
    toolCount: safeCollectionLength(state.tools),
    updatedAt: Date.now(),
  };
  if (server.type === "stdio") {
    descriptor.command = safeDisplayText(server.command, "MCP command", MCP_DESCRIPTOR_LIMITS.fieldBytes);
    descriptor.args = boundStringList(server.args, "MCP command argument");
  } else {
    descriptor.url = safeDisplayText(server.url, "MCP server URL", MCP_DESCRIPTOR_LIMITS.fieldBytes);
  }
  if (typeof server.raw.description === "string") {
    descriptor.description = safeDisplayText(
      server.raw.description,
      "MCP server description",
      MCP_DESCRIPTOR_LIMITS.descriptionBytes,
    );
  }
  if (state.error) descriptor.error = persistedDiagnosticMessage(state.error);
  if (jsonUtf8Bytes(descriptor) > MCP_DESCRIPTOR_LIMITS.itemJsonBytes) {
    throw descriptorLimitError("server", "item");
  }
  return descriptor;
}

function boundedServerDescriptors(states: readonly McpServerState[]): RuntimeMcpServerDescriptor[] {
  const count = safeCollectionLength(states);
  if (count > MCP_DESCRIPTOR_LIMITS.catalogItems) throw descriptorLimitError("server", "count");
  const descriptors: RuntimeMcpServerDescriptor[] = [];
  let bytes = 2;
  for (let index = 0; index < count; index += 1) {
    const state = safeArrayItem(states, index);
    if (!state) throw descriptorLimitError("server", "item");
    const descriptor = toRuntimeServerDescriptor(state);
    const itemBytes = jsonUtf8Bytes(descriptor);
    const nextBytes = bytes + (descriptors.length === 0 ? 0 : 1) + itemBytes;
    if (nextBytes > MCP_DESCRIPTOR_LIMITS.catalogJsonBytes) throw descriptorLimitError("server", "aggregate");
    descriptors.push(descriptor);
    bytes = nextBytes;
  }
  return descriptors;
}

function toRuntimeStatus(status: McpServerState["status"]): RuntimeMcpServerStatus {
  if (status === "disabled") return "disabled";
  if (status === "disconnected") return "stopped";
  if (status === "connecting") return "starting";
  if (status === "connected") return "running";
  return "error";
}

function protocolStatus(status: McpServerState["status"]): Extract<RuntimeEvent, { type: "mcp.server_status_changed" }>["payload"]["status"] {
  if (status === "disabled") return "disabled";
  if (status === "disconnected") return "stopped";
  if (status === "connecting") return "starting";
  if (status === "connected") return "running";
  return "failed";
}

function serverConfigSummary(server: McpServerConfig): NonNullable<Extract<RuntimeEvent, { type: "mcp.server_status_changed" }>["payload"]["config"]> {
  const summary: NonNullable<Extract<RuntimeEvent, { type: "mcp.server_status_changed" }>["payload"]["config"]> = {
    name: safeIdentity(server.name, "MCP server name", MCP_DESCRIPTOR_LIMITS.identityBytes),
    enabled: server.enabled,
    transport: server.type,
  };
  if (server.type === "stdio") {
    summary.command = safeDisplayText(server.command, "MCP command", MCP_DESCRIPTOR_LIMITS.fieldBytes);
    summary.args = boundStringList(server.args, "MCP command argument");
    if (server.env) {
      summary.envKeys = boundedOwnStringKeys(server.env, "MCP environment key").sort();
    }
  } else {
    summary.url = safeDisplayText(server.url, "MCP server URL", MCP_DESCRIPTOR_LIMITS.fieldBytes);
  }
  if (server.startupTimeoutMs !== undefined) summary.timeoutMs = server.startupTimeoutMs;
  if (jsonUtf8Bytes(summary) > MCP_DESCRIPTOR_LIMITS.itemJsonBytes) throw descriptorLimitError("server", "item");
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
  return boundedScopedStateEntries(view, "server").map((entry) => entry.state);
}

function scopedToolDefinitions(
  view: McpScopeView,
  assertOpen: () => void,
  elicitation: McpToolElicitationHandler,
): ReturnType<typeof createMcpChiliTools> {
  const definitions: ReturnType<typeof createMcpChiliTools> = [];
  let descriptorBytes = 2;
  for (const { state, manager } of boundedScopedStateEntries(view, "tool")) {
    if (state.status !== "connected") continue;
    const tools = boundedToolsForExecution(state.server.name, state.tools);
    if (definitions.length + tools.length > MCP_DESCRIPTOR_LIMITS.catalogItems) {
      throw descriptorLimitError("tool", "catalog count");
    }
    const toolsBytes = jsonUtf8Bytes(tools);
    if (descriptorBytes + toolsBytes > MCP_DESCRIPTOR_LIMITS.catalogJsonBytes) {
      throw descriptorLimitError("tool", "catalog aggregate");
    }
    definitions.push(...createMcpChiliTools(state.server, tools, {
      getToolRevision: (serverName, toolName) => manager.getToolRevision(serverName, toolName),
      callTool(serverName, toolName, input, signal, revision, interaction) {
        assertOpen();
        return manager.callTool(serverName, toolName, input, signal, revision, interaction);
      },
    }, elicitation));
    descriptorBytes += toolsBytes;
  }
  if (jsonUtf8Bytes(definitions) > MCP_DESCRIPTOR_LIMITS.catalogJsonBytes) {
    throw descriptorLimitError("tool", "catalog aggregate");
  }
  return definitions;
}

function boundedToolsForExecution(serverName: string, tools: readonly McpTool[]): McpTool[] {
  const catalog = boundMcpToolCatalog(serverName, tools);
  requireCompleteCatalog(catalog, "tool");
  return catalog.items.map(({ serverName: _serverName, ...tool }, index) => {
    const originalSchema = tools[index]?.inputSchema;
    if (originalSchema !== undefined) {
      const schema = validateStructuredToolData(originalSchema);
      if (mcpDefinitionFingerprint(schema) !== mcpDefinitionFingerprint(tool.inputSchema)) {
        throw new Error("MCP tool input schema cannot be represented without changing its definition");
      }
    }
    return tool;
  });
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
  const result: ReturnType<McpClientManager["listPrompts"]> = [];
  for (const { state } of boundedScopedStateEntries(view, "prompt")) {
    if (state.status !== "connected") continue;
    const count = safeCollectionLength(state.prompts);
    for (let index = 0; index < count; index += 1) {
      if (result.length > MCP_DESCRIPTOR_LIMITS.catalogItems) return result;
      const prompt = safeArrayItem(state.prompts, index);
      if (!prompt) throw descriptorLimitError("prompt", "item");
      result.push({ server: state.server, prompt });
    }
  }
  return result;
}

function scopedResources(view: McpScopeView): ReturnType<McpClientManager["listResources"]> {
  const result: ReturnType<McpClientManager["listResources"]> = [];
  for (const { state } of boundedScopedStateEntries(view, "resource")) {
    if (state.status !== "connected") continue;
    const count = safeCollectionLength(state.resources);
    for (let index = 0; index < count; index += 1) {
      if (result.length > MCP_DESCRIPTOR_LIMITS.catalogItems) return result;
      const resource = safeArrayItem(state.resources, index);
      if (!resource) throw descriptorLimitError("resource", "item");
      result.push({ server: state.server, resource });
    }
  }
  return result;
}

function boundedScopedStateEntries(
  view: McpScopeView,
  kind: "server" | "tool" | "prompt" | "resource",
): Array<{ state: McpServerState; manager: McpClientManager }> {
  const userStates = view.user.manager.listStates();
  const projectStates = view.project?.manager.listStates() ?? [];
  if (userStates.length > MCP_DESCRIPTOR_LIMITS.catalogItems
    || projectStates.length > MCP_DESCRIPTOR_LIMITS.catalogItems) {
    throw descriptorLimitError(kind, "server count");
  }
  const projectNames = new Set(projectStates.map((state) => state.server.name));
  const entries: Array<{ state: McpServerState; manager: McpClientManager }> = [];
  for (const state of userStates) {
    if (!projectNames.has(state.server.name)) entries.push({ state, manager: view.user.manager });
  }
  if (view.project) {
    for (const state of projectStates) entries.push({ state, manager: view.project.manager });
  }
  if (entries.length > MCP_DESCRIPTOR_LIMITS.catalogItems) throw descriptorLimitError(kind, "server count");
  return entries;
}

function scopedLoadErrors(view: McpScopeView): RuntimeMcpReloadError[] {
  const userErrors = view.user.loadErrors;
  const projectErrors = view.project?.loadErrors ?? [];
  if (userErrors.length + projectErrors.length > MCP_DESCRIPTOR_LIMITS.catalogItems) {
    throw descriptorLimitError("diagnostic", "count");
  }
  const errors: RuntimeMcpReloadError[] = [];
  for (const source of [userErrors, projectErrors]) {
    for (const error of source) errors.push(sanitizeMcpLoadError(error));
  }
  return requireBoundedFlatCatalog(errors, "diagnostic");
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
    serverName: safeIdentity(resource.server.name, "MCP server name", MCP_DESCRIPTOR_LIMITS.identityBytes),
    uri: safeIdentity(resource.resource.uri, "MCP resource URI", MCP_DESCRIPTOR_LIMITS.uriBytes),
    ...(resource.resource.name ? {
      name: safeDisplayText(resource.resource.name, "MCP resource name", MCP_DESCRIPTOR_LIMITS.fieldBytes),
    } : {}),
    ...(resource.resource.description ? {
      description: safeDisplayText(
        resource.resource.description,
        "MCP resource description",
        MCP_DESCRIPTOR_LIMITS.descriptionBytes,
      ),
    } : {}),
    ...(resource.resource.mimeType ? {
      mimeType: safeDisplayText(resource.resource.mimeType, "MCP resource MIME type", MCP_DESCRIPTOR_LIMITS.fieldBytes),
    } : {}),
  };
}

function firstResourceContent(result: McpReadResourceResult, fallbackUri: string): McpReadResourceResult["contents"][number] {
  const first = result.contents[0];
  if (!first) return { uri: fallbackUri, text: "" };
  return first;
}

function toPromptDefinition(prompt: { server: McpServerConfig; prompt: McpPrompt }): McpPromptDefinition {
  const definition: McpPromptDefinition = {
    serverName: safeIdentity(prompt.server.name, "MCP server name", MCP_DESCRIPTOR_LIMITS.identityBytes),
    name: safeIdentity(prompt.prompt.name, "MCP prompt name", MCP_DESCRIPTOR_LIMITS.identityBytes),
  };
  if (prompt.prompt.description !== undefined) {
    definition.description = safeDisplayText(
      prompt.prompt.description,
      "MCP prompt description",
      MCP_DESCRIPTOR_LIMITS.descriptionBytes,
    );
  }
  if (prompt.prompt.arguments !== undefined) {
    const argumentCount = safeCollectionLength(prompt.prompt.arguments);
    if (argumentCount > MCP_DESCRIPTOR_LIMITS.nestedItems) {
      throw descriptorLimitError("prompt", "nested count");
    }
    const argumentsList: Array<NonNullable<McpPromptDefinition["arguments"]>[number]> = [];
    for (let index = 0; index < argumentCount; index += 1) {
      const argument = safeArrayItem(prompt.prompt.arguments, index);
      if (!argument) throw descriptorLimitError("prompt", "argument");
      argumentsList.push({
        name: safeIdentity(argument.name, "MCP prompt argument name", MCP_DESCRIPTOR_LIMITS.identityBytes),
        ...(argument.description === undefined ? {} : {
          description: safeDisplayText(
            argument.description,
            "MCP prompt argument description",
            MCP_DESCRIPTOR_LIMITS.fieldBytes,
          ),
        }),
        ...(argument.required === undefined ? {} : { required: argument.required === true }),
      });
    }
    definition.arguments = argumentsList;
  }
  if (typeof prompt.prompt.title === "string") {
    definition.title = safeDisplayText(prompt.prompt.title, "MCP prompt title", MCP_DESCRIPTOR_LIMITS.fieldBytes);
  }
  if (jsonUtf8Bytes(definition) > MCP_DESCRIPTOR_LIMITS.itemJsonBytes) {
    throw descriptorLimitError("prompt", "item");
  }
  return definition;
}

function mcpPromptContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return JSON.stringify(content);
}

function mcpCommandCatalog(commands: readonly CommandDefinition[]): RuntimeCommandCatalog {
  const catalog = serializeCommandCatalog(createCommandRegistry(commands), {});
  if (jsonUtf8Bytes(catalog) > MCP_DESCRIPTOR_LIMITS.catalogJsonBytes) {
    throw descriptorLimitError("prompt", "command catalog aggregate");
  }
  return catalog;
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
  const error: RuntimeMcpReloadError = { message: persistedDiagnosticMessage(diagnostic.message) };
  const serverName = safeDiagnosticServerName(diagnostic.path);
  if (serverName !== "unknown") error.server = serverName;
  return error;
}

function serverAuthDescriptor(server: McpServerConfig): NonNullable<RuntimeMcpServerDescriptor["auth"]> {
  if (!("oauth" in server) || !server.oauth) return { required: false };
  return {
    required: true,
    authenticated: false,
    ...(server.oauth.scopes ? { scopes: boundStringList(server.oauth.scopes, "MCP OAuth scope") } : {}),
  };
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isMissingPath(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise(value as T | PromiseLike<T>);
    },
    reject(reason) {
      rejectPromise(reason);
    },
  };
}

function invokeObserved(operation: () => void): Promise<void> {
  try {
    operation();
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}
