import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChiliEvent, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { createBashTool } from "./builtins/bash.js";
import { ToolExecutor } from "./executor.js";
import { runProcess } from "./process.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ApprovalBrokerRequest } from "./types.js";

test("bash exposes Git status and both staged and unstaged diffs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-git-status-"));
  try {
    await initRepo(workspace);
    await writeFile(join(workspace, "tracked.txt"), "one\n", "utf8");
    await git(workspace, ["add", "tracked.txt"]);
    await git(workspace, ["commit", "--no-gpg-sign", "--no-verify", "-m", "init"]);

    await writeFile(join(workspace, "tracked.txt"), "two\n", "utf8");
    await writeFile(join(workspace, "staged.txt"), "staged\n", "utf8");
    await writeFile(join(workspace, "untracked.txt"), "loose\n", "utf8");
    await git(workspace, ["add", "staged.txt"]);

    const executor = createExecutor();
    const status = await bash(executor, workspace, "git status --porcelain=v1");
    expect(status.exitCode).toBe(0);
    expect(status.stdout.split("\n")).toEqual(expect.arrayContaining([
      "A  staged.txt", " M tracked.txt", "?? untracked.txt",
    ]));

    const unstaged = await bash(executor, workspace, "git diff --no-ext-diff -- tracked.txt");
    expect(unstaged.exitCode).toBe(0);
    expect(unstaged.stdout).toContain("-one");
    expect(unstaged.stdout).toContain("+two");

    const staged = await bash(executor, workspace, "git diff --no-ext-diff --cached -- staged.txt");
    expect(staged.exitCode).toBe(0);
    expect(staged.stdout).toContain("staged.txt");
    expect(staged.stdout).toContain("+staged");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash stages selected paths and commits without changing unrelated work or adding a trailer", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-git-commit-"));
  const approvals: ApprovalBrokerRequest[] = [];
  try {
    await initRepo(workspace);
    await writeFile(join(workspace, "base.txt"), "base\n", "utf8");
    await git(workspace, ["add", "base.txt"]);
    await git(workspace, ["commit", "--no-gpg-sign", "--no-verify", "-m", "init"]);

    await writeFile(join(workspace, "base.txt"), "unrelated edit\n", "utf8");
    await writeFile(join(workspace, "next.txt"), "next\n", "utf8");
    await writeFile(join(workspace, "untracked.txt"), "unrelated file\n", "utf8");
    const executor = createExecutor(approvals);

    expect((await bash(executor, workspace, "git add -- next.txt")).exitCode).toBe(0);
    expect((await git(workspace, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("next.txt");

    const commit = await bash(executor, workspace, "git commit -m 'Add next file'");
    expect(commit.exitCode).toBe(0);
    expect((await git(workspace, ["log", "-1", "--pretty=%B"])).stdout.trim()).toBe("Add next file");
    expect((await git(workspace, ["show", "--pretty=", "--name-only", "HEAD"])).stdout.trim()).toBe("next.txt");
    expect((await git(workspace, ["status", "--porcelain=v1"])).stdout.split("\n")).toEqual(expect.arrayContaining([
      " M base.txt", "?? untracked.txt",
    ]));
    expect(approvals).toEqual(expect.arrayContaining([
      expect.objectContaining({ permission: "bash", patterns: ["git add -- next.txt"] }),
      expect.objectContaining({ permission: "bash", patterns: ["git commit -m 'Add next file'"] }),
    ]));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash preserves a rejected commit hook's error and leaves HEAD unchanged", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-git-commit-hook-"));
  try {
    await initRepo(workspace);
    await writeFile(join(workspace, "base.txt"), "base\n", "utf8");
    await git(workspace, ["add", "base.txt"]);
    await git(workspace, ["commit", "--no-gpg-sign", "--no-verify", "-m", "init"]);
    const before = (await git(workspace, ["rev-parse", "HEAD"])).stdout;

    const hookPath = join(workspace, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, "#!/bin/sh\necho pre-commit hook failed >&2\nexit 42\n", "utf8");
    await chmod(hookPath, 0o755);
    await writeFile(join(workspace, "next.txt"), "next\n", "utf8");
    await git(workspace, ["add", "next.txt"]);

    const commit = await bash(createExecutor(), workspace, "git commit -m 'Add next file'");
    expect(commit.exitCode).not.toBe(0);
    expect(commit.stderr).toContain("pre-commit hook failed");
    expect((await git(workspace, ["rev-parse", "HEAD"])).stdout).toBe(before);
    expect((await git(workspace, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("next.txt");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash respects configured commit signing instead of silently disabling it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-git-signing-"));
  try {
    await initRepo(workspace);
    const signerPath = join(workspace, ".git", "reject-signing");
    await writeFile(signerPath, "#!/bin/sh\necho test signing command invoked >&2\nexit 1\n", "utf8");
    await chmod(signerPath, 0o755);
    await git(workspace, ["config", "commit.gpgsign", "true"]);
    await git(workspace, ["config", "gpg.format", "openpgp"]);
    await git(workspace, ["config", "gpg.program", signerPath]);
    await git(workspace, ["config", "user.signingkey", "chili-test"]);
    await writeFile(join(workspace, "next.txt"), "next\n", "utf8");
    await git(workspace, ["add", "next.txt"]);

    const commit = await bash(createExecutor(), workspace, "git commit -m 'Signed commit'");
    expect(commit.exitCode).not.toBe(0);
    expect(commit.stderr).toContain("test signing command invoked");
    expect((await git(workspace, ["config", "commit.gpgsign"])).stdout.trim()).toBe("true");
    expect((await git(workspace, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("next.txt");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash reports, creates, lists, and switches Git branches", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-git-branch-"));
  try {
    await initRepo(workspace);
    await writeFile(join(workspace, "base.txt"), "base\n", "utf8");
    await git(workspace, ["add", "base.txt"]);
    await git(workspace, ["commit", "--no-gpg-sign", "--no-verify", "-m", "init"]);

    const executor = createExecutor();
    const current = await bash(executor, workspace, "git branch --show-current");
    expect(current.exitCode).toBe(0);
    expect(current.stdout.trim()).toBeTruthy();
    expect((await bash(executor, workspace, "git branch codex/test")).exitCode).toBe(0);
    const listed = await bash(executor, workspace, "git branch --format='%(refname:short)'");
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.split("\n")).toContain("codex/test");
    expect((await bash(executor, workspace, "git switch codex/test")).exitCode).toBe(0);
    expect((await bash(executor, workspace, "git branch --show-current")).stdout.trim()).toBe("codex/test");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash preserves Git's nonzero exit status and error outside a repository", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-git-missing-"));
  try {
    const result = await bash(createExecutor(), workspace, "git status --porcelain=v1");
    expect(result.exitCode).toBe(128);
    expect(result.stderr).toContain("not a git repository");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function createExecutor(approvals: ApprovalBrokerRequest[] = []): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  registry.register(createBashTool());

  return new ToolExecutor({
    registry,
    events: { publish: async (_event: ChiliEvent) => undefined },
    approvals: {
      decide: async (request) => {
        approvals.push(request);
        return { action: "allow_once" };
      },
    },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
}

async function bash(executor: ToolExecutor, cwd: string, command: string) {
  const result = await executor.execute({
    sessionId: "session_git_tools" as SessionId,
    turnId: "turn_git_tools" as TurnId,
    toolName: "bash",
    input: { command },
    cwd,
  });
  expect(result.status).toBe("completed");
  if (result.status !== "completed") throw new Error(`Bash tool failed: ${JSON.stringify(result)}`);
  return result.result.structuredData as { stdout: string; stderr: string; exitCode: number };
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.email", "chili-test@example.com"]);
  await git(cwd, ["config", "user.name", "Chili Test"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);
  await git(cwd, ["config", "core.hooksPath", join(cwd, ".git", "hooks")]);
}

async function git(cwd: string, args: readonly string[]) {
  const result = await runProcess("git", args, {
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: 256_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} exited with code ${result.exitCode}`);
  }
  return result;
}
