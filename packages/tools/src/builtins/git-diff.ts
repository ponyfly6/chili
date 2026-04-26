import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import { runProcess } from "../process.js";

export interface GitDiffInput {
  staged?: boolean;
  stat?: boolean;
  base?: string;
  paths?: string[];
  maxOutputBytes?: number;
}

export function createGitDiffTool(): ChiliToolDefinition<GitDiffInput> {
  return {
    name: "git_diff",
    searchHint: "Inspect git diff output, staged changes, stats, or path-specific diffs.",
    description: "Read git diff output for the current workspace.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultOutputBytes: 100_000,
    inputSchema: {
      type: "object",
      properties: {
        staged: { type: "boolean" },
        stat: { type: "boolean" },
        base: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        maxOutputBytes: { type: "number" },
      },
    },
    validate(input): ValidationResult<GitDiffInput> {
      if (input === undefined) return { ok: true, value: {} };
      if (!isRecord(input)) return { ok: false, message: "expected an object" };

      const value: GitDiffInput = {};
      if (input.staged !== undefined) {
        if (typeof input.staged !== "boolean") return { ok: false, message: "staged must be boolean" };
        value.staged = input.staged;
      }
      if (input.stat !== undefined) {
        if (typeof input.stat !== "boolean") return { ok: false, message: "stat must be boolean" };
        value.stat = input.stat;
      }
      if (input.base !== undefined) {
        if (typeof input.base !== "string" || input.base.trim().length === 0) {
          return { ok: false, message: "base must be a non-empty string" };
        }
        value.base = input.base;
      }
      if (input.paths !== undefined) {
        if (!Array.isArray(input.paths)) return { ok: false, message: "paths must be an array" };
        for (const path of input.paths) {
          if (typeof path !== "string" || path.trim().length === 0) {
            return { ok: false, message: "paths must contain non-empty strings" };
          }
          if (path.startsWith("/") || path.includes("..")) {
            return { ok: false, message: "paths must stay inside the workspace" };
          }
        }
        value.paths = input.paths;
      }
      if (input.maxOutputBytes !== undefined) {
        if (typeof input.maxOutputBytes !== "number" || !Number.isInteger(input.maxOutputBytes) || input.maxOutputBytes <= 0) {
          return { ok: false, message: "maxOutputBytes must be a positive integer" };
        }
        value.maxOutputBytes = input.maxOutputBytes;
      }

      return { ok: true, value };
    },
    approval(input) {
      return {
        permission: "git_diff",
        patterns: input.paths?.length ? input.paths : ["*"],
        metadata: {
          staged: input.staged ?? false,
          stat: input.stat ?? false,
          base: input.base ?? "",
          paths: input.paths ?? [],
        },
      };
    },
    async execute(input, context) {
      const args = ["diff", "--no-ext-diff", "--no-color"];
      if (input.staged) args.push("--cached");
      if (input.stat) args.push("--stat");
      if (input.base) args.push(input.base);
      if (input.paths?.length) args.push("--", ...input.paths);

      const result = await runProcess("git", args, {
        cwd: context.cwd,
        signal: context.signal,
        timeoutMs: 15_000,
        maxOutputBytes: input.maxOutputBytes ?? 512_000,
      });

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `git diff exited with code ${result.exitCode}`);
      }

      const output = result.stdout || "(no diff)";
      return {
        title: input.stat ? "git diff --stat" : "git diff",
        output,
        metadata: {
          staged: input.staged ?? false,
          stat: input.stat ?? false,
          base: input.base,
          paths: input.paths ?? [],
          durationMs: result.durationMs,
          truncated: result.stdoutTruncated || result.stderrTruncated,
        },
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
