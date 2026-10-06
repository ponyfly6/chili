import { mkdir, realpath } from "node:fs/promises";
import { createHostToolExposure } from "./tool-surface.js";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  AgentRunnerSubagentRunner,
  AgentMailboxDeliveryPump,
  AgentTreeControlService,
  AgentTaskControlService,
  DelegationPolicyGate,
  LocalSubagentConcurrencyLimiter,
  LocalSubagentManager,
  RuntimeService,
  SingleAgentRuntime,
  SnapshotRecoveryService,
  TeamControlService,
  TeamExecutionRunner,
  TeamMergeService,
  TeamTaskDispatchService,
  TeamTaskVerificationService,
  TeamWorktreeService,
  buildChiliMemoryPromptFragments,
  chiliBasePromptFragment,
  completeWorkerToolPolicy,
  createMemoryTool,
  defaultScopedWorkerPolicy,
  type ModelRouter,
  type PromptFragment,
  type RuntimePromptTurnContext,
  type WorkerToolPolicy,
} from "@chili/core";
import type { AgentPath, ChiliEvent, EventEnvelope, ExecutionIdentity, ModelSelection, RuntimePermissionConfig, RuntimePermissionProfileId, ServiceTier, SessionId, TaskId, TeamId } from "@chili/protocol";
import { compactRuntimeEvent } from "@chili/protocol";
import { HostOwnerClaim, ObservableEventStore, SessionTranscriptJsonlMirror, SqliteEventStore } from "@chili/store";
import type { AgentMailboxRow, AgentTaskQuery, AgentTaskRow, TeamMemberRow, TeamMessageRow, TeamRow, TeamTaskRow } from "@chili/store";
import {
  DeferredApprovalQueue,
  DeferredUserInputQueue,
  DELEGATION_OFF_DENIED_TOOL_NAMES,
  CODING_TOOL_GROUPS,
  FileSystemSnapshotProvider,
  InMemoryToolRegistry,
  ManagedProcessManager,
  observeProcessGuardianLifecycle,
  resolveFileResourceDenials,
  withProcessOwner,
  PolicyApprovalBroker,
  PolicyApprovalState,
  type AgentMessageRecord,
  type AgentMessageToolController,
  type SubagentController,
  type SubagentControlController,
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
  createCompleteTaskTool,
  createEditTool,
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
  createTeamCreateTool,
  createTeamListTool,
  createTeamMemberAddTool,
  createTeamMemberListTool,
  createTeamMessageListTool,
  createTeamMessageSendTool,
  createTeamSnapshotTool,
  createTeamTaskAssignTool,
  createTeamTaskClaimTool,
  createTeamTaskCreateBatchTool,
  createTeamTaskCreateTool,
  createTeamTaskDispatchBatchTool,
  createTeamTaskDispatchTool,
  createTeamTaskListTool,
  createTeamTaskReconcileTool,
  createTeamRunLoopTool,
  createTeamTaskSyncTool,
  createTeamTaskUpdateTool,
  createToolSearchTool,
  createWriteFileTool,
  type BashRunner,
  type ChiliToolDefinition,
  type BashRunRequest,
  type DelegationToolController,
  type GoalToolController,
  type MailboxListToolInput,
  type SubagentMailboxRecord,
  type SubagentTaskRecord,
  type TeamDispatchAgentTaskRecord,
  type TeamMemberRecord,
  type TeamMessageRecord,
  type TeamRecord,
  type TeamRunLoopRecord,
  type TeamRunLoopToolController,
  type TeamSnapshotRecord,
  type TeamTaskClaimRecord,
  type TeamTaskDispatchRecord,
  type TeamTaskDispatchToolController,
  type TeamTaskRecord,
  type TeamTaskReconcileRecord,
  type TeamTaskSyncRecord,
  type TeamToolController,
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
import { loadHostConfig, DEFAULT_HOST_AGENT_CONFIG, type HostConfig, type HostAgentConfig } from "./config.js";
import { createAgentExpansionController, recursiveWorkerPolicy, resolveAgentAncestry } from "./agent-expansion.js";
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
  tasks: AgentTaskControlService;
  agents: AgentTreeControlService;
  mailboxPump: AgentMailboxDeliveryPump;
  teams: TeamControlService;
  teamDispatcher: TeamTaskDispatchService;
  teamMerger: TeamMergeService;
  teamRunner: TeamExecutionRunner;
  permissions: HostPermissionProfileControl;
  commands: PromptCommandControl;
  mcp: import("@chili/protocol").RuntimeMcpControlService;
  recovery: SnapshotRecoveryService;
  defaultModelSelection?: ModelSelection;
  defaultReasoningLevel?: HostReasoningLevel;
  defaultServiceTier?: ServiceTier;
  waitForBackgroundTasks(): Promise<void>;
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
    const reconcileStaleRuntimeState = async (): Promise<void> => {
      const now = Date.now();
      await tasks.reconcileStaleTasks({
        staleAfterMs: staleTurnRecoveryMs,
        modes: ["one_shot", "resumable", "background"],
        liveTaskIds: subagents.liveTaskIds(),
        requireLeaseEvidence: true,
        limit: 500,
        summary: "Recovered after the owning runtime stopped",
        error: "stale_agent_worker",
      });
      await eventStore.reconcileStaleTurns({
        staleBefore: now - staleTurnRecoveryMs,
        now,
        createId,
        status: "failed",
        reason: "stale_turn_recovered",
      });
      await service.recoverInputs();
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
    const childToolPolicyResolver = createWorkerToolPolicyResolver(eventStore, Boolean(options.userInputQueue), config.agents);
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
    const assertDelegationEnabled = (input: { sessionId: SessionId; action: string }): Promise<void> => {
      if (!delegationPolicyGate) throw new Error("Delegation policy gate is not initialized");
      return delegationPolicyGate.assertEnabled(input);
    };
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
    // A scoped worker may only receive Bash when Chili owns a concrete host
    // sandbox. An injected runner is opaque, and non-macOS platforms currently
    // have no equivalent sandbox implementation, so fail closed by omitting it.
    const childBashRunner = options.bashRunner || process.platform !== "darwin"
      ? undefined
      : createHostBashRunner({
          permissionProfile: () => permissions.get().profile,
          allowHostSandboxEscape: false,
          resolveResourceDenials,
        });
    const childRunLimiter = new LocalSubagentConcurrencyLimiter(config.agents.maxConcurrent);
    const registry = createToolRegistry(skillRegistryForCwd, bashRunner, processes, memoryOptions);
    const childRegistry = createChildToolRegistry(skillRegistryForCwd, childBashRunner, memoryOptions, childRunLimiter);
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
    const subagentPromptFragments = async (context: { cwd: string }) => buildHostPromptFragments({
      cwd: context.cwd,
      ...(await memoryOptionsForCwd(context.cwd)),
      memoryScopes: await allowedMemoryScopes(context.cwd),
      skillRegistry: await skillRegistryForCwd(context.cwd),
    });
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
      ...(options.sessionClaimLeaseMs !== undefined ? { sessionClaimLeaseMs: options.sessionClaimLeaseMs } : {}),
      ...(options.sessionClaimHeartbeatMs !== undefined ? { sessionClaimHeartbeatMs: options.sessionClaimHeartbeatMs } : {}),
    });
    initializationDrains.push(() => childService.shutdown("runtime_closed"));
    const subagents = new LocalSubagentManager({
      store: eventStore,
      runner: new AgentRunnerSubagentRunner({
        runner: childRuntime,
        runtime: childService,
        store: eventStore,
        maxTurns: DEV_MAX_TURNS,
        promptFragments: subagentPromptFragments,
        modelConfig: ({ sessionId }) => childService.getModelConfig(sessionId),
      }),
      createId,
      runLimiter: childRunLimiter,
      assertDelegationEnabled,
    });
    initializationDrains.push(() => subagents.shutdown("runtime_closed"));
    const tasks = new AgentTaskControlService({
      store: eventStore,
      runtime: childService,
      interruptTask: (taskId, fence) => subagents.interruptTask(taskId, fence),
      createId,
      runLimiter: childRunLimiter,
      assertDelegationEnabled,
    });
    initializationDrains.push(() => tasks.shutdown("runtime_closed"));
    const completeTaskController = createCompleteTaskController(tasks, subagents);
    childRegistry.register(createCompleteTaskTool(completeTaskController));
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
    const teams = new TeamControlService({
      store: eventStore,
      createId,
      sessionOperations: service,
    });
    const resolveTeamSession = async (sessionId: SessionId) => {
      await service.assertSessionTurnAllowed(sessionId);
      const session = (await eventStore.sessions()).find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      return session;
    };
    const teamWorktrees = new TeamWorktreeService({
      teams,
      cwd,
      resolveSession: resolveTeamSession,
      sessionOperations: service,
    });
    const teamVerifier = new TeamTaskVerificationService({
      teams,
      subagents,
      cwd,
      resolveSession: resolveTeamSession,
      sessionOperations: service,
    });
    delegationPolicyGate = new DelegationPolicyGate({
      store: eventStore,
      getDelegationConfig: (sessionId) => service.getDelegationConfig(sessionId),
    });
    const teamMerger = new TeamMergeService({
      teams,
      cwd,
      resolveSession: resolveTeamSession,
      sessionOperations: service,
    });
    const teamDispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store: eventStore,
      worktrees: teamWorktrees,
      cwd,
      assertDelegationEnabled,
      resolveSession: resolveTeamSession,
      sessionOperations: service,
    });
    for (const tool of createGoalTools(createGoalToolController(service))) {
      registry.register(tool);
    }
    const delegationController = createDelegationToolController(service);
    registry.register(createDelegationStatusTool(delegationController));
    registry.register(createDelegationSetTool(delegationController));
    await reconcileStaleRuntimeState();
    const teamRunner = new TeamExecutionRunner({
      teams,
      dispatcher: teamDispatcher,
      verifier: teamVerifier,
      merger: teamMerger,
      events: eventStore,
      cwd,
      resolveSession: resolveTeamSession,
      createSession: async (input) => {
        const session = await service.createSession({ cwd: input.cwd });
        return {
          sessionId: session.sessionId,
          discard: () => service.archiveSession(session.sessionId),
        };
      },
      assertDelegationEnabled,
      sessionOperations: service,
    });
    const agents = new AgentTreeControlService({
      store: eventStore,
      runtime: childService,
      rootRuntime: service,
      taskTurns: tasks,
      runLimiter: childRunLimiter,
      delegationPolicyGate,
      createId,
    });
    const mailboxPump = new AgentMailboxDeliveryPump({
      agents,
      events: eventStore,
    });
    initializationDrains.push(() => mailboxPump.stop());
    mailboxPump.start();
    const controlController = createSubagentControlController(tasks, agents);
    const expansionController = createAgentExpansionController({
      subagents, store: eventStore, limits: config.agents,
      workerPolicyForSession: (sessionId) => resolveWorkerToolPolicy(eventStore, sessionId, Boolean(options.userInputQueue), config.agents),
    });
    const rootMessages = createAgentMessageToolController(tasks, agents, "root");
    const childMessages = createAgentMessageToolController(tasks, agents, "child");
    registry.register(suspendAgentTool(createAgentSpawnTool(expansionController, controlController), childRunLimiter));
    registry.register(createAgentListTool(controlController, rootMessages));
    registry.register(createAgentSendTool(rootMessages));
    registry.register(suspendAgentTool(createAgentWaitTool(controlController), childRunLimiter));
    registry.register(createAgentStopTool(controlController));
    registry.register(suspendAgentTool(createAgentResumeTool(controlController), childRunLimiter));
    childRegistry.register(suspendAgentTool(createAgentSpawnTool(expansionController, controlController), childRunLimiter));
    childRegistry.register(suspendAgentTool(createAgentWaitTool(controlController), childRunLimiter));
    childRegistry.register(createAgentStopTool(controlController));
    childRegistry.register(suspendAgentTool(createAgentResumeTool(controlController), childRunLimiter));
    childRegistry.register(createAgentListTool(controlController, childMessages));
    childRegistry.register(createAgentSendTool(childMessages));
    registerTeamTools(registry, createTeamToolController(teams, tasks, "root"));
    registerTeamTools(childRegistry, createTeamToolController(teams, tasks, "child"));
    const teamDispatchController = createTeamTaskDispatchToolController(teamDispatcher, teams);
    registerTeamDispatchTools(registry, teamDispatchController);
    registry.register(createTeamRunLoopTool(createTeamRunLoopToolController(teamRunner, teams)));
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
      startDrain(() => subagents.shutdown("runtime_closed"));
      startDrain(() => tasks.shutdown("runtime_closed"));
      startDrain(() => processes.close("runtime_closed"));
      startDrain(() => options.approvalQueue?.denyAll("Runtime closed while waiting for approval."));
      startDrain(() => options.userInputQueue?.denyAll("Runtime closed while waiting for user input."));
      startDrain(() => mailboxPump.stop());
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
      tasks,
      agents,
      mailboxPump,
      teams,
      teamDispatcher,
      teamMerger,
      teamRunner,
      permissions,
      commands,
      mcp: mcpRuntime.control,
      recovery,
      ...(runtimeModelSelection ? { defaultModelSelection: runtimeModelSelection } : {}),
      ...(options.reasoningLevel !== undefined ? { defaultReasoningLevel: options.reasoningLevel } : {}),
      ...(options.serviceTier !== undefined ? { defaultServiceTier: options.serviceTier } : {}),
      waitForBackgroundTasks: () => subagents.waitForBackgroundTasks(),
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

function createWorkerToolPolicyResolver(
  store: ObservableEventStore,
  allowUserInput = false,
  agentLimits: HostAgentConfig = DEFAULT_HOST_AGENT_CONFIG,
): ToolAccessPolicyResolver {
  return { resolve: (context) => resolveWorkerToolPolicy(store, context.sessionId, allowUserInput, agentLimits) };
}

async function resolveWorkerToolPolicy(
  store: ObservableEventStore,
  sessionId: SessionId,
  allowUserInput: boolean,
  agentLimits: HostAgentConfig,
): Promise<WorkerToolPolicy> {
  const policy = await findWorkerToolPolicy(store, sessionId);
  const resolved = completeWorkerToolPolicy(policy ?? recursiveWorkerPolicy(defaultScopedWorkerPolicy(), agentLimits), sessionId);
  if (!allowUserInput || !resolved.allowedTools || resolved.allowedTools.includes("request_user_input")) return resolved;
  return { ...resolved, allowedTools: [...resolved.allowedTools, "request_user_input"] };
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
    // Background admission returns a handle without waiting for a child. Keep
    // the parent's slot until it actually waits, so a queued child cannot delay
    // delivery of its own handle to the parent at max_concurrent=1.
    if (tool.name === "agent_spawn" && isRecord(input)) {
      const background = Array.isArray(input.tasks)
        ? (input.completionPolicy ?? "join") !== "join"
        : input.mode === "background";
      if (background) return tool.execute(input, context);
    }
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

async function findWorkerToolPolicy(
  store: ObservableEventStore,
  sessionId: SessionId,
): Promise<WorkerToolPolicy | undefined> {
  let afterEventId: string | undefined;
  let found: WorkerToolPolicy | undefined;

  while (true) {
    const query: { type: string; limit: number; afterEventId?: string } = { type: "agent.spawned", limit: 500 };
    if (afterEventId) query.afterEventId = afterEventId;
    const events = await store.events(query);
    for (const event of events) {
      const policy = workerToolPolicyFromEvent(event, sessionId);
      if (policy) found = policy;
    }
    if (events.length < query.limit) return found;
    const lastEvent = events.at(-1);
    if (!lastEvent) return found;
    afterEventId = lastEvent.id;
  }
}

function workerToolPolicyFromEvent(
  event: EventEnvelope | undefined,
  sessionId: SessionId,
): WorkerToolPolicy | undefined {
  const payload = event?.payload;
  if (!isRecord(payload)) return undefined;
  if (payload.childSessionId !== sessionId) return undefined;
  const policy = payload.workerPolicy;
  if (!isRecord(policy)) return undefined;
  return {
    ...policy,
    allowedTools: stringArray(policy.allowedTools),
    writeScope: stringArray(policy.writeScope),
    executeScope: stringArray(policy.executeScope),
  } as WorkerToolPolicy;
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
    ...(await buildTaskFollowupPromptFragments(input.store, input.sessionId, input.cwd)),
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

async function buildTaskFollowupPromptFragments(
  store: ObservableEventStore,
  sessionId: SessionId,
  cwd: string,
): Promise<PromptFragment[]> {
  const tasks = await store.agentTasks({ childSessionId: sessionId, limit: 10 });
  if (tasks.length === 0) return [];
  if (tasks.length > 1) {
    throw new Error(
      `Agent task metadata invariant violated: child session ${sessionId} maps to ${tasks.length} tasks`,
    );
  }
  return [taskFollowupPromptFragment(tasks[0] as AgentTaskRow, cwd)];
}

function taskFollowupPromptFragment(task: AgentTaskRow, cwd: string): PromptFragment {
  return {
    id: `chili.task.followup.${task.id}`,
    layer: "developer",
    source: "runtime",
    priority: 30,
    lifecycle: "turn",
    trust: "system",
    content: [
      `Subagent task id: ${task.id}. Repository cwd: ${cwd}.`,
      `Agent path: ${task.path} (logical agent identifier, not a filesystem path).`,
      "Use repository-relative paths, or absolute paths under the repository cwd; never prefix file paths with the agent path.",
      "This is a follow-up for an existing task; answer in the task context and call complete_task with this task id when finished.",
    ].join(" "),
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
): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register(createCodeModeTool());
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

function createChildToolRegistry(
  skillRegistryForCwd: (cwd: string) => Promise<SkillRegistry>,
  bashRunner: BashRunner | undefined,
  memoryOptions: Parameters<typeof createMemoryTool>[0],
  runLimiter: LocalSubagentConcurrencyLimiter,
): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  const codeMode = createCodeModeTool();
  registry.register({ ...codeMode, async execute(input, context) {
    try {
      return await codeMode.execute(input, context);
    } finally {
      // VM cleanup is bounded. A nested agent wait may still be restoring this
      // parent's permit; do not let the next model call escape that limit.
      await runLimiter.waitForResume(context.sessionId);
    }
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
  if (bashRunner) {
    registry.register(createBashTool({ runner: bashRunner, allowEscalation: false }));
  }
  registerGitTools(registry);
  registry.register(createToolSearchTool(registry, { groups: CODING_TOOL_GROUPS }));
  return registry;
}

function registerGitTools(registry: InMemoryToolRegistry): void {
  registry.register(createGitStatusTool());
  registry.register(createGitDiffTool());
  registry.register(createGitStageTool());
  registry.register(createGitCommitTool());
  registry.register(createGitBranchTool());
}

function registerTeamTools(registry: InMemoryToolRegistry, controller: TeamToolController): void {
  registry.register(createTeamCreateTool(controller));
  registry.register(createTeamListTool(controller));
  registry.register(createTeamSnapshotTool(controller));
  registry.register(createTeamMemberAddTool(controller));
  registry.register(createTeamMemberListTool(controller));
  registry.register(createTeamTaskCreateTool(controller));
  registry.register(createTeamTaskCreateBatchTool(controller));
  registry.register(createTeamTaskListTool(controller));
  registry.register(createTeamTaskAssignTool(controller));
  registry.register(createTeamTaskClaimTool(controller));
  registry.register(createTeamTaskUpdateTool(controller));
  registry.register(createTeamMessageSendTool(controller));
  registry.register(createTeamMessageListTool(controller));
}

function registerTeamDispatchTools(registry: InMemoryToolRegistry, controller: TeamTaskDispatchToolController): void {
  registry.register(createTeamTaskDispatchTool(controller));
  registry.register(createTeamTaskDispatchBatchTool(controller));
  registry.register(createTeamTaskSyncTool(controller));
  registry.register(createTeamTaskReconcileTool(controller));
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

export function createSubagentControlController(
  tasks: AgentTaskControlService,
  agents: AgentTreeControlService,
): SubagentControlController {
  return {
    async listTasks(input, context) {
      if (input.taskIds) {
        const visible = (await Promise.all(input.taskIds.map((taskId) => tasks.getTask(taskId as TaskId))))
          .filter((task) => task.parentSessionId === context.sessionId)
          .filter((task) => !input.status || task.status === input.status)
          .map(toSubagentTaskRecord);
        return limitItems(visible, input.limit);
      }
      const query: AgentTaskQuery = {};
      if (input.status) query.status = input.status;
      if (input.limit !== undefined) query.limit = input.limit;
      query.parentSessionId = context.sessionId;
      return (await tasks.listTasks(query))
        .filter((task) => task.parentSessionId === context.sessionId)
        .map(toSubagentTaskRecord);
    },
    async waitTask(input, context) {
      const visibleTask = await tasks.getTask(input.taskId as TaskId);
      if (visibleTask.parentSessionId !== context.sessionId) {
        throw new Error(`Agent task is not visible to this session: ${input.taskId}`);
      }
      return toSubagentTaskRecord(
        await tasks.waitForTask({
          taskId: input.taskId as TaskId,
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          signal: context.signal,
        }),
      );
    },
    async waitTasks(input, context) {
      const taskIds = input.taskIds.map((taskId) => taskId as TaskId);
      const visibleTasks = await Promise.all(taskIds.map((taskId) => tasks.getTask(taskId)));
      const hiddenTask = visibleTasks.find((task) => task.parentSessionId !== context.sessionId);
      if (hiddenTask) throw new Error(`Agent task is not visible to this session: ${hiddenTask.id}`);
      const waited = await tasks.waitForTasks({
        taskIds,
        waitFor: input.waitFor ?? "all",
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        signal: context.signal,
      });
      return {
        waitFor: waited.waitFor,
        satisfied: waited.satisfied,
        timedOut: waited.timedOut,
        tasks: waited.tasks.map(toSubagentTaskRecord),
      };
    },
    async followupTask(input, context) {
      await requireVisibleAgentTask(tasks, input.taskId as TaskId, context.sessionId);
      const result = await tasks.followupTask({
        taskId: input.taskId as TaskId,
        text: input.prompt,
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
        signal: context.signal,
      });
      return toSubagentTaskRecord(result.task);
    },
    async closeTask(input, context) {
      await requireVisibleAgentTask(tasks, input.taskId as TaskId, context.sessionId);
      return toSubagentTaskRecord(
        await tasks.closeTask({
          taskId: input.taskId as TaskId,
          ...(input.status ? { status: input.status } : {}),
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.error ? { error: input.error } : {}),
          ...(input.interrupt !== undefined ? { interrupt: input.interrupt } : {}),
        }),
      );
    },
    async listMailbox(input, context) {
      const taskQuery: AgentTaskQuery = {
        parentSessionId: context.sessionId,
        limit: mailboxTaskLimit(input),
      };
      if (input.taskId) taskQuery.taskId = input.taskId as TaskId;
      if (input.path) taskQuery.path = input.path as AgentPath;
      const visibleTasks = (await tasks.listTasks(taskQuery))
        .filter((task) => task.parentSessionId === context.sessionId)
        .filter((task) => (input.taskId ? task.id === input.taskId : true))
        .filter((task) => (input.path ? task.path === input.path : true));
      if ((input.taskId || input.path) && visibleTasks.length === 0) return [];
      const visibleTaskIds = new Set(visibleTasks.map((task) => task.id));
      const visibleRecipientSessionIds = new Set<SessionId>([context.sessionId]);
      for (const task of visibleTasks) {
        if (task.childSessionId) visibleRecipientSessionIds.add(task.childSessionId);
      }

      const messages = await agents.mailbox({
        status: input.status ?? "queued",
        limit: mailboxTaskLimit(input),
      });
      return messages
        .filter((message) => mailboxMessageMatchesScope(
          message,
          visibleTaskIds,
          visibleRecipientSessionIds,
        ))
        .filter((message) => (input.taskId ? message.taskId === input.taskId : true))
        .filter((message) => (input.path ? message.path === input.path : true))
        .slice(0, input.limit ?? 500)
        .map(toSubagentMailboxRecord);
    },
    async consumeMailbox(input, context) {
      const message = (await agents.mailbox({ messageId: input.messageId, limit: 1 }))[0];
      if (!message?.taskId) throw new Error(`Mailbox message is not visible to this session: ${input.messageId}`);
      const task = await tasks.getTask(message.taskId);
      const visibleRecipients = new Set<SessionId>([context.sessionId]);
      if (task.childSessionId) visibleRecipients.add(task.childSessionId);
      if (
        task.parentSessionId !== context.sessionId ||
        (message.recipientSessionId !== undefined && !visibleRecipients.has(message.recipientSessionId))
      ) {
        throw new Error(`Mailbox message is not visible to this session: ${input.messageId}`);
      }
      return toSubagentMailboxRecord(await agents.consumeMailbox({ messageId: input.messageId }));
    },
  };
}

export function createCompleteTaskController(
  tasks: AgentTaskControlService,
  subagents: SubagentController,
): SubagentController {
  return {
    spawnTask(input, context) {
      return subagents.spawnTask(input, context);
    },
    async completeTask(input, context) {
      const taskId = input.taskId as TaskId;
      const task = await tasks.getTask(taskId);
      const mappings = (await tasks.listTasks({ childSessionId: context.sessionId, limit: 2 }))
        .filter((candidate) => candidate.childSessionId === context.sessionId);
      if (
        task.childSessionId !== context.sessionId ||
        mappings.length !== 1 ||
        mappings[0]?.id !== taskId
      ) {
        throw new Error(`Agent task cannot be completed by this session: ${taskId}`);
      }
      try {
        return await tasks.completeTask(input);
      } catch (error) {
        if (error instanceof Error && error.name === "AgentTaskNotRunnableError") {
          return subagents.completeTask(input, context);
        }
        throw error;
      }
    },
  };
}

function createAgentMessageToolController(
  tasks: AgentTaskControlService,
  agents: AgentTreeControlService,
  role: "root" | "child",
): AgentMessageToolController {
  return {
    async sendAgentMessage(input, context) {
      const sender = await resolveAgentMessageSender(
        tasks,
        role,
        context.sessionId,
        input.from,
      );
      const message = await agents.sendMessage({
        ...(input.messageId ? { messageId: input.messageId } : {}),
        from: sender,
        to: input.to,
        content: input.content,
        delivery: input.delivery ?? "queueOnly",
        ...(input.taskId ? { taskId: input.taskId as TaskId } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        sessionId: context.sessionId,
      });
      return toAgentMessageRecord(message);
    },
    async listAgentMessages(input, context) {
      await resolveAgentMessageSender(
        tasks,
        role,
        context.sessionId,
        undefined,
      );
      const visibleTasks = await listAgentMessageScopeTasks(tasks, context.sessionId);
      const visibleTaskIds = new Set(visibleTasks.map((task) => task.id));
      const visibleSessionIds = new Set<SessionId>([context.sessionId]);
      for (const task of visibleTasks) {
        if (task.childSessionId) visibleSessionIds.add(task.childSessionId);
      }
      const messages = await agents.mailbox({
        ...(input.status ? { status: input.status } : {}),
        ...(input.taskId ? { taskId: input.taskId as TaskId } : {}),
        ...(input.path ? { path: input.path as AgentPath } : {}),
        limit: Math.max(input.limit ?? 500, 1000),
      });
      return messages
        .filter((message) => {
          const taskMatches = message.taskId === undefined ? undefined : visibleTaskIds.has(message.taskId);
          const sessionMatches = message.recipientSessionId === undefined
            ? undefined
            : visibleSessionIds.has(message.recipientSessionId);
          if (taskMatches !== undefined && sessionMatches !== undefined) {
            return taskMatches && sessionMatches;
          }
          return taskMatches ?? sessionMatches ?? false;
        })
        .filter((message) => (input.from ? message.fromPath === input.from : true))
        .slice(0, input.limit ?? 500)
        .map(toAgentMessageRecord);
    },
  };
}

async function resolveAgentMessageSender(
  tasks: AgentTaskControlService,
  role: "root" | "child",
  sessionId: SessionId,
  requested: string | undefined,
): Promise<AgentPath> {
  if (role === "root") {
    const root = "/root" as AgentPath;
    if (requested && requested !== root) {
      throw new Error(`Agent message sender ${requested} does not match current agent ${root}`);
    }
    return root;
  }

  const ownTasks = await tasks.listTasks({ childSessionId: sessionId, limit: 1000 });
  if (ownTasks.length === 0) {
    throw new Error(`Agent message sender is unavailable for child session ${sessionId}`);
  }
  if (ownTasks.length > 1) {
    throw new Error(`Agent message sender is ambiguous for session ${sessionId}: ${ownTasks.map((task) => task.id).join(", ")}`);
  }
  const inferred = ownTasks[0]?.path as AgentPath;
  if (requested && requested !== inferred) {
    throw new Error(`Agent message sender ${requested} does not match current agent ${inferred}`);
  }
  return inferred;
}

async function listAgentMessageScopeTasks(
  tasks: AgentTaskControlService,
  sessionId: SessionId,
): Promise<AgentTaskRow[]> {
  const allTasks = await tasks.listTasks({ limit: 2_147_483_647 });
  const visible = new Map<TaskId, AgentTaskRow>();
  const endpoints: SessionId[] = [sessionId];
  const visitedEndpoints = new Set<SessionId>();

  for (const task of allTasks) {
    if (task.childSessionId === sessionId) {
      visible.set(task.id, task);
    }
  }

  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index] as SessionId;
    if (visitedEndpoints.has(endpoint)) continue;
    visitedEndpoints.add(endpoint);
    for (const task of allTasks) {
      if (task.parentSessionId !== endpoint) continue;
      visible.set(task.id, task);
      if (task.childSessionId) {
        endpoints.push(task.childSessionId);
      }
    }
  }

  return [...visible.values()];
}

async function visibleTeamsForSession(
  teams: TeamControlService,
  sessionId: SessionId,
): Promise<TeamRow[]> {
  const allTeams = await teams.listTeams();
  const visibility = await Promise.all(allTeams.map(async (team) => {
    if (team.sessionId === sessionId) return true;
    return (await teams.members(team.id)).some((member) => member.childSessionId === sessionId);
  }));
  return allTeams.filter((_team, index) => visibility[index]);
}

async function requireVisibleTeam(
  teams: TeamControlService,
  teamId: TeamId,
  sessionId: SessionId,
): Promise<TeamRow> {
  const team = (await visibleTeamsForSession(teams, sessionId)).find((candidate) => candidate.id === teamId);
  if (!team) throw new Error(`Team is not visible to this session: ${teamId}`);
  return team;
}

async function requireTeamOwnerOrLead(
  teams: TeamControlService,
  teamId: TeamId,
  sessionId: SessionId,
): Promise<TeamRow> {
  const team = (await teams.listTeams()).find((candidate) => candidate.id === teamId);
  if (!team) throw new Error(`Team is not visible to this session: ${teamId}`);
  if (team.sessionId === sessionId) return team;
  const lead = (await teams.members(teamId)).find((member) => member.path === team.leadPath);
  if (lead?.childSessionId !== sessionId) {
    throw new Error(`Team membership cannot be changed by this session: ${teamId}`);
  }
  return team;
}

async function requireUniqueDescendantAgentTask(
  tasks: AgentTaskControlService,
  childSessionId: SessionId,
  path: AgentPath,
  parentSessionId: SessionId,
): Promise<AgentTaskRow> {
  if (childSessionId === parentSessionId) {
    throw new Error(`Team member session is not a unique visible descendant: ${childSessionId}`);
  }

  const visited = new Set<SessionId>();
  let endpoint = childSessionId;
  let descendant: AgentTaskRow | undefined;
  while (endpoint !== parentSessionId) {
    if (visited.has(endpoint)) {
      throw new Error(`Team member session is not a unique visible descendant: ${childSessionId}`);
    }
    visited.add(endpoint);
    const mappings = (await tasks.listTasks({ childSessionId: endpoint, limit: 2 }))
      .filter((task) => task.childSessionId === endpoint);
    if (mappings.length !== 1) {
      throw new Error(`Team member session is not a unique visible descendant: ${childSessionId}`);
    }
    const task = mappings[0] as AgentTaskRow;
    descendant ??= task;
    if (!task.parentSessionId) {
      throw new Error(`Team member session is not a unique visible descendant: ${childSessionId}`);
    }
    endpoint = task.parentSessionId;
  }

  if (!descendant || descendant.path !== path) {
    throw new Error(`Team member session is not a unique visible descendant: ${childSessionId}`);
  }
  return descendant;
}

export function createTeamToolController(
  teams: TeamControlService,
  tasks: AgentTaskControlService,
  role: "root" | "child",
): TeamToolController {
  return {
    async createTeam(input, context) {
      const leadPath = await resolveAgentMessageSender(tasks, role, context.sessionId, input.leadPath);
      const createInput: Parameters<TeamControlService["createTeam"]>[0] = {
        name: input.name,
        leadPath,
        sessionId: context.sessionId,
      };
      if (input.teamId) createInput.teamId = input.teamId as TeamId;
      if (input.description) createInput.description = input.description;
      if (input.leadName) createInput.leadName = input.leadName;
      if (input.leadRole) createInput.leadRole = input.leadRole;
      if (input.leadStatus) createInput.leadStatus = input.leadStatus;
      if (input.leadWriteScope) createInput.leadWriteScope = input.leadWriteScope;
      return toTeamRecord(await teams.createTeam(createInput));
    },
    async listTeams(input, context) {
      const visible = await visibleTeamsForSession(teams, context.sessionId);
      return limitItems(
        visible.filter((team) => (input.status ? team.status === input.status : true)).map(toTeamRecord),
        input.limit,
      );
    },
    async snapshotTeam(input, context) {
      await requireVisibleTeam(teams, input.teamId as TeamId, context.sessionId);
      return toTeamSnapshotRecord(await teams.snapshot(input.teamId as TeamId));
    },
    async addMember(input, context) {
      await requireTeamOwnerOrLead(teams, input.teamId as TeamId, context.sessionId);
      if (input.childSessionId) {
        await requireUniqueDescendantAgentTask(
          tasks,
          input.childSessionId as SessionId,
          input.path as AgentPath,
          context.sessionId,
        );
      }
      const addInput: Parameters<TeamControlService["addMember"]>[0] = {
        teamId: input.teamId as TeamId,
        path: input.path as AgentPath,
        name: input.name,
        role: input.role,
        sessionId: context.sessionId,
      };
      if (input.status) addInput.status = input.status;
      if (input.childSessionId) addInput.childSessionId = input.childSessionId as SessionId;
      if (input.model) addInput.model = input.model;
      if (input.toolScope) addInput.toolScope = input.toolScope;
      if (input.writeScope) addInput.writeScope = input.writeScope;
      return toTeamMemberRecord(await teams.addMember(addInput));
    },
    async listMembers(input, context) {
      await requireVisibleTeam(teams, input.teamId as TeamId, context.sessionId);
      return limitItems(
        (await teams.members(input.teamId as TeamId))
          .filter((member) => (input.status ? member.status === input.status : true))
          .map(toTeamMemberRecord),
        input.limit,
      );
    },
    async createTask(input, context) {
      await requireVisibleTeam(teams, input.teamId as TeamId, context.sessionId);
      const createInput: Parameters<TeamControlService["createTask"]>[0] = {
        teamId: input.teamId as TeamId,
        title: input.title,
        sessionId: context.sessionId,
      };
      if (input.taskId) createInput.taskId = input.taskId as TaskId;
      if (input.description) createInput.description = input.description;
      if (input.createdBy) createInput.createdBy = input.createdBy as AgentPath;
      if (input.ownerPath) createInput.ownerPath = input.ownerPath as AgentPath;
      if (input.dependsOn) createInput.dependsOn = input.dependsOn as TaskId[];
      if (input.status) createInput.status = input.status;
      if (input.metadata) createInput.metadata = input.metadata;
      return toTeamTaskRecord(await teams.createTask(createInput));
    },
    async listTasks(input, context) {
      await requireVisibleTeam(teams, input.teamId as TeamId, context.sessionId);
      return limitItems(
        (await teams.tasks(input.teamId as TeamId))
          .filter((task) => (input.status ? task.status === input.status : true))
          .filter((task) => (input.ownerPath ? task.ownerPath === input.ownerPath : true))
          .map(toTeamTaskRecord),
        input.limit,
      );
    },
    async assignTask(input, context) {
      await requireVisibleTeam(teams, input.teamId as TeamId, context.sessionId);
      const assignInput: Parameters<TeamControlService["assignTask"]>[0] = {
        teamId: input.teamId as TeamId,
        taskId: input.taskId as TaskId,
        ownerPath: input.ownerPath as AgentPath,
        sessionId: context.sessionId,
      };
      if (input.assignedBy) assignInput.assignedBy = input.assignedBy as AgentPath;
      if (input.message) assignInput.message = input.message;
      if (input.messageDelivery) assignInput.messageDelivery = input.messageDelivery;
      if (input.messageSummary) assignInput.messageSummary = input.messageSummary;
      return toTeamTaskRecord(await teams.assignTask(assignInput));
    },
    async claimTask(input, context) {
      await requireVisibleTeam(teams, input.teamId as TeamId, context.sessionId);
      const claimInput: Parameters<TeamControlService["claimTask"]>[0] = {
        teamId: input.teamId as TeamId,
        taskId: input.taskId as TaskId,
        ownerPath: input.ownerPath as AgentPath,
        sessionId: context.sessionId,
      };
      if (input.claimedBy) claimInput.claimedBy = input.claimedBy as AgentPath;
      const claim = await teams.claimTask(claimInput);
      const result: TeamTaskClaimRecord = { applied: claim.applied };
      if (claim.reason) result.reason = claim.reason;
      if (claim.task) result.task = toTeamTaskRecord(claim.task);
      return result;
    },
    async updateTask(input, context) {
      await requireVisibleTeam(teams, input.teamId as TeamId, context.sessionId);
      const updateInput: Parameters<TeamControlService["updateTask"]>[0] = {
        teamId: input.teamId as TeamId,
        taskId: input.taskId as TaskId,
        sessionId: context.sessionId,
      };
      if (role === "child") updateInput.actorScope = "scoped_worker";
      if (input.status) updateInput.status = input.status;
      if (input.ownerPath) updateInput.ownerPath = input.ownerPath as AgentPath;
      if (input.title) updateInput.title = input.title;
      if (input.description) updateInput.description = input.description;
      if (input.dependsOn) updateInput.dependsOn = input.dependsOn as TaskId[];
      if (input.summary) updateInput.summary = input.summary;
      if (input.error) updateInput.error = input.error;
      if (input.metadata) updateInput.metadata = input.metadata;
      return toTeamTaskRecord(await teams.updateTask(updateInput));
    },
    async sendMessage(input, context) {
      await requireVisibleTeam(teams, input.teamId as TeamId, context.sessionId);
      const messageInput: Parameters<TeamControlService["sendMessage"]>[0] = {
        teamId: input.teamId as TeamId,
        from: input.from as AgentPath,
        to: input.to as AgentPath | "*",
        content: input.content,
        sessionId: context.sessionId,
      };
      if (input.messageId) messageInput.messageId = input.messageId;
      if (input.kind) messageInput.kind = input.kind;
      if (input.delivery) messageInput.delivery = input.delivery;
      if (input.taskId) messageInput.taskId = input.taskId as TaskId;
      if (input.summary) messageInput.summary = input.summary;
      if (input.metadata) messageInput.metadata = input.metadata;
      return toTeamMessageRecord(await teams.sendMessage(messageInput));
    },
    async listMessages(input, context) {
      await requireVisibleTeam(teams, input.teamId as TeamId, context.sessionId);
      return limitItems(
        (await teams.messages(input.teamId as TeamId))
          .filter((message) => (input.path ? message.fromPath === input.path || message.toPath === input.path || message.toPath === "*" : true))
          .filter((message) => (input.taskId ? message.taskId === input.taskId : true))
          .map(toTeamMessageRecord),
        input.limit,
      );
    },
  };
}

function createTeamTaskDispatchToolController(
  dispatcher: TeamTaskDispatchService,
  teams: TeamControlService,
): TeamTaskDispatchToolController {
  return {
    async dispatchTask(input, context) {
      await requireVisibleTeam(teams, input.teamId as TeamId, context.sessionId);
      const dispatchInput: Parameters<TeamTaskDispatchService["dispatchTask"]>[0] = {
        teamId: input.teamId as TeamId,
        taskId: input.taskId as TaskId,
        sessionId: context.sessionId,
        cwd: context.cwd,
        signal: context.signal,
      };
      if (input.ownerPath) dispatchInput.ownerPath = input.ownerPath as AgentPath;
      if (input.mode) dispatchInput.mode = input.mode;
      if (input.prompt) dispatchInput.prompt = input.prompt;
      if (input.sourceCallId !== undefined) dispatchInput.sourceCallId = input.sourceCallId;
      if (input.batchId !== undefined) dispatchInput.batchId = input.batchId;
      if (input.batchIndex !== undefined) dispatchInput.batchIndex = input.batchIndex;
      if (input.expectedBatchSize !== undefined) dispatchInput.expectedBatchSize = input.expectedBatchSize;
      if (input.maxConcurrency !== undefined) dispatchInput.maxConcurrency = input.maxConcurrency;
      return toTeamTaskDispatchRecord(await dispatcher.dispatchTask(dispatchInput));
    },
    async syncTask(input, context) {
      await requireVisibleTeam(teams, input.teamId as TeamId, context.sessionId);
      const syncInput: Parameters<TeamTaskDispatchService["syncTask"]>[0] = {
        teamId: input.teamId as TeamId,
        taskId: input.taskId as TaskId,
        sessionId: context.sessionId,
      };
      return toTeamTaskSyncRecord(await dispatcher.syncTask(syncInput));
    },
    async reconcileTasks(input, context) {
      if (input.teamId) {
        await requireVisibleTeam(teams, input.teamId as TeamId, context.sessionId);
      } else {
        const visibleTeams = (await visibleTeamsForSession(teams, context.sessionId))
          .filter((team) => team.status === "active");
        const reconciled: TeamTaskReconcileRecord = {
          scanned: 0,
          synced: [],
          skipped: [],
          errors: [],
        };
        const limit = input.limit ?? 500;
        for (const team of visibleTeams) {
          if (reconciled.scanned >= limit) break;
          const result = toTeamTaskReconcileRecord(await dispatcher.reconcileTasks({
            teamId: team.id,
            sessionId: context.sessionId,
            limit: limit - reconciled.scanned,
          }));
          reconciled.scanned += result.scanned;
          reconciled.synced.push(...result.synced);
          reconciled.skipped.push(...result.skipped);
          reconciled.errors.push(...result.errors);
        }
        return reconciled;
      }
      const reconcileInput: Parameters<TeamTaskDispatchService["reconcileTasks"]>[0] = {
        sessionId: context.sessionId,
      };
      if (input.teamId) reconcileInput.teamId = input.teamId as TeamId;
      if (input.limit !== undefined) reconcileInput.limit = input.limit;
      return toTeamTaskReconcileRecord(await dispatcher.reconcileTasks(reconcileInput));
    },
  };
}

function createTeamRunLoopToolController(
  teamRunner: TeamExecutionRunner,
  teams: TeamControlService,
): TeamRunLoopToolController {
  return {
    async runTeam(input, context) {
      await requireVisibleTeam(teams, input.teamId as TeamId, context.sessionId);
      const runInput: Parameters<TeamExecutionRunner["run"]>[0] = {
        teamId: input.teamId as TeamId,
        sessionId: context.sessionId,
        cwd: context.cwd,
        once: input.once ?? true,
        signal: context.signal,
      };
      if (input.mode) runInput.mode = input.mode;
      if (input.maxCycles !== undefined) runInput.maxCycles = input.maxCycles;
      if (input.timeoutMs !== undefined) runInput.timeoutMs = input.timeoutMs;
      if (input.pollIntervalMs !== undefined) runInput.pollIntervalMs = input.pollIntervalMs;
      if (input.maxConcurrentDispatches !== undefined) runInput.maxConcurrentDispatches = input.maxConcurrentDispatches;
      if (input.maxConcurrentVerifications !== undefined) runInput.maxConcurrentVerifications = input.maxConcurrentVerifications;
      return toTeamRunLoopRecord(await teamRunner.run(runInput));
    },
  };
}

function mailboxTaskLimit(input: MailboxListToolInput): number {
  return Math.max(input.limit ?? 500, 500);
}

async function requireVisibleAgentTask(
  tasks: AgentTaskControlService,
  taskId: TaskId,
  sessionId: SessionId,
): Promise<AgentTaskRow> {
  const task = await tasks.getTask(taskId);
  if (task.parentSessionId !== sessionId) {
    throw new Error(`Agent task is not visible to this session: ${taskId}`);
  }
  return task;
}

function mailboxMessageMatchesScope(
  message: AgentMailboxRow,
  visibleTaskIds: ReadonlySet<TaskId>,
  visibleRecipientSessionIds: ReadonlySet<SessionId>,
): boolean {
  const taskMatches = message.taskId === undefined
    ? undefined
    : visibleTaskIds.has(message.taskId);
  const recipientMatches = message.recipientSessionId === undefined
    ? undefined
    : visibleRecipientSessionIds.has(message.recipientSessionId);
  if (taskMatches !== undefined && recipientMatches !== undefined) {
    return taskMatches && recipientMatches;
  }
  return taskMatches ?? recipientMatches ?? false;
}

function toSubagentTaskRecord(task: AgentTaskRow): SubagentTaskRecord {
  return {
    taskId: task.id,
    path: task.path,
    taskName: task.taskName,
    status: task.status,
    ...(task.mode ? { mode: task.mode } : {}),
    generation: task.generation,
    ...(task.currentRunId ? { currentRunId: task.currentRunId } : {}),
    ...(task.childSessionId ? { childSessionId: task.childSessionId } : {}),
    ...(task.summary ? { summary: task.summary } : {}),
    ...(task.error ? { error: task.error } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
  };
}

function toSubagentMailboxRecord(message: AgentMailboxRow): SubagentMailboxRecord {
  return {
    messageId: message.id,
    path: message.path,
    fromPath: message.fromPath,
    status: message.status,
    triggerTurn: message.triggerTurn,
    ...(message.taskId ? { taskId: message.taskId } : {}),
    ...(message.recipientSessionId ? { recipientSessionId: message.recipientSessionId } : {}),
    ...(message.message ? { message: message.message } : {}),
    createdAt: message.createdAt,
    ...(message.consumedAt ? { consumedAt: message.consumedAt } : {}),
  };
}

function toAgentMessageRecord(message: AgentMailboxRow): AgentMessageRecord {
  const content = message.message && "content" in message.message ? message.message.content : undefined;
  const metadata = message.message?.metadata;
  return {
    messageId: message.id,
    fromPath: message.fromPath,
    toPath: message.path,
    delivery: message.triggerTurn ? "triggerTurn" : "queueOnly",
    status: message.status,
    ...(message.taskId ? { taskId: message.taskId } : {}),
    ...(message.recipientSessionId ? { recipientSessionId: message.recipientSessionId } : {}),
    ...(content ? { content } : {}),
    ...(metadata ? { metadata } : {}),
    createdAt: message.createdAt,
    ...(message.consumedAt ? { consumedAt: message.consumedAt } : {}),
  };
}

function toTeamRecord(team: TeamRow): TeamRecord {
  return {
    teamId: team.id,
    name: team.name,
    leadPath: team.leadPath,
    status: team.status,
    ...(team.sessionId ? { sessionId: team.sessionId } : {}),
    ...(team.description ? { description: team.description } : {}),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function toTeamSnapshotRecord(snapshot: Awaited<ReturnType<TeamControlService["snapshot"]>>): TeamSnapshotRecord {
  return {
    team: toTeamRecord(snapshot.team),
    members: snapshot.members.map((member) => {
      const record = {
        ...toTeamMemberRecord(member),
        taskIds: member.taskIds,
        deliveryIds: member.deliveryIds,
      };
      return member.currentTask ? { ...record, currentTask: toTeamTaskRecord(member.currentTask) } : record;
    }),
    tasks: snapshot.tasks.map((task) => {
      const record = {
        ...toTeamTaskRecord(task),
        blockedBy: task.blockedBy,
        blocks: task.blocks,
        ready: task.ready,
        messageIds: task.messageIds,
      };
      return {
        ...record,
        ...(task.owner ? { owner: toTeamMemberRecord(task.owner) } : {}),
        ...(task.dispatch !== undefined ? { dispatch: task.dispatch } : {}),
      };
    }),
    messages: snapshot.messages.map((message) => ({
      ...toTeamMessageRecord(message),
      deliveries: message.deliveries.map(toTeamMessageDeliveryRecord),
    })),
    messageDeliveries: snapshot.messageDeliveries.map(toTeamMessageDeliveryRecord),
    stats: snapshot.stats,
    generatedAt: snapshot.generatedAt,
  };
}

function toTeamMemberRecord(member: TeamMemberRow): TeamMemberRecord {
  return {
    teamId: member.teamId,
    path: member.path,
    name: member.name,
    role: member.role,
    status: member.status,
    ...(member.childSessionId ? { childSessionId: member.childSessionId } : {}),
    ...(member.model ? { model: member.model } : {}),
    ...(member.toolScope ? { toolScope: member.toolScope } : {}),
    ...(member.writeScope ? { writeScope: member.writeScope } : {}),
    ...(member.currentTaskId ? { currentTaskId: member.currentTaskId } : {}),
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
    ...(member.closedAt ? { closedAt: member.closedAt } : {}),
  };
}

function toTeamTaskRecord(task: TeamTaskRow): TeamTaskRecord {
  return {
    taskId: task.id,
    teamId: task.teamId,
    title: task.title,
    status: task.status,
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.description ? { description: task.description } : {}),
    ...(task.ownerPath ? { ownerPath: task.ownerPath } : {}),
    ...(task.createdBy ? { createdBy: task.createdBy } : {}),
    dependsOn: task.dependsOn,
    ...(task.summary ? { summary: task.summary } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.metadata ? { metadata: task.metadata } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
  };
}

function toTeamTaskDispatchRecord(
  result: Awaited<ReturnType<TeamTaskDispatchService["dispatchTask"]>>,
): TeamTaskDispatchRecord {
  return {
    status: result.status,
    teamTask: toTeamTaskRecord(result.teamTask),
    ...(result.agentTask ? { agentTask: toTeamDispatchAgentTaskRecord(result.agentTask) } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

function toTeamTaskSyncRecord(result: Awaited<ReturnType<TeamTaskDispatchService["syncTask"]>>): TeamTaskSyncRecord {
  return {
    applied: result.applied,
    teamTask: toTeamTaskRecord(result.teamTask),
    ...(result.agentTask ? { agentTask: toTeamDispatchAgentTaskRecord(result.agentTask) } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

function toTeamTaskReconcileRecord(
  result: Awaited<ReturnType<TeamTaskDispatchService["reconcileTasks"]>>,
): TeamTaskReconcileRecord {
  return {
    scanned: result.scanned,
    synced: result.synced.map(toTeamTaskSyncRecord),
    skipped: result.skipped.map(toTeamTaskSyncRecord),
    errors: result.errors.map((error) => ({
      teamId: error.teamId,
      taskId: error.taskId,
      error: error.error,
    })),
  };
}

function toTeamRunLoopRecord(result: Awaited<ReturnType<TeamExecutionRunner["run"]>>): TeamRunLoopRecord {
  return {
    teamId: result.teamId,
    cycles: result.cycles,
    stopReason: result.stopReason,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    maxConcurrentDispatches: result.maxConcurrentDispatches,
    maxConcurrentVerifications: result.maxConcurrentVerifications,
    dispatched: result.dispatched,
    completed: result.completed,
    accepted: result.accepted,
    reopened: result.reopened,
    merged: result.merged,
    mergeFailed: result.mergeFailed,
    mergeConflicted: result.mergeConflicted,
    mergeSkipped: result.mergeSkipped,
    failed: result.failed,
    blocked: result.blocked,
    skipped: result.skipped,
    stillRunning: result.stillRunning,
    errors: result.errors,
  };
}

function toTeamDispatchAgentTaskRecord(task: TeamDispatchAgentTaskLike): TeamDispatchAgentTaskRecord {
  const record: TeamDispatchAgentTaskRecord = {
    taskId: (task.taskId ?? task.id) as TaskId,
    status: task.status,
  };
  if (task.path) record.path = task.path;
  const runId = task.runId ?? task.currentRunId;
  if (runId) record.runId = runId;
  if (task.childSessionId) record.childSessionId = task.childSessionId;
  if (task.summary) record.summary = task.summary;
  const error = task.error;
  if (error) record.error = error instanceof Error ? error.message : error;
  return record;
}

function toTeamMessageRecord(message: TeamMessageRow): TeamMessageRecord {
  return {
    messageId: message.id,
    teamId: message.teamId,
    fromPath: message.fromPath,
    toPath: message.toPath,
    content: message.content,
    kind: message.kind,
    ...(message.delivery ? { delivery: message.delivery } : {}),
    ...(message.deliveryStatus ? { deliveryStatus: message.deliveryStatus } : {}),
    ...(message.deliveryError ? { deliveryError: message.deliveryError } : {}),
    ...(message.deliveryUpdatedAt ? { deliveryUpdatedAt: message.deliveryUpdatedAt } : {}),
    ...(message.deliveredAt ? { deliveredAt: message.deliveredAt } : {}),
    ...(message.taskId ? { taskId: message.taskId } : {}),
    ...(message.summary ? { summary: message.summary } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
    createdAt: message.createdAt,
  };
}

function toTeamMessageDeliveryRecord(
  delivery: Awaited<ReturnType<TeamControlService["snapshot"]>>["messageDeliveries"][number],
): TeamSnapshotRecord["messageDeliveries"][number] {
  return {
    mailboxMessageId: delivery.mailboxMessageId,
    teamId: delivery.teamId,
    teamMessageId: delivery.teamMessageId,
    path: delivery.path,
    status: delivery.status,
    triggerTurn: delivery.triggerTurn,
    ...(delivery.childSessionId ? { childSessionId: delivery.childSessionId } : {}),
    ...(delivery.error ? { error: delivery.error } : {}),
    queuedAt: delivery.queuedAt,
    updatedAt: delivery.updatedAt,
    ...(delivery.deliveredAt ? { deliveredAt: delivery.deliveredAt } : {}),
  };
}

function limitItems<T>(items: T[], limit: number | undefined): T[] {
  return limit === undefined ? items : items.slice(0, limit);
}

type TeamDispatchAgentTaskLike = (
  | {
      taskId: TaskId;
      id?: TaskId;
    }
  | {
      taskId?: TaskId;
      id: TaskId;
    }
) & {
  path?: AgentPath;
  runId?: string;
  currentRunId?: string;
  childSessionId?: SessionId;
  status: string;
  summary?: string;
  error?: string | Error;
};
