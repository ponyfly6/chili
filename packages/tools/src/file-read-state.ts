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

export class FileReadStateStore {
  private readonly snapshots = new Map<string, FileReadSnapshot>();

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
    this.snapshots.set(this.key(workspace, target), snapshot);
    return snapshot;
  }

  async assertFresh(cwd: string, absolutePath: string): Promise<FileReadSnapshot> {
    const workspace = resolve(cwd);
    const target = resolve(absolutePath);
    const key = this.key(workspace, target);
    const snapshot = this.snapshots.get(key);
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

  forget(cwd: string, absolutePath: string): void {
    const workspace = resolve(cwd);
    const target = resolve(absolutePath);
    this.snapshots.delete(this.key(workspace, target));
  }

  clear(): void {
    this.snapshots.clear();
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
