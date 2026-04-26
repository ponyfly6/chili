import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { ChiliToolDefinition, ChiliToolExecutionContext, ValidationResult } from "../types.js";

export interface ApplyPatchInput {
  patchText?: string;
  operations: ApplyPatchOperation[];
}

export type ApplyPatchOperation = CreateFileOperation | ReplaceTextOperation | DeleteFileOperation | RawPatchUpdateOperation;

export interface CreateFileOperation {
  type: "create";
  path: string;
  content: string;
  overwrite?: boolean;
}

export interface ReplaceTextOperation {
  type: "replace";
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface DeleteFileOperation {
  type: "delete";
  path: string;
}

export interface RawPatchUpdateOperation {
  type: "raw_update";
  path: string;
  movePath?: string;
  chunks: RawPatchChunk[];
}

export interface RawPatchChunk {
  oldLines: string[];
  newLines: string[];
}

interface AppliedOperation {
  type: ApplyPatchOperation["type"];
  path: string;
  changed: boolean;
  detail: string;
}

export function createApplyPatchTool(): ChiliToolDefinition<ApplyPatchInput> {
  return {
    name: "apply_patch",
    searchHint: "Apply structured create, replace, delete, or raw patch operations to workspace files.",
    description: "Apply Codex/OpenCode-style patch text to files inside the workspace.",
    risk: "write",
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: (input) => input.operations.some((operation) => operation.type === "delete"),
    interruptBehavior: "block",
    maxResultOutputBytes: 100_000,
    inputSchema: {
      type: "object",
      properties: {
        patchText: { type: "string" },
        operations: {
          type: "array",
          items: {
            type: "object",
          },
        },
      },
    },
    validate(input): ValidationResult<ApplyPatchInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };

      if (typeof input.patchText === "string") {
        const parsed = parsePatchText(input.patchText);
        if (!parsed.ok) return parsed;
        return {
          ok: true,
          value: {
            patchText: input.patchText,
            operations: parsed.value,
          },
        };
      }

      if (!Array.isArray(input.operations) || input.operations.length === 0) {
        return { ok: false, message: "patchText or operations must be provided" };
      }

      const operations: ApplyPatchOperation[] = [];
      for (const [index, raw] of input.operations.entries()) {
        const parsed = parseOperation(raw, index);
        if (!parsed.ok) return parsed;
        operations.push(parsed.value);
      }

      return { ok: true, value: { operations } };
    },
    approval(input) {
      return {
        permission: "edit",
        patterns: input.operations.flatMap((operation) => operation.type === "raw_update" && operation.movePath ? [operation.path, operation.movePath] : [operation.path]),
        metadata: {
          operationCount: input.operations.length,
          source: input.patchText ? "patchText" : "operations",
          operations: input.operations.map((operation) => ({
            type: operation.type,
            path: operation.path,
            ...(operation.type === "raw_update" && operation.movePath ? { movePath: operation.movePath } : {}),
          })),
        },
      };
    },
    async execute(input, context) {
      const workspace = resolve(context.cwd);
      const applied: AppliedOperation[] = [];

      for (const operation of input.operations) {
        const target = resolveWorkspacePath(workspace, operation.path);
        await assertPatchReadState(workspace, target, operation, context.fileReads);
        if (operation.type === "create") {
          applied.push(await createFile(target, operation));
        } else if (operation.type === "replace") {
          applied.push(await replaceText(target, operation));
        } else if (operation.type === "delete") {
          applied.push(await deleteFile(target, operation));
        } else {
          applied.push(await applyRawUpdate(workspace, target, operation));
        }
        await updatePatchReadState(workspace, operation, context.fileReads);
      }

      const changed = applied.filter((operation) => operation.changed);
      const output = [
        `Applied ${changed.length}/${applied.length} operation(s).`,
        "",
        ...applied.map((operation) => `- ${operation.type} ${operation.path}: ${operation.detail}`),
      ].join("\n");

      return {
        title: `patched ${changed.length} file operation(s)`,
        output,
        metadata: {
          files: [...new Set(applied.map((operation) => operation.path))],
          operationCount: applied.length,
          changedCount: changed.length,
        },
      };
    },
  };
}

function parseOperation(raw: unknown, index: number): ValidationResult<ApplyPatchOperation> {
  if (!isRecord(raw)) return { ok: false, message: `operation ${index} must be an object` };
  if (raw.type !== "create" && raw.type !== "replace" && raw.type !== "delete") {
    return { ok: false, message: `operation ${index} type must be "create", "replace", or "delete"` };
  }
  if (typeof raw.path !== "string" || raw.path.trim().length === 0) {
    return { ok: false, message: `operation ${index} path must be a non-empty string` };
  }
  if (!isSafeRelativePath(raw.path)) {
    return { ok: false, message: `operation ${index} path must stay inside the workspace` };
  }

  if (raw.type === "create") {
    if (typeof raw.content !== "string") {
      return { ok: false, message: `operation ${index} content must be a string` };
    }
    if (raw.overwrite !== undefined && typeof raw.overwrite !== "boolean") {
      return { ok: false, message: `operation ${index} overwrite must be boolean` };
    }
    const operation: CreateFileOperation = {
      type: "create",
      path: raw.path,
      content: raw.content,
    };
    if (raw.overwrite !== undefined) operation.overwrite = raw.overwrite;
    return { ok: true, value: operation };
  }

  if (raw.type === "delete") {
    return { ok: true, value: { type: "delete", path: raw.path } };
  }

  if (typeof raw.oldText !== "string" || raw.oldText.length === 0) {
    return { ok: false, message: `operation ${index} oldText must be a non-empty string` };
  }
  if (typeof raw.newText !== "string") {
    return { ok: false, message: `operation ${index} newText must be a string` };
  }
  if (raw.replaceAll !== undefined && typeof raw.replaceAll !== "boolean") {
    return { ok: false, message: `operation ${index} replaceAll must be boolean` };
  }
  const operation: ReplaceTextOperation = {
    type: "replace",
    path: raw.path,
    oldText: raw.oldText,
    newText: raw.newText,
  };
  if (raw.replaceAll !== undefined) operation.replaceAll = raw.replaceAll;
  return { ok: true, value: operation };
}

function parsePatchText(patchText: string): ValidationResult<ApplyPatchOperation[]> {
  const lines = normalizeLineEndings(patchText).split("\n");
  if (lines[0] !== "*** Begin Patch") {
    return { ok: false, message: "patchText must start with *** Begin Patch" };
  }

  const operations: ApplyPatchOperation[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line === "*** End Patch") break;

    if (line?.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      if (!isSafeRelativePath(path)) return { ok: false, message: `add path must stay inside the workspace: ${path}` };
      index++;
      const contents: string[] = [];
      while (index < lines.length && !isPatchBoundary(lines[index])) {
        const next = lines[index] ?? "";
        if (!next.startsWith("+")) return { ok: false, message: `add file line must start with +: ${path}` };
        contents.push(next.slice(1));
        index++;
      }
      operations.push({ type: "create", path, content: contents.join("\n"), overwrite: false });
      continue;
    }

    if (line?.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim();
      if (!isSafeRelativePath(path)) return { ok: false, message: `delete path must stay inside the workspace: ${path}` };
      operations.push({ type: "delete", path });
      index++;
      continue;
    }

    if (line?.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      if (!isSafeRelativePath(path)) return { ok: false, message: `update path must stay inside the workspace: ${path}` };
      index++;

      let movePath: string | undefined;
      const moveLine = lines[index];
      if (moveLine?.startsWith("*** Move to: ")) {
        movePath = moveLine.slice("*** Move to: ".length).trim();
        if (!isSafeRelativePath(movePath)) return { ok: false, message: `move path must stay inside the workspace: ${movePath}` };
        index++;
      }

      const chunks: RawPatchChunk[] = [];
      let current: RawPatchChunk = { oldLines: [], newLines: [] };
      let hasChange = false;

      while (index < lines.length && !isPatchBoundary(lines[index])) {
        const next = lines[index] ?? "";
        if (next === "*** End of File" || next === "\\ No newline at end of file") {
          index++;
          continue;
        }
        if (next.startsWith("@@")) {
          pushChunk(chunks, current, hasChange);
          current = { oldLines: [], newLines: [] };
          hasChange = false;
          index++;
          continue;
        }

        const prefix = next[0];
        if (prefix !== " " && prefix !== "+" && prefix !== "-") {
          return { ok: false, message: `update line must start with space, +, -, or @@: ${path}` };
        }

        const text = next.slice(1);
        if (prefix !== "+") current.oldLines.push(text);
        if (prefix !== "-") current.newLines.push(text);
        if (prefix === "+" || prefix === "-") hasChange = true;
        index++;
      }

      pushChunk(chunks, current, hasChange);
      if (chunks.length === 0) return { ok: false, message: `update patch has no changed chunks: ${path}` };
      const operation: RawPatchUpdateOperation = { type: "raw_update", path, chunks };
      if (movePath) operation.movePath = movePath;
      operations.push(operation);
      continue;
    }

    return { ok: false, message: `unknown patch hunk: ${line ?? ""}` };
  }

  if (operations.length === 0) return { ok: false, message: "patchText contains no operations" };
  return { ok: true, value: operations };
}

function pushChunk(chunks: RawPatchChunk[], chunk: RawPatchChunk, hasChange: boolean): void {
  if (!hasChange) return;
  chunks.push(chunk);
}

function isPatchBoundary(line: string | undefined): boolean {
  return (
    line === undefined ||
    line === "*** End Patch" ||
    line.startsWith("*** Add File: ") ||
    line.startsWith("*** Delete File: ") ||
    line.startsWith("*** Update File: ")
  );
}

async function createFile(target: WorkspacePath, operation: CreateFileOperation): Promise<AppliedOperation> {
  const existing = await readTextIfExists(target.absolutePath);
  if (existing !== undefined && !operation.overwrite) {
    throw new Error(`Refusing to overwrite existing file: ${target.relativePath}`);
  }

  await mkdir(dirname(target.absolutePath), { recursive: true });
  await writeFile(target.absolutePath, operation.content, "utf8");

  return {
    type: operation.type,
    path: target.relativePath,
    changed: existing !== operation.content,
    detail: existing === undefined ? "created" : "overwritten",
  };
}

async function assertPatchReadState(
  workspace: string,
  target: WorkspacePath,
  operation: ApplyPatchOperation,
  fileReads: ChiliToolExecutionContext["fileReads"],
): Promise<void> {
  if (!fileReads) return;

  if (operation.type === "create") {
    const existing = await readTextIfExists(target.absolutePath);
    if (existing !== undefined) await fileReads.assertFresh(workspace, target.absolutePath);
    return;
  }

  await fileReads.assertFresh(workspace, target.absolutePath);
  if (operation.type === "raw_update" && operation.movePath) {
    const outputPath = resolveWorkspacePath(workspace, operation.movePath);
    if (outputPath.absolutePath !== target.absolutePath) {
      const existingOutput = await readTextIfExists(outputPath.absolutePath);
      if (existingOutput !== undefined) await fileReads.assertFresh(workspace, outputPath.absolutePath);
    }
  }
}

async function updatePatchReadState(
  workspace: string,
  operation: ApplyPatchOperation,
  fileReads: ChiliToolExecutionContext["fileReads"],
): Promise<void> {
  if (!fileReads) return;

  if (operation.type === "delete") {
    const target = resolveWorkspacePath(workspace, operation.path);
    fileReads.forget(workspace, target.absolutePath);
    return;
  }

  const outputPath = operation.type === "raw_update" && operation.movePath ? operation.movePath : operation.path;
  const target = resolveWorkspacePath(workspace, outputPath);
  const content = await readTextIfExists(target.absolutePath);
  if (content !== undefined) await fileReads.recordTextRead(workspace, target.absolutePath, content);
  if (operation.type === "raw_update" && operation.movePath) {
    const source = resolveWorkspacePath(workspace, operation.path);
    if (source.absolutePath !== target.absolutePath) fileReads.forget(workspace, source.absolutePath);
  }
}

async function deleteFile(target: WorkspacePath, operation: DeleteFileOperation): Promise<AppliedOperation> {
  await rm(target.absolutePath);
  return {
    type: operation.type,
    path: target.relativePath,
    changed: true,
    detail: "deleted",
  };
}

async function replaceText(target: WorkspacePath, operation: ReplaceTextOperation): Promise<AppliedOperation> {
  const current = await readFile(target.absolutePath, "utf8");
  const occurrences = countOccurrences(current, operation.oldText);
  if (occurrences === 0) {
    throw new Error(`Text to replace was not found in ${target.relativePath}`);
  }
  if (!operation.replaceAll && occurrences !== 1) {
    throw new Error(`Text to replace occurs ${occurrences} times in ${target.relativePath}; set replaceAll to replace every occurrence`);
  }

  const next = operation.replaceAll
    ? current.split(operation.oldText).join(operation.newText)
    : current.replace(operation.oldText, operation.newText);

  await writeFile(target.absolutePath, next, "utf8");

  return {
    type: operation.type,
    path: target.relativePath,
    changed: next !== current,
    detail: `replaced ${operation.replaceAll ? occurrences : 1} occurrence(s)`,
  };
}

async function applyRawUpdate(workspace: string, target: WorkspacePath, operation: RawPatchUpdateOperation): Promise<AppliedOperation> {
  const source = await readFile(target.absolutePath, "utf8");
  const lineEnding = detectLineEnding(source);
  let next = normalizeLineEndings(source);

  for (const chunk of operation.chunks) {
    next = applyRawChunk(next, chunk, target.relativePath);
  }

  const outputPath = operation.movePath ? resolveWorkspacePath(workspace, operation.movePath) : target;
  await mkdir(dirname(outputPath.absolutePath), { recursive: true });
  await writeFile(outputPath.absolutePath, convertToLineEnding(next, lineEnding), "utf8");
  if (operation.movePath && outputPath.absolutePath !== target.absolutePath) {
    await rm(target.absolutePath);
  }

  return {
    type: operation.type,
    path: operation.movePath ?? target.relativePath,
    changed: normalizeLineEndings(source) !== next || Boolean(operation.movePath),
    detail: `applied ${operation.chunks.length} chunk(s)`,
  };
}

function applyRawChunk(content: string, chunk: RawPatchChunk, path: string): string {
  const oldText = chunk.oldLines.join("\n");
  const newText = chunk.newLines.join("\n");
  const candidates: Array<[string, string]> = oldText.length > 0 ? [[oldText, newText], [`${oldText}\n`, `${newText}\n`]] : [];

  for (const [find, replace] of candidates) {
    const occurrences = countOccurrences(content, find);
    if (occurrences === 1) {
      return content.replace(find, replace);
    }
    if (occurrences > 1) {
      throw new Error(`Patch chunk matches ${occurrences} locations in ${path}`);
    }
  }

  throw new Error(`Patch chunk did not match ${path}`);
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

function countOccurrences(text: string, search: string): number {
  return text.split(search).length - 1;
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

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
