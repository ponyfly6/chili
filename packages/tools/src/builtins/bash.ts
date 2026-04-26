import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import { runProcess } from "../process.js";

export interface BashInput {
  command: string;
  description?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export function createBashTool(): ChiliToolDefinition<BashInput> {
  return {
    name: "bash",
    aliases: ["run_shell_command"],
    searchHint: "Run shell commands; read-only commands can be scheduled concurrently.",
    description: "Run a non-interactive shell command in the workspace.",
    risk: "execute",
    isReadOnly: (input) => isReadOnlyShellCommand(input.command),
    isConcurrencySafe: (input) => isReadOnlyShellCommand(input.command),
    isDestructive: (input) => !isReadOnlyShellCommand(input.command),
    interruptBehavior: "cancel",
    maxResultOutputBytes: 30_000,
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        description: { type: "string" },
        timeoutMs: { type: "number" },
        timeout: { type: "number" },
        maxOutputBytes: { type: "number" },
      },
    },
    validate(input): ValidationResult<BashInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const command = input.command;
      const description = input.description;
      const timeoutMs = input.timeoutMs ?? input.timeout;
      const maxOutputBytes = input.maxOutputBytes;

      if (typeof command !== "string" || command.trim().length === 0) {
        return { ok: false, message: "command must be a non-empty string" };
      }
      if (description !== undefined && typeof description !== "string") {
        return { ok: false, message: "description must be a string" };
      }
      if (timeoutMs !== undefined && !isPositiveInteger(timeoutMs)) {
        return { ok: false, message: "timeoutMs must be a positive integer" };
      }
      if (maxOutputBytes !== undefined && !isPositiveInteger(maxOutputBytes)) {
        return { ok: false, message: "maxOutputBytes must be a positive integer" };
      }

      const value: BashInput = { command };
      if (description !== undefined) value.description = description;
      if (timeoutMs !== undefined) value.timeoutMs = timeoutMs;
      if (maxOutputBytes !== undefined) value.maxOutputBytes = maxOutputBytes;
      return { ok: true, value };
    },
    approval(input) {
      return {
        permission: "bash",
        patterns: [input.command],
        metadata: {
          command: input.command,
          commandPrefix: commandPrefix(input.command),
          readOnly: isReadOnlyShellCommand(input.command),
        },
      };
    },
    async execute(input, context) {
      await context.metadata({
        metadata: {
          command: input.command,
        },
      });

      const result = await runProcess("bash", ["-lc", input.command], {
        cwd: context.cwd,
        signal: context.signal,
        timeoutMs: input.timeoutMs ?? 30_000,
        maxOutputBytes: input.maxOutputBytes ?? 256_000,
      });

      const output = formatCommandOutput(result.stdout, result.stderr);

      return {
        title: `exit ${result.exitCode ?? "signal"}`,
        output,
        metadata: {
          command: input.command,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        },
      };
    },
  };
}

function isReadOnlyShellCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;
  if (/(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|sudo|tee|python|node|bun|npm|pnpm|yarn|make)\b/.test(normalized)) {
    return false;
  }
  if (/(^|\s)(>|>>|2>|&>)/.test(normalized)) return false;

  const segments = normalized
    .split(/\s*(?:&&|\|\|)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}

function isReadOnlySegment(command: string): boolean {
  const tokens = command.split(/\s+/);
  const first = tokens[0] ?? "";
  const second = tokens[1] ?? "";
  const prefix = second ? `${first} ${second}` : first;
  const readOnlyPrefixes = [
    "pwd",
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "grep",
    "rg",
    "find",
    "sed",
    "awk",
    "git status",
    "git diff",
    "git log",
    "git show",
    "git branch",
    "git rev-parse",
    "git ls-files",
    "git grep",
  ];
  return readOnlyPrefixes.some((allowed) => prefix === allowed || command.startsWith(`${allowed} `));
}

function commandPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  return tokens.slice(0, Math.min(tokens.length, 2)).join(" ");
}

function formatCommandOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) return `${stdout}\n\n[stderr]\n${stderr}`;
  if (stdout) return stdout;
  if (stderr) return `[stderr]\n${stderr}`;
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
