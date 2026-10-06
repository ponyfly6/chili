import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, SessionId, TaskId, TeamId, TimestampMs, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import {
  authorizeToolByPolicy,
  createApplyPatchTool,
  createBashTool,
  createEditTool,
  createGitDiffTool,
  createReadFileTool,
  createWriteFileTool,
  filterToolsByPolicy,
  observeRunProcessLifecycle,
  runProcess,
} from "@chili/tools";
import { LocalSubagentManager, type LocalSubagentRunInput, type LocalSubagentRunResult, type LocalSubagentRunner } from "./subagent.js";
import {
  RuntimeBusyError,
  type RuntimeSessionOperation,
  type SessionOperationCoordinator,
} from "./runtime-service.js";
import { TeamTaskDispatchService } from "./team-dispatcher.js";
import { TeamExecutionRunner } from "./team-execution-runner.js";
import { TeamSessionAuthorityError } from "./team-session-authority.js";
import { TeamControlService } from "./team.js";
import {
  TeamTaskVerificationService,
  type TeamTaskVerifierGitDiffInput,
  isAcceptedTeamTask,
  isCompletedButUnverifiedTeamTask,
  verificationMetadata,
  verifierWorkerPolicy,
} from "./team-verifier.js";
import { taskMergeMetadata, TeamTaskWorktreePathError, TeamWorktreeService } from "./team-worktree.js";

test("team runner auto-verifies worker completion before accepting the task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-runner-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1000 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_verifier_runner" as SessionId;
  const runner = new RoutingLocalSubagentRunner();

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
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
      resolveSession: testSessionResolver(dir),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
      gitDiff: async () => "diff --git a/packages/core/src/team.ts b/packages/core/src/team.ts",
    });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      verifier,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });

    const team = await teams.createTeam({ sessionId, name: "verifier-runner", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Implement verifier target",
      ownerPath: workerPath,
      metadata: {
        writeScope: ["packages/core"],
        suggestedTestCommands: ["bun test packages/core/src/team-verifier.test.ts"],
      },
    });

    const summary = await execution.run({ teamId: team.id, sessionId, mode: "one_shot", maxCycles: 3 });

    expect(summary).toMatchObject({
      stopReason: "drained",
      dispatched: [{ taskId: task.id, status: "completed", ownerPath: workerPath }],
      completed: [{ taskId: task.id, status: "completed", summary: "Implemented Implement verifier target" }],
      accepted: [{ taskId: task.id, status: "completed", summary: "Implemented Implement verifier target" }],
      reopened: [],
      errors: [],
    });
    expect(runner.runs.map((run) => run.taskName)).toEqual(["Implement verifier target", "Verify Implement verifier target"]);
    expect(runner.runs[1]?.prompt).toContain("Worker summary: Implemented Implement verifier target");
    expect(runner.runs[1]?.prompt).toContain("diff --git a/packages/core/src/team.ts b/packages/core/src/team.ts");
    expect(runner.runs[1]?.workerPolicy).toMatchObject({
      allowedTools: ["read", "glob", "grep", "git_diff", "bash", "complete_task"],
      writeScope: [],
      executeScope: ["bun test packages/core/src/team-verifier.test.ts"],
    });

    const [storedTask] = await teams.tasks(team.id);
    expect(storedTask?.status).toBe("completed");
    expect(verificationMetadata(storedTask?.metadata)?.status).toBe("passed");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier includes worker commits by diffing from the persisted worktree base", async () => {
  const dir = await mkVerifierGitRepo("chili-team-verifier-worker-commit-");
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1050 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_verifier_worker_commit" as SessionId;
  const runner = new FixedVerifierRunner("VERDICT: passed\nCommitted change is visible.");

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
    const verifier = new TeamTaskVerificationService({
      teams,
      subagents,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const team = await teams.createTeam({ sessionId, name: "verifier-worker-commit", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Verify committed work",
      ownerPath: workerPath,
    });
    const worktree = await worktrees.ensureTaskWorktree({
      teamId: team.id,
      taskId: task.id,
      sessionId,
      cwd: dir,
    });
    await writeFile(join(worktree.path, "packages/core/src/feature.ts"), "export const committed = 7;\n");
    await verifierGit(worktree.path, ["add", "packages/core/src/feature.ts"]);
    await verifierGit(worktree.path, ["commit", "-q", "-m", "worker commit"]);
    await teams.updateTask({
      sessionId,
      teamId: team.id,
      taskId: task.id,
      status: "completed",
      summary: "Committed the implementation",
      metadata: worktree.task.metadata ?? {},
    });

    const result = await verifier.verifyTask({ teamId: team.id, taskId: task.id, sessionId, cwd: dir });

    expect(result.status).toBe("passed");
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]?.prompt).toContain("export const committed = 7;");
    const [storedTask] = await teams.tasks(team.id);
    expect(verificationMetadata(storedTask?.metadata)?.gitDiff).toContain("export const committed = 7;");
    const artifact = verificationMetadata(storedTask?.metadata)?.artifact;
    expect(artifact).toMatchObject({ version: 1, baseCommit: worktree.baseRef });
    expect(artifact?.tree).toMatch(/^[0-9a-f]{40,64}$/);
    expect(artifact?.patchFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const verifiedContent = await runProcess("git", ["show", `${artifact?.commit}:packages/core/src/feature.ts`], {
      cwd: worktree.path,
      timeoutMs: 30_000,
    });
    expect(verifiedContent.exitCode).toBe(0);
    expect(verifiedContent.stdout).toBe("export const committed = 7;\n");
    expect(taskMergeMetadata(storedTask?.metadata)).toMatchObject({
      status: "pending",
      baseRef: worktree.baseRef,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["tracked", "untracked"] as const)("verifier rejects %s changes made while the verifier is running", async (kind) => {
  const context = await createArtifactVerifierContext(`chili-team-verifier-artifact-${kind}-`);
  const run = context.runner.run.bind(context.runner);
  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const committed = 2;\n");
    context.runner.run = async (input) => {
      expect(input.prompt).toContain("export const committed = 2;");
      await writeFile(join(context.worktreePath, kind === "tracked" ? "packages/core/src/feature.ts" : "unchecked.ts"), "export const unchecked = 999;\n");
      return run(input);
    };

    const result = await context.verify();

    expect(result.status).toBe("failed");
    const [task] = await context.teams.tasks(context.teamId);
    expect(task).toMatchObject({ status: "pending", error: "verification_failed" });
    expect(verificationMetadata(task?.metadata)?.feedback).toContain("worktree changed during verification");
    expect(verificationMetadata(task?.metadata)?.artifact).toBeDefined();
    expect(taskMergeMetadata(task?.metadata)).toBeUndefined();
  } finally {
    await context.close();
  }
});

test("immutable artifact patches retain the verifier byte limit", async () => {
  const context = await createArtifactVerifierContext("chili-team-verifier-artifact-limit-");
  try {
    await writeFile(join(context.worktreePath, "large.ts"), "x".repeat(210_000));

    const result = await context.verify();

    expect(result.status).toBe("failed");
    const [task] = await context.teams.tasks(context.teamId);
    expect(verificationMetadata(task?.metadata)?.feedback).toContain("git diff collection was incomplete");
    expect(verificationMetadata(task?.metadata)?.artifact).toBeDefined();
  } finally {
    await context.close();
  }
});

test.each([undefined, { version: 0 }] as const)("legacy applied tasks without a valid artifact are automatically reverified: %j", async (artifact) => {
  const context = await createArtifactVerifierContext("chili-team-verifier-legacy-applied-");
  try {
    await writeFile(join(context.worktreePath, "packages/core/src/feature.ts"), "export const committed = 2;\n");
    const [original] = await context.teams.tasks(context.teamId);
    if (!original) throw new Error("Missing legacy task fixture");
    const legacy = await context.teams.updateTask({
      teamId: context.teamId,
      taskId: original.id,
      metadata: {
        ...original.metadata,
        verification: { status: "passed", ...(artifact ? { artifact } : {}) },
        merge: { status: "applied", createdAt: 1000, mergedAt: 1100 },
      },
    });
    expect(isAcceptedTeamTask(legacy)).toBe(false);
    expect(isCompletedButUnverifiedTeamTask(legacy)).toBe(true);
    const claim = context.teams.claimTaskVerification.bind(context.teams);
    context.teams.claimTaskVerification = async (input) => {
      const [beforeClaim] = await context.teams.tasks(context.teamId);
      expect(beforeClaim?.status).toBe("completed");
      expect(verificationMetadata(beforeClaim?.metadata)?.status).toBe("failed");
      return claim(input);
    };

    const result = await context.sweep();

    expect(result.scanned).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.verified).toHaveLength(1);
    expect(result.verified[0]?.status).toBe("passed");
    expect(context.runner.runs).toHaveLength(1);
    const [task] = await context.teams.tasks(context.teamId);
    expect(task && isAcceptedTeamTask(task)).toBe(true);
    expect(verificationMetadata(task?.metadata)?.artifact).toBeDefined();
    expect(taskMergeMetadata(task?.metadata)).toMatchObject({ status: "pending", reason: "legacy_reverification" });
    expect(taskMergeMetadata(task?.metadata)?.mergedAt).toBeUndefined();
  } finally {
    await context.close();
  }
});

test.each(["applyStartedAt", "patchFingerprint"] as const)("legacy frozen pending merge with %s remains untouched until merger recovery", async (field) => {
  const context = await createArtifactVerifierContext("chili-team-verifier-legacy-frozen-");
  try {
    const [original] = await context.teams.tasks(context.teamId);
    if (!original) throw new Error("Missing frozen task fixture");
    const legacy = await context.teams.updateTask({
      teamId: context.teamId,
      taskId: original.id,
      metadata: {
        ...original.metadata,
        verification: { status: "passed", feedback: "Legacy verifier passed" },
        merge: { status: "pending", createdAt: 1000, diff: "frozen patch", [field]: field === "applyStartedAt" ? 1100 : "frozen-fingerprint" },
      },
    });

    const result = await context.sweep();
    const direct = await context.verify();

    expect(result).toMatchObject({ scanned: 0, verified: [], errors: [] });
    expect(direct).toMatchObject({ status: "skipped", reason: "merge_pending" });
    expect(context.runner.runs).toHaveLength(0);
    const [task] = await context.teams.tasks(context.teamId);
    expect(task).toEqual(legacy);
  } finally {
    await context.close();
  }
});

test("failed verifier reopens the task with feedback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-failed-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1100 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_verifier_failed" as SessionId;
  const runner = new FixedVerifierRunner("VERDICT: failed\nMissing coverage for retry timeout.");

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const verifier = new TeamTaskVerificationService({
      teams,
      subagents,
      cwd: dir,
      now,
      resolveSession: testSessionResolver(dir),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
      gitDiff: async () => "(no diff)",
    });
    const team = await teams.createTeam({ sessionId, name: "verifier-failed", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Needs verification", ownerPath: workerPath });
    await teams.updateTask({
      sessionId,
      teamId: team.id,
      taskId: task.id,
      status: "completed",
      summary: "Worker says done",
    });

    const result = await verifier.verifyCompletedTasks({ teamId: team.id, sessionId });

    expect(result.verified).toMatchObject([
      { status: "failed", feedback: "VERDICT: failed\nMissing coverage for retry timeout." },
    ]);
    const [storedTask] = await teams.tasks(team.id);
    expect(storedTask).toMatchObject({ id: task.id, status: "pending", error: "verification_failed" });
    expect(verificationMetadata(storedTask?.metadata)).toMatchObject({
      status: "failed",
      feedback: "VERDICT: failed\nMissing coverage for retry timeout.",
      workerSummary: "Worker says done",
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  ["failed before a quoted earlier pass", "VERDICT: failed\nMissing coverage. Earlier output:\n```\nVERDICT: passed\n```", "failed"],
  ["pass only in a quotation", "Earlier output:\nVERDICT: passed", "failed"],
  ["pass only in a code fence", "```\nVERDICT: passed\n```", "failed"],
  ["contradictory verdicts", "VERDICT: passed\nVERDICT: failed", "failed"],
  ["quoted contradictory verdict", "VERDICT: passed\n> VERDICT: failed", "failed"],
  ["inline quoted contradictory verdict", "VERDICT: passed\nThe old result was **VERDICT: failed**.", "failed"],
  ["formatted contradictory verdict", "VERDICT: passed\nFinal **VERDICT**: failed. Required coverage is missing.", "failed"],
  ["ordinary verdict property description", "VERDICT: passed\nValidated the `verdict: string` field in the protocol.", "passed"],
  ["repeated passing verdict", "VERDICT: passed\nVERDICT: passed", "failed"],
  ["negated passing prefix", "VERDICT: passed - actually no, tests failed", "failed"],
  ["verdict split over two lines", "VERDICT:\npassed", "failed"],
  ["missing verdict", "Tests passed.", "failed"],
  ["empty summary", "", "failed"],
  ["one leading verdict with CRLF", "  \r\nVERDICT: PASSED\r\nTests passed.\r\n", "passed"],
] as const)("verifier requires an unambiguous first-line verdict: %s", async (_name, summary, status) => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-verdict-"));
  const context = await createVerifierRegressionContext(dir, { summary, gitDiff: async () => "(no diff)" });
  try {
    const result = await context.verify();
    expect(result.status).toBe(status);
    const [stored] = await context.teams.tasks(context.teamId);
    expect(stored?.status).toBe(status === "passed" ? "completed" : "pending");
    expect(verificationMetadata(stored?.metadata)?.status).toBe(status);
  } finally {
    await context.close();
  }
});

test("verifier bounds tracked diffs by UTF-8 bytes and cannot accept omitted changes", async () => {
  const dir = await mkVerifierGitRepo("chili-team-verifier-tracked-budget-");
  const context = await createVerifierRegressionContext(dir);
  try {
    await writeFile(join(dir, "packages/core/src/feature.ts"), `export const changed = true;\n${"// 中文🌶️\n".repeat(30_000)}`);
    const result = await context.verify();
    const [stored] = await context.teams.tasks(context.teamId);
    const diff = verificationMetadata(stored?.metadata)?.gitDiff ?? "";
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ feedback: expect.stringContaining("git diff collection was incomplete") });
    expect(stored?.status).toBe("pending");
    expect(Buffer.byteLength(diff, "utf8")).toBeLessThanOrEqual(200_000);
    expect(diff).toContain("export const changed = true;");
    expect(diff.slice(0, 300)).toContain("Git diff incomplete: tracked diff truncated at UTF-8 byte limit");
    expect(diff).not.toContain("�");
    const snapshot = context.runner.runs[0]?.prompt.split("Git diff at verifier start:\n")[1] ?? "";
    expect(Buffer.byteLength(snapshot, "utf8")).toBeLessThanOrEqual(200_000);
    expect(snapshot.startsWith("[Git diff incomplete:")).toBe(true);
    expect(snapshot.includes("�")).toBe(false);
  } finally {
    await context.close();
  }
});

test("verifier stops collecting untracked diffs when the aggregate UTF-8 budget is exhausted", async () => {
  const dir = await mkVerifierGitRepo("chili-team-verifier-untracked-budget-");
  const context = await createVerifierRegressionContext(dir);
  let processesStarted = 0;
  try {
    await Promise.all(Array.from({ length: 40 }, (_, index) => writeFile(
      join(dir, `new-${String(index).padStart(3, "0")}.txt`),
      `${"中文🌶️".repeat(700)}\n`,
    )));
    const unsubscribe = observeRunProcessLifecycle((event) => {
      if (event.type === "started") processesStarted++;
    });
    try {
      expect((await context.verify()).status).toBe("failed");
    } finally {
      unsubscribe();
    }
    const [stored] = await context.teams.tasks(context.teamId);
    const diff = verificationMetadata(stored?.metadata)?.gitDiff ?? "";
    expect(Buffer.byteLength(diff, "utf8")).toBeLessThanOrEqual(200_000);
    expect(diff.slice(0, 300)).toContain("Git diff incomplete: untracked diff truncated at UTF-8 byte limit");
    expect(diff).not.toContain("new-039.txt");
    expect(diff).not.toContain("�");
    expect(processesStarted).toBeLessThan(30);
  } finally {
    await context.close();
  }
});

test("verifier bounds the number of untracked file processes even when patches are small", async () => {
  const dir = await mkVerifierGitRepo("chili-team-verifier-file-budget-");
  const context = await createVerifierRegressionContext(dir);
  let processesStarted = 0;
  try {
    await Promise.all(Array.from({ length: 150 }, (_, index) => writeFile(
      join(dir, `new-${String(index).padStart(3, "0")}.txt`),
      "small change\n",
    )));
    const unsubscribe = observeRunProcessLifecycle((event) => {
      if (event.type === "started") processesStarted++;
    });
    try {
      expect((await context.verify()).status).toBe("failed");
    } finally {
      unsubscribe();
    }
    const [stored] = await context.teams.tasks(context.teamId);
    const diff = verificationMetadata(stored?.metadata)?.gitDiff ?? "";
    expect(diff.slice(0, 300)).toContain("Git diff incomplete: untracked file limit reached (128 files)");
    expect(diff).toContain("new-127.txt");
    expect(diff).not.toContain("new-128.txt");
    expect(processesStarted).toBe(130);
  } finally {
    await context.close();
  }
}, 15_000);

test("verifier includes untracked paths with spaces and newlines without splitting the filename", async () => {
  const dir = await mkVerifierGitRepo("chili-team-verifier-untracked-name-");
  const context = await createVerifierRegressionContext(dir);
  try {
    await writeFile(join(dir, "new file\nwith newline.txt"), "new implementation\n");
    expect((await context.verify()).status).toBe("passed");
    const [stored] = await context.teams.tasks(context.teamId);
    expect(verificationMetadata(stored?.metadata)?.gitDiff).toContain("+new implementation");
  } finally {
    await context.close();
  }
});

test("abort while collecting real git output stops subsequent files and releases the verification claim", async () => {
  const dir = await mkVerifierGitRepo("chili-team-verifier-git-abort-");
  const context = await createVerifierRegressionContext(dir);
  const controller = new AbortController();
  let processesStarted = 0;
  try {
    await Promise.all(Array.from({ length: 10 }, (_, index) => writeFile(join(dir, `new-${index}.txt`), "change\n")));
    const unsubscribe = observeRunProcessLifecycle((event) => {
      if (event.type === "started" && ++processesStarted === 3) controller.abort();
    });
    try {
      await expect(context.verify(controller.signal)).rejects.toThrow();
    } finally {
      unsubscribe();
    }
    expect(processesStarted).toBe(3);
    expect(context.runner.runs).toEqual([]);
    const [stored] = await context.teams.tasks(context.teamId);
    expect(stored?.status).toBe("completed");
    expect(verificationMetadata(stored?.metadata)).toBeUndefined();
  } finally {
    await context.close();
  }
});

test("an empty collection error cannot be overridden by a passing verifier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-empty-error-"));
  const context = await createVerifierRegressionContext(dir, { gitDiff: async () => { throw new Error(""); } });
  try {
    expect((await context.verify()).status).toBe("failed");
    const [stored] = await context.teams.tasks(context.teamId);
    expect(verificationMetadata(stored?.metadata)?.feedback).toContain("unknown git diff collection error");
    expect(stored?.status).toBe("pending");
  } finally {
    await context.close();
  }
});

test.each([false, true])("read-only verification can inspect files without a committed Git baseline (repository: %s)", async (initializeGit) => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-readonly-baseline-"));
  if (initializeGit) await verifierGit(dir, ["init", "-q"]);
  const context = await createVerifierRegressionContext(dir, { metadata: { writeScope: [], requiredTools: ["read"] } });
  try {
    expect((await context.verify()).status).toBe("passed");
    const [stored] = await context.teams.tasks(context.teamId);
    expect(verificationMetadata(stored?.metadata)?.gitDiff).toContain("Inspect the relevant files and task result directly");
    expect(stored?.status).toBe("completed");
  } finally {
    await context.close();
  }
});

test.each([
  { writeScope: ["."] },
  { writeScope: [], executeScope: ["bun run build"] },
  { writeScope: [], requiredTools: ["shell"] },
])("verification of tasks with write or execution capability still requires a Git baseline: %j", async (metadata) => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-writing-baseline-"));
  const context = await createVerifierRegressionContext(dir, { metadata });
  try {
    expect((await context.verify()).status).toBe("failed");
    const [stored] = await context.teams.tasks(context.teamId);
    expect(verificationMetadata(stored?.metadata)?.gitDiff).toContain("Git diff incomplete: git diff failed");
  } finally {
    await context.close();
  }
});

test("verifier cannot pass when git diff collection fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-git-error-"));
  const context = await createVerifierRegressionContext(dir);
  try {
    expect((await context.verify()).status).toBe("failed");
    const [stored] = await context.teams.tasks(context.teamId);
    expect(verificationMetadata(stored?.metadata)?.gitDiff).toContain("Git diff incomplete: git diff failed");
  } finally {
    await context.close();
  }
});

test("verifier rejects forged worktree metadata before verification claim, git, or spawn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-path-authority-"));
  const workspaceB = await mkdtemp(join(tmpdir(), "chili-team-verifier-path-b-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1125 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_verifier_path_authority" as SessionId;
  const runner = new FixedVerifierRunner("VERDICT: passed\nShould not run.");
  let gitDiffCalls = 0;

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const verifier = new TeamTaskVerificationService({
      teams,
      subagents,
      cwd: dir,
      now,
      resolveSession: testSessionResolver(dir),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
      gitDiff: async () => {
        gitDiffCalls++;
        return "(should not run)";
      },
    });
    const team = await teams.createTeam({ sessionId, name: "verifier-path-authority", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Forged worktree",
      ownerPath: workerPath,
      metadata: {
        worktree: {
          path: workspaceB,
          baseRef: "HEAD",
          createdAt: 1125,
          status: "active",
        },
      },
    });
    await teams.updateTask({
      sessionId,
      teamId: team.id,
      taskId: task.id,
      status: "completed",
      summary: "Worker says done",
    });

    await expect(verifier.verifyTask({
      teamId: team.id,
      taskId: task.id,
      sessionId,
      cwd: dir,
    })).rejects.toBeInstanceOf(TeamTaskWorktreePathError);

    expect(gitDiffCalls).toBe(0);
    expect(runner.runs).toEqual([]);
    const [storedTask] = await teams.tasks(team.id);
    expect(verificationMetadata(storedTask?.metadata)).toBeUndefined();
  } finally {
    store.close();
    await rm(workspaceB, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort during verifier setup does not mark verification pending or reopen the task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-abort-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1150 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_verifier_abort" as SessionId;
  const controller = new AbortController();
  const runner = new FixedVerifierRunner("VERDICT: failed\nShould not run.");

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
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
      resolveSession: testSessionResolver(dir),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
      gitDiff: async () => {
        controller.abort();
        const error = new Error("git diff aborted");
        error.name = "AbortError";
        throw error;
      },
    });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      verifier,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const team = await teams.createTeam({ sessionId, name: "verifier-abort", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Abort verifier setup", ownerPath: workerPath });
    await teams.updateTask({
      sessionId,
      teamId: team.id,
      taskId: task.id,
      status: "completed",
      summary: "Worker says done",
    });

    const summary = await execution.run({ teamId: team.id, sessionId, signal: controller.signal });

    expect(summary).toMatchObject({
      stopReason: "aborted",
      errors: [],
      reopened: [],
      accepted: [],
    });
    expect(runner.runs).toEqual([]);
    const [storedTask] = await teams.tasks(team.id);
    expect(storedTask).toMatchObject({ id: task.id, status: "completed", summary: "Worker says done" });
    expect(verificationMetadata(storedTask?.metadata)).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier sweep runs completed tasks with bounded parallelism", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-parallel-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1180 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerA = "/root/a" as AgentPath;
  const workerB = "/root/b" as AgentPath;
  const workerC = "/root/c" as AgentPath;
  const sessionId = "session_team_verifier_parallel" as SessionId;
  const runner = new BarrierVerifierRunner();

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const verifier = new TeamTaskVerificationService({
      teams,
      subagents,
      cwd: dir,
      now,
      resolveSession: testSessionResolver(dir),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
      gitDiff: async () => "(no diff)",
    });
    const team = await teams.createTeam({ sessionId, name: "verifier-parallel", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerA, name: "a", role: "implementer" });
    await teams.addMember({ sessionId, teamId: team.id, path: workerB, name: "b", role: "implementer" });
    await teams.addMember({ sessionId, teamId: team.id, path: workerC, name: "c", role: "implementer" });
    const first = await teams.createTask({ sessionId, teamId: team.id, title: "Verify first", ownerPath: workerA });
    const second = await teams.createTask({ sessionId, teamId: team.id, title: "Verify second", ownerPath: workerB });
    const third = await teams.createTask({ sessionId, teamId: team.id, title: "Verify third", ownerPath: workerC });
    for (const task of [first, second, third]) {
      await teams.updateTask({ sessionId, teamId: team.id, taskId: task.id, status: "completed", summary: `Done ${task.title}` });
    }

    const verification = verifier.verifyCompletedTasks({ teamId: team.id, sessionId, maxConcurrentVerifications: 2 });
    await runner.firstBatchStarted;
    expect(runner.running).toBe(2);
    expect(runner.runs).toHaveLength(2);
    runner.releaseFirstBatch();
    const result = await verification;

    expect(result.maxConcurrentVerifications).toBe(2);
    expect(result.verified).toHaveLength(3);
    expect(result.errors).toEqual([]);
    expect(runner.maxRunning).toBe(2);
    expect(runner.runs.map((run) => run.taskName).sort()).toEqual([
      "Verify Verify first",
      "Verify Verify second",
      "Verify Verify third",
    ]);
  } finally {
    runner.releaseFirstBatch();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalizes hostile verifier sweep failures before returning them", async () => {
  const context = await createDirectVerifierContext("chili-team-verifier-hostile-error-");
  const originalUpdateTask = context.teams.updateTask.bind(context.teams);
  let injected = false;

  try {
    context.teams.updateTask = async (input) => {
      if (!injected && input.taskId === context.taskId) {
        injected = true;
        throw hostileSuccessfulOutputError("verifier update failed");
      }
      return originalUpdateTask(input);
    };
    const verifier = context.createVerifier();

    const result = await verifier.verifyCompletedTasks({ teamId: context.teamId });

    expect(result.errors).toHaveLength(1);
    expectBoundedSanitizedDiagnostic(result.errors[0]?.error);
    expect(utf8Bytes(JSON.stringify(result))).toBeLessThan(64 * 1024);
  } finally {
    await context.close();
  }
});

test("verifier sweep skips a task already claimed by another verifier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-claim-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1190 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_verifier_claim" as SessionId;
  const runner = new BlockingVerifierRunner();

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const verifier = new TeamTaskVerificationService({
      teams,
      subagents,
      cwd: dir,
      now,
      resolveSession: testSessionResolver(dir),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
      gitDiff: async () => "(no diff)",
    });
    const team = await teams.createTeam({ sessionId, name: "verifier-claim", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Claim once", ownerPath: workerPath });
    await teams.updateTask({ sessionId, teamId: team.id, taskId: task.id, status: "completed", summary: "Done" });

    const first = verifier.verifyCompletedTasks({ teamId: team.id, sessionId });
    await runner.started;
    const second = await verifier.verifyCompletedTasks({ teamId: team.id, sessionId });
    runner.release();
    const firstResult = await first;

    expect(second).toMatchObject({ scanned: 0, verified: [], skipped: [], errors: [] });
    expect(firstResult.verified).toHaveLength(1);
    expect(runner.runs).toHaveLength(1);
  } finally {
    runner.release();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct verifier rejects a wrong or archived owner session before side effects", async () => {
  const context = await createDirectVerifierContext("chili-team-verifier-direct-authority-");

  try {
    context.operations.resetAcquisitions();
    const verifier = context.createVerifier();

    await expect(verifier.verifyTask({
      teamId: context.teamId,
      taskId: context.taskId,
      sessionId: context.actorSessionId,
    })).rejects.toBeInstanceOf(TeamSessionAuthorityError);

    context.setOwnerStatus("archived");
    await expect(verifier.verifyTask({
      teamId: context.teamId,
      taskId: context.taskId,
    })).rejects.toBeInstanceOf(TeamSessionAuthorityError);

    expect(context.operations.acquisitions).toEqual([]);
    expect(context.gitDiffCwds).toEqual([]);
    expect(context.runner.runs).toEqual([]);
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(verificationMetadata(storedTask?.metadata)).toBeUndefined();
  } finally {
    await context.close();
  }
});

test("direct verifier rejects a busy owner session without claiming or spawning", async () => {
  const context = await createDirectVerifierContext("chili-team-verifier-direct-busy-");

  try {
    context.operations.resetAcquisitions();
    context.operations.block(context.ownerSessionId);
    const verifier = context.createVerifier();

    await expect(verifier.verifyCompletedTasks({
      teamId: context.teamId,
    })).rejects.toBeInstanceOf(RuntimeBusyError);

    expect(context.operations.acquisitions).toEqual([]);
    expect(context.gitDiffCwds).toEqual([]);
    expect(context.runner.runs).toEqual([]);
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(verificationMetadata(storedTask?.metadata)).toBeUndefined();
  } finally {
    context.operations.unblock(context.ownerSessionId);
    await context.close();
  }
});

test("direct verifier stops after losing its owner lease", async () => {
  const context = await createDirectVerifierContext("chili-team-verifier-direct-lost-");

  try {
    context.operations.resetAcquisitions();
    const verifier = context.createVerifier(async (input) => {
      context.gitDiffCwds.push(input.cwd);
      context.operations.lose(context.ownerSessionId);
      return "(diff before lease loss)";
    });

    await expect(verifier.verifyCompletedTasks({
      teamId: context.teamId,
    })).rejects.toBeInstanceOf(RuntimeBusyError);

    expect(context.operations.acquisitions).toEqual([context.ownerSessionId]);
    expect(context.runner.runs).toEqual([]);
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(verificationMetadata(storedTask?.metadata)?.status).toBe("pending");
  } finally {
    await context.close();
  }
});

test.each(["claim", "subagent"] as const)("cancellation after %s releases the verifier claim for an immediate retry", async (stage) => {
  const context = await createDirectVerifierContext(`chili-team-verifier-cancel-${stage}-`);
  const controller = new AbortController();
  const cancellation = new Error(`Cancelled after ${stage}`);
  const claim = context.teams.claimTaskVerification.bind(context.teams);
  const run = context.runner.run.bind(context.runner);

  try {
    if (stage === "claim") {
      context.teams.claimTaskVerification = async (input) => {
        const result = await claim(input);
        controller.abort(cancellation);
        return result;
      };
    } else {
      context.runner.run = async (input) => {
        const result = await run(input);
        controller.abort(cancellation);
        return result;
      };
    }
    const verifier = context.createVerifier();
    await expect(verifier.verifyTask({
      teamId: context.teamId,
      taskId: context.taskId,
      signal: controller.signal,
    })).rejects.toBe(cancellation);

    const [cancelledTask] = await context.teams.tasks(context.teamId);
    expect(cancelledTask?.status).toBe("completed");
    expect(verificationMetadata(cancelledTask?.metadata)).toBeUndefined();

    context.teams.claimTaskVerification = claim;
    context.runner.run = run;
    const retry = await verifier.verifyTask({ teamId: context.teamId, taskId: context.taskId });
    expect(retry.status).toBe("passed");
  } finally {
    await context.close();
  }
});

test("lease loss after the verifier runs preserves its pending claim", async () => {
  const context = await createDirectVerifierContext("chili-team-verifier-lost-after-run-");
  const run = context.runner.run.bind(context.runner);

  try {
    context.runner.run = async (input) => {
      const result = await run(input);
      context.operations.lose(context.ownerSessionId);
      return result;
    };
    await expect(context.createVerifier().verifyTask({
      teamId: context.teamId,
      taskId: context.taskId,
    })).rejects.toBeInstanceOf(RuntimeBusyError);

    const [task] = await context.teams.tasks(context.teamId);
    expect(task?.status).toBe("completed");
    expect(verificationMetadata(task?.metadata)?.status).toBe("pending");
    expect(context.runner.runs).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("direct verifier reenters the persisted owner operation", async () => {
  const context = await createDirectVerifierContext("chili-team-verifier-direct-nested-");

  try {
    context.operations.resetAcquisitions();
    const verifier = context.createVerifier();
    const [beforeVerification] = await context.teams.tasks(context.teamId);
    expect(beforeVerification?.sessionId).toBe(context.ownerSessionId);
    const result = await context.operations.withSessionOperation(
      context.ownerSessionId,
      () => verifier.verifyTask({ teamId: context.teamId, taskId: context.taskId }),
    );

    expect(result.status).toBe("passed");
    expect(context.operations.acquisitions).toEqual([context.ownerSessionId]);
    const canonicalOwnerCwd = await realpath(context.ownerCwd);
    expect(context.gitDiffCwds).toEqual([canonicalOwnerCwd]);
    expect(context.runner.runs).toHaveLength(1);
    expect(context.runner.runs[0]).toMatchObject({
      parentSessionId: context.ownerSessionId,
      cwd: canonicalOwnerCwd,
    });
    expect(context.runner.runs[0]?.cwd).not.toBe(context.defaultCwd);
    const [storedTask] = await context.teams.tasks(context.teamId);
    expect(storedTask?.sessionId).toBe(context.ownerSessionId);
    expect(verificationMetadata(storedTask?.metadata)?.status).toBe("passed");
  } finally {
    await context.close();
  }
});

test("verifier policy is read-only and denies write tools", async () => {
  const policy = verifierWorkerPolicy({
    teamId: "team_policy" as TeamId,
    taskId: "task_policy" as TaskId,
    memberPath: "/root/worker" as AgentPath,
    parentSessionId: "session_policy" as SessionId,
    testCommands: [
      "bun test packages/core/src/team-verifier.test.ts",
      "bun test packages/core/src/team-verifier.test.ts; rm -rf .",
      "npm run test > out.txt",
      "rm -rf .",
    ],
  });
  const read = createReadFileTool();
  const gitDiff = createGitDiffTool();
  const bash = createBashTool();
  const edit = createEditTool();
  const write = createWriteFileTool();
  const applyPatch = createApplyPatchTool();

  expect(policy.allowedTools).toEqual(["read", "glob", "grep", "git_diff", "bash", "complete_task"]);
  expect(policy.writeScope).toEqual([]);
  expect(policy.executeScope).toEqual(["bun test packages/core/src/team-verifier.test.ts"]);
  expect(filterToolsByPolicy([read, gitDiff, bash, edit, write, applyPatch], policy).map((tool) => tool.name)).toEqual([
    "read",
    "bash",
  ]);
  // Git can invoke repository filters and does not implement scoped isolation;
  // a name allowlist cannot grant capabilities the backend cannot enforce.
  await expect(authorizeToolByPolicy({
    tool: gitDiff,
    executeInput: { sessionId: "session_policy" as SessionId, turnId: "turn_policy" as TurnId,
      toolName: "git_diff", input: {}, cwd: "/tmp" },
    validatedInput: {}, approvalSpec: { permission: "git_diff", patterns: ["*"], metadata: {} },
    policy, isReadOnly: actualReadOnly,
  })).rejects.toThrow("not allowed");
  await expect(
    authorizeToolByPolicy({
      tool: bash,
      executeInput: {
        sessionId: "session_policy" as SessionId,
        turnId: "turn_policy" as TurnId,
        toolName: "bash",
        input: { command: "bun test packages/core/src/team-verifier.test.ts" },
        cwd: "/tmp",
      },
      validatedInput: { command: "bun test packages/core/src/team-verifier.test.ts" },
      approvalSpec: { permission: "bash", patterns: ["bun test packages/core/src/team-verifier.test.ts"], metadata: {} },
      policy,
      isReadOnly: actualReadOnly,
    }),
  ).resolves.toBeUndefined();
  await expect(
    authorizeToolByPolicy({
      tool: bash,
      executeInput: {
        sessionId: "session_policy" as SessionId,
        turnId: "turn_policy" as TurnId,
        toolName: "bash",
        input: { command: "bun test packages/core/src/other.test.ts" },
        cwd: "/tmp",
      },
      validatedInput: { command: "bun test packages/core/src/other.test.ts" },
      approvalSpec: { permission: "bash", patterns: ["bun test packages/core/src/other.test.ts"], metadata: {} },
      policy,
      isReadOnly: actualReadOnly,
    }),
  ).rejects.toThrow("execute scope");
  await expect(
    authorizeToolByPolicy({
      tool: bash,
      executeInput: {
        sessionId: "session_policy" as SessionId,
        turnId: "turn_policy" as TurnId,
        toolName: "bash",
        input: { command: "bun test packages/core/src/team-verifier.test.ts; rm -rf ." },
        cwd: "/tmp",
      },
      validatedInput: { command: "bun test packages/core/src/team-verifier.test.ts; rm -rf ." },
      approvalSpec: { permission: "bash", patterns: ["bun test packages/core/src/team-verifier.test.ts; rm -rf ."], metadata: {} },
      policy,
      isReadOnly: actualReadOnly,
    }),
  ).rejects.toThrow("execute scope");
  await expect(
    authorizeToolByPolicy({
      tool: edit,
      executeInput: {
        sessionId: "session_policy" as SessionId,
        turnId: "turn_policy" as TurnId,
        toolName: "edit",
        input: {},
        cwd: "/tmp",
      },
      validatedInput: {} as never,
      approvalSpec: { permission: "edit", patterns: ["packages/core/src/team.ts"], metadata: {} },
      policy,
      isReadOnly: async () => false,
    }),
  ).rejects.toThrow("not allowed");
});

test("runner does not report drained while a completed task is unverified", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-verifier-undrained-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1200 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_verifier_undrained" as SessionId;
  const runner = new RoutingLocalSubagentRunner();

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
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
      resolveSession: testSessionResolver(dir),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
      gitDiff: async () => "(no diff)",
    });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      verifier,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    });
    const team = await teams.createTeam({ sessionId, name: "verifier-undrained", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    await teams.createTask({ sessionId, teamId: team.id, title: "Complete then verify later", ownerPath: workerPath });

    const summary = await execution.run({ teamId: team.id, sessionId, mode: "one_shot", maxCycles: 1 });

    expect(summary).toMatchObject({
      stopReason: "max_cycles",
      completed: [{ status: "completed" }],
      accepted: [],
      stillRunning: [],
    });
    expect(runner.runs.map((run) => run.taskName)).toEqual(["Complete then verify later"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function createVerifierRegressionContext(
  dir: string,
  options: {
    summary?: string;
    gitDiff?: (input: TeamTaskVerifierGitDiffInput) => Promise<string>;
    metadata?: Record<string, unknown>;
  } = {},
) {
  // Keep the store outside the inspected directory so it never becomes a worker change.
  const storeDir = await mkdtemp(join(tmpdir(), "chili-team-verifier-regression-store-"));
  const store = new SqliteEventStore(join(storeDir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1100 as TimestampMs;
  const sessionId = "session_team_verifier_regression" as SessionId;
  const workerPath = "/root/worker" as AgentPath;
  const teams = new TeamControlService({ store, createId: ids, now });
  const runner = new FixedVerifierRunner(options.summary ?? "VERDICT: passed\nLooks good.");
  const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
  const verifier = new TeamTaskVerificationService({
    teams,
    subagents,
    cwd: dir,
    now,
    resolveSession: testSessionResolver(dir),
    sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
    ...(options.gitDiff ? { gitDiff: options.gitDiff } : {}),
  });
  const team = await teams.createTeam({ sessionId, name: "verifier-regression", leadPath: "/root" as AgentPath });
  await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
  const task = await teams.createTask({
    sessionId,
    teamId: team.id,
    title: "Verify worker changes",
    ownerPath: workerPath,
    metadata: options.metadata ?? { writeScope: ["."] },
  });
  await teams.updateTask({ sessionId, teamId: team.id, taskId: task.id, status: "completed", summary: "Done" });
  return {
    teams,
    teamId: team.id,
    runner,
    verify(signal?: AbortSignal) {
      return verifier.verifyTask({ teamId: team.id, taskId: task.id, sessionId, ...(signal ? { signal } : {}) });
    },
    async close() {
      store.close();
      await rm(storeDir, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function createArtifactVerifierContext(prefix: string) {
  const dir = await mkVerifierGitRepo(prefix);
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1250 as TimestampMs;
  const sessionId = "session_team_verifier_artifact" as SessionId;
  const workerPath = "/root/worker" as AgentPath;
  await persistRootSession(store, sessionId, dir);
  const teams = new TeamControlService({ store, createId: ids, now });
  const runner = new FixedVerifierRunner("VERDICT: passed\nThe implementation is correct.");
  const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
  const options = {
    teams,
    cwd: dir,
    now,
    resolveSession: persistedRootSessionResolver(store),
    sessionOperations: PASSTHROUGH_SESSION_OPERATIONS,
  };
  const worktrees = new TeamWorktreeService(options);
  const verifier = new TeamTaskVerificationService({ ...options, subagents });
  const team = await teams.createTeam({ sessionId, name: "artifact-verifier", leadPath: "/root" as AgentPath });
  await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
  const task = await teams.createTask({ sessionId, teamId: team.id, title: "Verify exact changes", ownerPath: workerPath });
  const worktree = await worktrees.ensureTaskWorktree({ teamId: team.id, taskId: task.id, sessionId, cwd: dir });
  await teams.updateTask({
    sessionId,
    teamId: team.id,
    taskId: task.id,
    status: "completed",
    summary: "Implementation complete",
    metadata: worktree.task.metadata ?? {},
  });
  return {
    teams,
    teamId: team.id,
    runner,
    worktreePath: worktree.path,
    verify: () => verifier.verifyTask({ teamId: team.id, taskId: task.id, sessionId, cwd: dir }),
    sweep: () => verifier.verifyCompletedTasks({ teamId: team.id, sessionId, cwd: dir }),
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

interface DirectVerifierContext {
  ownerCwd: string;
  defaultCwd: string;
  ownerSessionId: SessionId;
  actorSessionId: SessionId;
  teamId: TeamId;
  taskId: TaskId;
  teams: TeamControlService;
  runner: FixedVerifierRunner;
  operations: TestSessionOperationCoordinator;
  gitDiffCwds: string[];
  setOwnerStatus(status: "active" | "archived"): void;
  createVerifier(
    gitDiff?: (input: TeamTaskVerifierGitDiffInput) => Promise<string>,
  ): TeamTaskVerificationService;
  close(): Promise<void>;
}

async function createDirectVerifierContext(prefix: string): Promise<DirectVerifierContext> {
  const ownerCwd = await mkdtemp(join(tmpdir(), `${prefix}owner-`));
  const defaultCwd = await mkdtemp(join(tmpdir(), `${prefix}default-`));
  const store = new SqliteEventStore(join(ownerCwd, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 1250 as TimestampMs;
  const ownerSessionId = "session_team_verifier_direct_owner" as SessionId;
  const actorSessionId = "session_team_verifier_direct_actor" as SessionId;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const operations = new TestSessionOperationCoordinator();
  const teams = new TeamControlService({ store, createId: ids, now, sessionOperations: operations });
  const runner = new FixedVerifierRunner("VERDICT: passed\nDirect verification passed.");
  const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
  const team = await teams.createTeam({ sessionId: ownerSessionId, name: "direct-verifier", leadPath });
  await teams.addMember({
    sessionId: ownerSessionId,
    teamId: team.id,
    path: workerPath,
    name: "worker",
    role: "implementer",
  });
  const task = await teams.createTask({
    sessionId: ownerSessionId,
    teamId: team.id,
    title: "Verify direct API",
    ownerPath: workerPath,
  });
  await teams.updateTask({
    sessionId: ownerSessionId,
    teamId: team.id,
    taskId: task.id,
    status: "completed",
    summary: "Actor completed the task",
  });

  let ownerStatus: "active" | "archived" = "active";
  const gitDiffCwds: string[] = [];
  return {
    ownerCwd,
    defaultCwd,
    ownerSessionId,
    actorSessionId,
    teamId: team.id,
    taskId: task.id,
    teams,
    runner,
    operations,
    gitDiffCwds,
    setOwnerStatus(status) {
      ownerStatus = status;
    },
    createVerifier(gitDiff) {
      return new TeamTaskVerificationService({
        teams,
        subagents,
        cwd: defaultCwd,
        now,
        resolveSession: async (sessionId) => {
          if (sessionId !== ownerSessionId) throw new Error(`Unexpected verifier session: ${sessionId}`);
          return { cwd: ownerCwd, status: ownerStatus, source: "interactive" };
        },
        sessionOperations: operations,
        gitDiff: gitDiff ?? (async (input) => {
          gitDiffCwds.push(input.cwd);
          return "(direct verifier diff)";
        }),
      });
    },
    async close() {
      store.close();
      await rm(defaultCwd, { recursive: true, force: true });
      await rm(ownerCwd, { recursive: true, force: true });
    },
  };
}

interface TestSessionOperationState {
  sessionId: SessionId;
  controller: AbortController;
  active: boolean;
  lost: boolean;
}

class TestSessionOperationCoordinator implements SessionOperationCoordinator {
  readonly acquisitions: SessionId[] = [];
  private readonly storage = new AsyncLocalStorage<TestSessionOperationState>();
  private readonly active = new Map<SessionId, TestSessionOperationState>();
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

    const state: TestSessionOperationState = {
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

  private operation(state: TestSessionOperationState): RuntimeSessionOperation {
    return {
      signal: state.controller.signal,
      assertCurrent() {
        if (!state.active || state.lost) throw new RuntimeBusyError(state.sessionId);
      },
    };
  }
}

class RoutingLocalSubagentRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    if (input.taskName.startsWith("Verify ")) {
      return { status: "completed", summary: "VERDICT: passed\nTests passed." };
    }
    return { status: "completed", summary: `Implemented ${input.taskName}` };
  }
}

class FixedVerifierRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];

  constructor(private readonly summary: string) {}

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    return { status: "completed", summary: this.summary };
  }
}

class BarrierVerifierRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];
  running = 0;
  maxRunning = 0;
  private markFirstBatchStarted!: () => void;
  readonly firstBatchStarted = new Promise<void>((resolve) => {
    this.markFirstBatchStarted = resolve;
  });
  private releaseBatch!: () => void;
  private readonly firstBatchReleased = new Promise<void>((resolve) => {
    this.releaseBatch = resolve;
  });

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    if (this.runs.length === 2) this.markFirstBatchStarted();
    await this.firstBatchReleased;
    this.running--;
    return { status: "completed", summary: "VERDICT: passed\nLooks good." };
  }

  releaseFirstBatch(): void {
    this.releaseBatch();
  }
}

class BlockingVerifierRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];
  private releaseRun!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });
  private startedRun!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.startedRun = resolve;
  });

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    this.startedRun();
    await this.released;
    return { status: "completed", summary: "VERDICT: passed\nLooks good." };
  }

  release(): void {
    this.releaseRun();
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

async function mkVerifierGitRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, "packages/core/src"), { recursive: true });
  await writeFile(join(dir, "packages/core/src/feature.ts"), "export const committed = 1;\n");
  await verifierGit(dir, ["init", "-q"]);
  await verifierGit(dir, ["config", "user.email", "test@example.com"]);
  await verifierGit(dir, ["config", "user.name", "Test"]);
  await verifierGit(dir, ["add", "."]);
  await verifierGit(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

async function verifierGit(cwd: string, args: readonly string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000, maxOutputBytes: 128_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

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

function testSessionResolver(cwd: string) {
  return async () => ({ cwd, status: "active" as const, source: "interactive" as const });
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


async function actualReadOnly<Input>(
  tool: { isReadOnly?: boolean | ((input: Input) => boolean | Promise<boolean>) },
  input: Input,
): Promise<boolean | undefined> {
  const predicate = tool.isReadOnly;
  return typeof predicate === "function" ? predicate(input) : predicate;
}
