import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, SessionId, TaskId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import {
  TeamControlService,
  TeamMemberSessionOwnershipError,
  TeamMemberTargetAmbiguousError,
  TeamMessageConflictError,
  TeamMessageDeliveryError,
  TeamMessageSenderUnauthorizedError,
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
