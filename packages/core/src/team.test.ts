import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, ChiliEvent, SessionId, TaskId, TeamId, TimestampMs } from "@chili/protocol";
import { SessionRunClaimConflictError, SqliteEventStore } from "@chili/store";
import {
  TeamControlService,
  TeamMemberSessionOwnershipError,
  TeamMemberTargetAmbiguousError,
  TeamMessageConflictError,
  TeamMessageDeliveryError,
  TeamMessageSenderUnauthorizedError,
  TeamTaskAlreadyExistsError,
  TeamTaskWorkerMutationError,
} from "./team.js";

test("creates a persistent team with leader, members, task assignment, claim, and completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-control-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const leadPath = "/root" as AgentPath;
  const reviewerPath = "/root/reviewer" as AgentPath;
  const sessionId = "session_team_control" as SessionId;

  try {
    const service = new TeamControlService({
      store,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });

    const team = await service.createTeam({
      sessionId,
      name: "runtime-core",
      leadPath,
      description: "runtime implementation team",
      leadWriteScope: ["/repo"],
    });
    expect(team).toMatchObject({
      id: "team_1",
      sessionId,
      name: "runtime-core",
      leadPath,
      description: "runtime implementation team",
    });
    expect(await store.teamMembers({ teamId: team.id })).toMatchObject([
      {
        teamId: team.id,
        path: leadPath,
        name: "team-lead",
        role: "leader",
        status: "running",
        writeScope: ["/repo"],
      },
    ]);

    await seedMemberTask(store, {
      taskId: "task_reviewer_agent" as TaskId,
      path: reviewerPath,
      parentPath: leadPath,
      parentSessionId: sessionId,
      childSessionId: "session_reviewer" as SessionId,
      time: 9,
    });
    const reviewer = await service.addMember({
      sessionId,
      teamId: team.id,
      path: reviewerPath,
      name: "reviewer",
      role: "code-reviewer",
      childSessionId: "session_reviewer" as SessionId,
      toolScope: ["read", "git_diff"],
      writeScope: ["packages/core"],
    });
    expect(reviewer).toMatchObject({
      teamId: team.id,
      path: reviewerPath,
      toolScope: ["read", "git_diff"],
      writeScope: ["packages/core"],
    });
    const task = await service.createTask({
      sessionId,
      teamId: team.id,
      title: "Review team control service",
      createdBy: leadPath,
    });
    const assigned = await service.assignTask({
      sessionId,
      teamId: team.id,
      taskId: task.id,
      ownerPath: reviewerPath,
      assignedBy: leadPath,
      message: "Please review the team control service.",
      messageSummary: "review assignment",
    });
    expect(assigned).toMatchObject({
      id: task.id,
      ownerPath: reviewerPath,
      status: "pending",
    });
    expect(await store.teamMessages({ teamId: team.id, path: reviewerPath })).toMatchObject([
      {
        teamId: team.id,
        fromPath: leadPath,
        toPath: reviewerPath,
        kind: "task_assignment",
        delivery: "queueOnly",
        deliveryStatus: "queued",
        taskId: task.id,
        content: "Please review the team control service.",
      },
    ]);
    expect(await store.agentMailbox({ path: reviewerPath, status: "queued" })).toMatchObject([
      {
        path: reviewerPath,
        fromPath: leadPath,
        triggerTurn: false,
        taskId: task.id,
        recipientSessionId: "session_reviewer",
        message: {
          role: "user",
          content: "Please review the team control service.",
          metadata: {
            teamId: team.id,
            teamMessageKind: "task_assignment",
            taskId: task.id,
            summary: "review assignment",
          },
        },
      },
    ]);

    const claimed = await service.claimTask({
      sessionId,
      teamId: team.id,
      taskId: task.id,
      ownerPath: reviewerPath,
      claimedBy: reviewerPath,
    });
    expect(claimed).toMatchObject({
      applied: true,
      task: {
        id: task.id,
        status: "in_progress",
        ownerPath: reviewerPath,
      },
    });
    expect(await store.teamMembers({ teamId: team.id, path: reviewerPath })).toMatchObject([
      {
        status: "running",
        currentTaskId: task.id,
      },
    ]);
    const snapshot = await service.snapshot(team.id);
    const reviewerSnapshot = snapshot.members.find((member) => member.path === reviewerPath);
    expect(snapshot.stats).toMatchObject({
      memberCount: 2,
      taskCount: 1,
      messageCount: 1,
      deliveryCount: 1,
      membersByStatus: { running: 2 },
      tasksByStatus: { in_progress: 1 },
      messagesByDeliveryStatus: { queued: 1 },
      deliveriesByStatus: { queued: 1 },
      readyTaskIds: [],
      blockedTaskIds: [],
    });
    expect(reviewerSnapshot).toMatchObject({
      taskIds: [task.id],
      currentTask: { id: task.id, status: "in_progress" },
    });
    expect(reviewerSnapshot?.deliveryIds).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      id: task.id,
      owner: { path: reviewerPath },
      blockedBy: [],
      blocks: [],
      ready: false,
    });
    expect(snapshot.tasks[0]?.messageIds).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({
      taskId: task.id,
      deliveries: [{ path: reviewerPath, status: "queued" }],
    });

    const completed = await service.updateTask({
      sessionId,
      teamId: team.id,
      taskId: task.id,
      status: "completed",
      summary: "Looks solid",
    });
    expect(completed).toMatchObject({
      id: task.id,
      status: "completed",
      summary: "Looks solid",
      completedAt: 10,
    });
    expect(await store.teamMembers({ teamId: team.id, path: reviewerPath })).toMatchObject([
      {
        status: "idle",
      },
    ]);
    expect((await store.teamMembers({ teamId: team.id, path: reviewerPath }))[0]?.currentTaskId).toBeUndefined();
    expect((await store.events({ limit: 100 })).map((event) => event.type)).toEqual([
      "team.created",
      "team.member_added",
      "agent.task_created",
      "team.member_added",
      "team.task_created",
      "team.task_assigned",
      "team.message_sent",
      "agent.message_queued",
      "team.task_claimed",
      "team.task_updated",
      "team.member_status_changed",
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounds team task persistence while normalizing only diagnostic metadata paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-task-persistence-bounds-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_team_persistence_bounds" as SessionId;
  const leadPath = "/root" as AgentPath;
  const summaryPrefix =
    `Ordinary team summary keeps ${TEAM_HOSTILE_SECRET} and `
    + `http://127.0.0.1:4888/result?token=${TEAM_HOSTILE_SECRET}.\n`;
  const hugeOrdinarySummary = `${summaryPrefix}${teamWorstEscapedText()}`;
  const ordinaryFeedback = `User feedback keeps ${TEAM_HOSTILE_SECRET}`;
  const metadata: Record<string, unknown> = {
    feedback: ordinaryFeedback,
    verification: { status: "failed", feedback: hostileTeamDiagnostic("verification feedback", false) },
    diagnostics: { failureReason: hostileTeamDiagnostic("nested task failure", false) },
    "failure reason": hostileTeamDiagnostic("spaced task failure", false),
    ordinaryBlob: hugeOrdinarySummary,
    items: Array.from({ length: 300 }, (_, index) => ({ index, content: "ordinary" })),
  };
  Object.defineProperty(metadata, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { error: hostileTeamDiagnostic("prototype key failure", false) },
  });
  let deep: Record<string, unknown> = {};
  metadata.deep = deep;
  for (let index = 0; index < 20; index += 1) {
    const next: Record<string, unknown> = {};
    deep.next = next;
    deep = next;
  }
  metadata.circular = metadata;

  try {
    const service = new TeamControlService({
      store,
      createId: createSequentialId(),
      now: () => 20 as TimestampMs,
    });
    const team = await service.createTeam({ sessionId, name: "bounds", leadPath });
    const task = await service.createTask({
      sessionId,
      teamId: team.id,
      title: "Persist hostile result safely",
      createdBy: leadPath,
    });

    const updated = await service.updateTask({
      sessionId,
      teamId: team.id,
      taskId: task.id,
      status: "failed",
      title: hugeOrdinarySummary,
      description: hugeOrdinarySummary,
      summary: hugeOrdinarySummary,
      error: hostileTeamDiagnostic("team task failed", true),
      metadata,
    });

    expect(updated.status).toBe("failed");
    expect(updated.summary?.startsWith(summaryPrefix)).toBe(true);
    expect(updated.summary).not.toContain("[REDACTED]");
    expectTeamSafeDiagnostic(updated.error);
    expect(updated.metadata?.feedback).toBe(ordinaryFeedback);
    expectTeamSafeDiagnostic(
      ((updated.metadata?.verification as Record<string, unknown> | undefined)?.feedback as string | undefined),
    );
    expectTeamSafeDiagnostic(
      ((updated.metadata?.diagnostics as Record<string, unknown> | undefined)?.failureReason as string | undefined),
    );
    expectTeamSafeDiagnostic(updated.metadata?.["failure reason"] as string | undefined);
    expect(Object.prototype.hasOwnProperty.call(updated.metadata, "__proto__")).toBe(true);
    expectTeamSafeDiagnostic(
      ((updated.metadata?.["__proto__"] as Record<string, unknown> | undefined)?.error as string | undefined),
    );
    expect(jsonByteLength(updated.metadata)).toBeLessThanOrEqual(256 * 1024);

    const event = (await store.events({ type: "team.task_updated", limit: 10 })).at(-1) as
      | Extract<ChiliEvent, { type: "team.task_updated" }>
      | undefined;
    expect(event).toBeDefined();
    expect(event!.payload.summary?.startsWith(summaryPrefix)).toBe(true);
    expectTeamSafeDiagnostic(event!.payload.error);
    expect(jsonByteLength(event!.payload)).toBeLessThanOrEqual(512_000);
    expect(jsonByteLength(event)).toBeLessThanOrEqual(576_000);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit team ids are first-write-wins across SQLite connections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-create-race-"));
  const dbPath = join(dir, "events.sqlite");
  const firstStore = new SqliteEventStore(dbPath);
  const secondStore = new SqliteEventStore(dbPath);
  const teamId = "team_explicit_race" as TeamId;
  const first = new TeamControlService({ store: firstStore });
  const second = new TeamControlService({ store: secondStore });

  try {
    const results = await Promise.allSettled([
      first.createTeam({ teamId, name: "first", leadPath: "/root/first" as AgentPath }),
      second.createTeam({ teamId, name: "second", leadPath: "/root/second" as AgentPath }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" ? rejection.reason?.name : undefined).toBe("TeamAlreadyExistsError");
    const [team] = await firstStore.teams({ teamId });
    expect(team).toBeDefined();
    expect(["first", "second"]).toContain(team!.name);
    expect(await firstStore.teamMembers({ teamId })).toHaveLength(1);
    expect(await firstStore.events({ type: "team.created", limit: 10 })).toHaveLength(1);
  } finally {
    secondStore.close();
    firstStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit team task ids are globally first-write-wins across teams", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-task-explicit-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const service = new TeamControlService({ store, now: () => 20 as TimestampMs });
  const firstTeamId = "team_task_explicit_first" as TeamId;
  const secondTeamId = "team_task_explicit_second" as TeamId;
  const taskId = "task_explicit_global" as TaskId;

  try {
    await service.createTeam({ teamId: firstTeamId, name: "first", leadPath: "/root/first" as AgentPath });
    await service.createTeam({ teamId: secondTeamId, name: "second", leadPath: "/root/second" as AgentPath });
    const membersBefore = await store.teamMembers({});
    const original = await service.createTask({
      teamId: firstTeamId,
      taskId,
      title: "keep the first task",
      description: "first description",
      createdBy: "/root/first" as AgentPath,
      status: "completed",
      metadata: { source: "first", attempt: 1 },
    });

    await expect(service.createTask({
      teamId: firstTeamId,
      taskId,
      title: "same-team replacement",
      status: "pending",
      metadata: { source: "same-team duplicate" },
    })).rejects.toBeInstanceOf(TeamTaskAlreadyExistsError);
    await expect(service.createTask({
      teamId: secondTeamId,
      taskId,
      title: "cross-team replacement",
      status: "failed",
      metadata: { source: "cross-team duplicate" },
    })).rejects.toBeInstanceOf(TeamTaskAlreadyExistsError);

    expect(await store.teamTasks({ taskId })).toEqual([original]);
    expect(original).toMatchObject({
      id: taskId,
      teamId: firstTeamId,
      title: "keep the first task",
      description: "first description",
      status: "completed",
      metadata: { source: "first", attempt: 1 },
      completedAt: 20,
    });
    expect(await store.teamMembers({})).toEqual(membersBefore);
    const createdEvents = await store.events({ type: "team.task_created", limit: 10 });
    expect(createdEvents.filter(
      (event) => event.type === "team.task_created"
        && (event.payload as { taskId?: TaskId }).taskId === taskId,
    )).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent team task creation across SQLite connections has one global winner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-task-race-"));
  const dbPath = join(dir, "events.sqlite");
  const firstStore = new SqliteEventStore(dbPath);
  const secondStore = new SqliteEventStore(dbPath);
  const first = new TeamControlService({ store: firstStore, now: () => 30 as TimestampMs });
  const second = new TeamControlService({ store: secondStore, now: () => 40 as TimestampMs });
  const firstTeamId = "team_task_race_first" as TeamId;
  const secondTeamId = "team_task_race_second" as TeamId;
  const taskId = "task_global_race" as TaskId;

  try {
    await first.createTeam({ teamId: firstTeamId, name: "first", leadPath: "/root/first" as AgentPath });
    await second.createTeam({ teamId: secondTeamId, name: "second", leadPath: "/root/second" as AgentPath });
    const membersBefore = await firstStore.teamMembers({});
    const results = await Promise.allSettled([
      first.createTask({
        teamId: firstTeamId,
        taskId,
        title: "first contender",
        status: "completed",
        metadata: { contender: "first" },
      }),
      second.createTask({
        teamId: secondTeamId,
        taskId,
        title: "second contender",
        status: "failed",
        metadata: { contender: "second" },
      }),
    ]);

    const winners = results.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" ? rejection.reason?.name : undefined)
      .toBe("TeamTaskAlreadyExistsError");
    const winner = winners[0]?.status === "fulfilled" ? winners[0].value : undefined;
    expect(winner).toBeDefined();
    expect(await firstStore.teamTasks({ taskId })).toEqual([winner!]);
    expect(winner).toMatchObject(
      winner?.teamId === firstTeamId
        ? {
            teamId: firstTeamId,
            title: "first contender",
            status: "completed",
            metadata: { contender: "first" },
            completedAt: 30,
          }
        : {
            teamId: secondTeamId,
            title: "second contender",
            status: "failed",
            metadata: { contender: "second" },
            completedAt: 40,
          },
    );
    expect(await firstStore.teamMembers({})).toEqual(membersBefore);
    const createdEvents = await firstStore.events({ type: "team.task_created", limit: 10 });
    expect(createdEvents.filter(
      (event) => event.type === "team.task_created"
        && (event.payload as { taskId?: TaskId }).taskId === taskId,
    )).toHaveLength(1);
  } finally {
    secondStore.close();
    firstStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoped workers can report progress without forging runtime task state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-worker-update-policy-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ownerSessionId = "session_team_worker_policy_owner" as SessionId;
  const workerSessionId = "session_team_worker_policy_child" as SessionId;
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const dispatchedAgentPath = "/root/worker/protected-task" as AgentPath;
  const dispatchedAgentTaskId = "task_worker_policy_agent" as TaskId;
  const protectedMetadata = {
    verification: { status: "failed", feedback: "retry" },
    merge: { status: "pending", createdAt: 10 },
    worktree: { path: "/repo/.chili/worktrees/team/task", baseRef: "abc", createdAt: 9, status: "active" },
    chiliTeamDispatch: {
      agentTaskId: dispatchedAgentTaskId,
      agentPath: dispatchedAgentPath,
      childSessionId: workerSessionId,
      runId: "run_1",
      generation: 1,
    },
    writeScope: ["packages/core"],
  };

  try {
    const service = new TeamControlService({
      store,
      createId: createSequentialId(),
      now: () => 20 as TimestampMs,
    });
    const team = await service.createTeam({
      sessionId: ownerSessionId,
      name: "worker-policy",
      leadPath,
    });
    await seedMemberTask(store, {
      taskId: dispatchedAgentTaskId,
      path: dispatchedAgentPath,
      parentPath: workerPath,
      parentSessionId: ownerSessionId,
      childSessionId: workerSessionId,
      time: 10,
    });
    await service.addMember({
      sessionId: ownerSessionId,
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
    });
    const task = await service.createTask({
      sessionId: ownerSessionId,
      teamId: team.id,
      title: "protected task",
      ownerPath: workerPath,
      metadata: protectedMetadata,
    });
    expect(await service.claimTask({
      sessionId: ownerSessionId,
      teamId: team.id,
      taskId: task.id,
      ownerPath: workerPath,
    })).toMatchObject({ applied: true });

    const eventCountBefore = (await store.events({ type: "team.task_updated", limit: 100 })).length;
    await expect(service.updateTask({
      sessionId: "session_team_worker_policy_stranger" as SessionId,
      teamId: team.id,
      taskId: task.id,
      summary: "unauthorized progress",
    })).rejects.toBeInstanceOf(TeamTaskWorkerMutationError);
    expect(await store.events({ type: "team.task_updated", limit: 100 })).toHaveLength(eventCountBefore);

    const maliciousUpdates = [
      { status: "completed" as const },
      { status: "pending" as const },
      { metadata: { verification: { status: "passed" } } },
      { metadata: { merge: { status: "pending" } } },
      { metadata: { worktree: null } },
      { metadata: { chiliTeamDispatch: null } },
      { metadata: { writeScope: ["."] } },
      { ownerPath: leadPath },
      { title: "forged title" },
      { error: "forged error" },
    ];
    for (const update of maliciousUpdates) {
      await expect(service.updateTask({
        sessionId: workerSessionId,
        actorScope: "scoped_worker",
        teamId: team.id,
        taskId: task.id,
        ...update,
      })).rejects.toBeInstanceOf(TeamTaskWorkerMutationError);
    }
    expect(await store.events({ type: "team.task_updated", limit: 100 })).toHaveLength(eventCountBefore);

    const progressed = await service.updateTask({
      sessionId: workerSessionId,
      actorScope: "scoped_worker",
      teamId: team.id,
      taskId: task.id,
      status: "in_progress",
      summary: "Implemented half of the change",
      metadata: { workerProgress: { percent: 50 } },
    });
    expect(progressed).toMatchObject({
      status: "in_progress",
      summary: "Implemented half of the change",
      metadata: {
        ...protectedMetadata,
        workerProgress: { percent: 50 },
      },
    });
    expect(await store.events({ type: "team.task_updated", limit: 100 })).toHaveLength(eventCountBefore + 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("delivers explicit team messages to agent mailbox when requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-control-delivery-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_delivery_root" as SessionId;
  const workerSessionId = "session_worker" as SessionId;

  try {
    const service = new TeamControlService({
      store,
      createId: createSequentialId(),
      now: () => 30 as TimestampMs,
    });

    const team = await service.createTeam({ sessionId, name: "delivery-team", leadPath });
    await seedMemberTask(store, {
      taskId: "task_delivery_worker" as TaskId,
      path: workerPath,
      parentPath: leadPath,
      parentSessionId: sessionId,
      childSessionId: workerSessionId,
      time: 29,
    });
    await service.addMember({
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      childSessionId: workerSessionId,
    });

    const message = await service.sendMessage({
      teamId: team.id,
      from: leadPath,
      to: workerPath,
      content: "Please pick up the next step.",
      delivery: "triggerTurn",
      summary: "wake worker",
      metadata: { priority: "high" },
    });

    expect(message).toMatchObject({
      teamId: team.id,
      fromPath: leadPath,
      toPath: workerPath,
      delivery: "triggerTurn",
      deliveryStatus: "queued",
      content: "Please pick up the next step.",
    });
    expect(await store.agentMailbox({ path: workerPath, status: "queued" })).toMatchObject([
      {
        path: workerPath,
        fromPath: leadPath,
        triggerTurn: true,
        recipientSessionId: "session_worker",
        message: {
          role: "user",
          content: "Please pick up the next step.",
          metadata: {
            teamId: team.id,
            teamMessageKind: "text",
            summary: "wake worker",
            teamMessageMetadata: { priority: "high" },
          },
        },
      },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns dependency-aware claim failures without writing claim events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-control-claim-fail-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;

  try {
    const service = new TeamControlService({
      store,
      createId: createSequentialId(),
      now: () => 20 as TimestampMs,
    });

    const team = await service.createTeam({ name: "blocked-team", leadPath });
    await service.addMember({ teamId: team.id, path: workerPath, name: "worker", role: "implementer" });
    const blocked = await service.createTask({
      teamId: team.id,
      title: "Needs missing dependency",
      dependsOn: ["task_missing" as TaskId],
    });

    const claim = await service.claimTask({
      teamId: team.id,
      taskId: blocked.id,
      ownerPath: workerPath,
    });

    expect(claim).toMatchObject({
      applied: false,
      reason: "blocked",
      task: {
        id: blocked.id,
        status: "pending",
      },
    });
    expect(await store.events({ type: "team.task_claimed", limit: 10 })).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolves team member names and deduplicates complete message delivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-message-idempotency-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const leadPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const sessionId = "session_message_root" as SessionId;
  const workerSessionId = "session_worker" as SessionId;

  try {
    const service = new TeamControlService({ store, now: () => 40 as TimestampMs });
    const team = await service.createTeam({ sessionId, name: "message-team", leadPath, leadName: "lead" });
    await seedMemberTask(store, {
      taskId: "task_message_worker" as TaskId,
      path: workerPath,
      parentPath: leadPath,
      parentSessionId: sessionId,
      childSessionId: workerSessionId,
      time: 39,
    });
    await service.addMember({
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      childSessionId: workerSessionId,
    });
    const input = {
      teamId: team.id,
      messageId: "message_once",
      from: "lead",
      to: "worker",
      content: "Please report status.",
      metadata: { priority: "high" },
    };

    const first = await service.sendMessage(input);
    const retry = await service.sendMessage(input);
    expect(first).toMatchObject({
      id: "message_once",
      fromPath: leadPath,
      toPath: workerPath,
      delivery: "queueOnly",
      deliveryStatus: "queued",
    });
    expect(retry.id).toBe(first.id);
    expect(await store.teamMessages({ messageId: "message_once" })).toHaveLength(1);
    expect(await store.agentMailbox({ path: workerPath })).toHaveLength(1);

    await expect(service.sendMessage({ ...input, content: "different" })).rejects.toBeInstanceOf(
      TeamMessageConflictError,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports ambiguous and closed team message recipients clearly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-message-targets-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const leadPath = "/root" as AgentPath;
  const sessionId = "session_targets_root" as SessionId;

  try {
    const service = new TeamControlService({ store, now: () => 50 as TimestampMs });
    const team = await service.createTeam({ sessionId, name: "target-team", leadPath });
    for (const suffix of ["one", "two"]) {
      await seedMemberTask(store, {
        taskId: `task_target_${suffix}` as TaskId,
        path: `/root/${suffix}` as AgentPath,
        parentPath: leadPath,
        parentSessionId: sessionId,
        childSessionId: `session_${suffix}` as SessionId,
        time: 49,
      });
      await service.addMember({
        teamId: team.id,
        path: `/root/${suffix}` as AgentPath,
        name: "worker",
        role: "implementer",
        childSessionId: `session_${suffix}` as SessionId,
      });
    }
    await expect(service.sendMessage({
      teamId: team.id,
      from: leadPath,
      to: "worker",
      content: "ambiguous",
    })).rejects.toBeInstanceOf(TeamMemberTargetAmbiguousError);

    await store.append({
      id: "event_close_worker",
      type: "team.member_status_changed",
      time: 51 as TimestampMs,
      payload: {
        teamId: team.id,
        path: "/root/one" as AgentPath,
        status: "closed",
        reason: "finished",
      },
    });
    await expect(service.sendMessage({
      teamId: team.id,
      from: leadPath,
      to: "/root/one" as AgentPath,
      content: "wake closed member",
      delivery: "triggerTurn",
    })).rejects.toBeInstanceOf(TeamMessageDeliveryError);

    await expect(service.sendMessage({
      teamId: team.id,
      messageId: "closed_context_only",
      from: leadPath,
      to: "/root/one" as AgentPath,
      content: "Context for a future explicit resume",
      delivery: "queueOnly",
    })).resolves.toMatchObject({ deliveryStatus: "queued" });
    expect(await store.agentMailbox({ path: "/root/one" as AgentPath })).toEqual([
      expect.objectContaining({
        id: `agentmsg:team-message:${team.id}:closed_context_only:/root/one`,
        triggerTurn: false,
        status: "queued",
      }),
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lists team messages in insertion FIFO order when timestamps tie", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-message-fifo-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_fifo_root" as SessionId;
  const workerPath = "/root/worker" as AgentPath;
  const workerSessionId = "session_worker" as SessionId;

  try {
    const service = new TeamControlService({ store, now: () => 60 as TimestampMs });
    const team = await service.createTeam({ sessionId, name: "fifo-team", leadPath: "/root" as AgentPath });
    await seedMemberTask(store, {
      taskId: "task_fifo_worker" as TaskId,
      path: workerPath,
      parentPath: "/root" as AgentPath,
      parentSessionId: sessionId,
      childSessionId: workerSessionId,
      time: 59,
    });
    await service.addMember({
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      childSessionId: workerSessionId,
    });
    await service.sendMessage({ teamId: team.id, messageId: "z_first", from: "/root", to: "worker", content: "first" });
    await service.sendMessage({ teamId: team.id, messageId: "a_second", from: "/root", to: "worker", content: "second" });

    expect((await store.teamMessages({ teamId: team.id })).map((message) => message.id)).toEqual([
      "z_first",
      "a_second",
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("binds team message sender identity to the calling session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-message-sender-auth-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const rootSessionId = "session_root" as SessionId;
  const workerSessionId = "session_worker" as SessionId;
  const peerSessionId = "session_peer" as SessionId;
  const rootPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const peerPath = "/root/peer" as AgentPath;

  try {
    const service = new TeamControlService({ store, now: () => 70 as TimestampMs });
    const team = await service.createTeam({
      sessionId: rootSessionId,
      name: "auth-team",
      leadPath: rootPath,
      leadName: "lead",
    });
    await seedMemberTask(store, {
      taskId: "task_auth_worker" as TaskId,
      path: workerPath,
      parentPath: rootPath,
      parentSessionId: rootSessionId,
      childSessionId: workerSessionId,
      time: 69,
    });
    await seedMemberTask(store, {
      taskId: "task_auth_peer" as TaskId,
      path: peerPath,
      parentPath: rootPath,
      parentSessionId: rootSessionId,
      childSessionId: peerSessionId,
      time: 69,
    });
    await service.addMember({
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      childSessionId: workerSessionId,
    });
    await service.addMember({
      teamId: team.id,
      path: peerPath,
      name: "peer",
      role: "reviewer",
      childSessionId: peerSessionId,
    });
    await expect(service.addMember({
      teamId: team.id,
      path: "/root/colliding" as AgentPath,
      name: "colliding",
      role: "legacy-worker",
      childSessionId: rootSessionId,
    })).rejects.toBeInstanceOf(TeamMemberSessionOwnershipError);

    await expect(service.sendMessage({
      teamId: team.id,
      sessionId: rootSessionId,
      from: "worker",
      to: "peer",
      content: "root impersonation",
    })).rejects.toBeInstanceOf(TeamMessageSenderUnauthorizedError);
    await expect(service.sendMessage({
      teamId: team.id,
      sessionId: workerSessionId,
      from: "lead",
      to: "peer",
      content: "child impersonation",
    })).rejects.toBeInstanceOf(TeamMessageSenderUnauthorizedError);

    await expect(service.sendMessage({
      teamId: team.id,
      sessionId: rootSessionId,
      from: "lead",
      to: "worker",
      content: "authorized lead",
    })).resolves.toMatchObject({ fromPath: rootPath, toPath: workerPath });
    await expect(service.sendMessage({
      teamId: team.id,
      sessionId: workerSessionId,
      from: "worker",
      to: "peer",
      content: "authorized worker",
    })).resolves.toMatchObject({ fromPath: workerPath, toPath: peerPath });

    await expect(service.addMember({
      teamId: team.id,
      path: "/root/duplicate-session" as AgentPath,
      name: "duplicate-session",
      role: "legacy-worker",
      childSessionId: workerSessionId,
    })).rejects.toBeInstanceOf(TeamMemberSessionOwnershipError);
    await expect(service.sendMessage({
      teamId: team.id,
      sessionId: workerSessionId,
      from: "worker",
      to: "peer",
      content: "session remains bound to the original worker",
    })).resolves.toMatchObject({ fromPath: workerPath, toPath: peerPath });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("routes a worker team message back to the owning lead endpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-message-lead-roundtrip-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const rootSessionId = "session_root" as SessionId;
  const workerSessionId = "session_worker" as SessionId;
  const rootPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;

  try {
    const service = new TeamControlService({ store, now: () => 80 as TimestampMs });
    const team = await service.createTeam({
      sessionId: rootSessionId,
      name: "roundtrip-team",
      leadPath: rootPath,
      leadName: "lead",
    });
    await seedMemberTask(store, {
      taskId: "task_roundtrip_worker" as TaskId,
      path: workerPath,
      parentPath: rootPath,
      parentSessionId: rootSessionId,
      childSessionId: workerSessionId,
      time: 79,
    });
    await service.addMember({
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      childSessionId: workerSessionId,
    });

    const message = await service.sendMessage({
      teamId: team.id,
      sessionId: workerSessionId,
      from: "worker",
      to: "lead",
      content: "Work is ready for review.",
      delivery: "triggerTurn",
    });

    expect(message).toMatchObject({ fromPath: workerPath, toPath: rootPath, deliveryStatus: "queued" });
    expect(await store.agentMailbox({ path: rootPath })).toEqual([
      expect.objectContaining({
        fromPath: workerPath,
        recipientSessionId: rootSessionId,
        triggerTurn: true,
      }),
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("team member sessions must have unique descendant task ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-member-session-ownership-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const rootSessionId = "session_owner_root" as SessionId;
  const workerSessionId = "session_owner_worker" as SessionId;
  const nestedSessionId = "session_owner_nested" as SessionId;
  const victimSessionId = "session_other_interactive_root" as SessionId;
  const rootPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;
  const nestedPath = "/root/worker/reader" as AgentPath;
  const victimPath = "/root/victim" as AgentPath;

  try {
    const service = new TeamControlService({ store, now: () => 90 as TimestampMs });
    const team = await service.createTeam({
      sessionId: rootSessionId,
      name: "ownership-team",
      leadPath: rootPath,
      leadName: "lead",
    });
    await store.append({
      id: "event_other_interactive_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId: victimSessionId,
      payload: { sessionId: victimSessionId, cwd: "/other" },
    });
    await seedMemberTask(store, {
      taskId: "task_owner_worker" as TaskId,
      path: workerPath,
      parentPath: rootPath,
      parentSessionId: rootSessionId,
      childSessionId: workerSessionId,
      time: 2,
    });
    await seedMemberTask(store, {
      taskId: "task_owner_nested" as TaskId,
      path: nestedPath,
      parentPath: workerPath,
      parentSessionId: workerSessionId,
      childSessionId: nestedSessionId,
      time: 3,
    });

    await expect(service.addMember({
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      childSessionId: workerSessionId,
    })).resolves.toMatchObject({ path: workerPath, childSessionId: workerSessionId });
    await expect(service.addMember({
      teamId: team.id,
      path: nestedPath,
      name: "reader",
      role: "reviewer",
      childSessionId: nestedSessionId,
    })).resolves.toMatchObject({ path: nestedPath, childSessionId: nestedSessionId });

    await expect(service.addMember({
      teamId: team.id,
      path: victimPath,
      name: "victim",
      role: "worker",
      childSessionId: victimSessionId,
    })).rejects.toBeInstanceOf(TeamMemberSessionOwnershipError);
    await expect(service.addMember({
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      childSessionId: victimSessionId,
    })).rejects.toBeInstanceOf(TeamMemberSessionOwnershipError);
    expect(await store.teamMembers({ teamId: team.id, path: workerPath })).toMatchObject([
      { childSessionId: workerSessionId },
    ]);

    const corruptStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "agentTasks") {
          return async (...args: Parameters<SqliteEventStore["agentTasks"]>) => {
            const tasks = await target.agentTasks(...args);
            if (args[0]?.childSessionId !== nestedSessionId || tasks.length !== 1) return tasks;
            return [...tasks, { ...tasks[0]!, id: "task_duplicate_owner" as TaskId }];
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const corruptService = new TeamControlService({ store: corruptStore, now: () => 91 as TimestampMs });
    await expect(corruptService.addMember({
      teamId: team.id,
      path: nestedPath,
      name: "reader",
      role: "reviewer",
      childSessionId: nestedSessionId,
    })).rejects.toBeInstanceOf(TeamMemberSessionOwnershipError);

    await store.append({
      id: "event_corrupt_victim_member",
      type: "team.member_added",
      time: 92 as TimestampMs,
      sessionId: rootSessionId,
      payload: {
        teamId: team.id,
        path: victimPath,
        name: "victim",
        role: "worker",
        childSessionId: victimSessionId,
      },
    });
    await expect(service.sendMessage({
      teamId: team.id,
      sessionId: rootSessionId,
      from: rootPath,
      to: victimPath,
      content: "must not wake another interactive session",
      delivery: "triggerTurn",
    })).rejects.toBeInstanceOf(TeamMemberSessionOwnershipError);
    expect(await store.agentMailbox({ recipientSessionId: victimSessionId })).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bound team mutations use the owner operation fence and fail before append when it is lost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-operation-fence-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const ownerSessionId = "session_team_owner_fence" as SessionId;
  const actorSessionId = ownerSessionId;
  const acquired: SessionId[] = [];
  let failAtMutation = false;
  const sessionOperations = {
    async withSessionOperation<T>(
      sessionId: SessionId,
      fn: (operation: { readonly signal: AbortSignal; assertCurrent(): void }) => Promise<T> | T,
    ): Promise<T> {
      acquired.push(sessionId);
      let assertions = 0;
      const operation = {
        signal: new AbortController().signal,
        assertCurrent() {
          assertions++;
          if (failAtMutation && assertions >= 2) throw new Error("lease lost");
        },
      };
      return fn(operation);
    },
  };

  try {
    const service = new TeamControlService({
      store,
      createId: createSequentialId(),
      now: () => 100 as TimestampMs,
      sessionOperations,
    });
    const team = await service.createTeam({
      sessionId: ownerSessionId,
      name: "fenced-team",
      leadPath: "/root" as AgentPath,
    });
    const task = await service.createTask({
      teamId: team.id,
      sessionId: ownerSessionId,
      title: "fenced task",
    });

    failAtMutation = true;
    await expect(service.updateTask({
      teamId: team.id,
      taskId: task.id,
      sessionId: actorSessionId,
      status: "completed",
    })).rejects.toThrow("lease lost");
    expect((await service.tasks(team.id))[0]?.status).toBe("pending");

    failAtMutation = false;
    await service.updateTask({
      teamId: team.id,
      taskId: task.id,
      sessionId: actorSessionId,
      status: "completed",
    });
    expect(acquired.at(-1)).toBe(ownerSessionId);
    expect((await service.tasks(team.id))[0]?.status).toBe("completed");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bound writes commit under the durable owner claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-durable-owner-fence-"));
  const dbPath = join(dir, "events.sqlite");
  const store = new SqliteEventStore(dbPath);
  const contender = new SqliteEventStore(dbPath);
  const ownerSessionId = "session_team_durable_owner" as SessionId;
  const actorSessionId = ownerSessionId;
  const claimId = "run_claim_team_durable_owner";
  const claimedAt = Date.now();
  let assertions = 0;
  let replaceClaim = false;
  const sessionOperations = {
    async withSessionOperation<T>(
      sessionId: SessionId,
      fn: (operation: {
        readonly signal: AbortSignal;
        readonly runClaim: { sessionId: SessionId; claimId: string };
        assertCurrent(): void;
      }) => Promise<T> | T,
    ): Promise<T> {
      expect(sessionId).toBe(ownerSessionId);
      return fn({
        signal: new AbortController().signal,
        runClaim: { sessionId: ownerSessionId, claimId },
        assertCurrent() {
          assertions++;
          if (replaceClaim && assertions === 2) {
            expect(contender.claimSessionRun({
              sessionId: ownerSessionId,
              claimId: "run_claim_team_contender",
              allowSubagentSessions: false,
              time: claimedAt + 60_000,
              leaseDurationMs: 60_000,
            })).toEqual({ status: "claimed" });
          }
        },
      });
    },
  };

  try {
    await store.append({
      id: "event_team_durable_owner_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId: ownerSessionId,
      payload: { sessionId: ownerSessionId, cwd: "/repo" },
    });
    expect(store.claimSessionRun({
      sessionId: ownerSessionId,
      claimId,
      allowSubagentSessions: false,
      time: claimedAt,
      leaseDurationMs: 60_000,
    })).toEqual({ status: "claimed" });

    const service = new TeamControlService({ store, sessionOperations });
    const team = await service.createTeam({
      sessionId: ownerSessionId,
      name: "durably fenced",
      leadPath: "/root" as AgentPath,
    });
    const task = await service.createTask({
      teamId: team.id,
      title: "must keep owner claim",
    });
    expect((await store.events({
      sessionId: ownerSessionId,
      type: "team.task_created",
      limit: 10,
    })).at(-1)?.payload).toMatchObject({ taskId: task.id });

    assertions = 0;
    replaceClaim = true;
    await expect(service.updateTask({
      teamId: team.id,
      taskId: task.id,
      sessionId: actorSessionId,
      status: "completed",
    })).rejects.toBeInstanceOf(SessionRunClaimConflictError);
    expect((await service.tasks(team.id))[0]?.status).toBe("pending");
    expect(await store.events({ sessionId: actorSessionId, type: "team.task_updated", limit: 10 })).toEqual([]);
  } finally {
    contender.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function seedMemberTask(store: SqliteEventStore, input: {
  taskId: TaskId;
  path: AgentPath;
  parentPath: AgentPath;
  parentSessionId: SessionId;
  childSessionId: SessionId;
  time: number;
}): Promise<void> {
  await store.append({
    id: `event_${input.taskId}`,
    type: "agent.task_created",
    time: input.time as TimestampMs,
    sessionId: input.parentSessionId,
    payload: {
      taskId: input.taskId,
      path: input.path,
      parentPath: input.parentPath,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      taskName: input.taskId,
      cwd: "/repo",
      prompt: `run ${input.taskId}`,
      mode: "background",
    },
  });
}

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix: string) => `${prefix}_${++next}`;
}

const TEAM_HOSTILE_SECRET = "sk-team-persistence-secret-123456789";

function hostileTeamDiagnostic(label: string, includeWorstEscaped: boolean): string {
  return `${label}\nAuthorization: Bearer ${TEAM_HOSTILE_SECRET}\n`
    + `http://127.0.0.1:4888/private?token=${TEAM_HOSTILE_SECRET}\n`
    + (includeWorstEscaped ? teamWorstEscapedText() : "diagnostic detail");
}

function teamWorstEscapedText(): string {
  return "\u0000\"\\\n".repeat(Math.ceil((5 * 1024 * 1024) / 4));
}

function expectTeamSafeDiagnostic(value: string | undefined): void {
  expect(value).toBeDefined();
  expect(value).toContain("[REDACTED]");
  expect(value).not.toContain(TEAM_HOSTILE_SECRET);
  expect(value).not.toContain("127.0.0.1");
  expect(new TextEncoder().encode(value ?? "").byteLength).toBeLessThanOrEqual(16 * 1024);
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
