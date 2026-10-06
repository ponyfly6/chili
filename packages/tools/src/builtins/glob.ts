import { opendir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import { assertExistingPathInsideWorkspace, resolveWorkspacePath, toPosixPath, toPosixRelative } from "../workspace-path.js";

export interface GlobInput {
  pattern: string;
  path?: string;
  limit?: number;
}

export function createGlobTool(): ChiliToolDefinition<GlobInput> {
  return {
    name: "glob",
    codeMode: true,
    outputSchema: {
      type: "object",
      required: ["paths", "truncated"],
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Matching workspace-relative file paths; each item is a complete path." },
        truncated: { type: "boolean", description: "The match limit stopped the scan; additional matches may exist." },
      },
    },
    aliases: ["file_glob"],
    searchHint: "Find workspace files by glob pattern such as **/*.ts or packages/*/package.json.",
    description: "Find files in the workspace using a glob pattern. Supports *, **, and ?; use separate calls instead of brace expansion.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultOutputBytes: 20_000,
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern using *, **, or ?. Brace expansion such as *.{ts,tsx} is not supported; use separate glob calls. Literal braces remain supported.",
        },
        path: { type: "string" },
        limit: { type: "number" },
      },
    },
    validate(input): ValidationResult<GlobInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const pattern = input.pattern;
      const path = input.path;
      const limit = input.limit;

      if (typeof pattern !== "string" || pattern.trim().length === 0) {
        return { ok: false, message: "pattern must be a non-empty string" };
      }
      if (hasBraceExpansionSyntax(pattern)) {
        return {
          ok: false,
          message: "glob brace expansion is not supported; use separate glob calls instead",
        };
      }
      if (path !== undefined && (typeof path !== "string" || path.trim().length === 0)) {
        return { ok: false, message: "path must be a non-empty string" };
      }
      if (limit !== undefined && !isPositiveInteger(limit)) {
        return { ok: false, message: "limit must be a positive integer" };
      }

      const value: GlobInput = { pattern };
      if (path !== undefined) value.path = path;
      if (limit !== undefined) value.limit = limit;
      return { ok: true, value };
    },
    approval(input) {
      return {
        permission: "glob",
        patterns: [input.path ? `${input.path}/${input.pattern}` : input.pattern],
        metadata: {
          pattern: input.pattern,
          path: input.path,
        },
      };
    },
    async execute(input, context) {
      const workspace = resolve(context.cwd);
      const root = input.path ? resolveWorkspacePath(workspace, input.path, { allowWorkspaceRoot: true }) : { absolutePath: workspace, relativePath: "." };
      await assertExistingPathInsideWorkspace(workspace, root, input.path ?? ".");
      const info = await stat(root.absolutePath);
      if (!info.isDirectory()) {
        throw new Error(`glob path must be a directory: ${root.relativePath}`);
      }

      const matcher = globMatcher(input.pattern);
      const limit = input.limit ?? 100;
      const matches: string[] = [];
      let truncated = false;

      for await (const file of walkFiles(root.absolutePath)) {
        const relativeToRoot = toPosixRelative(root.absolutePath, file);
        if (!matcher(relativeToRoot)) continue;
        matches.push(toPosixRelative(workspace, file));
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
      }

      matches.sort((left, right) => left.localeCompare(right));
      const output = matches.length ? matches.join("\n") : "(no matches)";
      return {
        title: `glob ${input.pattern}`,
        output: truncated ? `${output}\n[truncated after ${limit} matches]` : output,
        structuredData: { paths: matches, truncated },
        metadata: {
          pattern: input.pattern,
          path: input.path,
          count: matches.length,
          truncated,
        },
      };
    },
  };
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  const dir = await opendir(root);
  for await (const entry of dir) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolutePath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(absolutePath);
    } else if (entry.isFile()) {
      yield absolutePath;
    }
  }
}

function globMatcher(pattern: string): (path: string) => boolean {
  const normalized = pattern.split(/[\\/]/).join("/");
  const regex = new RegExp(`^${globToRegex(normalized)}$`);
  return (path) => regex.test(path);
}

function globToRegex(pattern: string): string {
  let regex = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? "";
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      regex += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      regex += ".*";
      index++;
    } else if (char === "*") {
      regex += "[^/]*";
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegex(char);
    }
  }
  return regex;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function hasBraceExpansionSyntax(pattern: string): boolean {
  for (let start = 0; start < pattern.length; start++) {
    if (pattern[start] !== "{") continue;
    let depth = 1;
    for (let end = start + 1; end < pattern.length; end++) {
      const char = pattern[end];
      if (char === "{") {
        depth++;
        continue;
      }
      if (char !== "}") continue;
      depth--;
      if (depth !== 0) continue;

      const body = pattern.slice(start + 1, end);
      if (hasTopLevelBraceAlternatives(body) || isBraceSequence(body) || hasBraceExpansionSyntax(body)) {
        return true;
      }
      start = end;
      break;
    }
  }
  return false;
}

function hasTopLevelBraceAlternatives(body: string): boolean {
  let depth = 0;
  for (const char of body) {
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "," && depth === 0) return true;
  }
  return false;
}

function isBraceSequence(body: string): boolean {
  return /^(?:(?:[+-]?\d+)\.\.(?:[+-]?\d+)|[A-Za-z]\.\.[A-Za-z])(?:\.\.[+-]?\d+)?$/u.test(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
