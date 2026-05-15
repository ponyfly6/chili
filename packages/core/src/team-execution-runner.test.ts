import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, AgentRunId, SessionId, TaskId, TeamId, TimestampMs, ThreadId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { LocalSubagentManager, type LocalSubagentRunInput, type LocalSubagentRunResult, type LocalSubagentRunner } from "./subagent.js";
import { TeamTaskDispatchService, type TeamTaskDispatchResult } from "./team-dispatcher.js";
import { TeamExecutionRunner, type TeamTaskMerger, type TeamTaskVerifier } from "./team-execution-runner.js";
import type { TeamMergeResultStatus, TeamMergeSweepResult } from "./team-merge.js";
import { TeamControlService } from "./team.js";
import { taskMergeMetadata } from "./team-worktree.js";

test("runs team tasks through dependencies until the board is drained", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-drained-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 500 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const setupPath = "/root/setup" as AgentPath;
  const featurePath = "/root/feature" as AgentPath;
  const sessionId = "session_team_runner" as SessionId;
  const threadId = "thread_team_runner" as ThreadId;
  const runner = new DeferredLocalSubagentRunner();
  let subagents: LocalSubagentManager | undefined;

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      sleep: async () => {
        runner.completeNext();
        if (!subagents) throw new Error("subagents not initialized");
        await subagents.waitForBackgroundTasks();
      },
    });

    const team = await teams.createTeam({ sessionId, threadId, name: "runner", leadPath });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: setupPath, name: "setup", role: "implementer" });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: featurePath, name: "feature", role: "implementer" });
    const setup = await teams.createTask({ sessionId, threadId, teamId: team.id, title: "Prepare", ownerPath: setupPath });
    const feature = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Build feature",
      ownerPath: featurePath,
      dependsOn: [setup.id],
    });
    const unowned = await teams.createTask({ sessionId, threadId, teamId: team.id, title: "Needs owner" });

    const summary = await execution.run({
      teamId: team.id,
      sessionId,
      threadId,
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
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });
    const execution = new TeamExecutionRunner({ teams, dispatcher, cwd: dir, now });

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

test("dispatches independent team tasks concurrently with a bounded fan-out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-runner-concurrent-dispatch-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 620 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const sessionId = "session_team_runner_concurrent" as SessionId;
  let running = 0;
  let maxRunning = 0;

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ sessionId, name: "runner-concurrent", leadPath });
    const workerA = "/root/a" as AgentPath;
    const workerB = "/root/b" as AgentPath;
    const workerC = "/root/c" as AgentPath;
    await teams.addMember({ sessionId, teamId: team.id, path: workerA, name: "a", role: "implementer" });
    await teams.addMember({ sessionId, teamId: team.id, path: workerB, name: "b", role: "implementer" });
    await teams.addMember({ sessionId, teamId: team.id, path: workerC, name: "c", role: "implementer" });
    const first = await teams.createTask({ sessionId, teamId: team.id, title: "First", ownerPath: workerA });
    const second = await teams.createTask({ sessionId, teamId: team.id, title: "Second", ownerPath: workerB });
    const third = await teams.createTask({ sessionId, teamId: team.id, title: "Third", ownerPath: workerC });
    const tasksById = new Map([first, second, third].map((task) => [task.id, task]));

    const dispatcher = {
      async reconcileTasks() {
        return emptyReconcileResult();
      },
      async dispatchTask(input: Parameters<TeamTaskDispatchService["dispatchTask"]>[0]): Promise<TeamTaskDispatchResult> {
        const task = tasksById.get(input.taskId);
        if (!task) throw new Error(`missing task ${input.taskId}`);
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await delay(task.id === first.id ? 20 : 1);
        running -= 1;
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
    });

    const summary = await execution.run({
      teamId: team.id,
      sessionId,
      once: true,
      maxConcurrentDispatches: 2,
    });

    expect(maxRunning).toBe(2);
    expect(summary).toMatchObject({
      stopReason: "once",
      maxConcurrentDispatches: 2,
      errors: [],
    });
    expect(summary.dispatched).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: first.id, status: "running", ownerPath: workerA }),
      expect.objectContaining({ taskId: second.id, status: "running", ownerPath: workerB }),
      expect.objectContaining({ taskId: third.id, status: "running", ownerPath: workerC }),
    ]));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

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
    });

    await execution.run({ teamId: team.id, sessionId, once: true, maxConcurrentDispatches: 1 });

    expect(dispatchOrder).toEqual([high.id, low.id]);
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
  const threadId = "thread_team_runner_lifecycle" as ThreadId;
  const runner = new ImmediateLocalSubagentRunner();
  let subagents: LocalSubagentManager | undefined;

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });
    const execution = new TeamExecutionRunner({ teams, dispatcher, events: store, cwd: dir, now, createId: ids });

    const team = await teams.createTeam({ sessionId, threadId, name: "runner-lifecycle", leadPath });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, threadId, teamId: team.id, title: "Emit events", ownerPath: workerPath });

    const summary = await execution.run({ teamId: team.id, sessionId, threadId, mode: "one_shot", maxCycles: 3 });

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
      threadId,
      payload: {
        teamId: team.id,
        mode: "one_shot",
        once: false,
        maxCycles: 3,
        maxConcurrentDispatches: 4,
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
      threadId,
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
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });
    const execution = new TeamExecutionRunner({ teams, dispatcher, cwd: dir, now });

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
  const createdThreadId = "thread_created_for_runner" as ThreadId;
  const runner = new ImmediateLocalSubagentRunner();
  let subagents: LocalSubagentManager | undefined;
  const createdSessions: Array<{ teamId: string; cwd: string }> = [];

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      createSession: async (input) => {
        createdSessions.push(input);
        return { sessionId: createdSessionId, threadId: createdThreadId };
      },
    });

    const team = await teams.createTeam({ name: "sessionless", leadPath });
    await teams.addMember({ teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ teamId: team.id, title: "Needs session", ownerPath: workerPath });

    const summary = await execution.run({ teamId: team.id, mode: "one_shot" });

    expect(summary).toMatchObject({
      stopReason: "drained",
      dispatched: [{ taskId: task.id, status: "completed" }],
      completed: [{ taskId: task.id, status: "completed", summary: "Done Needs session" }],
      skipped: [],
      errors: [],
    });
    expect(createdSessions).toEqual([{ teamId: team.id, cwd: dir }]);
    expect(runner.runs[0]).toMatchObject({
      parentSessionId: createdSessionId,
      parentThreadId: createdThreadId,
      taskName: "Needs session",
    });
  } finally {
    await subagents?.waitForBackgroundTasks();
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
  const createdThreadId = "thread_created_for_reconcile" as ThreadId;
  const runner = new DeferredLocalSubagentRunner();
  let subagents: LocalSubagentManager | undefined;

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });
    const execution = new TeamExecutionRunner({
      teams,
      dispatcher,
      cwd: dir,
      now,
      createSession: async () => ({ sessionId: createdSessionId, threadId: createdThreadId }),
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
      threadId: createdThreadId,
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
  const createdThreadId = "thread_created_after_deadline" as ThreadId;
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
      createSession: async () => {
        await delay(30);
        return { sessionId: createdSessionId, threadId: createdThreadId };
      },
    });

    const summary = await execution.run({ teamId: team.id, timeoutMs: 10 });

    expect(summary).toMatchObject({
      stopReason: "timeout",
      cycles: 1,
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
  const createdThreadId = "thread_created_after_abort" as ThreadId;
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
      createSession: async (input) => {
        createSessionSignals.push(input.signal);
        controller.abort();
        return { sessionId: createdSessionId, threadId: createdThreadId };
      },
    });

    const summary = await execution.run({ teamId: team.id, signal: controller.signal });

    expect(summary).toMatchObject({
      stopReason: "aborted",
      cycles: 1,
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
      cycles: 1,
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
    const execution = new TeamExecutionRunner({ teams, dispatcher, cwd: dir, now });

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
    const execution = new TeamExecutionRunner({ teams, dispatcher, cwd: dir, now });

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
    const execution = new TeamExecutionRunner({ teams, dispatcher, cwd: dir, now });

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
    const teams = new TeamControlService({ store, createId: ids, now });
    subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });
    const verifier = new PendingMergeVerifier(teams, now);
    const merger = new MetadataMergeService(teams, "applied", now);
    const execution = new TeamExecutionRunner({ teams, dispatcher, verifier, merger, cwd: dir, now });
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
    const execution = new TeamExecutionRunner({ teams, dispatcher, merger, cwd: dir, now });

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
    const execution = new TeamExecutionRunner({ teams, dispatcher, cwd: dir, now });

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

class DeferredLocalSubagentRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];
  private readonly completions: Array<() => void> = [];

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    await new Promise<void>((resolve) => {
      this.completions.push(resolve);
    });
    return { status: "completed", summary: `Done ${input.taskName}` };
  }

  completeNext(): void {
    this.completions.shift()?.();
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
        ...(input.threadId ? { threadId: input.threadId } : {}),
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
          childThreadId: "thread_verifier" as ThreadId,
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
        ...(input.threadId ? { threadId: input.threadId } : {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
