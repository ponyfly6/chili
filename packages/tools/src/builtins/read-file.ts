import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";

export interface ReadFileInput {
  filePath: string;
  offset?: number;
  limit?: number;
  maxBytes?: number;
}

export function createReadFileTool(): ChiliToolDefinition<ReadFileInput> {
  return {
    name: "read",
    aliases: ["read_file"],
    description: "Read a UTF-8 text file within the current workspace.",
    risk: "read",
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
        maxBytes: { type: "number" },
      },
    },
    validate(input): ValidationResult<ReadFileInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const filePath = pickString(input, "filePath", "path", "file_path");
      const offset = input.offset;
      const limit = input.limit;
      const maxBytes = input.maxBytes;

      if (typeof filePath !== "string" || filePath.trim().length === 0) {
        return { ok: false, message: "filePath must be a non-empty string" };
      }
      if (offset !== undefined && (!isPositiveInteger(offset) || offset < 1)) {
        return { ok: false, message: "offset must be a positive integer starting at 1" };
      }
      if (limit !== undefined && !isPositiveInteger(limit)) {
        return { ok: false, message: "limit must be a positive integer" };
      }
      if (maxBytes !== undefined && !isPositiveInteger(maxBytes)) {
        return { ok: false, message: "maxBytes must be a positive integer" };
      }
      const value: ReadFileInput = {
        filePath,
      };
      if (offset !== undefined) value.offset = offset;
      if (limit !== undefined) value.limit = limit;
      if (maxBytes !== undefined) {
        value.maxBytes = maxBytes;
      }
      return {
        ok: true,
        value,
      };
    },
    approval(input) {
      return {
        permission: "read",
        patterns: [input.filePath],
        metadata: { filePath: input.filePath },
      };
    },
    async execute(input, context) {
      const workspace = resolve(context.cwd);
      const target = resolve(workspace, input.filePath);
      const rel = relative(workspace, target);

      if (rel.startsWith("..") || rel === "") {
        throw new Error(`read only supports files inside the workspace: ${input.filePath}`);
      }

      const buffer = await readFile(target);
      const maxBytes = input.maxBytes ?? 256_000;
      const truncated = buffer.byteLength > maxBytes;
      const rawContent = buffer.subarray(0, maxBytes).toString("utf8");
      const content = sliceLines(rawContent, input.offset, input.limit);

      return {
        title: rel,
        output: truncated ? `${content}\n[truncated after ${maxBytes} bytes]` : content,
        metadata: {
          path: rel,
          bytes: buffer.byteLength,
          truncated,
        },
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickString(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function sliceLines(content: string, offset = 1, limit?: number): string {
  if (offset === 1 && limit === undefined) return content;
  const lines = content.split("\n");
  const start = offset - 1;
  const end = limit === undefined ? undefined : start + limit;
  return lines.slice(start, end).join("\n");
}
