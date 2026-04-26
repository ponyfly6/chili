import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { timestampNow, type SnapshotId, type TimestampMs } from "@chili/protocol";
import type { SnapshotCreateRequest, SnapshotProvider, SnapshotRecord, SnapshotRevertOptions, SnapshotRevertResult } from "./types.js";

interface SnapshotManifest {
  id: SnapshotId;
  cwd: string;
  createdAt: TimestampMs;
  reason: string;
  entries: SnapshotEntry[];
}

interface SnapshotEntry {
  relativePath: string;
  existed: boolean;
  backupName?: string;
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
    const cwd = resolve(request.cwd);
    const entries = await this.collectEntries(cwd, request.patterns);
    if (entries.length === 0) return undefined;

    const id = this.id<SnapshotId>("snapshot");
    const snapshotDir = this.snapshotDir(cwd, id);
    await mkdir(snapshotDir, { recursive: true });

    const manifest: SnapshotManifest = {
      id,
      cwd,
      createdAt: this.now(),
      reason: request.reason,
      entries: [],
    };

    for (const [index, entry] of entries.entries()) {
      const source = resolve(cwd, entry.relativePath);
      if (entry.existed) {
        const backupName = `${index}.blob`;
        await copyFile(source, join(snapshotDir, backupName));
        manifest.entries.push({ ...entry, backupName });
      } else {
        manifest.entries.push(entry);
      }
    }

    await writeFile(join(snapshotDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    this.cwdBySnapshot.set(id, cwd);
    return {
      id,
      cwd,
      paths: manifest.entries.map((entry) => entry.relativePath),
      createdAt: manifest.createdAt,
    };
  }

  async revert(snapshotId: SnapshotId, options: SnapshotRevertOptions = {}): Promise<SnapshotRevertResult> {
    const manifest = await this.readManifest(snapshotId, options.cwd);
    const snapshotDir = this.snapshotDir(manifest.cwd, snapshotId);
    const restored: string[] = [];
    const removed: string[] = [];

    for (const entry of manifest.entries) {
      const target = resolve(manifest.cwd, entry.relativePath);
      if (entry.existed) {
        if (!entry.backupName) throw new Error(`Snapshot entry is missing backup: ${entry.relativePath}`);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(snapshotDir, entry.backupName), target);
        restored.push(entry.relativePath);
      } else {
        await rm(target, { force: true });
        removed.push(entry.relativePath);
      }
    }

    return {
      snapshotId,
      paths: manifest.entries.map((entry) => entry.relativePath),
      restored,
      removed,
    };
  }

  private async collectEntries(cwd: string, patterns: string[]): Promise<SnapshotEntry[]> {
    const entries = new Map<string, SnapshotEntry>();
    for (const pattern of patterns) {
      const relativePath = resolvePattern(cwd, pattern);
      if (!relativePath) continue;

      const absolutePath = resolve(cwd, relativePath);
      const info = await stat(absolutePath).catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      });
      if (info?.isDirectory()) continue;

      entries.set(relativePath, {
        relativePath,
        existed: Boolean(info),
      });
    }
    return [...entries.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private async readManifest(snapshotId: SnapshotId, cwd?: string): Promise<SnapshotManifest> {
    if (cwd) {
      return JSON.parse(await readFile(join(this.snapshotDir(resolve(cwd), snapshotId), "manifest.json"), "utf8")) as SnapshotManifest;
    }

    const rememberedCwd = this.cwdBySnapshot.get(snapshotId);
    if (rememberedCwd) {
      return JSON.parse(await readFile(join(this.snapshotDir(rememberedCwd, snapshotId), "manifest.json"), "utf8")) as SnapshotManifest;
    }

    const roots = this.candidateRoots();
    for (const root of roots) {
      const manifestPath = join(root, snapshotId, "manifest.json");
      const text = await readFile(manifestPath, "utf8").catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      });
      if (text) return JSON.parse(text) as SnapshotManifest;
    }
    throw new Error(`Snapshot not found: ${snapshotId}`);
  }

  private snapshotDir(cwd: string, snapshotId: SnapshotId): string {
    return join(this.rootDir(cwd), snapshotId);
  }

  private rootDir(cwd: string): string {
    return resolve(cwd, this.options.rootDir ?? ".chili/snapshots");
  }

  private candidateRoots(): string[] {
    if (this.options.rootDir && this.options.rootDir.startsWith("/")) return [this.options.rootDir];
    return [resolve(process.cwd(), this.options.rootDir ?? ".chili/snapshots")];
  }

  private id<T extends string>(prefix: string): T {
    const create = this.options.createId ?? defaultCreateId;
    return create(prefix) as T;
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

function resolvePattern(cwd: string, pattern: string): string | undefined {
  if (pattern.includes("*") || pattern.includes("\n") || pattern.trim().length === 0) return undefined;
  const absolute = resolve(cwd, pattern);
  const rel = relative(cwd, absolute);
  if (!isSafeRelativePath(rel)) return undefined;
  return rel;
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}
