import { mkdir, realpath } from "node:fs/promises";
import { createHostToolExposure } from "./tool-surface.js";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  AgentControlService,
  DelegationPolicyGate,
  LocalSubagentConcurrencyLimiter,
  RuntimeService,
  SingleAgentRuntime,
  SnapshotRecoveryService,
  buildChiliMemoryPromptFragments,
  chiliBasePromptFragment,
  createMemoryTool,
  type ModelRouter,
  type PromptFragment,
  type RuntimePromptTurnContext,
} from "@chili/core";
import type { ChiliEvent, ExecutionIdentity, ModelSelection, RuntimePermissionConfig, RuntimePermissionProfileId, ServiceTier, SessionId } from "@chili/protocol";
import { compactRuntimeEvent } from "@chili/protocol";
import { HostOwnerClaim, ObservableEventStore, SessionTranscriptJsonlMirror, SqliteEventStore } from "@chili/store";
import {
  DeferredApprovalQueue,
  DeferredUserInputQueue,
  DELEGATION_OFF_DENIED_TOOL_NAMES,
  CODING_TOOL_GROUPS,
  FileSystemSnapshotProvider,
  filterToolsByPolicy,
  isToolVisible,
  InMemoryToolRegistry,
  ManagedProcessManager,
  observeProcessGuardianLifecycle,
  resolveFileResourceDenials,
  withProcessOwner,
  PolicyApprovalBroker,
  PolicyApprovalState,
  ToolExecutor,
  createApplyPatchTool,
  createActivateSkillTool,
  createAgentSpawnTool,
  createAgentListTool,
  createAgentSendTool,
  createAgentWaitTool,
  createAgentStopTool,
  createAgentResumeTool,
  createBashTool,
  createCodeModeTool,
  createProcessTool,
  createDelegationSetTool,
  createDelegationStatusTool,
  createEditTool,
  createGitWorktreeTool,
  createGitApplyPatchTool,
  createGitBranchTool,
  createGitCommitTool,
  createGitDiffTool,
  createGitStageTool,
  createGitStatusTool,
  createGoalTools,
  createGlobTool,
  createGrepTool,
  createMcpResourceReadTool,
  createMcpResourcesListTool,
  createReadFileTool,
  createReadImageTool,
  createRequestUserInputTool,
  createToolSearchTool,
  createWriteFileTool,
  type BashRunner,
  type ChiliToolDefinition,
  type BashRunRequest,
  type DelegationToolController,
  type GoalToolController,
  type ToolAccessPolicyResolver,
  type ToolAccessPolicy,
} from "@chili/tools";
import {
  discoverSkills,
  formatAvailableSkillsPrompt,
  formatSkillBodyPrompt,
  listSkillResourceFiles,
  resolveSkillMentions,
  type Skill,
  type SkillMentionDiagnostic,
  type SkillResourceListing,
  type SkillRegistry,
} from "@chili/skills";
import { defaultAuthPath, FileAuthStorage } from "@chili/providers";
import { resolveHostExecutionIdentity } from "./identity.js";
import { targetPathsForSession } from "./context-targets.js";
import { evaluatePolicy } from "@chili/policy";
import { createFilesystemPromptCommandControl, type PromptCommandControl } from "@chili/commands";
import {
  assertSupportedPermissionProfile,
  createApprovalRulesets,
  createRequestScopedPolicyApprovalBroker,
  dangerousShellCommandsForProfile,
  persistAllowAlwaysDecision,
  runtimePermissionConfig,
  type ApprovalRulesetResolver,
} from "./approval.js";
import { createHostBashRunner } from "./bash-runner.js";
import { loadHostConfig, type HostConfig, type HostAgentConfig } from "./config.js";
import { resolveAgentAncestry } from "./agent-expansion.js";
import { createIdFactory } from "./id.js";
import type { HostModelName, HostReasoningLevel } from "./model.js";
import { createHostModel, resolveHostRuntimeModelSelection } from "./model.js";
import {
  createHostMcpRuntime,
  type HostMcpRuntime,
  type HostMcpRuntimeOptions,
} from "./mcp-control.js";
import { readUserModelSelection, writeUserModelSelection } from "./user-model-state.js";

const DEV_MAX_TURNS = 128;
const DEV_MAX_REPEATED_TOOL_CALLS = 20;
const DEV_MAX_TOOL_CALLS_PER_TURN = 200;
const DEV_MAX_CONCURRENT_TOOL_CALLS = 32;
const STALE_TURN_RECOVERY_MS = 30 * 60 * 1000;
const STALE_TURN_RECOVERY_INTERVAL_MS = 30_000;
const DEFAULT_READ_MAX_BYTES = 32 * 1024;
const READ_MAX_BYTES_LIMIT = 256 * 1024;

async function canonicalSkillWorkspace(cwd: string): Promise<string> {
  const absolute = resolve(cwd);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
    ) {
      return absolute;
    }
    throw error;
  }
}

export interface ChiliHostOptions {
  cwd: string;
  provider?: string;
  model?: HostModelName;
  reasoningLevel?: HostReasoningLevel;
  serviceTier?: ServiceTier;
  permissionProfile?: RuntimePermissionProfileId;
  askApproval?: import("@chili/tools").PolicyApprovalBrokerOptions["ask"];
  onEvent?: (event: ChiliEvent) => void;
  approvalQueue?: DeferredApprovalQueue;
  userInputQueue?: DeferredUserInputQueue;
  chiliHome?: string;
  projectRoot?: string;
  deferMcpConnect?: boolean;
  mcpConnectMode?: "eager" | "background" | "manual";
  bashRunner?: BashRunner;
  modelRouter?: ModelRouter;
  staleTurnRecoveryMs?: number;
  staleTurnRecoveryIntervalMs?: number | false;
  sessionClaimLeaseMs?: number;
  sessionClaimHeartbeatMs?: number;
  onStaleTurnRecoveryError?: (error: unknown) => void;
  mcpRuntimeFactory?: (
    options: HostMcpRuntimeOptions,
    baseCommands: PromptCommandControl,
  ) => Promise<HostMcpRuntime>;
}

export interface ChiliHost {
  cwd: string;
  identity: ExecutionIdentity;
  store: SqliteEventStore;
  events: ObservableEventStore;
  runtime: SingleAgentRuntime;
  service: RuntimeService;
  agents: AgentControlService;
  permissions: HostPermissionProfileControl;
  commands: PromptCommandControl;
  mcp: import("@chili/protocol").RuntimeMcpControlService;
  recovery: SnapshotRecoveryService;
  defaultModelSelection?: ModelSelection;
  defaultReasoningLevel?: HostReasoningLevel;
  defaultServiceTier?: ServiceTier;
  waitForAgents(): Promise<void>;
  close(): Promise<void>;
}

export interface HostPermissionProfileControl {
  get(): RuntimePermissionConfig;
  set(profile: RuntimePermissionProfileId): RuntimePermissionConfig;
}

export async function createChiliHost(options: ChiliHostOptions): Promise<ChiliHost> {
  assertSupportedPermissionProfile(options.permissionProfile ?? "default");
  const identity = await resolveHostExecutionIdentity(options);
  const cwd = identity.workspaceRoot;
  const stateDir = join(cwd, ".chili");
  await mkdir(stateDir, { recursive: true });

  const createId = createIdFactory();
  const chiliHome = identity.profilePath;
  const executionIdentityForCwd = async (requestedCwd: string): Promise<ExecutionIdentity> => {
    const canonicalCwd = await canonicalSkillWorkspace(requestedCwd);
    const relation = relative(identity.projectRoot, canonicalCwd);
    const withinHostProject = relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith("../"));
    return resolveHostExecutionIdentity({
      cwd: canonicalCwd, chiliHome,
      ...(withinHostProject ? { projectRoot: identity.projectRoot } : {}),
      ...(identity.authPath ? { authPath: identity.authPath } : {}),
    });
  };
  const memoryOptionsForCwd = async (requestedCwd: string) => {
    const current = await executionIdentityForCwd(requestedCwd);
    return { chiliHome, projectRoot: current.projectRoot, projectId: current.projectId };
  };
  const memoryOptions = { chiliHome, optionsForCwd: memoryOptionsForCwd };
  const baseCommands = createFilesystemPromptCommandControl({ cwd, chiliHome });
  let commands: PromptCommandControl = baseCommands;
  let sqliteStore: SqliteEventStore;
  const sessionMirror = new SessionTranscriptJsonlMirror(join(chiliHome, "sessions"), {
    groupByCwd: true,
    resolveSessionCwd: async (sessionId) => (await sqliteStore.sessions()).find((session) => session.id === sessionId)?.cwd,
  });
  const owner = new HostOwnerClaim(join(stateDir, "chili.sqlite"));
  let unsubscribeGuardians: (() => void) | undefined;
  try {
    sqliteStore = new SqliteEventStore(join(stateDir, "chili.sqlite"), { mirror: sessionMirror });
    unsubscribeGuardians = observeProcessGuardianLifecycle((event) => {
      if (event.ownerId !== owner.token) return;
      if (event.type === "started") owner.registerGuardian(event.pid);
      else owner.unregisterGuardian(event.pid);
    });
  } catch (error) {
    owner.release();
    throw error;
  }
  const eventStore = new ObservableEventStore(sqliteStore);
  const unsubscribeObserver = options.onEvent ? eventStore.subscribe((event) => options.onEvent!(compactRuntimeEvent(event))) : undefined;
  const initializationDrains: Array<() => unknown> = [];
  let cleanupMcp: (() => unknown) | undefined;
  try {
    const staleTurnRecoveryMs = nonNegativeDuration(
      options.staleTurnRecoveryMs,
      STALE_TURN_RECOVERY_MS,
      "staleTurnRecoveryMs",
    );
    const staleTurnRecoveryIntervalMs = options.staleTurnRecoveryIntervalMs === false
      ? false
      : positiveDuration(
          options.staleTurnRecoveryIntervalMs,
          STALE_TURN_RECOVERY_INTERVAL_MS,
          "staleTurnRecoveryIntervalMs",
        );
    let staleTurnRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTurnRecoveryRun: Promise<void> | undefined;
    let hostClosing = false;
    initializationDrains.push(() => {
      hostClosing = true;
      if (staleTurnRecoveryTimer) clearTimeout(staleTurnRecoveryTimer);
      return staleTurnRecoveryRun?.catch(() => undefined);
    });
    initializationDrains.push(() => options.approvalQueue?.denyAll("Host initialization failed."));
    initializationDrains.push(() => options.userInputQueue?.denyAll("Host initialization failed."));
    const reconcileStaleRuntimeState = async (includePending = false): Promise<void> => {
      const now = Date.now();
      await eventStore.reconcileStaleTurns({
        staleBefore: now - staleTurnRecoveryMs,
        now,
        createId,
        status: "failed",
        reason: "stale_turn_recovered",
      });
      await service.recoverInputs({ includePending });
      await childService.recoverInputs({ includePending });
    };
    const scheduleStaleTurnRecovery = (): void => {
      if (hostClosing || staleTurnRecoveryIntervalMs === false) return;
      staleTurnRecoveryTimer = setTimeout(() => {
        staleTurnRecoveryTimer = undefined;
        if (hostClosing) return;
        const run = reconcileStaleRuntimeState();
        staleTurnRecoveryRun = run;
        void run.catch((error: unknown) => {
          if (!hostClosing) {
            try {
              options.onStaleTurnRecoveryError?.(error);
            } catch {
              // Recovery diagnostics must not turn a retryable maintenance error
              // into an unhandled rejection that crashes the host process.
            }
          }
        }).finally(() => {
          if (staleTurnRecoveryRun === run) staleTurnRecoveryRun = undefined;
          scheduleStaleTurnRecovery();
        }).catch(() => undefined);
      }, staleTurnRecoveryIntervalMs);
      (staleTurnRecoveryTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    };
    const config = await loadHostConfig(cwd, { chiliHome });
    const childToolPolicyResolver = createSessionToolPolicyResolver(eventStore);
    let delegationPolicyGate: DelegationPolicyGate | undefined;
    const delegationToolPolicyResolver = createDelegationToolPolicyResolver(() => delegationPolicyGate);
    const rootToolPolicyResolver = combineToolAccessPolicyResolvers(
      createAgentExpansionToolPolicyResolver(eventStore, config.agents),
      delegationToolPolicyResolver,
    );
    const combinedChildToolPolicyResolver = combineToolAccessPolicyResolvers(
      childToolPolicyResolver,
      rootToolPolicyResolver,
    );
    const hostModelInput: { provider?: string; model?: HostModelName; reasoningLevel?: HostReasoningLevel; serviceTier?: ServiceTier } = {};
    if (options.provider !== undefined) hostModelInput.provider = options.provider;
    if (options.model !== undefined) hostModelInput.model = options.model;
    if (options.reasoningLevel !== undefined) hostModelInput.reasoningLevel = options.reasoningLevel;
    if (options.serviceTier !== undefined) hostModelInput.serviceTier = options.serviceTier;
    const explicitModelSelection = options.provider !== undefined || options.model !== undefined;
    const persistedUserModelSelection = explicitModelSelection ? undefined : await readPersistedUserModelSelection(chiliHome);
    const modelInput = { ...hostModelInput };
    if (!explicitModelSelection && persistedUserModelSelection) {
      modelInput.provider = persistedUserModelSelection.provider;
      modelInput.model = persistedUserModelSelection.model;
    }
    const model = options.modelRouter ?? await createHostModel(modelInput, { authStorage: new FileAuthStorage(identity.authPath ?? defaultAuthPath(chiliHome)), profileId: identity.profileId });
    const runtimeModelSelection = explicitModelSelection ? resolveHostRuntimeModelSelection(hostModelInput) : undefined;
    const serviceDefaultModelSelection = runtimeModelSelection ?? persistedUserModelSelection;
    const persistUserModelSelection = async (input: { modelSelection: ModelSelection }): Promise<void> => {
      await writeUserModelSelection(input.modelSelection, { chiliHome }).catch(() => undefined);
    };
    const skillRegistryForCwd = async (requestedCwd: string): Promise<SkillRegistry> => {
      const canonicalCwd = await canonicalSkillWorkspace(requestedCwd);
      const current = await executionIdentityForCwd(canonicalCwd);
      return discoverSkills({ cwd: canonicalCwd, chiliHome, projectRoot: current.projectRoot });
    };
    await skillRegistryForCwd(cwd);
    const approvalState = new PolicyApprovalState();
    const approvalRootBySession = new Map<SessionId, SessionId>();
    const sandboxedShell = options.bashRunner === undefined && process.platform === "darwin";
    const permissions = createPermissionProfileControl(
      config,
      options.permissionProfile ?? "default",
      sandboxedShell,
    );
    const approvalRulesetsForRequest: ApprovalRulesetResolver = async (request) => {
      if (!delegationPolicyGate) throw new Error("Delegation policy gate is not initialized");
      const rootSessionId = await delegationPolicyGate.rootSessionId(request.sessionId);
      const sessions = await eventStore.sessions();
      const session = sessions.find((candidate) => candidate.id === request.sessionId);
      if (!session) throw new Error(`Session not found: ${request.sessionId}`);
      if (session.status !== "active") {
        throw new Error(`Session is not active: ${request.sessionId} (${session.status})`);
      }
      const rootSession = sessions.find((candidate) => candidate.id === rootSessionId);
      if (!rootSession) throw new Error(`Approval root session not found: ${rootSessionId}`);
      if (rootSession.status !== "active") {
        throw new Error(`Approval root session is not active: ${rootSessionId} (${rootSession.status})`);
      }
      if (rootSession.source === "subagent") {
        throw new Error(`Approval root session cannot be a subagent: ${rootSessionId}`);
      }
      const sessionCwd = await canonicalSkillWorkspace(session.cwd);
      const sessionConfig = await loadHostConfig(sessionCwd, { chiliHome });
      const rulesets = createApprovalRulesets(permissions.get().profile, sessionConfig, { sandboxedShell });
      const previousRootSessionId = approvalRootBySession.get(request.sessionId);
      if (previousRootSessionId && previousRootSessionId !== rootSessionId) {
        throw new Error(
          `Approval ancestry changed for session ${request.sessionId}: ${previousRootSessionId} -> ${rootSessionId}`,
        );
      }
      approvalRootBySession.set(request.sessionId, rootSessionId);
      approvalState.linkSession(rootSessionId, request.sessionId);
      return rulesets;
    };
    const resolveResourceDenials = async (request: BashRunRequest) => {
      const sessionCwd = request.workspaceRoot ?? request.cwd;
      const latestConfig = await loadHostConfig(sessionCwd, { chiliHome });
      return resolveFileResourceDenials(sessionCwd, createApprovalRulesets(
        permissions.get().profile, latestConfig, { sandboxedShell },
      ));
    };
    const bashRunner = createHostBashRunner({
      permissionProfile: () => permissions.get().profile,
      resolveResourceDenials,
      ...(options.bashRunner ? { sandboxedRunner: options.bashRunner, unsandboxedRunner: options.bashRunner } : {}),
    });
    const processes = new ManagedProcessManager();
    initializationDrains.push(() => processes.close("runtime_closed"));
    const childRunLimiter = new LocalSubagentConcurrencyLimiter(config.agents.maxConcurrent);
    const registry = createToolRegistry(skillRegistryForCwd, bashRunner, processes, memoryOptions, childRunLimiter);
    const childRegistry = createToolRegistry(skillRegistryForCwd, bashRunner, processes, memoryOptions, childRunLimiter);
    if (options.userInputQueue) {
      const userInputTool = createRequestUserInputTool(
        options.userInputQueue,
        { publish: (event) => eventStore.append(event) },
        createId,
      );
      registry.register(userInputTool);
      childRegistry.register(userInputTool);
    }
    let mcpRuntime: HostMcpRuntime | undefined;
    cleanupMcp = () => mcpRuntime?.close();
    const allowedMemoryScopes = async (sessionCwd: string): Promise<Array<"user" | "project">> => {
      const current = await executionIdentityForCwd(sessionCwd);
      const latestConfig = await loadHostConfig(sessionCwd, { chiliHome });
      const rulesets = createApprovalRulesets(permissions.get().profile, latestConfig, { sandboxedShell });
      return (["user", "project"] as const).filter((scope) => evaluatePolicy(
        "memory.read",
        scope === "user" ? `profile:${chiliHome}/user` : `profile:${chiliHome}/project:${current.projectId}`,
        rulesets,
      ).action === "allow");
    };
    const promptFragments = async (context: { sessionId: SessionId; cwd: string; turn?: RuntimePromptTurnContext }) =>
      buildHostPromptFragments({
        cwd: context.cwd,
        ...(await memoryOptionsForCwd(context.cwd)),
        memoryScopes: await allowedMemoryScopes(context.cwd),
        targetPaths: await targetPathsForSession(eventStore, context.sessionId, context.cwd),
        skillRegistry: await skillRegistryForCwd(context.cwd),
        ...(context.turn ? { turn: context.turn } : {}),
      }).then((fragments) => [...fragments, agentExpansionPromptFragment(config.agents)]);
    const childPromptFragments = async (context: { sessionId: SessionId; cwd: string; turn?: RuntimePromptTurnContext }) =>
      buildHostChildPromptFragments({
        cwd: context.cwd,
        ...(await memoryOptionsForCwd(context.cwd)),
        memoryScopes: await allowedMemoryScopes(context.cwd),
        sessionId: context.sessionId,
        targetPaths: await targetPathsForSession(eventStore, context.sessionId, context.cwd),
        skillRegistry: await skillRegistryForCwd(context.cwd),
        store: eventStore,
        ...(context.turn ? { turn: context.turn } : {}),
      }).then((fragments) => [...fragments, agentExpansionPromptFragment(config.agents)]);
    const snapshotProvider = new FileSystemSnapshotProvider({
      rootDir: join(stateDir, "snapshots"),
      createId,
    });
    const childToolExecutor = new ToolExecutor({
      registry: childRegistry,
      executionContext: (operation) => withProcessOwner(owner.token, operation),
      events: { publish: (event: ChiliEvent) => eventStore.append(event) },
      approvals: createApprovalBroker({ ...options, chiliHome }, config, approvalState, permissions, approvalRulesetsForRequest),
      policyResolver: combinedChildToolPolicyResolver,
      snapshotProvider,
      createId,
      maxResultOutputBytes: 128_000,
    });
    const childContextBudget = {
      maxInputChars: 500_000,
      maxToolResultChars: 80_000,
      preserveRecentMessages: 12,
    };
    const childRuntime = new SingleAgentRuntime({
      store: eventStore,
      model,
      toolRegistry: childRegistry,
      toolExecutor: childToolExecutor,
      toolExposure: createHostToolExposure(eventStore, "child"),
      toolPolicyResolver: combinedChildToolPolicyResolver,
      createId,
      contextBudget: childContextBudget,
      retryPolicy: {
        maxAttempts: 2,
        initialDelayMs: 500,
      },
      doomLoopGuard: {
        maxRepeatedToolCalls: DEV_MAX_REPEATED_TOOL_CALLS,
        maxToolCallsPerTurn: DEV_MAX_TOOL_CALLS_PER_TURN,
      },
      maxConcurrentToolCalls: DEV_MAX_CONCURRENT_TOOL_CALLS,
    });
    const childService = new RuntimeService({
      runtime: childRuntime,
      executionContext: (operation) => withProcessOwner(owner.token, operation),
      executionIdentityResolver: executionIdentityForCwd,
      store: eventStore,
      cwd,
      createId,
      maxTurns: DEV_MAX_TURNS,
      contextBudget: childContextBudget,
      promptFragments: childPromptFragments,
      ...(serviceDefaultModelSelection ? { defaultModelSelection: serviceDefaultModelSelection } : {}),
      ...(options.reasoningLevel !== undefined ? { defaultReasoningLevel: options.reasoningLevel } : {}),
      ...(options.serviceTier !== undefined ? { defaultServiceTier: options.serviceTier } : {}),
      onModelChanged: persistUserModelSelection,
      allowSubagentSessions: true,
      stopSessionResources: (sessionId, reason) => processes.stopSession(sessionId, reason),
      runInput: async (sessionId, signal, run) => {
        const permit = await childRunLimiter.acquireRun(sessionId, signal);
        try { return await permit.run(run); } finally { permit.release(); }
      },
      ...(options.sessionClaimLeaseMs !== undefined ? { sessionClaimLeaseMs: options.sessionClaimLeaseMs } : {}),
      ...(options.sessionClaimHeartbeatMs !== undefined ? { sessionClaimHeartbeatMs: options.sessionClaimHeartbeatMs } : {}),
    });
    initializationDrains.push(() => childService.shutdown("runtime_closed"));
    const toolExecutor = new ToolExecutor({
      registry,
      executionContext: (operation) => withProcessOwner(owner.token, operation),
      events: { publish: (event) => eventStore.append(event) },
      approvals: createApprovalBroker({ ...options, chiliHome }, config, approvalState, permissions, approvalRulesetsForRequest),
      policyResolver: rootToolPolicyResolver,
      snapshotProvider,
      createId,
      maxResultOutputBytes: 256_000,
    });
    const runtimeContextBudget = {
      maxInputChars: 500_000,
      maxToolResultChars: 80_000,
      preserveRecentMessages: 12,
    };
    const runtime = new SingleAgentRuntime({
      store: eventStore,
      model,
      toolRegistry: registry,
      toolExecutor,
      toolExposure: createHostToolExposure(eventStore, "root"),
      toolPolicyResolver: rootToolPolicyResolver,
      createId,
      contextBudget: runtimeContextBudget,
      retryPolicy: {
        maxAttempts: 2,
        initialDelayMs: 500,
      },
      doomLoopGuard: {
        maxRepeatedToolCalls: DEV_MAX_REPEATED_TOOL_CALLS,
        maxToolCallsPerTurn: DEV_MAX_TOOL_CALLS_PER_TURN,
      },
      maxConcurrentToolCalls: DEV_MAX_CONCURRENT_TOOL_CALLS,
    });
    const service = new RuntimeService({
      runtime,
      executionContext: (operation) => withProcessOwner(owner.token, operation),
      executionIdentityResolver: executionIdentityForCwd,
      store: eventStore,
      cwd,
      createId,
      maxTurns: DEV_MAX_TURNS,
      contextBudget: runtimeContextBudget,
      promptFragments,
      ...(serviceDefaultModelSelection ? { defaultModelSelection: serviceDefaultModelSelection } : {}),
      ...(options.reasoningLevel !== undefined ? { defaultReasoningLevel: options.reasoningLevel } : {}),
      ...(options.serviceTier !== undefined ? { defaultServiceTier: options.serviceTier } : {}),
      onModelChanged: persistUserModelSelection,
      stopSessionResources: (sessionId, reason) => processes.stopSession(sessionId, reason),
      ...(options.sessionClaimLeaseMs !== undefined ? { sessionClaimLeaseMs: options.sessionClaimLeaseMs } : {}),
      ...(options.sessionClaimHeartbeatMs !== undefined ? { sessionClaimHeartbeatMs: options.sessionClaimHeartbeatMs } : {}),
    });
    const recovery = new SnapshotRecoveryService({ store: eventStore, snapshotProvider, createId, sessionOperations: service });
    initializationDrains.push(() => service.shutdown("runtime_closed"));
    delegationPolicyGate = new DelegationPolicyGate({
      store: eventStore,
      getDelegationConfig: (sessionId) => service.getDelegationConfig(sessionId),
    });
    for (const tool of createGoalTools(createGoalToolController(service))) {
      registry.register(tool);
    }
    const delegationController = createDelegationToolController(service);
    registry.register(createDelegationStatusTool(delegationController));
    registry.register(createDelegationSetTool(delegationController));
    await reconcileStaleRuntimeState(true);
    const agents = new AgentControlService({
      normalizePolicy: (policy) => ({
        ...policy,
        ...(policy.allowedTools ? {
          allowedTools: filterToolsByPolicy(registry.list(), { allowedTools: policy.allowedTools }).map((tool) => tool.name),
        } : {}),
        ...(policy.deniedTools ? {
          deniedTools: [...new Set([
            ...policy.deniedTools,
            ...registry.list().filter((tool) => !isToolVisible(tool, { deniedTools: policy.deniedTools! })).map((tool) => tool.name),
          ])],
        } : {}),
      }),
      store: eventStore,
      runtime: childService,
      rootRuntime: service,
      maxChildren: config.agents.maxChildren,
      maxDepth: config.agents.maxDepth,
      createId,
    });
    for (const agentRegistry of [registry, childRegistry]) {
      agentRegistry.register(createAgentSpawnTool(agents));
      agentRegistry.register(createAgentListTool(agents));
      agentRegistry.register(createAgentSendTool(agents));
      agentRegistry.register(suspendAgentTool(createAgentWaitTool(agents), childRunLimiter));
      agentRegistry.register(createAgentStopTool(agents));
      agentRegistry.register(createAgentResumeTool(agents));
    }
    mcpRuntime = await (options.mcpRuntimeFactory ?? createHostMcpRuntime)({
      cwd,
      chiliHome,
      registries: [registry, childRegistry],
      ...(options.userInputQueue ? { userInputQueue: options.userInputQueue } : {}),
      guardianLifecycle: (event) => {
        if (event.type === "started") owner.registerGuardian(event.pid);
        else owner.unregisterGuardian(event.pid);
      },
      events: { publish: (event: ChiliEvent) => eventStore.append(event) },
      createId,
      connectMode: options.mcpConnectMode ?? (options.deferMcpConnect === true ? "background" : "eager"),
    }, baseCommands);
    commands = mcpRuntime.commands;
    registerMcpResourceTools(registry, mcpRuntime);
    registerMcpResourceTools(childRegistry, mcpRuntime);
    scheduleStaleTurnRecovery();

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closePromise) return closePromise;

      let resolveClose!: () => void;
      let rejectClose!: (error: unknown) => void;
      closePromise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolveClose = resolvePromise;
        rejectClose = rejectPromise;
      });

      // Publish the one close promise before any shutdown call can synchronously
      // abort a model/tool and let its listener reenter close().
      hostClosing = true;
      if (staleTurnRecoveryTimer) clearTimeout(staleTurnRecoveryTimer);
      staleTurnRecoveryTimer = undefined;
      const errors: unknown[] = [];
      const pendingDrains: Promise<unknown>[] = [];
      const startDrain = (operation: () => unknown): void => {
        try {
          pendingDrains.push(Promise.resolve(operation()));
        } catch (error) {
          errors.push(error);
        }
      };

      // Start every admission/abort path even if one of its peers throws
      // synchronously. The single cleanup actor below observes all outcomes.
      startDrain(() => service.shutdown("runtime_closed"));
      startDrain(() => childService.shutdown("runtime_closed"));
      startDrain(() => processes.close("runtime_closed"));
      startDrain(() => options.approvalQueue?.denyAll("Runtime closed while waiting for approval."));
      startDrain(() => options.userInputQueue?.denyAll("Runtime closed while waiting for user input."));
      startDrain(() => staleTurnRecoveryRun?.catch(() => undefined));

      const cleanupActor = (async (): Promise<void> => {
        const drainResults = await Promise.allSettled(pendingDrains);
        for (const result of drainResults) {
          if (result.status === "rejected") errors.push(result.reason);
        }
        try {
          await mcpRuntime?.close();
        } catch (error) {
          errors.push(error);
        } finally {
          try {
            unsubscribeObserver?.();
            try { await sqliteStore.flushInputMirrors(); } finally {
              sqliteStore.close();
              unsubscribeGuardians?.();
              owner.release();
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, "Chili Host shutdown encountered multiple errors");
        }
      })();
      void cleanupActor.then(resolveClose, rejectClose);
      return closePromise;
    };

    return {
      cwd,
      identity,
      store: sqliteStore,
      events: eventStore,
      runtime,
      service,
      agents,
      permissions,
      commands,
      mcp: mcpRuntime.control,
      recovery,
      ...(runtimeModelSelection ? { defaultModelSelection: runtimeModelSelection } : {}),
      ...(options.reasoningLevel !== undefined ? { defaultReasoningLevel: options.reasoningLevel } : {}),
      ...(options.serviceTier !== undefined ? { defaultServiceTier: options.serviceTier } : {}),
      waitForAgents: () => childService.waitForIdle(),
      close,
    };
  } catch (error) {
    // Begin every abort path before waiting so dependent services can settle.
    const cleanup = await Promise.allSettled(initializationDrains.map((drain) => Promise.resolve().then(drain)));
    const errors: unknown[] = [error];
    for (const result of cleanup) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    // MCP can be used by a settling tool; close it only after runtime drains.
    try {
      await cleanupMcp?.();
    } catch (closeError) {
      errors.push(closeError);
    }
    unsubscribeObserver?.();
    try {
      try {
        await sqliteStore.flushInputMirrors();
      } finally {
        sqliteStore.close();
        unsubscribeGuardians?.();
        owner.release();
      }
    } catch (closeError) {
      errors.push(closeError);
    }
    if (errors.length > 1) throw new AggregateError(errors, "Chili Host initialization and cleanup failed");
    throw error;
  }
}

function nonNegativeDuration(value: number | undefined, fallback: number, name: string): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return duration;
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return duration;
}

async function readPersistedUserModelSelection(chiliHome: string): Promise<ModelSelection | undefined> {
  const selection = await readUserModelSelection({ chiliHome });
  if (!selection) return undefined;
  try {
    return resolveHostRuntimeModelSelection(selection);
  } catch {
    return undefined;
  }
}

function registerMcpResourceTools(registry: InMemoryToolRegistry, runtime: HostMcpRuntime): void {
  registry.register(createMcpResourcesListTool(runtime.resources));
  registry.register(createMcpResourceReadTool(runtime.resources));
}

function createSessionToolPolicyResolver(store: ObservableEventStore): ToolAccessPolicyResolver {
  return { async resolve(context) {
    const session = await store.session(context.sessionId);
    if (session?.source === "subagent" && !session.agent) {
      throw new Error("Legacy Agent sessions are read-only");
    }
    return session?.agent?.policy;
  } };
}

function agentExpansionPromptFragment(limits: HostAgentConfig): PromptFragment {
  return {
    id: "chili.agent-expansion", layer: "developer", source: "runtime", priority: 20,
    lifecycle: "stable", trust: "system",
    content: `Agent expansion limits: each agent may create at most ${limits.maxChildren} direct child identities in total, including completed or stopped children. Resume an existing agent to reuse its identity. The root is depth 0; the deepest allowed child is depth ${limits.maxDepth}. The Host runs at most ${limits.maxConcurrent} child-agent executions concurrently across all depths, excluding the root and parents waiting for descendants. These limits do not grant tools or override the delegation policy.`,
  };
}

function suspendAgentTool<Input>(
  tool: ChiliToolDefinition<Input>,
  limiter: LocalSubagentConcurrencyLimiter,
): ChiliToolDefinition<Input> {
  return { ...tool, execute: (input, context) => {
    return limiter.suspend(context.sessionId, () => tool.execute(input, context));
  } };
}

function createAgentExpansionToolPolicyResolver(
  store: ObservableEventStore,
  limits: HostAgentConfig,
): ToolAccessPolicyResolver {
  return { async resolve(context) {
    if (limits.maxChildren === 0 || limits.maxDepth === 0) return { deniedTools: ["agent_spawn"] };
    const ancestry = await resolveAgentAncestry(store, context.sessionId);
    return ancestry.depth >= limits.maxDepth ? { deniedTools: ["agent_spawn"] } : undefined;
  } };
}

function createDelegationToolPolicyResolver(
  gate: () => DelegationPolicyGate | undefined,
): ToolAccessPolicyResolver {
  return {
    async resolve(context) {
      const current = gate();
      if (!current || !(await current.isOff(context.sessionId))) return undefined;
      return { deniedTools: DELEGATION_OFF_DENIED_TOOL_NAMES };
    },
  };
}

function combineToolAccessPolicyResolvers(
  worker: ToolAccessPolicyResolver,
  delegation: ToolAccessPolicyResolver,
): ToolAccessPolicyResolver {
  return {
    async resolve(context) {
      const [workerPolicy, delegationPolicy] = await Promise.all([
        worker.resolve(context),
        delegation.resolve(context),
      ]);
      if (!workerPolicy) return delegationPolicy;
      if (!delegationPolicy) return workerPolicy;
      const deniedTools = uniqueStrings([
        ...(workerPolicy.deniedTools ?? []),
        ...(delegationPolicy.deniedTools ?? []),
      ]);
      const combined: ToolAccessPolicy = {
        ...workerPolicy,
        ...delegationPolicy,
        deniedTools,
        metadata: {
          ...workerPolicy.metadata,
          ...delegationPolicy.metadata,
        },
      };
      return combined;
    },
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function createGoalToolController(service: RuntimeService): GoalToolController {
  return {
    async getGoal(context) {
      return service.getGoal({ sessionId: context.sessionId });
    },
    async createGoal(input, context) {
      return service.setGoal({
        sessionId: context.sessionId,
        objective: input.objective,
        ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
        replace: false,
      });
    },
    async updateGoal(input, context) {
      return service.updateGoal({
        sessionId: context.sessionId,
        status: input.status,
      });
    },
  };
}

function createDelegationToolController(service: RuntimeService): DelegationToolController {
  return {
    getDelegationConfig(context) {
      return service.getDelegationConfig(context.sessionId);
    },
    setDelegationPolicy(input, context) {
      return service.setDelegationPolicy({
        sessionId: context.sessionId,
        policy: input.policy,
      });
    },
  };
}

export async function buildHostPromptFragments(input: {
  cwd: string;
  skillRegistry: SkillRegistry;
  turn?: RuntimePromptTurnContext;
  homeDir?: string;
  chiliHome?: string;
  projectId?: string;
  projectRoot?: string;
  targetPaths?: readonly string[];
  memoryScopes?: readonly ("user" | "project")[];
}): Promise<PromptFragment[]> {
  const context: PromptFragment[] = [
    chiliBasePromptFragment(),
    {
      id: "chili.tools.code-mode",
      layer: "developer",
      source: "core",
      priority: 10,
      lifecycle: "stable",
      trust: "system",
      content: [
        "When code_mode is available, use it to combine tool calls with predictable JavaScript control flow and summarize intermediate results with text(...). Direct tool calls remain available for individual actions.",
        "Await dependent operations in order. Use Promise.allSettled for independent work and inspect every result; the host enforces tool concurrency limits. Await all work before returning.",
        "Tool permissions, approvals, and worker scope still apply to every nested call, including writes. A failed script does not roll back completed actions; inspect what ran before retrying.",
      ].join("\n"),
    },
    ...(await buildChiliMemoryPromptFragments({
      cwd: input.cwd,
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.chiliHome ? { chiliHome: input.chiliHome } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.turn?.text ? { query: input.turn.text } : {}),
      ...(input.targetPaths ? { targetPaths: input.targetPaths } : {}),
      ...(input.memoryScopes ? { memoryScopes: input.memoryScopes } : {}),
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    })),
  ];
  const skillsPrompt = formatAvailableSkillsPrompt(input.skillRegistry.list());
  if (skillsPrompt) {
    context.push({
      id: "chili.skills.catalog",
      layer: "contextual_user",
      source: "skills",
      priority: 100,
      lifecycle: "session",
      trust: "tool",
      content: skillsPrompt,
    });
  }
  const skillMentionFragments = await buildSkillMentionPromptFragments(input.skillRegistry, input.turn);
  context.push(...skillMentionFragments);
  return context;
}

export async function buildHostChildPromptFragments(input: {
  cwd: string;
  sessionId: SessionId;
  skillRegistry: SkillRegistry;
  store: ObservableEventStore;
  turn?: RuntimePromptTurnContext;
  homeDir?: string;
  chiliHome?: string;
  projectId?: string;
  projectRoot?: string;
  targetPaths?: readonly string[];
  memoryScopes?: readonly ("user" | "project")[];
}): Promise<PromptFragment[]> {
  return [
    ...(await buildHostPromptFragments({
      cwd: input.cwd,
      skillRegistry: input.skillRegistry,
      ...(input.turn ? { turn: input.turn } : {}),
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.chiliHome ? { chiliHome: input.chiliHome } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.turn?.text ? { query: input.turn.text } : {}),
      ...(input.targetPaths ? { targetPaths: input.targetPaths } : {}),
      ...(input.memoryScopes ? { memoryScopes: input.memoryScopes } : {}),
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    })),
    chiliChildRuntimeBasePromptFragment(),
  ];
}

function chiliChildRuntimeBasePromptFragment(): PromptFragment {
  return {
    id: "chili.child_runtime.base",
    layer: "base",
    source: "core",
    priority: 10,
    lifecycle: "stable",
    trust: "system",
    content:
      "You are a local Chili subagent. Work in the assigned repository scope, keep results concise, and return a clear final summary.",
  };
}

async function buildSkillMentionPromptFragments(
  skillRegistry: SkillRegistry,
  turn: RuntimePromptTurnContext | undefined,
): Promise<PromptFragment[]> {
  if (!turn) return [];
  const resolved = resolveSkillMentions({
    text: turn.text,
    ...(turn.skillMentions ? { mentions: turn.skillMentions } : {}),
    registry: skillRegistry,
  });
  const fragments: PromptFragment[] = [];
  for (const skill of resolved.skills) {
    const resources = await listSkillResourceFiles(skill.baseDir);
    fragments.push(skillBodyPromptFragment(skill, resources, needsPathSuffix(skill, resolved.skills)));
  }
  if (resolved.diagnostics.length > 0) fragments.push(skillMentionWarningsFragment(resolved.diagnostics));
  return fragments;
}

function skillBodyPromptFragment(skill: Skill, resources: SkillResourceListing, withPathSuffix: boolean): PromptFragment {
  return {
    id: `chili.skill.${promptFragmentIdPart(skill.name)}${withPathSuffix ? `.${shortHash(skill.filePath)}` : ""}`,
    layer: "contextual_user",
    source: "skills",
    priority: 30,
    lifecycle: "turn",
    trust: "tool",
    content: formatSkillBodyPrompt(skill, {
      resourceFiles: resources.files,
      resourcesTruncated: resources.truncated,
    }),
    metadata: {
      kind: "skill_body",
      name: skill.name,
      path: skill.filePath,
      baseDir: skill.baseDir,
      source: skill.source,
      skillFiles: resources.files.map((file) => file.path),
      skillFilesTruncated: resources.truncated,
      omittedHiddenSkillFiles: resources.omittedHidden,
      omittedLargeSkillFiles: resources.omittedLarge,
      omittedUnreadableSkillFiles: resources.omittedUnreadable,
    },
  };
}

function skillMentionWarningsFragment(diagnostics: readonly SkillMentionDiagnostic[]): PromptFragment {
  return {
    id: "chili.skill_mentions.warnings",
    layer: "contextual_user",
    source: "skills",
    priority: 31,
    lifecycle: "turn",
    trust: "tool",
    content: diagnostics.map((diagnostic) => `[skill mention warning] ${diagnostic.message}`).join("\n"),
    metadata: {
      kind: "skill_mention_warnings",
      count: diagnostics.length,
    },
  };
}

function needsPathSuffix(skill: Skill, skills: readonly Skill[]): boolean {
  return skills.filter((candidate) => candidate.name === skill.name).length > 1;
}

function promptFragmentIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

function createToolRegistry(
  skillRegistryForCwd: (cwd: string) => Promise<SkillRegistry>,
  bashRunner: BashRunner,
  processes: ManagedProcessManager,
  memoryOptions: Parameters<typeof createMemoryTool>[0],
  runLimiter: LocalSubagentConcurrencyLimiter,
): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  const codeMode = createCodeModeTool();
  registry.register({ ...codeMode, async execute(input, context) {
    try { return await codeMode.execute(input, context); }
    finally { await runLimiter.waitForResume(context.sessionId); }
  } });
  registry.register(createReadFileTool({ defaultMaxBytes: DEFAULT_READ_MAX_BYTES, maxBytesLimit: READ_MAX_BYTES_LIMIT }));
  registry.register(createReadImageTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  registry.register(createMemoryTool(memoryOptions));
  registry.register(createActivateSkillTool((context) => skillRegistryForCwd(context.cwd)));
  registry.register(createEditTool());
  registry.register(createWriteFileTool());
  registry.register(createApplyPatchTool());
  registry.register(createBashTool({ runner: bashRunner, processes }));
  registry.register(createProcessTool(processes));
  registerGitTools(registry);
  registry.register(createToolSearchTool(registry, { groups: CODING_TOOL_GROUPS }));
  return registry;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registerGitTools(registry: InMemoryToolRegistry): void {
  registry.register(createGitStatusTool());
  registry.register(createGitDiffTool());
  registry.register(createGitStageTool());
  registry.register(createGitCommitTool());
  registry.register(createGitBranchTool());
  registry.register(createGitWorktreeTool());
  registry.register(createGitApplyPatchTool());
}

interface MutableHostPermissionProfileControl extends HostPermissionProfileControl {
  register(broker: PolicyApprovalBroker): void;
  rulesets(): readonly (readonly import("@chili/policy").PermissionRule[])[];
  dangerousShellCommands(): "ask" | "allow";
}

function createPermissionProfileControl(
  config: HostConfig,
  initialProfile: RuntimePermissionProfileId,
  sandboxedShell: boolean,
): MutableHostPermissionProfileControl {
  let profile = initialProfile;
  const brokers = new Set<PolicyApprovalBroker>();
  const control: MutableHostPermissionProfileControl = {
    get() {
      return runtimePermissionConfig(profile);
    },
    set(nextProfile) {
      assertSupportedPermissionProfile(nextProfile);
      profile = nextProfile;
      for (const broker of brokers) {
        broker.setRulesets(control.rulesets());
        broker.setDangerousShellCommands(control.dangerousShellCommands());
      }
      return control.get();
    },
    register(broker) {
      brokers.add(broker);
      broker.setRulesets(control.rulesets());
      broker.setDangerousShellCommands(control.dangerousShellCommands());
    },
    rulesets() {
      return createApprovalRulesets(profile, config, { sandboxedShell });
    },
    dangerousShellCommands() {
      return dangerousShellCommandsForProfile(profile);
    },
  };
  return control;
}

function createApprovalBroker(
  options: ChiliHostOptions,
  config: HostConfig,
  approvalState: PolicyApprovalState,
  permissions?: MutableHostPermissionProfileControl,
  rulesetsForRequest?: ApprovalRulesetResolver,
): PolicyApprovalBroker {
  const sandboxedShell = options.bashRunner === undefined && process.platform === "darwin";
  let broker: PolicyApprovalBroker;
  const brokerOptions: import("@chili/tools").PolicyApprovalBrokerOptions = {
    rulesets: permissions?.rulesets() ?? createApprovalRulesets(options.permissionProfile ?? "default", config, { sandboxedShell }),
    ...(permissions ? { dangerousShellCommands: permissions.dangerousShellCommands() } : {}),
    state: approvalState,
    allowOneShotPolicyBypass: () => (
      permissions?.get().profile ?? (options.permissionProfile ?? "default")
    ) === "full-access",
    ask: async (request, signal) => {
      return options.approvalQueue
        ? await options.approvalQueue.ask(request, signal)
        : options.askApproval
          ? await options.askApproval(request, signal)
          : { action: "deny", feedback: "No approval interface available." };
    },
    // The broker validates the latest policy before this commit. Never cache
    // persistent grants: the request resolver rereads config so removal revokes.
    onApproved: (request, decision) => persistAllowAlwaysDecision(request, decision, {
      ...(options.chiliHome ? { chiliHome: options.chiliHome } : {}),
    }),
    onSessionGrant: async () => {
      await options.approvalQueue?.recheckPending((request) => broker.preflight(request));
    },
  };
  broker = rulesetsForRequest
    ? createRequestScopedPolicyApprovalBroker({ ...brokerOptions, rulesetsForRequest })
    : new PolicyApprovalBroker(brokerOptions);
  permissions?.register(broker);
  return broker;
}
