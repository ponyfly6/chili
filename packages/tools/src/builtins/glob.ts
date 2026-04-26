import { opendir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";

export interface GlobInput {
  pattern: string;
  path?: string;
  limit?: number;
}

export function createGlobTool(): ChiliToolDefinition<GlobInput> {
  return {
    name: "glob",
    aliases: ["file_glob"],
    searchHint: "Find workspace files by glob pattern such as **/*.ts or packages/*/package.json.",
    description: "Find files in the workspace using a glob pattern.",
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
      const root = input.path ? resolveWorkspacePath(workspace, input.path) : { absolutePath: workspace, relativePath: "." };
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

function resolveWorkspacePath(workspace: string, path: string): { absolutePath: string; relativePath: string } {
  const absolutePath = resolve(workspace, path);
  const relativePath = relative(workspace, absolutePath);
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`Path must stay inside the workspace: ${path}`);
  }
  return { absolutePath, relativePath: toPosixPath(relativePath) };
}

function toPosixRelative(from: string, to: string): string {
  const rel = relative(from, to);
  return rel.length === 0 ? "." : toPosixPath(rel);
}

function toPosixPath(path: string): string {
  return path.split(/[\\/]/).join("/");
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
