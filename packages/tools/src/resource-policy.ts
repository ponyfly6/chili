import { realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { matches, parsePermissionSpec, type PermissionRule } from "@chili/policy";
import { assertPathOutsideProtectedWorkspaceMetadata, isSafeRelativePath, resolveWorkspacePath, toPosixPath } from "./workspace-path.js";
import type { ApprovalPreflightRequest, ToolApprovalSpecWithDefaults, ToolResourceDenials } from "./types.js";

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

export async function canonicalApprovalSpec<T extends ToolApprovalSpecWithDefaults>(
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
  // The legacy permission syntax has no literal-star escape. Such file names
  // can be approved once but must never produce a wildcard reusable grant.
  return { ...spec, patterns, ...(literal && patterns.some((pattern) => pattern.includes("*")) ? { maxApprovalScope: "once" as const } : {}) };
}

export async function canonicalPermissionRules(
  request: ApprovalPreflightRequest,
  rulesets: readonly (readonly PermissionRule[])[],
): Promise<readonly (readonly PermissionRule[])[]> {
  const identity = request.metadata?.resourceIdentity;
  const binding = typeof identity === "string" ? `.__resource__.${identity}` : undefined;
  return Promise.all(rulesets.map(async (rules) => {
    const result: PermissionRule[] = [];
    for (const original of rules) {
      let rule = original;
      if (binding) {
        if (rule.permission.includes(".__resource__.")) {
          if (!rule.permission.endsWith(binding)) continue;
          rule = { ...rule, permission: rule.permission.slice(0, -binding.length) };
        } else if (rule.action === "allow" && rule.source !== "permission_profile:full-access") {
          // An old name-based grant is not authority over a different server.
          continue;
        }
      } else if (rule.permission.includes(".__resource__.")) continue;
      if (request.workspaceRoot && isFilePermission(request.permission)) {
        const parsed = parsePermissionSpec(rule.permission);
        if (isFilePermission(parsed.permission) || parsed.permission === "*") {
          try {
            const pattern = await canonicalResourcePattern(request.workspaceRoot, rule.pattern);
            const permission = parsed.content === undefined ? rule.permission
              : `${parsed.permission}(${await canonicalResourcePattern(request.workspaceRoot, parsed.content)})`;
            rule = { ...rule, permission, pattern };
          } catch (error) {
            // Absolute grants for a different workspace do not authorize this one.
            if (error instanceof Error && error.message.startsWith("Path must stay inside the workspace:")) continue;
            throw error;
          }
        }
      }
      result.push(rule);
    }
    return result;
  }));
}

export function approvalGrantPermission(request: ApprovalPreflightRequest): string {
  const identity = request.metadata?.resourceIdentity;
  return typeof identity === "string" ? `${request.permission}.__resource__.${identity}` : request.permission;
}

export function approvalGrantPatterns(request: ApprovalPreflightRequest): string[] {
  return request.workspaceRoot && isFilePermission(request.permission)
    ? request.patterns.map((pattern) => resolve(request.workspaceRoot!, pattern))
    : [...request.patterns];
}

/**
 * Compile explicit resource denials for shell backends. Allow/ask rules cannot
 * remove a denial. Unsupported patterns reject execution instead of widening
 * the policy; this is intentionally not a complete read-scope sandbox.
 */
export async function resolveFileResourceDenials(
  cwd: string,
  rulesets: readonly (readonly PermissionRule[])[],
): Promise<ToolResourceDenials | undefined> {
  const readPaths: string[] = [];
  const writePaths: string[] = [];
  for (const rule of rulesets.flat()) {
    if (rule.action !== "deny") continue;
    const parsed = parsePermissionSpec(rule.permission);
    const permission = parsed.permission.toLowerCase();
    const read = FILE_READ_PERMISSIONS.some((name) => matches(permission, name));
    const write = FILE_WRITE_PERMISSIONS.some((name) => matches(permission, name));
    if (!read && !write) continue;
    const selector = await denialSelector(cwd, parsed.content !== undefined && rule.pattern === "*" ? parsed.content : rule.pattern);
    const scoped = parsed.content === undefined || rule.pattern === "*" || parsed.content === "*" ? selector
      : intersectDenialSelectors(selector, await denialSelector(cwd, parsed.content));
    if (!scoped) continue;
    if (read) readPaths.push(scoped.path);
    if (write) writePaths.push(scoped.path);
  }
  if (readPaths.length === 0 && writePaths.length === 0) return undefined;
  return { readPaths: minimalDeniedPaths(readPaths), writePaths: minimalDeniedPaths(writePaths) };
}

/** Canonical absolute identity, including a missing tail; paths may be outside cwd. */
export async function canonicalAbsoluteResourcePath(cwd: string, path: string): Promise<string> {
  return canonicalExistingAncestor(resolve(cwd, path));
}

interface DenialSelector {
  path: string;
  subtree: boolean;
}

async function denialSelector(cwd: string, pattern: string): Promise<DenialSelector> {
  if (pattern === "*") return { path: await realpath(resolve(cwd)), subtree: true };
  if (!pattern.includes("*")) return { path: await canonicalAbsoluteResourcePath(cwd, pattern), subtree: false };
  try {
    // A real literal filename can contain '*'. Its identity wins over glob syntax.
    const path = await realpath(resolve(cwd, pattern));
    return { path: await canonicalAbsoluteResourcePath(cwd, path), subtree: false };
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (pattern.endsWith("/*") && !pattern.slice(0, -1).includes("*")) {
    return { path: await canonicalAbsoluteResourcePath(cwd, pattern.slice(0, -2) || "/"), subtree: true };
  }
  throw new Error(`Cannot enforce resource deny pattern in the process backend: ${pattern}. Use a concrete path or a directory followed by /*.`);
}

function intersectDenialSelectors(left: DenialSelector, right: DenialSelector): DenialSelector | undefined {
  if (left.path === right.path) return { path: left.path, subtree: left.subtree && right.subtree };
  if (left.subtree && pathInside(left.path, right.path)) return right;
  if (right.subtree && pathInside(right.path, left.path)) return left;
  return undefined;
}

function minimalDeniedPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)].sort();
  return unique.filter((path) => !unique.some((other) => other !== path && pathInside(other, path)));
}

function pathInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || isSafeRelativePath(path);
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
