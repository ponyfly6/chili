import type { ToolCallId } from "@chili/protocol";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertExistingPathInsideWorkspace,
  assertWritablePathInsideWorkspace,
  resolveWorkspacePath,
} from "./workspace-path.js";

export const DEFAULT_MAX_PERSISTED_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PERSISTED_OUTPUT_DIRECTORY_BYTES = 64 * 1024 * 1024;

const sidecarDirectoryLocks = new Map<string, Promise<void>>();
const activeSidecars = new Set<string>();

export interface PersistedOutput {
  relativePath: string;
  absolutePath: string;
  bytes: number;
  originalBytes: number;
  limitBytes: number;
  truncated: boolean;
}

export interface ToolOutputStorageOptions {
  maxBytes?: number;
  maxDirectoryBytes?: number;
}

export async function persistToolOutput(
  cwd: string,
  callId: ToolCallId,
  output: string,
  options: ToolOutputStorageOptions = {},
): Promise<PersistedOutput> {
  const target = await prepareOutputTarget(cwd, callId);
  const limitBytes = options.maxBytes ?? DEFAULT_MAX_PERSISTED_OUTPUT_BYTES;
  const persisted = truncateUtf8(output, limitBytes);
  return withSidecarDirectoryLock(target.directoryPath, async () => {
    await validateOutputTarget(cwd, target);
    await writeFile(target.absolutePath, persisted.text, "utf8");
    const bytes = Buffer.byteLength(persisted.text, "utf8");
    await enforceSidecarDirectoryBudget(
      target.directoryPath,
      target.absolutePath,
      options.maxDirectoryBytes ?? DEFAULT_MAX_PERSISTED_OUTPUT_DIRECTORY_BYTES,
    );
    return {
      relativePath: target.relativePath,
      absolutePath: target.absolutePath,
      bytes,
      originalBytes: persisted.bytes,
      limitBytes,
      truncated: persisted.truncated,
    };
  });
}

export class StreamingToolOutputFile {
  private originalBytes = 0;
  private persistedBytes = 0;
  private closed = false;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly cwd: string,
    private readonly target: OutputTarget,
    private readonly handle: FileHandle,
    private readonly limitBytes: number,
    private readonly maxDirectoryBytes: number,
  ) {}

  static async open(
    cwd: string,
    callId: ToolCallId,
    options: ToolOutputStorageOptions = {},
  ): Promise<StreamingToolOutputFile> {
    const target = await prepareOutputTarget(cwd, callId);
    const handle = await withSidecarDirectoryLock(target.directoryPath, async () => {
      await validateOutputTarget(cwd, target);
      const opened = await open(target.absolutePath, "w");
      activeSidecars.add(target.absolutePath);
      return opened;
    });
    return new StreamingToolOutputFile(
      cwd,
      target,
      handle,
      options.maxBytes ?? DEFAULT_MAX_PERSISTED_OUTPUT_BYTES,
      options.maxDirectoryBytes ?? DEFAULT_MAX_PERSISTED_OUTPUT_DIRECTORY_BYTES,
    );
  }

  append(text: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Cannot append to a closed tool output file"));
    this.writeQueue = this.writeQueue.then(async () => {
      const bytes = Buffer.byteLength(text, "utf8");
      this.originalBytes += bytes;
      const remaining = Math.max(0, this.limitBytes - this.persistedBytes);
      if (remaining === 0 || bytes === 0) return;
      const bounded = truncateUtf8(text, remaining).text;
      if (bounded.length === 0) return;
      await this.handle.write(bounded, null, "utf8");
      this.persistedBytes += Buffer.byteLength(bounded, "utf8");
    });
    return this.writeQueue;
  }

  async close(): Promise<PersistedOutput> {
    if (this.closed) throw new Error("Tool output file is already closed");
    this.closed = true;
    try {
      await this.writeQueue;
      await this.handle.close();
      await withSidecarDirectoryLock(this.target.directoryPath, async () => {
        activeSidecars.delete(this.target.absolutePath);
        await validateOutputTarget(this.cwd, this.target);
        await enforceSidecarDirectoryBudget(
          this.target.directoryPath,
          this.target.absolutePath,
          this.maxDirectoryBytes,
        );
      });
    } catch (error) {
      activeSidecars.delete(this.target.absolutePath);
      await this.handle.close().catch(() => undefined);
      throw error;
    }
    return {
      relativePath: this.target.relativePath,
      absolutePath: this.target.absolutePath,
      bytes: this.persistedBytes,
      originalBytes: this.originalBytes,
      limitBytes: this.limitBytes,
      truncated: this.persistedBytes < this.originalBytes,
    };
  }
}

export function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  const bytes = buffer.byteLength;
  if (bytes <= maxBytes) return { text, bytes, truncated: false };
  let end = Math.max(0, Math.min(Math.trunc(maxBytes), bytes));
  while (end > 0 && ((buffer[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return {
    text: buffer.subarray(0, end).toString("utf8"),
    bytes,
    truncated: true,
  };
}

interface OutputTarget {
  relativePath: string;
  absolutePath: string;
  directoryPath: string;
}

async function prepareOutputTarget(cwd: string, callId: ToolCallId): Promise<OutputTarget> {
  const relativeDirectory = join(".chili", "tool-results");
  const relativePath = join(relativeDirectory, toolResultFilename(callId));
  const directory = resolveWorkspacePath(cwd, relativeDirectory);
  const file = resolveWorkspacePath(cwd, relativePath);
  await assertWritablePathInsideWorkspace(cwd, file, relativePath);
  await mkdir(directory.absolutePath, { recursive: true });
  return {
    relativePath,
    absolutePath: file.absolutePath,
    directoryPath: directory.absolutePath,
  };
}

async function validateOutputTarget(cwd: string, target: OutputTarget): Promise<void> {
  const relativeDirectory = join(".chili", "tool-results");
  const directory = resolveWorkspacePath(cwd, relativeDirectory);
  const file = resolveWorkspacePath(cwd, target.relativePath);
  await assertExistingPathInsideWorkspace(cwd, directory, relativeDirectory);
  await assertWritablePathInsideWorkspace(cwd, file, target.relativePath);
}

function toolResultFilename(callId: ToolCallId): string {
  const value = String(callId);
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && !value.includes("..")) {
    return `${value}.txt`;
  }
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `toolcall_${hash}.txt`;
}

async function enforceSidecarDirectoryBudget(directory: string, currentPath: string, maxBytes: number): Promise<void> {
  if (maxBytes === Infinity) return;
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const path = join(directory, entry.name);
    const info = await stat(path);
    return { path, bytes: info.size, modifiedAt: info.mtimeMs };
  }));
  let totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  const current = files.find((file) => file.path === currentPath);
  const activeBytes = files
    .filter((file) => activeSidecars.has(file.path))
    .reduce((total, file) => total + file.bytes, 0);
  const effectiveLimit = Math.max(0, Math.trunc(maxBytes), current?.bytes ?? 0, activeBytes);
  files.sort((left, right) => {
    if (left.path === currentPath || activeSidecars.has(left.path)) return 1;
    if (right.path === currentPath || activeSidecars.has(right.path)) return -1;
    return left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path);
  });
  for (const file of files) {
    if (totalBytes <= effectiveLimit || file.path === currentPath || activeSidecars.has(file.path)) break;
    await unlink(file.path).catch((error) => {
      if (!isNotFoundError(error)) throw error;
    });
    totalBytes -= file.bytes;
  }
}

async function withSidecarDirectoryLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const previous = sidecarDirectoryLocks.get(directory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const tail = previous.then(() => current);
  sidecarDirectoryLocks.set(directory, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sidecarDirectoryLocks.get(directory) === tail) sidecarDirectoryLocks.delete(directory);
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
