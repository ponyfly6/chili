import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import { relative, resolve } from "node:path";
import { runProcess, type RunProcessOptions, type RunProcessResult } from "../process.js";
import { classifyDangerousShellCommand, commandPrefix, isReadOnlyShellCommand } from "../shell-safety.js";

export interface BashInput {
  command: string;
  description?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
  env?: Record<string, string>;
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
        cwd: { type: "string" },
        workingDirectory: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
    },
    validate(input): ValidationResult<BashInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const command = input.command;
      const description = input.description;
      const timeoutMs = input.timeoutMs ?? input.timeout;
      const maxOutputBytes = input.maxOutputBytes;
      const cwd = pickString(input, "cwd", "workingDirectory", "working_directory");
      const env = parseEnv(input.env);

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
      if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim().length === 0)) {
        return { ok: false, message: "cwd must be a non-empty string" };
      }
      if (!env.ok) return env;

      const value: BashInput = { command };
      if (description !== undefined) value.description = description;
      if (timeoutMs !== undefined) value.timeoutMs = timeoutMs;
      if (maxOutputBytes !== undefined) value.maxOutputBytes = maxOutputBytes;
      if (cwd !== undefined) value.cwd = cwd;
      if (env.value !== undefined) value.env = env.value;
      return { ok: true, value };
    },
    approval(input) {
      const danger = classifyDangerousShellCommand(input.command);
      return {
        permission: "bash",
        patterns: [input.command],
        metadata: {
          command: input.command,
          commandPrefix: commandPrefix(input.command),
          readOnly: isReadOnlyShellCommand(input.command),
          cwd: input.cwd,
          envKeys: input.env ? Object.keys(input.env).sort() : [],
          ...(danger ? { danger: danger.action, dangerReason: danger.reason } : {}),
        },
      };
    },
    async execute(input, context) {
      const cwd = input.cwd ? resolveWorkspaceDirectory(context.cwd, input.cwd).absolutePath : resolve(context.cwd);
      await context.metadata({
        metadata: {
          command: input.command,
          cwd,
        },
      });

      const processOptions: RunProcessOptions = {
        cwd,
        signal: context.signal,
        timeoutMs: input.timeoutMs ?? 30_000,
        maxOutputBytes: input.maxOutputBytes ?? 256_000,
      };
      if (input.env) processOptions.env = input.env;
      const result = await runProcess("bash", ["-lc", input.command], processOptions);

      const output = formatCommandOutput(result, input.timeoutMs ?? 30_000);

      return {
        title: result.timedOut ? `timed out after ${input.timeoutMs ?? 30_000}ms` : `exit ${result.exitCode ?? "signal"}`,
        output,
        metadata: {
          command: input.command,
          cwd,
          envKeys: input.env ? Object.keys(input.env).sort() : [],
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          aborted: result.aborted,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          outputLimitBytes: result.outputLimitBytes,
        },
      };
    },
  };
}

function formatCommandOutput(result: RunProcessResult, timeoutMs: number): string {
  const sections: string[] = [];
  if (result.stdout) sections.push(result.stdout);
  if (result.stdoutTruncated) {
    sections.push(`[stdout truncated after ${result.outputLimitBytes} byte(s); process wrote ${result.stdoutBytes} byte(s)]`);
  }
  if (result.stderr) sections.push(`[stderr]\n${result.stderr}`);
  if (result.stderrTruncated) {
    sections.push(`[stderr truncated after ${result.outputLimitBytes} byte(s); process wrote ${result.stderrBytes} byte(s)]`);
  }
  if (result.timedOut) {
    sections.push(`[process timed out after ${timeoutMs}ms and was terminated]`);
  }
  return sections.join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function pickString(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseEnv(value: unknown): ValidationResult<Record<string, string> | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value) || Array.isArray(value)) return { ok: false, message: "env must be an object" };

  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isValidEnvName(key)) return { ok: false, message: `env key is invalid: ${key}` };
    if (typeof item !== "string") return { ok: false, message: `env.${key} must be a string` };
    env[key] = item;
  }
  return { ok: true, value: env };
}

function isValidEnvName(key: string): boolean {
  return key.length > 0 && !key.includes("=") && !key.includes("\0");
}

function resolveWorkspaceDirectory(workspaceInput: string, path: string): { absolutePath: string; relativePath: string } {
  const workspace = resolve(workspaceInput);
  const absolutePath = resolve(workspace, path);
  const relativePath = relative(workspace, absolutePath);
  if (relativePath && !isSafeRelativePath(relativePath)) {
    throw new Error(`cwd must stay inside the workspace: ${path}`);
  }
  return { absolutePath, relativePath: relativePath || "." };
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
}
