import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import { CODE_MODE_LIMITS, executeCodeMode } from "../code-mode/runtime.js";

export interface CodeModeInput {
  code: string;
  timeoutMs?: number;
}

export function createCodeModeTool(): ChiliToolDefinition<CodeModeInput> {
  return {
    name: "code_mode",
    description: "Run JavaScript that composes available tools with tools.<name>(input). Every call returns a ToolResult object: {title, output, structuredData?, metadata?, content?, artifactIds?}. Prefer structuredData for machine-readable values; inspect metadata.structuredDataUnavailable and metadata.truncated before relying on a preview. Use await and Promise.all for dependencies and independent calls. Only text(value) output reaches the model; return values are discarded. ALL_TOOLS lists callable tool names and descriptions. Use tools[\"name\"] for names containing punctuation. Each call has a fresh isolated heap with no Node, files, network, imports, or timers. Await every tool call: returning requests cancellation of unfinished calls and cancels queued calls. Tool failures reject and can be caught; earlier side effects are not rolled back. Scripts may make at most 64 calls with 8 running concurrently, use 64 MiB memory, and emit 256 KiB. Default deadline 30 seconds; maximum 120 seconds.",
    risk: "read",
    codeMode: false,
    isOrchestrator: true,
    isConcurrencySafe: false,
    alwaysLoad: true,
    maxResultOutputBytes: CODE_MODE_LIMITS.outputBytes + 8192,
    inputSchema: {
      type: "object",
      required: ["code"],
      additionalProperties: false,
      properties: {
        code: { type: "string", description: "Raw JavaScript async function body; top-level await is supported. Emit results with text(value)." },
        timeoutMs: { type: "integer", minimum: 1, maximum: CODE_MODE_LIMITS.maxTimeoutMs },
      },
    },
    validate(input): ValidationResult<CodeModeInput> {
      if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, message: "expected an object" };
      const record = input as Record<string, unknown>;
      if (Object.keys(record).some((key) => key !== "code" && key !== "timeoutMs")) return { ok: false, message: "only code and timeoutMs are supported" };
      if (typeof record.code !== "string" || !record.code.trim()) return { ok: false, message: "code must be a non-empty string" };
      if (new TextEncoder().encode(record.code).byteLength > CODE_MODE_LIMITS.scriptBytes) return { ok: false, message: `code exceeds ${CODE_MODE_LIMITS.scriptBytes} bytes` };
      if (record.timeoutMs !== undefined && (typeof record.timeoutMs !== "number" || !Number.isInteger(record.timeoutMs) || record.timeoutMs < 1 || record.timeoutMs > CODE_MODE_LIMITS.maxTimeoutMs)) {
        return { ok: false, message: `timeoutMs must be an integer from 1 to ${CODE_MODE_LIMITS.maxTimeoutMs}` };
      }
      return { ok: true, value: { code: record.code, ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs as number }) } };
    },
    approval: () => false,
    async execute(input, context) {
      if (!context.visibleTools || !context.invokeTool) throw new Error("Code mode requires a tool execution context");
      const callable = (await context.visibleTools()).filter((tool) => tool.codeMode === true && !tool.isOrchestrator && tool.name !== "code_mode");
      const invoke = context.invokeTool;
      const result = await executeCodeMode({
        code: input.code,
        tools: callable.map((tool) => ({ name: tool.name, description: tool.description })),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        signal: context.signal,
        invokeTool: (name, args, signal) => invoke(name, args, signal),
      });
      if (!result.ok) {
        const calls = result.calls.length ? `\nTool calls (earlier effects are not undone): ${result.calls.map((call) => `${call.name} (${call.status})`).join(", ")}` : "";
        throw new Error(`Code mode ${result.error?.kind ?? "failure"}: ${result.error?.message ?? "Execution failed"}${result.output ? `\nOutput before failure:\n${result.output}` : ""}${calls}`);
      }
      return {
        title: "Code mode",
        output: result.output || "(script completed without text output)",
        metadata: { codeMode: true, calls: result.calls },
      };
    },
  };
}
