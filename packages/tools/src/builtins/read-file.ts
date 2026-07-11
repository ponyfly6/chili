import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import { assertExistingPathInsideWorkspace, resolveWorkspacePath } from "../workspace-path.js";

export interface ReadFileInput {
  filePath: string;
  offset?: number;
  limit?: number;
  maxBytes?: number;
}

export interface ReadFileToolOptions {
  defaultMaxBytes?: number;
  maxBytesLimit?: number;
}

const DEFAULT_MAX_READ_BYTES = 256_000;

export function createReadFileTool(options: ReadFileToolOptions = {}): ChiliToolDefinition<ReadFileInput> {
  const defaultMaxBytes = options.defaultMaxBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxBytesLimit = options.maxBytesLimit ?? Math.max(defaultMaxBytes, DEFAULT_MAX_READ_BYTES);
  if (!isPositiveInteger(defaultMaxBytes)) {
    throw new Error("defaultMaxBytes must be a positive integer");
  }
  if (!isPositiveInteger(maxBytesLimit)) {
    throw new Error("maxBytesLimit must be a positive integer");
  }
  if (defaultMaxBytes > maxBytesLimit) {
    throw new Error("defaultMaxBytes must be <= maxBytesLimit");
  }
  return {
    name: "read",
    aliases: ["read_file"],
    searchHint: "Read text files with optional line offsets and byte limits.",
    description: "Read a UTF-8 text file within the current workspace.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultOutputBytes: Infinity,
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
        maxBytes: { type: "number", maximum: maxBytesLimit },
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
      if (maxBytes !== undefined && maxBytes > maxBytesLimit) {
        return { ok: false, message: `maxBytes must be <= ${maxBytesLimit}` };
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
      const workspace = context.cwd;
      const target = resolveWorkspacePath(workspace, input.filePath);
      await assertExistingPathInsideWorkspace(workspace, target, input.filePath);

      const maxBytes = input.maxBytes ?? defaultMaxBytes;
      if (maxBytes > maxBytesLimit) {
        throw new Error(`maxBytes must be <= ${maxBytesLimit}`);
      }
      const rangeOptions: { offset?: number; limit?: number; maxBytes: number } = { maxBytes };
      if (input.offset !== undefined) rangeOptions.offset = input.offset;
      if (input.limit !== undefined) rangeOptions.limit = input.limit;
      const selection = input.offset === undefined && input.limit === undefined
        ? await readPrefix(target.absolutePath, maxBytes)
        : await readLineRange(target.absolutePath, rangeOptions);
      const { content, truncated, bytes } = selection;
      const fullRead = !truncated && input.offset === undefined && input.limit === undefined;
      if (fullRead) {
        await context.fileReads?.recordTextRead(workspace, target.absolutePath, content);
      } else {
        await context.fileReads?.recordTextRangeRead(workspace, target.absolutePath, content, {
          ...(input.offset !== undefined ? { offset: input.offset } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
      }

      return {
        title: target.relativePath,
        output: truncated ? `${content}\n[truncated after ${maxBytes} bytes]` : content,
        metadata: {
          path: target.relativePath,
          bytes,
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

interface ReadSelection {
  content: string;
  bytes: number;
  truncated: boolean;
}

async function readPrefix(path: string, maxBytes: number): Promise<ReadSelection> {
  const info = await stat(path);
  const bytesToRead = Math.min(info.size, maxBytes);
  if (bytesToRead === 0) {
    return { content: "", bytes: info.size, truncated: false };
  }

  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, 0);
    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      bytes: info.size,
      truncated: info.size > maxBytes,
    };
  } finally {
    await file.close();
  }
}

async function readLineRange(
  path: string,
  options: { offset?: number; limit?: number; maxBytes: number },
): Promise<ReadSelection> {
  const info = await stat(path);
  const startLine = options.offset ?? 1;
  const endLineExclusive = options.limit === undefined ? Number.POSITIVE_INFINITY : startLine + options.limit;
  const stream = createReadStream(path);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let lineNumber = 1;
  let output = "";
  let outputBytes = 0;
  let selectedLines = 0;
  let truncated = false;
  let stop = false;
  let endedWithNewline = false;

  const appendLine = (line: string): void => {
    if (lineNumber >= startLine && lineNumber < endLineExclusive) {
      const prefix = selectedLines > 0 ? "\n" : "";
      const appended = appendLimited(output, outputBytes, `${prefix}${line}`, options.maxBytes);
      output = appended.output;
      outputBytes = appended.outputBytes;
      truncated = truncated || appended.truncated;
      selectedLines += 1;
    }
    lineNumber += 1;
    if (truncated || lineNumber >= endLineExclusive) stop = true;
  };

  try {
    for await (const chunk of stream) {
      if (stop) break;
      const text = decoder.write(chunk as Buffer);
      endedWithNewline = text.endsWith("\n");
      const lines = `${pending}${text}`.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        appendLine(line);
        if (stop) break;
      }
    }
    if (!stop) {
      const tail = decoder.end();
      const finalText = `${pending}${tail}`;
      if (finalText.length > 0 || endedWithNewline) appendLine(finalText);
    }
  } finally {
    stream.destroy();
  }

  return { content: output, bytes: info.size, truncated };
}

function appendLimited(
  output: string,
  outputBytes: number,
  next: string,
  maxBytes: number,
): { output: string; outputBytes: number; truncated: boolean } {
  if (next.length === 0) return { output, outputBytes, truncated: false };
  const remaining = maxBytes - outputBytes;
  if (remaining <= 0) return { output, outputBytes, truncated: true };
  const nextBuffer = Buffer.from(next, "utf8");
  if (nextBuffer.byteLength <= remaining) {
    return {
      output: `${output}${next}`,
      outputBytes: outputBytes + nextBuffer.byteLength,
      truncated: false,
    };
  }
  return {
    output: `${output}${nextBuffer.subarray(0, remaining).toString("utf8")}`,
    outputBytes: maxBytes,
    truncated: true,
  };
}
