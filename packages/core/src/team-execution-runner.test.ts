import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type {
  AgentPath,
  AgentRunId,
  ChiliEvent,
  SessionId,
  TaskId,
  TeamId,
  TimestampMs,
} from "@chili/protocol";
import {
  SessionRunClaimConflictError,
  SqliteEventStore,
  type EventAppendOptions,
  type SessionRunClaimFence,
} from "@chili/store";
import { LocalSubagentManager, type LocalSubagentRunInput, type LocalSubagentRunResult, type LocalSubagentRunner } from "./subagent.js";
import {
  TeamTaskDispatchService as CoreTeamTaskDispatchService,
  type TeamTaskDispatchResult,
  type TeamTaskDispatchServiceOptions,
} from "./team-dispatcher.js";
import {
  TeamExecutionRunner as CoreTeamExecutionRunner,
  type TeamExecutionRunnerOptions,
  type TeamTaskMerger,
  type TeamTaskVerifier,
} from "./team-execution-runner.js";
import type { TeamMergeResultStatus, TeamMergeSweepResult } from "./team-merge.js";
import { TeamSessionAuthorityError } from "./team-session-authority.js";
import { TeamControlService } from "./team.js";
import { taskMergeMetadata } from "./team-worktree.js";
import {
  RuntimeBusyError,
  type RuntimeSessionOperation,
  type SessionOperationCoordinator,
} from "./runtime-service.js";

const passthroughSessionOperations: SessionOperationCoordinator = {
  async withSessionOperation(_sessionId, fn) {
    const operation = {
      signal: new AbortController().signal,
      assertCurrent() {},
    };
    return fn(operation);
  },
};

class TeamExecutionRunner extends CoreTeamExecutionRunner {
  constructor(options: Omit<TeamExecutionRunnerOptions, "sessionOperations"> & {
    sessionOperations?: SessionOperationCoordinator;
  }) {
    super({ sessionOperations: passthroughSessionOperations, ...options });
  }
}

class TeamTaskDispatchService extends CoreTeamTaskDispatchService {
  constructor(options: Omit<TeamTaskDispatchServiceOptions, "sessionOperations"> & {
    sessionOperations?: SessionOperationCoordinator;
  }) {
    super({ sessionOperations: passthroughSessionOperations, ...options });
  }
}

test("runs team tasks through dependencies until the board is drained", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-drained-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 500 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const setupPath = "/root/setup" as AgentPath;
  const featurePath = "/root/feature" as AgentPath;
  const sessionId = "session_team_runner" as SessionId;
  const runner = new DeferredLocalSubagentRunner();
  let subagents: LocalSubagentManager | undefined;

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
    });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      sleep: async () => {
        runner.completeNext();
        if (!subagents) throw new Error("subagents not initialized");
        await subagents.waitForBackgroundTasks();
      },
    });

    const team = await teams.createTeam({ sessionId, name: "runner", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: setupPath, name: "setup", role: "implementer" });
    await teams.addMember({ sessionId, teamId: team.id, path: featurePath, name: "feature", role: "implementer" });
    const setup = await teams.createTask({ sessionId, teamId: team.id, title: "Prepare", ownerPath: setupPath });
    const feature = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Build feature",
      ownerPath: featurePath,
      dependsOn: [setup.id],
    });
    const unowned = await teams.createTask({ sessionId, teamId: team.id, title: "Needs owner" });

    const summary = await execution.run({
      teamId: team.id,
      sessionId,
      maxCycles: 5,
      timeoutMs: 10_000,
      pollIntervalMs: 1,
    });

    expect(summary).toMatchObject({
      teamId: team.id,
      stopReason: "drained",
      cycles: 3,
      dispatched: [
        { taskId: setup.id, ownerPath: setupPath, status: "running" },
        { taskId: feature.id, ownerPath: featurePath, status: "running" },
      ],
      completed: [
        { taskId: setup.id, status: "completed", summary: "Done Prepare" },
        { taskId: feature.id, status: "completed", summary: "Done Build feature" },
      ],
      blocked: [],
      skipped: [{ taskId: unowned.id, reason: "missing_owner" }],
      stillRunning: [],
      errors: [],
    });
    expect(runner.runs.map((run) => run.taskName)).toEqual(["Prepare", "Build feature"]);
    expect(await teams.tasks(team.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: setup.id, status: "completed" }),
      expect.objectContaining({ id: feature.id, status: "completed" }),
      expect.objectContaining({ id: unowned.id, status: "pending" }),
    ]));
  } finally {
    runner.completeAll();
    await subagents?.waitForBackgroundTasks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runs one cycle and reports still-running background tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-once-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 600 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_runner_once" as SessionId;
  const runner = new DeferredLocalSubagentRunner();
  let subagents: LocalSubagentManager | undefined;

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
    });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
    });

    const team = await teams.createTeam({ sessionId, name: "runner-once", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Keep running", ownerPath: workerPath });

    const summary = await execution.run({ teamId: team.id, sessionId, once: true });

    expect(summary).toMatchObject({
      stopReason: "once",
      cycles: 1,
      dispatched: [{ taskId: task.id, status: "running", ownerPath: workerPath }],
      completed: [],
      failed: [],
      stillRunning: [{ taskId: task.id, ownerPath: workerPath, title: "Keep running" }],
      errors: [],
    });
    expect(runner.runs).toHaveLength(1);

    runner.completeNext();
    await subagents.waitForBackgroundTasks();
  } finally {
    runner.completeAll();
    await subagents?.waitForBackgroundTasks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("uses one persisted canonical workspace for dispatch, verification, and merge and rejects A/B overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-authority-"));
  const workspaceA = join(dir, "workspace-a");
  const workspaceAlias = join(dir, "workspace-a-alias");
  const workspaceB = join(dir, "workspace-b");
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
  await symlink(workspaceA, workspaceAlias);
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 610 as TimestampMs;
  const sessionA = "session_team_runner_authority_a" as SessionId;
  const sessionB = "session_team_runner_authority_b" as SessionId;
  const dispatchInputs: Array<Parameters<TeamTaskDispatchService["dispatchTask"]>[0]> = [];
  const verifyInputs: Array<Parameters<TeamTaskVerifier["verifyCompletedTasks"]>[0]> = [];
  const mergeInputs: Array<Parameters<TeamTaskMerger["mergeTeamTasks"]>[0]> = [];

  try {
    await persistRootSession(store, sessionA, workspaceA);
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ sessionId: sessionA, name: "authority", leadPath: "/root" as AgentPath });
    const workerPath = "/root/worker" as AgentPath;
    await teams.addMember({ sessionId: sessionA, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId: sessionA, teamId: team.id, title: "Authority", ownerPath: workerPath });
    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask(input: Parameters<TeamTaskDispatchService["dispatchTask"]>[0]): Promise<TeamTaskDispatchResult> {
        dispatchInputs.push(input);
        return { status: "running", teamTask: { ...task, status: "in_progress" } };
      },
    } as unknown as TeamTaskDispatchService;
    const verifier: TeamTaskVerifier = {
      async verifyCompletedTasks(input) {
        verifyInputs.push(input);
        return { scanned: 0, maxConcurrentVerifications: 2, verified: [], skipped: [], errors: [] };
      },
    };
    const merger: TeamTaskMerger = {
      async mergeTeamTasks(input) {
        mergeInputs.push(input);
        return { scanned: 0, applied: [], failed: [], conflicted: [], skipped: [], errors: [] };
      },
    };
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      verifier,
      merger,
      cwd: workspaceB,
      now,
      resolveSession: persistedRootSessionResolver(store),
    });

    await execution.run({ teamId: team.id, sessionId: sessionA, cwd: workspaceAlias, once: true });

    const canonicalA = await realpath(workspaceA);
    expect(dispatchInputs).toMatchObject([{ sessionId: sessionA, cwd: canonicalA }]);
    expect(verifyInputs).toMatchObject([{ sessionId: sessionA, cwd: canonicalA }]);
    expect(mergeInputs).toMatchObject([{ sessionId: sessionA, cwd: canonicalA }]);

    dispatchInputs.length = 0;
    verifyInputs.length = 0;
    mergeInputs.length = 0;
    await expect(execution.run({ teamId: team.id, sessionId: sessionB, cwd: workspaceA, once: true }))
      .rejects.toBeInstanceOf(TeamSessionAuthorityError);
    await expect(execution.run({ teamId: team.id, sessionId: sessionA, cwd: workspaceB, once: true }))
      .rejects.toBeInstanceOf(TeamSessionAuthorityError);
    expect(dispatchInputs).toEqual([]);
    expect(verifyInputs).toEqual([]);
    expect(mergeInputs).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const maxConcurrentDispatches of [1, 2]) {
  test(`limits five live child tasks to ${maxConcurrentDispatches} and replenishes terminal slots`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `chili-team-runner-live-cap-${maxConcurrentDispatches}-`));
    const store = new SqliteEventStore(join(dir, "events.sqlite"));
    const ids = createSequentialId();
    const now = () => 620 as TimestampMs;
    const leadPath = "/root" as AgentPath;
    const sessionId = `session_team_runner_live_cap_${maxConcurrentDispatches}` as SessionId;
    const runner = new DeferredLocalSubagentRunner();
    const activeRunsAtWait: number[] = [];
    let subagents: LocalSubagentManager | undefined;

    try {
      await persistRootSession(store, sessionId, dir);
      const teams = new TeamControlService({ store, createId: ids, now });
      subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
      const dispatcher = new TeamTaskDispatchService({
        teams,
        subagents,
        store,
        cwd: dir,
        now,
        resolveSession: persistedRootSessionResolver(store),
      });
      const execution = new TeamExecutionRunner({
        teams,
        dispatcher,
        cwd: dir,
        now,
        resolveSession: persistedRootSessionResolver(store),
        sleep: async () => {
          activeRunsAtWait.push(runner.activeRunCount);
          const completedTaskId = runner.completeNext();
          if (!completedTaskId) throw new Error("expected an active subagent run");
          await waitForAgentTaskTerminal(store, completedTaskId);
        },
      });

      const team = await teams.createTeam({ sessionId, name: `runner-live-cap-${maxConcurrentDispatches}`, leadPath });
      const tasks = [];
      for (let index = 0; index < 5; index++) {
        const workerPath = `/root/worker-${index + 1}` as AgentPath;
        await teams.addMember({
          sessionId,
          teamId: team.id,
          path: workerPath,
          name: `worker-${index + 1}`,
          role: "implementer",
        });
        tasks.push(await teams.createTask({
          sessionId,
          teamId: team.id,
          title: `Task ${index + 1}`,
          ownerPath: workerPath,
        }));
      }

      const summary = await execution.run({
        teamId: team.id,
        sessionId,
        maxCycles: 10,
        timeoutMs: 10_000,
        pollIntervalMs: 1,
        maxConcurrentDispatches,
      });

      expect(runner.maxActiveRuns).toBe(maxConcurrentDispatches);
      expect(runner.runs).toHaveLength(5);
      expect(activeRunsAtWait).toEqual(maxConcurrentDispatches === 1 ? [1, 1, 1, 1, 1] : [2, 2, 2, 2, 1]);
      expect(summary).toMatchObject({
        stopReason: "drained",
        maxConcurrentDispatches,
        stillRunning: [],
        errors: [],
      });
      expect(summary.dispatched).toHaveLength(5);
      expect(summary.dispatched.map((task) => task.taskId)).toEqual(expect.arrayContaining(tasks.map((task) => task.id)));
      expect(summary.completed).toHaveLength(5);
      expect(summary.completed.map((task) => task.taskId)).toEqual(expect.arrayContaining(tasks.map((task) => task.id)));
    } finally {
      runner.completeAll();
      await subagents?.waitForBackgroundTasks();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("orders runnable dispatches by task priority before creation order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-priority-dispatch-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 623 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const sessionId = "session_team_runner_priority" as SessionId;
  const dispatchOrder: TaskId[] = [];

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ sessionId, name: "runner-priority", leadPath });
    const lowWorker = "/root/low" as AgentPath;
    const highWorker = "/root/high" as AgentPath;
    await teams.addMember({ sessionId, teamId: team.id, path: lowWorker, name: "low", role: "implementer" });
    await teams.addMember({ sessionId, teamId: team.id, path: highWorker, name: "high", role: "implementer" });
    const low = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Low priority first",
      ownerPath: lowWorker,
      metadata: { priority: "p3" },
    });
    const high = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "High priority second",
      ownerPath: highWorker,
      metadata: { priority: "p0" },
    });

    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask(input: Parameters<TeamTaskDispatchService["dispatchTask"]>[0]): Promise<TeamTaskDispatchResult> {
        const task = (await teams.tasks(input.teamId)).find((item) => item.id === input.taskId);
        if (!task) throw new Error(`missing task ${input.taskId}`);
        dispatchOrder.push(input.taskId);
        return {
          status: "running",
          teamTask: { ...task, status: "in_progress" },
        };
      },
    };
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher: dispatcher as unknown as TeamTaskDispatchService,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
    });

    await execution.run({ teamId: team.id, sessionId, once: true, maxConcurrentDispatches: 1 });

    expect(dispatchOrder).toEqual([high.id]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("prioritizes critical-path narrow writes over broad write reservations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-critical-path-dispatch-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 624 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const sessionId = "session_team_runner_critical_path" as SessionId;
  const dispatchOrder: TaskId[] = [];

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ sessionId, name: "runner-critical-path", leadPath });
    const broadWorker = "/root/broad" as AgentPath;
    const coreWorker = "/root/core" as AgentPath;
    const leafWorker = "/root/leaf" as AgentPath;
    await teams.addMember({ sessionId, teamId: team.id, path: broadWorker, name: "broad", role: "implementer" });
    await teams.addMember({ sessionId, teamId: team.id, path: coreWorker, name: "core", role: "implementer" });
    await teams.addMember({ sessionId, teamId: team.id, path: leafWorker, name: "leaf", role: "implementer" });
    const broad = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Broad write created first",
      ownerPath: broadWorker,
      metadata: { priority: "p2", writeScope: ["."] },
    });
    const setup = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Critical setup",
      ownerPath: coreWorker,
      metadata: { priority: "p2", writeScope: ["packages/core/src"] },
    });
    const leaf = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Leaf depends on setup",
      ownerPath: leafWorker,
      dependsOn: [setup.id],
      metadata: { priority: "p2", writeScope: ["packages/core/tests"] },
    });

    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask(input: Parameters<TeamTaskDispatchService["dispatchTask"]>[0]): Promise<TeamTaskDispatchResult> {
        const task = (await teams.tasks(input.teamId)).find((item) => item.id === input.taskId);
        if (!task) throw new Error(`missing task ${input.taskId}`);
        dispatchOrder.push(input.taskId);
        return {
          status: "running",
          teamTask: { ...task, status: "in_progress" },
        };
      },
    };
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher: dispatcher as unknown as TeamTaskDispatchService,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
    });

    const summary = await execution.run({ teamId: team.id, sessionId, once: true, maxConcurrentDispatches: 4 });

    expect(dispatchOrder).toEqual([setup.id]);
    expect(summary.dispatched).toEqual([expect.objectContaining({ taskId: setup.id, status: "running", ownerPath: coreWorker })]);
    expect(summary.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: broad.id, reason: "write_conflict" }),
      expect.objectContaining({ taskId: leaf.id, reason: "dependency_incomplete", blockedBy: [setup.id] }),
    ]));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("emits team run lifecycle events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-lifecycle-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 650 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_runner_lifecycle" as SessionId;
  const runner = new ImmediateLocalSubagentRunner();
  let subagents: LocalSubagentManager | undefined;

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
    });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      events: store,
      cwd: dir,
      now,
      createId: ids,
      resolveSession: persistedRootSessionResolver(store),
    });

    const team = await teams.createTeam({ sessionId, name: "runner-lifecycle", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Emit events", ownerPath: workerPath });

    const summary = await execution.run({ teamId: team.id, sessionId, mode: "one_shot", maxCycles: 3 });

    expect(summary).toMatchObject({
      stopReason: "drained",
      dispatched: [{ taskId: task.id, status: "completed" }],
      completed: [{ taskId: task.id, status: "completed" }],
      errors: [],
    });
    const lifecycleEvents = (await store.events({ limit: 100 })).filter((event) => event.type.startsWith("team.run_"));
    expect(lifecycleEvents.map((event) => event.type)).toEqual([
      "team.run_started",
      "team.run_progress",
      "team.run_progress",
      "team.run_progress",
      "team.run_progress",
      "team.run_progress",
      "team.run_progress",
      "team.run_completed",
    ]);
    expect(lifecycleEvents[0]).toMatchObject({
      type: "team.run_started",
      sessionId,
      payload: {
        teamId: team.id,
        mode: "one_shot",
        once: false,
        maxCycles: 3,
        maxConcurrentDispatches: 3,
        maxConcurrentVerifications: 2,
      },
    });
    const runIds = new Set(lifecycleEvents.map((event) => (isRecord(event.payload) ? event.payload.runId : undefined)));
    expect(runIds.size).toBe(1);
    expect([...runIds][0]).toEqual(expect.stringContaining("teamrun_"));
    expect(
      lifecycleEvents
        .filter((event) => event.type === "team.run_progress")
        .map((event) => (isRecord(event.payload) ? event.payload.phase : undefined)),
    ).toEqual(["reconcile", "load", "verify", "merge", "dispatch", "drain"]);
    expect(lifecycleEvents.at(-1)).toMatchObject({
      type: "team.run_completed",
      sessionId,
      payload: {
        teamId: team.id,
        cycles: 1,
        stopReason: "drained",
        counts: {
          dispatched: 1,
          completed: 1,
          errors: 0,
        },
      },
    });
  } finally {
    await subagents?.waitForBackgroundTasks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("fences the ordered team run lifecycle with the owner run claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-lifecycle-fence-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_team_runner_lifecycle_fence" as SessionId;
  const runClaim: SessionRunClaimFence = {
    sessionId,
    claimId: "run_claim_team_runner_lifecycle_fence",
  };
  const operations = new ControlledSessionOperationCoordinator();

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, sessionOperations: operations });
    const team = await teams.createTeam({
      sessionId,
      name: "lifecycle-fence",
      leadPath: "/root" as AgentPath,
    });
    expect(store.claimSessionRun({
      sessionId,
      claimId: runClaim.claimId,
      allowSubagentSessions: false,
      time: Date.now(),
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });
    operations.setRunClaim(runClaim);
    const events = new RecordingTeamRunEventStore(store);
    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask() {
        throw new Error("not expected");
      },
    } as unknown as TeamTaskDispatchService;
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      sessionOperations: operations,
      events,
      cwd: dir,
      resolveSession: persistedRootSessionResolver(store),
    });

    const summary = await execution.run({ teamId: team.id, sessionId, maxCycles: 2 });

    expect(summary).toMatchObject({ stopReason: "drained", cycles: 1, errors: [] });
    expect(events.appends.map(({ event }) => event.type)).toEqual([
      "team.run_started",
      "team.run_progress",
      "team.run_progress",
      "team.run_progress",
      "team.run_progress",
      "team.run_progress",
      "team.run_progress",
      "team.run_completed",
    ]);
    expect(
      events.appends
        .filter(({ event }) => event.type === "team.run_progress")
        .map(({ event }) => event.type === "team.run_progress" ? event.payload.phase : undefined),
    ).toEqual(["reconcile", "load", "verify", "merge", "dispatch", "drain"]);
    expect(events.appends.every(({ options }) => options?.runClaim === runClaim)).toBe(true);
  } finally {
    operations.setRunClaim(undefined);
    store.releaseSessionRun({ sessionId, claimId: runClaim.claimId });
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto-assigns scoped unowned tasks to compatible idle members", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-auto-assign-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 625 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const sessionId = "session_team_runner_auto_assign" as SessionId;

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ sessionId, name: "runner-auto-assign", leadPath });
    const coreWorker = "/root/core" as AgentPath;
    const docsWorker = "/root/docs" as AgentPath;
    await teams.addMember({ sessionId, teamId: team.id, path: coreWorker, name: "core", role: "implementer", writeScope: ["packages/core"], toolScope: ["edit"] });
    await teams.addMember({ sessionId, teamId: team.id, path: docsWorker, name: "docs", role: "implementer", writeScope: ["docs"], toolScope: ["edit"] });
    const coreTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Core task",
      metadata: { writeScope: ["packages/core/src"], requiredTools: ["edit"] },
    });
    const docsTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Docs task",
      metadata: { writeScope: ["docs"], requiredTools: ["edit"] },
    });
    const unscopedTask = await teams.createTask({ sessionId, teamId: team.id, title: "Needs explicit owner" });

    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask(input: Parameters<TeamTaskDispatchService["dispatchTask"]>[0]): Promise<TeamTaskDispatchResult> {
        const task = (await teams.tasks(input.teamId)).find((item) => item.id === input.taskId);
        if (!task) throw new Error(`missing task ${input.taskId}`);
        const teamTask: TeamTaskDispatchResult["teamTask"] = { ...task, status: "in_progress" };
        if (input.ownerPath) teamTask.ownerPath = input.ownerPath;
        return {
          status: "running",
          teamTask,
        };
      },
    };
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher: dispatcher as unknown as TeamTaskDispatchService,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
    });

    const summary = await execution.run({ teamId: team.id, sessionId, once: true, maxConcurrentDispatches: 4 });

    expect(summary.dispatched).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: coreTask.id, ownerPath: coreWorker, status: "running" }),
      expect.objectContaining({ taskId: docsTask.id, ownerPath: docsWorker, status: "running" }),
    ]));
    expect(summary.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: unscopedTask.id, reason: "missing_owner" }),
    ]));
    expect(summary.blocked).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("records dispatcher policy blocks in the runner summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-policy-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 700 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_runner_policy" as SessionId;
  const runner = new ImmediateLocalSubagentRunner();
  let subagents: LocalSubagentManager | undefined;

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
    });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
    });

    const team = await teams.createTeam({ sessionId, name: "runner-policy", leadPath });
    await teams.addMember({
      sessionId,
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      toolScope: ["read"],
      writeScope: ["packages/core"],
    });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Write elsewhere",
      ownerPath: workerPath,
      metadata: { writeScope: ["packages/store"], requiredTools: ["edit"] },
    });

    const summary = await execution.run({ teamId: team.id, sessionId, once: true });

    expect(summary).toMatchObject({
      stopReason: "once",
      dispatched: [],
      blocked: [{ taskId: task.id, ownerPath: workerPath, reason: "scope_mismatch" }],
      errors: [],
    });
    expect(runner.runs).toEqual([]);
    expect(await teams.tasks(team.id)).toMatchObject([{ id: task.id, status: "blocked", error: "scope_mismatch" }]);
  } finally {
    await subagents?.waitForBackgroundTasks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("creates a parent session when runnable team tasks do not have one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-session-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 800 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const createdSessionId = "session_created_for_runner" as SessionId;
  const runner = new ImmediateLocalSubagentRunner();
  let subagents: LocalSubagentManager | undefined;
  const createdSessions: Array<{ teamId: string; cwd: string }> = [];

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
    });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      createSession: async (input) => {
        createdSessions.push(input);
        await persistRootSession(store, createdSessionId, input.cwd);
        return { sessionId: createdSessionId, discard: async () => {} };
      },
    });

    const team = await teams.createTeam({ name: "sessionless", leadPath });
    await teams.addMember({ teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ teamId: team.id, title: "Needs session", ownerPath: workerPath });

    const summary = await execution.run({
      teamId: team.id,
      sessionId: "session_untrusted_caller" as SessionId,
      mode: "one_shot",
    });

    expect(summary).toMatchObject({
      stopReason: "drained",
      dispatched: [{ taskId: task.id, status: "completed" }],
      completed: [{ taskId: task.id, status: "completed", summary: "Done Needs session" }],
      skipped: [],
      errors: [],
    });
    expect(createdSessions).toEqual([{ teamId: team.id, cwd: await realpath(dir) }]);
    expect((await teams.listTeams()).find((candidate) => candidate.id === team.id)?.sessionId).toBe(createdSessionId);
    expect(runner.runs[0]).toMatchObject({
      parentSessionId: createdSessionId,
      taskName: "Needs session",
    });
  } finally {
    await subagents?.waitForBackgroundTasks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("archives only the unused session that loses a concurrent owner-binding race", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-session-race-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const now = () => 825 as TimestampMs;
  const sessionIds = [
    "session_runner_race_a" as SessionId,
    "session_runner_race_b" as SessionId,
  ];
  let candidateIndex = 0;
  let createdCount = 0;
  let releaseCreated!: () => void;
  const bothCreated = new Promise<void>((resolve) => {
    releaseCreated = resolve;
  });
  let bindingOperationIndex = 0;
  let releaseFirstBinding!: () => void;
  const firstBindingFinished = new Promise<void>((resolve) => {
    releaseFirstBinding = resolve;
  });
  const bindingOperations: SessionOperationCoordinator = {
    async withSessionOperation(_sessionId, fn) {
      const index = bindingOperationIndex++;
      if (index > 0) await firstBindingFinished;
      const operation: RuntimeSessionOperation = {
        signal: new AbortController().signal,
        assertCurrent() {},
      };
      try {
        return await fn(operation);
      } finally {
        if (index === 0) releaseFirstBinding();
      }
    },
  };
  let reconciliations = 0;

  try {
    const teams = new TeamControlService({ store, now, sessionOperations: bindingOperations });
    const team = await teams.createTeam({ name: "session-race", leadPath: "/root" as AgentPath });
    const dispatcher = {
      async reconcileTasks() {
        reconciliations++;
        return emptyReconcileResult();
      },
      async dispatchTask() {
        throw new Error("an owner-binding loser must not dispatch");
      },
    } as unknown as TeamTaskDispatchService;
    const createSession = async (input: { cwd: string }) => {
      const sessionId = sessionIds[candidateIndex++];
      if (!sessionId) throw new Error("unexpected third session candidate");
      await persistRootSession(store, sessionId, input.cwd);
      createdCount++;
      if (createdCount === sessionIds.length) releaseCreated();
      await bothCreated;
      return {
        sessionId,
        discard: async () => {
          await store.append({
            id: `event_archive_${sessionId}`,
            type: "session.archived",
            time: 826 as TimestampMs,
            sessionId,
            payload: { sessionId },
          });
        },
      };
    };
    const first = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      createSession,
    });
    const second = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      createSession,
    });

    const results = await Promise.allSettled([
      first.run({ teamId: team.id, once: true }),
      second.run({ teamId: team.id, once: true }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(TeamSessionAuthorityError);
    expect(reconciliations).toBe(1);

    const ownerSessionId = (await teams.listTeams()).find((candidate) => candidate.id === team.id)?.sessionId;
    if (!ownerSessionId) throw new Error("concurrent owner binding did not produce a winner");
    expect(sessionIds).toContain(ownerSessionId);
    const loserSessionId = sessionIds.find((sessionId) => sessionId !== ownerSessionId);
    expect(loserSessionId).toBeDefined();
    if (!loserSessionId) throw new Error("concurrent owner binding did not produce a loser");
    expect(await store.sessions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ownerSessionId, status: "active" }),
      expect.objectContaining({ id: loserSessionId, status: "archived" }),
    ]));
    expect(await store.events({ type: "session.archived", limit: 10 })).toMatchObject([
      { sessionId: loserSessionId, payload: { sessionId: loserSessionId } },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("uses the auto-created parent session when reconciling background tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-reconcile-session-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 850 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const createdSessionId = "session_created_for_reconcile" as SessionId;
  const runner = new DeferredLocalSubagentRunner();
  let subagents: LocalSubagentManager | undefined;

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
    });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
      createSession: async (input) => {
        await persistRootSession(store, createdSessionId, input.cwd);
        return { sessionId: createdSessionId, discard: async () => {} };
      },
      sleep: async () => {
        runner.completeNext();
        if (!subagents) throw new Error("subagents not initialized");
        await subagents.waitForBackgroundTasks();
      },
    });

    const team = await teams.createTeam({ name: "sessionless-background", leadPath });
    await teams.addMember({ teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ teamId: team.id, title: "Background needs session", ownerPath: workerPath });

    const summary = await execution.run({ teamId: team.id, maxCycles: 3, pollIntervalMs: 1 });

    expect(summary).toMatchObject({
      stopReason: "drained",
      completed: [{ taskId: task.id, status: "completed", summary: "Done Background needs session" }],
      errors: [],
    });
    const updates = await store.events({ type: "team.task_updated", limit: 20 });
    const completion = updates.find((event) => isRecord(event.payload) && event.payload.taskId === task.id && event.payload.status === "completed");
    expect(completion).toMatchObject({
      sessionId: createdSessionId,
    });
  } finally {
    runner.completeAll();
    await subagents?.waitForBackgroundTasks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not dispatch after slow session creation exceeds the deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-session-timeout-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 875 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const createdSessionId = "session_created_after_deadline" as SessionId;
  const dispatches: Array<Parameters<TeamTaskDispatchService["dispatchTask"]>[0]> = [];

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ name: "session-timeout", leadPath });
    await teams.addMember({ teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    await teams.createTask({ teamId: team.id, title: "Needs slow session", ownerPath: workerPath });
    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask(input: Parameters<TeamTaskDispatchService["dispatchTask"]>[0]) {
        dispatches.push(input);
        throw new Error("dispatch should not run after deadline");
      },
      async syncTask() {
        throw new Error("not expected");
      },
    } as unknown as TeamTaskDispatchService;
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      createSession: async () => {
        await delay(30);
        return { sessionId: createdSessionId, discard: async () => {} };
      },
    });

    const summary = await execution.run({ teamId: team.id, timeoutMs: 10 });

    expect(summary).toMatchObject({
      stopReason: "timeout",
      cycles: 0,
      dispatched: [],
      errors: [],
    });
    expect(dispatches).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("passes abort signals into session creation and stops before dispatch when aborted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-session-abort-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 880 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const createdSessionId = "session_created_after_abort" as SessionId;
  const controller = new AbortController();
  const createSessionSignals: Array<AbortSignal | undefined> = [];
  const dispatches: Array<Parameters<TeamTaskDispatchService["dispatchTask"]>[0]> = [];

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ name: "session-abort", leadPath });
    await teams.addMember({ teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    await teams.createTask({ teamId: team.id, title: "Needs aborted session", ownerPath: workerPath });
    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask(input: Parameters<TeamTaskDispatchService["dispatchTask"]>[0]) {
        dispatches.push(input);
        throw new Error("dispatch should not run after abort");
      },
      async syncTask() {
        throw new Error("not expected");
      },
    } as unknown as TeamTaskDispatchService;
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      createSession: async (input) => {
        createSessionSignals.push(input.signal);
        controller.abort();
        return { sessionId: createdSessionId, discard: async () => {} };
      },
    });

    const summary = await execution.run({ teamId: team.id, signal: controller.signal });

    expect(summary).toMatchObject({
      stopReason: "aborted",
      cycles: 0,
      dispatched: [],
      errors: [],
    });
    expect(createSessionSignals).toEqual([controller.signal]);
    expect(dispatches).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("treats abort-aware session creation rejection as an aborted run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-session-abort-reject-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 890 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const controller = new AbortController();
  const dispatches: Array<Parameters<TeamTaskDispatchService["dispatchTask"]>[0]> = [];

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ name: "session-abort-reject", leadPath });
    await teams.addMember({ teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    await teams.createTask({ teamId: team.id, title: "Needs rejected session", ownerPath: workerPath });
    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask(input: Parameters<TeamTaskDispatchService["dispatchTask"]>[0]) {
        dispatches.push(input);
        throw new Error("dispatch should not run after abort");
      },
      async syncTask() {
        throw new Error("not expected");
      },
    } as unknown as TeamTaskDispatchService;
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      createSession: async () => {
        controller.abort();
        const error = new Error("session creation aborted");
        error.name = "AbortError";
        throw error;
      },
    });

    const summary = await execution.run({ teamId: team.id, signal: controller.signal });

    expect(summary).toMatchObject({
      stopReason: "aborted",
      cycles: 0,
      dispatched: [],
      errors: [],
    });
    expect(dispatches).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports timeout when dispatch finishes after the run deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-dispatch-timeout-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 900 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_runner_timeout" as SessionId;
  const dispatches: Array<Parameters<TeamTaskDispatchService["dispatchTask"]>[0]> = [];

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ sessionId, name: "timeout", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Slow dispatch", ownerPath: workerPath });
    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask(input: Parameters<TeamTaskDispatchService["dispatchTask"]>[0]) {
        dispatches.push(input);
        await delay(30);
        return {
          status: "running" as const,
          teamTask: { ...task, status: "in_progress" as const },
        };
      },
      async syncTask() {
        throw new Error("not expected");
      },
    } as unknown as TeamTaskDispatchService;
    const execution = new TeamExecutionRunner({ teams, dispatcher, cwd: dir, now, resolveSession: () => ({ cwd: dir }) });

    const summary = await execution.run({ teamId: team.id, sessionId, once: true, timeoutMs: 10 });

    expect(summary).toMatchObject({
      stopReason: "timeout",
      cycles: 1,
      dispatched: [{ taskId: task.id, status: "running" }],
    });
    expect(dispatches).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports timeout when reconcile finishes after the run deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-reconcile-timeout-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 925 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const sessionId = "session_team_runner_reconcile_timeout" as SessionId;
  let reconcileCount = 0;

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ sessionId, name: "reconcile-timeout", leadPath });
    const dispatcher = {
      async reconcileTasks() {
        reconcileCount++;
        await delay(30);
        return emptyReconcileResult();
      },
      async dispatchTask() {
        throw new Error("not expected");
      },
      async syncTask() {
        throw new Error("not expected");
      },
    } as unknown as TeamTaskDispatchService;
    const execution = new TeamExecutionRunner({ teams, dispatcher, cwd: dir, now, resolveSession: () => ({ cwd: dir }) });

    const summary = await execution.run({ teamId: team.id, sessionId, timeoutMs: 10 });

    expect(summary).toMatchObject({
      stopReason: "timeout",
      cycles: 1,
      dispatched: [],
      completed: [],
      errors: [],
    });
    expect(reconcileCount).toBe(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports abort when the signal is aborted during task dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-dispatch-abort-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 950 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_runner_abort" as SessionId;
  const controller = new AbortController();

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ sessionId, name: "abort", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Abort dispatch", ownerPath: workerPath });
    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask() {
        controller.abort();
        return {
          status: "running" as const,
          teamTask: { ...task, status: "in_progress" as const },
        };
      },
      async syncTask() {
        throw new Error("not expected");
      },
    } as unknown as TeamTaskDispatchService;
    const execution = new TeamExecutionRunner({ teams, dispatcher, cwd: dir, now, resolveSession: () => ({ cwd: dir }) });

    const summary = await execution.run({ teamId: team.id, sessionId, once: true, signal: controller.signal });

    expect(summary).toMatchObject({
      stopReason: "aborted",
      cycles: 1,
      dispatched: [{ taskId: task.id, status: "running" }],
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("merges verifier-passed tasks and drains after merge is applied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-merge-applied-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 980 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_runner_merge" as SessionId;
  const runner = new ImmediateLocalSubagentRunner();
  let subagents: LocalSubagentManager | undefined;

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
    });
    const verifier = new PendingMergeVerifier(teams, now);
    const merger = new MetadataMergeService(teams, "applied", now);
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      verifier,
      merger,
      cwd: dir,
      now,
      resolveSession: persistedRootSessionResolver(store),
    });
    const team = await teams.createTeam({ sessionId, name: "runner-merge", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Complete and merge", ownerPath: workerPath });

    const summary = await execution.run({ teamId: team.id, sessionId, mode: "one_shot", maxCycles: 3 });

    expect(summary).toMatchObject({
      stopReason: "drained",
      completed: [{ taskId: task.id, status: "completed" }],
      accepted: [{ taskId: task.id, status: "completed" }],
      merged: [{ taskId: task.id, status: "applied" }],
      mergeFailed: [],
      mergeConflicted: [],
      mergeSkipped: [],
      errors: [],
    });
    const [storedTask] = await teams.tasks(team.id);
    expect(taskMergeMetadata(storedTask?.metadata)?.status).toBe("applied");
  } finally {
    await subagents?.waitForBackgroundTasks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports merge conflicts from verifier-passed tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-merge-conflict-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 985 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_runner_merge_conflict" as SessionId;

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ sessionId, name: "runner-merge-conflict", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Already verified",
      ownerPath: workerPath,
      status: "completed",
      metadata: pendingMergeMetadata(),
    });
    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask() {
        throw new Error("not expected");
      },
      async syncTask() {
        throw new Error("not expected");
      },
    } as unknown as TeamTaskDispatchService;
    const merger = new MetadataMergeService(teams, "conflicted", now);
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      merger,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
    });

    const summary = await execution.run({ teamId: team.id, sessionId, maxCycles: 2 });

    expect(summary).toMatchObject({
      stopReason: "drained",
      merged: [],
      mergeConflicted: [{ taskId: task.id, status: "conflicted", error: "merge_conflicted" }],
      errors: [],
    });
    const [storedTask] = await teams.tasks(team.id);
    expect(taskMergeMetadata(storedTask?.metadata)?.status).toBe("conflicted");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not report drained while a pending merge has not been processed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-merge-pending-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 990 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_runner_merge_pending" as SessionId;

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ sessionId, name: "runner-merge-pending", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Pending merge",
      ownerPath: workerPath,
      status: "completed",
      metadata: pendingMergeMetadata(),
    });
    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask() {
        throw new Error("not expected");
      },
      async syncTask() {
        throw new Error("not expected");
      },
    } as unknown as TeamTaskDispatchService;
    const execution = new TeamExecutionRunner({ teams, dispatcher, cwd: dir, now, resolveSession: () => ({ cwd: dir }) });

    const summary = await execution.run({ teamId: team.id, sessionId, maxCycles: 1 });

    expect(summary).toMatchObject({
      stopReason: "max_cycles",
      cycles: 1,
      stillRunning: [],
      merged: [],
      mergeConflicted: [],
      errors: [],
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("holds one owner-session operation for a direct team run and rejects a peer run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-operation-peer-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_team_runner_operation_peer" as SessionId;
  const operations = new ControlledSessionOperationCoordinator();
  let releaseReconcile: (() => void) | undefined;
  let markReconcileEntered: (() => void) | undefined;
  const reconcileEntered = new Promise<void>((resolve) => {
    markReconcileEntered = resolve;
  });
  const reconcileGate = new Promise<void>((resolve) => {
    releaseReconcile = resolve;
  });

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, sessionOperations: operations });
    const team = await teams.createTeam({ sessionId, name: "operation-peer", leadPath: "/root" as AgentPath });
    operations.resetObservations();
    const dispatcher = {
      async reconcileTasks() {
        markReconcileEntered?.();
        await reconcileGate;
        return emptyReconcileResult();
      },
      async dispatchTask() {
        throw new Error("not expected");
      },
    } as unknown as TeamTaskDispatchService;
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      sessionOperations: operations,
      events: store,
      cwd: dir,
      resolveSession: persistedRootSessionResolver(store),
    });

    const first = execution.run({ teamId: team.id, sessionId, once: true });
    await reconcileEntered;
    await expect(execution.run({ teamId: team.id, sessionId, once: true }))
      .rejects.toBeInstanceOf(RuntimeBusyError);
    releaseReconcile?.();
    await expect(first).resolves.toMatchObject({ stopReason: "once" });
    expect(operations.topLevelEntries).toEqual([sessionId]);
  } finally {
    releaseReconcile?.();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuses an inherited owner-session operation for a nested team run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-operation-nested-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_team_runner_operation_nested" as SessionId;
  const runClaim: SessionRunClaimFence = {
    sessionId,
    claimId: "run_claim_team_runner_operation_nested",
  };
  const operations = new ControlledSessionOperationCoordinator();

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, sessionOperations: operations });
    const team = await teams.createTeam({ sessionId, name: "operation-nested", leadPath: "/root" as AgentPath });
    expect(store.claimSessionRun({
      sessionId,
      claimId: runClaim.claimId,
      allowSubagentSessions: false,
      time: Date.now(),
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });
    operations.setRunClaim(runClaim);
    const events = new RecordingTeamRunEventStore(store);
    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask() {
        throw new Error("not expected");
      },
    } as unknown as TeamTaskDispatchService;
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      sessionOperations: operations,
      events,
      cwd: dir,
      resolveSession: persistedRootSessionResolver(store),
    });
    operations.resetObservations();

    const summary = await operations.withSessionOperation(
      sessionId,
      () => execution.run({ teamId: team.id, sessionId, once: true }),
    );

    expect(summary.stopReason).toBe("once");
    expect(operations.topLevelEntries).toEqual([sessionId]);
    expect(operations.nestedEntries).toBe(1);
    expect(events.appends.length).toBeGreaterThan(0);
    expect(events.appends.every(({ options }) => options?.runClaim === runClaim)).toBe(true);
  } finally {
    operations.setRunClaim(undefined);
    store.releaseSessionRun({ sessionId, claimId: runClaim.claimId });
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects a stale runner finalize after the owner lease is taken over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-finalize-fence-"));
  const dbPath = join(dir, "events.sqlite");
  const store = new SqliteEventStore(dbPath);
  const contender = new SqliteEventStore(dbPath);
  const sessionId = "session_team_runner_finalize_fence" as SessionId;
  const runClaim: SessionRunClaimFence = {
    sessionId,
    claimId: "run_claim_team_runner_finalize_stale",
  };
  const contenderClaimId = "run_claim_team_runner_finalize_current";
  const claimedAt = Date.now();
  const operations = new ControlledSessionOperationCoordinator();
  let takeoverStatus: ReturnType<SqliteEventStore["claimSessionRun"]>["status"] | undefined;
  let tookOver = false;

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, sessionOperations: operations });
    const team = await teams.createTeam({
      sessionId,
      name: "finalize-fence",
      leadPath: "/root" as AgentPath,
    });
    expect(store.claimSessionRun({
      sessionId,
      claimId: runClaim.claimId,
      allowSubagentSessions: false,
      time: claimedAt,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });
    operations.setRunClaim(runClaim);
    const events = new RecordingTeamRunEventStore(store, (event) => {
      if (event.type !== "team.run_completed" || tookOver) return;
      tookOver = true;
      takeoverStatus = contender.claimSessionRun({
        sessionId,
        claimId: contenderClaimId,
        allowSubagentSessions: false,
        time: claimedAt + 60_000,
        leaseDurationMs: 60_000,
      }).status;
      // Model the old runner's cleanup racing its stale async finalize. Once
      // the connection-local owner marker is gone, only the explicit fence on
      // the lifecycle append can reject this commit.
      store.releaseSessionRun({ sessionId, claimId: runClaim.claimId });
    });
    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask() {
        throw new Error("not expected");
      },
    } as unknown as TeamTaskDispatchService;
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      sessionOperations: operations,
      events,
      cwd: dir,
      resolveSession: persistedRootSessionResolver(store),
    });

    await expect(execution.run({ teamId: team.id, sessionId, maxCycles: 2 }))
      .rejects.toBeInstanceOf(SessionRunClaimConflictError);

    expect(takeoverStatus).toBe("claimed");
    expect(events.appends.at(-1)).toMatchObject({
      event: { type: "team.run_completed" },
      options: { runClaim },
    });
    const lifecycleTypes = (await store.events({ sessionId, limit: 100 }))
      .map((event) => event.type)
      .filter((type) => type.startsWith("team.run_"));
    expect(lifecycleTypes).toContain("team.run_started");
    expect(lifecycleTypes).not.toContain("team.run_completed");
  } finally {
    operations.setRunClaim(undefined);
    contender.releaseSessionRun({ sessionId, claimId: contenderClaimId });
    store.releaseSessionRun({ sessionId, claimId: runClaim.claimId });
    contender.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lease loss rejects the run without writing progress or completed lifecycle events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-operation-lost-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_team_runner_operation_lost" as SessionId;
  const operations = new ControlledSessionOperationCoordinator();

  try {
    await persistRootSession(store, sessionId, dir);
    const teams = new TeamControlService({ store, sessionOperations: operations });
    const team = await teams.createTeam({ sessionId, name: "operation-lost", leadPath: "/root" as AgentPath });
    const dispatcher = {
      async reconcileTasks() {
        operations.invalidate(sessionId);
        throw new DOMException("operation lease aborted", "AbortError");
      },
      async dispatchTask() {
        throw new Error("not expected");
      },
    } as unknown as TeamTaskDispatchService;
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      sessionOperations: operations,
      events: store,
      cwd: dir,
      resolveSession: persistedRootSessionResolver(store),
    });

    await expect(execution.run({ teamId: team.id, sessionId, once: true }))
      .rejects.toBeInstanceOf(RuntimeBusyError);
    const lifecycleTypes = (await store.events({ sessionId, limit: 100 }))
      .map((event) => event.type)
      .filter((type) => type.startsWith("team.run_"));
    expect(lifecycleTypes).toEqual(["team.run_started"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class DeferredLocalSubagentRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];
  maxActiveRuns = 0;
  private readonly completions: Array<{ taskId: TaskId; resolve: () => void }> = [];
  private activeRuns = 0;

  get activeRunCount(): number {
    return this.activeRuns;
  }

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    this.activeRuns++;
    this.maxActiveRuns = Math.max(this.maxActiveRuns, this.activeRuns);
    await new Promise<void>((resolve) => {
      this.completions.push({ taskId: input.taskId, resolve });
    });
    this.activeRuns--;
    return { status: "completed", summary: `Done ${input.taskName}` };
  }

  completeNext(): TaskId | undefined {
    const completion = this.completions.shift();
    completion?.resolve();
    return completion?.taskId;
  }

  completeAll(): void {
    while (this.completions.length > 0) this.completeNext();
  }
}

class ImmediateLocalSubagentRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    return { status: "completed", summary: `Done ${input.taskName}` };
  }
}

interface ControlledSessionOperationContext {
  sessionId: SessionId;
  controller: AbortController;
  current: boolean;
  operation: RuntimeSessionOperation;
}

class ControlledSessionOperationCoordinator implements SessionOperationCoordinator {
  topLevelEntries: SessionId[] = [];
  nestedEntries = 0;
  private readonly storage = new AsyncLocalStorage<ControlledSessionOperationContext>();
  private readonly active = new Map<SessionId, ControlledSessionOperationContext>();
  private runClaim: SessionRunClaimFence | undefined;

  async withSessionOperation<T>(
    sessionId: SessionId,
    fn: (operation: RuntimeSessionOperation) => Promise<T> | T,
  ): Promise<T> {
    const inherited = this.storage.getStore();
    if (inherited?.sessionId === sessionId && inherited.current) {
      this.nestedEntries++;
      inherited.operation.assertCurrent();
      try {
        const result = await fn(inherited.operation);
        inherited.operation.assertCurrent();
        return result;
      } catch (error) {
        inherited.operation.assertCurrent();
        throw error;
      }
    }
    if (this.active.has(sessionId)) throw new RuntimeBusyError(sessionId);

    const controller = new AbortController();
    let context: ControlledSessionOperationContext;
    context = {
      sessionId,
      controller,
      current: true,
      operation: {
        signal: controller.signal,
        ...(this.runClaim?.sessionId === sessionId ? { runClaim: this.runClaim } : {}),
        assertCurrent: () => {
          if (!context.current || this.active.get(sessionId) !== context) {
            throw new RuntimeBusyError(sessionId);
          }
        },
      },
    };
    this.topLevelEntries.push(sessionId);
    this.active.set(sessionId, context);
    try {
      const result = await this.storage.run(context, () => fn(context.operation));
      context.operation.assertCurrent();
      return result;
    } catch (error) {
      context.operation.assertCurrent();
      throw error;
    } finally {
      context.current = false;
      if (this.active.get(sessionId) === context) this.active.delete(sessionId);
    }
  }

  invalidate(sessionId: SessionId): void {
    const context = this.active.get(sessionId);
    if (!context) return;
    context.current = false;
    context.controller.abort(new RuntimeBusyError(sessionId));
  }

  setRunClaim(runClaim: SessionRunClaimFence | undefined): void {
    this.runClaim = runClaim;
  }

  resetObservations(): void {
    this.topLevelEntries = [];
    this.nestedEntries = 0;
  }
}

class RecordingTeamRunEventStore {
  readonly appends: Array<{ event: ChiliEvent; options?: EventAppendOptions }> = [];

  constructor(
    private readonly store: SqliteEventStore,
    private readonly beforeAppend?: (
      event: ChiliEvent,
      options: EventAppendOptions | undefined,
    ) => void,
  ) {}

  async append(event: ChiliEvent, options?: EventAppendOptions): Promise<void> {
    this.beforeAppend?.(event, options);
    this.appends.push({ event, ...(options ? { options } : {}) });
    await this.store.append(event, options);
  }
}

class PendingMergeVerifier implements TeamTaskVerifier {
  constructor(
    private readonly teams: TeamControlService,
    private readonly now: () => TimestampMs,
  ) {}

  async verifyCompletedTasks(input: Parameters<TeamTaskVerifier["verifyCompletedTasks"]>[0]): Promise<Awaited<ReturnType<TeamTaskVerifier["verifyCompletedTasks"]>>> {
    const tasks = await this.teams.tasks(input.teamId);
    const result: Awaited<ReturnType<TeamTaskVerifier["verifyCompletedTasks"]>> = {
      scanned: 0,
      maxConcurrentVerifications: input.maxConcurrentVerifications ?? 2,
      verified: [],
      skipped: [],
      errors: [],
    };
    for (const task of tasks) {
      if (task.status !== "completed" || taskMergeMetadata(task.metadata)) continue;
      result.scanned++;
      const updated = await this.teams.updateTask({
        teamId: task.teamId,
        taskId: task.id,
        metadata: pendingMergeMetadata(Number(this.now())),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
      result.verified.push({
        status: "passed",
        teamTask: updated,
        verifierTask: {
          taskId: "task_verifier" as TaskId,
          runId: "run_verifier" as AgentRunId,
          path: "/root/worker/verifier" as AgentPath,
          parentPath: "/root/worker" as AgentPath,
          childSessionId: "session_verifier" as SessionId,
          status: "completed",
          summary: "VERDICT: passed",
        },
        feedback: "VERDICT: passed",
      });
    }
    return result;
  }
}

class MetadataMergeService implements TeamTaskMerger {
  constructor(
    private readonly teams: TeamControlService,
    private readonly status: TeamMergeResultStatus,
    private readonly now: () => TimestampMs,
  ) {}

  async mergeTeamTasks(input: Parameters<TeamTaskMerger["mergeTeamTasks"]>[0]): Promise<TeamMergeSweepResult> {
    const result: TeamMergeSweepResult = {
      scanned: 0,
      applied: [],
      failed: [],
      conflicted: [],
      skipped: [],
      errors: [],
    };
    const tasks = await this.teams.tasks(input.teamId);
    for (const task of tasks) {
      const merge = taskMergeMetadata(task.metadata);
      if (!merge || merge.status !== "pending") continue;
      result.scanned++;
      const metadata = {
        ...(task.metadata ?? {}),
        merge: {
          ...merge,
          status: this.status,
          mergedAt: Number(this.now()),
          diffSummary: { filesChanged: 1, paths: ["packages/core/src/team.ts"], truncatedPaths: false, diffBytes: 10 },
          ...(this.status === "conflicted" ? { error: "merge_conflicted", conflicts: ["packages/core/src/team.ts"] } : {}),
          ...(this.status === "failed" ? { error: "merge_failed" } : {}),
        },
      };
      const updated = await this.teams.updateTask({
        teamId: task.teamId,
        taskId: task.id,
        metadata,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
      const item = {
        status: this.status,
        teamTask: updated,
        diffSummary: { filesChanged: 1, paths: ["packages/core/src/team.ts"], truncatedPaths: false, diffBytes: 10 },
        ...(this.status === "conflicted" ? { error: "merge_conflicted", conflicts: ["packages/core/src/team.ts"] } : {}),
        ...(this.status === "failed" ? { error: "merge_failed" } : {}),
      };
      if (this.status === "applied") result.applied.push(item as TeamMergeSweepResult["applied"][number]);
      else if (this.status === "failed") result.failed.push(item as TeamMergeSweepResult["failed"][number]);
      else if (this.status === "conflicted") result.conflicted.push(item as TeamMergeSweepResult["conflicted"][number]);
    }
    return result;
  }
}

function pendingMergeMetadata(createdAt = 900): Record<string, unknown> {
  return {
    verification: { status: "passed", gitDiff: "diff" },
    merge: {
      status: "pending",
      createdAt,
      worktreePath: "/tmp/chili-runner-test-worktree",
      baseRef: "HEAD",
      diff: "diff",
    },
  };
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

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix: string) => `${prefix}_${++next}`;
}

function emptyReconcileResult() {
  return {
    scanned: 0,
    synced: [],
    skipped: [],
    errors: [],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAgentTaskTerminal(store: SqliteEventStore, taskId: TaskId): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const task = await store.agentTask(taskId);
    if (task && task.status !== "running") return;
    await delay(1);
  }
  throw new Error(`agent task did not reach terminal state: ${taskId}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
