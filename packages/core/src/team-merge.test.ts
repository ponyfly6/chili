import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, SessionId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { runProcess } from "@chili/tools";
import { TeamMergeService, type TeamMergeGitRunnerResult } from "./team-merge.js";
import { TeamControlService } from "./team.js";
import { taskMergeMetadata, TeamWorktreeService } from "./team-worktree.js";

test("applies a verifier-passed pending worktree merge to the main workspace", async () => {
  const context = await createPendingMergeContext("chili-team-merge-applied-");

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");

    const result = await context.merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });

    expect(result).toMatchObject({
      scanned: 1,
      applied: [{ status: "applied", teamTask: { id: context.taskId } }],
      failed: [],
      conflicted: [],
      skipped: [],
      errors: [],
    });
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 2;\n");
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(taskMergeMetadata(storedTask?.metadata)).toMatchObject({
      status: "applied",
      mergedAt: 2000,
      diffSummary: { filesChanged: 1 },
    });
    expect(taskMergeMetadata(storedTask?.metadata)?.diff).toContain("export const value = 2;");

    const repeated = await context.merger.mergeTeamTasks({
      teamId: context.teamId,
      taskId: context.taskId,
      cwd: context.dir,
    });
    expect(repeated).toMatchObject({
      scanned: 0,
      applied: [],
      skipped: [{ status: "skipped", reason: "not_pending", teamTask: { id: context.taskId } }],
      errors: [],
    });
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 2;\n");
  } finally {
    await context.close();
  }
});

test("marks a merge conflicted without changing dirty main workspace files", async () => {
  const context = await createPendingMergeContext("chili-team-merge-conflict-");

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    await writeFile(join(context.dir, "packages/core/src/feature.ts"), "export const value = 99;\n");

    const result = await context.merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });

    expect(result).toMatchObject({
      scanned: 1,
      applied: [],
      conflicted: [{ status: "conflicted", teamTask: { id: context.taskId } }],
      errors: [],
    });
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 99;\n");
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(taskMergeMetadata(storedTask?.metadata)).toMatchObject({
      status: "conflicted",
      error: "Main workspace has local changes in files touched by the task patch",
    });
    expect(taskMergeMetadata(storedTask?.metadata)?.conflicts?.[0]).toContain("packages/core/src/feature.ts");
  } finally {
    await context.close();
  }
});

test("marks a pending merge skipped when the task worktree is missing", async () => {
  const context = await createPendingMergeContext("chili-team-merge-missing-");

  try {
    await rm(context.worktreePath, { recursive: true, force: true });

    const result = await context.merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });

    expect(result).toMatchObject({
      scanned: 1,
      applied: [],
      skipped: [{ status: "skipped", reason: "missing_worktree", teamTask: { id: context.taskId } }],
      errors: [],
    });
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(taskMergeMetadata(storedTask?.metadata)).toMatchObject({
      status: "skipped",
      reason: "missing_worktree",
    });
    expect(taskMergeMetadata(storedTask?.metadata)?.error).toContain("Task worktree is missing");
  } finally {
    await context.close();
  }
});

test("applies staged and untracked worktree changes in the merge diff", async () => {
  const context = await createPendingMergeContext("chili-team-merge-mixed-");

  try {
    await writeFile(join(context.worktreePath, "docs/readme.md"), "# docs\n\nstaged docs change\n");
    await git(context.worktreePath, ["add", "docs/readme.md"]);
    await writeFile(join(context.worktreePath, "packages/core/src/new-feature.ts"), "export const created = true;\n");

    const result = await context.merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });

    expect(result.applied).toMatchObject([{ status: "applied", diffSummary: { filesChanged: 2 } }]);
    expect(await readFile(join(context.dir, "docs/readme.md"), "utf8")).toContain("staged docs change");
    expect(await readFile(join(context.dir, "packages/core/src/new-feature.ts"), "utf8")).toBe("export const created = true;\n");
    const [storedTask] = await context.teams.tasks(context.teamId);
    const diff = taskMergeMetadata(storedTask?.metadata)?.diff ?? "";
    expect(diff).toContain("staged docs change");
    expect(diff).toContain("packages/core/src/new-feature.ts");
  } finally {
    await context.close();
  }
});

test("prechecks pending merge patches concurrently before serial apply", async () => {
  const context = await createPendingMergeContext("chili-team-merge-precheck-");
  const now = () => 2000 as TimestampMs;
  let runningDiffs = 0;
  let maxRunningDiffs = 0;

  try {
    const worktrees = new TeamWorktreeService({ teams: context.teams, cwd: context.dir, now });
    const second = await context.teams.createTask({
      sessionId: context.sessionId,
      teamId: context.teamId,
      title: "Merge docs worktree",
      ownerPath: "/root/worker" as AgentPath,
      metadata: { writeScope: ["docs"] },
    });
    const secondWorktree = await worktrees.ensureTaskWorktree({
      teamId: context.teamId,
      taskId: second.id,
      sessionId: context.sessionId,
      cwd: context.dir,
    });
    await context.teams.updateTask({
      sessionId: context.sessionId,
      teamId: context.teamId,
      taskId: second.id,
      status: "completed",
      summary: "Docs completed",
      metadata: {
        ...(secondWorktree.task.metadata ?? {}),
        verification: { status: "passed", gitDiff: "(pending merge)" },
        merge: {
          status: "pending",
          createdAt: 2000,
          worktreePath: secondWorktree.path,
          baseRef: secondWorktree.baseRef,
          diff: "(pending merge)",
        },
      },
    });
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    await writeFile(join(secondWorktree.path, "docs/readme.md"), "# docs\n\nmerged docs\n");

    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      now,
      runGit: async (input): Promise<TeamMergeGitRunnerResult> => {
        const isWorktreeHeadDiff = input.args[0] === "diff" && input.args.includes("HEAD") && input.cwd.includes(".chili/worktrees");
        if (isWorktreeHeadDiff) {
          runningDiffs++;
          maxRunningDiffs = Math.max(maxRunningDiffs, runningDiffs);
          await delay(20);
        }
        try {
          return await runProcess("git", input.args, {
            cwd: input.cwd,
            ...(input.signal ? { signal: input.signal } : {}),
            timeoutMs: input.timeoutMs ?? 30_000,
            maxOutputBytes: input.maxOutputBytes ?? 5_000_000,
          });
        } finally {
          if (isWorktreeHeadDiff) runningDiffs--;
        }
      },
    });

    const result = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });

    expect(result.applied.map((item) => item.teamTask.id).sort()).toEqual([context.taskId, second.id].sort());
    expect(result.conflicted).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(maxRunningDiffs).toBeGreaterThan(1);
  } finally {
    await context.close();
  }
});

async function createPendingMergeContext(prefix: string): Promise<{
  dir: string;
  store: SqliteEventStore;
  teams: TeamControlService;
  merger: TeamMergeService;
  teamId: import("@chili/protocol").TeamId;
  taskId: import("@chili/protocol").TaskId;
  sessionId: SessionId;
  worktreePath: string;
  close(): Promise<void>;
}> {
  const dir = await mkGitRepo(prefix);
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 2000 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_merge" as SessionId;
  const teams = new TeamControlService({ store, createId: ids, now });
  const worktrees = new TeamWorktreeService({ teams, cwd: dir, now });
  const merger = new TeamMergeService({ teams, cwd: dir, now });
  const team = await teams.createTeam({ sessionId, name: "merge", leadPath });
  await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer", writeScope: ["packages/core", "docs"] });
  const task = await teams.createTask({
    sessionId,
    teamId: team.id,
    title: "Merge worktree",
    ownerPath: workerPath,
    metadata: { writeScope: ["packages/core", "docs"] },
  });
  const worktree = await worktrees.ensureTaskWorktree({ teamId: team.id, taskId: task.id, sessionId, cwd: dir });
  const completed = await teams.updateTask({
    sessionId,
    teamId: team.id,
    taskId: task.id,
    status: "completed",
    summary: "Worker completed",
    metadata: {
      ...(worktree.task.metadata ?? {}),
      verification: { status: "passed", gitDiff: "(pending merge)" },
      merge: {
        status: "pending",
        createdAt: 2000,
        worktreePath: worktree.path,
        baseRef: worktree.baseRef,
        diff: "(pending merge)",
      },
    },
  });

  return {
    dir,
    store,
    teams,
    merger,
    teamId: team.id,
    taskId: completed.id,
    sessionId,
    worktreePath: worktree.path,
    close: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
