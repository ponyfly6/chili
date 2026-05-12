import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

export interface FileReadSnapshot {
  cwd: string;
  absolutePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  contentHash: string;
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

const DEFAULT_MAX_RECORDS = 100;
const DEFAULT_MAX_RANGE_CONTENT_BYTES = 25 * 1024 * 1024;

export class FileReadStateStore {
  private readonly records = new Map<string, FileReadRecord>();
  private readonly maxRecords: number;
  private readonly maxRangeContentBytes: number;
  private rangeContentBytes = 0;

  constructor(options: FileReadStateStoreOptions = {}) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxRangeContentBytes = options.maxRangeContentBytes ?? DEFAULT_MAX_RANGE_CONTENT_BYTES;
  }

  async recordTextRead(cwd: string, absolutePath: string, content: string): Promise<FileReadSnapshot> {
    const workspace = resolve(cwd);
    const target = resolve(absolutePath);
    const info = await stat(target);
    if (!info.isFile()) {
      throw new Error(`Read state can only track files: ${this.relativePath(workspace, target)}`);
    }

    const snapshot: FileReadSnapshot = {
      cwd: workspace,
      absolutePath: target,
      relativePath: this.relativePath(workspace, target),
      size: info.size,
      mtimeMs: info.mtimeMs,
      contentHash: hash(content),
    };
    const record = this.record(workspace, target);
    this.rangeContentBytes -= record.ranges.reduce((total, range) => total + contentByteLength(range), 0);
    if (this.rangeContentBytes < 0) this.rangeContentBytes = 0;
    record.ranges = [];
    record.full = snapshot;
    this.enforceLimits();
    return snapshot;
  }

  async recordTextRangeRead(
    cwd: string,
    absolutePath: string,
    content: string,
    range: { offset?: number; limit?: number } = {},
  ): Promise<FileReadRangeSnapshot> {
    const workspace = resolve(cwd);
    const target = resolve(absolutePath);
    const info = await stat(target);
    if (!info.isFile()) {
      throw new Error(`Read state can only track files: ${this.relativePath(workspace, target)}`);
    }

    const snapshot: FileReadRangeSnapshot = {
      cwd: workspace,
      absolutePath: target,
      relativePath: this.relativePath(workspace, target),
      size: info.size,
      mtimeMs: info.mtimeMs,
      contentHash: hash(content),
      content,
      ...(range.offset !== undefined ? { offset: range.offset } : {}),
      ...(range.limit !== undefined ? { limit: range.limit } : {}),
    };
    this.record(workspace, target).ranges.push(snapshot);
    this.rangeContentBytes += contentByteLength(snapshot);
    this.enforceLimits();
    return snapshot;
  }

  async assertFresh(cwd: string, absolutePath: string): Promise<FileReadSnapshot> {
    const workspace = resolve(cwd);
    const target = resolve(absolutePath);
    const key = this.key(workspace, target);
    const record = this.records.get(key);
    if (record) this.touch(key, record);
    const snapshot = record?.full;
    const relativePath = this.relativePath(workspace, target);
    if (!snapshot) {
      throw new Error(`Read ${relativePath} before modifying it so the edit is based on current contents.`);
    }

    const info = await stat(target);
    if (!info.isFile()) {
      throw new Error(`Cannot modify non-file path: ${relativePath}`);
    }
    if (info.size === snapshot.size && info.mtimeMs === snapshot.mtimeMs) {
      return snapshot;
    }

    const current = await readFile(target, "utf8");
    const currentHash = hash(current);
    if (currentHash !== snapshot.contentHash) {
      throw new Error(`File changed since it was read: ${relativePath}. Read it again before modifying.`);
    }

    return this.recordTextRead(workspace, target, current);
  }

  async assertObservedText(cwd: string, absolutePath: string, text: string): Promise<FileReadSnapshot | FileReadRangeSnapshot> {
    if (text.length === 0) {
      return this.assertFresh(cwd, absolutePath);
    }

    const workspace = resolve(cwd);
    const target = resolve(absolutePath);
    const relativePath = this.relativePath(workspace, target);
    const key = this.key(workspace, target);
    const record = this.records.get(key);
    if (!record) {
      throw new Error(`Read ${relativePath} before modifying it so the edit is based on current contents.`);
    }
    this.touch(key, record);

    if (record.full) {
      return this.assertFresh(workspace, target);
    }

    const snapshot = record.ranges.find((range) => includesNormalized(range.content, text));
    if (!snapshot) {
      throw new Error(`Read the target text in ${relativePath} before modifying it.`);
    }

    const info = await stat(target);
    if (!info.isFile()) {
      throw new Error(`Cannot modify non-file path: ${relativePath}`);
    }
    if (info.size !== snapshot.size || info.mtimeMs !== snapshot.mtimeMs) {
      throw new Error(`File changed since the target text was read: ${relativePath}. Read it again before modifying.`);
    }

    return snapshot;
  }

  forget(cwd: string, absolutePath: string): void {
    const workspace = resolve(cwd);
    const target = resolve(absolutePath);
    this.deleteRecord(this.key(workspace, target));
  }

  clear(): void {
    this.records.clear();
    this.rangeContentBytes = 0;
  }

  private record(cwd: string, absolutePath: string): FileReadRecord {
    const key = this.key(cwd, absolutePath);
    const existing = this.records.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing;
    }
    const next: FileReadRecord = { ranges: [] };
    this.records.set(key, next);
    return next;
  }

  private touch(key: string, record: FileReadRecord): void {
    this.records.delete(key);
    this.records.set(key, record);
  }

  private enforceLimits(): void {
    while (this.records.size > this.maxRecords || this.rangeContentBytes > this.maxRangeContentBytes) {
      const key = this.records.keys().next().value;
      if (typeof key !== "string") break;
      this.deleteRecord(key);
    }
  }

  private deleteRecord(key: string): void {
    const record = this.records.get(key);
    if (!record) return;
    this.rangeContentBytes -= record.ranges.reduce((total, range) => total + contentByteLength(range), 0);
    if (this.rangeContentBytes < 0) this.rangeContentBytes = 0;
    this.records.delete(key);
  }

  private key(cwd: string, absolutePath: string): string {
    return `${resolve(cwd)}\0${resolve(absolutePath)}`;
  }

  private relativePath(cwd: string, absolutePath: string): string {
    return relative(cwd, absolutePath).split(/[\\/]/).join("/");
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function contentByteLength(snapshot: FileReadRangeSnapshot): number {
  return Buffer.byteLength(snapshot.content, "utf8");
}

function includesNormalized(haystack: string, needle: string): boolean {
  return normalizeLineEndings(haystack).includes(normalizeLineEndings(needle));
}

function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
