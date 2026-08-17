import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import { resolve } from "node:path";
import { runProcess, type RunProcessOptions, type RunProcessResult } from "../process.js";
import { ProcessOutputAccumulator, type ProcessOutputSnapshot } from "../process-output-accumulator.js";
import {
  classifyDangerousShellCommand,
  commandPrefix,
  escalatedShellCommandRejection,
  isReadOnlyShellCommand,
} from "../shell-safety.js";
import { assertExistingPathInsideWorkspace, resolveWorkspacePath, type WorkspacePath } from "../workspace-path.js";

export interface BashInput {
  command: string;
  description?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
  env?: Record<string, string>;
  sandboxPermissions?: BashSandboxPermissions;
  justification?: string;
}

export type BashSandboxPermissions = "use_default" | "require_escalated";

export interface BashRunRequest {
  command: string;
  workspaceRoot: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  sandboxPermissions: BashSandboxPermissions;
  signal: AbortSignal;
  onOutput: RunProcessOptions["onOutput"];
  onRawOutput?: RunProcessOptions["onRawOutput"];
}

export interface BashRunResult extends RunProcessResult {
  sandbox?: "macos-seatbelt" | "none";
}

export interface BashRunner {
  run(request: BashRunRequest): Promise<BashRunResult>;
}

export interface BashToolOptions {
  runner?: BashRunner;
  allowEscalation?: boolean;
}

const DEFAULT_BASH_RUNNER: BashRunner = {
  async run(request) {
    const processOptions: RunProcessOptions = {
      cwd: request.cwd,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
    };
    if (request.env) processOptions.env = request.env;
    if (request.onOutput) processOptions.onOutput = request.onOutput;
    if (request.onRawOutput) processOptions.onRawOutput = request.onRawOutput;
    const result = await runProcess("bash", ["-lc", request.command], processOptions);
    return { ...result, sandbox: "none" };
  },
};

export function createUnsandboxedBashRunner(): BashRunner {
  return DEFAULT_BASH_RUNNER;
}

export function createBashTool(options: BashToolOptions = {}): ChiliToolDefinition<BashInput> {
  const runner = options.runner ?? DEFAULT_BASH_RUNNER;
  const allowEscalation = options.allowEscalation ?? true;
  return {
    name: "bash",
    aliases: ["run_shell_command"],
    searchHint: "Run shell commands; read-only commands can be scheduled concurrently.",
    description: allowEscalation
      ? "Run a non-interactive shell command in the workspace. Commands that require desktop IPC or other access blocked by the default sandbox may request one-time elevated execution with a justification."
      : "Run a non-interactive shell command in the workspace.",
    risk: "execute",
    isReadOnly: (input) => isReadOnlyShellCommand(input.command),
    isConcurrencySafe: (input) => isReadOnlyShellCommand(input.command),
    isDestructive: (input) => !isReadOnlyShellCommand(input.command),
    interruptBehavior: "cancel",
    maxResultOutputBytes: 64 * 1024,
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
        ...(allowEscalation
          ? {
              sandboxPermissions: {
                type: "string",
                enum: ["use_default", "require_escalated"],
              },
              sandbox_permissions: {
                type: "string",
                enum: ["use_default", "require_escalated"],
              },
              justification: { type: "string" },
            }
          : {}),
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
      const sandboxPermissions = parseSandboxPermissions(input);
      const justification = input.justification;

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
      if (!sandboxPermissions.ok) return sandboxPermissions;
      if (!allowEscalation && sandboxPermissions.value === "require_escalated") {
        return { ok: false, message: "sandbox escalation is unavailable for this tool registry" };
      }
      if (justification !== undefined && typeof justification !== "string") {
        return { ok: false, message: "justification must be a string" };
      }
      const normalizedJustification = typeof justification === "string" ? justification.trim() : undefined;
      if (sandboxPermissions.value === "require_escalated" && !normalizedJustification) {
        return {
          ok: false,
          message: "justification must be a non-empty string when sandboxPermissions is require_escalated",
        };
      }
      if (sandboxPermissions.value === "require_escalated" && containsUnsafeApprovalText(command)) {
        return {
          ok: false,
          message: "elevated command must not contain control or bidirectional formatting characters",
        };
      }
      if (
        sandboxPermissions.value === "require_escalated"
        && normalizedJustification
        && containsUnsafeApprovalText(normalizedJustification)
      ) {
        return {
          ok: false,
          message: "elevated justification must not contain control or bidirectional formatting characters",
        };
      }
      if (sandboxPermissions.value === "require_escalated" && env.value !== undefined) {
        return {
          ok: false,
          message: "env overrides are not allowed when sandboxPermissions is require_escalated",
        };
      }
      if (sandboxPermissions.value === "require_escalated") {
        const rejection = escalatedShellCommandRejection(command);
        if (rejection) return { ok: false, message: rejection };
      }
      if (sandboxPermissions.value === "use_default" && justification !== undefined) {
        return {
          ok: false,
          message: "justification is only valid when sandboxPermissions is require_escalated",
        };
      }

      const value: BashInput = { command, sandboxPermissions: sandboxPermissions.value };
      if (description !== undefined) value.description = description;
      if (timeoutMs !== undefined) value.timeoutMs = timeoutMs;
      if (maxOutputBytes !== undefined) value.maxOutputBytes = maxOutputBytes;
      if (cwd !== undefined) value.cwd = cwd;
      if (env.value !== undefined) value.env = env.value;
      if (normalizedJustification !== undefined) value.justification = normalizedJustification;
      return { ok: true, value };
    },
    approval(input) {
      const danger = classifyDangerousShellCommand(input.command);
      const sandboxPermissions = input.sandboxPermissions ?? "use_default";
      return {
        permission: sandboxPermissions === "require_escalated" ? "bash.unsandboxed" : "bash",
        patterns: [input.command],
        ...(sandboxPermissions === "require_escalated" ? { maxApprovalScope: "once" as const } : {}),
        metadata: {
          command: input.command,
          commandPrefix: commandPrefix(input.command),
          readOnly: isReadOnlyShellCommand(input.command),
          cwd: input.cwd,
          envKeys: input.env ? Object.keys(input.env).sort() : [],
          sandboxPermissions,
          ...(input.justification ? { justification: input.justification } : {}),
          ...(danger ? { danger: danger.action, dangerReason: danger.reason, dangerSource: "bash_danger_classifier" } : {}),
        },
      };
    },
    async execute(input, context) {
      const cwd = input.cwd ? (await resolveWorkspaceDirectory(context.cwd, input.cwd)).absolutePath : resolve(context.cwd);
      const sandboxPermissions = input.sandboxPermissions ?? "use_default";
      await context.metadata({
        metadata: {
          command: input.command,
          cwd,
          sandboxPermissions,
          ...(input.justification ? { justification: input.justification } : {}),
        },
      });

      const timeoutMs = input.timeoutMs ?? 30_000;
      const maxOutputBytes = input.maxOutputBytes ?? 256_000;
      const outputAccumulator = new ProcessOutputAccumulator({
        cwd: context.cwd,
        callId: context.outputArtifactId,
        ...(context.persistedOutputLimits?.maxBytes !== undefined
          ? { maxPersistedBytes: context.persistedOutputLimits.maxBytes }
          : {}),
        ...(context.persistedOutputLimits?.maxDirectoryBytes !== undefined
          ? { maxDirectoryBytes: context.persistedOutputLimits.maxDirectoryBytes }
          : {}),
      });
      const runRequest: BashRunRequest = {
        command: input.command,
        workspaceRoot: resolve(context.cwd),
        cwd,
        signal: context.signal,
        timeoutMs,
        maxOutputBytes,
        sandboxPermissions,
        onOutput: (chunk) => context.streamOutput(chunk),
        onRawOutput: (chunk) => outputAccumulator.append(chunk),
      };
      if (input.env) runRequest.env = input.env;
      let result: BashRunResult;
      try {
        result = await runner.run(runRequest);
      } catch (error) {
        await outputAccumulator.finish();
        throw error;
      }
      const outputSnapshot = await outputAccumulator.finish();
      if (outputSnapshot.persistedOutput) {
        try {
          await context.registerPersistedOutput(outputSnapshot.persistedOutput);
        } catch (error) {
          delete outputSnapshot.outputPath;
          delete outputSnapshot.persistedBytes;
          delete outputSnapshot.persistedTruncated;
          delete outputSnapshot.persistedOutput;
          outputSnapshot.persistenceError = error instanceof Error ? error.message : String(error);
        }
      }
      const sandbox = result.sandbox ?? "none";
      const executionMode = sandbox === "none" ? "unsandboxed" : "sandboxed";
      await context.metadata({ metadata: { sandbox, sandboxPermissions, executionMode } });

      const output = outputSnapshot.truncated
        ? formatTruncatedCommandOutput(outputSnapshot, result, timeoutMs)
        : formatCommandOutput(result, timeoutMs);

      return {
        title: result.timedOut ? `timed out after ${timeoutMs}ms` : `exit ${result.exitCode ?? "signal"}`,
        output,
        metadata: {
          command: input.command,
          cwd,
          envKeys: input.env ? Object.keys(input.env).sort() : [],
          sandboxPermissions,
          executionMode,
          sandbox,
          ...(input.justification ? { justification: input.justification } : {}),
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
          ...(outputSnapshot.truncated
            ? {
                outputTruncated: true,
                outputBytes: outputSnapshot.totalBytes,
                outputLines: outputSnapshot.totalLines,
                outputPreviewBytes: outputSnapshot.previewBytes,
                outputPreviewLines: outputSnapshot.previewLines,
                outputTruncatedBy: outputSnapshot.truncatedBy,
                ...(outputSnapshot.outputPath ? { outputPath: outputSnapshot.outputPath } : {}),
                ...(outputSnapshot.persistedBytes !== undefined
                  ? { outputPersistedBytes: outputSnapshot.persistedBytes }
                  : {}),
                ...(outputSnapshot.persistedTruncated !== undefined
                  ? { outputPersistedTruncated: outputSnapshot.persistedTruncated }
                  : {}),
                ...(outputSnapshot.persistenceError
                  ? { outputPersistenceError: outputSnapshot.persistenceError }
                  : {}),
              }
            : {}),
        },
      };
    },
  };
}

function formatTruncatedCommandOutput(
  snapshot: ProcessOutputSnapshot,
  result: RunProcessResult,
  timeoutMs: number,
): string {
  const persistenceFailure = snapshot.persistenceError
    ? `; output could not be persisted: ${snapshot.persistenceError}`
    : "";
  const sections = [
    `[command output truncated: showing ${snapshot.previewLines} preview lines from ${snapshot.totalLines} output lines / ${snapshot.totalBytes} raw bytes${persistenceFailure}]\n${snapshot.preview}`,
  ];
  if (result.timedOut) {
    sections.push(`[process timed out after ${timeoutMs}ms and was terminated]`);
  }
  return sections.join("\n\n");
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

function parseSandboxPermissions(
  input: Record<string, unknown>,
): ValidationResult<BashSandboxPermissions> {
  const camelCase = input.sandboxPermissions;
  const snakeCase = input.sandbox_permissions;
  if (camelCase !== undefined && snakeCase !== undefined && camelCase !== snakeCase) {
    return {
      ok: false,
      message: "sandboxPermissions and sandbox_permissions must match when both are provided",
    };
  }
  const value = camelCase ?? snakeCase ?? "use_default";
  if (value !== "use_default" && value !== "require_escalated") {
    return {
      ok: false,
      message: "sandboxPermissions must be use_default or require_escalated",
    };
  }
  return { ok: true, value };
}

function isValidEnvName(key: string): boolean {
  return key.length > 0 && !key.includes("=") && !key.includes("\0");
}

function containsUnsafeApprovalText(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value);
}

async function resolveWorkspaceDirectory(workspaceInput: string, path: string): Promise<WorkspacePath> {
  try {
    const target = resolveWorkspacePath(workspaceInput, path, { allowWorkspaceRoot: true });
    await assertExistingPathInsideWorkspace(workspaceInput, target, path);
    return target;
  } catch (error) {
    if (error instanceof Error && error.message.includes("inside the workspace")) {
      throw new Error(`cwd must stay inside the workspace: ${path}`);
    }
    throw error;
  }
}
