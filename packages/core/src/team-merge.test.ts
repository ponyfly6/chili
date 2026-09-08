import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, AgentRunId, SessionId, TaskId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { runProcess } from "@chili/tools";
import {
  RuntimeBusyError,
  type RuntimeSessionOperation,
  type SessionOperationCoordinator,
} from "./runtime-service.js";
import { TeamTaskVerificationService } from "./team-verifier.js";
import { TeamTaskDispatchService } from "./team-dispatcher.js";
import { captureTeamTaskArtifact } from "./team-artifact.js";
import { TeamMergeService, type TeamMergeGitRunnerResult } from "./team-merge.js";
import { TeamSessionAuthorityError } from "./team-session-authority.js";
import { TeamControlService } from "./team.js";
import { taskMergeMetadata, TeamWorktreeService, worktreeMetadata } from "./team-worktree.js";

test("applies a verifier-passed pending worktree merge to the main workspace", async () => {
  const context = await createPendingMergeContext("chili-team-merge-applied-");

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");

    await acceptPendingArtifacts(context);
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

test("continues apply and finalization after the request aborts post-marker", async () => {
  const context = await createPendingMergeContext("chili-team-merge-post-marker-abort-");
  const controller = new AbortController();
  let markerObserved = false;

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations: passthroughSessionOperations,
      runGit: async (input): Promise<TeamMergeGitRunnerResult> => {
        if (
          input.args[0] === "apply"
          && input.args.includes("--reverse")
          && input.args.includes("--check")
          && !controller.signal.aborted
        ) {
          const [taskAtMarker] = await context.teams.tasks(context.teamId);
          const mergeAtMarker = taskAtMarker?.metadata?.merge as Record<string, unknown> | undefined;
          markerObserved = mergeAtMarker?.status === "pending"
            && typeof mergeAtMarker.applyStartedAt === "number"
            && typeof mergeAtMarker.patchFingerprint === "string";
          controller.abort(new DOMException("request closed", "AbortError"));
        }
        const result = await runProcess("git", input.args, {
          cwd: input.cwd,
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.timeoutMs ?? 30_000,
          maxOutputBytes: input.maxOutputBytes ?? 5_000_000,
        });
        return result;
      },
    });

    await acceptPendingArtifacts(context);
    const result = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(true);
    expect(markerObserved).toBe(true);
    expect(result.applied).toMatchObject([{ teamTask: { id: context.taskId } }]);
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 2;\n");
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(taskMergeMetadata(storedTask?.metadata)?.status).toBe("applied");
  } finally {
    await context.close();
  }
});

test("marks a merge conflicted without changing dirty main workspace files", async () => {
  const context = await createPendingMergeContext("chili-team-merge-conflict-");

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    await writeFile(join(context.dir, "packages/core/src/feature.ts"), "export const value = 99;\n");

    await acceptPendingArtifacts(context);
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

    await acceptPendingArtifacts(context);
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

    await acceptPendingArtifacts(context);
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

test("merges worker commits by diffing the frozen base commit to the current worktree", async () => {
  const context = await createPendingMergeContext("chili-team-merge-worker-commit-");

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 7;\n");
    await git(context.worktreePath, ["add", "packages/core/src/feature.ts"]);
    await git(context.worktreePath, ["commit", "-q", "-m", "worker commit"]);

    await acceptPendingArtifacts(context);
    const result = await context.merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });

    expect(result.applied).toMatchObject([{ status: "applied", diffSummary: { filesChanged: 1 } }]);
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 7;\n");
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(taskMergeMetadata(storedTask?.metadata)?.diff).toContain("export const value = 7;");
  } finally {
    await context.close();
  }
});

test("rejects committed main divergence on a touched path before git apply", async () => {
  const context = await createPendingMergeContext("chili-team-merge-committed-divergence-");
  let actualApplyCalls = 0;

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    await writeFile(
      join(context.dir, "packages/core/src/feature.ts"),
      "export const value = 1;\nexport const mainOnly = true;\n",
    );
    await git(context.dir, ["add", "packages/core/src/feature.ts"]);
    await git(context.dir, ["commit", "-q", "-m", "main touched same file"]);
    const beforeMerge = await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8");
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations: passthroughSessionOperations,
      runGit: async (input): Promise<TeamMergeGitRunnerResult> => {
        if (input.args[0] === "apply" && !input.args.includes("--check")) actualApplyCalls++;
        return runProcess("git", input.args, {
          cwd: input.cwd,
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.timeoutMs ?? 30_000,
          maxOutputBytes: input.maxOutputBytes ?? 5_000_000,
        });
      },
    });

    await acceptPendingArtifacts(context);
    const result = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });

    expect(result.conflicted).toMatchObject([{
      error: "Main workspace has committed changes in files touched by the task patch",
    }]);
    expect(actualApplyCalls).toBe(0);
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe(beforeMerge);
  } finally {
    await context.close();
  }
});

test("recovers a durable apply intent after a crash before git apply", async () => {
  const context = await createPendingMergeContext("chili-team-merge-marker-recovery-");
  let crashBeforeApply = true;
  let actualApplyCalls = 0;

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations: passthroughSessionOperations,
      runGit: async (input): Promise<TeamMergeGitRunnerResult> => {
        if (
          crashBeforeApply
          && input.args[0] === "apply"
          && input.args.includes("--reverse")
          && input.args.includes("--check")
        ) {
          crashBeforeApply = false;
          throw new Error("simulated crash after apply marker");
        }
        if (input.args[0] === "apply" && !input.args.includes("--check")) actualApplyCalls++;
        return runProcess("git", input.args, {
          cwd: input.cwd,
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.timeoutMs ?? 30_000,
          maxOutputBytes: input.maxOutputBytes ?? 5_000_000,
        });
      },
    });

    await acceptPendingArtifacts(context);
    const interrupted = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });
    expect(interrupted.errors).toMatchObject([{ taskId: context.taskId, error: "simulated crash after apply marker" }]);
    expect(actualApplyCalls).toBe(0);
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 1;\n");
    const [markedTask] = await context.teams.tasks(context.teamId);
    const markedMerge = markedTask?.metadata?.merge as Record<string, unknown> | undefined;
    expect(markedMerge).toMatchObject({
      status: "pending",
      baseCommit: expect.any(String),
      mainHead: expect.any(String),
      worktreeHead: expect.any(String),
      applyStartedAt: expect.any(Number),
      patchFingerprint: expect.any(String),
      postStateFingerprint: expect.any(String),
    });

    const recovered = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });
    expect(recovered.applied).toMatchObject([{ teamTask: { id: context.taskId } }]);
    expect(actualApplyCalls).toBe(1);
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 2;\n");
  } finally {
    await context.close();
  }
});

test("refuses a frozen apply intent after main HEAD advances", async () => {
  const context = await createPendingMergeContext("chili-team-merge-main-head-fence-");
  let stopAfterMarker = true;
  let actualApplyCalls = 0;

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations: passthroughSessionOperations,
      runGit: async (input): Promise<TeamMergeGitRunnerResult> => {
        if (
          stopAfterMarker
          && input.args[0] === "apply"
          && input.args.includes("--reverse")
          && input.args.includes("--check")
        ) {
          stopAfterMarker = false;
          throw new Error("stop after marker");
        }
        if (input.args[0] === "apply" && !input.args.includes("--check")) actualApplyCalls++;
        return runProcess("git", input.args, {
          cwd: input.cwd,
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.timeoutMs ?? 30_000,
          maxOutputBytes: input.maxOutputBytes ?? 5_000_000,
        });
      },
    });

    await acceptPendingArtifacts(context);
    const interrupted = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });
    expect(interrupted.errors).toHaveLength(1);
    await writeFile(join(context.dir, "docs/readme.md"), "# docs\n\nmain advanced\n");
    await git(context.dir, ["add", "docs/readme.md"]);
    await git(context.dir, ["commit", "-q", "-m", "advance main"]);

    const recovered = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });
    expect(recovered.conflicted).toMatchObject([{
      error: "Main workspace HEAD changed after the merge apply intent was frozen",
    }]);
    expect(actualApplyCalls).toBe(0);
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 1;\n");
  } finally {
    await context.close();
  }
});

test("finalizes exactly once when the owner lease is lost after git apply", async () => {
  const context = await createPendingMergeContext("chili-team-merge-apply-lease-loss-");
  const sessionOperations = new TestSessionOperationCoordinator();
  const fencedTeams = new TeamControlService({
    store: context.store,
    now: () => 2000 as TimestampMs,
    sessionOperations,
  });
  let loseLeaseAfterApply = true;
  let actualApplyCalls = 0;

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    const merger = new TeamMergeService({
      teams: fencedTeams,
      cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations,
      runGit: async (input): Promise<TeamMergeGitRunnerResult> => {
        const result = await runProcess("git", input.args, {
          cwd: input.cwd,
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.timeoutMs ?? 30_000,
          maxOutputBytes: input.maxOutputBytes ?? 5_000_000,
        });
        if (input.args[0] === "apply" && !input.args.includes("--check")) {
          actualApplyCalls++;
          if (loseLeaseAfterApply && result.exitCode === 0) {
            loseLeaseAfterApply = false;
            sessionOperations.invalidate(context.sessionId);
          }
        }
        return result;
      },
    });

    await acceptPendingArtifacts(context);
    await expect(merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    })).rejects.toBeInstanceOf(RuntimeBusyError);
    expect(actualApplyCalls).toBe(1);
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 2;\n");
    const [pendingTask] = await fencedTeams.tasks(context.teamId);
    expect(taskMergeMetadata(pendingTask?.metadata)?.status).toBe("pending");

    const recovered = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });
    expect(recovered.applied).toMatchObject([{ teamTask: { id: context.taskId } }]);
    expect(actualApplyCalls).toBe(1);
    const [appliedTask] = await fencedTeams.tasks(context.teamId);
    expect(taskMergeMetadata(appliedTask?.metadata)?.status).toBe("applied");
  } finally {
    await context.close();
  }
});

test("marks a partially applied frozen patch conflicted without rollback", async () => {
  const context = await createPendingMergeContext("chili-team-merge-partial-recovery-");
  let stopAfterMarker = true;
  let actualApplyCalls = 0;

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    await writeFile(join(context.worktreePath, "docs/readme.md"), "# docs\n\nworker docs\n");
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations: passthroughSessionOperations,
      runGit: async (input): Promise<TeamMergeGitRunnerResult> => {
        if (
          stopAfterMarker
          && input.args[0] === "apply"
          && input.args.includes("--reverse")
          && input.args.includes("--check")
        ) {
          stopAfterMarker = false;
          throw new Error("stop after marker");
        }
        if (input.args[0] === "apply" && !input.args.includes("--check")) actualApplyCalls++;
        return runProcess("git", input.args, {
          cwd: input.cwd,
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.timeoutMs ?? 30_000,
          maxOutputBytes: input.maxOutputBytes ?? 5_000_000,
        });
      },
    });

    await acceptPendingArtifacts(context);
    const interrupted = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });
    expect(interrupted.errors).toHaveLength(1);
    await writeFile(join(context.dir, "packages/core/src/feature.ts"), "export const value = 2;\n");

    const recovered = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });
    expect(recovered.conflicted).toMatchObject([{
      error: "Frozen task patch is partially applied or conflicts with the main workspace",
    }]);
    expect(actualApplyCalls).toBe(0);
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(await readFile(join(context.dir, "docs/readme.md"), "utf8")).toBe("# docs\n");
  } finally {
    await context.close();
  }
});

test("does not accept an already-applied patch after touched files receive extra edits", async () => {
  const context = await createPendingMergeContext("chili-team-merge-post-state-fence-");
  let crashAfterApply = true;

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations: passthroughSessionOperations,
      runGit: async (input): Promise<TeamMergeGitRunnerResult> => {
        const result = await runProcess("git", input.args, {
          cwd: input.cwd,
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.timeoutMs ?? 30_000,
          maxOutputBytes: input.maxOutputBytes ?? 5_000_000,
        });
        if (
          crashAfterApply
          && input.args[0] === "apply"
          && !input.args.includes("--check")
          && result.exitCode === 0
        ) {
          crashAfterApply = false;
          throw new Error("simulated crash after git apply");
        }
        return result;
      },
    });

    await acceptPendingArtifacts(context);
    const interrupted = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });
    expect(interrupted.errors).toHaveLength(1);
    await writeFile(
      join(context.dir, "packages/core/src/feature.ts"),
      "export const value = 2;\n// user edit after apply\n",
    );

    const recovered = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });
    expect(recovered.conflicted).toHaveLength(1);
    expect(recovered.applied).toEqual([]);
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toContain("user edit after apply");
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
    const worktrees = new TeamWorktreeService({
      teams: context.teams,
      cwd: context.dir,
      now,
      resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations: passthroughSessionOperations,
    });
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
      resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations: passthroughSessionOperations,
      runGit: async (input): Promise<TeamMergeGitRunnerResult> => {
        const isWorktreeHeadDiff = input.args[0] === "diff"
          && input.args.includes("--binary")
          && input.cwd.includes(".chili/worktrees");
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

    await acceptPendingArtifacts(context);
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

test("rejects merge session/workspace overrides and resolver failures before any git command", async () => {
  const context = await createPendingMergeContext("chili-team-merge-authority-");
  const workspaceB = await mkdtemp(join(tmpdir(), "chili-team-merge-authority-b-"));
  const sessionB = "session_team_merge_b" as SessionId;
  let gitCalls = 0;
  const runGit = async (): Promise<TeamMergeGitRunnerResult> => {
    gitCalls++;
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  try {
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: workspaceB,
      resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations: passthroughSessionOperations,
      runGit,
    });
    await acceptPendingArtifacts(context);
    await expect(merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: sessionB,
      cwd: context.dir,
    })).rejects.toBeInstanceOf(TeamSessionAuthorityError);
    await expect(merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: workspaceB,
    })).rejects.toBeInstanceOf(TeamSessionAuthorityError);

    for (const reason of ["missing", "archived", "subagent"] as const) {
      const rejectingMerger = new TeamMergeService({
        teams: context.teams,
        cwd: context.dir,
        resolveSession: async () => {
          throw new Error(`session is ${reason}`);
        },
        sessionOperations: passthroughSessionOperations,
        runGit,
      });
      await expect(rejectingMerger.mergeTeamTasks({
        teamId: context.teamId,
        sessionId: context.sessionId,
        cwd: context.dir,
      })).rejects.toThrow(`session is ${reason}`);
    }

    expect(gitCalls).toBe(0);
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(taskMergeMetadata(storedTask?.metadata)?.status).toBe("pending");
  } finally {
    await rm(workspaceB, { recursive: true, force: true });
    await context.close();
  }
});

test("rejects absolute, traversal, and symlink worktree path overrides before git or finalize", async () => {
  const cases = ["absolute", "traversal", "symlink"] as const;

  for (const variant of cases) {
    const context = await createPendingMergeContext(`chili-team-merge-path-${variant}-`);
    const workspaceB = await mkdtemp(join(tmpdir(), `chili-team-merge-path-${variant}-b-`));
    let gitCalls = 0;
    try {
      const [task] = await context.teams.tasks(context.teamId);
      if (!task) throw new Error("expected pending merge task");
      if (variant === "symlink") {
        await rm(context.worktreePath, { recursive: true, force: true });
        await symlink(await realpath(workspaceB), context.worktreePath, "dir");
      } else {
        const merge = taskMergeMetadata(task.metadata);
        if (!merge) throw new Error("expected pending merge metadata");
        await context.teams.updateTask({
          sessionId: context.sessionId,
          teamId: context.teamId,
          taskId: context.taskId,
          metadata: {
            ...(task.metadata ?? {}),
            merge: {
              ...merge,
              worktreePath: variant === "absolute" ? await realpath(workspaceB) : "../../../workspace-b",
            },
          },
        });
      }

      const merger = new TeamMergeService({
        teams: context.teams,
        cwd: context.dir,
        resolveSession: persistedRootSessionResolver(context.store),
        sessionOperations: passthroughSessionOperations,
        runGit: async () => {
          gitCalls++;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      await acceptPendingArtifacts(context);
      const result = await merger.mergeTeamTasks({
        teamId: context.teamId,
        sessionId: context.sessionId,
        cwd: context.dir,
      });

      expect(result.errors).toHaveLength(1);
      expect(result.applied).toEqual([]);
      expect(result.conflicted).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(gitCalls).toBe(0);
      const [storedTask] = await context.teams.tasks(context.teamId);
      expect(taskMergeMetadata(storedTask?.metadata)?.status).toBe("pending");
    } finally {
      await rm(workspaceB, { recursive: true, force: true });
      await context.close();
    }
  }
});

test("reauthorizes every merge-prepare finalization branch before task mutation", async () => {
  const scenarios = [
    {
      name: "missing",
      setup: async (context: Awaited<ReturnType<typeof createPendingMergeContext>>) => {
        await rm(context.worktreePath, { recursive: true, force: true });
      },
    },
    {
      name: "empty",
      setup: async (_context: Awaited<ReturnType<typeof createPendingMergeContext>>) => {},
    },
    {
      name: "dirty",
      setup: async (context: Awaited<ReturnType<typeof createPendingMergeContext>>) => {
        await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
        await writeFile(join(context.dir, "packages/core/src/feature.ts"), "export const value = 99;\n");
      },
    },
    {
      name: "patch-conflict",
      setup: async (context: Awaited<ReturnType<typeof createPendingMergeContext>>) => {
        await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
        await writeFile(join(context.dir, "packages/core/src/feature.ts"), "export const value = 99;\n");
        await git(context.dir, ["add", "packages/core/src/feature.ts"]);
        await git(context.dir, ["commit", "-q", "-m", "diverge main"]);
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    const context = await createPendingMergeContext(`chili-team-merge-reauth-${scenario.name}-`);
    try {
      await scenario.setup(context);
      const persistedResolver = persistedRootSessionResolver(context.store);
      let resolverCalls = 0;
      const merger = new TeamMergeService({
        teams: context.teams,
        cwd: context.dir,
        resolveSession: async (sessionId) => {
          resolverCalls++;
          if (resolverCalls === 3) throw new Error(`session revoked before ${scenario.name} finalization`);
          return persistedResolver(sessionId);
        },
        sessionOperations: passthroughSessionOperations,
      });

      await acceptPendingArtifacts(context);
      const result = await merger.mergeTeamTasks({
        teamId: context.teamId,
        sessionId: context.sessionId,
        cwd: context.dir,
      });

      expect(resolverCalls).toBe(3);
      expect(result.errors).toMatchObject([{ taskId: context.taskId }]);
      expect(result.applied).toEqual([]);
      expect(result.conflicted).toEqual([]);
      expect(result.skipped).toEqual([]);
      const [storedTask] = await context.teams.tasks(context.teamId);
      expect(taskMergeMetadata(storedTask?.metadata)?.status).toBe("pending");
    } finally {
      await context.close();
    }
  }
});

test("reauthorizes immediately before the actual git apply", async () => {
  const context = await createPendingMergeContext("chili-team-merge-apply-reauth-");
  let resolverCalls = 0;
  let actualApplyCalls = 0;

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    const persistedResolver = persistedRootSessionResolver(context.store);
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      resolveSession: async (sessionId) => {
        resolverCalls++;
        if (resolverCalls === 5) throw new Error("session revoked immediately before git apply");
        return persistedResolver(sessionId);
      },
      sessionOperations: passthroughSessionOperations,
      runGit: async (input): Promise<TeamMergeGitRunnerResult> => {
        if (input.args[0] === "apply" && !input.args.includes("--check")) actualApplyCalls++;
        return runProcess("git", input.args, {
          cwd: input.cwd,
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.timeoutMs ?? 30_000,
          maxOutputBytes: input.maxOutputBytes ?? 5_000_000,
        });
      },
    });

    await acceptPendingArtifacts(context);
    const result = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });

    expect(resolverCalls).toBe(5);
    expect(actualApplyCalls).toBe(0);
    expect(result.errors).toMatchObject([{ taskId: context.taskId }]);
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 1;\n");
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(taskMergeMetadata(storedTask?.metadata)?.status).toBe("pending");
  } finally {
    await context.close();
  }
});

test("holds one session operation across the merge sweep and rejects a concurrent merge before side effects", async () => {
  const context = await createPendingMergeContext("chili-team-merge-operation-busy-");
  const sessionOperations = new TestSessionOperationCoordinator();
  let releaseGit: (() => void) | undefined;
  let reachedGit: (() => void) | undefined;
  const gitReleased = new Promise<void>((resolve) => {
    releaseGit = resolve;
  });
  const gitReached = new Promise<void>((resolve) => {
    reachedGit = resolve;
  });
  let shouldBlock = true;
  let gitCalls = 0;
  let actualApplyCalls = 0;
  let firstMerge: Promise<unknown> | undefined;

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations,
      runGit: async (input): Promise<TeamMergeGitRunnerResult> => {
        gitCalls++;
        const isWorktreeDiff = input.args[0] === "diff"
          && input.args.includes("--binary")
          && input.cwd === context.worktreePath;
        if (shouldBlock && isWorktreeDiff) {
          shouldBlock = false;
          reachedGit?.();
          await gitReleased;
        }
        if (input.args[0] === "apply" && !input.args.includes("--check")) actualApplyCalls++;
        return runProcess("git", input.args, {
          cwd: input.cwd,
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.timeoutMs ?? 30_000,
          maxOutputBytes: input.maxOutputBytes ?? 5_000_000,
        });
      },
    });

    await acceptPendingArtifacts(context);
    firstMerge = merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });
    await gitReached;
    const callsBeforeConcurrentAttempt = gitCalls;

    await expect(merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    })).rejects.toBeInstanceOf(RuntimeBusyError);

    expect(gitCalls).toBe(callsBeforeConcurrentAttempt);
    expect(actualApplyCalls).toBe(0);
    const [pendingTask] = await context.teams.tasks(context.teamId);
    expect(taskMergeMetadata(pendingTask?.metadata)?.status).toBe("pending");

    releaseGit?.();
    const completed = await firstMerge;
    expect(completed).toMatchObject({ applied: [{ teamTask: { id: context.taskId } }] });
    expect(actualApplyCalls).toBe(1);
  } finally {
    releaseGit?.();
    await firstMerge?.catch(() => undefined);
    await context.close();
  }
});

test("fails closed when the session operation capability is lost immediately before git apply", async () => {
  const context = await createPendingMergeContext("chili-team-merge-operation-lost-");
  const sessionOperations = new TestSessionOperationCoordinator();
  const persistedResolver = persistedRootSessionResolver(context.store);
  let resolverCalls = 0;
  let actualApplyCalls = 0;

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      resolveSession: async (sessionId) => {
        resolverCalls++;
        const resolved = await persistedResolver(sessionId);
        if (resolverCalls === 5) sessionOperations.invalidate(sessionId);
        return resolved;
      },
      sessionOperations,
      runGit: async (input): Promise<TeamMergeGitRunnerResult> => {
        if (input.args[0] === "apply" && !input.args.includes("--check")) actualApplyCalls++;
        return runProcess("git", input.args, {
          cwd: input.cwd,
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.timeoutMs ?? 30_000,
          maxOutputBytes: input.maxOutputBytes ?? 5_000_000,
        });
      },
    });

    await acceptPendingArtifacts(context);
    await expect(merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    })).rejects.toBeInstanceOf(RuntimeBusyError);

    expect(resolverCalls).toBe(5);
    expect(actualApplyCalls).toBe(0);
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 1;\n");
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(taskMergeMetadata(storedTask?.metadata)?.status).toBe("pending");
  } finally {
    await context.close();
  }
});

test("refuses merge finalization when the session operation capability expires after revalidation", async () => {
  const context = await createPendingMergeContext("chili-team-merge-operation-finalize-");
  const sessionOperations = new TestSessionOperationCoordinator();
  const persistedResolver = persistedRootSessionResolver(context.store);
  let resolverCalls = 0;
  let actualApplyCalls = 0;

  try {
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      resolveSession: async (sessionId) => {
        resolverCalls++;
        const resolved = await persistedResolver(sessionId);
        if (resolverCalls === 3) sessionOperations.invalidate(sessionId);
        return resolved;
      },
      sessionOperations,
      runGit: async (input): Promise<TeamMergeGitRunnerResult> => {
        if (input.args[0] === "apply" && !input.args.includes("--check")) actualApplyCalls++;
        return runProcess("git", input.args, {
          cwd: input.cwd,
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.timeoutMs ?? 30_000,
          maxOutputBytes: input.maxOutputBytes ?? 5_000_000,
        });
      },
    });

    await acceptPendingArtifacts(context);
    await expect(merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    })).rejects.toBeInstanceOf(RuntimeBusyError);

    expect(resolverCalls).toBe(3);
    expect(actualApplyCalls).toBe(0);
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(taskMergeMetadata(storedTask?.metadata)?.status).toBe("pending");
  } finally {
    await context.close();
  }
});

test("reuses a nested session operation while preserving the merge capability", async () => {
  const context = await createPendingMergeContext("chili-team-merge-operation-nested-");
  const sessionOperations = new TestSessionOperationCoordinator();

  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations,
    });

    await acceptPendingArtifacts(context);
    const result = await sessionOperations.withSessionOperation(
      context.sessionId,
      () => merger.mergeTeamTasks({
        teamId: context.teamId,
        sessionId: context.sessionId,
        cwd: context.dir,
      }),
    );

    expect(result.applied).toMatchObject([{ teamTask: { id: context.taskId } }]);
    expect(sessionOperations.acquisitions).toBe(1);
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 2;\n");
  } finally {
    await context.close();
  }
});

test("does not downgrade a merge authority revocation into a per-task error", async () => {
  const context = await createPendingMergeContext("chili-team-merge-operation-authority-");
  const persistedResolver = persistedRootSessionResolver(context.store);
  let resolverCalls = 0;

  try {
    await rm(context.worktreePath, { recursive: true, force: true });
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      resolveSession: async (sessionId) => {
        resolverCalls++;
        if (resolverCalls === 3) throw new TeamSessionAuthorityError("team owner session was revoked");
        return persistedResolver(sessionId);
      },
      sessionOperations: passthroughSessionOperations,
    });

    await acceptPendingArtifacts(context);
    await expect(merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    })).rejects.toBeInstanceOf(TeamSessionAuthorityError);
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(taskMergeMetadata(storedTask?.metadata)?.status).toBe("pending");
  } finally {
    await context.close();
  }
});

test("normalizes hostile merge sweep failures before returning them", async () => {
  const context = await createPendingMergeContext("chili-team-merge-hostile-error-");

  try {
    const merger = new TeamMergeService({
      teams: context.teams,
      cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations: passthroughSessionOperations,
      runGit: async () => {
        throw hostileSuccessfulOutputError("merge precheck failed");
      },
    });

    await acceptPendingArtifacts(context);
    const result = await merger.mergeTeamTasks({
      teamId: context.teamId,
      sessionId: context.sessionId,
      cwd: context.dir,
    });

    expect(result.errors).toHaveLength(1);
    expectBoundedSanitizedDiagnostic(result.errors[0]?.error);
    expect(utf8Bytes(JSON.stringify(result))).toBeLessThan(64 * 1024);
  } finally {
    await context.close();
  }
});

test("verified A -> B artifacts inherit and merge same-file increments without committing dirty user work", async () => {
  const context = await createPendingMergeContext("chili-team-artifact-chain-");
  try {
    const originalHead = (await runProcess("git", ["rev-parse", "HEAD"], { cwd: context.dir })).stdout;
    const originalIndex = await readFile(join(context.dir, ".git/index"));
    await writeFile(join(context.dir, "docs/readme.md"), "user unfinished docs\n");
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    await writeFile(join(context.worktreePath, "packages/core/src/created-by-a.ts"), "export const created = 1;\n");
    await verifyCurrentTask(context, context.taskId);
    const firstMerge = await context.merger.mergeTeamTasks({ teamId: context.teamId, sessionId: context.sessionId });
    expect(firstMerge.applied).toHaveLength(1);
    const second = await context.teams.createTask({
      teamId: context.teamId, sessionId: context.sessionId, title: "B consumes A", ownerPath: "/root/worker" as AgentPath,
      dependsOn: [context.taskId], metadata: { writeScope: ["packages/core"] },
    });
    const worktrees = new TeamWorktreeService({
      teams: context.teams, cwd: context.dir, resolveSession: persistedRootSessionResolver(context.store),
      sessionOperations: passthroughSessionOperations,
    });
    const secondWorktree = await worktrees.ensureTaskWorktree({ teamId: context.teamId, taskId: second.id, sessionId: context.sessionId });
    expect(await readFile(join(secondWorktree.path, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(await readFile(join(secondWorktree.path, "packages/core/src/created-by-a.ts"), "utf8")).toBe("export const created = 1;\n");
    expect(await readFile(join(secondWorktree.path, "docs/readme.md"), "utf8")).toBe("# docs\n");
    await writeFile(join(secondWorktree.path, "packages/core/src/feature.ts"), "export const value = 3;\n");
    await writeFile(join(secondWorktree.path, "packages/core/src/created-by-a.ts"), "export const created = 2;\n");
    await writeFile(join(secondWorktree.path, "packages/core/src/created-by-b.ts"), "export const successor = true;\n");
    await verifyCurrentTask(context, second.id);
    const secondMerge = await context.merger.mergeTeamTasks({ teamId: context.teamId, taskId: second.id, sessionId: context.sessionId });
    expect(secondMerge.errors).toEqual([]);
    expect(secondMerge.conflicted).toEqual([]);
    expect(secondMerge.applied).toHaveLength(1);
    expect(taskMergeMetadata(secondMerge.applied[0]?.teamTask.metadata)?.diff).toContain("-export const value = 2;");
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 3;\n");
    expect(await readFile(join(context.dir, "packages/core/src/created-by-a.ts"), "utf8")).toBe("export const created = 2;\n");
    expect(await readFile(join(context.dir, "packages/core/src/created-by-b.ts"), "utf8")).toBe("export const successor = true;\n");
    expect(await readFile(join(context.dir, "docs/readme.md"), "utf8")).toBe("user unfinished docs\n");
    expect((await runProcess("git", ["rev-parse", "HEAD"], { cwd: context.dir })).stdout).toBe(originalHead);
    expect(await readFile(join(context.dir, ".git/index"))).toEqual(originalIndex);
  } finally { await context.close(); }
});

test("changes after verification cannot merge or dispatch dependent tasks", async () => {
  const context = await createPendingMergeContext("chili-team-artifact-changed-");
  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    await verifyCurrentTask(context, context.taskId);
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 999;\n");
    const result = await context.merger.mergeTeamTasks({ teamId: context.teamId, sessionId: context.sessionId });
    expect(result.applied).toEqual([]);
    expect(result.conflicted[0]?.error).toContain("changed after verification");
    expect(result.conflicted[0]?.teamTask.metadata?.verification).toMatchObject({ status: "failed" });
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 1;\n");
    const dependent = await context.teams.createTask({
      teamId: context.teamId, sessionId: context.sessionId, title: "Must not run", ownerPath: "/root/worker" as AgentPath,
      dependsOn: [context.taskId], metadata: { allowedTools: ["read"] },
    });
    const worktrees = new TeamWorktreeService({ teams: context.teams, cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store), sessionOperations: passthroughSessionOperations });
    await expect(worktrees.ensureTaskWorktree({ teamId: context.teamId, taskId: dependent.id, sessionId: context.sessionId }))
      .rejects.toThrow("no delivered artifact");
    const dispatcher = new TeamTaskDispatchService({ teams: context.teams, cwd: context.dir, store: context.store,
      resolveSession: persistedRootSessionResolver(context.store), sessionOperations: passthroughSessionOperations,
      subagents: { async spawnTask() { throw new Error("must not spawn dependent"); } },
    });
    expect(await dispatcher.dispatchTask({ teamId: context.teamId, taskId: dependent.id, sessionId: context.sessionId }))
      .toMatchObject({ status: "skipped", reason: "blocked" });
  } finally { await context.close(); }
});

test("legacy passed metadata without an artifact requires reverification", async () => {
  const context = await createPendingMergeContext("chili-team-artifact-legacy-");
  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    const result = await context.merger.mergeTeamTasks({ teamId: context.teamId, sessionId: context.sessionId });
    expect(result.conflicted[0]?.error).toContain("no immutable artifact");
    expect(result.applied).toEqual([]);
    await verifyCurrentTask(context, context.taskId);
    expect((await context.merger.mergeTeamTasks({ teamId: context.teamId, sessionId: context.sessionId })).applied).toHaveLength(1);
  } finally { await context.close(); }
});

test("merges a verified mode-only artifact", async () => {
  const context = await createPendingMergeContext("chili-team-artifact-mode-");
  try {
    await chmod(join(context.worktreePath, "packages/core/src/feature.ts"), 0o755);
    await verifyCurrentTask(context, context.taskId);
    const result = await context.merger.mergeTeamTasks({ teamId: context.teamId, sessionId: context.sessionId });
    expect(result.errors).toEqual([]);
    expect(result.conflicted).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect((await lstat(join(context.dir, "packages/core/src/feature.ts"))).mode & 0o111).toBe(0o111);
  } finally { await context.close(); }
});

for (const changedAfterOldMerge of [false, true]) {
  test(`reverifies legacy applied artifacts and ${changedAfterOldMerge ? "rejects changed results" : "confirms matching results without reapplying"}`, async () => {
    const context = await createPendingMergeContext("chili-team-artifact-legacy-applied-");
    try {
      await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
      await verifyCurrentTask(context, context.taskId);
      expect((await context.merger.mergeTeamTasks({ teamId: context.teamId, sessionId: context.sessionId })).applied).toHaveLength(1);
      await removeArtifactIdentity(context);
      if (changedAfterOldMerge) await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 999;\n");
      const verification = await createArtifactVerifier(context).verifyCompletedTasks({ teamId: context.teamId, sessionId: context.sessionId });
      expect(verification.verified.map((item) => item.status)).toEqual(["passed"]);
      const result = await context.merger.mergeTeamTasks({ teamId: context.teamId, sessionId: context.sessionId });
      expect(result.errors).toEqual([]);
      expect(changedAfterOldMerge ? result.conflicted : result.applied).toHaveLength(1);
      expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 2;\n");
    } finally { await context.close(); }
  });
}

test("recovers a legacy frozen apply before independently reverifying its artifact", async () => {
  const context = await createPendingMergeContext("chili-team-artifact-legacy-frozen-");
  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    await acceptPendingArtifacts(context);
    const interruptedMerger = new TeamMergeService({ teams: context.teams, cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store), sessionOperations: passthroughSessionOperations,
      runGit: async (input) => {
        const result = await runProcess("git", input.args, { cwd: input.cwd, ...(input.signal ? { signal: input.signal } : {}) });
        if (input.args[0] === "apply" && !input.args.includes("--check")) throw new Error("simulated old-process crash after apply");
        return result;
      },
    });
    expect((await interruptedMerger.mergeTeamTasks({ teamId: context.teamId, sessionId: context.sessionId })).errors).toHaveLength(1);
    await removeArtifactIdentity(context);
    expect((await createArtifactVerifier(context).verifyCompletedTasks({ teamId: context.teamId, sessionId: context.sessionId })).verified).toEqual([]);
    const recovered = await context.merger.mergeTeamTasks({ teamId: context.teamId, sessionId: context.sessionId });
    expect(recovered.applied).toHaveLength(1);
    const verified = await createArtifactVerifier(context).verifyCompletedTasks({ teamId: context.teamId, sessionId: context.sessionId });
    expect(verified.verified.map((item) => item.status)).toEqual(["passed"]);
    expect((await context.merger.mergeTeamTasks({ teamId: context.teamId, sessionId: context.sessionId })).applied).toHaveLength(1);
    expect(await readFile(join(context.dir, "packages/core/src/feature.ts"), "utf8")).toBe("export const value = 2;\n");
  } finally { await context.close(); }
});

async function removeArtifactIdentity(context: Awaited<ReturnType<typeof createPendingMergeContext>>): Promise<void> {
  const task = (await context.teams.tasks(context.teamId)).find((item) => item.id === context.taskId)!;
  const merge = { ...taskMergeMetadata(task.metadata) };
  delete merge.artifactCommit;
  await context.teams.updateTask({ teamId: context.teamId, taskId: context.taskId, sessionId: context.sessionId,
    metadata: { ...task.metadata, verification: { status: "passed" }, merge } });
}

test("refuses a preexisting dependent worktree with an obsolete base and preserves its edits", async () => {
  const context = await createPendingMergeContext("chili-team-artifact-old-dependent-");
  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const value = 2;\n");
    await verifyCurrentTask(context, context.taskId);
    expect((await context.merger.mergeTeamTasks({ teamId: context.teamId, sessionId: context.sessionId })).applied).toHaveLength(1);
    const dependent = await context.teams.createTask({ teamId: context.teamId, sessionId: context.sessionId, title: "Old dependent", ownerPath: "/root/worker" as AgentPath });
    const worktrees = new TeamWorktreeService({ teams: context.teams, cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store), sessionOperations: passthroughSessionOperations });
    const old = await worktrees.ensureTaskWorktree({ teamId: context.teamId, taskId: dependent.id, sessionId: context.sessionId });
    await writeFile(join(old.path, "packages/core/src/feature.ts"), "worker unfinished edit\n");
    await context.teams.updateTask({ teamId: context.teamId, taskId: dependent.id, sessionId: context.sessionId, dependsOn: [context.taskId] });
    await expect(worktrees.ensureTaskWorktree({ teamId: context.teamId, taskId: dependent.id, sessionId: context.sessionId }))
      .rejects.toThrow("Existing task worktree does not match");
    expect(await readFile(join(old.path, "packages/core/src/feature.ts"), "utf8")).toBe("worker unfinished edit\n");
  } finally { await context.close(); }
});

test("reuses a worktree whose dependency only delivered a read-only result", async () => {
  const context = await createPendingMergeContext("chili-team-artifact-read-only-base-");
  try {
    const analysis = await context.teams.createTask({ teamId: context.teamId, sessionId: context.sessionId, title: "Analysis", status: "completed" });
    const dependent = await context.teams.createTask({ teamId: context.teamId, sessionId: context.sessionId, title: "Implementation", ownerPath: "/root/worker" as AgentPath, dependsOn: [analysis.id] });
    const worktrees = new TeamWorktreeService({ teams: context.teams, cwd: context.dir,
      resolveSession: persistedRootSessionResolver(context.store), sessionOperations: passthroughSessionOperations });
    const first = await worktrees.ensureTaskWorktree({ teamId: context.teamId, taskId: dependent.id, sessionId: context.sessionId });
    const repeated = await worktrees.ensureTaskWorktree({ teamId: context.teamId, taskId: dependent.id, sessionId: context.sessionId });
    expect(repeated.created).toBe(false);
    expect(repeated.baseRef).toBe(first.baseRef);
    expect(repeated.path).toBe(first.path);
  } finally { await context.close(); }
});

async function verifyCurrentTask(context: Awaited<ReturnType<typeof createPendingMergeContext>>, taskId: TaskId): Promise<void> {
  const task = (await context.teams.tasks(context.teamId)).find((item) => item.id === taskId)!;
  await context.teams.updateTask({ teamId: context.teamId, taskId, sessionId: context.sessionId, status: "completed",
    metadata: { ...task.metadata, verification: { status: "failed" } } });
  const verifier = createArtifactVerifier(context);
  expect((await verifier.verifyTask({ teamId: context.teamId, taskId, sessionId: context.sessionId })).status).toBe("passed");
}

function createArtifactVerifier(context: Awaited<ReturnType<typeof createPendingMergeContext>>): TeamTaskVerificationService {
  return new TeamTaskVerificationService({
    teams: context.teams, cwd: context.dir, resolveSession: persistedRootSessionResolver(context.store),
    sessionOperations: passthroughSessionOperations,
    subagents: { async spawnTask() { return {
      taskId: "verifier" as TaskId, runId: "verify-run" as AgentRunId, path: "/root/worker/verifier" as AgentPath,
      parentPath: "/root/worker" as AgentPath, childSessionId: "verify-session" as SessionId,
      status: "completed" as const, summary: "VERDICT: passed\nDeterministic integration fixture inspected the artifact.",
    }; } },
  });
}

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
  await persistRootSession(store, sessionId, dir, now());
  const teams = new TeamControlService({ store, createId: ids, now });
  const worktrees = new TeamWorktreeService({
    teams,
    cwd: dir,
    now,
    resolveSession: persistedRootSessionResolver(store),
    sessionOperations: passthroughSessionOperations,
  });
  const merger = new TeamMergeService({
    teams,
    cwd: dir,
    now,
    resolveSession: persistedRootSessionResolver(store),
    sessionOperations: passthroughSessionOperations,
  });
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

// Existing recovery/authority cases start with a deterministic accepted artifact.
// This is explicit test setup: production merge never manufactures acceptance.
async function acceptPendingArtifacts(context: Awaited<ReturnType<typeof createPendingMergeContext>>): Promise<void> {
  for (const task of await context.teams.tasks(context.teamId)) {
    const merge = taskMergeMetadata(task.metadata);
    if (merge?.status !== "pending" || !merge.worktreePath || !merge.baseRef) continue;
    if (merge.worktreePath !== worktreeMetadata(task.metadata)?.path) continue;
    try {
      if (!(await lstat(merge.worktreePath)).isDirectory()) continue;
    } catch { continue; }
    const { patch, ...artifact } = await captureTeamTaskArtifact({ cwd: merge.worktreePath, baseRef: merge.baseRef });
    await context.teams.updateTask({
      teamId: task.teamId, taskId: task.id, sessionId: context.sessionId,
      metadata: { ...task.metadata, verification: { status: "passed", gitDiff: patch, artifact }, merge: { ...merge, diff: patch } },
    });
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

async function persistRootSession(
  store: SqliteEventStore,
  sessionId: SessionId,
  cwd: string,
  time: number,
): Promise<void> {
  await store.append({
    id: `event_${sessionId}`,
    type: "session.created",
    time: time as TimestampMs,
    sessionId,
    payload: { sessionId, cwd },
  });
}

function persistedRootSessionResolver(store: SqliteEventStore) {
  return async (sessionId: SessionId): Promise<{ cwd: string }> => {
    const session = (await store.sessions()).find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status !== "active") throw new Error(`Session is not active: ${sessionId}`);
    if (session.source === "subagent") throw new Error(`Session is not interactive: ${sessionId}`);
    return { cwd: session.cwd };
  };
}

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix: string) => `${prefix}_${++next}`;
}

const HOSTILE_SUCCESS_OUTPUT_SECRET = "sk-team-success-output-secret-123456789";

function hostileSuccessfulOutputError(label: string): Error {
  return new Error([
    `${label}: password=${HOSTILE_SUCCESS_OUTPUT_SECRET}`,
    `Authorization: Bearer ${HOSTILE_SUCCESS_OUTPUT_SECRET}`,
    `http://127.0.0.1:4567/callback?token=${HOSTILE_SUCCESS_OUTPUT_SECRET}`,
    "\u0000".repeat(5 * 1024 * 1024),
  ].join("\n"));
}

function expectBoundedSanitizedDiagnostic(value: string | undefined): void {
  expect(value).toBeDefined();
  if (value === undefined) return;
  expect(value).toContain("[REDACTED]");
  expect(value).not.toContain(HOSTILE_SUCCESS_OUTPUT_SECRET);
  expect(value).not.toContain("127.0.0.1");
  expect(value).not.toContain("\u0000");
  expect(utf8Bytes(value)).toBeLessThanOrEqual(16 * 1024);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const passthroughSessionOperations: SessionOperationCoordinator = {
  async withSessionOperation<T>(
    _sessionId: SessionId,
    fn: (operation: RuntimeSessionOperation) => Promise<T> | T,
  ): Promise<T> {
    const operation: RuntimeSessionOperation = {
      signal: new AbortController().signal,
      assertCurrent: () => {},
    };
    return fn(operation);
  },
};

interface TestSessionOperationState {
  sessionId: SessionId;
  controller: AbortController;
  active: boolean;
  operation: RuntimeSessionOperation;
}

class TestSessionOperationCoordinator implements SessionOperationCoordinator {
  readonly #storage = new AsyncLocalStorage<TestSessionOperationState>();
  readonly #active = new Map<SessionId, TestSessionOperationState>();
  acquisitions = 0;

  async withSessionOperation<T>(
    sessionId: SessionId,
    fn: (operation: RuntimeSessionOperation) => Promise<T> | T,
  ): Promise<T> {
    const inherited = this.#storage.getStore();
    if (inherited?.sessionId === sessionId) {
      inherited.operation.assertCurrent();
      const result = await fn(inherited.operation);
      inherited.operation.assertCurrent();
      return result;
    }
    if (this.#active.has(sessionId)) throw new RuntimeBusyError(sessionId);

    const controller = new AbortController();
    let state: TestSessionOperationState;
    state = {
      sessionId,
      controller,
      active: true,
      operation: {
        signal: controller.signal,
        assertCurrent: () => {
          if (!state.active || this.#active.get(sessionId) !== state) {
            throw new RuntimeBusyError(sessionId);
          }
        },
      },
    };
    this.#active.set(sessionId, state);
    this.acquisitions++;
    return this.#storage.run(state, async () => {
      try {
        state.operation.assertCurrent();
        const result = await fn(state.operation);
        state.operation.assertCurrent();
        return result;
      } finally {
        state.active = false;
        if (this.#active.get(sessionId) === state) this.#active.delete(sessionId);
      }
    });
  }

  invalidate(sessionId: SessionId): void {
    const state = this.#active.get(sessionId);
    if (!state) return;
    state.active = false;
    this.#active.delete(sessionId);
    state.controller.abort(new RuntimeBusyError(sessionId));
  }
}
