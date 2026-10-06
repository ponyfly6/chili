import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

export interface FileContentVersion {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  contentHash: string;
}

export interface FileReadSnapshot extends FileContentVersion {
  cwd: string;
  absolutePath: string;
  relativePath: string;
  sessionId?: string;
}

export interface FileReadRangeSnapshot extends FileReadSnapshot {
  content: string;
  offset?: number;
  limit?: number;
}

interface FileReadRecord {
  full?: FileReadSnapshot;
  ranges: FileReadRangeSnapshot[];
}

export interface FileReadStateStoreOptions {
  maxRecords?: number;
  maxRangeContentBytes?: number;
}

interface SharedFileReadState {
  records: Map<string, FileReadRecord>;
  rangeContentBytes: number;
}

const DEFAULT_MAX_RECORDS = 100;
const DEFAULT_MAX_RANGE_CONTENT_BYTES = 25 * 1024 * 1024;

/** Observations belong to one session and canonical workspace, never to an executor. */
export class FileReadStateStore {
  private readonly maxRecords: number;
  private readonly maxRangeContentBytes: number;

  constructor(
    private readonly options: FileReadStateStoreOptions = {},
    private readonly shared: SharedFileReadState = { records: new Map(), rangeContentBytes: 0 },
    private readonly sessionId?: string,
  ) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxRangeContentBytes = options.maxRangeContentBytes ?? DEFAULT_MAX_RANGE_CONTENT_BYTES;
  }

  forSession(sessionId: string): FileReadStateStore {
    if (!sessionId) throw new Error("File observation requires a session identity");
    return new FileReadStateStore(this.options, this.shared, sessionId);
  }

  async recordTextRead(
    cwd: string,
    absolutePath: string,
    content: string,
    observedVersion?: FileContentVersion,
  ): Promise<FileReadSnapshot> {
    const [workspace, target] = await canonicalIdentity(cwd, absolutePath);
    const version = await readFileContentVersion(target);
    if ((observedVersion && !sameFileVersion(observedVersion, version)) || hash(content) !== version.contentHash) {
      throw changedDuringRead(this.relativePath(workspace, target));
    }
    const snapshot = this.snapshot(workspace, target, version);
    const record = this.record(workspace, target);
    this.discardRanges(record);
    record.full = snapshot;
    this.enforceLimits();
    return snapshot;
  }

  async recordTextRangeRead(
    cwd: string,
    absolutePath: string,
    content: string,
    range: { offset?: number; limit?: number } = {},
    observedVersion?: FileContentVersion,
  ): Promise<FileReadRangeSnapshot> {
    const [workspace, target] = await canonicalIdentity(cwd, absolutePath);
    const version = await readFileContentVersion(target);
    if (observedVersion && !sameFileVersion(observedVersion, version)) {
      throw changedDuringRead(this.relativePath(workspace, target));
    }
    const snapshot: FileReadRangeSnapshot = {
      ...this.snapshot(workspace, target, version),
      content,
      ...range,
    };
    const record = this.record(workspace, target);
    const previous = record.full ?? record.ranges[0];
    if (previous && !sameFileVersion(previous, version)) {
      delete record.full;
      this.discardRanges(record);
    }
    record.ranges.push(snapshot);
    this.shared.rangeContentBytes += contentByteLength(snapshot);
    this.enforceLimits();
    return snapshot;
  }

  async assertFresh(cwd: string, absolutePath: string): Promise<FileReadSnapshot> {
    const [workspace, target] = await canonicalIdentity(cwd, absolutePath);
    const key = this.key(workspace, target);
    const record = this.shared.records.get(key);
    if (record) this.touch(key, record);
    const snapshot = record?.full;
    const relativePath = this.relativePath(workspace, target);
    if (!snapshot) {
      throw new Error(`Read ${relativePath} before modifying it so the edit is based on current contents.`);
    }
    // Size and timestamps alone are not a content version (editors may restore mtime).
    const current = await readFileContentVersion(target);
    if (!sameFileVersion(snapshot, current)) {
      throw new Error(`File changed since it was read: ${relativePath}. Read it again before modifying.`);
    }
    return snapshot;
  }

  async assertObservedText(cwd: string, absolutePath: string, text: string): Promise<FileReadSnapshot | FileReadRangeSnapshot> {
    if (text.length === 0) return this.assertFresh(cwd, absolutePath);
    const [workspace, target] = await canonicalIdentity(cwd, absolutePath);
    const relativePath = this.relativePath(workspace, target);
    const key = this.key(workspace, target);
    const record = this.shared.records.get(key);
    if (!record) {
      throw new Error(`Read ${relativePath} before modifying it so the edit is based on current contents.`);
    }
    this.touch(key, record);
    if (record.full) return this.assertFresh(workspace, target);
    const snapshot = record.ranges.find((range) => includesNormalized(range.content, text));
    if (!snapshot) throw new Error(`Read the target text in ${relativePath} before modifying it.`);
    if (!sameFileVersion(snapshot, await readFileContentVersion(target))) {
      throw new Error(`File changed since the target text was read: ${relativePath}. Read it again before modifying.`);
    }
    return snapshot;
  }

  async forget(cwd: string, absolutePath: string): Promise<void> {
    const [workspace, target] = await canonicalIdentity(cwd, absolutePath);
    this.deleteRecord(this.key(workspace, target));
  }

  clear(): void {
    if (this.sessionId === undefined) {
      this.shared.records.clear();
      this.shared.rangeContentBytes = 0;
      return;
    }
    const prefix = `${JSON.stringify(this.sessionId)}\0`;
    for (const key of this.shared.records.keys()) {
      if (key.startsWith(prefix)) this.deleteRecord(key);
    }
  }

  private snapshot(cwd: string, absolutePath: string, version: FileContentVersion): FileReadSnapshot {
    return {
      ...version,
      cwd,
      absolutePath,
      relativePath: this.relativePath(cwd, absolutePath),
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
    };
  }

  private record(cwd: string, absolutePath: string): FileReadRecord {
    const key = this.key(cwd, absolutePath);
    const existing = this.shared.records.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing;
    }
    const next: FileReadRecord = { ranges: [] };
    this.shared.records.set(key, next);
    return next;
  }

  private touch(key: string, record: FileReadRecord): void {
    this.shared.records.delete(key);
    this.shared.records.set(key, record);
  }

  private enforceLimits(): void {
    while (this.shared.records.size > this.maxRecords || this.shared.rangeContentBytes > this.maxRangeContentBytes) {
      const key = this.shared.records.keys().next().value;
      if (typeof key !== "string") break;
      this.deleteRecord(key);
    }
  }

  private discardRanges(record: FileReadRecord): void {
    this.shared.rangeContentBytes -= record.ranges.reduce((total, range) => total + contentByteLength(range), 0);
    if (this.shared.rangeContentBytes < 0) this.shared.rangeContentBytes = 0;
    record.ranges = [];
  }

  private deleteRecord(key: string): void {
    const record = this.shared.records.get(key);
    if (!record) return;
    this.discardRanges(record);
    this.shared.records.delete(key);
  }

  private key(cwd: string, absolutePath: string): string {
    return `${JSON.stringify(this.sessionId ?? null)}\0${cwd}\0${absolutePath}`;
  }

  private relativePath(cwd: string, absolutePath: string): string {
    return relative(cwd, absolutePath).split(/[\\/]/).join("/");
  }
}

/** Resolve aliases even for files not yet created, without granting permissions. */
export async function canonicalFilePath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const parent = dirname(resolve(path));
    if (parent === resolve(path)) throw error;
    return resolve(await canonicalFilePath(parent), basename(path));
  }
}

export async function readFileContentVersion(path: string): Promise<FileContentVersion> {
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error(`Read state can only track files: ${path}`);
    const digest = createHash("sha256");
    const stream = file.createReadStream({ autoClose: false });
    for await (const chunk of stream) digest.update(chunk);
    const after = await file.stat();
    const current = await stat(path);
    if (!sameFileMetadata(before, after) || !sameFileMetadata(after, current)) throw changedDuringRead(path);
    return {
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      dev: after.dev,
      ino: after.ino,
      contentHash: digest.digest("hex"),
    };
  } finally {
    await file.close();
  }
}

export function sameFileVersion(left: FileContentVersion, right: FileContentVersion): boolean {
  return sameFileMetadata(left, right) && left.contentHash === right.contentHash;
}

function sameFileMetadata(left: Omit<FileContentVersion, "contentHash">, right: Omit<FileContentVersion, "contentHash">): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.dev === right.dev && left.ino === right.ino;
}

async function canonicalIdentity(cwd: string, path: string): Promise<[string, string]> {
  return Promise.all([realpath(resolve(cwd)), canonicalFilePath(path)]);
}

function changedDuringRead(path: string): Error {
  return new Error(`File changed while it was being read: ${path}. Read it again before modifying.`);
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function contentByteLength(snapshot: FileReadRangeSnapshot): number {
  return Buffer.byteLength(snapshot.content, "utf8");
}

function includesNormalized(haystack: string, needle: string): boolean {
  return haystack.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    .includes(needle.replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
