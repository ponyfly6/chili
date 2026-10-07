import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { withFileOperationLocks } from "../file-operation-lock.js";
import { assertReadableFileResources } from "../file-resource-access.js";
import { canonicalResourcePattern } from "../resource-policy.js";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import { assertExistingPathInsideWorkspace, resolveWorkspacePath } from "../workspace-path.js";

export interface PresentFileInput {
  filePath: string;
  title?: string;
  description?: string;
}

export interface PresentedFile {
  type: "presented_file";
  path: string;
  title: string;
  description?: string;
}

export function createPresentFileTool(): ChiliToolDefinition<PresentFileInput> {
  return {
    name: "present_file",
    codeMode: false,
    searchHint: "Present an existing completed document, image, prototype, or other deliverable to the user.",
    description: "Present an existing workspace file as an explicit user-facing deliverable. Call after creating and checking the file the user requested. This only verifies and presents the file; it does not create, edit, copy, or upload it. Do not use for source-code references, ordinary repository changes, files merely read during research, logs, or temporary working files. Use normal file links for references and the code review view for repository changes.",
    risk: "read",
    resourcePolicy: "filesystem",
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultOutputBytes: Infinity,
    inputSchema: {
      type: "object",
      required: ["filePath"],
      additionalProperties: false,
      properties: {
        filePath: { type: "string", minLength: 1, description: "An existing file inside the current workspace, absolute or workspace-relative." },
        title: { type: "string", minLength: 1, maxLength: 200, description: "A short user-facing title. Defaults to the file name." },
        description: { type: "string", maxLength: 2_000, description: "A brief description of what the user receives." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["type", "path", "title"],
      additionalProperties: false,
      properties: {
        type: { const: "presented_file" },
        path: { type: "string", description: "Canonical absolute path of the verified existing file." },
        title: { type: "string" },
        description: { type: "string" },
      },
    },
    validate(input): ValidationResult<PresentFileInput> {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { ok: false, message: "expected an object" };
      }
      const record = input as Record<string, unknown>;
      if (typeof record.filePath !== "string" || !record.filePath.trim() || record.filePath.includes("\0")) {
        return { ok: false, message: "filePath must be a non-empty file path without null bytes" };
      }
      if (record.title !== undefined && (typeof record.title !== "string" || !record.title.trim() || record.title.trim().length > 200)) {
        return { ok: false, message: "title must be a non-empty string of at most 200 characters" };
      }
      if (record.description !== undefined && (typeof record.description !== "string" || record.description.trim().length > 2_000)) {
        return { ok: false, message: "description must be a string of at most 2000 characters" };
      }
      if (Object.keys(record).some((key) => !["filePath", "title", "description"].includes(key))) {
        return { ok: false, message: "only filePath, title, and description are supported" };
      }
      const value: PresentFileInput = { filePath: record.filePath };
      if (typeof record.title === "string") value.title = record.title.trim();
      if (typeof record.description === "string" && record.description.trim()) value.description = record.description.trim();
      return { ok: true, value };
    },
    async prepareInput(input, context) {
      return { ...input, filePath: await canonicalResourcePattern(context.cwd, input.filePath, true) };
    },
    resources(input) {
      return { permission: "read", patterns: [input.filePath], metadata: { filePath: input.filePath } };
    },
    async execute(input, context) {
      const target = resolveWorkspacePath(context.cwd, input.filePath);
      return withFileOperationLocks([target.absolutePath], context.signal, async () => {
        await assertExistingPathInsideWorkspace(context.cwd, target, input.filePath);
        await assertReadableFileResources(context, [target.absolutePath]);
        const path = await realpath(target.absolutePath);
        const before = await stat(target.absolutePath);
        if (!before.isFile()) throw new Error("present_file requires an existing regular file, not a directory or special file.");

        // Opening read-only checks OS access as well as policy. Never create a
        // missing file, follow a replaced final symlink, or wait on a FIFO.
        const file = await open(target.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await file.stat();
          const current = await stat(target.absolutePath);
          if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
            || opened.dev !== current.dev || opened.ino !== current.ino
            || await realpath(target.absolutePath) !== path) {
            throw new Error("File changed while being presented; no deliverable was returned. Retry with the current file.");
          }
          await assertExistingPathInsideWorkspace(context.cwd, target, input.filePath);
          await assertReadableFileResources(context, [target.absolutePath]);
          const presented: PresentedFile = {
            type: "presented_file",
            path,
            title: input.title ?? basename(path),
            ...(input.description ? { description: input.description } : {}),
          };
          return {
            title: `Presented file: ${presented.title}`,
            output: JSON.stringify(presented),
            structuredData: presented,
            metadata: { type: presented.type, path: presented.path, title: presented.title },
          };
        } finally {
          await file.close();
        }
      });
    },
  };
}
