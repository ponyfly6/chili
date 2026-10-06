import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId, ToolCallId, TurnId } from "@chili/protocol";
import { createGitWorktreeTool, type GitWorktreeInput } from "./builtins/git-worktree.js";
import { runProcess } from "./process.js";
import type { ChiliToolExecutionContext } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("git_worktree creates a detached committed snapshot and lists registered paths", async () => {
  const root = await repository();
  const head = await git(root, ["rev-parse", "HEAD"]);
  const branch = await git(root, ["symbolic-ref", "HEAD"]);
  await writeFile(join(root, "tracked.txt"), "parent edits\n");
  await writeFile(join(root, "untracked.txt"), "parent only\n");
  const data = await execute(root, { action: "create", name: "isolated" }) as CreatedWorktree;
  expect(data).toEqual({ path: join(root, ".chili", "worktrees", "isolated"), baseCommit: head, head, detached: true, created: true });
  expect(data.head).toMatch(/^[0-9a-f]{40}$/);
  expect(await readFile(join(data.path, "tracked.txt"), "utf8")).toBe("committed\n");
  expect(await exists(join(data.path, "untracked.txt"))).toBe(false);
  expect(await git(root, ["symbolic-ref", "HEAD"])).toBe(branch);
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("parent edits\n");
  const listing = await execute(root, { action: "list" }) as WorktreeList;
  expect(listing.truncated).toBe(false);
  expect(listing.worktrees).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: root, head, detached: false, managed: false }),
    expect.objectContaining({ path: data.path, head, detached: true, managed: true }),
  ]));
  expect(createGitWorktreeTool().codeMode).toBe(true);
});

test("git_worktree reuses matching dirty worktrees without changing files or index", async () => {
  const root = await repository();
  const first = await execute(root, { action: "create", name: "preserve" }) as CreatedWorktree;
  await writeFile(join(first.path, "tracked.txt"), "staged edits\n");
  await git(first.path, ["add", "tracked.txt"]);
  await writeFile(join(first.path, "tracked.txt"), "later edits\n");
  await writeFile(join(first.path, "new.txt"), "untracked edits\n");
  const before = await git(first.path, ["status", "--porcelain=v1"]);
  const staged = await git(first.path, ["show", ":tracked.txt"]);
  const repeated = await execute(root, { action: "create", name: "preserve", base: first.baseCommit }) as CreatedWorktree;
  expect(repeated.created).toBe(false);
  expect(await git(first.path, ["status", "--porcelain=v1"])).toBe(before);
  expect(await git(first.path, ["show", ":tracked.txt"])).toBe(staged);
  expect(await readFile(join(first.path, "tracked.txt"), "utf8")).toBe("later edits\n");
  expect(await readFile(join(first.path, "new.txt"), "utf8")).toBe("untracked edits\n");
});

test("git_worktree refuses a different base and preserves the existing checkout", async () => {
  const root = await repository();
  const first = await execute(root, { action: "create", name: "fixed" }) as CreatedWorktree;
  await writeFile(join(first.path, "tracked.txt"), "keep this\n");
  await writeFile(join(root, "tracked.txt"), "next commit\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "--no-gpg-sign", "--no-verify", "-m", "next"]);
  await expect(execute(root, { action: "create", name: "fixed" })).rejects.toThrow("requested detached commit");
  expect(await git(first.path, ["rev-parse", "HEAD"])).toBe(first.head);
  expect(await readFile(join(first.path, "tracked.txt"), "utf8")).toBe("keep this\n");
});

test("git_worktree rejects unsafe names, revisions, and unsupported operations", async () => {
  const tool = createGitWorktreeTool();
  for (const name of ["../escape", "/outside", "alias/name", ".", "..", "-option", "Upper", "bad\0name", "bad\n", "a".repeat(65)]) {
    expect((await tool.validate?.({ action: "create", name }))?.ok).toBe(false);
  }
  for (const input of [
    { action: "create" }, { action: "remove", name: "x" }, { action: "create", name: "ok", force: true },
    { action: "list", name: "x" }, { action: "list", base: "HEAD" },
    { action: "create", name: "x", base: "--help" }, { action: "create", name: "x", base: "HEAD\n" },
  ]) expect((await tool.validate?.(input))?.ok).toBe(false);
});

test("git_worktree preserves an existing directory without a Git registration", async () => {
  const root = await repository();
  const target = join(root, ".chili", "worktrees", "occupied");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "keep.txt"), "keep\n");
  await expect(execute(root, { action: "create", name: "occupied" })).rejects.toThrow("unregistered worktree directory");
  expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("keep\n");
  expect((await execute(root, { action: "list" }) as WorktreeList).worktrees).toHaveLength(1);
});

test("git_worktree rejects symlink aliases at every managed path segment", async () => {
  for (const segment of [".chili", ".chili/worktrees", ".chili/worktrees/alias"]) {
    const root = await repository();
    const outside = await temporaryDirectory();
    const parts = segment.split("/");
    if (parts.length > 1) await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
    await symlink(outside, join(root, ...parts), "dir");
    await expect(execute(root, { action: "create", name: "alias" })).rejects.toThrow("symlink aliases");
    expect(await exists(join(outside, "tracked.txt"))).toBe(false);
    expect(await exists(join(outside, "worktrees"))).toBe(false);
  }
});

test("git_worktree fails closed on resource denials, scoped policies, and revoked authorization", async () => {
  const root = await repository();
  for (const overrides of [
    { currentResourceDenials: async () => ({ readPaths: [join(root, "secret")], writePaths: [] }) },
    { executionPolicy: { writeScope: ["src"] } },
    { assertCurrentAuthorization: async () => { throw new Error("authorization revoked"); } },
  ] satisfies Array<Partial<ChiliToolExecutionContext>>) {
    await expect(execute(root, { action: "create", name: "denied" }, overrides)).rejects.toThrow();
    expect(await exists(join(root, ".chili"))).toBe(false);
  }
});

test("git_worktree checks authorization again before Git creates the worktree", async () => {
  const root = await repository();
  await expect(execute(root, { action: "create", name: "revoked" }, {
    assertCurrentAuthorization: async () => {
      if (await exists(join(root, ".chili", "worktrees"))) throw new Error("authorization revoked before creation");
    },
  })).rejects.toThrow("authorization revoked before creation");
  expect(await exists(join(root, ".chili", "worktrees", "revoked"))).toBe(false);
  expect((await execute(root, { action: "list" }) as WorktreeList).worktrees).toHaveLength(1);
});

test("concurrent git_worktree creates converge on one registered worktree", async () => {
  const root = await repository();
  const results = await Promise.all([
    execute(root, { action: "create", name: "shared" }),
    execute(root, { action: "create", name: "shared" }),
  ]) as CreatedWorktree[];
  expect(results.map((entry) => entry.created).sort()).toEqual([false, true]);
  expect((await execute(root, { action: "list" }) as WorktreeList).worktrees).toHaveLength(2);
});

interface CreatedWorktree { path: string; baseCommit: string; head: string; detached: boolean; created: boolean; }
interface WorktreeList { worktrees: Array<{ path: string; head: string | null; detached: boolean; managed: boolean }>; truncated: boolean; }

async function execute(cwd: string, input: GitWorktreeInput, overrides: Partial<ChiliToolExecutionContext> = {}): Promise<unknown> {
  const tool = createGitWorktreeTool();
  const validated = await tool.validate?.(input);
  if (!validated?.ok) throw new Error(validated?.message ?? "validation failed");
  const callId = "git_worktree_test" as ToolCallId;
  const context: ChiliToolExecutionContext = {
    sessionId: "git_worktree_session" as SessionId,
    turnId: "git_worktree_turn" as TurnId,
    callId, outputArtifactId: callId, cwd, signal: new AbortController().signal,
    metadata: async () => undefined,
    streamOutput: async () => undefined,
    requestApproval: async () => ({ action: "allow_once" }),
    registerPersistedOutput: async () => undefined,
    ...overrides,
  };
  return (await tool.execute(validated.value, context)).structuredData;
}

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "chili-worktree-tool-")));
  directories.push(path);
  return path;
}

async function repository(): Promise<string> {
  const root = await temporaryDirectory();
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "chili-test@example.com"]);
  await git(root, ["config", "user.name", "Chili Test"]);
  await writeFile(join(root, "tracked.txt"), "committed\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "--no-gpg-sign", "--no-verify", "-m", "init"]);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000, maxOutputBytes: 256_000 });
  if (result.exitCode !== 0 || result.timedOut) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
