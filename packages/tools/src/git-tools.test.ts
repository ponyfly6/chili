import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChiliEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import {
  createGitBranchTool,
  createGitCommitTool,
  createGitDiffTool,
  createGitStageTool,
  createGitStatusTool,
} from "./builtins/git-diff.js";
import { ToolExecutor } from "./executor.js";
import { runProcess } from "./process.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ApprovalBrokerRequest, ExecuteToolInput } from "./types.js";

test("git_status separates staged, unstaged, and untracked changes", async () => {
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
    const result = await executor.execute(toolInput("git_status", {}, workspace));

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const status = JSON.parse(result.result.output) as GitStatusOutput;
    expect(status.clean).toBe(false);
    expect(status.staged).toEqual([expect.objectContaining({ path: "staged.txt", status: "added" })]);
    expect(status.unstaged).toEqual([expect.objectContaining({ path: "tracked.txt", status: "modified" })]);
    expect(status.untracked).toEqual([expect.objectContaining({ path: "untracked.txt", status: "untracked" })]);

    const unstagedDiff = await executor.execute(toolInput("git_diff", { path: "tracked.txt" }, workspace));
    expect(unstagedDiff.status).toBe("completed");
    if (unstagedDiff.status === "completed") {
      expect(unstagedDiff.result.output).toContain("-one");
      expect(unstagedDiff.result.output).toContain("+two");
    }

    const stagedDiff = await executor.execute(toolInput("git_diff", { staged: true, paths: ["staged.txt"] }, workspace));
    expect(stagedDiff.status).toBe("completed");
    if (stagedDiff.status === "completed") {
      expect(stagedDiff.result.output).toContain("staged.txt");
      expect(stagedDiff.result.metadata?.staged).toBe(true);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("git_stage and git_commit stage selected paths and create a local commit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-git-commit-"));
  const approvals: ApprovalBrokerRequest[] = [];
  try {
    await initRepo(workspace);
    await writeFile(join(workspace, "base.txt"), "base\n", "utf8");
    await git(workspace, ["add", "base.txt"]);
    await git(workspace, ["commit", "--no-gpg-sign", "--no-verify", "-m", "init"]);

    await writeFile(join(workspace, "next.txt"), "next\n", "utf8");
    const executor = createExecutor(approvals);

    const staged = await executor.execute(toolInput("git_stage", { paths: ["next.txt"] }, workspace));
    expect(staged.status).toBe("completed");
    if (staged.status === "completed") {
      const output = JSON.parse(staged.result.output) as { staged: GitStatusItem[] };
      expect(output.staged).toEqual([expect.objectContaining({ path: "next.txt", status: "added" })]);
    }

    const commit = await executor.execute(toolInput("git_commit", { message: "Add next file" }, workspace));
    expect(commit.status).toBe("completed");
    if (commit.status === "completed") {
      const output = JSON.parse(commit.result.output) as { hash: string; subject: string };
      expect(output.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(output.subject).toBe("Add next file");
    }

    const log = await git(workspace, ["log", "-1", "--pretty=%s"]);
    expect(log.stdout.trim()).toBe("Add next file");
    expect(approvals.map((approval) => approval.permission)).toContain("git_stage");
    expect(approvals.map((approval) => approval.permission)).toContain("git_commit");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("git_commit runs hooks by default and fails when a hook rejects the commit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-git-commit-hook-"));
  try {
    await initRepo(workspace);
    await writeFile(join(workspace, "base.txt"), "base\n", "utf8");
    await git(workspace, ["add", "base.txt"]);
    await git(workspace, ["commit", "--no-gpg-sign", "--no-verify", "-m", "init"]);

    const hookPath = join(workspace, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, "#!/bin/sh\necho pre-commit hook failed >&2\nexit 42\n", "utf8");
    await chmod(hookPath, 0o755);

    await writeFile(join(workspace, "next.txt"), "next\n", "utf8");
    await git(workspace, ["add", "next.txt"]);

    const executor = createExecutor();
    const commit = await executor.execute(toolInput("git_commit", { message: "Add next file" }, workspace));

    expect(commit.status).toBe("failed");
    if (commit.status === "failed") {
      expect(commit.error.message).toContain("pre-commit hook failed");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("git_branch reports current branch and safely creates and switches branches", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-git-branch-"));
  try {
    await initRepo(workspace);
    await writeFile(join(workspace, "base.txt"), "base\n", "utf8");
    await git(workspace, ["add", "base.txt"]);
    await git(workspace, ["commit", "--no-gpg-sign", "--no-verify", "-m", "init"]);

    const executor = createExecutor();
    const current = await executor.execute(toolInput("git_branch", {}, workspace));
    expect(current.status).toBe("completed");
    if (current.status !== "completed") return;
    const currentOutput = JSON.parse(current.result.output) as { current?: string; detached: boolean };
    expect(currentOutput.detached).toBe(false);
    expect(currentOutput.current).toBeTruthy();

    const created = await executor.execute(toolInput("git_branch", { action: "create", name: "codex/test" }, workspace));
    expect(created.status).toBe("completed");

    const listed = await executor.execute(toolInput("git_branch", { action: "list" }, workspace));
    expect(listed.status).toBe("completed");
    if (listed.status === "completed") {
      const output = JSON.parse(listed.result.output) as { branches?: string[] };
      expect(output.branches).toContain("codex/test");
    }

    const switched = await executor.execute(toolInput("git_branch", { action: "switch", name: "codex/test" }, workspace));
    expect(switched.status).toBe("completed");
    if (switched.status === "completed") {
      const output = JSON.parse(switched.result.output) as { after: { current?: string } };
      expect(output.after.current).toBe("codex/test");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("git tools fail clearly outside a git repository", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-git-missing-"));
  try {
    const executor = createExecutor();
    const result = await executor.execute(toolInput("git_status", {}, workspace));

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.message).toContain("Not a git repository");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("git tools reject dangerous or unsupported parameters", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-git-safety-"));
  try {
    await initRepo(workspace);
    const executor = createExecutor();

    const unsafePath = await executor.execute(toolInput("git_diff", { paths: ["../outside.txt"] }, workspace));
    expect(unsafePath.status).toBe("failed");
    if (unsafePath.status === "failed") expect(unsafePath.error.message).toContain("workspace");

    const unsafeBranch = await executor.execute(toolInput("git_branch", { action: "create", name: "-force" }, workspace));
    expect(unsafeBranch.status).toBe("failed");
    if (unsafeBranch.status === "failed") expect(unsafeBranch.error.message).toContain("safe local branch name");

    const unsupportedAction = await executor.execute(toolInput("git_branch", { action: "reset", name: "main" }, workspace));
    expect(unsupportedAction.status).toBe("failed");
    if (unsupportedAction.status === "failed") expect(unsupportedAction.error.message).toContain("action must be");

    const unsupportedFlag = await executor.execute(toolInput("git_stage", { all: true, force: true }, workspace));
    expect(unsupportedFlag.status).toBe("failed");
    if (unsupportedFlag.status === "failed") expect(unsupportedFlag.error.message).toContain("unsupported git_stage parameter");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

interface GitStatusItem {
  path: string;
  status: string;
  code: string;
}

interface GitStatusOutput {
  clean: boolean;
  staged: GitStatusItem[];
  unstaged: GitStatusItem[];
  untracked: GitStatusItem[];
}

function createExecutor(approvals: ApprovalBrokerRequest[] = []): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  registry.register(createGitStatusTool());
  registry.register(createGitDiffTool());
  registry.register(createGitStageTool());
  registry.register(createGitCommitTool());
  registry.register(createGitBranchTool());

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

function toolInput(toolName: string, input: unknown, cwd: string, callId?: ToolCallId): ExecuteToolInput {
  const value: ExecuteToolInput = {
    sessionId: "session_git_tools" as SessionId,
    turnId: "turn_git_tools" as TurnId,
    toolName,
    input,
    cwd,
  };
  if (callId) value.callId = callId;
  return value;
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.email", "chili-test@example.com"]);
  await git(cwd, ["config", "user.name", "Chili Test"]);
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
