import type { CliModelName, CliReasoningLevel } from "./model.js";
import type { AgentTaskStatus } from "@chili/protocol";

export interface CliArgs {
  command:
    | "run"
    | "serve"
    | "sessions"
    | "revert"
    | "agents"
    | "teams"
    | "team"
    | "team-members"
    | "team-tasks"
    | "team-messages"
    | "team-dispatch"
    | "team-run"
    | "team-run-loop"
    | "team-merge"
    | "team-sync"
    | "team-reconcile"
    | "tasks"
    | "task"
    | "task-followup"
    | "task-wait"
    | "task-close"
    | "tasks-reconcile-stale"
    | "prompt-debug"
    | "mailbox"
    | "mailbox-consume"
    | "skills-list"
    | "skills-enable"
    | "skills-disable"
    | "memory-show"
    | "memory-add"
    | "memory-reload"
    | "mcp"
    | "help";
  prompt?: string;
  cwd: string;
  host: string;
  port: number;
  resume?: string;
  threadId?: string;
  snapshotId?: string;
  taskId?: string;
  teamId?: string;
  messageId?: string;
  memoryScope?: "user" | "project" | "all";
  mcpAction?: "list" | "status" | "reload" | "add" | "remove" | "auth" | "logout";
  mcpServer?: string;
  mcpTransport?: "stdio" | "http" | "sse";
  mcpCommand?: string;
  mcpArgs?: string[];
  mcpEnv?: Record<string, string>;
  mcpUrl?: string;
  mcpDescription?: string;
  mcpEnabled?: boolean;
  mcpCallbackUrl?: string;
  mcpScopes?: string[];
  skillName?: string;
  skillScope?: "user" | "project";
  taskStatus?: Extract<AgentTaskStatus, "completed" | "failed" | "cancelled">;
  timeoutMs?: number;
  staleAfterMs?: number;
  maxCycles?: number;
  provider?: string;
  model?: CliModelName;
  reasoningLevel?: CliReasoningLevel;
  yes: boolean;
  json: boolean;
  content: boolean;
  once: boolean;
  maxTurns: number;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = [...argv];
  const result: CliArgs = {
    command: "run",
    cwd: process.cwd(),
    host: "127.0.0.1",
    port: 4777,
    yes: false,
    json: false,
    content: false,
    once: false,
    maxTurns: 128,
  };
  const prompt: string[] = [];

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;

    if (arg === "sessions" || arg === "ls") {
      result.command = "sessions";
      continue;
    }
    if (arg === "tasks") {
      result.command = "tasks";
      continue;
    }
    if (arg === "recover-tasks") {
      result.command = "tasks-reconcile-stale";
      continue;
    }
    if (arg === "agents" || arg === "tree") {
      result.command = "agents";
      continue;
    }
    if (arg === "teams") {
      result.command = "teams";
      continue;
    }
    if (arg === "team") {
      const next = requireValue(arg, args);
      if (next === "status") {
        result.command = "team";
        result.teamId = requireValue(next, args);
        continue;
      }
      if (next === "members") {
        result.command = "team-members";
        result.teamId = requireValue(next, args);
        continue;
      }
      if (next === "tasks") {
        result.command = "team-tasks";
        result.teamId = requireValue(next, args);
        continue;
      }
      if (next === "messages") {
        result.command = "team-messages";
        result.teamId = requireValue(next, args);
        continue;
      }
      if (next === "run-loop") {
        result.command = "team-run-loop";
        result.teamId = requireValue(next, args);
        continue;
      }
      result.command = "team";
      result.teamId = next;
      continue;
    }
    if (arg === "team-status") {
      result.command = "team";
      result.teamId = requireValue(arg, args);
      continue;
    }
    if (arg === "team-members") {
      result.command = "team-members";
      result.teamId = requireValue(arg, args);
      continue;
    }
    if (arg === "team-tasks") {
      result.command = "team-tasks";
      result.teamId = requireValue(arg, args);
      continue;
    }
    if (arg === "team-messages") {
      result.command = "team-messages";
      result.teamId = requireValue(arg, args);
      continue;
    }
    if (arg === "team-dispatch") {
      result.command = "team-dispatch";
      result.teamId = requireValue(arg, args);
      result.taskId = requireValue(arg, args);
      continue;
    }
    if (arg === "team-run") {
      result.command = "team-run";
      result.teamId = requireValue(arg, args);
      result.taskId = requireValue(arg, args);
      continue;
    }
    if (arg === "team-run-loop") {
      result.command = "team-run-loop";
      result.teamId = requireValue(arg, args);
      continue;
    }
    if (arg === "team-merge") {
      result.command = "team-merge";
      result.teamId = requireValue(arg, args);
      continue;
    }
    if (arg === "team-sync") {
      result.command = "team-sync";
      result.teamId = requireValue(arg, args);
      result.taskId = requireValue(arg, args);
      continue;
    }
    if (arg === "team-reconcile") {
      result.command = "team-reconcile";
      const teamId = args[0];
      if (teamId && !teamId.startsWith("-")) {
        result.teamId = teamId;
        args.shift();
      }
      continue;
    }
    if (arg === "mailbox") {
      result.command = "mailbox";
      continue;
    }
    if (arg === "skills") {
      parseSkillsCommand(result, args);
      continue;
    }
    if (arg === "memory") {
      parseMemoryCommand(result, args, prompt);
      continue;
    }
    if (arg === "mcp") {
      parseMcpCommand(result, args);
      continue;
    }
    if (arg === "prompt-debug") {
      result.command = "prompt-debug";
      continue;
    }
    if (arg === "consume") {
      result.command = "mailbox-consume";
      result.messageId = requireValue(arg, args);
      continue;
    }
    if (arg === "task") {
      result.command = "task";
      result.taskId = requireValue(arg, args);
      continue;
    }
    if (arg === "followup") {
      result.command = "task-followup";
      result.taskId = requireValue(arg, args);
      prompt.push(...args.splice(0));
      continue;
    }
    if (arg === "wait") {
      result.command = "task-wait";
      result.taskId = requireValue(arg, args);
      continue;
    }
    if (arg === "close") {
      result.command = "task-close";
      result.taskId = requireValue(arg, args);
      prompt.push(...args.splice(0));
      continue;
    }
    if (arg === "serve") {
      result.command = "serve";
      continue;
    }
    if (arg === "revert") {
      result.command = "revert";
      const snapshotId = args.shift();
      if (!snapshotId || snapshotId.startsWith("-")) throw new Error("revert requires a snapshot id");
      result.snapshotId = snapshotId;
      continue;
    }
    if (arg === "help" || arg === "--help" || arg === "-h") {
      result.command = "help";
      continue;
    }
    if (arg === "--cwd") {
      result.cwd = requireValue(arg, args);
      continue;
    }
    if (arg === "--host") {
      result.host = requireValue(arg, args);
      continue;
    }
    if (arg === "--port") {
      result.port = Number.parseInt(requireValue(arg, args), 10);
      if (!Number.isInteger(result.port) || result.port <= 0) throw new Error("--port must be a positive integer");
      continue;
    }
    if (arg === "--resume" || arg === "-r") {
      result.resume = requireValue(arg, args);
      continue;
    }
    if (arg === "--thread") {
      result.threadId = requireValue(arg, args);
      continue;
    }
    if (arg === "--provider") {
      result.provider = requireValue(arg, args);
      continue;
    }
    if (arg === "--model") {
      const parsed = parseModelValue(requireValue(arg, args));
      result.model = parsed.model;
      if (parsed.reasoningLevel) result.reasoningLevel = parsed.reasoningLevel;
      continue;
    }
    if (arg === "--thinking" || arg === "--reasoning") {
      result.reasoningLevel = parseReasoningLevel(requireValue(arg, args), arg);
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      result.yes = true;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "--content") {
      result.content = true;
      continue;
    }
    if (arg === "--text") {
      prompt.push(requireValue(arg, args));
      continue;
    }
    if (arg === "--once") {
      result.once = true;
      continue;
    }
    if (arg === "--max-turns") {
      result.maxTurns = Number.parseInt(requireValue(arg, args), 10);
      if (!Number.isInteger(result.maxTurns) || result.maxTurns <= 0) throw new Error("--max-turns must be a positive integer");
      continue;
    }
    if (arg === "--max-cycles") {
      result.maxCycles = Number.parseInt(requireValue(arg, args), 10);
      if (!Number.isInteger(result.maxCycles) || result.maxCycles <= 0) throw new Error("--max-cycles must be a positive integer");
      continue;
    }
    if (arg === "--status") {
      const status = requireValue(arg, args);
      if (status !== "completed" && status !== "failed" && status !== "cancelled") {
        throw new Error("--status must be completed, failed, or cancelled");
      }
      result.taskStatus = status;
      continue;
    }
    if (arg === "--task") {
      result.taskId = requireValue(arg, args);
      continue;
    }
    if (arg === "--timeout-ms") {
      result.timeoutMs = Number.parseInt(requireValue(arg, args), 10);
      if (!Number.isInteger(result.timeoutMs) || result.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");
      continue;
    }
    if (arg === "--stale-after-ms") {
      result.staleAfterMs = Number.parseInt(requireValue(arg, args), 10);
      if (!Number.isInteger(result.staleAfterMs) || result.staleAfterMs < 0) {
        throw new Error("--stale-after-ms must be a non-negative integer");
      }
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    prompt.push(arg, ...args.splice(0));
  }

  if (prompt.length > 0) result.prompt = prompt.join(" ");
  return result;
}

export function usage(): string {
  return [
    "Chili CLI",
    "",
    "Usage:",
    "  bun run chili -- \"fix the failing test\"",
    "  bun run chili -- --resume <session-id> \"continue\"",
    "  bun run chili -- sessions",
    "  bun run chili -- tasks",
    "  bun run chili -- recover-tasks --stale-after-ms 30000",
    "  bun run chili -- agents",
    "  bun run chili -- teams",
    "  bun run chili -- team <team-id>",
    "  bun run chili -- team status <team-id> --json",
    "  bun run chili -- team tasks <team-id>",
    "  bun run chili -- team-members <team-id>",
    "  bun run chili -- team-tasks <team-id>",
    "  bun run chili -- team-messages <team-id>",
    "  bun run chili -- team-dispatch <team-id> <task-id>",
    "  bun run chili -- team-run <team-id> <task-id>",
    "  bun run chili -- team-run-loop <team-id> --once --max-cycles 10 --timeout-ms 30000",
    "  bun run chili -- team-merge <team-id> [--task <task-id>] [--json]",
    "  bun run chili -- team-sync <team-id> <task-id>",
    "  bun run chili -- team-reconcile [team-id]",
    "  bun run chili -- mailbox",
    "  bun run chili -- skills [list|enable|disable] [--user|--project] [skill-name]",
    "  bun run chili -- memory show",
    "  bun run chili -- memory add [--user|--project] \"remember this\"",
    "  bun run chili -- memory reload",
    "  bun run chili -- mcp list [--json]",
    "  bun run chili -- mcp status [server-name] [--json]",
    "  bun run chili -- mcp reload [--json]",
    "  bun run chili -- mcp add <server-name> --command <cmd> [--arg <arg>] [--env KEY=VALUE]",
    "  bun run chili -- mcp remove <server-name>",
    "  bun run chili -- mcp auth <server-name>",
    "  bun run chili -- mcp logout <server-name>",
    "  bun run chili -- prompt-debug [--resume <session-id>] [--thread <thread-id>] [--text <prompt>] [--content] [--json]",
    "  bun run chili -- consume <mailbox-message-id>",
    "  bun run chili -- task <task-id>",
    "  bun run chili -- followup <task-id> \"continue this task\"",
    "  bun run chili -- wait <task-id> --timeout-ms 30000",
    "  bun run chili -- --status cancelled close <task-id> \"stopped\"",
    "  bun run chili -- serve --port 4777",
    "  bun run chili -- revert <snapshot-id> --resume <session-id>",
    "  bun run chili -- --model fake \"hello\"",
    "  bun run chili -- --model deepseek \"hello\"",
    "  bun run chili -- --model kimi \"hello\"",
    "  bun run chili -- --model codex \"hello\"",
    "  bun run chili -- --provider openai-codex --model gpt-5.5 \"hello\"",
    "  bun run chili -- --model openai-codex/gpt-5.3-codex \"hello\"",
    "  bun run chili -- --model gpt-5.3-codex --thinking high \"hello\"",
    "  bun run chili -- --model legacy-minimax \"hello\"",
    "",
    "Options:",
    "  --cwd <path>        Workspace directory, default current directory",
    "  --host <host>       Runtime server host, default 127.0.0.1",
    "  --port <port>       Runtime server port for serve, default 4777",
    "  --resume, -r <id>   Resume a session",
    "  --thread <id>       Select a thread for prompt-debug",
    "  --provider <name>   Provider name: minimax | deepseek | kimi | codex | openai-codex",
    "  --model <pattern>   Provider alias, provider/model, or bare model id; default minimax",
    "  --thinking <level>  Thinking level: off | minimal | low | medium | high | xhigh",
    "  --reasoning <level> Alias for --thinking",
    "  --yes, -y           Auto-approve tool permissions",
    "  --json              Print machine-readable JSON for supported read commands",
    "  --user              Use user scope for memory or skills commands",
    "  --project           Use project scope for memory or skills commands",
    "  --text <prompt>     Assemble prompt-debug as if this current-turn text were submitted",
    "  --content           Include prompt fragment content for prompt-debug",
    "  --once              Run one team execution cycle",
    "  --max-turns <n>     Max automatic tool-use continuation turns before final answer, default 128",
    "  --max-cycles <n>    Max team execution runner cycles",
    "  --status <status>   Task close status: completed | failed | cancelled",
    "  --task <task-id>     Limit team merge to one task",
    "  --timeout-ms <n>    Task wait timeout in milliseconds",
    "  --stale-after-ms <n> Recover running background tasks older than this many milliseconds",
  ].join("\n");
}

function parseMcpCommand(result: CliArgs, args: string[]): void {
  const action = args[0] && !args[0].startsWith("-") ? args.shift() : "list";
  if (
    action !== "list" &&
    action !== "status" &&
    action !== "reload" &&
    action !== "add" &&
    action !== "remove" &&
    action !== "auth" &&
    action !== "logout"
  ) {
    throw new Error(`Unknown mcp command: ${action}`);
  }
  result.command = "mcp";
  result.mcpAction = action;

  if (action === "add") {
    result.mcpServer = requireValue("mcp add", args);
    parseMcpAddFlags(result, args);
    return;
  }

  if (action === "remove" || action === "auth" || action === "logout") {
    result.mcpServer = requireValue(`mcp ${action}`, args);
    parseMcpFlags(result, args);
    return;
  }

  if (action === "status") {
    const server = args[0];
    if (server && !server.startsWith("-")) {
      result.mcpServer = server;
      args.shift();
    }
  }
  parseMcpFlags(result, args);
}

function parseMcpAddFlags(result: CliArgs, args: string[]): void {
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "--transport") {
      result.mcpTransport = parseMcpTransport(requireValue(arg, args));
      continue;
    }
    if (arg === "--command") {
      result.mcpCommand = requireValue(arg, args);
      continue;
    }
    if (arg === "--arg") {
      result.mcpArgs = [...(result.mcpArgs ?? []), requireAnyValue(arg, args)];
      continue;
    }
    if (arg === "--env") {
      const env = parseKeyValue(requireValue(arg, args), arg);
      result.mcpEnv = { ...(result.mcpEnv ?? {}), [env.key]: env.value };
      continue;
    }
    if (arg === "--url") {
      result.mcpUrl = requireValue(arg, args);
      continue;
    }
    if (arg === "--description") {
      result.mcpDescription = requireValue(arg, args);
      continue;
    }
    if (arg === "--enable" || arg === "--enabled") {
      result.mcpEnabled = true;
      continue;
    }
    if (arg === "--disable" || arg === "--disabled") {
      result.mcpEnabled = false;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown mcp add option: ${arg}`);
    throw new Error(`Unexpected mcp add argument: ${arg}`);
  }
}

function parseMcpFlags(result: CliArgs, args: string[]): void {
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "--callback-url") {
      result.mcpCallbackUrl = requireValue(arg, args);
      continue;
    }
    if (arg === "--scope") {
      result.mcpScopes = [...(result.mcpScopes ?? []), requireValue(arg, args)];
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown mcp option: ${arg}`);
    throw new Error(`Unexpected mcp argument: ${arg}`);
  }
}

function parseMcpTransport(value: string): "stdio" | "http" | "sse" {
  if (value === "stdio" || value === "http" || value === "sse") return value;
  throw new Error("--transport must be stdio, http, or sse");
}

function parseKeyValue(value: string, flag: string): { key: string; value: string } {
  const separator = value.indexOf("=");
  if (separator <= 0) throw new Error(`${flag} must use KEY=VALUE`);
  const key = value.slice(0, separator).trim();
  if (!key) throw new Error(`${flag} must include a non-empty key`);
  return { key, value: value.slice(separator + 1) };
}

function parseSkillsCommand(result: CliArgs, args: string[]): void {
  const action = args[0] && !args[0].startsWith("-") ? args.shift() : "list";
  if (action === "list" || action === "show") {
    result.command = "skills-list";
    parseSkillFlags(result, args, false);
    return;
  }
  if (action === "enable") {
    result.command = "skills-enable";
    parseSkillFlags(result, args, true);
    if (!result.skillName) throw new Error("skills enable requires a skill name");
    return;
  }
  if (action === "disable") {
    result.command = "skills-disable";
    parseSkillFlags(result, args, true);
    if (!result.skillName) throw new Error("skills disable requires a skill name");
    return;
  }
  throw new Error(`Unknown skills command: ${action}`);
}

function parseSkillFlags(result: CliArgs, args: string[], nameAllowed: boolean): void {
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--user") {
      result.skillScope = "user";
      continue;
    }
    if (arg === "--project") {
      result.skillScope = "project";
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown skills option: ${arg}`);
    if (!nameAllowed) throw new Error(`Unexpected skills argument: ${arg}`);
    if (result.skillName) throw new Error("skills command accepts one skill name");
    result.skillName = arg;
  }
}

function parseModelValue(value: string): { model: CliModelName; reasoningLevel?: CliReasoningLevel } {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("--model requires a value");
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex === -1) return { model: trimmed };
  const suffix = trimmed.slice(colonIndex + 1);
  if (!isReasoningLevel(suffix)) return { model: trimmed };
  const model = trimmed.slice(0, colonIndex);
  if (!model) throw new Error("--model requires a model before the thinking suffix");
  return { model, reasoningLevel: suffix };
}

function parseReasoningLevel(value: string, flag: string): CliReasoningLevel {
  if (isReasoningLevel(value)) return value;
  throw new Error(`${flag} must be off, minimal, low, medium, high, or xhigh`);
}

function isReasoningLevel(value: string): value is CliReasoningLevel {
  return value === "off"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh";
}

function parseMemoryCommand(result: CliArgs, args: string[], prompt: string[]): void {
  const action = args[0] && !args[0].startsWith("-") ? args.shift() : "show";
  if (action === "show" || action === "list") {
    result.command = "memory-show";
    parseMemoryFlags(result, args, false);
    return;
  }
  if (action === "reload" || action === "refresh") {
    result.command = "memory-reload";
    parseMemoryFlags(result, args, false);
    return;
  }
  if (action === "add") {
    result.command = "memory-add";
    const text: string[] = [];
    parseMemoryFlags(result, args, true, text);
    if (result.memoryScope === "all") throw new Error("memory add scope must be user or project");
    prompt.push(...text);
    return;
  }
  throw new Error(`Unknown memory command: ${action}`);
}

function parseMemoryFlags(
  result: CliArgs,
  args: string[],
  textAllowed: boolean,
  text: string[] = [],
): void {
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--user") {
      result.memoryScope = "user";
      continue;
    }
    if (arg === "--project") {
      result.memoryScope = "project";
      continue;
    }
    if (arg === "--all") {
      result.memoryScope = "all";
      continue;
    }
    if (arg === "--scope") {
      result.memoryScope = parseMemoryScope(requireValue(arg, args));
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown memory option: ${arg}`);
    if (!textAllowed) throw new Error(`Unexpected memory argument: ${arg}`);
    text.push(arg);
  }
}

function parseMemoryScope(value: string): "user" | "project" | "all" {
  if (value === "user" || value === "project" || value === "all") return value;
  throw new Error("--scope must be user, project, or all");
}

function requireValue(flag: string, args: string[]): string {
  const value = args.shift();
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}

function requireAnyValue(flag: string, args: string[]): string {
  const value = args.shift();
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
