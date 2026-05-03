import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AgentRunnerSubagentRunner,
  AgentMailboxDeliveryPump,
  AgentTreeControlService,
  AgentTaskControlService,
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
  createMemoryTool,
  defaultScopedWorkerPolicy,
  type PromptFragment,
  type RuntimePromptTurnContext,
  type WorkerToolPolicy,
} from "@chili/core";
import type { AgentPath, ApprovalDecision, EventEnvelope, SessionId, TaskId, TeamId, ThreadId } from "@chili/protocol";
import { ObservableEventStore, SessionTranscriptJsonlMirror, SqliteEventStore } from "@chili/store";
import type { AgentMailboxRow, AgentTaskQuery, AgentTaskRow, TeamMemberRow, TeamMessageRow, TeamRow, TeamTaskRow } from "@chili/store";
import {
  DeferredApprovalQueue,
  FileSystemSnapshotProvider,
  InMemoryToolRegistry,
  PolicyApprovalBroker,
  type SubagentController,
  type SubagentControlController,
  ToolExecutor,
  createApplyPatchTool,
  createActivateSkillTool,
  createBashTool,
  createMailboxConsumeTool,
  createMailboxListTool,
  createCompleteTaskTool,
  createEditTool,
  createGitBranchTool,
  createGitCommitTool,
  createGitDiffTool,
  createGitStageTool,
  createGitStatusTool,
  createGlobTool,
  createGrepTool,
  createReadFileTool,
  createTaskCloseTool,
  createTaskFollowupTool,
  createTaskListTool,
  createTaskTool,
  createTaskWaitTool,
  createTeamCreateTool,
  createTeamListTool,
  createTeamMemberAddTool,
  createTeamMemberListTool,
  createTeamMessageListTool,
  createTeamMessageSendTool,
  createTeamSnapshotTool,
  createTeamTaskAssignTool,
  createTeamTaskClaimTool,
  createTeamTaskCreateTool,
  createTeamTaskDispatchTool,
  createTeamTaskListTool,
  createTeamTaskReconcileTool,
  createTeamTaskSyncTool,
  createTeamTaskUpdateTool,
  createToolSearchTool,
  createWriteFileTool,
  type MailboxListToolInput,
  type SubagentMailboxRecord,
  type SubagentTaskRecord,
  type TeamDispatchAgentTaskRecord,
  type TeamMemberRecord,
  type TeamMessageRecord,
  type TeamRecord,
  type TeamSnapshotRecord,
  type TeamTaskClaimRecord,
  type TeamTaskDispatchRecord,
  type TeamTaskDispatchToolController,
  type TeamTaskRecord,
  type TeamTaskReconcileRecord,
  type TeamTaskSyncRecord,
  type TeamToolController,
  type ToolAccessPolicyResolver,
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
import { defaultChiliHome } from "@chili/providers";
import { createCliApprovalBroker, createCliApprovalRulesets, persistAllowAlwaysDecision } from "./approval.js";
import { loadCliConfig, type CliConfig } from "./config.js";
import { createIdFactory } from "./id.js";
import type { CliModelName, CliReasoningLevel } from "./model.js";
import { createCliModel } from "./model.js";
import { CliPrinter, PrintingEventStore } from "./printing-store.js";

const DEV_MAX_TURNS = 128;
const DEV_MAX_REPEATED_TOOL_CALLS = 20;
const DEV_MAX_TOOL_CALLS_PER_TURN = 200;
const DEV_MAX_CONCURRENT_TOOL_CALLS = 32;

export interface CliHarnessOptions {
  cwd: string;
  provider?: string;
  model?: CliModelName;
  reasoningLevel?: CliReasoningLevel;
  yes?: boolean;
  quiet?: boolean;
  approvalQueue?: DeferredApprovalQueue;
  chiliHome?: string;
}

export interface CliHarness {
  cwd: string;
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
  recovery: SnapshotRecoveryService;
  close(): Promise<void>;
}

export async function createCliHarness(options: CliHarnessOptions): Promise<CliHarness> {
  const cwd = resolve(options.cwd);
  const stateDir = join(cwd, ".chili");
  await mkdir(stateDir, { recursive: true });

  const createId = createIdFactory();
  const chiliHome = options.chiliHome ?? defaultChiliHome();
  let sqliteStore: SqliteEventStore;
  const sessionMirror = new SessionTranscriptJsonlMirror(join(chiliHome, "sessions"), {
    groupByCwd: true,
    resolveSessionCwd: async (sessionId) => (await sqliteStore.sessions()).find((session) => session.id === sessionId)?.cwd,
  });
  sqliteStore = new SqliteEventStore(join(stateDir, "chili.sqlite"), { mirror: sessionMirror });
  const printer = new CliPrinter();
  const printableStore = options.quiet ? sqliteStore : new PrintingEventStore(sqliteStore, printer);
  const eventStore = new ObservableEventStore(printableStore);
  const childToolPolicyResolver = createWorkerToolPolicyResolver(eventStore);
  const cliModelInput: { provider?: string; model?: CliModelName; reasoningLevel?: CliReasoningLevel } = {};
  if (options.provider !== undefined) cliModelInput.provider = options.provider;
  if (options.model !== undefined) cliModelInput.model = options.model;
  if (options.reasoningLevel !== undefined) cliModelInput.reasoningLevel = options.reasoningLevel;
  const model = await createCliModel(cliModelInput);
  const skillRegistry = await discoverSkills({ cwd });
  const config = await loadCliConfig(cwd, { chiliHome });
  const registry = createToolRegistry(skillRegistry);
  const childRegistry = createChildToolRegistry(skillRegistry);
  const promptFragments = (context: { cwd: string; turn?: RuntimePromptTurnContext }) =>
    buildCliPromptFragments({
      cwd: context.cwd,
      skillRegistry,
      ...(context.turn ? { turn: context.turn } : {}),
    });
  const childPromptFragments = (context: { sessionId: SessionId; threadId: ThreadId; cwd: string; turn?: RuntimePromptTurnContext }) =>
    buildCliChildPromptFragments({
      cwd: context.cwd,
      sessionId: context.sessionId,
      threadId: context.threadId,
      skillRegistry,
      store: eventStore,
      ...(context.turn ? { turn: context.turn } : {}),
    });
  const subagentPromptFragments = (context: { cwd: string }) => buildCliPromptFragments({ cwd: context.cwd, skillRegistry });
  const snapshotProvider = new FileSystemSnapshotProvider({
    rootDir: join(stateDir, "snapshots"),
    createId,
  });
  const childToolExecutor = new ToolExecutor({
    registry: childRegistry,
    events: { publish: (event) => eventStore.append(event) },
    approvals: createApprovalBroker(options, config),
    policyResolver: childToolPolicyResolver,
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
    toolPolicyResolver: childToolPolicyResolver,
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
    store: eventStore,
    cwd,
    createId,
    maxTurns: DEV_MAX_TURNS,
    contextBudget: childContextBudget,
    promptFragments: childPromptFragments,
  });
  const subagents = new LocalSubagentManager({
    store: eventStore,
    runner: new AgentRunnerSubagentRunner({
      runner: childRuntime,
      store: eventStore,
      maxTurns: DEV_MAX_TURNS,
      promptFragments: subagentPromptFragments,
    }),
    createId,
  });
  const tasks = new AgentTaskControlService({
    store: eventStore,
    runtime: childService,
    interruptTask: (taskId) => subagents.interruptTask(taskId),
    createId,
  });
  const teams = new TeamControlService({
    store: eventStore,
    createId,
  });
  const teamWorktrees = new TeamWorktreeService({
    teams,
    cwd,
  });
  const teamDispatcher = new TeamTaskDispatchService({
    teams,
    subagents,
    store: eventStore,
    worktrees: teamWorktrees,
    cwd,
  });
  const teamVerifier = new TeamTaskVerificationService({
    teams,
    subagents,
    cwd,
  });
  const teamMerger = new TeamMergeService({
    teams,
    cwd,
  });
  const completeTaskController: SubagentController = {
    spawnTask(input, context) {
      return subagents.spawnTask(input, context);
    },
    async completeTask(input) {
      try {
        return await tasks.completeTask(input);
      } catch (error) {
        if (error instanceof Error && error.name === "AgentTaskNotRunnableError") {
          return subagents.completeTask(input);
        }
        throw error;
      }
    },
  };
  registry.register(createTaskTool(subagents));
  childRegistry.register(createCompleteTaskTool(completeTaskController));
  const toolExecutor = new ToolExecutor({
    registry,
    events: { publish: (event) => eventStore.append(event) },
    approvals: createApprovalBroker(options, config),
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
  const recovery = new SnapshotRecoveryService({
    store: eventStore,
    snapshotProvider,
    createId,
  });
  const service = new RuntimeService({
    runtime,
    store: eventStore,
    cwd,
    createId,
    maxTurns: DEV_MAX_TURNS,
    contextBudget: runtimeContextBudget,
    promptFragments,
  });
  const teamRunner = new TeamExecutionRunner({
    teams,
    dispatcher: teamDispatcher,
    verifier: teamVerifier,
    merger: teamMerger,
    events: eventStore,
    cwd,
    createSession: async (input) => service.createSession({ cwd: input.cwd }),
  });
  const agents = new AgentTreeControlService({
    store: eventStore,
    runtime: childService,
    createId,
  });
  const mailboxPump = new AgentMailboxDeliveryPump({
    agents,
    events: eventStore,
  });
  mailboxPump.start();
  const controlController = createSubagentControlController(tasks, agents);
  registry.register(createTaskListTool(controlController));
  registry.register(createTaskWaitTool(controlController));
  registry.register(createTaskFollowupTool(controlController));
  registry.register(createTaskCloseTool(controlController));
  registry.register(createMailboxListTool(controlController));
  registry.register(createMailboxConsumeTool(controlController));
  const teamController = createTeamToolController(teams);
  registerTeamTools(registry, teamController);
  registerTeamTools(childRegistry, teamController);
  const teamDispatchController = createTeamTaskDispatchToolController(teamDispatcher);
  registerTeamDispatchTools(registry, teamDispatchController);

  return {
    cwd,
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
    recovery,
    close: async () => {
      await mailboxPump.stop();
      await subagents.waitForBackgroundTasks();
      sqliteStore.close();
    },
  };
}

export async function latestThreadId(store: SqliteEventStore, sessionId: SessionId): Promise<ThreadId | undefined> {
  const events = await store.events({ sessionId, limit: 5000 });
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.threadId) return event.threadId;
  }
  return undefined;
}

export function newThreadId(): ThreadId {
  return createIdFactory()("thread") as ThreadId;
}

function createWorkerToolPolicyResolver(store: ObservableEventStore): ToolAccessPolicyResolver {
  return {
    async resolve(context) {
      const policy = await findWorkerToolPolicy(store, context.sessionId, context.threadId);
      return policy ?? defaultScopedWorkerPolicy();
    },
  };
}

async function findWorkerToolPolicy(
  store: ObservableEventStore,
  sessionId: SessionId,
  threadId: ThreadId | undefined,
): Promise<WorkerToolPolicy | undefined> {
  let afterEventId: string | undefined;
  let found: WorkerToolPolicy | undefined;

  while (true) {
    const query: { type: string; limit: number; afterEventId?: string } = { type: "agent.spawned", limit: 500 };
    if (afterEventId) query.afterEventId = afterEventId;
    const events = await store.events(query);
    for (const event of events) {
      const policy = workerToolPolicyFromEvent(event, sessionId, threadId);
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
  threadId: ThreadId | undefined,
): WorkerToolPolicy | undefined {
  const payload = event?.payload;
  if (!isRecord(payload)) return undefined;
  if (payload.childSessionId !== sessionId) return undefined;
  if (threadId && payload.childThreadId !== threadId) return undefined;
  const policy = payload.workerPolicy;
  if (!isRecord(policy)) return undefined;
  return {
    ...policy,
    allowedTools: stringArray(policy.allowedTools),
    writeScope: stringArray(policy.writeScope),
    executeScope: stringArray(policy.executeScope),
  } as WorkerToolPolicy;
}

export async function buildCliPromptFragments(input: {
  cwd: string;
  skillRegistry: SkillRegistry;
  turn?: RuntimePromptTurnContext;
  homeDir?: string;
  projectRoot?: string;
}): Promise<PromptFragment[]> {
  const context: PromptFragment[] = [
    chiliBasePromptFragment(),
    ...(await buildChiliMemoryPromptFragments({
      cwd: input.cwd,
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    })),
  ];
  const skillsPrompt = formatAvailableSkillsPrompt(input.skillRegistry.list());
  if (skillsPrompt) {
    context.push({
      id: "chili.skills.catalog",
      layer: "developer",
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

export async function buildCliChildPromptFragments(input: {
  cwd: string;
  sessionId: SessionId;
  threadId: ThreadId;
  skillRegistry: SkillRegistry;
  store: ObservableEventStore;
  turn?: RuntimePromptTurnContext;
  homeDir?: string;
  projectRoot?: string;
}): Promise<PromptFragment[]> {
  return [
    ...(await buildCliPromptFragments({
      cwd: input.cwd,
      skillRegistry: input.skillRegistry,
      ...(input.turn ? { turn: input.turn } : {}),
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    })),
    chiliChildRuntimeBasePromptFragment(),
    ...(await buildTaskFollowupPromptFragments(input.store, input.sessionId, input.threadId)),
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
  threadId: ThreadId,
): Promise<PromptFragment[]> {
  const tasks = await store.agentTasks({ childSessionId: sessionId, limit: 10 });
  const task = tasks.find((candidate) => candidate.childThreadId === threadId);
  return task ? [taskFollowupPromptFragment(task)] : [];
}

function taskFollowupPromptFragment(task: AgentTaskRow): PromptFragment {
  const cwd = task.cwd ? ` Repository cwd: ${task.cwd}.` : "";
  return {
    id: `chili.task.followup.${task.id}`,
    layer: "developer",
    source: "runtime",
    priority: 30,
    lifecycle: "turn",
    trust: "system",
    content: [
      `Subagent task id: ${task.id}.${cwd}`,
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

function createToolRegistry(skillRegistry: SkillRegistry): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  registry.register(createMemoryTool());
  registry.register(createActivateSkillTool(skillRegistry));
  registry.register(createEditTool());
  registry.register(createWriteFileTool());
  registry.register(createApplyPatchTool());
  registry.register(createBashTool());
  registerGitTools(registry);
  registry.register(createToolSearchTool(registry));
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

function createChildToolRegistry(skillRegistry: SkillRegistry): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  registry.register(createMemoryTool());
  registry.register(createActivateSkillTool(skillRegistry));
  registry.register(createEditTool());
  registry.register(createWriteFileTool());
  registry.register(createApplyPatchTool());
  registry.register(createBashTool());
  registerGitTools(registry);
  registry.register(createToolSearchTool(registry));
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
  registry.register(createTeamTaskListTool(controller));
  registry.register(createTeamTaskAssignTool(controller));
  registry.register(createTeamTaskClaimTool(controller));
  registry.register(createTeamTaskUpdateTool(controller));
  registry.register(createTeamMessageSendTool(controller));
  registry.register(createTeamMessageListTool(controller));
}

function registerTeamDispatchTools(registry: InMemoryToolRegistry, controller: TeamTaskDispatchToolController): void {
  registry.register(createTeamTaskDispatchTool(controller));
  registry.register(createTeamTaskSyncTool(controller));
  registry.register(createTeamTaskReconcileTool(controller));
}

function createApprovalBroker(options: CliHarnessOptions, config: CliConfig): PolicyApprovalBroker {
  if (!options.approvalQueue) {
    return createCliApprovalBroker({
      ...(options.yes === undefined ? {} : { yes: options.yes }),
      config,
      ...(options.chiliHome ? { chiliHome: options.chiliHome } : {}),
    });
  }

  let broker: PolicyApprovalBroker;
  broker = new PolicyApprovalBroker({
    rulesets: createCliApprovalRulesets(options.yes ?? false, config),
    ask: async (request) => {
      const decision: ApprovalDecision = options.approvalQueue
        ? await options.approvalQueue.ask(request)
        : { action: "deny", feedback: "Approval queue is unavailable." };
      return persistAllowAlwaysDecision(request, decision, options.chiliHome ? { chiliHome: options.chiliHome } : {});
    },
    onSessionGrant: async () => {
      await options.approvalQueue?.recheckPending((request) => broker.preflight(request));
    },
  });
  return broker;
}

function createSubagentControlController(
  tasks: AgentTaskControlService,
  agents: AgentTreeControlService,
): SubagentControlController {
  return {
    async listTasks(input, context) {
      const query: AgentTaskQuery = {};
      if (input.status) query.status = input.status;
      if (input.limit !== undefined) query.limit = input.limit;
      if (!input.all) query.parentSessionId = context.sessionId;
      return (await tasks.listTasks(query)).map(toSubagentTaskRecord);
    },
    async waitTask(input) {
      return toSubagentTaskRecord(
        await tasks.waitForTask({
          taskId: input.taskId as TaskId,
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        }),
      );
    },
    async followupTask(input) {
      const result = await tasks.followupTask({
        taskId: input.taskId as TaskId,
        text: input.prompt,
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
      });
      return toSubagentTaskRecord(result.task);
    },
    async closeTask(input) {
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
      const messages = await agents.mailbox({
        status: input.status ?? "queued",
        ...(input.taskId ? { taskId: input.taskId as TaskId } : {}),
        ...(input.path ? { path: input.path as AgentPath } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      if (input.all || input.taskId || input.path) return messages.map(toSubagentMailboxRecord);

      const visibleTaskIds = new Set(
        (await tasks.listTasks({ parentSessionId: context.sessionId, limit: mailboxTaskLimit(input) })).map((task) => task.id),
      );
      return messages.filter((message) => message.taskId && visibleTaskIds.has(message.taskId)).map(toSubagentMailboxRecord);
    },
    async consumeMailbox(input, context) {
      const message = (await agents.mailbox({ messageId: input.messageId, limit: 1 }))[0];
      if (!message?.taskId) throw new Error(`Mailbox message is not visible to this session: ${input.messageId}`);
      const task = await tasks.getTask(message.taskId);
      if (task.parentSessionId !== context.sessionId) {
        throw new Error(`Mailbox message is not visible to this session: ${input.messageId}`);
      }
      return toSubagentMailboxRecord(await agents.consumeMailbox({ messageId: input.messageId }));
    },
  };
}

function createTeamToolController(teams: TeamControlService): TeamToolController {
  return {
    async createTeam(input, context) {
      const createInput: Parameters<TeamControlService["createTeam"]>[0] = {
        name: input.name,
        leadPath: input.leadPath as AgentPath,
        sessionId: context.sessionId,
      };
      if (context.threadId) createInput.threadId = context.threadId;
      if (input.teamId) createInput.teamId = input.teamId as TeamId;
      if (input.description) createInput.description = input.description;
      if (input.leadName) createInput.leadName = input.leadName;
      if (input.leadRole) createInput.leadRole = input.leadRole;
      if (input.leadStatus) createInput.leadStatus = input.leadStatus;
      if (input.leadWriteScope) createInput.leadWriteScope = input.leadWriteScope;
      return toTeamRecord(await teams.createTeam(createInput));
    },
    async listTeams(input) {
      return limitItems(
        (await teams.listTeams()).filter((team) => (input.status ? team.status === input.status : true)).map(toTeamRecord),
        input.limit,
      );
    },
    async snapshotTeam(input) {
      return toTeamSnapshotRecord(await teams.snapshot(input.teamId as TeamId));
    },
    async addMember(input, context) {
      const addInput: Parameters<TeamControlService["addMember"]>[0] = {
        teamId: input.teamId as TeamId,
        path: input.path as AgentPath,
        name: input.name,
        role: input.role,
        sessionId: context.sessionId,
      };
      if (context.threadId) addInput.threadId = context.threadId;
      if (input.status) addInput.status = input.status;
      if (input.childSessionId) addInput.childSessionId = input.childSessionId as SessionId;
      if (input.childThreadId) addInput.childThreadId = input.childThreadId as ThreadId;
      if (input.model) addInput.model = input.model;
      if (input.toolScope) addInput.toolScope = input.toolScope;
      if (input.writeScope) addInput.writeScope = input.writeScope;
      return toTeamMemberRecord(await teams.addMember(addInput));
    },
    async listMembers(input) {
      return limitItems(
        (await teams.members(input.teamId as TeamId))
          .filter((member) => (input.status ? member.status === input.status : true))
          .map(toTeamMemberRecord),
        input.limit,
      );
    },
    async createTask(input, context) {
      const createInput: Parameters<TeamControlService["createTask"]>[0] = {
        teamId: input.teamId as TeamId,
        title: input.title,
        sessionId: context.sessionId,
      };
      if (context.threadId) createInput.threadId = context.threadId;
      if (input.taskId) createInput.taskId = input.taskId as TaskId;
      if (input.description) createInput.description = input.description;
      if (input.createdBy) createInput.createdBy = input.createdBy as AgentPath;
      if (input.ownerPath) createInput.ownerPath = input.ownerPath as AgentPath;
      if (input.dependsOn) createInput.dependsOn = input.dependsOn as TaskId[];
      if (input.status) createInput.status = input.status;
      if (input.metadata) createInput.metadata = input.metadata;
      return toTeamTaskRecord(await teams.createTask(createInput));
    },
    async listTasks(input) {
      return limitItems(
        (await teams.tasks(input.teamId as TeamId))
          .filter((task) => (input.status ? task.status === input.status : true))
          .filter((task) => (input.ownerPath ? task.ownerPath === input.ownerPath : true))
          .map(toTeamTaskRecord),
        input.limit,
      );
    },
    async assignTask(input, context) {
      const assignInput: Parameters<TeamControlService["assignTask"]>[0] = {
        teamId: input.teamId as TeamId,
        taskId: input.taskId as TaskId,
        ownerPath: input.ownerPath as AgentPath,
        sessionId: context.sessionId,
      };
      if (context.threadId) assignInput.threadId = context.threadId;
      if (input.assignedBy) assignInput.assignedBy = input.assignedBy as AgentPath;
      if (input.message) assignInput.message = input.message;
      if (input.messageDelivery) assignInput.messageDelivery = input.messageDelivery;
      if (input.messageSummary) assignInput.messageSummary = input.messageSummary;
      return toTeamTaskRecord(await teams.assignTask(assignInput));
    },
    async claimTask(input, context) {
      const claimInput: Parameters<TeamControlService["claimTask"]>[0] = {
        teamId: input.teamId as TeamId,
        taskId: input.taskId as TaskId,
        ownerPath: input.ownerPath as AgentPath,
        sessionId: context.sessionId,
      };
      if (context.threadId) claimInput.threadId = context.threadId;
      if (input.claimedBy) claimInput.claimedBy = input.claimedBy as AgentPath;
      const claim = await teams.claimTask(claimInput);
      const result: TeamTaskClaimRecord = { applied: claim.applied };
      if (claim.reason) result.reason = claim.reason;
      if (claim.task) result.task = toTeamTaskRecord(claim.task);
      return result;
    },
    async updateTask(input, context) {
      const updateInput: Parameters<TeamControlService["updateTask"]>[0] = {
        teamId: input.teamId as TeamId,
        taskId: input.taskId as TaskId,
        sessionId: context.sessionId,
      };
      if (context.threadId) updateInput.threadId = context.threadId;
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
      const messageInput: Parameters<TeamControlService["sendMessage"]>[0] = {
        teamId: input.teamId as TeamId,
        from: input.from as AgentPath,
        to: input.to as AgentPath | "*",
        content: input.content,
        sessionId: context.sessionId,
      };
      if (context.threadId) messageInput.threadId = context.threadId;
      if (input.messageId) messageInput.messageId = input.messageId;
      if (input.kind) messageInput.kind = input.kind;
      if (input.delivery) messageInput.delivery = input.delivery;
      if (input.taskId) messageInput.taskId = input.taskId as TaskId;
      if (input.summary) messageInput.summary = input.summary;
      if (input.metadata) messageInput.metadata = input.metadata;
      return toTeamMessageRecord(await teams.sendMessage(messageInput));
    },
    async listMessages(input) {
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

function createTeamTaskDispatchToolController(dispatcher: TeamTaskDispatchService): TeamTaskDispatchToolController {
  return {
    async dispatchTask(input, context) {
      const dispatchInput: Parameters<TeamTaskDispatchService["dispatchTask"]>[0] = {
        teamId: input.teamId as TeamId,
        taskId: input.taskId as TaskId,
        sessionId: context.sessionId,
        cwd: context.cwd,
        signal: context.signal,
      };
      if (context.threadId) dispatchInput.threadId = context.threadId;
      if (input.ownerPath) dispatchInput.ownerPath = input.ownerPath as AgentPath;
      if (input.mode) dispatchInput.mode = input.mode;
      if (input.prompt) dispatchInput.prompt = input.prompt;
      return toTeamTaskDispatchRecord(await dispatcher.dispatchTask(dispatchInput));
    },
    async syncTask(input, context) {
      const syncInput: Parameters<TeamTaskDispatchService["syncTask"]>[0] = {
        teamId: input.teamId as TeamId,
        taskId: input.taskId as TaskId,
        sessionId: context.sessionId,
      };
      if (context.threadId) syncInput.threadId = context.threadId;
      return toTeamTaskSyncRecord(await dispatcher.syncTask(syncInput));
    },
    async reconcileTasks(input, context) {
      const reconcileInput: Parameters<TeamTaskDispatchService["reconcileTasks"]>[0] = {
        sessionId: context.sessionId,
      };
      if (context.threadId) reconcileInput.threadId = context.threadId;
      if (input.teamId) reconcileInput.teamId = input.teamId as TeamId;
      if (input.limit !== undefined) reconcileInput.limit = input.limit;
      return toTeamTaskReconcileRecord(await dispatcher.reconcileTasks(reconcileInput));
    },
  };
}

function mailboxTaskLimit(input: MailboxListToolInput): number {
  return Math.max(input.limit ?? 500, 500);
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
    ...(task.childThreadId ? { childThreadId: task.childThreadId } : {}),
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
    ...(message.childSessionId ? { childSessionId: message.childSessionId } : {}),
    ...(message.childThreadId ? { childThreadId: message.childThreadId } : {}),
    ...(message.message ? { message: message.message } : {}),
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
    ...(member.childThreadId ? { childThreadId: member.childThreadId } : {}),
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

function toTeamDispatchAgentTaskRecord(task: TeamDispatchAgentTaskLike): TeamDispatchAgentTaskRecord {
  const record: TeamDispatchAgentTaskRecord = {
    taskId: (task.taskId ?? task.id) as TaskId,
    status: task.status,
  };
  if (task.path) record.path = task.path;
  const runId = task.runId ?? task.currentRunId;
  if (runId) record.runId = runId;
  if (task.childSessionId) record.childSessionId = task.childSessionId;
  if (task.childThreadId) record.childThreadId = task.childThreadId;
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
    ...(delivery.childThreadId ? { childThreadId: delivery.childThreadId } : {}),
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
  childThreadId?: ThreadId;
  status: string;
  summary?: string;
  error?: string | Error;
};
