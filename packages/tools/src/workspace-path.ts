import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const PROTECTED_WORKSPACE_METADATA = [".git", ".chili"] as const;
const MAX_GITDIR_POINTER_BYTES = 4_096;
const MAX_PROTECTED_METADATA_ENTRIES = 100_000;
const MAX_PROTECTED_METADATA_TARGETS = 4_096;

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

export async function assertDirectWritablePathInsideWorkspace(
  workspaceInput: string,
  target: WorkspacePath,
  originalPath = target.relativePath,
): Promise<void> {
  await assertPathOutsideProtectedWorkspaceMetadata(workspaceInput, target, originalPath);
  await assertWritablePathInsideWorkspace(workspaceInput, target, originalPath);
  await assertExistingTargetHasSingleLink(target.absolutePath, originalPath);
}

export async function assertPathOutsideProtectedWorkspaceMetadata(
  workspaceInput: string,
  target: WorkspacePath,
  originalPath = target.relativePath,
): Promise<void> {
  const workspaceRealPath = await realpath(resolve(workspaceInput));
  await assertLogicalPathOutsideProtectedMetadata(workspaceInput, target, originalPath, workspaceRealPath);
  try {
    const targetRealPath = await realpath(target.absolutePath);
    await assertRealPathOutsideProtectedMetadata(workspaceRealPath, targetRealPath, originalPath);
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const parent = await nearestExistingParent(target.absolutePath);
  const parentRealPath = await realpath(parent);
  await assertRealPathOutsideProtectedMetadata(workspaceRealPath, parentRealPath, originalPath);
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

async function assertLogicalPathOutsideProtectedMetadata(
  workspaceInput: string,
  target: WorkspacePath,
  originalPath: string,
  workspaceRealPath: string,
): Promise<void> {
  const logicalRelativePath = relative(resolve(workspaceInput), target.absolutePath);
  const caseInsensitive = await isCaseInsensitiveFileSystem(workspaceRealPath);
  assertRelativePathOutsideProtectedMetadata(logicalRelativePath, originalPath, caseInsensitive);
}

function assertRelativePathOutsideProtectedMetadata(
  relativePath: string,
  originalPath: string,
  caseInsensitive: boolean,
): void {
  const [rootEntry] = toPosixPath(relativePath).split("/");
  if (!rootEntry) return;
  const comparableEntry = caseInsensitive ? rootEntry.toLowerCase() : rootEntry;
  if (PROTECTED_WORKSPACE_METADATA.some((entry) => entry === comparableEntry)) {
    throw protectedMetadataPathError(originalPath);
  }
}

async function assertRealPathOutsideProtectedMetadata(
  workspaceRealPath: string,
  targetRealPath: string,
  originalPath: string,
): Promise<void> {
  const caseInsensitive = await isCaseInsensitiveFileSystem(workspaceRealPath);
  const protectedRoots = await protectedWorkspaceMetadataRoots(workspaceRealPath);
  for (const protectedRoot of protectedRoots) {
    if (isSamePathOrInside(protectedRoot, targetRealPath, caseInsensitive)) {
      throw protectedMetadataPathError(originalPath);
    }
  }
}

async function protectedWorkspaceMetadataRoots(workspaceRealPath: string): Promise<string[]> {
  const roots = new Set<string>();
  const pendingDirectories: string[] = [];
  for (const entry of PROTECTED_WORKSPACE_METADATA) {
    const logicalPath = resolve(workspaceRealPath, entry);
    roots.add(logicalPath);
    try {
      const canonicalPath = await realpath(logicalPath);
      roots.add(canonicalPath);
      const info = await stat(logicalPath);
      if (info.isDirectory()) pendingDirectories.push(canonicalPath);
      if (entry === ".git") {
        if (info.isFile() && info.size <= MAX_GITDIR_POINTER_BYTES) {
          const pointer = /^gitdir:\s*(.+?)\s*$/im.exec(await readFile(logicalPath, "utf8"));
          if (pointer?.[1]) {
            const targetPath = resolve(dirname(logicalPath), pointer[1]);
            const canonicalTarget = await canonicalPathOrLogical(targetPath);
            roots.add(canonicalTarget);
            try {
              if ((await stat(canonicalTarget)).isDirectory()) pendingDirectories.push(canonicalTarget);
            } catch (error) {
              if (!isNotFound(error)) throw error;
            }
          }
        }
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  await collectProtectedMetadataSymlinkTargets(pendingDirectories, roots);
  return [...roots];
}

async function collectProtectedMetadataSymlinkTargets(
  pendingDirectories: string[],
  protectedRoots: Set<string>,
): Promise<void> {
  const visitedDirectories = new Set<string>();
  let inspectedEntries = 0;
  let discoveredTargets = 0;

  while (pendingDirectories.length > 0) {
    const requestedDirectory = pendingDirectories.pop();
    if (!requestedDirectory) continue;
    let directory: string;
    try {
      directory = await realpath(requestedDirectory);
    } catch (error) {
      throw protectedMetadataInspectionError(requestedDirectory, error);
    }
    if (visitedDirectories.has(directory)) continue;
    visitedDirectories.add(directory);

    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      throw protectedMetadataInspectionError(directory, error);
    }
    try {
      for await (const entry of handle) {
        inspectedEntries += 1;
        if (inspectedEntries > MAX_PROTECTED_METADATA_ENTRIES) {
          throw new Error(
            `Cannot safely inspect protected workspace metadata: traversal exceeds `
            + `${MAX_PROTECTED_METADATA_ENTRIES} entries.`,
          );
        }
        const entryPath = resolve(directory, entry.name);
        const info = await lstat(entryPath);
        if (info.isSymbolicLink()) {
          let target: string;
          try {
            target = await realpath(entryPath);
          } catch (error) {
            throw protectedMetadataInspectionError(entryPath, error);
          }
          if (!protectedRoots.has(target)) {
            discoveredTargets += 1;
            if (discoveredTargets > MAX_PROTECTED_METADATA_TARGETS) {
              throw new Error(
                `Cannot safely inspect protected workspace metadata: traversal exceeds `
                + `${MAX_PROTECTED_METADATA_TARGETS} symlink targets.`,
              );
            }
            protectedRoots.add(target);
          }
          if ((await stat(entryPath)).isDirectory()) pendingDirectories.push(target);
          continue;
        }
        if (info.isDirectory()) pendingDirectories.push(entryPath);
      }
    } catch (error) {
      if (isProtectedMetadataInspectionError(error)) throw error;
      throw protectedMetadataInspectionError(directory, error);
    }
  }
}

async function assertExistingTargetHasSingleLink(path: string, originalPath: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.nlink <= 1) return;
    throw new Error(
      `Direct writes refuse existing multi-link targets: ${originalPath} has ${info.nlink} hard links`,
    );
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

function protectedMetadataInspectionError(path: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Cannot safely inspect protected workspace metadata at ${path}: ${message}`);
}

function isProtectedMetadataInspectionError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Cannot safely inspect protected workspace metadata");
}

async function canonicalPathOrLogical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNotFound(error)) return resolve(path);
    throw error;
  }
}

function isSamePathOrInside(root: string, target: string, caseInsensitive: boolean): boolean {
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  const comparableTarget = caseInsensitive ? target.toLowerCase() : target;
  const rel = relative(comparableRoot, comparableTarget);
  return rel === "" || isSafeRelativePath(rel);
}

async function isCaseInsensitiveFileSystem(workspaceRealPath: string): Promise<boolean> {
  const caseVariant = pathWithCaseVariant(workspaceRealPath);
  if (!caseVariant) return false;
  try {
    return await realpath(caseVariant) === workspaceRealPath;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function pathWithCaseVariant(path: string): string | undefined {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const character = path[index];
    if (!character || !/[A-Za-z]/.test(character)) continue;
    const toggled = character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
    return `${path.slice(0, index)}${toggled}${path.slice(index + 1)}`;
  }
  return undefined;
}

function protectedMetadataPathError(originalPath: string): Error {
  return new Error(`Path points to protected workspace metadata: ${originalPath}`);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
