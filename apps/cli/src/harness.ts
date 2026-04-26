import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AgentRunnerSubagentRunner,
  AgentTreeControlService,
  AgentTaskControlService,
  LocalSubagentManager,
  RuntimeService,
  SingleAgentRuntime,
  SnapshotRecoveryService,
} from "@chili/core";
import type { SessionId, ThreadId } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import {
  DeferredApprovalQueue,
  FileSystemSnapshotProvider,
  InMemoryToolRegistry,
  PolicyApprovalBroker,
  type SubagentController,
  ToolExecutor,
  createApplyPatchTool,
  createBashTool,
  createCompleteTaskTool,
  createEditTool,
  createGitDiffTool,
  createGlobTool,
  createGrepTool,
  createReadFileTool,
  createTaskTool,
  createToolSearchTool,
  createWriteFileTool,
} from "@chili/tools";
import { createCliApprovalBroker, createCliPermissionRules } from "./approval.js";
import { createIdFactory } from "./id.js";
import type { CliModelName } from "./model.js";
import { createCliModel } from "./model.js";
import { CliPrinter, PrintingEventStore } from "./printing-store.js";

export interface CliHarnessOptions {
  cwd: string;
  model: CliModelName;
  yes?: boolean;
  quiet?: boolean;
  approvalQueue?: DeferredApprovalQueue;
}

export interface CliHarness {
  cwd: string;
  store: SqliteEventStore;
  events: ObservableEventStore;
  runtime: SingleAgentRuntime;
  service: RuntimeService;
  tasks: AgentTaskControlService;
  agents: AgentTreeControlService;
  recovery: SnapshotRecoveryService;
  close(): Promise<void>;
}

export async function createCliHarness(options: CliHarnessOptions): Promise<CliHarness> {
  const cwd = resolve(options.cwd);
  const stateDir = join(cwd, ".chili");
  await mkdir(stateDir, { recursive: true });

  const createId = createIdFactory();
  const sqliteStore = new SqliteEventStore(join(stateDir, "chili.sqlite"));
  const printer = new CliPrinter();
  const printableStore = options.quiet ? sqliteStore : new PrintingEventStore(sqliteStore, printer);
  const eventStore = new ObservableEventStore(printableStore);
  const model = await createCliModel(options.model);
  const registry = createToolRegistry();
  const childRegistry = createChildToolRegistry();
  const childSystem = [
    "You are a local Chili subagent. Work in the assigned repository scope, keep results concise, and return a clear final summary.",
  ];
  const snapshotProvider = new FileSystemSnapshotProvider({
    rootDir: join(stateDir, "snapshots"),
    createId,
  });
  const childToolExecutor = new ToolExecutor({
    registry: childRegistry,
    events: { publish: (event) => eventStore.append(event) },
    approvals: createApprovalBroker(options),
    snapshotProvider,
    createId,
    maxResultOutputBytes: 128_000,
  });
  const childRuntime = new SingleAgentRuntime({
    store: eventStore,
    model,
    toolRegistry: childRegistry,
    toolExecutor: childToolExecutor,
    createId,
    contextBudget: {
      maxInputChars: 120_000,
      maxToolResultChars: 16_000,
      preserveRecentMessages: 4,
    },
    retryPolicy: {
      maxAttempts: 2,
      initialDelayMs: 500,
    },
    doomLoopGuard: {
      maxRepeatedToolCalls: 3,
      maxToolCallsPerTurn: 20,
    },
  });
  const childService = new RuntimeService({
    runtime: childRuntime,
    store: eventStore,
    cwd,
    createId,
    maxTurns: 8,
    system: childSystem,
  });
  const subagents = new LocalSubagentManager({
    store: eventStore,
    runner: new AgentRunnerSubagentRunner({
      runner: childRuntime,
      store: eventStore,
      maxTurns: 8,
      system: childSystem,
    }),
    createId,
  });
  const tasks = new AgentTaskControlService({
    store: eventStore,
    runtime: childService,
    interruptTask: (taskId) => subagents.interruptTask(taskId),
    createId,
    system: childSystem,
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
    approvals: createApprovalBroker(options),
    snapshotProvider,
    createId,
    maxResultOutputBytes: 256_000,
  });
  const runtime = new SingleAgentRuntime({
    store: eventStore,
    model,
    toolRegistry: registry,
    toolExecutor,
    createId,
    contextBudget: {
      maxInputChars: 160_000,
      maxToolResultChars: 24_000,
      preserveRecentMessages: 6,
    },
    retryPolicy: {
      maxAttempts: 2,
      initialDelayMs: 500,
    },
    doomLoopGuard: {
      maxRepeatedToolCalls: 3,
      maxToolCallsPerTurn: 40,
    },
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
  });
  const agents = new AgentTreeControlService({
    store: eventStore,
    createId,
  });

  return {
    cwd,
    store: sqliteStore,
    events: eventStore,
    runtime,
    service,
    tasks,
    agents,
    recovery,
    close: async () => {
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

function createToolRegistry(): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  registry.register(createEditTool());
  registry.register(createWriteFileTool());
  registry.register(createApplyPatchTool());
  registry.register(createBashTool());
  registry.register(createGitDiffTool());
  registry.register(createToolSearchTool(registry));
  return registry;
}

function createChildToolRegistry(): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  registry.register(createGitDiffTool());
  registry.register(createToolSearchTool(registry));
  return registry;
}

function createApprovalBroker(options: CliHarnessOptions): PolicyApprovalBroker {
  if (!options.approvalQueue) {
    return createCliApprovalBroker(options.yes === undefined ? {} : { yes: options.yes });
  }

  return new PolicyApprovalBroker({
    rulesets: [createCliPermissionRules(options.yes ?? false)],
    ask: async (request) =>
      options.approvalQueue?.ask(request) ?? { action: "deny", feedback: "Approval queue is unavailable." },
  });
}
