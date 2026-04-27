import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, SessionId, TimestampMs, ThreadId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { LocalSubagentManager, type LocalSubagentRunInput, type LocalSubagentRunResult, type LocalSubagentRunner } from "./subagent.js";
import { TeamTaskDispatchService } from "./team-dispatcher.js";
import { TeamExecutionRunner } from "./team-execution-runner.js";
import { TeamControlService } from "./team.js";

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
