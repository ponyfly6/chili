import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import { runProcess } from "../process.js";

export type GrepOutputMode = "content" | "files_with_matches" | "count";

export interface GrepInput {
  pattern: string;
  path?: string;
  paths?: string[];
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
    searchHint: "Search file contents with ripgrep, optional path/paths, glob/type filters, context lines, counts, or file names.",
    description: "Search workspace file contents using ripgrep. Use paths for multiple search roots.",
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
        paths: { type: "array", items: { type: "string" } },
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
      const paths = input.paths;
      const glob = input.glob;
      const type = input.type;
      if (path !== undefined) {
        if (typeof path !== "string" || path.trim().length === 0) return { ok: false, message: "path must be a non-empty string" };
        value.path = path;
      }
      if (paths !== undefined) {
        if (!Array.isArray(paths) || paths.length === 0) return { ok: false, message: "paths must be a non-empty array" };
        const parsedPaths: string[] = [];
        for (const item of paths) {
          if (typeof item !== "string" || item.trim().length === 0) return { ok: false, message: "paths entries must be non-empty strings" };
          parsedPaths.push(item);
        }
        value.paths = parsedPaths;
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
        patterns: input.paths ?? splitSearchPathList(input.path) ?? ["*"],
        metadata: {
          pattern: input.pattern,
          path: input.path,
          paths: input.paths,
          glob: input.glob,
          outputMode: input.outputMode ?? "content",
        },
      };
    },
    async execute(input, context) {
      const workspace = resolve(context.cwd);
      const searchPaths = await resolveSearchPaths(workspace, input);
      const args = buildRipgrepArgs(input, searchPaths.map((path) => path.relativePath));
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
          paths: input.paths,
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

function buildRipgrepArgs(input: GrepInput, searchPaths: string[]): string[] {
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
  args.push("--", input.pattern, ...searchPaths);
  return args;
}

function resolveWorkspacePath(workspace: string, path: string): { absolutePath: string; relativePath: string } {
  const absolutePath = resolve(workspace, path);
  const relativePath = relative(workspace, absolutePath);
  if (relativePath === "") {
    return { absolutePath, relativePath: "." };
  }
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`Path must stay inside the workspace: ${path}`);
  }
  return { absolutePath, relativePath: relativePath.split(/[\\/]/).join("/") };
}

async function resolveSearchPaths(workspace: string, input: GrepInput): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const rawPaths = input.paths ?? await normalizePathString(workspace, input.path);
  return rawPaths.map((path) => resolveWorkspacePath(workspace, path));
}

async function normalizePathString(workspace: string, path: string | undefined): Promise<string[]> {
  if (path === undefined) return ["."];
  const split = splitSearchPathList(path);
  if (!split || split.length <= 1) return [path];
  if (await pathExists(resolve(workspace, path))) return [path];
  return split;
}

function splitSearchPathList(path: string | undefined): string[] | undefined {
  if (path === undefined) return undefined;
  const parts = path.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts : [path];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    return true;
  }
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
