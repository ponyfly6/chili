import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { withFileOperationLocks } from "../file-operation-lock.js";
import { assertGitResourceAccess } from "../file-resource-access.js";
import { assertGitRepositoryRoot, assertGitSuccess, resolveGitCommit, runGit } from "./git-utils.js";
import type { ChiliToolDefinition, ChiliToolExecutionContext, ValidationResult } from "../types.js";

export interface GitWorktreeInput {
  action: "create" | "list";
  name?: string;
  base?: string;
}

interface GitWorktreeEntry {
  path: string;
  head: string | null;
  detached: boolean;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
  managed: boolean;
}

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function createGitWorktreeTool(): ChiliToolDefinition<GitWorktreeInput> {
  return {
    name: "git_worktree",
    codeMode: true,
    searchHint: "Create an isolated detached Git worktree or list registered worktrees.",
    description: "Create a detached worktree at .chili/worktrees/<name> from a fixed commit, or list Git worktrees. Existing matching worktrees are preserved and reused; this tool never resets, removes, or prunes worktrees.",
    risk: "write",
    isReadOnly: (input) => input.action === "list",
    isConcurrencySafe: (input) => input.action === "list",
    isDestructive: false,
    maxResultOutputBytes: 100_000,
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["create", "list"] },
        name: { type: "string", description: "Required for create: a lowercase alphanumeric slug with internal hyphens, at most 64 characters." },
        base: { type: "string", description: "Commit or ref for create; defaults to HEAD and is resolved to a full commit ID before creation." },
      },
    },
    outputSchema: {
      oneOf: [
        {
          type: "object", required: ["path", "baseCommit", "head", "detached", "created"],
          properties: {
            path: { type: "string" }, baseCommit: { type: "string" }, head: { type: "string" },
            detached: { type: "boolean" }, created: { type: "boolean" },
          },
        },
        {
          type: "object", required: ["worktrees", "truncated"],
          properties: {
            worktrees: { type: "array", items: {
              type: "object", required: ["path", "head", "detached", "branch", "locked", "prunable", "managed"],
              properties: {
                path: { type: "string" }, head: { type: ["string", "null"] }, detached: { type: "boolean" },
                branch: { type: ["string", "null"] }, locked: { type: "boolean" }, prunable: { type: "boolean" },
                managed: { type: "boolean", description: "Whether the registered path has this tool's .chili/worktrees/<slug> layout." },
              },
            } },
            truncated: { type: "boolean" },
          },
        },
      ],
    },
    validate: validateInput,
    approval(input) {
      return {
        permission: "git_worktree",
        patterns: input.action === "create" ? [`.chili/worktrees/${input.name}`] : ["*"],
        metadata: { action: input.action, ...(input.name ? { name: input.name } : {}), ...(input.base ? { base: input.base } : {}) },
      };
    },
    async execute(input, context) {
      await assertGitResourceAccess(context, input.action === "create");
      const root = await assertGitRepositoryRoot(context);
      if (input.action === "list") {
        const data = { worktrees: await readWorktrees(context, root), truncated: false };
        await assertGitResourceAccess(context, false);
        return { title: "git worktree list", output: JSON.stringify(data, null, 2), structuredData: data };
      }
      if (!input.name || !isSafeName(input.name)) throw new Error("git_worktree create requires a safe name");
      const target = join(root, ".chili", "worktrees", input.name);
      await assertManagedPath(root, target);
      const baseCommit = await resolveGitCommit(context, input.base ?? "HEAD");
      const commonDirectory = await gitCommonDirectory(context);
      // Directory locks coordinate worktree creation, without the regular-file mutation journal.
      return withFileOperationLocks([join(root, ".chili", "worktrees"), target], context.signal, async () => {
        await assertGitResourceAccess(context, true);
        if (await assertGitRepositoryRoot(context) !== root) throw new Error("Repository path changed before worktree creation");
        await assertManagedPath(root, target);
        const existing = matchingWorktree(await readWorktrees(context, root), target);
        let created = false;
        if (!existing) {
          if (await pathExists(target)) throw new Error(`Refusing to overwrite an unregistered worktree directory: ${target}`);
          await ensureManagedDirectory(context, root, join(root, ".chili"));
          await ensureManagedDirectory(context, root, join(root, ".chili", "worktrees"));
          await assertManagedPath(root, target);
          await assertGitResourceAccess(context, true);
          const result = await runGit(context, ["worktree", "add", "--detach", "--", target, baseCommit], { mutates: true });
          assertGitSuccess(result, "git worktree add");
          created = true;
        }
        await assertGitResourceAccess(context, true);
        await assertManagedPath(root, target, true);
        const registered = matchingWorktree(await readWorktrees(context, root), target);
        if (!registered || !registered.detached || registered.head !== baseCommit || registered.prunable) {
          throw new Error("Existing worktree is not registered at the requested detached commit; its contents were preserved.");
        }
        const childContext = { ...context, cwd: target };
        if (await assertGitRepositoryRoot(childContext) !== target || await gitCommonDirectory(childContext) !== commonDirectory) {
          throw new Error("Worktree does not belong to the current Git repository; its contents were preserved.");
        }
        const head = await resolveGitCommit(childContext);
        if (head !== baseCommit) throw new Error("Worktree HEAD changed during creation; its contents were preserved.");
        await assertManagedPath(root, target, true);
        await assertGitResourceAccess(context, true);
        const data = { path: target, baseCommit, head, detached: true, created };
        return { title: created ? "created git worktree" : "reused git worktree", output: JSON.stringify(data, null, 2), structuredData: data };
      });
    },
  };
}

function validateInput(input: unknown): ValidationResult<GitWorktreeInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, message: "expected an object" };
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !["action", "name", "base"].includes(key));
  if (unknown) return { ok: false, message: `unsupported git_worktree parameter: ${unknown}` };
  if (record.action !== "create" && record.action !== "list") return { ok: false, message: "action must be create or list" };
  if (record.action === "list") {
    if (record.name !== undefined || record.base !== undefined) return { ok: false, message: "name and base are only supported for create" };
    return { ok: true, value: { action: "list" } };
  }
  if (typeof record.name !== "string" || !isSafeName(record.name)) {
    return { ok: false, message: "name must be a safe lowercase slug with internal hyphens, at most 64 characters" };
  }
  if (record.base !== undefined && (typeof record.base !== "string" || !record.base.length || record.base.startsWith("-") || /[\s\0]/.test(record.base))) {
    return { ok: false, message: "base must be a non-empty Git revision without whitespace or a leading dash" };
  }
  return { ok: true, value: { action: "create", name: record.name, ...(typeof record.base === "string" ? { base: record.base } : {}) } };
}

async function readWorktrees(context: ChiliToolExecutionContext, root: string): Promise<GitWorktreeEntry[]> {
  const result = await runGit(context, ["worktree", "list", "--porcelain", "-z"]);
  assertGitSuccess(result, "git worktree list");
  const entries: GitWorktreeEntry[] = [];
  for (const record of result.stdout.split("\0\0")) {
    if (!record) continue;
    const fields = record.split("\0").filter(Boolean);
    const path = fields[0]?.startsWith("worktree ") ? fields[0].slice(9) : undefined;
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice(5) ?? null;
    if (!path || resolve(path) !== path || (head !== null && !COMMIT_PATTERN.test(head))) {
      throw new Error("Git returned an invalid worktree registration");
    }
    entries.push({
      path, head, detached: fields.includes("detached"),
      branch: fields.find((field) => field.startsWith("branch "))?.slice(7) ?? null,
      locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
      prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
      managed: dirname(path) === join(root, ".chili", "worktrees") && isSafeName(basename(path)),
    });
  }
  return entries;
}

function matchingWorktree(entries: GitWorktreeEntry[], target: string): GitWorktreeEntry | undefined {
  const matching = entries.filter((entry) => entry.path === target);
  if (matching.length > 1) throw new Error("Git returned duplicate worktree registrations");
  return matching[0];
}

async function gitCommonDirectory(context: ChiliToolExecutionContext): Promise<string> {
  const result = await runGit(context, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  assertGitSuccess(result, "git rev-parse --git-common-dir");
  return realpath(result.stdout.trim());
}

async function assertManagedPath(root: string, target: string, requireExisting = false): Promise<void> {
  for (const path of [join(root, ".chili"), join(root, ".chili", "worktrees"), target]) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== path) {
        throw new Error(`Worktree path must be a canonical directory without symlink aliases: ${path}`);
      }
    } catch (error) {
      if (!isNotFound(error) || requireExisting) throw error;
    }
  }
}

async function ensureManagedDirectory(context: ChiliToolExecutionContext, root: string, path: string): Promise<void> {
  await assertManagedPath(root, path);
  await assertGitResourceAccess(context, true);
  try { await mkdir(path); }
  catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
  }
  await assertManagedPath(root, path);
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (isNotFound(error)) return false; throw error; }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isSafeName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && !/[^a-z0-9-]/.test(name) && !name.startsWith("-") && !name.endsWith("-");
}
