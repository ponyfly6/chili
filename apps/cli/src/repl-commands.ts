import {
  bindBuiltinCommands,
  collectCommandNodes,
  createCommandRegistry,
  importRuntimeCommandCatalog,
  resolveCommand,
  type CommandRegistry,
  type ResolveCommandResult,
} from "@chili/commands";
import {
  DELEGATION_POLICIES,
  REASONING_LEVELS,
  SERVICE_TIERS,
  type DelegationPolicy,
  type ModelSelection,
  type ReasoningLevel,
  type RuntimeCommandCatalog,
  type ServiceTier,
  type SessionId,
} from "@chili/protocol";

export interface CliReplCommandContext {
  sessionId: SessionId;
  cwd: string;
  listSessions(): Promise<void>;
  setModel(sessionId: SessionId, selection: ModelSelection): Promise<void>;
  setReasoning(sessionId: SessionId, reasoningLevel: ReasoningLevel): Promise<void>;
  setServiceTier(sessionId: SessionId, serviceTier: ServiceTier): Promise<void>;
  compactSession(sessionId: SessionId, focus: string): Promise<void>;
  revertSession(sessionId: SessionId, snapshotId: string): Promise<void>;
  showDelegation(sessionId: SessionId, policy?: DelegationPolicy): Promise<void>;
  showAgents(sessionId: SessionId): Promise<void>;
  showMailbox(sessionId: SessionId): Promise<void>;
  listTasks(sessionId: SessionId): Promise<void>;
  showTask(sessionId: SessionId, taskId: string): Promise<void>;
  showMemory(scope: string): Promise<void>;
  addMemory(input: string): Promise<void>;
  reloadMemory(scope: string): Promise<void>;
  runPromptCommand(sessionId: SessionId, commandId: string, args: string): Promise<void>;
}

export interface CliReplDispatchResult {
  status: "handled" | "exit" | "not_command" | "error";
  output?: string;
}

type CliReplCommandAction =
  | { type: "help" }
  | { type: "exit" }
  | { type: "set_model"; selection: ModelSelection }
  | { type: "set_reasoning"; reasoningLevel: ReasoningLevel }
  | { type: "set_service_tier"; serviceTier: ServiceTier }
  | { type: "session_list" }
  | { type: "session_compact"; focus: string }
  | { type: "session_revert"; snapshotId: string }
  | { type: "session_delegation"; policy?: DelegationPolicy }
  | { type: "team_agents" }
  | { type: "team_mailbox" }
  | { type: "team_tasks" }
  | { type: "team_task"; taskId: string }
  | { type: "memory_show"; scope: string }
  | { type: "memory_add"; input: string }
  | { type: "memory_reload"; scope: string }
  | { type: "prompt"; commandId: string; args: string };

export type CliReplCommandRegistry = CommandRegistry<CliReplCommandContext, CliReplCommandAction>;

export function createCliReplCommandRegistry(runtimeCatalog?: RuntimeCommandCatalog): CliReplCommandRegistry {
  const builtins = bindBuiltinCommands<CliReplCommandContext, CliReplCommandAction>({
    help: { run: () => ({ type: "help" }) },
    "model.select": { run: (_context, input) => ({ type: "set_model", selection: parseModelSelection(input.raw) }) },
    "model.service": { run: (_context, input) => ({
      type: "set_service_tier",
      serviceTier: parseValue(input.raw, SERVICE_TIERS, "service tier"),
    }) },
    "thinking.effort": { run: (_context, input) => ({
      type: "set_reasoning",
      reasoningLevel: parseValue(input.raw, REASONING_LEVELS, "reasoning level"),
    }) },
    session: { run: () => ({ type: "session_list" }) },
    "session.list": { run: () => ({ type: "session_list" }) },
    "session.compact": { run: (_context, input) => ({ type: "session_compact", focus: input.raw }) },
    "session.revert": { run: (_context, input) => ({ type: "session_revert", snapshotId: input.raw }) },
    "session.delegation": { run: (_context, input) => ({
      type: "session_delegation",
      ...delegationPolicyInput(input.raw),
    }) },
    team: { run: () => ({ type: "team_agents" }) },
    "team.agents": { run: () => ({ type: "team_agents" }) },
    "team.mailbox": { run: () => ({ type: "team_mailbox" }) },
    "team.tasks": { run: () => ({ type: "team_tasks" }) },
    "team.task": { run: (_context, input) => ({ type: "team_task", taskId: input.raw }) },
    memory: { run: () => ({ type: "memory_show", scope: "" }) },
    "memory.show": { run: (_context, input) => ({ type: "memory_show", scope: input.raw }) },
    "memory.add": { run: (_context, input) => ({ type: "memory_add", input: input.raw }) },
    "memory.reload": { run: (_context, input) => ({ type: "memory_reload", scope: input.raw }) },
    app: {},
    "app.exit": { run: () => ({ type: "exit" }) },
  });
  const prompts = runtimeCatalog
    ? importRuntimeCommandCatalog<CliReplCommandContext, CliReplCommandAction>(runtimeCatalog, (command, _context, input) => ({
        type: "prompt",
        commandId: command.id,
        args: input.raw,
      }))
    : [];
  return createCommandRegistry([...builtins, ...prompts]);
}

export async function dispatchCliReplCommand(
  registry: CliReplCommandRegistry,
  context: CliReplCommandContext,
  input: string,
): Promise<CliReplDispatchResult> {
  const resolved = resolveCommand(registry, context, input);
  if (resolved.status === "not_command") return { status: "not_command" };
  if (resolved.status !== "matched") return { status: "error", output: resolutionMessage(resolved) };
  if (!resolved.command.run) return { status: "error", output: `${resolved.path} cannot be executed.` };
  try {
    const action = await resolved.command.run(context, resolved.args);
    return await executeAction(registry, context, action);
  } catch (error) {
    return { status: "error", output: error instanceof Error ? error.message : String(error) };
  }
}

function resolutionMessage(
  result: Exclude<ResolveCommandResult<CliReplCommandContext, CliReplCommandAction>, { status: "matched" | "not_command" }>,
): string {
  if (result.status === "disabled") return `${result.path} is unavailable: ${result.reason}`;
  if (result.status === "incomplete") {
    const children = result.children.length > 0 ? ` Available: ${result.children.join(", ")}.` : "";
    return `Incomplete command. Usage: ${result.usage}.${children}`;
  }
  const suggestions = result.suggestions.length > 0 ? ` Did you mean ${result.suggestions.join(" or ")}?` : "";
  return `Unknown command token: ${result.token || result.input}.${suggestions}`;
}

async function executeAction(
  registry: CliReplCommandRegistry,
  context: CliReplCommandContext,
  action: CliReplCommandAction,
): Promise<CliReplDispatchResult> {
  switch (action.type) {
    case "help":
      return { status: "handled", output: commandHelp(registry) };
    case "exit":
      return { status: "exit" };
    case "set_model":
      await context.setModel(context.sessionId, action.selection);
      break;
    case "set_reasoning":
      await context.setReasoning(context.sessionId, action.reasoningLevel);
      break;
    case "set_service_tier":
      await context.setServiceTier(context.sessionId, action.serviceTier);
      break;
    case "session_list":
      await context.listSessions();
      break;
    case "session_compact":
      await context.compactSession(context.sessionId, action.focus);
      break;
    case "session_revert":
      await context.revertSession(context.sessionId, action.snapshotId);
      break;
    case "session_delegation":
      await context.showDelegation(context.sessionId, action.policy);
      break;
    case "team_agents":
      await context.showAgents(context.sessionId);
      break;
    case "team_mailbox":
      await context.showMailbox(context.sessionId);
      break;
    case "team_tasks":
      await context.listTasks(context.sessionId);
      break;
    case "team_task":
      await context.showTask(context.sessionId, action.taskId);
      break;
    case "memory_show":
      await context.showMemory(action.scope);
      break;
    case "memory_add":
      await context.addMemory(action.input);
      break;
    case "memory_reload":
      await context.reloadMemory(action.scope);
      break;
    case "prompt":
      await context.runPromptCommand(context.sessionId, action.commandId, action.args);
      break;
  }
  return { status: "handled" };
}

function commandHelp(registry: CliReplCommandRegistry): string {
  return collectCommandNodes(registry.roots())
    .filter((command) => !command.hidden)
    .map((command) => `${`${command.path}${command.argumentHint ? ` ${command.argumentHint}` : ""}`.padEnd(42)} ${command.description}`)
    .join("\n");
}

function parseModelSelection(input: string): ModelSelection {
  const value = input.trim();
  const separator = value.indexOf("/");
  const provider = separator > 0 ? value.slice(0, separator).trim() : "";
  const model = separator > 0 ? value.slice(separator + 1).trim() : "";
  if (!provider || !model) throw new Error("model selection must be <provider/model>");
  return { provider, model };
}

function parseValue<const TValue extends string>(
  input: string,
  values: readonly TValue[],
  label: string,
): TValue {
  const value = input.trim();
  if (!values.includes(value as TValue)) {
    throw new Error(`${label} must be one of: ${values.join(", ")}`);
  }
  return value as TValue;
}

function delegationPolicyInput(input: string): { policy?: DelegationPolicy } {
  const value = input.trim();
  if (!value || value === "status") return {};
  return { policy: parseValue(value, DELEGATION_POLICIES, "delegation policy") };
}
