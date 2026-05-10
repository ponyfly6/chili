import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";

export interface ReadImageInput {
  filePath: string;
  maxBytes?: number;
}

const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function createReadImageTool(): ChiliToolDefinition<ReadImageInput> {
  return {
    name: "read_image",
    aliases: ["view_image", "image_read"],
    searchHint: "Read an image file from the workspace and send it to vision-capable models. For text-only pasted-image prompts, prefer an OCR or image-understanding MCP tool that returns text.",
    description: "Read a PNG, JPEG, GIF, or WebP image within the current workspace and return it as an image block for vision-capable models.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string" },
        maxBytes: { type: "number" },
      },
    },
    validate(input): ValidationResult<ReadImageInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const filePath = pickString(input, "filePath", "path", "file_path");
      const maxBytes = input.maxBytes;
      if (typeof filePath !== "string" || filePath.trim().length === 0) {
        return { ok: false, message: "filePath must be a non-empty string" };
      }
      if (maxBytes !== undefined && !isPositiveInteger(maxBytes)) {
        return { ok: false, message: "maxBytes must be a positive integer" };
      }
      const value: ReadImageInput = { filePath };
      if (maxBytes !== undefined) value.maxBytes = maxBytes;
      return { ok: true, value };
    },
    approval(input) {
      return {
        permission: "read",
        patterns: [input.filePath],
        metadata: { filePath: input.filePath, media: "image" },
      };
    },
    async execute(input, context) {
      const workspace = resolve(context.cwd);
      const target = resolve(workspace, input.filePath);
      const rel = relative(workspace, target);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`read_image only supports files inside the workspace: ${input.filePath}`);
      }

      const mimeType = mimeTypeForPath(target);
      if (!mimeType) {
        throw new Error(`read_image supports PNG, JPEG, GIF, and WebP images: ${input.filePath}`);
      }

      const info = await stat(target);
      if (!info.isFile()) throw new Error(`read_image only supports files: ${input.filePath}`);
      const maxBytes = input.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
      if (info.size > maxBytes) {
        throw new Error(`image is ${info.size} bytes, above the ${maxBytes} byte limit`);
      }

      const buffer = await readFile(target);
      const data = buffer.toString("base64");
      return {
        title: rel,
        output: [
          `Image read: ${rel}`,
          `MIME type: ${mimeType}`,
          `Bytes: ${buffer.byteLength}`,
          "The visual image content is attached to this tool result as an image block. Inspect that image block directly; do not treat this as metadata-only output.",
        ].join("\n"),
        content: [{ type: "image", data, mimeType }],
        metadata: {
          path: rel,
          bytes: buffer.byteLength,
          mimeType,
        },
      };
    },
  };
}

function mimeTypeForPath(path: string): string | undefined {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()];
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
