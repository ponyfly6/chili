import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFilePath, readFileContentVersion, sameFileVersion, type FileContentVersion } from "./file-read-state.js";

interface LockOwner {
  owner: string;
  pid: number;
}

let database: Promise<Database> | undefined;
const LOCK_TIMEOUT_MS = 30_000;
const pendingMutations = new Map<string, { version?: FileContentVersion | null }>();

/**
 * Cooperative file locks shared by every Chili executor on this machine/user.
 * No expiry can evict a live owner. SQLite serializes acquisition/reclamation;
 * only an ESRCH process check permits recovery after a hard process crash.
 * Editors and shell commands that do not use this API are outside this lock.
 */
export async function withFileOperationLocks<T>(
  paths: readonly string[],
  signal: AbortSignal,
  operation: () => Promise<T>,
  mutation?: { sessionId: string; authorize?: () => Promise<void> },
): Promise<T> {
  signal.throwIfAborted();
  const resources = [...new Set(await Promise.all(paths.map(canonicalFilePath)))].sort();
  const db = await lockDatabase();
  const owner = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (!tryAcquire(db, resources, owner)) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("Timed out waiting for an active file operation; no live owner was displaced.");
    await delay(10, signal);
  }
  try {
    signal.throwIfAborted();
    const current = [...new Set(await Promise.all(paths.map(canonicalFilePath)))].sort();
    if (current.length !== resources.length || current.some((path, index) => path !== resources[index])) {
      throw new Error("File resource changed while waiting for its operation lock. Retry with the current path.");
    }
    await mutation?.authorize?.();
    return mutation ? await withFileMutationJournal(resources, mutation.sessionId, operation) : await operation();
  } finally {
    // Cancellation never interrupts release. Acquisition transactions are short;
    // SQLite's busy timeout allows an in-flight writer to finish first.
    db.query("DELETE FROM file_operation_locks WHERE owner = ?").run(owner);
  }
}

function tryAcquire(db: Database, paths: readonly string[], owner: string): boolean {
  try {
    return db.transaction(() => {
      for (const path of paths) {
        const held = db.query<LockOwner, [string]>("SELECT owner, pid FROM file_operation_locks WHERE path = ?").get(path);
        if (!held) continue;
        if (!processHasExited(held.pid)) return false;
        db.query("DELETE FROM file_operation_locks WHERE path = ? AND owner = ?").run(path, held.owner);
      }
      const insert = db.query("INSERT INTO file_operation_locks (path, owner, pid) VALUES (?, ?, ?)");
      for (const path of paths) insert.run(path, owner, process.pid);
      return true;
    }).immediate();
  } catch (error) {
    if (isBusy(error)) return false;
    throw error;
  }
}

async function lockDatabase(): Promise<Database> {
  if (!database) database = openLockDatabase().catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

async function openLockDatabase(): Promise<Database> {
  const directory = join(tmpdir(), `chili-file-operation-locks-${process.getuid?.() ?? "user"}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
    throw new Error("File operation lock directory must be private and owned by the current user.");
  }
  const db = new Database(join(directory, "locks.sqlite"), { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec("CREATE TABLE IF NOT EXISTS file_operation_locks (path TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS file_mutation_clock (id INTEGER PRIMARY KEY CHECK (id = 1), epoch TEXT NOT NULL, revision INTEGER NOT NULL)");
    db.query("INSERT OR IGNORE INTO file_mutation_clock (id, epoch, revision) VALUES (1, ?, 0)").run(randomUUID());
    db.exec("CREATE TABLE IF NOT EXISTS file_mutation_heads (path TEXT PRIMARY KEY, revision INTEGER NOT NULL, session_id TEXT NOT NULL, version_json TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS file_mutation_sessions (path TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY (path, session_id))");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function processHasExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
  }
}

function isBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED");
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export interface FileMutationCheckpoint {
  epoch: string;
  revision: number;
  sessionId: string;
}

export async function fileMutationCheckpoint(sessionId: string): Promise<FileMutationCheckpoint> {
  const db = await lockDatabase();
  const clock = db.query<{ epoch: string; revision: number }, []>("SELECT epoch, revision FROM file_mutation_clock WHERE id = 1").get();
  if (!clock) throw new Error("File mutation history is unavailable");
  return { ...clock, sessionId };
}

/** Must be called while holding this path's operation lock. */
export async function assertFileMutationOwnership(
  path: string,
  checkpoint: FileMutationCheckpoint,
  before: FileContentVersion | null,
  current: FileContentVersion | null,
): Promise<void> {
  const db = await lockDatabase();
  const clock = await fileMutationCheckpoint(checkpoint.sessionId);
  if (clock.epoch !== checkpoint.epoch || clock.revision < checkpoint.revision) {
    throw new Error("Cannot safely restore this snapshot: its file change history is no longer available. Current files were preserved.");
  }
  const other = db.query<{ session_id: string }, [string, string, number]>(
    "SELECT session_id FROM file_mutation_sessions WHERE path = ? AND session_id != ? AND revision > ? LIMIT 1",
  ).get(path, checkpoint.sessionId, checkpoint.revision);
  if (other) {
    throw new Error(`Cannot safely restore ${path}: another session changed this file after the snapshot. Current files were preserved.`);
  }
  const head = db.query<{ revision: number; version_json: string }, [string]>(
    "SELECT revision, version_json FROM file_mutation_heads WHERE path = ?",
  ).get(path);
  const expected = head && head.revision > checkpoint.revision
    ? JSON.parse(head.version_json) as FileContentVersion | null : before;
  if (!sameOptionalVersion(expected, current)) {
    throw new Error(`Cannot safely restore ${path}: its current changes are not recorded for this session. Current files were preserved.`);
  }
}

export async function readOptionalFileVersion(path: string): Promise<FileContentVersion | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`File is not a regular file: ${path}`);
    return await readFileContentVersion(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readVersions(paths: readonly string[]): Promise<Map<string, FileContentVersion | null>> {
  return new Map(await Promise.all(paths.map(async (path) => [path, await readOptionalFileVersion(path)] as const)));
}

async function recordChanges(
  db: Database,
  paths: readonly string[],
  sessionId: string,
  before: Map<string, FileContentVersion | null>,
): Promise<void> {
  const after = await readVersions(paths);
  const changed = paths.filter((path) => {
    const owned = pendingMutations.get(path)?.version;
    // Never claim arbitrary external/Bash postimages observed after the operation.
    return owned !== undefined && sameOptionalVersion(owned, after.get(path) ?? null)
      && !sameOptionalVersion(before.get(path) ?? null, owned);
  });
  if (changed.length === 0) return;
  db.transaction(() => {
    db.exec("UPDATE file_mutation_clock SET revision = revision + 1 WHERE id = 1");
    const clock = db.query<{ revision: number }, []>("SELECT revision FROM file_mutation_clock WHERE id = 1").get();
    if (!clock) throw new Error("File mutation history is unavailable");
    for (const path of changed) {
      db.query("INSERT INTO file_mutation_heads (path, revision, session_id, version_json) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET revision = excluded.revision, session_id = excluded.session_id, version_json = excluded.version_json")
        .run(path, clock.revision, sessionId, JSON.stringify(after.get(path) ?? null));
      db.query("INSERT INTO file_mutation_sessions (path, session_id, revision) VALUES (?, ?, ?) ON CONFLICT(path, session_id) DO UPDATE SET revision = excluded.revision")
        .run(path, sessionId, clock.revision);
    }
  }).immediate();
}

function sameOptionalVersion(left: FileContentVersion | null, right: FileContentVersion | null): boolean {
  return left === null || right === null ? left === right : sameFileVersion(left, right);
}

/** Record a known postimage, not merely whatever happens to be on disk later. */
export async function recordOwnedFileVersion(path: string, expectedContentHash: string | null): Promise<void> {
  const resource = await canonicalFilePath(path);
  const pending = pendingMutations.get(resource);
  if (!pending) return;
  const current = await readOptionalFileVersion(resource);
  if ((current?.contentHash ?? null) !== expectedContentHash) {
    throw new Error(`File changed while recording its modification: ${path}. Current contents cannot be attributed to this operation.`);
  }
  pending.version = current;
}

/** The caller already holds the resource locks and has validated access. */
export async function withFileMutationJournal<T>(paths: readonly string[], sessionId: string, operation: () => Promise<T>): Promise<T> {
  const db = await lockDatabase();
  const resources = [...new Set(await Promise.all(paths.map(canonicalFilePath)))];
  const before = await readVersions(resources);
  for (const path of resources) pendingMutations.set(path, {});
  try {
    return await operation();
  } finally {
    try { await recordChanges(db, resources, sessionId, before); }
    finally { for (const path of resources) pendingMutations.delete(path); }
  }
}
