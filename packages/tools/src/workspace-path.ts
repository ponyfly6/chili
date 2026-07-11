import { lstat, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export interface WorkspacePath {
  absolutePath: string;
  relativePath: string;
}

export interface ResolveWorkspacePathOptions {
  allowWorkspaceRoot?: boolean;
}

export function resolveWorkspacePath(
  workspaceInput: string,
  path: string,
  options: ResolveWorkspacePathOptions = {},
): WorkspacePath {
  const workspace = resolve(workspaceInput);
  const absolutePath = resolve(workspace, path);
  const relativePath = relative(workspace, absolutePath);
  if (relativePath === "") {
    if (options.allowWorkspaceRoot) return { absolutePath, relativePath: "." };
    throw new Error(`Path must stay inside the workspace: ${path}`);
  }
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`Path must stay inside the workspace: ${path}`);
  }
  return { absolutePath, relativePath: toPosixPath(relativePath) };
}

export async function assertExistingPathInsideWorkspace(
  workspaceInput: string,
  target: WorkspacePath,
  originalPath = target.relativePath,
): Promise<void> {
  const workspaceRealPath = await realpath(resolve(workspaceInput));
  const targetRealPath = await realpath(target.absolutePath);
  assertRealPathInsideWorkspace(workspaceRealPath, targetRealPath, originalPath);
}

export async function assertWritablePathInsideWorkspace(
  workspaceInput: string,
  target: WorkspacePath,
  originalPath = target.relativePath,
): Promise<void> {
  const workspaceRealPath = await realpath(resolve(workspaceInput));
  try {
    const targetRealPath = await realpath(target.absolutePath);
    assertRealPathInsideWorkspace(workspaceRealPath, targetRealPath, originalPath);
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  try {
    await lstat(target.absolutePath);
    throw new Error(`Path must stay inside the workspace: ${originalPath}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const parent = await nearestExistingParent(target.absolutePath);
  const parentRealPath = await realpath(parent);
  assertRealPathInsideWorkspace(workspaceRealPath, parentRealPath, originalPath);
}

export function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
}

export function toPosixPath(path: string): string {
  return path.split(/[\\/]/).join("/");
}

export function toPosixRelative(from: string, to: string): string {
  const rel = relative(from, to);
  return rel.length === 0 ? "." : toPosixPath(rel);
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = dirname(path);
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const next = dirname(current);
      if (next === current) throw error;
      current = next;
    }
  }
}

function assertRealPathInsideWorkspace(workspaceRealPath: string, targetRealPath: string, originalPath: string): void {
  const rel = relative(workspaceRealPath, targetRealPath);
  if (rel === "" || isSafeRelativePath(rel)) return;
  throw new Error(`Path must stay inside the workspace: ${originalPath}`);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
