import type { ToolCallId } from "@chili/protocol";
import { dlopen, FFIType } from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  assertExistingPathInsideWorkspace,
  assertWritablePathInsideWorkspace,
  resolveWorkspacePath,
} from "./workspace-path.js";
import type { PersistedToolOutputRegistration } from "./types.js";

export const DEFAULT_MAX_PERSISTED_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PERSISTED_OUTPUT_DIRECTORY_BYTES = 64 * 1024 * 1024;

const sidecarDirectoryLocks = new Map<string, Promise<void>>();
const FILESYSTEM_LOCK_TIMEOUT_MS = 2_000;
const FILESYSTEM_LOCK_RETRY_MS = 10;
const FILESYSTEM_LOCK_FILENAME = ".sidecar.lock";
const LOCK_EXCLUSIVE = 2;
const LOCK_NONBLOCKING = 4;
const LOCK_UNLOCK = 8;
const trustedPersistedOutputs = new WeakSet<object>();

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
  const maxDirectoryBytes = options.maxDirectoryBytes ?? DEFAULT_MAX_PERSISTED_OUTPUT_DIRECTORY_BYTES;
  const limitBytes = effectiveOutputLimit(
    options.maxBytes ?? DEFAULT_MAX_PERSISTED_OUTPUT_BYTES,
    maxDirectoryBytes,
  );
  const persisted = truncateUtf8(output, limitBytes);
  return withOutputDirectoryLock(target.directoryPath, async () => {
    await validateOutputTarget(cwd, target);
    const bytes = Buffer.byteLength(persisted.text, "utf8");
    await ensureSidecarDirectoryCapacity(target.directoryPath, bytes, maxDirectoryBytes);
    const temporary = await openTemporaryOutput(target, bytes);
    try {
      await temporary.handle.writeFile(persisted.text, "utf8");
      await temporary.handle.truncate(bytes);
      await validateTemporaryHandle(temporary.handle);
      await temporary.handle.sync();
      await temporary.handle.close();
      await validateOutputTarget(cwd, target);
      await rename(temporary.path, target.absolutePath);
      return trustedPersistedOutput({
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        bytes,
        originalBytes: persisted.bytes,
        limitBytes,
        truncated: persisted.truncated,
      });
    } catch (error) {
      await temporary.handle.close().catch(() => undefined);
      await unlink(temporary.path).catch((unlinkError) => {
        if (!isNotFoundError(unlinkError)) throw unlinkError;
      });
      throw error;
    }
  });
}

export async function validatePersistedToolOutput(
  cwd: string,
  callId: ToolCallId,
  registration: PersistedToolOutputRegistration,
  options: ToolOutputStorageOptions = {},
): Promise<PersistedOutput> {
  if (!isTrustedPersistedOutput(registration)) {
    throw new Error("Persisted tool output registration was not created by Chili storage");
  }
  const snapshot = snapshotPersistedOutputRegistration(registration);
  validatePersistedOutputRegistration(snapshot);
  const expectedLimit = effectiveOutputLimit(
    options.maxBytes ?? DEFAULT_MAX_PERSISTED_OUTPUT_BYTES,
    options.maxDirectoryBytes ?? DEFAULT_MAX_PERSISTED_OUTPUT_DIRECTORY_BYTES,
  );
  if (snapshot.limitBytes !== expectedLimit) {
    throw new Error(
      `Persisted tool output limit mismatch: expected ${expectedLimit}, found ${snapshot.limitBytes}`,
    );
  }
  const target = outputTarget(cwd, callId);
  if (snapshot.relativePath !== target.relativePath) {
    throw new Error(`Persisted tool output path does not match call ${callId}`);
  }
  const file = resolveWorkspacePath(cwd, snapshot.relativePath);
  await assertExistingPathInsideWorkspace(cwd, file, snapshot.relativePath);
  const info = await lstat(file.absolutePath);
  validatePrivateRegularFile(info, "Persisted tool output");
  if (info.size !== snapshot.bytes) {
    throw new Error(
      `Persisted tool output size mismatch: expected ${snapshot.bytes} bytes, found ${info.size}`,
    );
  }
  return trustedPersistedOutput({
    relativePath: target.relativePath,
    absolutePath: file.absolutePath,
    bytes: snapshot.bytes,
    originalBytes: snapshot.originalBytes,
    limitBytes: snapshot.limitBytes,
    truncated: snapshot.truncated,
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
    private readonly temporaryPath: string,
    private readonly handle: FileHandle,
    private readonly limitBytes: number,
  ) {}

  static async open(
    cwd: string,
    callId: ToolCallId,
    options: ToolOutputStorageOptions = {},
  ): Promise<StreamingToolOutputFile> {
    const target = await prepareOutputTarget(cwd, callId);
    const maxDirectoryBytes = options.maxDirectoryBytes ?? DEFAULT_MAX_PERSISTED_OUTPUT_DIRECTORY_BYTES;
    const limitBytes = effectiveOutputLimit(
      options.maxBytes ?? DEFAULT_MAX_PERSISTED_OUTPUT_BYTES,
      maxDirectoryBytes,
    );
    const reservationBytes = Number.isFinite(limitBytes) ? limitBytes : 0;
    const temporary = await withOutputDirectoryLock(target.directoryPath, async () => {
      await validateOutputTarget(cwd, target);
      await ensureSidecarDirectoryCapacity(target.directoryPath, reservationBytes, maxDirectoryBytes);
      return openTemporaryOutput(target, reservationBytes);
    });
    return new StreamingToolOutputFile(
      cwd,
      target,
      temporary.path,
      temporary.handle,
      limitBytes,
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
      await this.handle.writeFile(bounded, "utf8");
      this.persistedBytes += Buffer.byteLength(bounded, "utf8");
    });
    return this.writeQueue;
  }

  async close(): Promise<PersistedOutput> {
    if (this.closed) throw new Error("Tool output file is already closed");
    this.closed = true;
    try {
      await this.writeQueue;
      await this.handle.truncate(this.persistedBytes);
      await validateTemporaryHandle(this.handle);
      await this.handle.sync();
      await this.handle.close();
      await withOutputDirectoryLock(this.target.directoryPath, async () => {
        await validateOutputTarget(this.cwd, this.target);
        await rename(this.temporaryPath, this.target.absolutePath);
      });
    } catch (error) {
      await this.handle.close().catch(() => undefined);
      await unlink(this.temporaryPath).catch((unlinkError) => {
        if (!isNotFoundError(unlinkError)) throw unlinkError;
      });
      throw error;
    }
    return trustedPersistedOutput({
      relativePath: this.target.relativePath,
      absolutePath: this.target.absolutePath,
      bytes: this.persistedBytes,
      originalBytes: this.originalBytes,
      limitBytes: this.limitBytes,
      truncated: this.persistedBytes < this.originalBytes,
    });
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

interface TemporaryOutput {
  path: string;
  handle: FileHandle;
}

async function prepareOutputTarget(cwd: string, callId: ToolCallId): Promise<OutputTarget> {
  const target = outputTarget(cwd, callId);
  await assertWritablePathInsideWorkspace(cwd, {
    absolutePath: target.absolutePath,
    relativePath: target.relativePath,
  }, target.relativePath);
  await mkdir(target.directoryPath, { recursive: true });
  return target;
}

function outputTarget(cwd: string, callId: ToolCallId): OutputTarget {
  const relativeDirectory = join(".chili", "tool-results");
  const relativePath = join(relativeDirectory, toolResultFilename(callId));
  const directory = resolveWorkspacePath(cwd, relativeDirectory);
  const file = resolveWorkspacePath(cwd, relativePath);
  return {
    relativePath,
    absolutePath: file.absolutePath,
    directoryPath: directory.absolutePath,
  };
}

function validatePersistedOutputRegistration(registration: PersistedToolOutputRegistration): void {
  for (const [label, value] of [
    ["bytes", registration.bytes],
    ["originalBytes", registration.originalBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Persisted tool output ${label} must be a non-negative safe integer`);
    }
  }
  if (!(registration.limitBytes === Infinity
    || (Number.isSafeInteger(registration.limitBytes) && registration.limitBytes >= 0))) {
    throw new Error("Persisted tool output limitBytes must be a non-negative safe integer or Infinity");
  }
  if (registration.bytes > registration.originalBytes || registration.bytes > registration.limitBytes) {
    throw new Error("Persisted tool output byte counts are inconsistent");
  }
  if (registration.truncated !== (registration.bytes < registration.originalBytes)) {
    throw new Error("Persisted tool output truncated flag does not match its byte counts");
  }
}

function snapshotPersistedOutputRegistration(
  registration: PersistedToolOutputRegistration,
): PersistedToolOutputRegistration {
  return {
    relativePath: registration.relativePath,
    bytes: registration.bytes,
    originalBytes: registration.originalBytes,
    limitBytes: registration.limitBytes,
    truncated: registration.truncated,
  };
}

function trustedPersistedOutput(output: PersistedOutput): PersistedOutput {
  const frozen = Object.freeze(output);
  trustedPersistedOutputs.add(frozen);
  return frozen;
}

function isTrustedPersistedOutput(
  registration: PersistedToolOutputRegistration,
): boolean {
  return typeof registration === "object"
    && registration !== null
    && trustedPersistedOutputs.has(registration);
}

async function validateOutputTarget(cwd: string, target: OutputTarget): Promise<void> {
  const relativeDirectory = join(".chili", "tool-results");
  const directory = resolveWorkspacePath(cwd, relativeDirectory);
  const file = resolveWorkspacePath(cwd, target.relativePath);
  await assertExistingPathInsideWorkspace(cwd, directory, relativeDirectory);
  await assertWritablePathInsideWorkspace(cwd, file, target.relativePath);
}

async function openTemporaryOutput(target: OutputTarget, reservationBytes: number): Promise<TemporaryOutput> {
  const path = join(
    target.directoryPath,
    `.${basename(target.absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(
    path,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await validateTemporaryHandle(handle);
    await handle.truncate(reservationBytes);
    return { path, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

async function validateTemporaryHandle(handle: FileHandle): Promise<void> {
  const info = await handle.stat();
  if (!info.isFile() || info.nlink !== 1) {
    throw new Error("Tool output temporary file is not a private regular file");
  }
}

function toolResultFilename(callId: ToolCallId): string {
  const value = String(callId);
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && !value.includes("..")) {
    return `${value}.txt`;
  }
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `toolcall_${hash}.txt`;
}

async function ensureSidecarDirectoryCapacity(
  directory: string,
  incomingBytes: number,
  maxBytes: number,
): Promise<void> {
  if (maxBytes === Infinity) return;
  const entries = await readdir(directory, { withFileTypes: true });
  const files = (await Promise.all(entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".txt") || isTemporaryOutputName(entry.name)))
    .map(async (entry) => {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error(`Cannot safely account for tool output directory entry: ${entry.name}`);
      }
      return {
        path,
        bytes: info.size,
        modifiedAt: info.mtimeMs,
        temporary: isTemporaryOutputName(entry.name),
      };
    }))).filter((file) => file !== undefined);
  let totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  const effectiveLimit = Math.max(0, Math.trunc(maxBytes));
  const temporaryBytes = files.reduce(
    (total, file) => total + (file.temporary ? file.bytes : 0),
    0,
  );
  if (temporaryBytes + incomingBytes > effectiveLimit) {
    throw new Error(
      `Tool output directory byte budget exhausted: ${temporaryBytes} reserved + ${incomingBytes} requested > ${effectiveLimit}`,
    );
  }
  files.sort((left, right) => {
    if (left.temporary !== right.temporary) return left.temporary ? 1 : -1;
    return left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path);
  });
  for (const file of files) {
    if (totalBytes + incomingBytes <= effectiveLimit) break;
    if (file.temporary) continue;
    await unlink(file.path).catch((error) => {
      if (!isNotFoundError(error)) throw error;
    });
    totalBytes -= file.bytes;
  }
  if (totalBytes + incomingBytes > effectiveLimit) {
    throw new Error(
      `Tool output directory byte budget exhausted: ${totalBytes} existing + ${incomingBytes} requested > ${effectiveLimit}`,
    );
  }
}

function effectiveOutputLimit(maxBytes: number, maxDirectoryBytes: number): number {
  const outputLimit = maxBytes === Infinity ? Infinity : Math.max(0, Math.trunc(maxBytes));
  const directoryLimit = maxDirectoryBytes === Infinity
    ? Infinity
    : Math.max(0, Math.trunc(maxDirectoryBytes));
  return Math.min(outputLimit, directoryLimit);
}

function isTemporaryOutputName(name: string): boolean {
  return /^\..+\.txt\.\d+\.[0-9a-f-]{36}\.tmp$/i.test(name);
}

async function withFilesystemDirectoryLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const path = join(directory, FILESYSTEM_LOCK_FILENAME);
  const handle = await open(
    path,
    fsConstants.O_RDWR | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const [handleInfo, pathInfo] = await Promise.all([handle.stat(), lstat(path)]);
    validatePrivateRegularFile(handleInfo, "Tool output directory lock");
    if (pathInfo.dev !== handleInfo.dev || pathInfo.ino !== handleInfo.ino) {
      throw new Error("Tool output directory lock changed while opening");
    }
    await acquireFilesystemLock(handle.fd, directory);
    try {
      const lockedInfo = await lstat(path);
      if (lockedInfo.dev !== handleInfo.dev || lockedInfo.ino !== handleInfo.ino) {
        throw new Error("Tool output directory lock changed while acquiring");
      }
      return await operation();
    } finally {
      nativeFlock(handle.fd, LOCK_UNLOCK);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function acquireFilesystemLock(fd: number, directory: string): Promise<void> {
  const deadline = Date.now() + FILESYSTEM_LOCK_TIMEOUT_MS;
  while (nativeFlock(fd, LOCK_EXCLUSIVE | LOCK_NONBLOCKING) !== 0) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for tool output directory lock: ${directory}`);
    }
    await delay(FILESYSTEM_LOCK_RETRY_MS);
  }
}

interface NativeFileLockBackend {
  tryLock(fd: number): number;
  unlock(fd: number): number;
}

function loadNativeFileLockBackend(): NativeFileLockBackend {
  if (process.platform === "win32") {
    const library = dlopen("msvcrt.dll", {
      _locking: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    return {
      tryLock: (fd) => library.symbols._locking(fd, 2, 1),
      unlock: (fd) => library.symbols._locking(fd, 0, 1),
    };
  }

  const candidates = process.platform === "darwin"
    ? ["/usr/lib/libSystem.B.dylib"]
    : process.platform === "linux"
      ? linuxLibcCandidates()
      : [];
  for (const path of candidates) {
    try {
      const library = dlopen(path, {
        flock: {
          args: [FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
      });
      return {
        tryLock: (fd) => library.symbols.flock(fd, LOCK_EXCLUSIVE | LOCK_NONBLOCKING),
        unlock: (fd) => library.symbols.flock(fd, LOCK_UNLOCK),
      };
    } catch {
      // Try the next libc name; musl and glibc expose different loader paths.
    }
  }
  throw new Error(`Tool output directory locking is unsupported on ${process.platform}/${process.arch}`);
}

function linuxLibcCandidates(): string[] {
  const muslArch = process.arch === "x64"
    ? "x86_64"
    : process.arch === "arm64"
      ? "aarch64"
      : process.arch;
  return [
    "libc.so.6",
    "libc.so",
    `/lib/libc.musl-${muslArch}.so.1`,
    `/usr/lib/libc.musl-${muslArch}.so.1`,
    `/lib/ld-musl-${muslArch}.so.1`,
  ];
}

let nativeFileLockBackend: NativeFileLockBackend | undefined;

function nativeFlock(fd: number, operation: number): number {
  nativeFileLockBackend ??= loadNativeFileLockBackend();
  return operation === LOCK_UNLOCK
    ? nativeFileLockBackend.unlock(fd)
    : nativeFileLockBackend.tryLock(fd);
}

function validatePrivateRegularFile(
  info: Awaited<ReturnType<FileHandle["stat"]>>,
  label: string,
): void {
  const unsafePermissions = process.platform !== "win32" && (Number(info.mode) & 0o077) !== 0;
  if (!info.isFile() || info.nlink !== 1 || unsafePermissions) {
    throw new Error(`${label} is not a private regular file`);
  }
}

function withOutputDirectoryLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  return withSidecarDirectoryLock(directory, () => withFilesystemDirectoryLock(directory, operation));
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
