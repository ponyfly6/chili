import { afterEach, expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId, ToolCallId, TurnId } from "@chili/protocol";
import { createGitApplyPatchTool, type GitApplyPatchInput } from "./builtins/git-apply-patch.js";
import { runProcess } from "./process.js";
import type { ChiliToolExecutionContext } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("git_apply_patch checks and applies explicit text edits, additions and deletions without staging", async () => {
  const root = await repository();
  const expectedHead = (await git(root, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(root, "tracked.txt"), "changed\n");
  await rm(join(root, "remove.txt"));
  await writeFile(join(root, "new.txt"), "new\n");
  await git(root, ["add", "new.txt"]);
  const patchText = await git(root, ["diff", "--full-index", "--binary", "HEAD"]);
  await git(root, ["reset", "--hard", "HEAD"]);
  await writeFile(join(root, "unrelated.txt"), "local work\n");
  const checked = await execute(root, { patchText, expectedHead, checkOnly: true });
  expect(checked.applied).toBe(false);
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("committed\n");
  expect(await exists(join(root, "new.txt"))).toBe(false);
  const applied = await execute(root, { patchText, expectedHead });
  expect(applied).toEqual({ patchHash: checked.patchHash, paths: ["new.txt", "remove.txt", "tracked.txt"], head: expectedHead, applicable: true, applied: true });
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("changed\n");
  expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new\n");
  expect(await exists(join(root, "remove.txt"))).toBe(false);
  expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe("local work\n");
  expect(await git(root, ["diff", "--cached"])).toBe("");
  expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(expectedHead);
  expect(createGitApplyPatchTool().codeMode).toBe(true);
});

test("git_apply_patch refuses changed HEAD and affected local or staged changes", async () => {
  const root = await repository();
  const input = await editPatch(root);
  await writeFile(join(root, "tracked.txt"), "local work\n");
  await expect(execute(root, input)).rejects.toThrow("local, staged");
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("local work\n");
  await git(root, ["add", "tracked.txt"]);
  await expect(execute(root, input)).rejects.toThrow("local, staged");
  await git(root, ["commit", "--no-gpg-sign", "--no-verify", "-m", "next"]);
  await expect(execute(root, input)).rejects.toThrow("HEAD changed");
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("local work\n");
});

test("git_apply_patch refuses untracked and ignored destinations", async () => {
  const root = await repository();
  const expectedHead = (await git(root, ["rev-parse", "HEAD"])).trim();
  const patchText = "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n";
  await writeFile(join(root, "new.txt"), "keep\n");
  await expect(execute(root, { patchText, expectedHead })).rejects.toThrow("untracked or ignored");
  await writeFile(join(root, ".git", "info", "exclude"), "new.txt\n");
  await expect(execute(root, { patchText, expectedHead })).rejects.toThrow("untracked or ignored");
  expect(await readFile(join(root, "new.txt"), "utf8")).toBe("keep\n");
});

test("git_apply_patch rejects unsupported syntax and protected paths before execution", async () => {
  const tool = createGitApplyPatchTool();
  const expectedHead = "a".repeat(40);
  const patches = [
    "diff --git a/.git/config b/.git/config\n", "diff --git a/.chili/config b/.chili/config\n",
    "diff --git a/../outside b/../outside\n", "diff --git a/file b/other\n",
    "diff --git a/space name b/space name\n", "diff --git \"a/file\" \"b/file\"\n",
    "diff --git a/file b/file\nGIT binary patch\n", "diff --git a/file b/file\nnew file mode 120000\n",
    "diff --git a/file b/file\nindex aaa..bbb 160000\n", "diff --git a/file b/file\nrename from old\n",
  ];
  for (const patchText of patches) expect((await tool.validate?.({ patchText, expectedHead }))?.ok).toBe(false);
  expect((await tool.validate?.({ patchText: "diff --git a/file b/file\n", expectedHead: "HEAD" }))?.ok).toBe(false);
});

test("git_apply_patch refuses symlink and hardlink targets", async () => {
  const root = await repository();
  const input = await editPatch(root);
  const outside = await temporaryDirectory();
  await writeFile(join(outside, "victim.txt"), "committed\n");
  await rm(join(root, "tracked.txt"));
  await symlink(join(outside, "victim.txt"), join(root, "tracked.txt"));
  await expect(execute(root, input)).rejects.toThrow();
  expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("committed\n");
  await rm(join(root, "tracked.txt"));
  await link(join(outside, "victim.txt"), join(root, "tracked.txt"));
  await expect(execute(root, input)).rejects.toThrow("hard links");
  expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("committed\n");
});

test("git_apply_patch checks every hunk before applying any file", async () => {
  const root = await repository();
  const input = await editPatch(root);
  const invalid = input.patchText + "diff --git a/remove.txt b/remove.txt\n--- a/remove.txt\n+++ b/remove.txt\n@@ -1 +1 @@\n-wrong\n+changed\n";
  await expect(execute(root, { ...input, patchText: invalid })).rejects.toThrow();
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("committed\n");
  expect(await readFile(join(root, "remove.txt"), "utf8")).toBe("remove\n");
});

test("git_apply_patch refuses local bytes hidden by index optimization flags", async () => {
  const root = await repository();
  const input = await editPatch(root);
  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    await git(root, ["update-index", `--${flag}`, "tracked.txt"]);
    await writeFile(join(root, "tracked.txt"), "local bytes hidden from status\n");
    expect(await git(root, ["status", "--porcelain=v1"])).toBe("");
    await expect(execute(root, input)).rejects.toThrow("bytes differ");
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("local bytes hidden from status\n");
    await git(root, ["update-index", `--no-${flag}`, "tracked.txt"]);
    await git(root, ["checkout", "--", "tracked.txt"]);
  }
});

test("git_apply_patch supports executable mode changes", async () => {
  const root = await repository();
  const expectedHead = (await git(root, ["rev-parse", "HEAD"])).trim();
  await chmod(join(root, "tracked.txt"), 0o755);
  const patchText = await git(root, ["diff", "--full-index"]);
  await git(root, ["checkout", "--", "tracked.txt"]);
  await execute(root, { patchText, expectedHead });
  expect((await lstat(join(root, "tracked.txt"))).mode & 0o111).toBe(0o111);
});

test("git_apply_patch fails closed on resource denials, scoped policies, and revocation", async () => {
  const root = await repository();
  const input = await editPatch(root);
  for (const overrides of [
    { currentResourceDenials: async () => ({ readPaths: [], writePaths: [join(root, "tracked.txt")] }) },
    { executionPolicy: { writeScope: ["tracked.txt"] } },
    { assertCurrentAuthorization: async () => { throw new Error("authorization revoked"); } },
    { assertFileResourceAccess: async () => { throw new Error("path denied"); } },
  ] satisfies Array<Partial<ChiliToolExecutionContext>>) {
    await expect(execute(root, input, overrides)).rejects.toThrow();
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("committed\n");
  }
});

test("git_apply_patch refuses configured filters without running them", async () => {
  const root = await repository();
  const input = await editPatch(root);
  await git(root, ["config", "filter.untrusted.clean", "touch filter-ran; cat"]);
  await writeFile(join(root, ".gitattributes"), "tracked.txt filter=untrusted\n");
  await expect(execute(root, input)).rejects.toThrow("configured repository filters");
  expect(await exists(join(root, "filter-ran"))).toBe(false);
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("committed\n");
});

test("git_apply_patch handles nested paths literally and verifies Git's parsed paths", async () => {
  const root = await repository();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "[name].txt"), "committed\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "--no-gpg-sign", "--no-verify", "-m", "nested"]);
  const expectedHead = (await git(root, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(root, "src", "[name].txt"), "changed\n");
  const patchText = await git(root, ["diff", "--full-index"]);
  await git(root, ["checkout", "--", "src/[name].txt"]);
  await execute(root, { patchText, expectedHead });
  expect(await readFile(join(root, "src", "[name].txt"), "utf8")).toBe("changed\n");
  await git(root, ["checkout", "--", "src/[name].txt"]);
  const mismatched = patchText.replace("+++ b/src/[name].txt", "+++ b/unexpected.txt");
  await expect(execute(root, { patchText: mismatched, expectedHead })).rejects.toThrow();
  expect(await exists(join(root, "unexpected.txt"))).toBe(false);
  expect(await readFile(join(root, "src", "[name].txt"), "utf8")).toBe("committed\n");
});

interface PatchResult { patchHash: string; paths: string[]; head: string; applicable: boolean; applied: boolean }

async function execute(cwd: string, input: GitApplyPatchInput, overrides: Partial<ChiliToolExecutionContext> = {}): Promise<PatchResult> {
  const tool = createGitApplyPatchTool();
  const validated = await tool.validate!(input);
  if (!validated.ok) throw new Error(validated.message);
  const callId = "git_patch_test" as ToolCallId;
  const context: ChiliToolExecutionContext = {
    sessionId: "git_patch_session" as SessionId, turnId: "git_patch_turn" as TurnId,
    callId, outputArtifactId: callId, cwd, signal: new AbortController().signal,
    metadata: async () => undefined, streamOutput: async () => undefined,
    registerPersistedOutput: async () => undefined,
    ...overrides,
  };
  return (await tool.execute(validated.value, context)).structuredData as unknown as PatchResult;
}

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "chili-git-patch-test-")));
  directories.push(path);
  return path;
}

async function repository(): Promise<string> {
  const root = await temporaryDirectory();
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "chili-test@example.com"]);
  await git(root, ["config", "user.name", "Chili Test"]);
  await git(root, ["config", "core.filemode", "true"]);
  await writeFile(join(root, "tracked.txt"), "committed\n");
  await writeFile(join(root, "remove.txt"), "remove\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "--no-gpg-sign", "--no-verify", "-m", "init"]);
  return root;
}

async function editPatch(root: string): Promise<GitApplyPatchInput> {
  const expectedHead = (await git(root, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(root, "tracked.txt"), "changed\n");
  const patchText = await git(root, ["diff", "--full-index"]);
  await git(root, ["checkout", "--", "tracked.txt"]);
  return { patchText, expectedHead };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000, maxOutputBytes: 256_000 });
  if (result.exitCode !== 0 || result.timedOut) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
