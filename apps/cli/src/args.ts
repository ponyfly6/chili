import type { CliModelName } from "./model.js";
import type { AgentTaskStatus } from "@chili/protocol";

export interface CliArgs {
  command:
    | "run"
    | "serve"
    | "sessions"
    | "revert"
    | "agents"
    | "tasks"
    | "task"
    | "task-followup"
    | "task-wait"
    | "task-close"
    | "mailbox"
    | "mailbox-consume"
    | "help";
  prompt?: string;
  cwd: string;
  host: string;
  port: number;
  resume?: string;
  snapshotId?: string;
  taskId?: string;
  messageId?: string;
  taskStatus?: Extract<AgentTaskStatus, "completed" | "failed" | "cancelled">;
  timeoutMs?: number;
  model: CliModelName;
  yes: boolean;
  maxTurns: number;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = [...argv];
  const result: CliArgs = {
    command: "run",
    cwd: process.cwd(),
    host: "127.0.0.1",
    port: 4777,
    model: "minimax",
    yes: false,
    maxTurns: 12,
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
    if (arg === "agents" || arg === "tree") {
      result.command = "agents";
      continue;
    }
    if (arg === "mailbox") {
      result.command = "mailbox";
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
    if (arg === "--model") {
      const model = requireValue(arg, args);
      if (!isCliModelName(model)) throw new Error(`Unknown model: ${model}`);
      result.model = model;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      result.yes = true;
      continue;
    }
    if (arg === "--max-turns") {
      result.maxTurns = Number.parseInt(requireValue(arg, args), 10);
      if (!Number.isInteger(result.maxTurns) || result.maxTurns <= 0) throw new Error("--max-turns must be a positive integer");
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
    if (arg === "--timeout-ms") {
      result.timeoutMs = Number.parseInt(requireValue(arg, args), 10);
      if (!Number.isInteger(result.timeoutMs) || result.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");
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
    "  bun run chili -- agents",
    "  bun run chili -- mailbox",
    "  bun run chili -- consume <mailbox-message-id>",
    "  bun run chili -- task <task-id>",
    "  bun run chili -- followup <task-id> \"continue this task\"",
    "  bun run chili -- wait <task-id> --timeout-ms 30000",
    "  bun run chili -- --status cancelled close <task-id> \"stopped\"",
    "  bun run chili -- serve --port 4777",
    "  bun run chili -- revert <snapshot-id> --resume <session-id>",
    "  bun run chili -- --model fake \"hello\"",
    "  bun run chili -- --model legacy-minimax \"hello\"",
    "",
    "Options:",
    "  --cwd <path>        Workspace directory, default current directory",
    "  --host <host>       Runtime server host, default 127.0.0.1",
    "  --port <port>       Runtime server port for serve, default 4777",
    "  --resume, -r <id>   Resume a session",
    "  --model <name>      minimax | fake | legacy-minimax, default minimax",
    "  --yes, -y           Auto-approve tool permissions",
    "  --max-turns <n>     Max automatic tool-use continuation turns, default 12",
    "  --status <status>   Task close status: completed | failed | cancelled",
    "  --timeout-ms <n>    Task wait timeout in milliseconds",
  ].join("\n");
}

function isCliModelName(value: string): value is CliModelName {
  return value === "minimax" || value === "fake" || value === "legacy-minimax";
}

function requireValue(flag: string, args: string[]): string {
  const value = args.shift();
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}
