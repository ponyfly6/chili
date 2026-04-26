import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, AgentRunId, SessionId, TaskId, ThreadId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { LocalSubagentManager, type LocalSubagentRunInput, type LocalSubagentRunResult, type LocalSubagentRunner } from "./subagent.js";
import { TeamTaskDispatchService } from "./team-dispatcher.js";
import { TeamControlService } from "./team.js";

test("dispatches a one-shot team task to a local subagent and syncs the final result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-oneshot-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 100 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_dispatch" as SessionId;
  const threadId = "thread_team_dispatch" as ThreadId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "Implemented the task" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });

    const team = await teams.createTeam({ sessionId, threadId, name: "core", leadPath });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Implement dispatch",
      description: "Wire team task to subagent execution.",
      ownerPath: workerPath,
      metadata: { priority: "p1" },
    });

    const result = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "one_shot",
      sessionId,
      threadId,
      cwd: dir,
    });

    expect(result.status).toBe("completed");
    expect(result.agentTask).toMatchObject({
      status: "completed",
      summary: "Implemented the task",
      parentPath: workerPath,
    });
    expect(result.teamTask).toMatchObject({
      id: task.id,
      status: "completed",
      summary: "Implemented the task",
      metadata: {
        priority: "p1",
        chiliTeamDispatch: {
          agentTaskId: result.agentTask?.taskId,
          agentPath: result.agentTask?.path,
          mode: "one_shot",
          agentStatus: "completed",
          syncedAt: 100,
        },
      },
    });
    expect(await store.agentTask(result.agentTask?.taskId as TaskId)).toMatchObject({
      status: "completed",
      summary: "Implemented the task",
    });
    expect(await store.teamMembers({ teamId: team.id, path: workerPath })).toMatchObject([{ status: "idle" }]);
    expect(runner.runs[0]?.prompt).toContain(`Team task: ${team.id}/${task.id}`);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncs a background team task after the subagent finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-background-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 200 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/verifier" as AgentPath;
  const sessionId = "session_team_background" as SessionId;
  const threadId = "thread_team_background" as ThreadId;
  const runner = new DeferredLocalSubagentRunner({ status: "completed", summary: "Verified independently" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });

    const team = await teams.createTeam({ sessionId, threadId, name: "review", leadPath });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: workerPath, name: "verifier", role: "reviewer" });
    const task = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Verify runtime",
      ownerPath: workerPath,
    });

    const dispatched = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "background",
      sessionId,
      threadId,
      cwd: dir,
    });
    expect(dispatched.status).toBe("running");
    const dispatchedAgentTask = dispatched.agentTask;
    if (!dispatchedAgentTask) throw new Error("expected dispatched agent task");
    expect(dispatched.teamTask).toMatchObject({
      status: "in_progress",
    });
    expect(dispatched.teamTask.metadata).toEqual({
      chiliTeamDispatch: {
        agentTaskId: dispatchedAgentTask.taskId,
        agentPath: dispatchedAgentTask.path,
        runId: dispatchedAgentTask.runId,
        childSessionId: dispatchedAgentTask.childSessionId,
        childThreadId: dispatchedAgentTask.childThreadId,
        mode: "background",
        dispatchedAt: 200,
        agentStatus: "running",
      },
    });

    await runner.started;
    runner.complete();
    await subagents.waitForBackgroundTasks();
    const synced = await dispatcher.syncTask({ teamId: team.id, taskId: task.id, sessionId, threadId });

    expect(synced).toMatchObject({
      applied: true,
      teamTask: {
        id: task.id,
        status: "completed",
        summary: "Verified independently",
      },
      agentTask: {
        status: "completed",
        summary: "Verified independently",
      },
    });
    expect(synced.teamTask.metadata).toEqual({
      chiliTeamDispatch: {
        agentTaskId: dispatchedAgentTask.taskId,
        agentPath: dispatchedAgentTask.path,
        runId: dispatchedAgentTask.runId,
        childSessionId: dispatchedAgentTask.childSessionId,
        childThreadId: dispatchedAgentTask.childThreadId,
        mode: "background",
        dispatchedAt: 200,
        agentStatus: "completed",
        syncedAt: 200,
      },
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports skipped reasons for dispatch, sync, and reconcile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-skips-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 225 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_skips" as SessionId;
  const threadId = "thread_team_skips" as ThreadId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "should not run" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });

    const team = await teams.createTeam({ sessionId, threadId, name: "skips", leadPath });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const unownedTask = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Missing owner",
    });

    const dispatchSkipped = await dispatcher.dispatchTask({ teamId: team.id, taskId: unownedTask.id, sessionId, threadId });
    expect(dispatchSkipped).toMatchObject({
      status: "skipped",
      reason: "missing_owner",
      teamTask: { id: unownedTask.id, status: "pending" },
    });
    expect(runner.runs).toEqual([]);

    const syncSkipped = await dispatcher.syncTask({ teamId: team.id, taskId: unownedTask.id, sessionId, threadId });
    expect(syncSkipped).toMatchObject({
      applied: false,
      reason: "not_dispatched",
      teamTask: { id: unownedTask.id, status: "pending" },
    });

    const missingAgentTask = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Missing agent task",
      ownerPath: workerPath,
      status: "in_progress",
      metadata: {
        chiliTeamDispatch: {
          agentTaskId: "task_missing_agent" as TaskId,
          agentPath: workerPath,
          runId: "agentrun_missing_agent" as AgentRunId,
          childSessionId: "session_missing_agent" as SessionId,
          childThreadId: "thread_missing_agent" as ThreadId,
          mode: "background",
          dispatchedAt: 100,
          agentStatus: "running",
        },
      },
    });

    const reconciled = await dispatcher.reconcileTasks({ teamId: team.id, sessionId, threadId });
    expect(reconciled).toMatchObject({
      scanned: 1,
      synced: [],
      skipped: [
        {
          applied: false,
          reason: "agent_task_not_found",
          teamTask: { id: missingAgentTask.id, status: "in_progress" },
        },
      ],
      errors: [],
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconciles dispatched background team tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-reconcile-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 250 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/reconciler" as AgentPath;
  const sessionId = "session_team_reconcile" as SessionId;
  const threadId = "thread_team_reconcile" as ThreadId;
  const runner = new DeferredLocalSubagentRunner({ status: "completed", summary: "Reconciled result" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });

    const team = await teams.createTeam({ sessionId, threadId, name: "reconcile", leadPath });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: workerPath, name: "reconciler", role: "worker" });
    const task = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Background task",
      ownerPath: workerPath,
    });
    const plainTask = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Plain in-progress task",
      ownerPath: workerPath,
      status: "in_progress",
    });

    const dispatched = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "background",
      sessionId,
      threadId,
      cwd: dir,
    });
    await runner.started;

    const beforeComplete = await dispatcher.reconcileTasks({ teamId: team.id, sessionId, threadId });
    expect(beforeComplete).toMatchObject({
      scanned: 1,
      synced: [],
      skipped: [{ applied: false, reason: "agent_running", teamTask: { id: task.id } }],
      errors: [],
    });

    runner.complete();
    await subagents.waitForBackgroundTasks();
    const afterComplete = await dispatcher.reconcileTasks({ teamId: team.id, sessionId, threadId });

    expect(afterComplete).toMatchObject({
      scanned: 1,
      synced: [
        {
          applied: true,
          teamTask: {
            id: task.id,
            status: "completed",
            summary: "Reconciled result",
            metadata: {
              chiliTeamDispatch: {
                agentTaskId: dispatched.agentTask?.taskId,
                agentStatus: "completed",
                syncedAt: 250,
              },
            },
          },
        },
      ],
      skipped: [],
      errors: [],
    });
    const untouched = (await teams.tasks(team.id)).find((item) => item.id === plainTask.id);
    expect(untouched).toMatchObject({ status: "in_progress" });
    expect(untouched?.metadata).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("marks a team task failed when the dispatched subagent fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-failed-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 300 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_failed" as SessionId;
  const runner = new FakeLocalSubagentRunner({ status: "failed", error: new Error("model failed") });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });

    const team = await teams.createTeam({ sessionId, name: "failure", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Fails", ownerPath: workerPath });

    const result = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "one_shot",
      sessionId,
      cwd: dir,
    });

    expect(result.status).toBe("failed");
    expect(result.teamTask).toMatchObject({
      status: "failed",
      error: "model failed",
      completedAt: 300,
      metadata: {
        chiliTeamDispatch: {
          agentStatus: "failed",
          syncedAt: 300,
        },
      },
    });
    expect(await store.teamMembers({ teamId: team.id, path: workerPath })).toMatchObject([{ status: "idle" }]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class FakeLocalSubagentRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];

  constructor(private readonly result: LocalSubagentRunResult) {}

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    return this.result;
  }
}

class DeferredLocalSubagentRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];
  readonly started: Promise<void>;
  private resolveStarted: (() => void) | undefined;
  private resolveCompletion: (() => void) | undefined;

  constructor(private readonly result: LocalSubagentRunResult) {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    this.resolveStarted?.();
    await new Promise<void>((resolve) => {
      this.resolveCompletion = resolve;
    });
    return this.result;
  }

  complete(): void {
    this.resolveCompletion?.();
  }
}

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix: string) => `${prefix}_${++next}`;
}
