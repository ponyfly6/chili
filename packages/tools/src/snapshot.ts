import { assertFileMutationOwnership, fileMutationCheckpoint, readOptionalFileVersion, recordOwnedFileVersion, withFileMutationJournal, withFileOperationLocks, type FileMutationCheckpoint } from "./file-operation-lock.js";
import { readFileContentVersion, sameFileVersion, type FileContentVersion } from "./file-read-state.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { timestampNow, type SnapshotId, type TimestampMs } from "@chili/protocol";
import type { SnapshotCreateRequest, SnapshotProvider, SnapshotRecord, SnapshotRevertOptions, SnapshotRevertResult } from "./types.js";

const SNAPSHOT_VERSION = 3 as const;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_PATTERN_COUNT = 2_048;
const MAX_SNAPSHOT_ENTRIES = 1_024;
const MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_ID_PATTERN = /^snapshot_[A-Za-z0-9_-]{1,120}$/u;
const BACKUP_NAME_PATTERN = /^[0-9]+\.blob$/u;

interface SnapshotManifest {
  version: 2 | typeof SNAPSHOT_VERSION;
  ownership?: FileMutationCheckpoint;
  id: SnapshotId;
  cwd: string;
  createdAt: TimestampMs;
  reason: string;
  entries: SnapshotEntry[];
}

type SnapshotEntry = RegularSnapshotEntry | MissingSnapshotEntry;

interface RegularSnapshotEntry {
  relativePath: string;
  kind: "regular";
  existed: true;
  backupName: string;
  mode: 0o100644 | 0o100755;
  beforeVersion?: FileContentVersion;
}

interface MissingSnapshotEntry {
  relativePath: string;
  kind: "missing";
  existed: false;
}

interface CollectedRegularEntry extends Omit<RegularSnapshotEntry, "backupName"> {
  path: string;
  device: number | bigint;
  inode: number | bigint;
  size: number;
}

type CollectedEntry = CollectedRegularEntry | MissingSnapshotEntry;

interface SecureFile {
  path: string;
  handle: FileHandle;
  device: number | bigint;
  inode: number | bigint;
  size: number;
}

export interface FileSystemSnapshotProviderOptions {
  rootDir?: string;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
}

export class FileSystemSnapshotProvider implements SnapshotProvider {
  private readonly cwdBySnapshot = new Map<SnapshotId, string>();

  constructor(private readonly options: FileSystemSnapshotProviderOptions = {}) {}

  async create(request: SnapshotCreateRequest): Promise<SnapshotRecord | undefined> {
    const cwd = await canonicalDirectory(request.cwd, "snapshot cwd");
    if (request.patterns.length > MAX_PATTERN_COUNT) throw new Error(`Snapshot has too many patterns (maximum ${MAX_PATTERN_COUNT})`);
    const paths = request.patterns.map((pattern) => resolvePattern(cwd, pattern))
      .filter((path): path is string => path !== undefined).map((path) => resolve(cwd, path));
    return withFileOperationLocks(paths, request.signal ?? new AbortController().signal, () => this.createLocked({ ...request, cwd }));
  }

  private async createLocked(request: SnapshotCreateRequest): Promise<SnapshotRecord | undefined> {
    await request.assertCurrentAuthorization?.();
    request.signal?.throwIfAborted();
    const cwd = await canonicalDirectory(request.cwd, "snapshot cwd");
    const entries = await this.collectEntries(cwd, request.patterns);
    if (entries.length === 0) return undefined;

    const id = this.id<SnapshotId>("snapshot");
    let root: string | undefined;
    let snapshotDir: string | undefined;
    let createdSnapshotDir = false;
    try {
      requireSnapshotId(id);
      root = await this.prepareRoot(cwd);
      snapshotDir = join(root, id);
      await assertSecureDirectory(root, "snapshot root");
      await mkdir(snapshotDir, { mode: 0o700 });
      createdSnapshotDir = true;
      await assertSecureDirectory(snapshotDir, "snapshot directory");
      const manifest: SnapshotManifest = {
        version: SNAPSHOT_VERSION,
        id,
        cwd,
        createdAt: this.now(),
        reason: request.reason,
        ownership: await fileMutationCheckpoint(request.sessionId),
        entries: [],
      };

      for (const [index, entry] of entries.entries()) {
        await request.assertCurrentAuthorization?.();
        request.signal?.throwIfAborted();
        if (entry.kind === "regular") {
          const backupName = `${index}.blob`;
          const beforeVersion = await readFileContentVersion(entry.path);
          await assertSecureDirectory(snapshotDir, "snapshot directory");
          const source = await openSecureRegularFile(entry.path, "snapshot source");
          try {
            if (!sameIdentity(entry, source) || source.size !== entry.size) {
              throw new Error(`Snapshot source changed before backup: ${entry.relativePath}`);
            }
            await copySecureFile(source, join(snapshotDir, backupName), MAX_SNAPSHOT_FILE_BYTES);
          } finally {
            await source.handle.close();
          }
          if (!sameFileVersion(beforeVersion, await readFileContentVersion(entry.path))
            || (await readFileContentVersion(join(snapshotDir, backupName))).contentHash !== beforeVersion.contentHash) {
            throw new Error(`Snapshot source changed during backup: ${entry.relativePath}`);
          }
          manifest.entries.push({
            beforeVersion,
            relativePath: entry.relativePath,
            kind: "regular",
            existed: true,
            backupName,
            mode: entry.mode,
          });
        } else {
          manifest.entries.push(entry);
        }
      }

      request.signal?.throwIfAborted();
      await writeExclusiveRegularFile(
        join(snapshotDir, "manifest.json"),
        Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
      );
      await assertSecureDirectory(snapshotDir, "snapshot directory");
      this.cwdBySnapshot.set(id, cwd);
      return {
        id,
        cwd,
        paths: manifest.entries.map((entry) => entry.relativePath),
        createdAt: manifest.createdAt,
      };
    } catch (error) {
      if (createdSnapshotDir && root && snapshotDir) await removePartialSnapshot(root, snapshotDir);
      throw error;
    }
  }

  async revert(snapshotId: SnapshotId, options: SnapshotRevertOptions = {}): Promise<SnapshotRevertResult> {
    requireSnapshotId(snapshotId);
    const { manifest, snapshotDir } = await this.readManifest(snapshotId, options.cwd);
    const paths = manifest.entries.map((entry) => resolve(manifest.cwd, entry.relativePath));
    const signal = options.signal ?? new AbortController().signal;
    return withFileOperationLocks(paths, signal, async () => {
      const backupSizes = await validateSnapshotBackups(manifest, snapshotDir);
      const expected = new Map<string, FileContentVersion | null>();
      const backupHashes = new Map<string, string>();
      const unchanged = new Set<string>();
      // Validate every target before changing any target. A later conflict must
      // not cause a partially applied rollback of earlier, unrelated files.
      for (const entry of manifest.entries) {
        signal.throwIfAborted();
        const target = resolve(manifest.cwd, entry.relativePath);
        assertContained(manifest.cwd, target, "snapshot target");
        await assertSafeAncestors(manifest.cwd, entry.relativePath);
        await assertSafeTarget(target);
        const current = await readOptionalFileVersion(target);
        expected.set(target, current);
        if (entry.kind === "regular") {
          const backup = await readFileContentVersion(join(snapshotDir, entry.backupName));
          if (entry.beforeVersion && backup.contentHash !== entry.beforeVersion.contentHash) {
            throw new Error(`Snapshot backup content changed: ${entry.relativePath}`);
          }
          backupHashes.set(target, backup.contentHash);
          if (current?.contentHash === backup.contentHash && normalizeRegularMode((await lstat(target)).mode) === entry.mode) {
            unchanged.add(target);
            continue;
          }
        } else if (current === null) {
          unchanged.add(target);
          continue;
        }
        if (!manifest.ownership || (entry.kind === "regular" && !entry.beforeVersion)) {
          throw new Error(`Cannot safely restore ${entry.relativePath}: this older snapshot has no record of who changed the file. Current files were preserved.`);
        }
        await assertFileMutationOwnership(target, manifest.ownership, entry.kind === "regular" ? entry.beforeVersion! : null, current);
      }

      const apply = async (): Promise<SnapshotRevertResult> => {
        const restored: string[] = [];
        const removed: string[] = [];
        for (const entry of manifest.entries) {
          signal.throwIfAborted();
          const target = resolve(manifest.cwd, entry.relativePath);
          await assertExpectedTargetVersion(target, expected.get(target) ?? null);
          if (!unchanged.has(target)) {
            if (entry.kind === "regular") {
              await ensureSecureDirectory(dirname(target), manifest.cwd, "snapshot target parent");
              await assertSafeTarget(target);
              const backupPath = join(snapshotDir, entry.backupName);
              assertContained(snapshotDir, backupPath, "snapshot backup");
              await assertSecureDirectory(snapshotDir, "snapshot directory");
              const backup = await openSecureRegularFile(backupPath, "snapshot backup");
              try {
                if (backup.size !== backupSizes.get(entry.backupName)) {
                  throw new Error(`Snapshot backup changed before restore: ${entry.backupName}`);
                }
                const backupHash = backupHashes.get(target)!;
                await restoreSecureFile(backup, target, entry.mode, MAX_SNAPSHOT_FILE_BYTES, expected.get(target) ?? null, backupHash, signal);
                await recordOwnedFileVersion(target, backupHash);
              } finally {
                await backup.handle.close();
              }
            } else {
              await assertSafeAncestors(manifest.cwd, entry.relativePath);
              await assertExpectedTargetVersion(target, expected.get(target) ?? null);
              signal.throwIfAborted();
              if (expected.get(target) !== null) await unlink(target);
              await recordOwnedFileVersion(target, null);
            }
          }
          if (entry.kind === "regular") restored.push(entry.relativePath);
          else removed.push(entry.relativePath);
        }
        return { snapshotId, paths: manifest.entries.map((entry) => entry.relativePath), restored, removed };
      };
      return manifest.ownership ? withFileMutationJournal(paths, manifest.ownership.sessionId, apply) : apply();
    });
  }

  private async collectEntries(cwd: string, patterns: string[]): Promise<CollectedEntry[]> {
    if (patterns.length > MAX_PATTERN_COUNT) throw new Error(`Snapshot has too many patterns (maximum ${MAX_PATTERN_COUNT})`);
    const entries = new Map<string, CollectedEntry>();
    let totalBytes = 0;
    for (const pattern of patterns) {
      const relativePath = resolvePattern(cwd, pattern);
      if (!relativePath || entries.has(relativePath)) continue;
      if (entries.size >= MAX_SNAPSHOT_ENTRIES) {
        throw new Error(`Snapshot has too many entries (maximum ${MAX_SNAPSHOT_ENTRIES})`);
      }

      const ancestorsExist = await assertSafeAncestors(cwd, relativePath);
      if (!ancestorsExist) {
        entries.set(relativePath, { relativePath, kind: "missing", existed: false });
        continue;
      }

      const absolutePath = resolve(cwd, relativePath);
      const info = await lstat(absolutePath).catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      });
      if (!info) {
        entries.set(relativePath, { relativePath, kind: "missing", existed: false });
        continue;
      }
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Snapshot source is not a regular file: ${relativePath}`);
      }
      if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error(`Snapshot source has an invalid size: ${relativePath}`);
      if (info.size > MAX_SNAPSHOT_FILE_BYTES) {
        throw new Error(`Snapshot source exceeds ${MAX_SNAPSHOT_FILE_BYTES} bytes: ${relativePath}`);
      }
      totalBytes += info.size;
      if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
        throw new Error(`Snapshot exceeds ${MAX_SNAPSHOT_TOTAL_BYTES} total bytes`);
      }
      entries.set(relativePath, {
        relativePath,
        kind: "regular",
        existed: true,
        path: absolutePath,
        device: info.dev,
        inode: info.ino,
        size: info.size,
        mode: normalizeRegularMode(info.mode),
      });
    }
    return [...entries.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private async readManifest(
    snapshotId: SnapshotId,
    requestedCwd?: string,
  ): Promise<{ manifest: SnapshotManifest; snapshotDir: string }> {
    const candidateCwd = requestedCwd !== undefined
      ? await canonicalDirectory(requestedCwd, "snapshot cwd")
      : this.cwdBySnapshot.get(snapshotId) ?? await canonicalDirectory(process.cwd(), "snapshot cwd");
    const root = await this.resolveRoot(candidateCwd, false);
    const snapshotDir = join(root, snapshotId);
    await assertSecureDirectory(root, "snapshot root");
    await assertSecureDirectory(snapshotDir, "snapshot directory");
    const manifestPath = join(snapshotDir, "manifest.json");
    const manifest = await this.tryReadManifest(manifestPath, snapshotId).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (!manifest) throw new Error(`Snapshot not found: ${snapshotId}`);
    if (manifest.cwd !== candidateCwd) throw new Error("Snapshot manifest cwd does not match the requested workspace");
    const canonicalManifestCwd = await canonicalDirectory(manifest.cwd, "snapshot manifest cwd");
    if (canonicalManifestCwd !== manifest.cwd) throw new Error("Snapshot manifest cwd is not canonical");
    const expectedRoot = await this.resolveRoot(manifest.cwd, false);
    if (expectedRoot !== root) throw new Error("Snapshot manifest is outside its configured root");
    return { manifest, snapshotDir };
  }

  private async tryReadManifest(path: string, snapshotId: SnapshotId): Promise<SnapshotManifest> {
    const file = await openSecureRegularFile(path, "snapshot manifest");
    try {
      const info = await file.handle.stat();
      if (info.size > MAX_MANIFEST_BYTES) throw new Error("Snapshot manifest is too large");
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.handle.readFile("utf8")) as unknown;
      } catch {
        throw new Error("Snapshot manifest is not valid JSON");
      }
      return validateManifest(parsed, snapshotId);
    } finally {
      await file.handle.close();
    }
  }

  private async prepareRoot(cwd: string): Promise<string> {
    const root = await this.resolveRoot(cwd, true);
    await ensureSecureDirectory(root, undefined, "snapshot root");
    return root;
  }

  private async resolveRoot(cwd: string, allowMissing: boolean): Promise<string> {
    const configured = this.options.rootDir ?? ".chili/snapshots";
    if (!isAbsolute(configured)) {
      const root = resolve(cwd, configured);
      assertContained(cwd, root, "snapshot root");
      if (!allowMissing) await assertSecureDirectory(root, "snapshot root");
      return root;
    }
    const canonical = await canonicalizeProspectivePath(resolve(configured));
    if (!allowMissing) await assertSecureDirectory(canonical, "snapshot root");
    return canonical;
  }

  private id<T extends string>(prefix: string): T {
    return (this.options.createId ?? defaultCreateId)(prefix) as T;
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

function resolvePattern(cwd: string, pattern: string): string | undefined {
  if (pattern.includes("*")) return undefined;
  if (pattern.includes("\n") || pattern.includes("\0") || pattern.trim().length === 0) {
    throw new Error("Unsafe snapshot pattern");
  }
  const rel = relative(cwd, resolve(cwd, pattern));
  if (!isSafeRelativePath(rel)) throw new Error(`Unsafe snapshot pattern: ${pattern}`);
  return rel;
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0
    && !isAbsolute(path)
    && !path.includes("\\")
    && !path.includes("\0")
    && normalize(path) === path
    && !path.split(sep).some((part) => part.length === 0 || part === "." || part === "..");
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const info = await lstat(canonical);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is not a directory`);
  return canonical;
}

async function canonicalizeProspectivePath(path: string): Promise<string> {
  const requested = normalizeMacSystemAlias(resolve(path));
  const root = parse(requested).root;
  const parts = relative(root, requested).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error("Snapshot root contains a symbolic link");
    if (!info.isDirectory()) throw new Error("Snapshot root ancestor is not a directory");
  }
  return requested;
}

async function ensureSecureDirectory(path: string, containmentRoot: string | undefined, label: string): Promise<void> {
  const target = resolve(path);
  if (containmentRoot !== undefined) assertContained(containmentRoot, target, label);
  const root = parse(target).root;
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (!info) {
      await mkdir(current, { mode: 0o700 });
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error(`${label} is not a secure directory`);
    } else if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${label} contains a non-directory or symbolic link`);
    }
  }
  await assertSecureDirectory(target, label);
}

async function assertSecureDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is not a secure directory`);
  if (await realpath(path) !== resolve(path)) throw new Error(`${label} contains a symbolic link`);
}

async function assertSafeAncestors(cwd: string, relativePath: string): Promise<boolean> {
  if (!isSafeRelativePath(relativePath)) throw new Error(`Unsafe snapshot path: ${relativePath}`);
  const parts = relativePath.split(sep);
  let current = cwd;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await lstat(current).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (!info) return false;
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(current) !== current) {
      throw new Error(`Snapshot path ancestor is unsafe (symbolic link or non-directory): ${relativePath}`);
    }
  }
  return true;
}

async function assertSafeTarget(path: string): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error(`Snapshot target is not a regular file: ${path}`);
}

async function openSecureRegularFile(path: string, label: string): Promise<SecureFile> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} is not a regular file`);
  if (await realpath(path) !== resolve(path)) throw new Error(`${label} contains a symbolic link`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const after = await lstat(path);
    const expected = identity(before);
    if (!opened.isFile()
      || !Number.isSafeInteger(opened.size)
      || opened.size < 0
      || await realpath(path) !== resolve(path)
      || !sameIdentity(expected, identity(opened))
      || !sameIdentity(expected, identity(after))) {
      throw new Error(`${label} changed while it was opened`);
    }
    return { path, handle, device: opened.dev, inode: opened.ino, size: opened.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function copySecureFile(source: SecureFile, destination: string, maxBytes: number): Promise<void> {
  await assertOpenFileIdentity(source, "snapshot source");
  if (source.size > maxBytes) throw new Error(`Snapshot source exceeds ${maxBytes} bytes`);
  const handle = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("Snapshot destination is not a regular file");
    await copyOpenFileContents(source.handle, handle, maxBytes);
    await assertOpenFileIdentity(source, "snapshot source");
    const after = await lstat(destination);
    if (!sameIdentity(identity(opened), identity(after)) || after.isSymbolicLink() || !after.isFile()) {
      throw new Error("Snapshot destination changed while it was written");
    }
  } finally {
    await handle.close();
  }
}

async function writeExclusiveRegularFile(path: string, content: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("Snapshot destination is not a regular file");
    await handle.writeFile(content);
    const after = await lstat(path);
    if (!sameIdentity(identity(opened), identity(after)) || after.isSymbolicLink() || !after.isFile()) {
      throw new Error("Snapshot destination changed while it was written");
    }
  } finally {
    await handle.close();
  }
}

async function validateSnapshotBackups(
  manifest: SnapshotManifest,
  snapshotDir: string,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    if (entry.kind !== "regular") continue;
    await assertSecureDirectory(snapshotDir, "snapshot directory");
    const backupPath = join(snapshotDir, entry.backupName);
    assertContained(snapshotDir, backupPath, "snapshot backup");
    const backup = await openSecureRegularFile(backupPath, "snapshot backup");
    try {
      if (backup.size > MAX_SNAPSHOT_FILE_BYTES) {
        throw new Error(`Snapshot backup exceeds ${MAX_SNAPSHOT_FILE_BYTES} bytes: ${entry.backupName}`);
      }
      totalBytes += backup.size;
      if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
        throw new Error(`Snapshot backups exceed ${MAX_SNAPSHOT_TOTAL_BYTES} total bytes`);
      }
      sizes.set(entry.backupName, backup.size);
    } finally {
      await backup.handle.close();
    }
  }
  return sizes;
}

async function restoreSecureFile(
  source: SecureFile,
  target: string,
  mode: 0o100644 | 0o100755,
  maxBytes: number,
  expectedTarget: FileContentVersion | null,
  expectedBackupHash: string,
  signal: AbortSignal,
): Promise<void> {
  await assertOpenFileIdentity(source, "snapshot backup");
  if (source.size > maxBytes) throw new Error(`Snapshot backup exceeds ${maxBytes} bytes`);
  const before = await lstat(target).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (before && (before.isSymbolicLink() || !before.isFile())) throw new Error("Snapshot target is not a regular file");
  const parent = dirname(target);
  if (await realpath(parent) !== resolve(parent)) throw new Error("Snapshot target parent contains a symbolic link");
  const temporary = join(parent, `.chili-snapshot-restore-${globalThis.crypto.randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let temporaryExists = true;
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("Snapshot restore temporary is not a regular file");
    await copyOpenFileContents(source.handle, handle, maxBytes);
    await assertOpenFileIdentity(source, "snapshot backup");
    await handle.chmod(mode & 0o777);
    const temporaryInfo = await lstat(temporary);
    if (!sameIdentity(identity(opened), identity(temporaryInfo)) || temporaryInfo.isSymbolicLink() || !temporaryInfo.isFile()) {
      throw new Error("Snapshot restore temporary changed while it was written");
    }
    await handle.sync();
    await handle.close();

    if (await realpath(parent) !== resolve(parent)) throw new Error("Snapshot target parent contains a symbolic link");
    const current = await lstat(target).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (before) {
      if (!current || current.isSymbolicLink() || !current.isFile() || !sameIdentity(identity(before), identity(current))) {
        throw new Error("Snapshot target changed before it was restored");
      }
    } else if (current) {
      throw new Error("Snapshot target appeared before it was restored");
    }
    if ((await readFileContentVersion(temporary)).contentHash !== expectedBackupHash) {
      throw new Error("Snapshot backup contents changed before restore");
    }
    await assertExpectedTargetVersion(target, expectedTarget);
    signal.throwIfAborted();
    await rename(temporary, target);
    temporaryExists = false;
  } finally {
    await handle.close().catch(() => undefined);
    if (temporaryExists) await unlink(temporary).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

async function copyOpenFileContents(source: FileHandle, destination: FileHandle, maxBytes: number): Promise<void> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return;
    if (position + bytesRead > maxBytes) throw new Error(`Snapshot file exceeds ${maxBytes} bytes while copying`);
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written, position + written);
      if (result.bytesWritten === 0) throw new Error("Snapshot copy made no progress");
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
}

async function assertOpenFileIdentity(file: SecureFile, label: string): Promise<void> {
  const opened = await file.handle.stat();
  const pathInfo = await lstat(file.path);
  const expected = { device: file.device, inode: file.inode };
  if (!opened.isFile() || pathInfo.isSymbolicLink() || !pathInfo.isFile()
    || opened.size !== file.size || pathInfo.size !== file.size
    || !sameIdentity(expected, identity(opened)) || !sameIdentity(expected, identity(pathInfo))) {
    throw new Error(`${label} changed while it was read`);
  }
}

async function removePartialSnapshot(root: string, snapshotDir: string): Promise<void> {
  assertContained(root, snapshotDir, "partial snapshot");
  const info = await lstat(snapshotDir).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (!info) return;
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Refusing to clean an unsafe partial snapshot");
  await rm(snapshotDir, { recursive: true, force: true });
}

function validateManifest(value: unknown, requestedId: SnapshotId): SnapshotManifest {
  if (!isRecord(value)
    || (value.version !== 2 && value.version !== SNAPSHOT_VERSION)
    || typeof value.id !== "string"
    || value.id !== requestedId
    || typeof value.cwd !== "string"
    || typeof value.createdAt !== "number"
    || !Number.isSafeInteger(value.createdAt)
    || typeof value.reason !== "string"
    || !Array.isArray(value.entries)
    || value.entries.length > MAX_SNAPSHOT_ENTRIES) {
    throw new Error("Invalid snapshot manifest");
  }
  requireSnapshotId(value.id);
  if (value.version === SNAPSHOT_VERSION && !validOwnership(value.ownership)) {
    throw new Error("Snapshot manifest has invalid modification ownership");
  }
  const paths = new Set<string>();
  const backups = new Set<string>();
  const entries: SnapshotEntry[] = value.entries.map((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.relativePath !== "string"
      || !isSafeRelativePath(candidate.relativePath)
      || (candidate.kind !== "regular" && candidate.kind !== "missing")
      || typeof candidate.existed !== "boolean") {
      throw new Error("Invalid snapshot manifest entry");
    }
    if (paths.has(candidate.relativePath)) throw new Error("Snapshot manifest contains duplicate paths");
    paths.add(candidate.relativePath);
    if (candidate.kind === "regular") {
      if (candidate.existed !== true
        || typeof candidate.backupName !== "string"
        || !BACKUP_NAME_PATTERN.test(candidate.backupName)
        || (candidate.mode !== 0o100644 && candidate.mode !== 0o100755)) {
        throw new Error("Snapshot regular entry is inconsistent");
      }
      if (value.version === SNAPSHOT_VERSION && !validFileVersion(candidate.beforeVersion)) {
        throw new Error("Snapshot regular entry has no valid content version");
      }
      if (backups.has(candidate.backupName)) throw new Error("Snapshot manifest contains duplicate backups");
      backups.add(candidate.backupName);
      return {
        relativePath: candidate.relativePath,
        kind: "regular",
        existed: true,
        backupName: candidate.backupName,
        mode: candidate.mode,
        ...(validFileVersion(candidate.beforeVersion) ? { beforeVersion: candidate.beforeVersion } : {}),
      };
    }
    if (candidate.existed !== false || candidate.backupName !== undefined || candidate.mode !== undefined) {
      throw new Error("Snapshot missing entry is inconsistent");
    }
    return { relativePath: candidate.relativePath, kind: "missing", existed: false };
  });
  return {
    version: value.version as SnapshotManifest["version"],
    ...(validOwnership(value.ownership) ? { ownership: value.ownership } : {}),
    id: value.id as SnapshotId,
    cwd: value.cwd,
    createdAt: value.createdAt as TimestampMs,
    reason: value.reason,
    entries,
  };
}

function requireSnapshotId(value: string): void {
  if (!SNAPSHOT_ID_PATTERN.test(value)) throw new Error("Invalid snapshot id");
}

function normalizeRegularMode(mode: number): 0o100644 | 0o100755 {
  return (mode & 0o111) === 0 ? 0o100644 : 0o100755;
}

function normalizeMacSystemAlias(path: string): string {
  if (process.platform !== "darwin") return path;
  if (path === "/var") return "/private/var";
  if (path.startsWith("/var/")) return `/private${path}`;
  if (path === "/tmp") return "/private/tmp";
  if (path.startsWith("/tmp/")) return `/private${path}`;
  return path;
}

function assertContained(root: string, target: string, label: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error(`${label} escapes its root`);
}

function identity(info: { dev: number | bigint; ino: number | bigint }): { device: number | bigint; inode: number | bigint } {
  return { device: info.dev, inode: info.ino };
}

function sameIdentity(
  left: { device: number | bigint; inode: number | bigint },
  right: { device: number | bigint; inode: number | bigint },
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

async function assertExpectedTargetVersion(path: string, expected: FileContentVersion | null): Promise<void> {
  const current = await readOptionalFileVersion(path);
  if (current === null || expected === null ? current !== expected : !sameFileVersion(current, expected)) {
    throw new Error(`Snapshot target changed before restore: ${path}. Current files were preserved where not already restored.`);
  }
}

function validOwnership(value: unknown): value is FileMutationCheckpoint {
  return isRecord(value) && typeof value.epoch === "string" && value.epoch.length > 0
    && typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0
    && typeof value.sessionId === "string" && value.sessionId.length > 0;
}

function validFileVersion(value: unknown): value is FileContentVersion {
  return isRecord(value) && typeof value.contentHash === "string" && /^[a-f0-9]{64}$/.test(value.contentHash)
    && ["size", "mtimeMs", "ctimeMs", "dev", "ino"].every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));
}
