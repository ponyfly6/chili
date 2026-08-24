import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, AgentRunId, ChiliEvent, SessionId, TaskId, TimestampMs, ToolCallId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import {
  RuntimeBusyError,
  type RuntimeSessionOperation,
  type SessionOperationCoordinator,
} from "./runtime-service.js";
import { LocalSubagentManager, type LocalSubagentRunInput, type LocalSubagentRunResult, type LocalSubagentRunner } from "./subagent.js";
import {
  TeamTaskDispatchAuthorityError,
  TeamTaskDispatchService,
} from "./team-dispatcher.js";
import { TeamControlService } from "./team.js";

const TEST_SESSION_OPERATIONS: SessionOperationCoordinator = {
  async withSessionOperation(_sessionId, fn) {
    const controller = new AbortController();
    return fn({ signal: controller.signal, assertCurrent() {} });
  },
};

test("dispatches a one-shot team task to a local subagent and syncs the final result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-oneshot-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 100 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_dispatch" as SessionId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "Implemented the task" });
  const inputController = new AbortController();

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const team = await teams.createTeam({ sessionId, name: "core", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({
      sessionId,
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
      cwd: dir,
      signal: inputController.signal,
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
    const runSignal = runner.runs[0]?.signal;
    expect(runSignal).toBeDefined();
    expect(runSignal).not.toBe(inputController.signal);
    expect(runSignal?.aborted).toBe(false);
    inputController.abort();
    expect(runSignal?.aborted).toBe(true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("session operation fencing rejects an external concurrent dispatch before either task is claimed or spawned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-operation-busy-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const sessionId = "session_team_dispatch_operation_busy" as SessionId;
  const workerPath = "/root/worker" as AgentPath;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "only the lease owner ran" });
  const sessionOperations = new FakeSessionOperationCoordinator();
  const gate = sessionOperations.pauseNextOperation();
  let firstDispatch: ReturnType<TeamTaskDispatchService["dispatchTask"]> | undefined;

  try {
    const teams = new TeamControlService({ store, createId: ids });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations,
    });
    const team = await teams.createTeam({ sessionId, name: "operation busy", leadPath: "/root" as AgentPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const firstTask = await teams.createTask({ sessionId, teamId: team.id, title: "Lease owner", ownerPath: workerPath });
    const secondTask = await teams.createTask({ sessionId, teamId: team.id, title: "External contender", ownerPath: workerPath });

    firstDispatch = dispatcher.dispatchTask({
      teamId: team.id,
      taskId: firstTask.id,
      mode: "one_shot",
      sessionId,
    });
    await gate.entered;

    await expect(dispatcher.dispatchTask({
      teamId: team.id,
      taskId: secondTask.id,
      mode: "one_shot",
      sessionId,
    })).rejects.toBeInstanceOf(RuntimeBusyError);
    expect(await store.events({ type: "team.task_claimed", limit: 10 })).toEqual([]);
    expect(runner.runs).toEqual([]);
    expect(await teams.tasks(team.id)).toMatchObject([
      { id: firstTask.id, status: "pending" },
      { id: secondTask.id, status: "pending" },
    ]);

    gate.release();
    await expect(firstDispatch).resolves.toMatchObject({ status: "completed" });
    expect(runner.runs).toHaveLength(1);
    expect(await store.events({ type: "team.task_claimed" })).toHaveLength(1);
    expect(await store.events({ type: "agent.task_created" })).toHaveLength(1);
    expect((await teams.tasks(team.id)).find((task) => task.id === secondTask.id)).toMatchObject({ status: "pending" });
  } finally {
    gate.release();
    await firstDispatch?.catch(() => undefined);
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lost session operation capability stops dispatch before claim or spawn side effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-operation-lost-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const sessionId = "session_team_dispatch_operation_lost" as SessionId;
  const workerPath = "/root/worker" as AgentPath;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "must not run" });
  const sessionOperations = new FakeSessionOperationCoordinator();

  try {
    const teams = new TeamControlService({ store, createId: ids });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations,
      assertDelegationEnabled() {
        sessionOperations.invalidate(sessionId);
      },
    });
    const team = await teams.createTeam({ sessionId, name: "operation lost", leadPath: "/root" as AgentPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Stop on lease loss", ownerPath: workerPath });

    await expect(dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "one_shot",
      sessionId,
    })).rejects.toBeInstanceOf(RuntimeBusyError);

    expect(await store.events({ type: "team.task_claimed", limit: 10 })).toEqual([]);
    expect(await store.agentTasks({ parentSessionId: sessionId })).toEqual([]);
    expect(runner.runs).toEqual([]);
    expect(await teams.tasks(team.id)).toMatchObject([{ id: task.id, status: "pending" }]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch reenters an operation already owned by the same async session chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-operation-nested-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const sessionId = "session_team_dispatch_operation_nested" as SessionId;
  const workerPath = "/root/worker" as AgentPath;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "nested dispatch completed" });
  const sessionOperations = new FakeSessionOperationCoordinator();

  try {
    const setupTeams = new TeamControlService({ store, createId: ids });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids });
    const team = await setupTeams.createTeam({ sessionId, name: "nested operation", leadPath: "/root" as AgentPath });
    await setupTeams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await setupTeams.createTask({ sessionId, teamId: team.id, title: "Nested dispatch", ownerPath: workerPath });
    const teams = new TeamControlService({ store, createId: ids, sessionOperations });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations,
    });

    const result = await sessionOperations.withSessionOperation(sessionId, async (operation) => {
      operation.assertCurrent();
      return dispatcher.dispatchTask({ teamId: team.id, taskId: task.id, mode: "one_shot", sessionId });
    });

    expect(result).toMatchObject({ status: "completed", teamTask: { id: task.id, status: "completed" } });
    expect(sessionOperations.topLevelCalls).toBe(1);
    expect(sessionOperations.nestedCalls).toBeGreaterThanOrEqual(3);
    expect(runner.runs).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile acquires a separate owner operation for each active team", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-reconcile-operation-segments-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const firstSessionId = "session_team_reconcile_segment_first" as SessionId;
  const secondSessionId = "session_team_reconcile_segment_second" as SessionId;
  const runner = new FakeLocalSubagentRunner({ status: "completed" });
  const sessionOperations = new FakeSessionOperationCoordinator();

  try {
    const teams = new TeamControlService({ store, createId: ids });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations,
    });
    await teams.createTeam({ sessionId: firstSessionId, name: "first", leadPath: "/root" as AgentPath });
    await teams.createTeam({ sessionId: secondSessionId, name: "second", leadPath: "/root" as AgentPath });

    await expect(dispatcher.reconcileTasks()).resolves.toEqual({
      scanned: 0,
      synced: [],
      skipped: [],
      errors: [],
    });
    expect([...sessionOperations.topLevelSessionIds].sort()).toEqual([firstSessionId, secondSessionId].sort());
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch authority rejects owner overrides but accepts descendant task actor provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-authority-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_authority" as SessionId;
  const otherSessionId = "session_team_authority_other" as SessionId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "must not run" });
  const authorityCalls: SessionId[] = [];

  try {
    const teams = new TeamControlService({ store, createId: ids });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      resolveSession(requestedSessionId) {
        authorityCalls.push(requestedSessionId);
        return { cwd: dir };
      },
      sessionOperations: TEST_SESSION_OPERATIONS,
    });
    const team = await teams.createTeam({ sessionId, name: "authority", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Stay inside authority",
      ownerPath: workerPath,
    });

    await expect(dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      sessionId: otherSessionId,
    })).rejects.toBeInstanceOf(TeamTaskDispatchAuthorityError);
    expect(authorityCalls).toEqual([]);

    await expect(dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      sessionId,
      cwd: join(dir, "other-workspace"),
    })).rejects.toBeInstanceOf(TeamTaskDispatchAuthorityError);
    expect(authorityCalls).toEqual([sessionId]);
    expect(runner.runs).toEqual([]);
    expect(await store.teamTasks({ teamId: team.id })).toMatchObject([{ id: task.id, status: "pending" }]);

    const corruptTask = await teams.createTask({
      sessionId: otherSessionId,
      teamId: team.id,
      title: "Conflicting persisted owner",
      ownerPath: workerPath,
    });
    const provenanceDispatch = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: corruptTask.id,
      mode: "one_shot",
    });
    expect(provenanceDispatch.status).toBe("completed");
    expect(runner.runs).toHaveLength(1);
    expect(authorityCalls.every((candidate) => candidate === sessionId)).toBe(true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("session authority rejection leaves the team task unclaimed and never spawns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-session-rejection-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const sessionId = "session_team_authority_rejected" as SessionId;
  const workerPath = "/root/worker" as AgentPath;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "must not run" });

  try {
    const teams = new TeamControlService({ store, createId: ids });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids });
    const team = await teams.createTeam({ sessionId, name: "session rejection", leadPath: "/root" as AgentPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Do not claim without session authority",
      ownerPath: workerPath,
    });

    for (const reason of ["missing", "archived", "subagent"] as const) {
      const dispatcher = new TeamTaskDispatchService({
        teams,
        subagents,
        store,
        cwd: dir,
        resolveSession() {
          throw new TeamTaskDispatchAuthorityError(`session is ${reason}`);
        },
        sessionOperations: TEST_SESSION_OPERATIONS,
      });

      await expect(dispatcher.dispatchTask({
        teamId: team.id,
        taskId: task.id,
        sessionId,
      })).rejects.toThrow(`session is ${reason}`);

      expect(runner.runs).toEqual([]);
      expect(await store.agentTasks({ parentSessionId: sessionId })).toEqual([]);
      expect(await store.teamTasks({ teamId: team.id })).toMatchObject([{
        id: task.id,
        status: "pending",
      }]);
      expect(await store.teamMembers({ teamId: team.id, path: workerPath })).toMatchObject([{
        status: "idle",
      }]);
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sync and reconcile reject unbound or subagent owner authority without mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-sync-authority-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const leadPath = "/root" as AgentPath;
  const childSessionId = "session_sync_subagent" as SessionId;
  const runner = new FakeLocalSubagentRunner({ status: "completed" });

  try {
    const teams = new TeamControlService({ store, createId: ids });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      resolveSession: () => ({ cwd: dir, status: "active", source: "subagent" }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });
    const unbound = await teams.createTeam({ name: "unbound", leadPath });
    const unboundTask = await teams.createTask({ teamId: unbound.id, title: "unbound sync" });
    const childOwned = await teams.createTeam({ sessionId: childSessionId, name: "child", leadPath });
    const childTask = await teams.createTask({ sessionId: childSessionId, teamId: childOwned.id, title: "child sync" });
    const before = await store.events({ limit: 100 });

    await expect(dispatcher.syncTask({ teamId: unbound.id, taskId: unboundTask.id }))
      .rejects.toBeInstanceOf(TeamTaskDispatchAuthorityError);
    await expect(dispatcher.reconcileTasks({ teamId: unbound.id }))
      .rejects.toBeInstanceOf(TeamTaskDispatchAuthorityError);
    await expect(dispatcher.syncTask({ teamId: childOwned.id, taskId: childTask.id }))
      .rejects.toBeInstanceOf(TeamTaskDispatchAuthorityError);
    await expect(dispatcher.reconcileTasks({ teamId: childOwned.id }))
      .rejects.toBeInstanceOf(TeamTaskDispatchAuthorityError);

    expect(await store.events({ limit: 100 })).toEqual(before);
    expect(runner.runs).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("includes failed verifier feedback in retry prompts and clears stale task errors on success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-verifier-feedback-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 150 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_dispatch_verifier_feedback" as SessionId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "Fixed verifier feedback" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const team = await teams.createTeam({ sessionId, name: "feedback", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Retry after verifier failure",
      ownerPath: workerPath,
      metadata: {
        verification: {
          status: "failed",
          feedback: "VERDICT: failed\nAdd retry timeout coverage.",
        },
      },
    });
    await teams.updateTask({
      sessionId,
      teamId: team.id,
      taskId: task.id,
      error: "verification_failed",
    });

    const result = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "one_shot",
      sessionId,
      cwd: dir,
    });

    expect(runner.runs[0]?.prompt).toContain("Previous verifier feedback:\nVERDICT: failed\nAdd retry timeout coverage.");
    expect(result.teamTask).toMatchObject({
      id: task.id,
      status: "completed",
      summary: "Fixed verifier feedback",
    });
    expect(result.teamTask.error).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("applies one concurrent background sync and fences stale sync after verifier reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-background-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 200 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/verifier" as AgentPath;
  const sessionId = "session_team_background" as SessionId;
  const runner = new DeferredLocalSubagentRunner({ status: "completed", summary: "Verified independently" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const team = await teams.createTeam({ sessionId, name: "review", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "verifier", role: "reviewer" });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Verify runtime",
      ownerPath: workerPath,
    });

    const dispatched = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "background",
      sessionId,
      cwd: dir,
    });
    expect(dispatched.status).toBe("running");
    const dispatchedAgentTask = dispatched.agentTask;
    if (!dispatchedAgentTask) throw new Error("expected dispatched agent task");
    expect(dispatched.teamTask).toMatchObject({
      status: "in_progress",
    });
    expect(dispatched.teamTask.metadata).toMatchObject({
      chiliTeamDispatch: {
        agentTaskId: dispatchedAgentTask.taskId,
        agentPath: dispatchedAgentTask.path,
        runId: dispatchedAgentTask.runId,
        childSessionId: dispatchedAgentTask.childSessionId,
        mode: "background",
        dispatchedAt: 200,
        agentStatus: "running",
        policy: {
          allowed: true,
          allowedTools: expect.arrayContaining(["read", "complete_task", "team_task_update"]),
          checkedAt: 200,
        },
      },
    });
    expect(dispatchedAgentTask.workerPolicy).toMatchObject({
      teamId: team.id,
      taskId: task.id,
      memberPath: workerPath,
      childSessionId: dispatchedAgentTask.childSessionId,
      allowedTools: expect.arrayContaining(["read", "complete_task", "team_task_update"]),
      writeScope: [],
      executeScope: [],
    });
    expect(await store.agentTask(dispatchedAgentTask.taskId)).toMatchObject({
      mode: "background",
      completionPolicy: "detached",
    });

    await runner.started;
    runner.complete();
    await subagents.waitForBackgroundTasks();
    const syncs = await Promise.all([
      dispatcher.syncTask({ teamId: team.id, taskId: task.id, sessionId }),
      dispatcher.syncTask({ teamId: team.id, taskId: task.id, sessionId }),
    ]);
    expect(syncs.filter((result) => result.applied)).toHaveLength(1);
    expect(syncs.filter((result) => !result.applied)).toMatchObject([{ reason: "team_already_final" }]);
    const synced = syncs.find((result) => result.applied);
    if (!synced) throw new Error("expected one applied team sync");

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
    expect(synced.teamTask.metadata).toMatchObject({
      chiliTeamDispatch: {
        agentTaskId: dispatchedAgentTask.taskId,
        agentPath: dispatchedAgentTask.path,
        runId: dispatchedAgentTask.runId,
        childSessionId: dispatchedAgentTask.childSessionId,
        mode: "background",
        dispatchedAt: 200,
        agentStatus: "completed",
        syncedAt: 200,
        policy: {
          allowed: true,
          allowedTools: expect.arrayContaining(["read", "complete_task", "team_task_update"]),
          checkedAt: 200,
        },
      },
    });
    const terminalUpdates = (await store.events({ type: "team.task_updated" })).filter(
      (event) => {
        const payload = event.payload as { taskId?: TaskId; status?: string };
        return event.type === "team.task_updated" && payload.taskId === task.id && payload.status === "completed";
      },
    );
    expect(terminalUpdates).toHaveLength(1);
    expect(await store.teamMembers({ teamId: team.id, path: workerPath })).toMatchObject([{ status: "idle" }]);

    const reopenedMetadata = {
      ...synced.teamTask.metadata,
      verification: { status: "failed", feedback: "retry required" },
    };
    await teams.updateTask({
      teamId: team.id,
      taskId: task.id,
      status: "pending",
      error: "verification_failed",
      metadata: reopenedMetadata,
      sessionId,
    });
    const terminalAgentTask = synced.agentTask;
    if (!terminalAgentTask?.currentRunId || terminalAgentTask.status !== "completed") {
      throw new Error("expected a completed agent task with a run fence");
    }
    const stale = await teams.syncTaskFromAgent({
      teamId: team.id,
      taskId: task.id,
      agentTaskId: terminalAgentTask.id,
      agentRunId: terminalAgentTask.currentRunId as AgentRunId,
      agentGeneration: terminalAgentTask.generation,
      agentStatus: terminalAgentTask.status,
      status: "completed",
      ...(terminalAgentTask.summary ? { summary: terminalAgentTask.summary } : {}),
      metadata: synced.teamTask.metadata ?? {},
      sessionId,
    });
    expect(stale).toMatchObject({
      applied: false,
      reason: "not_in_progress",
      task: {
        status: "pending",
        error: "verification_failed",
        metadata: { verification: { status: "failed", feedback: "retry required" } },
      },
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const maxConcurrency of [1, 2]) {
  test(`direct team batch limits five real child lifetimes to ${maxConcurrency} and replenishes slots`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `chili-team-dispatch-batch-cap-${maxConcurrency}-`));
    const store = new SqliteEventStore(join(dir, "events.sqlite"));
    const ids = createSequentialId();
    const now = () => 205 as TimestampMs;
    const leadPath = "/root" as AgentPath;
    const sessionId = `session_team_batch_cap_${maxConcurrency}` as SessionId;
    const sourceCallId = `call_team_batch_cap_${maxConcurrency}` as ToolCallId;
    const batchId = sourceCallId;
    const runner = new RollingDeferredLocalSubagentRunner();
    let subagents: LocalSubagentManager | undefined;

    try {
      const teams = new TeamControlService({ store, createId: ids, now });
      subagents = new LocalSubagentManager({ store, runner, createId: ids, now, maxActiveRuns: 5 });
      const dispatcher = new TeamTaskDispatchService({
        teams,
        subagents,
        store,
        cwd: dir,
        now,
        resolveSession: () => ({ cwd: dir }),
        sessionOperations: TEST_SESSION_OPERATIONS,
      });
      const team = await teams.createTeam({ sessionId, name: `batch-cap-${maxConcurrency}`, leadPath });
      const tasks = [];
      for (let index = 0; index < 5; index++) {
        const ownerPath = `/root/batch-worker-${index}` as AgentPath;
        await teams.addMember({
          sessionId,
          teamId: team.id,
          path: ownerPath,
          name: `batch-worker-${index}`,
          role: "implementer",
        });
        tasks.push(await teams.createTask({
          sessionId,
          teamId: team.id,
          title: `Batch task ${index}`,
          ownerPath,
        }));
      }

      const dispatched = await Promise.all(tasks.map((task, batchIndex) => dispatcher.dispatchTask({
        teamId: team.id,
        taskId: task.id,
        mode: "background",
        sessionId,
        cwd: dir,
        sourceCallId,
        batchId,
        batchIndex,
        expectedBatchSize: tasks.length,
        maxConcurrency,
      })));

      expect(dispatched).toHaveLength(5);
      expect(dispatched.every((result) => result.status === "running")).toBe(true);
      expect(dispatched.map((result) => result.agentTask?.status)).toEqual(Array(5).fill("pending"));
      await waitUntil(() => runner.runs.length === maxConcurrency);
      expect(runner.activeRunCount).toBe(maxConcurrency);

      while (runner.runs.length < tasks.length) {
        const expectedStarted = runner.runs.length + 1;
        runner.completeNext();
        await waitUntil(() => runner.runs.length === expectedStarted);
        expect(runner.activeRunCount).toBeLessThanOrEqual(maxConcurrency);
      }

      runner.completeAll();
      await subagents.waitForBackgroundTasks();
      expect(runner.maxActiveRuns).toBe(maxConcurrency);
      expect(runner.activeRunCount).toBe(0);
      expect(runner.runs.map((run) => ({
        sourceCallId: run.sourceCallId,
        batchId: run.batchId,
        batchIndex: run.batchIndex,
        expectedBatchSize: run.expectedBatchSize,
        maxConcurrency: run.maxConcurrency,
        completionPolicy: run.completionPolicy,
      })).sort((left, right) => Number(left.batchIndex) - Number(right.batchIndex))).toEqual(
        Array.from({ length: 5 }, (_, batchIndex) => ({
          sourceCallId,
          batchId,
          batchIndex,
          expectedBatchSize: 5,
          maxConcurrency,
          completionPolicy: "detached",
        })),
      );
    } finally {
      runner.completeAll();
      await subagents?.waitForBackgroundTasks();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("syncs an incomplete child as a blocked team task with an actionable error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-incomplete-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 210 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/reviewer" as AgentPath;
  const sessionId = "session_team_incomplete" as SessionId;
  const runner = new DeferredLocalSubagentRunner({
    status: "incomplete",
    summary: "I'll inspect the repository next.",
  });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const team = await teams.createTeam({ sessionId, name: "incomplete", leadPath });
    await teams.addMember({
      sessionId,
      teamId: team.id,
      path: workerPath,
      name: "reviewer",
      role: "reviewer",
    });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Inspect architecture",
      ownerPath: workerPath,
    });

    const dispatched = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "background",
      sessionId,
      cwd: dir,
    });
    expect(dispatched).toMatchObject({
      status: "running",
      teamTask: { status: "in_progress" },
    });

    await runner.started;
    runner.complete();
    await subagents.waitForBackgroundTasks();
    const synced = await dispatcher.syncTask({ teamId: team.id, taskId: task.id, sessionId });

    expect(synced).toMatchObject({
      applied: true,
      teamTask: {
        status: "blocked",
        summary: "I'll inspect the repository next.",
        error: expect.stringContaining("subagent_incomplete"),
        metadata: {
          chiliTeamDispatch: {
            agentStatus: "incomplete",
            syncedAt: 210,
          },
        },
      },
      agentTask: {
        status: "incomplete",
        summary: "I'll inspect the repository next.",
      },
    });
    expect(await store.teamMembers({ teamId: team.id, path: workerPath })).toMatchObject([{ status: "idle" }]);
    const duplicate = await dispatcher.syncTask({ teamId: team.id, taskId: task.id, sessionId });
    expect(duplicate).toMatchObject({
      applied: false,
      reason: "team_not_in_progress",
      teamTask: { status: "blocked" },
    });
    const blockedUpdates = (await store.events({ type: "team.task_updated" })).filter(
      (event) => {
        const payload = event.payload as { taskId?: TaskId; status?: string };
        return event.type === "team.task_updated" && payload.taskId === task.id && payload.status === "blocked";
      },
    );
    expect(blockedUpdates).toHaveLength(1);
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
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "should not run" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const team = await teams.createTeam({ sessionId, name: "skips", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const unownedTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Missing owner",
    });

    const dispatchSkipped = await dispatcher.dispatchTask({ teamId: team.id, taskId: unownedTask.id, sessionId });
    expect(dispatchSkipped).toMatchObject({
      status: "skipped",
      reason: "missing_owner",
      teamTask: { id: unownedTask.id, status: "pending" },
    });
    expect(runner.runs).toEqual([]);

    const syncSkipped = await dispatcher.syncTask({ teamId: team.id, taskId: unownedTask.id, sessionId });
    expect(syncSkipped).toMatchObject({
      applied: false,
      reason: "not_dispatched",
      teamTask: { id: unownedTask.id, status: "pending" },
    });

    const missingAgentTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Missing agent task",
      ownerPath: workerPath,
      status: "in_progress",
      metadata: {
        chiliTeamDispatch: {
          agentTaskId: "task_missing_agent" as TaskId,
          agentPath: workerPath,
          runId: "agentrun_missing_agent" as AgentRunId,
          generation: 2,
          childSessionId: "session_missing_agent" as SessionId,
          mode: "background",
          dispatchedAt: 100,
          agentStatus: "running",
        },
      },
    });

    const reconciled = await dispatcher.reconcileTasks({ teamId: team.id, sessionId });
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

test("gates dispatch by dependencies, member scopes, and write conflicts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-policy-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 240 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const reviewerPath = "/root/reviewer" as AgentPath;
  const sessionId = "session_team_policy" as SessionId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "policy ok" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const team = await teams.createTeam({ sessionId, name: "policy", leadPath });
    await teams.addMember({
      sessionId,
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      toolScope: ["read", "edit"],
      writeScope: ["packages/core"],
    });
    await teams.addMember({
      sessionId,
      teamId: team.id,
      path: reviewerPath,
      name: "reviewer",
      role: "reviewer",
      writeScope: ["packages/core"],
    });

    const blockedByDependency = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Needs setup",
      ownerPath: workerPath,
      dependsOn: ["task_missing_dependency" as TaskId],
    });
    const dependencyResult = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: blockedByDependency.id,
      sessionId,
      cwd: dir,
    });
    expect(dependencyResult).toMatchObject({
      status: "skipped",
      reason: "blocked",
      teamTask: { id: blockedByDependency.id, status: "pending" },
    });

    const missingMemberTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Missing member",
      ownerPath: "/root/missing" as AgentPath,
    });
    const missingMember = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: missingMemberTask.id,
      sessionId,
      cwd: dir,
    });
    expect(missingMember).toMatchObject({
      status: "skipped",
      reason: "missing_member",
      teamTask: {
        id: missingMemberTask.id,
        status: "blocked",
        error: "missing_member",
        metadata: { chiliTeamDispatch: { policy: { allowed: false, reason: "missing_member" } } },
      },
    });

    const scopeMismatchTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Outside scope",
      ownerPath: workerPath,
      metadata: { writeScope: ["packages/server"], requiredTools: ["bash"] },
    });
    const scopeMismatch = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: scopeMismatchTask.id,
      sessionId,
      cwd: dir,
    });
    expect(scopeMismatch).toMatchObject({
      status: "skipped",
      reason: "scope_mismatch",
      teamTask: {
        id: scopeMismatchTask.id,
        status: "blocked",
        error: "scope_mismatch",
        metadata: {
          writeScope: ["packages/server"],
          requiredTools: ["bash"],
          chiliTeamDispatch: {
            policy: {
              allowed: false,
              reason: "scope_mismatch",
              writeScope: ["packages/server"],
              requiredTools: ["bash"],
              memberWriteScope: ["packages/core"],
              memberToolScope: ["read", "edit"],
              checkedAt: 240,
            },
          },
        },
      },
    });

    const scopedWriteTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Scoped writer",
      ownerPath: workerPath,
      metadata: { writeScope: ["packages/core/src"], requiredTools: ["edit"] },
    });
    const scopedWrite = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: scopedWriteTask.id,
      mode: "one_shot",
      sessionId,
      cwd: dir,
    });
    expect(scopedWrite).toMatchObject({
      status: "completed",
      teamTask: {
        id: scopedWriteTask.id,
        status: "completed",
        metadata: {
          chiliTeamDispatch: {
            policy: {
              allowed: true,
              writeScope: ["packages/core/src"],
              requiredTools: ["edit"],
              allowedTools: expect.arrayContaining(["read", "edit", "complete_task", "team_task_update"]),
              checkedAt: 240,
            },
          },
        },
      },
    });
    expect(scopedWrite.agentTask?.workerPolicy).toMatchObject({
      teamId: team.id,
      taskId: scopedWriteTask.id,
      memberPath: workerPath,
      writeScope: ["packages/core/src"],
      allowedTools: expect.arrayContaining(["read", "edit", "complete_task", "team_task_update"]),
    });

    const existingWriter = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Existing writer",
      ownerPath: reviewerPath,
      status: "in_progress",
      metadata: {
        writeScope: ["packages/core"],
        chiliTeamDispatch: {
          agentTaskId: "task_existing_writer" as TaskId,
          agentPath: reviewerPath,
          runId: "agentrun_existing_writer" as AgentRunId,
          childSessionId: "session_existing_writer" as SessionId,
          mode: "background",
          dispatchedAt: 200,
          agentStatus: "running",
        },
      },
    });
    const conflictTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Overlapping writer",
      ownerPath: workerPath,
      metadata: { writeScope: ["packages/core/src"], requiredTools: ["edit"] },
    });
    const conflictDispatch = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: conflictTask.id,
      mode: "one_shot",
      sessionId,
      cwd: dir,
    });
    expect(conflictDispatch).toMatchObject({
      status: "skipped",
      reason: "write_conflict",
      teamTask: {
        id: conflictTask.id,
        status: "blocked",
        error: "write_conflict",
        metadata: {
          writeScope: ["packages/core/src"],
          requiredTools: ["edit"],
          chiliTeamDispatch: {
            policy: {
              allowed: false,
              reason: "write_conflict",
              writeScope: ["packages/core/src"],
              requiredTools: ["edit"],
              conflicts: [{ taskId: existingWriter.id, ownerPath: reviewerPath, writeScope: ["packages/core"] }],
              checkedAt: 240,
            },
          },
        },
      },
    });

    expect(runner.runs).toHaveLength(1);
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
  const runner = new DeferredLocalSubagentRunner({ status: "completed", summary: "Reconciled result" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const team = await teams.createTeam({ sessionId, name: "reconcile", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "reconciler", role: "worker" });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Background task",
      ownerPath: workerPath,
    });
    const plainTask = await teams.createTask({
      sessionId,
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
      cwd: dir,
    });
    await runner.started;

    const beforeComplete = await dispatcher.reconcileTasks({ teamId: team.id, sessionId });
    expect(beforeComplete).toMatchObject({
      scanned: 1,
      synced: [],
      skipped: [{ applied: false, reason: "agent_running", teamTask: { id: task.id } }],
      errors: [],
    });

    runner.complete();
    await subagents.waitForBackgroundTasks();
    const afterComplete = await dispatcher.reconcileTasks({ teamId: team.id, sessionId });

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

test("skips dispatch for dependency-blocked team tasks without spawning a subagent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-dependency-blocked-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 325 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_dependency_blocked" as SessionId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "should not run" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const team = await teams.createTeam({ sessionId, name: "dependency-blocked", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const setup = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Prepare shared context",
      ownerPath: workerPath,
    });
    const blocked = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Implement after setup",
      ownerPath: workerPath,
      dependsOn: [setup.id],
    });

    const result = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: blocked.id,
      mode: "one_shot",
      sessionId,
      cwd: dir,
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "blocked",
      teamTask: {
        id: blocked.id,
        status: "pending",
        dependsOn: [setup.id],
      },
    });
    expect(runner.runs).toEqual([]);
    expect(await store.agentTasks({ limit: 10 })).toEqual([]);
    expect(await store.events({ type: "team.task_claimed", limit: 10 })).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("blocks dispatch when member writeScope or toolScope cannot satisfy task metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-scope-blocked-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 350 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_scope_blocked" as SessionId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "should not run" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const team = await teams.createTeam({ sessionId, name: "scope-blocked", leadPath });
    await teams.addMember({
      sessionId,
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      toolScope: ["read", "git_diff"],
      writeScope: ["packages/core"],
    });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Edit store with shell",
      ownerPath: workerPath,
      metadata: {
        writeScope: ["packages/store"],
        requiredTools: ["read", "shell"],
      },
    });

    const result = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "one_shot",
      sessionId,
      cwd: dir,
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "scope_mismatch",
      teamTask: {
        id: task.id,
        status: "blocked",
        error: "scope_mismatch",
        metadata: {
          writeScope: ["packages/store"],
          requiredTools: ["read", "shell"],
          chiliTeamDispatch: {
            policy: {
              allowed: false,
              reason: "scope_mismatch",
              writeScope: ["packages/store"],
              requiredTools: ["read", "shell"],
              memberWriteScope: ["packages/core"],
              memberToolScope: ["read", "git_diff"],
              checkedAt: 350,
            },
          },
        },
      },
    });
    expect(runner.runs).toEqual([]);
    expect(await store.events({ type: "team.task_claimed", limit: 10 })).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("blocks dispatch when required write or execute tools lack explicit scopes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-required-scope-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 355 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_required_scope" as SessionId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "should not run" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const team = await teams.createTeam({ sessionId, name: "required-scope", leadPath });
    await teams.addMember({
      sessionId,
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      toolScope: ["read", "edit", "bash"],
      writeScope: ["packages/core"],
    });

    const editTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Edit without write scope",
      ownerPath: workerPath,
      metadata: { requiredTools: ["edit"] },
    });
    const editDispatch = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: editTask.id,
      mode: "one_shot",
      sessionId,
      cwd: dir,
    });
    expect(editDispatch).toMatchObject({
      status: "skipped",
      reason: "scope_mismatch",
      teamTask: {
        id: editTask.id,
        status: "blocked",
        error: "scope_mismatch",
        metadata: { chiliTeamDispatch: { policy: { allowed: false, requiredTools: ["edit"] } } },
      },
    });

    const bashTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Shell without execute scope",
      ownerPath: workerPath,
      metadata: { requiredTools: ["bash"] },
    });
    const bashDispatch = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: bashTask.id,
      mode: "one_shot",
      sessionId,
      cwd: dir,
    });
    expect(bashDispatch).toMatchObject({
      status: "skipped",
      reason: "scope_mismatch",
      teamTask: {
        id: bashTask.id,
        status: "blocked",
        error: "scope_mismatch",
        metadata: { chiliTeamDispatch: { policy: { allowed: false, requiredTools: ["bash"] } } },
      },
    });

    expect(runner.runs).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("skips unavailable members without permanently blocking the task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-member-unavailable-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 360 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_member_unavailable" as SessionId;
  const runner = new DeferredLocalSubagentRunner({ status: "completed", summary: "busy task done" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const team = await teams.createTeam({ sessionId, name: "member-unavailable", leadPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const runningTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Already running",
      ownerPath: workerPath,
    });
    const waitingTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Wait for worker",
      ownerPath: workerPath,
    });

    const runningDispatch = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: runningTask.id,
      mode: "background",
      sessionId,
      cwd: dir,
    });
    expect(runningDispatch.status).toBe("running");
    await runner.started;

    const waitingDispatch = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: waitingTask.id,
      mode: "one_shot",
      sessionId,
      cwd: dir,
    });
    expect(waitingDispatch).toMatchObject({
      status: "skipped",
      reason: "member_unavailable",
      teamTask: {
        id: waitingTask.id,
        status: "pending",
        metadata: {
          chiliTeamDispatch: {
            policy: {
              allowed: false,
              reason: "member_unavailable",
              checkedAt: 360,
            },
          },
        },
      },
    });
    expect(runner.runs).toHaveLength(1);
    expect(await store.events({ type: "team.task_claimed", limit: 10 })).toHaveLength(1);

    runner.complete();
    await subagents.waitForBackgroundTasks();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("blocks dispatch for overlapping running write scopes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-conflicts-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 375 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const busyPath = "/root/busy" as AgentPath;
  const sessionId = "session_team_conflicts" as SessionId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "Implemented with conflict noted" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const team = await teams.createTeam({ sessionId, name: "conflicts", leadPath });
    await teams.addMember({
      sessionId,
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      writeScope: ["packages/core"],
    });
    await teams.addMember({ sessionId, teamId: team.id, path: busyPath, name: "busy", role: "implementer" });
    const busyTask = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Touch core broadly",
      ownerPath: busyPath,
      status: "in_progress",
      metadata: { writeScope: ["packages/core"] },
    });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Touch a nested core file",
      ownerPath: workerPath,
      metadata: { writeScope: ["packages/core/src"] },
    });

    const result = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "one_shot",
      sessionId,
      cwd: dir,
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "write_conflict",
      teamTask: {
        id: task.id,
        status: "blocked",
        error: "write_conflict",
        metadata: {
          writeScope: ["packages/core/src"],
          chiliTeamDispatch: {
            policy: {
              allowed: false,
              reason: "write_conflict",
              writeScope: ["packages/core/src"],
              memberWriteScope: ["packages/core"],
              checkedAt: 375,
              conflicts: [
                {
                  taskId: busyTask.id,
                  ownerPath: busyPath,
                  writeScope: ["packages/core"],
                },
              ],
            },
          },
        },
      },
    });
    expect(runner.runs).toHaveLength(0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile recreates a marker-only dispatch with the same reserved task identity after lease loss", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-marker-recovery-"));
  const dbPath = join(dir, "events.sqlite");
  let store = new SqliteEventStore(dbPath);
  const ids = createSequentialId();
  const sessionId = "session_team_marker_recovery" as SessionId;
  const workerPath = "/root/worker" as AgentPath;
  const lostOperations = new FakeSessionOperationCoordinator();

  try {
    const teams = new TeamControlService({ store, createId: ids });
    const team = await teams.createTeam({ sessionId, name: "marker recovery", leadPath: "/root" as AgentPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({
      sessionId,
      teamId: team.id,
      title: "Recover marker",
      description: "Create the child only after restart",
      ownerPath: workerPath,
      metadata: {
        writeScope: ["packages/core"],
        // A verifier retry can retain fields from the previous binding. The
        // newly claimed prepared intent must replace them atomically.
        chiliTeamDispatch: { generation: 41, agentStatus: "completed" },
      },
    });
    const crashingDispatcher = new TeamTaskDispatchService({
      teams,
      store,
      cwd: dir,
      createId: ids,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: lostOperations,
      worktrees: {
        async ensureTaskWorktree() {
          lostOperations.invalidate(sessionId);
          throw new RuntimeBusyError(sessionId);
        },
      },
      subagents: {
        async spawnTask() {
          throw new Error("spawn must not run before the claimed worktree is recovered");
        },
      },
    });

    await expect(crashingDispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "one_shot",
      sessionId,
    })).rejects.toBeInstanceOf(RuntimeBusyError);

    const markerTask = (await teams.tasks(team.id))[0];
    expect(markerTask).toMatchObject({
      id: task.id,
      status: "in_progress",
      metadata: {
        chiliTeamDispatch: {
          state: "prepared",
          ownerPath: workerPath,
          mode: "one_shot",
          worktreeRequired: true,
          taskName: "Recover marker",
          prompt: expect.stringContaining("Create the child only after restart"),
        },
      },
    });
    const marker = markerTask?.metadata?.chiliTeamDispatch as Record<string, unknown>;
    expect(await store.agentTasks({ limit: 10 })).toEqual([]);
    const claimEvent = (await store.events({ type: "team.task_claimed" }))[0];
    expect(claimEvent?.payload).toMatchObject({
      taskId: task.id,
      metadata: { chiliTeamDispatch: { dispatchId: marker.dispatchId, agentTaskId: marker.agentTaskId } },
    });

    const replayStore = new SqliteEventStore(join(dir, "replayed-events.sqlite"));
    try {
      await replayStore.appendMany((await store.events({ limit: 100 })) as ChiliEvent[]);
      expect((await replayStore.teamTasks({ teamId: team.id }))[0]?.metadata).toMatchObject({
        chiliTeamDispatch: {
          state: "prepared",
          dispatchId: marker.dispatchId,
          agentTaskId: marker.agentTaskId,
        },
      });
    } finally {
      replayStore.close();
    }

    store.close();
    store = new SqliteEventStore(dbPath);
    const recoveredTeams = new TeamControlService({ store, createId: ids });
    const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "recovered marker" });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids });
    let recoveredWorktreeEnsures = 0;
    const recoveringDispatcher = new TeamTaskDispatchService({
      teams: recoveredTeams,
      subagents,
      store,
      cwd: dir,
      createId: ids,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
      worktrees: {
        async ensureTaskWorktree(input) {
          recoveredWorktreeEnsures++;
          const current = (await recoveredTeams.tasks(input.teamId)).find((item) => item.id === input.taskId);
          if (!current) throw new Error("missing recovered worktree task");
          const path = marker.taskCwd as string;
          const updated = await recoveredTeams.updateTask({
            teamId: input.teamId,
            taskId: input.taskId,
            sessionId,
            metadata: {
              ...current.metadata,
              worktree: { path, baseRef: "a".repeat(40), createdAt: 1, status: "active" },
            },
          });
          return { path, baseRef: "a".repeat(40), createdAt: 1, status: "active", created: true, task: updated };
        },
      },
    });

    const reopened = (await recoveredTeams.tasks(team.id))[0];
    expect(reopened?.metadata).toMatchObject({
      chiliTeamDispatch: { dispatchId: marker.dispatchId, agentTaskId: marker.agentTaskId, state: "prepared" },
    });
    const reconciled = await recoveringDispatcher.reconcileTasks({ teamId: team.id, sessionId });
    expect(reconciled).toMatchObject({ scanned: 1, errors: [], synced: [{ applied: true }] });
    expect(recoveredWorktreeEnsures).toBe(1);
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]).toMatchObject({
      taskId: marker.agentTaskId,
      runId: marker.runId,
      childSessionId: marker.childSessionId,
      prompt: marker.prompt,
    });
    expect((await recoveredTeams.tasks(team.id))[0]).toMatchObject({
      status: "completed",
      summary: "recovered marker",
      metadata: {
        chiliTeamDispatch: {
          state: "bound",
          dispatchId: marker.dispatchId,
          agentTaskId: marker.agentTaskId,
          runId: marker.runId,
          childSessionId: marker.childSessionId,
        },
      },
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile restores binding without spawning again after the child was durably created", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-binding-recovery-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const sessionId = "session_team_binding_recovery" as SessionId;
  const workerPath = "/root/worker" as AgentPath;
  const lostOperations = new FakeSessionOperationCoordinator();
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "child survived" });

  try {
    const teams = new TeamControlService({ store, createId: ids });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids });
    const team = await teams.createTeam({ sessionId, name: "binding recovery", leadPath: "/root" as AgentPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Recover binding", ownerPath: workerPath });
    const crashingDispatcher = new TeamTaskDispatchService({
      teams,
      store,
      cwd: dir,
      createId: ids,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: lostOperations,
      subagents: {
        async spawnTask(input) {
          const result = await subagents.spawnTask(input);
          lostOperations.invalidate(sessionId);
          return result;
        },
      },
    });

    await expect(crashingDispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "one_shot",
      sessionId,
    })).rejects.toBeInstanceOf(RuntimeBusyError);
    expect(runner.runs).toHaveLength(1);
    expect(await store.events({ type: "agent.task_created" })).toHaveLength(1);
    const stranded = (await teams.tasks(team.id))[0];
    const marker = stranded?.metadata?.chiliTeamDispatch as Record<string, unknown>;
    expect(stranded).toMatchObject({ status: "in_progress", metadata: { chiliTeamDispatch: { state: "prepared" } } });

    let retrySpawnCalls = 0;
    const recoveringDispatcher = new TeamTaskDispatchService({
      teams,
      store,
      cwd: dir,
      createId: ids,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
      subagents: {
        async spawnTask(input) {
          retrySpawnCalls++;
          return subagents.spawnTask(input);
        },
      },
    });
    const reconciled = await recoveringDispatcher.reconcileTasks({ teamId: team.id, sessionId });

    expect(reconciled).toMatchObject({ scanned: 1, errors: [], synced: [{ applied: true }] });
    expect(retrySpawnCalls).toBe(0);
    expect(runner.runs).toHaveLength(1);
    expect(await store.events({ type: "agent.task_created" })).toHaveLength(1);
    expect((await teams.tasks(team.id))[0]).toMatchObject({
      status: "completed",
      summary: "child survived",
      metadata: {
        chiliTeamDispatch: {
          state: "bound",
          dispatchId: marker.dispatchId,
          agentTaskId: marker.agentTaskId,
          runId: marker.runId,
        },
      },
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile drives a reserved pending child after task creation committed but spawn threw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-commit-throw-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const sessionId = "session_team_commit_throw" as SessionId;
  const workerPath = "/root/worker" as AgentPath;
  const originalAppend = store.append.bind(store);
  let throwAfterCreation = true;

  try {
    const teams = new TeamControlService({ store, createId: ids });
    const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "recovered pending child" });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids });
    const team = await teams.createTeam({ sessionId, name: "commit throw", leadPath: "/root" as AgentPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Recover pending child", ownerPath: workerPath });

    store.append = async (event, options) => {
      await originalAppend(event, options);
      if (throwAfterCreation && event.type === "agent.task_created") {
        throwAfterCreation = false;
        throw new Error("mirror failed after durable creation");
      }
    };
    const crashingDispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      createId: ids,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const stranded = await crashingDispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "one_shot",
      sessionId,
      cwd: dir,
    });
    expect(stranded).toMatchObject({
      status: "running",
      teamTask: { status: "in_progress", metadata: { chiliTeamDispatch: { state: "prepared" } } },
      agentTask: { status: "pending" },
    });
    expect(runner.runs).toHaveLength(0);
    expect(await store.events({ type: "agent.task_created" })).toHaveLength(1);
    expect(await store.events({ type: "agent.spawned" })).toHaveLength(0);

    store.append = originalAppend;
    const recoveringDispatcher = new TeamTaskDispatchService({
      teams,
      subagents: new LocalSubagentManager({ store, runner, createId: ids }),
      store,
      cwd: dir,
      createId: ids,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });
    const reconciled = await recoveringDispatcher.reconcileTasks({ teamId: team.id, sessionId });

    expect(reconciled).toMatchObject({ scanned: 1, errors: [], synced: [{ applied: true }] });
    expect(runner.runs).toHaveLength(1);
    expect(await store.events({ type: "agent.task_created" })).toHaveLength(1);
    expect(await store.events({ type: "agent.spawned" })).toHaveLength(1);
    expect((await teams.tasks(team.id))[0]).toMatchObject({
      status: "completed",
      summary: "recovered pending child",
      metadata: { chiliTeamDispatch: { state: "bound", agentStatus: "completed" } },
    });
  } finally {
    store.append = originalAppend;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an abort after a queued reserved spawn closes generation one and atomically syncs prepared team state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-queued-abort-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const sessionId = "session_team_queued_abort" as SessionId;
  const workerPath = "/root/worker" as AgentPath;
  const request = new AbortController();
  const runner = new RollingDeferredLocalSubagentRunner();
  const subagents = new LocalSubagentManager({ store, runner, createId: ids, maxActiveRuns: 1 });

  try {
    await subagents.spawnTask({
      parentSessionId: "session_unrelated_blocker" as SessionId,
      parentPath: "/unrelated" as AgentPath,
      cwd: dir,
      taskName: "block queue",
      prompt: "wait",
      mode: "background",
    });
    await waitUntil(() => runner.activeRunCount === 1);

    const teams = new TeamControlService({ store, createId: ids });
    const team = await teams.createTeam({ sessionId, name: "queued abort", leadPath: "/root" as AgentPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Abort while queued", ownerPath: workerPath });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      store,
      cwd: dir,
      createId: ids,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
      subagents: {
        async spawnTask(input) {
          const result = await subagents.spawnTask(input);
          request.abort();
          return result;
        },
      },
    });

    const result = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "background",
      sessionId,
      cwd: dir,
      signal: request.signal,
    });
    const agentTaskId = result.agentTask?.taskId;
    if (!agentTaskId) throw new Error("expected queued durable child");

    expect(result).toMatchObject({
      status: "cancelled",
      teamTask: {
        status: "cancelled",
        metadata: { chiliTeamDispatch: { state: "bound", generation: 1, agentStatus: "cancelled" } },
      },
      agentTask: { status: "cancelled" },
    });
    const closedAgentTask = await store.agentTask(agentTaskId);
    expect(closedAgentTask).toMatchObject({
      status: "cancelled",
      generation: 1,
    });
    expect(closedAgentTask?.currentRunId).toBeUndefined();
    expect((await store.events({ type: "agent.spawned" })).filter(
      (event) => (event.payload as { taskId?: TaskId }).taskId === agentTaskId,
    )).toHaveLength(0);
    expect(runner.runs).toHaveLength(1);
  } finally {
    runner.completeAll();
    await subagents.waitForBackgroundTasks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile observes a live bound lease, then closes its expired generation without rerunning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-expired-bound-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  let clock = 100;
  const now = () => clock as TimestampMs;
  const sessionId = "session_team_expired_bound" as SessionId;
  const workerPath = "/root/worker" as AgentPath;
  const runner = new DeferredLocalSubagentRunner({ status: "completed", summary: "must lose stale completion" });
  const subagents = new LocalSubagentManager({
    store,
    runner,
    createId: ids,
    now,
    leaseTtlMs: 50,
    leaseHeartbeatIntervalMs: 60_000,
  });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const team = await teams.createTeam({ sessionId, name: "expired bound", leadPath: "/root" as AgentPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Expire child", ownerPath: workerPath });
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      createId: ids,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });
    const dispatched = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "background",
      sessionId,
      cwd: dir,
    });
    await runner.started;
    expect(dispatched.teamTask).toMatchObject({
      status: "in_progress",
      metadata: { chiliTeamDispatch: { state: "bound", generation: 1, agentStatus: "running" } },
    });

    let retrySpawnCalls = 0;
    const recoveringDispatcher = new TeamTaskDispatchService({
      teams,
      store,
      cwd: dir,
      createId: ids,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
      subagents: {
        async spawnTask() {
          retrySpawnCalls++;
          throw new Error("bound running tasks must never be respawned");
        },
      },
    });
    const active = await recoveringDispatcher.reconcileTasks({ teamId: team.id, sessionId });
    expect(active).toMatchObject({ scanned: 1, errors: [], synced: [], skipped: [{ applied: false, reason: "agent_running" }] });
    expect(retrySpawnCalls).toBe(0);

    clock = 1_000;
    const expired = await recoveringDispatcher.reconcileTasks({ teamId: team.id, sessionId });
    expect(expired).toMatchObject({ scanned: 1, errors: [], synced: [{ applied: true }] });
    expect(retrySpawnCalls).toBe(0);
    expect(runner.runs).toHaveLength(1);
    expect(await store.agentTask(dispatched.agentTask!.taskId)).toMatchObject({
      status: "incomplete",
      generation: 2,
      error: "team_dispatch_worker_lease_expired",
    });
    expect((await teams.tasks(team.id))[0]).toMatchObject({
      status: "blocked",
      metadata: { chiliTeamDispatch: { state: "bound", generation: 2, agentStatus: "incomplete" } },
    });
    expect(await store.events({ type: "agent.task_created" })).toHaveLength(1);
    expect(await store.events({ type: "agent.spawned" })).toHaveLength(1);
  } finally {
    runner.complete();
    await subagents.waitForBackgroundTasks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminal synchronization loses atomically when a follow-up run reopens the child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-terminal-reopen-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const sessionId = "session_team_terminal_reopen" as SessionId;
  const workerPath = "/root/worker" as AgentPath;
  const followupRunId = "agent_terminal_followup" as AgentRunId;
  const originalSync = store.syncTeamTaskFromAgentCas.bind(store);
  let reopened = false;

  try {
    const teams = new TeamControlService({ store, createId: ids });
    const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "first run terminal" });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids });
    const team = await teams.createTeam({ sessionId, name: "terminal reopen", leadPath: "/root" as AgentPath });
    await teams.addMember({ sessionId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const task = await teams.createTask({ sessionId, teamId: team.id, title: "Race terminal sync", ownerPath: workerPath });

    store.syncTeamTaskFromAgentCas = async (input) => {
      if (!reopened) {
        reopened = true;
        const agentTask = await store.agentTask(input.agentTaskId);
        if (!agentTask) throw new Error("missing terminal child before follow-up reopen");
        await store.append({
          id: ids("event"),
          type: "agent.spawned",
          time: 500 as TimestampMs,
          sessionId,
          payload: {
            runId: followupRunId,
            taskId: agentTask.id,
            path: agentTask.path,
            ...(agentTask.parentPath ? { parentPath: agentTask.parentPath } : {}),
            ...(agentTask.parentSessionId ? { parentSessionId: agentTask.parentSessionId } : {}),
            ...(agentTask.childSessionId ? { childSessionId: agentTask.childSessionId } : {}),
            taskName: agentTask.taskName,
            generation: input.agentGeneration + 1,
          },
        });
      }
      return originalSync(input);
    };
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      createId: ids,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

    const result = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: task.id,
      mode: "one_shot",
      sessionId,
      cwd: dir,
    });

    expect(result).toMatchObject({
      status: "running",
      teamTask: { status: "in_progress", metadata: { chiliTeamDispatch: { state: "prepared" } } },
      agentTask: { status: "completed", summary: "first run terminal" },
    });
    expect(await store.agentTask(result.agentTask!.taskId)).toMatchObject({
      status: "running",
      generation: 2,
      currentRunId: followupRunId,
    });
    expect((await store.events({ type: "team.task_updated" })).filter((event) => {
      const payload = event.payload as { taskId?: TaskId; status?: string };
      return payload.taskId === task.id && payload.status === "completed";
    })).toHaveLength(0);
  } finally {
    store.syncTeamTaskFromAgentCas = originalSync;
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
    const dispatcher = new TeamTaskDispatchService({
      teams,
      subagents,
      store,
      cwd: dir,
      now,
      resolveSession: () => ({ cwd: dir }),
      sessionOperations: TEST_SESSION_OPERATIONS,
    });

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

interface FakeSessionOperationState {
  sessionId: SessionId;
  controller: AbortController;
  valid: boolean;
  operation: RuntimeSessionOperation;
}

interface FakeSessionOperationGate {
  entered: Promise<void>;
  release(): void;
}

class FakeSessionOperationCoordinator implements SessionOperationCoordinator {
  topLevelCalls = 0;
  nestedCalls = 0;
  readonly topLevelSessionIds: SessionId[] = [];
  private readonly storage = new AsyncLocalStorage<FakeSessionOperationState>();
  private readonly active = new Map<SessionId, FakeSessionOperationState>();
  private nextGate: (FakeSessionOperationGate & { markEntered(): void; wait(): Promise<void> }) | undefined;

  pauseNextOperation(): FakeSessionOperationGate {
    let markEntered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = {
      entered,
      markEntered: () => markEntered?.(),
      release: () => release?.(),
      wait: () => released,
    };
    this.nextGate = gate;
    return gate;
  }

  invalidate(sessionId: SessionId): void {
    const state = this.active.get(sessionId);
    if (!state || !state.valid) return;
    state.valid = false;
    state.controller.abort(new RuntimeBusyError(sessionId));
  }

  async withSessionOperation<T>(
    sessionId: SessionId,
    fn: (operation: RuntimeSessionOperation) => Promise<T> | T,
  ): Promise<T> {
    const inherited = this.storage.getStore();
    if (inherited?.sessionId === sessionId) {
      this.nestedCalls++;
      inherited.operation.assertCurrent();
      const result = await fn(inherited.operation);
      inherited.operation.assertCurrent();
      return result;
    }
    if (this.active.has(sessionId)) throw new RuntimeBusyError(sessionId);

    const controller = new AbortController();
    let state: FakeSessionOperationState;
    state = {
      sessionId,
      controller,
      valid: true,
      operation: {
        signal: controller.signal,
        assertCurrent: () => {
          if (!state.valid || this.active.get(sessionId) !== state) {
            throw new RuntimeBusyError(sessionId);
          }
        },
      },
    };
    this.topLevelCalls++;
    this.topLevelSessionIds.push(sessionId);
    this.active.set(sessionId, state);
    const gate = this.nextGate;
    this.nextGate = undefined;

    return this.storage.run(state, async () => {
      try {
        gate?.markEntered();
        await gate?.wait();
        state.operation.assertCurrent();
        const result = await fn(state.operation);
        state.operation.assertCurrent();
        return result;
      } finally {
        state.valid = false;
        if (this.active.get(sessionId) === state) this.active.delete(sessionId);
      }
    });
  }
}

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

class RollingDeferredLocalSubagentRunner implements LocalSubagentRunner {
  readonly runs: LocalSubagentRunInput[] = [];
  maxActiveRuns = 0;
  private activeRuns = 0;
  private readonly completions: Array<() => void> = [];

  get activeRunCount(): number {
    return this.activeRuns;
  }

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.runs.push(input);
    this.activeRuns++;
    this.maxActiveRuns = Math.max(this.maxActiveRuns, this.activeRuns);
    await new Promise<void>((resolve) => {
      this.completions.push(resolve);
    });
    this.activeRuns--;
    return { status: "completed", summary: `Done ${input.taskName}` };
  }

  completeNext(): void {
    this.completions.shift()?.();
  }

  completeAll(): void {
    while (this.completions.length > 0) this.completeNext();
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix: string) => `${prefix}_${++next}`;
}
