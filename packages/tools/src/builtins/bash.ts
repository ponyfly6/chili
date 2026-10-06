import { normalizePersistedError } from "@chili/protocol";
import type { ChiliToolDefinition, ChiliToolExecutionContext, ToolAccessPolicy, ToolResourceDenials, ValidationResult } from "../types.js";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { bashArguments } from "../bash-invocation.js";
import { runProcess, type RunProcessOptions, type RunProcessResult } from "../process.js";
import { ProcessOutputAccumulator, type ProcessOutputSnapshot } from "../process-output-accumulator.js";
import type { ManagedProcessManager } from "../managed-process.js";
import { managedProcessToolResult } from "./process.js";
import {
  classifyDangerousShellCommand,
  commandPrefix,
  escalatedShellCommandRejection,
  isReadOnlyShellCommand,
} from "../shell-safety.js";
import { assertExistingPathInsideWorkspace, resolveWorkspacePath, type WorkspacePath } from "../workspace-path.js";

export interface BashInput {
  command: string;
  background?: boolean;
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
  executionPolicy?: ToolAccessPolicy;
  resourceDenials?: ToolResourceDenials;
  assertCurrentAuthorization?: () => Promise<void>;
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
  /** Promises to enforce the supplied filesystem, network, and escalation limits. */
  supportsExecutionPolicy?: boolean;
  supportsResourceDenials?: boolean;
  run(request: BashRunRequest): Promise<BashRunResult>;
}

export interface BashToolOptions {
  runner?: BashRunner;
  allowEscalation?: boolean;
  processes?: ManagedProcessManager;
}

const DEFAULT_BASH_RUNNER: BashRunner = {
  async run(request) {
    if (request.executionPolicy || request.resourceDenials?.readPaths.length || request.resourceDenials?.writePaths.length) {
      throw new Error("Scoped execution requires an enforcing shell sandbox; the unsandboxed runner is unavailable.");
    }
    const processOptions: RunProcessOptions = {
      ...(request.assertCurrentAuthorization ? { beforeSpawn: request.assertCurrentAuthorization } : {}),
      cwd: request.cwd,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
    };
    if (request.env) processOptions.env = request.env;
    if (request.onOutput) processOptions.onOutput = request.onOutput;
    if (request.onRawOutput) processOptions.onRawOutput = request.onRawOutput;
    const executable = process.platform === "win32" ? "bash" : "/bin/bash";
    const result = await runProcess(executable, bashArguments(request.command), processOptions);
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
    codeMode: true,
    outputSchema: {
      oneOf: [
        {
          type: "object",
          required: ["background", "stdout", "stderr", "exitCode", "signal", "timedOut", "stdoutTruncated", "stderrTruncated", "stdoutBytes", "stderrBytes", "durationMs"],
          properties: {
            background: { const: false },
            stdout: { type: "string", description: "Captured standard output without display notices." },
            stderr: { type: "string", description: "Captured standard error without display notices." },
            exitCode: { type: ["integer", "null"] }, signal: { type: ["string", "null"] },
            timedOut: { type: "boolean" }, stdoutTruncated: { type: "boolean" }, stderrTruncated: { type: "boolean" },
            stdoutBytes: { type: "integer" }, stderrBytes: { type: "integer" }, durationMs: { type: "number" },
            outputPath: { type: "string", description: "Workspace-relative path to persisted output when available." },
          },
        },
        {
          type: "object",
          required: ["background", "processId", "status", "outputTail", "truncated"],
          properties: {
            background: { const: true }, processId: { type: "string" },
            status: { type: "string", enum: ["running", "exited", "stopped", "failed"] },
            outputTail: { type: "string", description: "Bounded combined output tail. A running status does not imply readiness." },
            truncated: { type: "boolean" },
          },
        },
      ],
    },
    resourcePolicy: "process",
    aliases: ["run_shell_command"],
    searchHint: options.processes
      ? "Run shell commands or start managed background servers; inspect and stop them with process."
      : "Run shell commands; read-only commands can be scheduled concurrently.",
    description: (allowEscalation
      ? "Run a non-interactive Bash command without login or interactive profiles in the authoritative workspace. Relative cwd values resolve from that workspace root, and absolute cwd values must remain inside it. Commands that require desktop IPC or other access blocked by the default sandbox may request one-time elevated execution with a justification."
      : "Run a non-interactive Bash command without login or interactive profiles in the authoritative workspace. Relative cwd values resolve from that workspace root, and absolute cwd values must remain inside it.")
      + (options.processes
        ? " Set background=true for a dev server or long-running command. Run the program in the foreground, without nohup or a trailing &: Chili keeps it running and returns a processId for the process tool. A running handle does not imply the program is ready or successful. Background commands have no default timeout and survive ordinary replies; explicit Stop, archive, or host shutdown stops them. Existing sandbox restrictions still apply."
        : ""),
    risk: "execute",
    isReadOnly: isReadOnlyBashInput,
    isConcurrencySafe: isReadOnlyBashInput,
    isDestructive: (input) => !isReadOnlyBashInput(input),
    maxResultOutputBytes: 64 * 1024,
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        ...(options.processes ? { background: { type: "boolean", description: "Keep this command running across model turns and return a managed processId." } } : {}),
        description: { type: "string" },
        timeoutMs: { type: "number" },
        timeout: { type: "number" },
        maxOutputBytes: { type: "number" },
        cwd: {
          type: "string",
          description: "Working directory. Relative paths resolve from the authoritative workspace root; absolute paths must remain inside it.",
        },
        workingDirectory: {
          type: "string",
          description: "Alias for cwd. Relative paths resolve from the authoritative workspace root; absolute paths must remain inside it.",
        },
        working_directory: {
          type: "string",
          description: "Alias for cwd. Relative paths resolve from the authoritative workspace root; absolute paths must remain inside it.",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Environment overrides. Non-empty overrides require execution scope for scoped workers and disable read-only concurrent scheduling.",
        },
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
      const background = input.background;
      const description = input.description;
      const timeoutMs = input.timeoutMs ?? input.timeout;
      const maxOutputBytes = input.maxOutputBytes;
      const cwd = parseCwdAliases(input);
      const env = parseEnv(input.env);
      const sandboxPermissions = parseSandboxPermissions(input);
      const justification = input.justification;

      if (typeof command !== "string" || command.trim().length === 0) {
        return { ok: false, message: "command must be a non-empty string" };
      }
      if (background !== undefined && typeof background !== "boolean") {
        return { ok: false, message: "background must be a boolean" };
      }
      if (background === true && !options.processes) {
        return { ok: false, message: "managed background commands are unavailable in this tool registry" };
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
      if (!cwd.ok) return cwd;
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
      if (background !== undefined) value.background = background;
      if (description !== undefined) value.description = description;
      if (timeoutMs !== undefined) value.timeoutMs = timeoutMs;
      if (maxOutputBytes !== undefined) value.maxOutputBytes = maxOutputBytes;
      if (cwd.value !== undefined) value.cwd = cwd.value;
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
          ...(input.background ? { background: true } : {}),
          commandPrefix: commandPrefix(input.command),
          readOnly: isReadOnlyBashInput(input),
          cwd: input.cwd,
          envKeys: input.env ? Object.keys(input.env).sort() : [],
          sandboxPermissions,
          ...(input.justification ? { justification: input.justification } : {}),
          ...(danger ? { danger: danger.action, dangerReason: danger.reason, dangerSource: "bash_danger_classifier" } : {}),
        },
      };
    },
    async execute(input, context) {
      if (context.executionPolicy && !runner.supportsExecutionPolicy) {
        throw new Error("This shell backend cannot enforce the current execution policy.");
      }
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
      const authority = await prepareBashAuthority(context, runner);

      if (input.background) {
        const processes = options.processes;
        if (!processes) throw new Error("Managed background commands are unavailable");
        context.signal.throwIfAborted();
        const owner = { sessionId: context.sessionId, workspaceRoot: context.cwd };
        const processId = processes.start({
          owner,
          runner,
          request: {
            ...authority,
            ...(context.executionPolicy ? { executionPolicy: context.executionPolicy } : {}),
            command: input.command,
            workspaceRoot: resolve(context.cwd),
            cwd,
            timeoutMs: input.timeoutMs ?? 0,
            maxOutputBytes: Math.min(input.maxOutputBytes ?? 64 * 1024, 64 * 1024),
            sandboxPermissions,
            ...(input.env ? { env: input.env } : {}),
          },
          capture: new ProcessOutputAccumulator({
            cwd: context.cwd,
            callId: context.outputArtifactId,
            maxBytes: 16 * 1024,
            maxLines: 200,
            persistOutput: false,
          }),
        });
        try {
          const snapshot = await processes.read(owner, processId, { waitMs: 250, signal: context.signal });
          await context.metadata({ metadata: { processId, background: true } });
          context.signal.throwIfAborted();
          return {
            ...managedProcessToolResult(snapshot),
            structuredData: {
              background: true,
              processId,
              status: snapshot.status,
              outputTail: snapshot.output.preview,
              truncated: snapshot.output.truncated,
            },
          };
        } catch (error) {
          await processes.stop(owner, processId);
          throw error;
        }
      }

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
        ...authority,
        ...(context.executionPolicy ? { executionPolicy: context.executionPolicy } : {}),
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
        await authority.assertCurrentAuthorization?.();
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
          outputSnapshot.persistenceError = normalizePersistedError(error).message;
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
        structuredData: {
          background: false,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          durationMs: result.durationMs,
          ...(outputSnapshot.outputPath ? { outputPath: outputSnapshot.outputPath } : {}),
        },
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

async function prepareBashAuthority(
  context: ChiliToolExecutionContext,
  runner: BashRunner,
): Promise<Pick<BashRunRequest, "resourceDenials" | "assertCurrentAuthorization">> {
  const current = await context.currentResourceDenials?.();
  const resourceDenials = current && current.readPaths.length + current.writePaths.length > 0
    ? { readPaths: [...current.readPaths], writePaths: [...current.writePaths] }
    : undefined;
  if (resourceDenials && !runner.supportsResourceDenials) {
    throw new Error("This shell backend cannot enforce explicit file resource denies.");
  }
  const version = resourceDenialVersion(resourceDenials);
  const assertCurrentAuthorization = context.assertCurrentAuthorization || context.currentResourceDenials
    ? async (): Promise<void> => {
        await context.assertCurrentAuthorization?.();
        if (resourceDenialVersion(await context.currentResourceDenials?.()) !== version) {
          throw new Error("File resource policy changed during shell preparation; prepare the command again before executing.");
        }
      }
    : undefined;
  return {
    ...(resourceDenials ? { resourceDenials } : {}),
    ...(assertCurrentAuthorization ? { assertCurrentAuthorization } : {}),
  };
}

function resourceDenialVersion(denials?: ToolResourceDenials): string {
  return JSON.stringify([[...new Set(denials?.readPaths ?? [])].sort(), [...new Set(denials?.writePaths ?? [])].sort()]);
}

function isReadOnlyBashInput(input: BashInput): boolean {
  // The same command can invoke different executables or startup code under
  // custom BASH_ENV, PATH, HOME, or other tool-specific environment settings.
  return !input.background && Object.keys(input.env ?? {}).length === 0 && isReadOnlyShellCommand(input.command);
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

function parseCwdAliases(record: Record<string, unknown>): ValidationResult<string | undefined> {
  const entries = (["cwd", "workingDirectory", "working_directory"] as const)
    .map((key) => ({ key, value: record[key] }))
    .filter((entry) => entry.value !== undefined);

  for (const entry of entries) {
    if (typeof entry.value !== "string" || entry.value.trim().length === 0) {
      return { ok: false, message: `${entry.key} must be a non-empty string` };
    }
  }

  const first = entries[0]?.value as string | undefined;
  if (entries.some((entry) => entry.value !== first)) {
    return {
      ok: false,
      message: "cwd, workingDirectory, and working_directory must match when multiple aliases are provided",
    };
  }
  return { ok: true, value: first };
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
  const workspace = resolve(workspaceInput);
  try {
    const target = resolveWorkspacePath(workspace, path, { allowWorkspaceRoot: true });
    await assertExistingPathInsideWorkspace(workspace, target, path);
    const info = await stat(target.absolutePath);
    if (!info.isDirectory()) {
      throw new Error("resolved path is not a directory");
    }
    return target;
  } catch (error) {
    if (error instanceof Error && error.message.includes("inside the workspace")) {
      throw new Error(`cwd must stay inside the authoritative workspace ${workspace}: ${path}`);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cwd must resolve to an existing directory inside the authoritative workspace ${workspace}: ${path} (${reason})`);
  }
}
