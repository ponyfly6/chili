import { realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { assertPathOutsideProtectedWorkspaceMetadata, isSafeRelativePath, resolveWorkspacePath, toPosixPath } from "./workspace-path.js";
import type { ToolResourceSpecWithDefaults } from "./types.js";

const FILE_PERMISSIONS = new Set(["read", "read_image", "write", "edit", "glob", "grep"]);
export const FILE_READ_PERMISSIONS = ["read", "read_image", "glob", "grep"] as const;
export const FILE_WRITE_PERMISSIONS = ["write", "edit"] as const;

export function isFilePermission(permission: string): boolean {
  return FILE_PERMISSIONS.has(permission.toLowerCase());
}

/** Resolve the actual target, including symlinked parents of not-yet-created files. */
export async function canonicalResourcePattern(cwd: string, pattern: string, literal = false): Promise<string> {
  if (pattern === "*" && !literal) return pattern;
  const workspace = await realpath(resolve(cwd));
  let wildcard = literal ? -1 : pattern.search(/[?*[]/);
  if (wildcard >= 0) {
    try {
      // Existing names may contain shell/glob characters. Resolve that resource
      // before treating an unresolvable rule as a wildcard expression.
      await realpath(resolve(cwd, pattern));
      wildcard = -1;
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  const prefix = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
  const separator = prefix.lastIndexOf("/");
  const root = wildcard < 0 ? pattern : separator < 0 ? "." : prefix.slice(0, separator) || "/";
  const suffix = wildcard < 0 ? "" : separator < 0 ? pattern : pattern.slice(separator + 1);
  const target = await canonicalExistingAncestor(resolve(cwd, root));
  const path = suffix ? resolve(target, suffix) : target;
  const normalized = relative(workspace, path);
  if (normalized !== "" && !isSafeRelativePath(normalized)) {
    throw new Error(`Path must stay inside the workspace: ${pattern}`);
  }
  return normalized === "" ? "." : toPosixPath(normalized);
}

export async function canonicalToolResources<T extends ToolResourceSpecWithDefaults>(
  cwd: string,
  spec: T,
): Promise<T> {
  if (!isFilePermission(spec.permission)) return spec;
  const permission = spec.permission.toLowerCase();
  const literal = permission !== "glob" && permission !== "grep";
  if (permission === "write" || permission === "edit") {
    for (const pattern of spec.patterns) {
      await assertPathOutsideProtectedWorkspaceMetadata(cwd, resolveWorkspacePath(cwd, pattern), pattern);
    }
  }
  const patterns = await Promise.all(spec.patterns.map((pattern) => canonicalResourcePattern(cwd, pattern, literal)));
  return { ...spec, patterns };
}

/** Canonical absolute identity, including a missing tail; paths may be outside cwd. */
export async function canonicalAbsoluteResourcePath(cwd: string, path: string): Promise<string> {
  return canonicalExistingAncestor(resolve(cwd, path));
}

async function canonicalExistingAncestor(path: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (info.isFile() && info.nlink > 1) {
      throw new Error("Resource permissions refuse multi-link targets because file aliases cannot be safely authorized.");
    }
    return canonical;
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalExistingAncestor(parent), relative(parent, path));
  }
}
