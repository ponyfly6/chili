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
    expect(dispatched.teamTask.metadata).toMatchObject({
      chiliTeamDispatch: {
        agentTaskId: dispatchedAgentTask.taskId,
        agentPath: dispatchedAgentTask.path,
        runId: dispatchedAgentTask.runId,
        childSessionId: dispatchedAgentTask.childSessionId,
        childThreadId: dispatchedAgentTask.childThreadId,
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
    expect(synced.teamTask.metadata).toMatchObject({
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
        policy: {
          allowed: true,
          allowedTools: expect.arrayContaining(["read", "complete_task", "team_task_update"]),
          checkedAt: 200,
        },
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

test("gates dispatch by dependencies, member scopes, and write conflicts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-policy-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 240 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const reviewerPath = "/root/reviewer" as AgentPath;
  const sessionId = "session_team_policy" as SessionId;
  const threadId = "thread_team_policy" as ThreadId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "policy ok" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });

    const team = await teams.createTeam({ sessionId, threadId, name: "policy", leadPath });
    await teams.addMember({
      sessionId,
      threadId,
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      toolScope: ["read", "edit"],
      writeScope: ["packages/core"],
    });
    await teams.addMember({
      sessionId,
      threadId,
      teamId: team.id,
      path: reviewerPath,
      name: "reviewer",
      role: "reviewer",
      writeScope: ["packages/core"],
    });

    const blockedByDependency = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Needs setup",
      ownerPath: workerPath,
      dependsOn: ["task_missing_dependency" as TaskId],
    });
    const dependencyResult = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: blockedByDependency.id,
      sessionId,
      threadId,
      cwd: dir,
    });
    expect(dependencyResult).toMatchObject({
      status: "skipped",
      reason: "blocked",
      teamTask: { id: blockedByDependency.id, status: "pending" },
    });

    const missingMemberTask = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Missing member",
      ownerPath: "/root/missing" as AgentPath,
    });
    const missingMember = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: missingMemberTask.id,
      sessionId,
      threadId,
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
      threadId,
      teamId: team.id,
      title: "Outside scope",
      ownerPath: workerPath,
      metadata: { writeScope: ["packages/server"], requiredTools: ["bash"] },
    });
    const scopeMismatch = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: scopeMismatchTask.id,
      sessionId,
      threadId,
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
      threadId,
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
      threadId,
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
      threadId,
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
          childThreadId: "thread_existing_writer" as ThreadId,
          mode: "background",
          dispatchedAt: 200,
          agentStatus: "running",
        },
      },
    });
    const conflictTask = await teams.createTask({
      sessionId,
      threadId,
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
      threadId,
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

test("skips dispatch for dependency-blocked team tasks without spawning a subagent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-dispatch-dependency-blocked-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ids = createSequentialId();
  const now = () => 325 as TimestampMs;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_team_dependency_blocked" as SessionId;
  const threadId = "thread_team_dependency_blocked" as ThreadId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "should not run" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });

    const team = await teams.createTeam({ sessionId, threadId, name: "dependency-blocked", leadPath });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const setup = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Prepare shared context",
      ownerPath: workerPath,
    });
    const blocked = await teams.createTask({
      sessionId,
      threadId,
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
      threadId,
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
  const threadId = "thread_team_scope_blocked" as ThreadId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "should not run" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });

    const team = await teams.createTeam({ sessionId, threadId, name: "scope-blocked", leadPath });
    await teams.addMember({
      sessionId,
      threadId,
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      toolScope: ["read", "git_diff"],
      writeScope: ["packages/core"],
    });
    const task = await teams.createTask({
      sessionId,
      threadId,
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
      threadId,
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
  const threadId = "thread_team_required_scope" as ThreadId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "should not run" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });

    const team = await teams.createTeam({ sessionId, threadId, name: "required-scope", leadPath });
    await teams.addMember({
      sessionId,
      threadId,
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      toolScope: ["read", "edit", "bash"],
      writeScope: ["packages/core"],
    });

    const editTask = await teams.createTask({
      sessionId,
      threadId,
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
      threadId,
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
      threadId,
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
      threadId,
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
  const threadId = "thread_team_member_unavailable" as ThreadId;
  const runner = new DeferredLocalSubagentRunner({ status: "completed", summary: "busy task done" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });

    const team = await teams.createTeam({ sessionId, threadId, name: "member-unavailable", leadPath });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const runningTask = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Already running",
      ownerPath: workerPath,
    });
    const waitingTask = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Wait for worker",
      ownerPath: workerPath,
    });

    const runningDispatch = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: runningTask.id,
      mode: "background",
      sessionId,
      threadId,
      cwd: dir,
    });
    expect(runningDispatch.status).toBe("running");
    await runner.started;

    const waitingDispatch = await dispatcher.dispatchTask({
      teamId: team.id,
      taskId: waitingTask.id,
      mode: "one_shot",
      sessionId,
      threadId,
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
  const threadId = "thread_team_conflicts" as ThreadId;
  const runner = new FakeLocalSubagentRunner({ status: "completed", summary: "Implemented with conflict noted" });

  try {
    const teams = new TeamControlService({ store, createId: ids, now });
    const subagents = new LocalSubagentManager({ store, runner, createId: ids, now });
    const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir, now });

    const team = await teams.createTeam({ sessionId, threadId, name: "conflicts", leadPath });
    await teams.addMember({
      sessionId,
      threadId,
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      writeScope: ["packages/core"],
    });
    await teams.addMember({ sessionId, threadId, teamId: team.id, path: busyPath, name: "busy", role: "implementer" });
    const busyTask = await teams.createTask({
      sessionId,
      threadId,
      teamId: team.id,
      title: "Touch core broadly",
      ownerPath: busyPath,
      status: "in_progress",
      metadata: { writeScope: ["packages/core"] },
    });
    const task = await teams.createTask({
      sessionId,
      threadId,
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
      threadId,
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
