import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import { assertWritablePathInsideWorkspace, resolveWorkspacePath } from "../workspace-path.js";

export interface WriteFileInput {
  filePath: string;
  content: string;
  instruction?: string;
}

export function createWriteFileTool(): ChiliToolDefinition<WriteFileInput> {
  return {
    name: "write",
    aliases: ["write_file"],
    searchHint: "Write full UTF-8 file contents; existing files must be read first.",
    description: "Write full UTF-8 text content to a workspace file.",
    risk: "write",
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: true,
    interruptBehavior: "block",
    maxResultOutputBytes: 100_000,
    inputSchema: {
      type: "object",
      required: ["filePath", "content"],
      properties: {
        filePath: { type: "string" },
        content: { type: "string" },
        instruction: { type: "string" },
      },
    },
    validate(input): ValidationResult<WriteFileInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const filePath = pickString(input, "filePath", "file_path", "path");
      const content = input.content;
      const instruction = input.instruction;

      if (typeof filePath !== "string" || filePath.trim().length === 0) {
        return { ok: false, message: "filePath must be a non-empty string" };
      }
      if (typeof content !== "string") {
        return { ok: false, message: "content must be a string" };
      }
      if (instruction !== undefined && typeof instruction !== "string") {
        return { ok: false, message: "instruction must be a string" };
      }

      const value: WriteFileInput = { filePath, content };
      if (instruction !== undefined) value.instruction = instruction;
      return { ok: true, value };
    },
    approval(input) {
      return {
        permission: "write",
        patterns: [input.filePath],
        metadata: {
          filePath: input.filePath,
          bytes: Buffer.byteLength(input.content, "utf8"),
          instruction: input.instruction,
        },
      };
    },
    async execute(input, context) {
      const workspace = context.cwd;
      const target = resolveWorkspacePath(workspace, input.filePath);
      await assertWritablePathInsideWorkspace(workspace, target, input.filePath);
      const existing = await readTextIfExists(target.absolutePath);
      if (existing !== undefined) {
        await context.fileReads?.assertFresh(workspace, target.absolutePath);
      }

      await mkdir(dirname(target.absolutePath), { recursive: true });
      await writeFile(target.absolutePath, input.content, "utf8");
      await context.fileReads?.recordTextRead(workspace, target.absolutePath, input.content);

      return {
        title: target.relativePath,
        output: existing === undefined ? "Created file successfully." : "Wrote file successfully.",
        metadata: {
          filePath: target.relativePath,
          created: existing === undefined,
          bytes: Buffer.byteLength(input.content, "utf8"),
        },
      };
    },
  };
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function pickString(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
