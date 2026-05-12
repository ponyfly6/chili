import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";

export interface EditInput {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  instruction?: string;
}

export function createEditTool(): ChiliToolDefinition<EditInput> {
  return {
    name: "edit",
    aliases: ["replace"],
    searchHint: "Replace exact literal text in a workspace file after reading it.",
    description: "Replace exact literal text in a workspace file.",
    risk: "write",
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: false,
    interruptBehavior: "block",
    maxResultOutputBytes: 100_000,
    inputSchema: {
      type: "object",
      required: ["filePath", "oldString", "newString"],
      properties: {
        filePath: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
        replaceAll: { type: "boolean" },
        instruction: { type: "string" },
      },
    },
    validate(input): ValidationResult<EditInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };

      const filePath = pickString(input, "filePath", "file_path", "path");
      const oldString = pickString(input, "oldString", "old_string", "oldText");
      const newString = pickString(input, "newString", "new_string", "newText");
      const replaceAll = pickBoolean(input, "replaceAll", "allow_multiple", "replace_all");
      const instruction = input.instruction;

      if (typeof filePath !== "string" || filePath.trim().length === 0) {
        return { ok: false, message: "filePath must be a non-empty string" };
      }
      if (typeof oldString !== "string") {
        return { ok: false, message: "oldString must be a string" };
      }
      if (typeof newString !== "string") {
        return { ok: false, message: "newString must be a string" };
      }
      if (oldString === newString) {
        return { ok: false, message: "oldString and newString must be different" };
      }
      if (replaceAll.invalid) {
        return { ok: false, message: "replaceAll must be a boolean" };
      }
      if (instruction !== undefined && typeof instruction !== "string") {
        return { ok: false, message: "instruction must be a string" };
      }

      const value: EditInput = {
        filePath,
        oldString,
        newString,
      };
      if (replaceAll.value !== undefined) value.replaceAll = replaceAll.value;
      if (instruction !== undefined) value.instruction = instruction;
      return { ok: true, value };
    },
    approval(input) {
      return {
        permission: "edit",
        patterns: [input.filePath],
        metadata: {
          filePath: input.filePath,
          replaceAll: input.replaceAll ?? false,
          instruction: input.instruction,
          oldPreview: preview(input.oldString),
          newPreview: preview(input.newString),
        },
      };
    },
    async execute(input, context) {
      const workspace = resolve(context.cwd);
      const target = resolveWorkspacePath(workspace, input.filePath);
      const existing = await readTextIfExists(target.absolutePath);

      if (input.oldString === "") {
        if (existing !== undefined) {
          await context.fileReads?.assertFresh(workspace, target.absolutePath);
        }
        await mkdir(dirname(target.absolutePath), { recursive: true });
        await writeFile(target.absolutePath, input.newString, "utf8");
        await context.fileReads?.recordTextRead(workspace, target.absolutePath, input.newString);
        return {
          title: target.relativePath,
          output: existing === undefined ? "Created file successfully." : "Replaced file contents successfully.",
          metadata: {
            filePath: target.relativePath,
            created: existing === undefined,
            occurrences: 1,
          },
        };
      }

      if (existing === undefined) {
        throw new Error(`File not found: ${target.relativePath}`);
      }
      await context.fileReads?.assertObservedText(workspace, target.absolutePath, input.oldString);

      const lineEnding = detectLineEnding(existing);
      const oldString = convertToLineEnding(normalizeLineEndings(input.oldString), lineEnding);
      const newString = convertToLineEnding(normalizeLineEndings(input.newString), lineEnding);
      const occurrences = countOccurrences(existing, oldString);

      if (occurrences === 0) {
        throw new Error(`Text to replace was not found in ${target.relativePath}`);
      }
      if (!input.replaceAll && occurrences !== 1) {
        throw new Error(`Text to replace occurs ${occurrences} times in ${target.relativePath}; set replaceAll to true`);
      }

      const next = input.replaceAll ? existing.split(oldString).join(newString) : existing.replace(oldString, newString);
      await writeFile(target.absolutePath, next, "utf8");
      await context.fileReads?.recordTextRead(workspace, target.absolutePath, next);

      return {
        title: target.relativePath,
        output: `Edit applied successfully. Replaced ${input.replaceAll ? occurrences : 1} occurrence(s).`,
        metadata: {
          filePath: target.relativePath,
          occurrences: input.replaceAll ? occurrences : 1,
        },
      };
    },
  };
}

interface WorkspacePath {
  absolutePath: string;
  relativePath: string;
}

function resolveWorkspacePath(workspace: string, path: string): WorkspacePath {
  const absolutePath = resolve(workspace, path);
  const relativePath = relative(workspace, absolutePath);
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`Path must stay inside the workspace: ${path}`);
  }
  return { absolutePath, relativePath };
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text;
  return text.replaceAll("\n", "\r\n");
}

function countOccurrences(text: string, search: string): number {
  return text.split(search).length - 1;
}

function pickString(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function pickBoolean(record: Record<string, unknown>, ...keys: string[]): { value?: boolean; invalid?: boolean } {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return { invalid: true };
    return { value };
  }
  return {};
}

function preview(value: string): string {
  const normalized = normalizeLineEndings(value);
  if (normalized.length <= 300) return normalized;
  return `${normalized.slice(0, 300)}...`;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
