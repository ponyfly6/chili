import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, SessionId, TaskId, TeamId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { runProcess } from "@chili/tools";
import { LocalSubagentManager, type LocalSubagentRunInput, type LocalSubagentRunResult, type LocalSubagentRunner } from "./subagent.js";
import {
  RuntimeBusyError,
  type RuntimeSessionOperation,
  type SessionOperationCoordinator,
} from "./runtime-service.js";
import { TeamTaskDispatchService, type TeamTaskWorktreeManager } from "./team-dispatcher.js";
import { TeamExecutionRunner } from "./team-execution-runner.js";
import { TeamSessionAuthorityError } from "./team-session-authority.js";
import { TeamControlService } from "./team.js";
import { TeamTaskVerificationService } from "./team-verifier.js";
import {
  assertTeamTaskWorktreePath,
  preflightTeamTaskWorktree,
  TeamTaskWorktreePathError,
  TeamWorktreeService,
  taskMergeMetadata,
  worktreeMetadata,
} from "./team-worktree.js";

test("writing task dispatch runs the worker in an isolated worktree", async () => {
  const dir = await mkGitRepo("chili-team-worktree-writing-");
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1300 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_worktree_writing" as SessionId;
  const runner = new WritingRunner("packages/core/src/feature.ts", "export const value = 2;\n");

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const worktrees = new TeamWorktreeService({
      teams,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      worktrees,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const team = await teams.createTeam({ sessionId, name: "worktree-writing", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer", writeScope: ["packages/core"] });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Write isolated feature",
      ownerPath: workerPath,
      metadata: { writeScope: ["packages/core"], requiredTools: ["edit"] },
    });

    const result = await dispatcher.dispatchTask({ teamId: team.id, taskId: task.id, mode: "one_shot", sessionId, cwd: dir });

    const metadata = worktreeMetadata(result.teamTask.metadata);
    expect(metadata).toMatchObject({ status: "active", createdAt: 1300 });
    expect(metadata?.baseRef).toMatch(/^[0-9a-f]{40}$/);
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
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      worktrees,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const team = await teams.createTeam({ sessionId, name: "worktree-readonly", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "reader", role: "reviewer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Read only", ownerPath: workerPath });

    const result = await dispatcher.dispatchTask({ teamId: team.id, taskId: task.id, mode: "one_shot", sessionId, cwd: dir });

    expect(result.status).toBe("completed");
    expect(runner.runs[0]?.cwd).toBe(await realpath(dir));
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
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const worktrees = new TeamWorktreeService({
      teams,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      worktrees,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const team = await teams.createTeam({ sessionId, name: "worktree-parallel", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: corePath, name: "core", role: "implementer", writeScope: ["packages/core"] });
    await teams.addMember({ sessionId, teamId: team.id, path: docsPath, name: "docs", role: "implementer", writeScope: ["docs"] });
    const coreTask = await teams.createTask({ sessionId, teamId: team.id, title: "Core write", ownerPath: corePath, metadata: { writeScope: ["packages/core"] } });
    const docsTask = await teams.createTask({ sessionId, teamId: team.id, title: "Docs write", ownerPath: docsPath, metadata: { writeScope: ["docs"] } });

    const first = await dispatcher.dispatchTask({ teamId: team.id, taskId: coreTask.id, mode: "background", sessionId, cwd: dir });
    const second = await dispatcher.dispatchTask({ teamId: team.id, taskId: docsTask.id, mode: "background", sessionId, cwd: dir });
    await runner.waitForRuns(2);

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

test("worktree preflight rejects absolute, traversal, external symlink, and sibling symlink metadata before git", async () => {
  const dir = await mkGitRepo("chili-team-worktree-path-authority-");
  const workspaceB = await mkdtemp(join(tmpdir(), "chili-team-worktree-path-b-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1322 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_worktree_path_authority" as SessionId;
  let gitCalls = 0;

  try {
    const canonicalDir = await realpath(dir);
    const canonicalB = await realpath(workspaceB);
    await persistRootSession(store, sessionId, canonicalDir);
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ sessionId, name: "worktree-path-authority", leadPath });
    await teams.addMember({
      sessionId,
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      writeScope: ["packages/core"],
    });
    const worktrees = new TeamWorktreeService({
      teams,
      cwd: canonicalDir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
      runGit: async () => {
        gitCalls++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const managedTeamRoot = join(canonicalDir, ".chili", "worktrees", String(team.id));
    await mkdir(managedTeamRoot, { recursive: true });
    const siblingTarget = join(managedTeamRoot, "sibling-target");
    await mkdir(siblingTarget, { recursive: true });

    const cases: Array<{ title: string; pathFor(taskId: TaskId): Promise<string> | string }> = [
      { title: "absolute workspace B", pathFor: () => canonicalB },
      { title: "relative traversal", pathFor: () => "../../../workspace-b" },
      {
        title: "external symlink",
        pathFor: async (taskId) => {
          const expected = join(managedTeamRoot, String(taskId));
          await symlink(canonicalB, expected, "dir");
          return expected;
        },
      },
      {
        title: "sibling symlink alias",
        pathFor: async (taskId) => {
          const expected = join(managedTeamRoot, String(taskId));
          await symlink(siblingTarget, expected, "dir");
          return expected;
        },
      },
    ];

    for (const item of cases) {
      const task = await teams.createTask({
        sessionId,
        teamId: team.id,
        title: item.title,
        ownerPath: workerPath,
        metadata: { writeScope: ["packages/core"] },
      });
      const forgedPath = await item.pathFor(task.id);
      const forged = await teams.updateTask({
        sessionId,
        teamId: team.id,
        taskId: task.id,
        metadata: {
          ...(task.metadata ?? {}),
          worktree: { path: forgedPath, baseRef: "a".repeat(40), createdAt: 1322, status: "active" },
        },
      });

      await expect(preflightTeamTaskWorktree({
        cwd: canonicalDir,
        teamId: team.id,
        taskId: task.id,
        metadata: forged.metadata,
        requireExisting: true,
      })).rejects.toBeInstanceOf(TeamTaskWorktreePathError);
      await expect(worktrees.ensureTaskWorktree({
        teamId: team.id,
        taskId: task.id,
        sessionId,
        cwd: canonicalDir,
      })).rejects.toBeInstanceOf(TeamTaskWorktreePathError);
    }

    expect(gitCalls).toBe(0);
  } finally {
    store.close();
    await rm(workspaceB, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("worktree path encoding is injective while preserving existing safe identifiers", async () => {
  const dir = await mkGitRepo("chili-team-worktree-path-identity-");

  try {
    const canonicalDir = await realpath(dir);
    const taskId = "task.safe_1-2" as TaskId;
    const safePath = await assertTeamTaskWorktreePath({
      cwd: canonicalDir,
      teamId: "team.safe_1-2" as TeamId,
      taskId,
    });
    expect(safePath).toBe(join(
      canonicalDir,
      ".chili",
      "worktrees",
      "team.safe_1-2",
      "task.safe_1-2",
    ));

    const colonTaskPath = await assertTeamTaskWorktreePath({
      cwd: canonicalDir,
      teamId: "team" as TeamId,
      taskId: "a:b" as TaskId,
    });
    const underscoreTaskPath = await assertTeamTaskWorktreePath({
      cwd: canonicalDir,
      teamId: "team" as TeamId,
      taskId: "a_b" as TaskId,
    });
    expect(colonTaskPath).not.toBe(underscoreTaskPath);
    expect(colonTaskPath).toBe(join(
      canonicalDir,
      ".chili",
      "worktrees",
      "team",
      `~u${Buffer.from("a:b", "utf16le").toString("base64url")}`,
    ));

    const colonTeamPath = await assertTeamTaskWorktreePath({
      cwd: canonicalDir,
      teamId: "a:b" as TeamId,
      taskId,
    });
    const underscoreTeamPath = await assertTeamTaskWorktreePath({
      cwd: canonicalDir,
      teamId: "a_b" as TeamId,
      taskId,
    });
    expect(colonTeamPath).not.toBe(underscoreTeamPath);

    const highSurrogatePath = await assertTeamTaskWorktreePath({
      cwd: canonicalDir,
      teamId: "team" as TeamId,
      taskId: "\ud800" as TaskId,
    });
    const replacementCharacterPath = await assertTeamTaskWorktreePath({
      cwd: canonicalDir,
      teamId: "team" as TeamId,
      taskId: "\ufffd" as TaskId,
    });
    expect(highSurrogatePath).not.toBe(replacementCharacterPath);
    expect(highSurrogatePath).toEndWith(
      `/~u${Buffer.from("\ud800", "utf16le").toString("base64url")}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worktree metadata accepts only a full immutable commit object ID", () => {
  const base = { path: "/workspace/.chili/worktrees/team/task", createdAt: 1, status: "active" as const };
  expect(worktreeMetadata({ worktree: { ...base, baseRef: "HEAD" } })).toBeUndefined();
  expect(worktreeMetadata({ worktree: { ...base, baseRef: "a".repeat(39) } })).toBeUndefined();
  expect(worktreeMetadata({ worktree: { ...base, baseRef: "a".repeat(41) } })).toBeUndefined();
  expect(worktreeMetadata({ worktree: { ...base, baseRef: "A".repeat(40) } })).toEqual({
    ...base,
    baseRef: "a".repeat(40),
  });
  expect(worktreeMetadata({ worktree: { ...base, baseRef: "b".repeat(64) } })?.baseRef).toBe(
    "b".repeat(64),
  );
});

test("worktree path encoding rejects overlong literal and encoded identifiers without creating paths", async () => {
  const dir = await mkGitRepo("chili-team-worktree-path-too-long-");

  try {
    const canonicalDir = await realpath(dir);
    await expect(assertTeamTaskWorktreePath({
      cwd: canonicalDir,
      teamId: "team" as TeamId,
      taskId: "a".repeat(256) as TaskId,
    })).rejects.toBeInstanceOf(TeamTaskWorktreePathError);
    await expect(assertTeamTaskWorktreePath({
      cwd: canonicalDir,
      teamId: "team" as TeamId,
      taskId: ":".repeat(100) as TaskId,
    })).rejects.toBeInstanceOf(TeamTaskWorktreePathError);
    expect(await pathExists(join(canonicalDir, ".chili"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formerly colliding task identifiers create concurrently and reuse their exact worktrees", async () => {
  const dir = await mkGitRepo("chili-team-worktree-path-concurrent-");
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_team_worktree_path_concurrent" as SessionId;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: createSequentialId() });
    const team = await teams.createTeam({ sessionId, name: "path-concurrent", leadPath });
    const colonTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      taskId: "a:b" as TaskId,
      title: "Colon task",
      ownerPath: workerPath,
    });
    const underscoreTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      taskId: "a_b" as TaskId,
      title: "Underscore task",
      ownerPath: workerPath,
    });
    const worktrees = new TeamWorktreeService({
      teams,
      cwd: dir,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });

    const created = await Promise.all([
      worktrees.ensureTaskWorktree({ teamId: team.id, taskId: colonTask.id, sessionId }),
      worktrees.ensureTaskWorktree({ teamId: team.id, taskId: underscoreTask.id, sessionId }),
    ]);
    expect(created.map((item) => item.created)).toEqual([true, true]);
    expect(created[0]?.path).not.toBe(created[1]?.path);
    expect(created[0]?.baseRef).toMatch(/^[0-9a-f]{40}$/);
    expect(created[1]?.baseRef).toBe(created[0]?.baseRef);

    const reused = await Promise.all([
      worktrees.ensureTaskWorktree({ teamId: team.id, taskId: colonTask.id, sessionId }),
      worktrees.ensureTaskWorktree({ teamId: team.id, taskId: underscoreTask.id, sessionId }),
    ]);
    expect(reused.map((item) => item.created)).toEqual([false, false]);
    expect(reused.map((item) => item.path)).toEqual(created.map((item) => item.path));
    expect(reused.map((item) => item.baseRef)).toEqual(created.map((item) => item.baseRef));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct worktree creation rejects task actor authority before mkdir, git, or update", async () => {
  const context = await createDirectWorktreeContext("chili-team-worktree-direct-authority-");

  try {
    context.operations.resetAcquisitions();
    const worktrees = context.createWorktrees();

    await expect(worktrees.ensureTaskWorktree({
      teamId: context.teamId,
      taskId: context.taskId,
      sessionId: context.actorSessionId,
    })).rejects.toBeInstanceOf(TeamSessionAuthorityError);

    expect(context.operations.acquisitions).toEqual([]);
    expect(context.gitCalls()).toBe(0);
    expect(await pathExists(context.managedRoot)).toBe(false);
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(worktreeMetadata(storedTask?.metadata)).toBeUndefined();
  } finally {
    await context.close();
  }
});

test("direct worktree creation rejects a busy owner before mkdir, git, or update", async () => {
  const context = await createDirectWorktreeContext("chili-team-worktree-direct-busy-");

  try {
    context.operations.resetAcquisitions();
    context.operations.block(context.ownerSessionId);
    const worktrees = context.createWorktrees();

    await expect(worktrees.ensureTaskWorktree({
      teamId: context.teamId,
      taskId: context.taskId,
    })).rejects.toBeInstanceOf(RuntimeBusyError);

    expect(context.operations.acquisitions).toEqual([]);
    expect(context.gitCalls()).toBe(0);
    expect(await pathExists(context.managedRoot)).toBe(false);
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(worktreeMetadata(storedTask?.metadata)).toBeUndefined();
  } finally {
    context.operations.unblock(context.ownerSessionId);
    await context.close();
  }
});

test("direct worktree creation stops on owner lease loss before mkdir, git, or update", async () => {
  const context = await createDirectWorktreeContext("chili-team-worktree-direct-lost-");

  try {
    context.operations.resetAcquisitions();
    let resolves = 0;
    const worktrees = context.createWorktrees(() => {
      resolves++;
      if (resolves === 3) context.operations.lose(context.ownerSessionId);
    });

    await expect(worktrees.ensureTaskWorktree({
      teamId: context.teamId,
      taskId: context.taskId,
    })).rejects.toBeInstanceOf(RuntimeBusyError);

    expect(resolves).toBe(3);
    expect(context.operations.acquisitions).toEqual([context.ownerSessionId]);
    expect(context.gitCalls()).toBe(0);
    expect(await pathExists(context.managedRoot)).toBe(false);
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(worktreeMetadata(storedTask?.metadata)).toBeUndefined();
  } finally {
    await context.close();
  }
});

test("direct worktree creation recovers an exact registered worktree after post-add lease loss", async () => {
  const context = await createDirectWorktreeContext("chili-team-worktree-direct-recover-");

  try {
    context.operations.resetAcquisitions();
    const interrupted = context.createWorktrees(undefined, (input) => {
      if (input.args[0] === "worktree" && input.args[1] === "add") {
        context.operations.lose(context.ownerSessionId);
      }
    });

    await expect(interrupted.ensureTaskWorktree({
      teamId: context.teamId,
      taskId: context.taskId,
    })).rejects.toBeInstanceOf(RuntimeBusyError);

    expect(context.worktreeAddCalls()).toBe(1);
    expect(await pathExists(context.expectedPath)).toBe(true);
    let [storedTask] = await context.teams.tasks(context.teamId);
    expect(worktreeMetadata(storedTask?.metadata)).toBeUndefined();

    context.operations.resetAcquisitions();
    const recovered = await context.createWorktrees().ensureTaskWorktree({
      teamId: context.teamId,
      taskId: context.taskId,
    });

    expect(recovered).toMatchObject({ created: false, path: context.expectedPath });
    expect(recovered.baseRef).toMatch(/^[0-9a-f]{40}$/);
    expect(context.worktreeAddCalls()).toBe(1);
    expect(context.operations.acquisitions).toEqual([context.ownerSessionId]);
    [storedTask] = await context.teams.tasks(context.teamId);
    expect(worktreeMetadata(storedTask?.metadata)).toMatchObject({
      path: context.expectedPath,
      baseRef: recovered.baseRef,
      status: "active",
    });
  } finally {
    await context.close();
  }
});

test("direct worktree recovery rejects a registered HEAD that disagrees with the worktree", async () => {
  const context = await createDirectWorktreeContext("chili-team-worktree-direct-recover-head-");

  try {
    const interrupted = context.createWorktrees(undefined, (input) => {
      if (input.args[0] === "worktree" && input.args[1] === "add") {
        context.operations.lose(context.ownerSessionId);
      }
    });
    await expect(interrupted.ensureTaskWorktree({
      teamId: context.teamId,
      taskId: context.taskId,
    })).rejects.toBeInstanceOf(RuntimeBusyError);

    context.operations.resetAcquisitions();
    const forgedHead = "f".repeat(40);
    const recovering = context.createWorktrees(undefined, undefined, (input, result) => {
      if (input.args[0] !== "worktree" || input.args[1] !== "list") return result;
      return { ...result, stdout: result.stdout.replace(/HEAD [0-9a-f]+/g, `HEAD ${forgedHead}`) };
    });
    await expect(recovering.ensureTaskWorktree({
      teamId: context.teamId,
      taskId: context.taskId,
    })).rejects.toBeInstanceOf(TeamTaskWorktreePathError);
    expect(context.worktreeAddCalls()).toBe(1);
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(worktreeMetadata(storedTask?.metadata)).toBeUndefined();
  } finally {
    await context.close();
  }
});

test("worktree creation freezes HEAD before the main branch advances", async () => {
  const context = await createDirectWorktreeContext("chili-team-worktree-freeze-head-");

  try {
    const originalHead = await gitOutput(context.ownerCwd, ["rev-parse", "HEAD"]);
    const canonicalOwnerCwd = await realpath(context.ownerCwd);
    let advancedHead: string | undefined;
    const worktrees = context.createWorktrees(undefined, async (input) => {
      if (
        advancedHead === undefined
        && input.cwd === canonicalOwnerCwd
        && input.args[0] === "rev-parse"
      ) {
        await writeFile(join(context.ownerCwd, "packages/core/src/feature.ts"), "export const value = 2;\n");
        await git(context.ownerCwd, ["add", "packages/core/src/feature.ts"]);
        await git(context.ownerCwd, ["commit", "-q", "-m", "advance main"]);
        advancedHead = await gitOutput(context.ownerCwd, ["rev-parse", "HEAD"]);
      }
    });

    const result = await worktrees.ensureTaskWorktree({
      teamId: context.teamId,
      taskId: context.taskId,
    });

    expect(advancedHead).toMatch(/^[0-9a-f]{40}$/);
    expect(advancedHead).not.toBe(originalHead);
    expect(result.baseRef).toBe(originalHead);
    expect(await gitOutput(result.path, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(await readFile(join(result.path, "packages/core/src/feature.ts"), "utf8")).toBe(
      "export const value = 1;\n",
    );
    expect(await readFile(join(context.ownerCwd, "packages/core/src/feature.ts"), "utf8")).toBe(
      "export const value = 2;\n",
    );
  } finally {
    await context.close();
  }
});

test("direct worktree creation reenters the owner lease and uses its canonical cwd", async () => {
  const context = await createDirectWorktreeContext("chili-team-worktree-direct-nested-");

  try {
    context.operations.resetAcquisitions();
    const worktrees = context.createWorktrees();
    const [beforeCreation] = await context.teams.tasks(context.teamId);
    expect(beforeCreation?.sessionId).toBe(context.actorSessionId);

    const result = await context.operations.withSessionOperation(
      context.ownerSessionId,
      () => worktrees.ensureTaskWorktree({ teamId: context.teamId, taskId: context.taskId }),
    );

    expect(result.created).toBe(true);
    expect(result.path.startsWith(`${context.managedRoot}/`)).toBe(true);
    expect(result.path).not.toContain(context.defaultCwd);
    expect(context.operations.acquisitions).toEqual([context.ownerSessionId]);
    expect(context.gitCalls()).toBe(3);
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(storedTask?.sessionId).toBe(context.actorSessionId);
    expect(worktreeMetadata(storedTask?.metadata)?.path).toBe(result.path);
  } finally {
    await context.close();
  }
});

test("concurrent dispatch claims before creating task worktrees", async () => {
  const dir = await mkGitRepo("chili-team-worktree-claim-first-");
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1325 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_worktree_claim_first" as SessionId;
  const runner = new CapturingRunner();
  let ensureCalls = 0;

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    const worktrees: TeamTaskWorktreeManager = {
      async ensureTaskWorktree(input) {
        ensureCalls++;
        await sleepMs(25);
        const path = await assertTeamTaskWorktreePath({
          cwd: dir,
          teamId: input.teamId,
          taskId: input.taskId,
        });
        const task = await teams.updateTask({
          teamId: input.teamId,
          taskId: input.taskId,
          sessionId,
          metadata: {
            writeScope: ["packages/core"],
            worktree: { path, baseRef: "a".repeat(40), createdAt: Number(now()), status: "active" },
          },
        });
        return { path, baseRef: "a".repeat(40), createdAt: Number(now()), status: "active", created: true, task };
      },
    };
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      worktrees,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const team = await teams.createTeam({ sessionId, name: "worktree-claim-first", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer", writeScope: ["packages/core"] });
    const first = await teams.createTask({ sessionId, teamId: team.id, title: "First write", ownerPath: workerPath, metadata: { writeScope: ["packages/core"] } });
    const second = await teams.createTask({ sessionId, teamId: team.id, title: "Second write", ownerPath: workerPath, metadata: { writeScope: ["packages/core"] } });

    const results = await Promise.all([
      dispatcher.dispatchTask({ teamId: team.id, taskId: first.id, mode: "one_shot", sessionId, cwd: dir }),
      dispatcher.dispatchTask({ teamId: team.id, taskId: second.id, mode: "one_shot", sessionId, cwd: dir }),
    ]);

    expect(ensureCalls).toBe(1);
    expect(runner.runs).toHaveLength(1);
    expect(results.map((result) => result.status).sort()).toEqual(["completed", "skipped"]);
    expect(results.find((result) => result.status === "skipped")).toMatchObject({ reason: "member_unavailable" });
  } finally {
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
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      worktrees,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const team = await teams.createTeam({ sessionId, name: "worktree-failure", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer", writeScope: ["packages/core"] });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Cannot isolate", ownerPath: workerPath, metadata: { writeScope: ["packages/core"] } });

    const result = await dispatcher.dispatchTask({ teamId: team.id, taskId: task.id, mode: "one_shot", sessionId, cwd: dir });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "blocked",
      teamTask: { id: task.id, status: "blocked", error: "worktree_failed: git worktree add failed" },
    });
    const storedMember = (await teams.members(team.id)).find((member) => member.path === workerPath);
    expect(storedMember).toMatchObject({ path: workerPath, status: "idle" });
    expect(storedMember?.currentTaskId).toBeUndefined();
    expect(runner.runs).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort during worktree creation does not block the task", async () => {
  const dir = await mkGitRepo("chili-team-worktree-abort-");
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1335 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_worktree_abort" as SessionId;
  const controller = new AbortController();
  const runner = new CapturingRunner();
  const worktrees: TeamTaskWorktreeManager = {
    async ensureTaskWorktree() {
      const error = new Error("git worktree add aborted");
      error.name = "AbortError";
      controller.abort(error);
      throw error;
    },
  };

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      worktrees,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const team = await teams.createTeam({ sessionId, name: "worktree-abort", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer", writeScope: ["packages/core"] });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Abort isolation", ownerPath: workerPath, metadata: { writeScope: ["packages/core"] } });

    const summary = await execution.run({ teamId: team.id, sessionId, cwd: dir, signal: controller.signal });

    expect(summary).toMatchObject({
      stopReason: "aborted",
      dispatched: [],
      errors: [],
    });
    expect(runner.runs).toEqual([]);
    const [storedTask] = await teams.tasks(team.id);
    expect(storedTask).toMatchObject({ id: task.id, status: "pending" });
    expect(storedTask?.error ?? "").toBe("");
    expect(worktreeMetadata(storedTask?.metadata)).toBeUndefined();
    const storedMember = (await teams.members(team.id)).find((member) => member.path === workerPath);
    expect(storedMember).toMatchObject({ path: workerPath, status: "idle" });
    expect(storedMember?.currentTaskId).toBeUndefined();
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
  const runner = new WritingThenVerifyingRunner("packages/core/src/feature.ts", "export const value = 42;\n");

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const worktrees = new TeamWorktreeService({
      teams,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      worktrees,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const verifier = new TeamTaskVerificationService({
      teams,
      subagents,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const team = await teams.createTeam({ sessionId, name: "worktree-verifier", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer", writeScope: ["packages/core"] });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Implement isolated change",
      ownerPath: workerPath,
      metadata: {
        writeScope: ["packages/core"],
        suggestedTestCommands: ["bun test packages/core/src/team-worktree.test.ts"],
      },
    });

    const dispatched = await dispatcher.dispatchTask({ teamId: team.id, taskId: task.id, mode: "one_shot", sessionId, cwd: dir });
    const worktree = worktreeMetadata(dispatched.teamTask.metadata);
    if (!worktree) throw new Error("expected task worktree metadata");
    expect(await readFile(join(worktree.path, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 42;\n");
    const directDiff = await runProcess("git", ["diff", "--no-ext-diff", "--no-color"], {
      cwd: worktree.path,
      timeoutMs: 30_000,
      maxOutputBytes: 128_000,
    });
    expect(directDiff.stdout).toContain("export const value = 42;");
    const verified = await verifier.verifyCompletedTasks({ teamId: team.id, sessionId, cwd: dir });

    expect(verified.verified).toMatchObject([{ status: "passed" }]);
    expect(runner.runs.map((run) => run.cwd)).toEqual([worktree.path, worktree.path]);
    expect(runner.runs[1]?.prompt).toContain(`Isolated worktree: ${worktree.path}`);
    expect(await readFile(join(dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 1;\n");
    const [storedTask] = await teams.tasks(team.id);
    expect(taskMergeMetadata(storedTask?.metadata)).toMatchObject({
      status: "pending",
      worktreePath: worktree.path,
      baseRef: worktree.baseRef,
    });
    expect(taskMergeMetadata(storedTask?.metadata)?.diff).toContain("export const value = 42;");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier merge diff includes staged and untracked worktree changes", async () => {
  const dir = await mkGitRepo("chili-team-worktree-merge-diff-");
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1350 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_worktree_merge_diff" as SessionId;
  const runner = new MixedChangeRunner();

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const worktrees = new TeamWorktreeService({
      teams,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      worktrees,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const verifier = new TeamTaskVerificationService({
      teams,
      subagents,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const team = await teams.createTeam({ sessionId, name: "worktree-merge-diff", leadPath });
    await teams.addMember({
      sessionId,
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      writeScope: ["packages/core", "docs"],
    });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Create mixed worktree changes",
      ownerPath: workerPath,
      metadata: { writeScope: ["packages/core", "docs"] },
    });

    const dispatched = await dispatcher.dispatchTask({ teamId: team.id, taskId: task.id, mode: "one_shot", sessionId, cwd: dir });
    const worktree = worktreeMetadata(dispatched.teamTask.metadata);
    if (!worktree) throw new Error("expected task worktree metadata");
    const verified = await verifier.verifyCompletedTasks({ teamId: team.id, sessionId, cwd: dir });

    expect(verified.verified).toMatchObject([{ status: "passed" }]);
    const [storedTask] = await teams.tasks(team.id);
    const diff = taskMergeMetadata(storedTask?.metadata)?.diff ?? "";
    expect(diff).toContain("docs staged by worker");
    expect(diff).toContain("packages/core/src/new-feature.ts");
    expect(diff).toContain("export const created = true;");
    expect(await readFile(join(dir, "docs/readme.md"), "utf8")).toBe("# docs\n");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

interface DirectWorktreeContext {
  ownerCwd: string;
  defaultCwd: string;
  managedRoot: string;
  expectedPath: string;
  ownerSessionId: SessionId;
  actorSessionId: SessionId;
  teamId: TeamId;
  taskId: TaskId;
  teams: TeamControlService;
  operations: WorktreeSessionOperationCoordinator;
  createWorktrees(
    onResolve?: () => void,
    onGitSuccess?: (input: { cwd: string; args: readonly string[] }) => Promise<void> | void,
    transformGitResult?: (
      input: { cwd: string; args: readonly string[] },
      result: { exitCode: number | null; stdout: string; stderr: string },
    ) => { exitCode: number | null; stdout: string; stderr: string },
  ): TeamWorktreeService;
  gitCalls(): number;
  worktreeAddCalls(): number;
  close(): Promise<void>;
}

async function createDirectWorktreeContext(prefix: string): Promise<DirectWorktreeContext> {
  const ownerCwd = await mkGitRepo(`${prefix}owner-`);
  const defaultCwd = await mkdtemp(join(tmpdir(), `${prefix}default-`));
  const store = new SqliteEventStore(join(ownerCwd, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1330 as TimestampMs;
  const ownerSessionId = "session_team_worktree_direct_owner" as SessionId;
  const actorSessionId = "session_team_worktree_direct_actor" as SessionId;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const operations = new WorktreeSessionOperationCoordinator();
  const teams = new TeamControlService({ store, createId: ids, now, sessionOperations: operations });
  const team = await teams.createTeam({ sessionId: ownerSessionId, name: "direct-worktree", leadPath });
  const task = await teams.createTask({
    sessionId: actorSessionId,
    teamId: team.id,
    title: "Create direct worktree",
    ownerPath: workerPath,
    metadata: { writeScope: ["packages/core"] },
  });
  const managedRoot = join(await realpath(ownerCwd), ".chili", "worktrees");
  const expectedPath = join(managedRoot, String(team.id), String(task.id));
  let runGitCalls = 0;
  let addCalls = 0;

  return {
    ownerCwd,
    defaultCwd,
    managedRoot,
    expectedPath,
    ownerSessionId,
    actorSessionId,
    teamId: team.id,
    taskId: task.id,
    teams,
    operations,
    createWorktrees(onResolve, onGitSuccess, transformGitResult) {
      return new TeamWorktreeService({
        teams,
        cwd: defaultCwd,
        now,
        resolveSession: async (sessionId) => {
          onResolve?.();
          if (sessionId !== ownerSessionId) throw new Error(`Unexpected worktree session: ${sessionId}`);
          return { cwd: ownerCwd, status: "active", source: "interactive" };
        },
        sessionOperations: operations,
        runGit: async (input) => {
          runGitCalls++;
          if (input.args[0] === "worktree" && input.args[1] === "add") addCalls++;
          const result = await runProcess("git", input.args, {
            cwd: input.cwd,
            ...(input.signal ? { signal: input.signal } : {}),
            timeoutMs: 30_000,
            maxOutputBytes: 128_000,
          });
          if (result.exitCode === 0) await onGitSuccess?.(input);
          const normalized = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
          return transformGitResult?.(input, normalized) ?? normalized;
        },
      });
    },
    gitCalls() {
      return runGitCalls;
    },
    worktreeAddCalls() {
      return addCalls;
    },
    async close() {
      store.close();
      await rm(defaultCwd, { recursive: true, force: true });
      await rm(ownerCwd, { recursive: true, force: true });
    },
  };
}

interface WorktreeSessionOperationState {
  sessionId: SessionId;
  controller: AbortController;
  active: boolean;
  lost: boolean;
}

class WorktreeSessionOperationCoordinator implements SessionOperationCoordinator {
  readonly acquisitions: SessionId[] = [];
  private readonly storage = new AsyncLocalStorage<WorktreeSessionOperationState>();
  private readonly active = new Map<SessionId, WorktreeSessionOperationState>();
  private readonly blocked = new Set<SessionId>();

  async withSessionOperation<T>(
    sessionId: SessionId,
    fn: (operation: RuntimeSessionOperation) => Promise<T> | T,
  ): Promise<T> {
    const inherited = this.storage.getStore();
    if (inherited?.sessionId === sessionId && inherited.active && !inherited.lost) {
      const operation = this.operation(inherited);
      operation.assertCurrent();
      try {
        const result = await fn(operation);
        operation.assertCurrent();
        return result;
      } catch (error) {
        operation.assertCurrent();
        throw error;
      }
    }
    if (this.blocked.has(sessionId) || this.active.has(sessionId)) {
      throw new RuntimeBusyError(sessionId);
    }

    const state: WorktreeSessionOperationState = {
      sessionId,
      controller: new AbortController(),
      active: true,
      lost: false,
    };
    const operation = this.operation(state);
    this.active.set(sessionId, state);
    this.acquisitions.push(sessionId);
    return this.storage.run(state, async () => {
      try {
        const result = await fn(operation);
        operation.assertCurrent();
        return result;
      } catch (error) {
        operation.assertCurrent();
        throw error;
      } finally {
        state.active = false;
        if (this.active.get(sessionId) === state) this.active.delete(sessionId);
      }
    });
  }

  block(sessionId: SessionId): void {
    this.blocked.add(sessionId);
  }

  unblock(sessionId: SessionId): void {
    this.blocked.delete(sessionId);
  }

  lose(sessionId: SessionId): void {
    const state = this.active.get(sessionId);
    if (!state) throw new Error(`No active operation for ${sessionId}`);
    state.lost = true;
    state.controller.abort(new RuntimeBusyError(sessionId));
  }

  resetAcquisitions(): void {
    this.acquisitions.length = 0;
  }

  private operation(state: WorktreeSessionOperationState): RuntimeSessionOperation {
    return {
      signal: state.controller.signal,
      assertCurrent() {
        if (!state.active || state.lost) throw new RuntimeBusyError(state.sessionId);
      },
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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

class MixedChangeRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    if (input.taskName.startsWith("Verify ")) return { status: "completed", summary: "VERDICT: passed\nPatch is complete." };
    await writeFile(join(input.cwd, "docs/readme.md"), "# docs\n\ndocs staged by worker\n");
    const staged = await runProcess("git", ["add", "docs/readme.md"], {
      cwd: input.cwd,
      timeoutMs: 30_000,
      maxOutputBytes: 128_000,
    });
    if (staged.exitCode !== 0) throw new Error(staged.stderr || `git add failed with exit ${staged.exitCode}`);
    await writeFile(join(input.cwd, "packages/core/src/new-feature.ts"), "export const created = true;\n");
    return { status: "completed", summary: "Created staged and untracked worktree changes" };
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
  private readonly runWaiters: Array<{ count: number; resolve: () => void }> = [];

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    for (let index = this.runWaiters.length - 1; index >= 0; index--) {
      const waiter = this.runWaiters[index];
      if (!waiter || this.runs.length < waiter.count) continue;
      this.runWaiters.splice(index, 1);
      waiter.resolve();
    }
    await new Promise<void>((resolve) => this.completions.push(resolve));
    return { status: "completed", summary: `Done ${input.taskName}` };
  }

  waitForRuns(count: number): Promise<void> {
    if (this.runs.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) => this.runWaiters.push({ count, resolve }));
  }

  completeAll(): void {
    while (this.completions.length > 0) this.completions.shift()?.();
  }
}

const PASSTHROUGH_SESSION_OPERATIONS = {
  async withSessionOperation<T>(
    _sessionId: SessionId,
    fn: (operation: { readonly signal: AbortSignal; assertCurrent(): void }) => Promise<T> | T,
  ): Promise<T> {
    return fn({
      signal: new AbortController().signal,
      assertCurrent() {},
    });
  },
};

async function persistRootSession(store: SqliteEventStore, sessionId: SessionId, cwd: string): Promise<void> {
  await store.append({
    id: `event_root_${sessionId}`,
    type: "session.created",
    time: 1 as TimestampMs,
    sessionId,
    payload: { sessionId, cwd },
  });
}

function persistedRootSessionResolver(store: SqliteEventStore) {
  return async (sessionId: SessionId): Promise<{ cwd: string }> => {
    const session = (await store.sessions()).find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status !== "active") throw new Error(`Session is not active: ${sessionId}`);
    if (session.source !== "interactive") throw new Error(`Session is not a root session: ${sessionId}`);
    return { cwd: session.cwd };
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

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000, maxOutputBytes: 128_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix: string) => `${prefix}_${++next}`;
}
