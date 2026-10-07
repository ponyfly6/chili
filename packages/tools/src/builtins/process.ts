import type { ToolResult } from "@chili/protocol";
import type { ManagedProcessManager, ManagedProcessSnapshot } from "../managed-process.js";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";

export type ProcessInput =
  | { action: "list" }
  | { action: "read"; processId: string; waitMs?: number }
  | { action: "stop"; processId: string };

/** Control only a process previously started by this session's Bash tool. */
export function createProcessTool(processes: ManagedProcessManager): ChiliToolDefinition<ProcessInput> {
  return {
    name: "process",
    codeMode: true,
    outputSchema: {
      oneOf: [
        { type: "object", required: ["processes"], properties: { processes: { type: "array", items: {
          type: "object", required: ["processId", "status", "command", "cwd", "startedAt"],
          properties: {
            processId: { type: "string" }, status: { type: "string" }, command: { type: "string" }, cwd: { type: "string" },
            startedAt: { type: "number" }, finishedAt: { type: "number" },
          },
        } } } },
        { type: "object", required: ["processId", "status", "command", "cwd", "outputTail", "truncated", "outputBytes"], properties: {
          processId: { type: "string" }, status: { type: "string", enum: ["running", "exited", "stopped", "failed"] },
          command: { type: "string" }, cwd: { type: "string" }, outputTail: { type: "string" },
          truncated: { type: "boolean" }, outputBytes: { type: "integer" },
          exitCode: { type: ["integer", "null"] }, timedOut: { type: "boolean" }, error: { type: "string" },
        } },
      ],
    },
    resourcePolicy: "process",
    searchHint: "Read logs and status, list, or stop this task's managed background commands.",
    description: "Inspect or stop background commands started by bash(background=true) in this task. read returns the latest bounded stdout/stderr tail and actual status; waitMs optionally waits for exit before taking the snapshot (maximum 30000 ms). Repeated reads can contain the same output. list finds this task's handles. stop terminates the owned command and its process group. Handles and logs are local to this host lifetime; no stdin or arbitrary PID control is available. Managed commands can outlive a code-mode script; JavaScript work itself is not kept alive between scripts.",
    risk: "execute",
    isReadOnly: (input) => input.action !== "stop",
    isConcurrencySafe: (input) => input.action !== "stop",
    isDestructive: (input) => input.action === "stop",
    maxResultOutputBytes: 64 * 1024,
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "read", "stop"] },
        processId: { type: "string" },
        waitMs: { type: "integer", minimum: 0, maximum: 30_000 },
      },
    },
    validate(input): ValidationResult<ProcessInput> {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { ok: false, message: "expected an object" };
      }
      const record = input as Record<string, unknown>;
      if (Object.keys(record).some((key) => !["action", "processId", "waitMs"].includes(key))) {
        return { ok: false, message: "only action, processId and waitMs are supported" };
      }
      if (record.action === "list") {
        if (record.processId !== undefined || record.waitMs !== undefined) {
          return { ok: false, message: "list does not accept processId or waitMs" };
        }
        return { ok: true, value: { action: "list" } };
      }
      if (record.action !== "read" && record.action !== "stop") {
        return { ok: false, message: "action must be list, read or stop" };
      }
      if (typeof record.processId !== "string" || !record.processId.trim() || record.processId.length > 200) {
        return { ok: false, message: "processId must be a non-empty managed process handle" };
      }
      if (record.action === "stop") {
        if (record.waitMs !== undefined) return { ok: false, message: "stop does not accept waitMs" };
        return { ok: true, value: { action: "stop", processId: record.processId } };
      }
      if (record.waitMs !== undefined && (typeof record.waitMs !== "number"
        || !Number.isInteger(record.waitMs) || record.waitMs < 0 || record.waitMs > 30_000)) {
        return { ok: false, message: "waitMs must be an integer from 0 to 30000" };
      }
      return { ok: true, value: {
        action: "read", processId: record.processId,
        ...(record.waitMs !== undefined ? { waitMs: record.waitMs as number } : {}),
      } };
    },
    // The only mutation cancels an already-authorized, exactly-owned process.
    // This tool is registered for top-level tasks, not scoped workers.
    resources: () => false,
    async execute(input, context) {
      context.signal.throwIfAborted();
      const owner = { sessionId: context.sessionId, workspaceRoot: context.cwd };
      if (input.action === "list") {
        const items = processes.list(owner);
        return { title: `${items.length} managed processes`, output: JSON.stringify(items, null, 2), structuredData: { processes: items } };
      }
      const snapshot = input.action === "stop"
        ? await processes.stop(owner, input.processId)
        : await processes.read(owner, input.processId, {
          ...(input.waitMs !== undefined ? { waitMs: input.waitMs } : {}),
          signal: context.signal,
        });
      return managedProcessToolResult(snapshot);
    },
  };
}

export function managedProcessToolResult(snapshot: ManagedProcessSnapshot): ToolResult {
  const { processId, status, command, cwd, output, result, error } = snapshot;
  const details = [
    `Process ${processId}: ${status}`,
    `Command: ${command}`,
    `Directory: ${cwd}`,
    ...(result ? [`Exit code: ${result.exitCode ?? "signal"}${result.timedOut ? " (timed out)" : ""}`] : []),
    ...(error ? [`Error: ${error}`] : []),
    ...(status === "running" ? ["The command is still running. Inspect its logs or check the service before assuming it is ready."] : []),
    ...(output.truncated ? [`[Earlier output omitted; latest ${output.previewBytes} bytes shown from ${output.totalBytes} bytes.]`] : []),
    ...(output.preview ? ["", output.preview] : []),
  ];
  return {
    title: `process ${status}`,
    output: details.join("\n"),
    structuredData: {
      processId, status, command, cwd,
      outputTail: output.preview, truncated: output.truncated, outputBytes: output.totalBytes,
      ...(result ? { exitCode: result.exitCode, timedOut: result.timedOut } : {}),
      ...(error ? { error } : {}),
    },
    metadata: {
      processId, processStatus: status, command, cwd, background: true,
      outputBytes: output.totalBytes, outputTruncated: output.truncated,
      ...(result ? {
        exitCode: result.exitCode, timedOut: result.timedOut,
        durationMs: result.durationMs, sandbox: result.sandbox ?? "none",
      } : {}),
      ...(error ? { error } : {}),
    },
  };
}
