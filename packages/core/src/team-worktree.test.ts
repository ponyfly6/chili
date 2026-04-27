import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, SessionId, TaskId, TimestampMs, ThreadId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { runProcess } from "@chili/tools";
import { LocalSubagentManager, type LocalSubagentRunInput, type LocalSubagentRunResult, type LocalSubagentRunner } from "./subagent.js";
import { TeamTaskDispatchService, type TeamTaskWorktreeManager } from "./team-dispatcher.js";
import { TeamControlService } from "./team.js";
import { TeamTaskVerificationService } from "./team-verifier.js";
import { TeamWorktreeService, taskMergeMetadata, worktreeMetadata } from "./team-worktree.js";

test("writing task dispatch runs the worker in an isolated worktree", async () => {
  const dir = await mkGitRepo("chili-team-worktree-writing-");
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1300 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_worktree_writing" as SessionId;
  const threadId = "thread_team_worktree_writing" as ThreadId;
  const runner = new WritingRunner("packages/core/src/feature.ts", "export const value = 2;\n");

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const worktrees = new TeamWorktreeService({ teams, cwd: dir, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, worktrees, cwd: dir, now });
    const team = await teams.createTeam({ sessionId, threadId, name: "worktree-writing", leadPath });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: workerPath, name: "worker", role: "implementer", writeScope: ["packages/core"] });
    const task = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Write isolated feature",
      ownerPath: workerPath,
      metadata: { writeScope: ["packages/core"], requiredTools: ["edit"] },
    });

    const result = await dispatcher.dispatchTask({ teamId: team.id, taskId: task.id, mode: "one_shot", sessionId, threadId, cwd: dir });

    const metadata = worktreeMetadata(result.teamTask.metadata);
    expect(metadata).toMatchObject({ status: "active", baseRef: "HEAD", createdAt: 1300 });
    expect(runner.runs[0]?.cwd).toBe(metadata?.path);
    expect(runner.runs[0]?.prompt).toContain("Isolated worktree:");
    expect(await readFile(join(dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(await readFile(join(metadata?.path ?? "", "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 2;\n");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("readonly task dispatch keeps the worker in the main workspace", async () => {
  const dir = await mkGitRepo("chili-team-worktree-readonly-");
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1310 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/reader" as AgentPath;
  const sessionId = "session_team_worktree_readonly" as SessionId;
  const runner = new CapturingRunner();
  const worktrees: TeamTaskWorktreeManager = {
    async ensureTaskWorktree() {
      throw new Error("readonly task should not create a worktree");
    },
  };

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, worktrees, cwd: dir, now });
    const team = await teams.createTeam({ sessionId, name: "worktree-readonly", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "reader", role: "reviewer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Read only", ownerPath: workerPath });

    const result = await dispatcher.dispatchTask({ teamId: team.id, taskId: task.id, mode: "one_shot", sessionId, cwd: dir });

    expect(result.status).toBe("completed");
    expect(runner.runs[0]?.cwd).toBe(dir);
    expect(worktreeMetadata(result.teamTask.metadata)).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("different writing tasks can run with different task worktrees", async () => {
  const dir = await mkGitRepo("chili-team-worktree-parallel-");
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1320 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const corePath = "/root/core" as AgentPath;
  const docsPath = "/root/docs" as AgentPath;
  const sessionId = "session_team_worktree_parallel" as SessionId;
  const runner = new HoldingRunner();
  let subagents: LocalSubagentManager | undefined;

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const worktrees = new TeamWorktreeService({ teams, cwd: dir, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, worktrees, cwd: dir, now });
    const team = await teams.createTeam({ sessionId, name: "worktree-parallel", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: corePath, name: "core", role: "implementer", writeScope: ["packages/core"] });
    await teams.addMember({ sessionId, teamId: team.id, path: docsPath, name: "docs", role: "implementer", writeScope: ["docs"] });
    const coreTask = await teams.createTask({ sessionId, teamId: team.id, title: "Core write", ownerPath: corePath, metadata: { writeScope: ["packages/core"] } });
    const docsTask = await teams.createTask({ sessionId, teamId: team.id, title: "Docs write", ownerPath: docsPath, metadata: { writeScope: ["docs"] } });

    const first = await dispatcher.dispatchTask({ teamId: team.id, taskId: coreTask.id, mode: "background", sessionId, cwd: dir });
    const second = await dispatcher.dispatchTask({ teamId: team.id, taskId: docsTask.id, mode: "background", sessionId, cwd: dir });

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    expect(worktreeMetadata(first.teamTask.metadata)?.path).toBe(runner.runs[0]?.cwd);
    expect(worktreeMetadata(second.teamTask.metadata)?.path).toBe(runner.runs[1]?.cwd);
    expect(runner.runs[0]?.cwd).not.toBe(runner.runs[1]?.cwd);
  } finally {
    runner.completeAll();
    await subagents?.waitForBackgroundTasks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("worktree creation failure blocks the task with a clear error", async () => {
  const dir = await mkGitRepo("chili-team-worktree-failure-");
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1330 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_worktree_failure" as SessionId;
  const runner = new CapturingRunner();
  const worktrees: TeamTaskWorktreeManager = {
    async ensureTaskWorktree() {
      throw new Error("git worktree add failed");
    },
  };

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, worktrees, cwd: dir, now });
    const team = await teams.createTeam({ sessionId, name: "worktree-failure", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer", writeScope: ["packages/core"] });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Cannot isolate", ownerPath: workerPath, metadata: { writeScope: ["packages/core"] } });

    const result = await dispatcher.dispatchTask({ teamId: team.id, taskId: task.id, mode: "one_shot", sessionId, cwd: dir });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "blocked",
      teamTask: { id: task.id, status: "blocked", error: "worktree_failed: git worktree add failed" },
    });
    expect(runner.runs).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier uses the task worktree and records pending merge diff without touching main workspace", async () => {
  const dir = await mkGitRepo("chili-team-worktree-verifier-");
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1340 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_worktree_verifier" as SessionId;
  const threadId = "thread_team_worktree_verifier" as ThreadId;
  const runner = new WritingThenVerifyingRunner("packages/core/src/feature.ts", "export const value = 42;\n");

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const worktrees = new TeamWorktreeService({ teams, cwd: dir, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, worktrees, cwd: dir, now });
    const verifier = new TeamTaskVerificationService({ teams, subagents, cwd: dir, now });
    const team = await teams.createTeam({ sessionId, threadId, name: "worktree-verifier", leadPath });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: workerPath, name: "worker", role: "implementer", writeScope: ["packages/core"] });
    const task = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Implement isolated change",
      ownerPath: workerPath,
      metadata: {
        writeScope: ["packages/core"],
        suggestedTestCommands: ["bun test packages/core/src/team-worktree.test.ts"],
      },
    });

    const dispatched = await dispatcher.dispatchTask({ teamId: team.id, taskId: task.id, mode: "one_shot", sessionId, threadId, cwd: dir });
    const worktree = worktreeMetadata(dispatched.teamTask.metadata);
    if (!worktree) throw new Error("expected task worktree metadata");
    expect(await readFile(join(worktree.path, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 42;\n");
    const directDiff = await runProcess("git", ["diff", "--no-ext-diff", "--no-color"], {
      cwd: worktree.path,
      timeoutMs: 30_000,
      maxOutputBytes: 128_000,
    });
    expect(directDiff.stdout).toContain("export const value = 42;");
    const verified = await verifier.verifyCompletedTasks({ teamId: team.id, sessionId, threadId, cwd: dir });

    expect(verified.verified).toMatchObject([{ status: "passed" }]);
    expect(runner.runs.map((run) => run.cwd)).toEqual([worktree.path, worktree.path]);
    expect(runner.runs[1]?.prompt).toContain(`Isolated worktree: ${worktree.path}`);
    expect(await readFile(join(dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 1;\n");
    const [storedTask] = await teams.tasks(team.id);
    expect(taskMergeMetadata(storedTask?.metadata)).toMatchObject({
      status: "pending",
      worktreePath: worktree.path,
      baseRef: "HEAD",
    });
    expect(taskMergeMetadata(storedTask?.metadata)?.diff).toContain("export const value = 42;");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class WritingRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];

  constructor(
    private readonly path: string,
    private readonly content: string,
  ) {}

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    await writeFile(join(input.cwd, this.path), this.content);
    return { status: "completed", summary: `Wrote ${this.path}` };
  }
}

class WritingThenVerifyingRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];

  constructor(
    private readonly path: string,
    private readonly content: string,
  ) {}

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    if (input.taskName.startsWith("Verify ")) return { status: "completed", summary: "VERDICT: passed\nDiff looks good." };
    await writeFile(join(input.cwd, this.path), this.content);
    return { status: "completed", summary: `Wrote ${this.path}` };
  }
}

class CapturingRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    return { status: "completed", summary: `Done ${input.taskName}` };
  }
}

class HoldingRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];
  private readonly completions: Array<() => void> = [];

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    await new Promise<void>((resolve) => this.completions.push(resolve));
    return { status: "completed", summary: `Done ${input.taskName}` };
  }

  completeAll(): void {
    while (this.completions.length > 0) this.completions.shift()?.();
  }
}

async function mkGitRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, "packages/core/src"), { recursive: true });
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "packages/core/src/feature.ts"), "export const value = 1;\n");
  await writeFile(join(dir, "docs/readme.md"), "# docs\n");
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000, maxOutputBytes: 128_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix: string) => `${prefix}_${++next}`;
}
