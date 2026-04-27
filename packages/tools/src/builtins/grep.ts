import { relative, resolve } from "node:path";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import { runProcess } from "../process.js";

export type GrepOutputMode = "content" | "files_with_matches" | "count";

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  outputMode?: GrepOutputMode;
  beforeContext?: number;
  afterContext?: number;
  context?: number;
  lineNumbers?: boolean;
  caseInsensitive?: boolean;
  type?: string;
  headLimit?: number;
  multiline?: boolean;
  maxOutputBytes?: number;
}

export function createGrepTool(): ChiliToolDefinition<GrepInput> {
  return {
    name: "grep",
    aliases: ["grep_search"],
    searchHint: "Search file contents with ripgrep, optional glob/type filters, context lines, counts, or file names.",
    description: "Search workspace file contents using ripgrep.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultOutputBytes: 20_000,
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        outputMode: { type: "string", enum: ["content", "files_with_matches", "count"] },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
        beforeContext: { type: "number" },
        afterContext: { type: "number" },
        context: { type: "number" },
        lineNumbers: { type: "boolean" },
        caseInsensitive: { type: "boolean" },
        type: { type: "string" },
        headLimit: { type: "number" },
        multiline: { type: "boolean" },
        maxOutputBytes: { type: "number" },
      },
    },
    validate(input): ValidationResult<GrepInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const pattern = input.pattern;
      if (typeof pattern !== "string" || pattern.length === 0) {
        return { ok: false, message: "pattern must be a non-empty string" };
      }

      const outputMode = input.outputMode ?? input.output_mode ?? "content";
      if (outputMode !== "content" && outputMode !== "files_with_matches" && outputMode !== "count") {
        return { ok: false, message: "outputMode must be content, files_with_matches, or count" };
      }

      const beforeContextRaw = input.beforeContext ?? input.before_context;
      const afterContextRaw = input.afterContext ?? input.after_context;
      const contextRaw = input.context;
      const headLimitRaw = input.headLimit ?? input.head_limit;
      const maxOutputBytesRaw = input.maxOutputBytes ?? input.max_output_bytes;
      const numbers = [
        ["beforeContext", beforeContextRaw],
        ["afterContext", afterContextRaw],
        ["context", contextRaw],
        ["headLimit", headLimitRaw],
        ["maxOutputBytes", maxOutputBytesRaw],
      ] as const;
      for (const [name, value] of numbers) {
        if (value !== undefined && !isNonNegativeInteger(value)) {
          return { ok: false, message: `${name} must be a non-negative integer` };
        }
      }

      const value: GrepInput = { pattern, outputMode };
      const path = input.path;
      const glob = input.glob;
      const type = input.type;
      if (path !== undefined) {
        if (typeof path !== "string" || path.trim().length === 0) return { ok: false, message: "path must be a non-empty string" };
        value.path = path;
      }
      if (glob !== undefined) {
        if (typeof glob !== "string" || glob.trim().length === 0) return { ok: false, message: "glob must be a non-empty string" };
        value.glob = glob;
      }
      if (type !== undefined) {
        if (typeof type !== "string" || type.trim().length === 0) return { ok: false, message: "type must be a non-empty string" };
        value.type = type;
      }
      const beforeContext = beforeContextRaw as number | undefined;
      const afterContext = afterContextRaw as number | undefined;
      const contextLines = contextRaw as number | undefined;
      const headLimit = headLimitRaw as number | undefined;
      const maxOutputBytes = maxOutputBytesRaw as number | undefined;
      if (beforeContext !== undefined) value.beforeContext = beforeContext;
      if (afterContext !== undefined) value.afterContext = afterContext;
      if (contextLines !== undefined) value.context = contextLines;
      if (input.lineNumbers !== undefined || input.line_numbers !== undefined) {
        const lineNumbers = input.lineNumbers ?? input.line_numbers;
        if (typeof lineNumbers !== "boolean") return { ok: false, message: "lineNumbers must be a boolean" };
        value.lineNumbers = lineNumbers;
      }
      if (input.caseInsensitive !== undefined || input.case_insensitive !== undefined) {
        const caseInsensitive = input.caseInsensitive ?? input.case_insensitive;
        if (typeof caseInsensitive !== "boolean") return { ok: false, message: "caseInsensitive must be a boolean" };
        value.caseInsensitive = caseInsensitive;
      }
      if (headLimit !== undefined) value.headLimit = headLimit;
      if (input.multiline !== undefined) {
        if (typeof input.multiline !== "boolean") return { ok: false, message: "multiline must be a boolean" };
        value.multiline = input.multiline;
      }
      if (maxOutputBytes !== undefined) value.maxOutputBytes = maxOutputBytes;
      return { ok: true, value };
    },
    approval(input) {
      return {
        permission: "grep",
        patterns: [input.path ?? "*"],
        metadata: {
          pattern: input.pattern,
          path: input.path,
          glob: input.glob,
          outputMode: input.outputMode ?? "content",
        },
      };
    },
    async execute(input, context) {
      const workspace = resolve(context.cwd);
      const searchPath = input.path ? resolveWorkspacePath(workspace, input.path) : { absolutePath: workspace, relativePath: "." };
      const args = buildRipgrepArgs(input, searchPath.relativePath === "." ? "." : searchPath.relativePath);
      const result = await runProcess("rg", args, {
        cwd: workspace,
        signal: context.signal,
        timeoutMs: 15_000,
        maxOutputBytes: input.maxOutputBytes ?? 512_000,
      });

      if (result.timedOut) {
        throw new Error(`rg timed out after 15000ms`);
      }
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(result.stderr || `rg exited with code ${result.exitCode}`);
      }

      const lines = result.stdout.trimEnd().split("\n").filter((line) => line.length > 0);
      const headLimit = input.headLimit ?? 250;
      const visible = headLimit > 0 ? lines.slice(0, headLimit) : lines;
      const truncated = lines.length > visible.length || result.stdoutTruncated || result.stderrTruncated;
      const output = visible.length ? visible.join("\n") : "(no matches)";
      return {
        title: `grep ${input.pattern}`,
        output: truncated ? `${output}\n[truncated after ${visible.length} line(s)]` : output,
        metadata: {
          pattern: input.pattern,
          path: input.path,
          glob: input.glob,
          outputMode: input.outputMode ?? "content",
          lineCount: visible.length,
          totalLines: lines.length,
          truncated,
          durationMs: result.durationMs,
          outputLimitBytes: result.outputLimitBytes,
        },
      };
    },
  };
}

function buildRipgrepArgs(input: GrepInput, searchPath: string): string[] {
  const args = ["--color=never", "--no-heading", "--max-columns", "500"];
  const outputMode = input.outputMode ?? "content";
  if (outputMode === "content" && input.lineNumbers !== false) args.push("--line-number");
  if (outputMode === "files_with_matches") args.push("--files-with-matches");
  if (outputMode === "count") args.push("--count");
  if (input.caseInsensitive) args.push("--ignore-case");
  if (input.glob) args.push("--glob", input.glob);
  if (input.type) args.push("--type", input.type);
  if (input.multiline) args.push("--multiline");
  if (input.context !== undefined) args.push("--context", String(input.context));
  else {
    if (input.beforeContext !== undefined) args.push("--before-context", String(input.beforeContext));
    if (input.afterContext !== undefined) args.push("--after-context", String(input.afterContext));
  }
  args.push("--", input.pattern, searchPath);
  return args;
}

function resolveWorkspacePath(workspace: string, path: string): { absolutePath: string; relativePath: string } {
  const absolutePath = resolve(workspace, path);
  const relativePath = relative(workspace, absolutePath);
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`Path must stay inside the workspace: ${path}`);
  }
  return { absolutePath, relativePath: relativePath.split(/[\\/]/).join("/") };
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
