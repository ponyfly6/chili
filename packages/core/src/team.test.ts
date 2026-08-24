import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, SessionId, TaskId, ThreadId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import {
  TeamControlService,
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
  const threadId = "thread_team_control" as ThreadId;

  try {
    const service = new TeamControlService({
      store,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });

    const team = await service.createTeam({
      sessionId,
      threadId,
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

    const reviewer = await service.addMember({
      sessionId,
      threadId,
      teamId: team.id,
      path: reviewerPath,
      name: "reviewer",
      role: "code-reviewer",
      childSessionId: "session_reviewer" as SessionId,
      childThreadId: "thread_reviewer" as ThreadId,
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
      threadId,
      teamId: team.id,
      title: "Review team control service",
      createdBy: leadPath,
    });
    const assigned = await service.assignTask({
      sessionId,
      threadId,
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
        childSessionId: "session_reviewer",
        childThreadId: "thread_reviewer",
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
      threadId,
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
      threadId,
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

  try {
    const service = new TeamControlService({
      store,
      createId: createSequentialId(),
      now: () => 30 as TimestampMs,
    });

    const team = await service.createTeam({ name: "delivery-team", leadPath });
    await service.addMember({
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      childSessionId: "session_worker" as SessionId,
      childThreadId: "thread_worker" as ThreadId,
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
        childSessionId: "session_worker",
        childThreadId: "thread_worker",
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

  try {
    const service = new TeamControlService({ store, now: () => 40 as TimestampMs });
    const team = await service.createTeam({ name: "message-team", leadPath, leadName: "lead" });
    await service.addMember({
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      childSessionId: "session_worker" as SessionId,
      childThreadId: "thread_worker" as ThreadId,
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

  try {
    const service = new TeamControlService({ store, now: () => 50 as TimestampMs });
    const team = await service.createTeam({ name: "target-team", leadPath });
    for (const suffix of ["one", "two"]) {
      await service.addMember({
        teamId: team.id,
        path: `/root/${suffix}` as AgentPath,
        name: "worker",
        role: "implementer",
        childSessionId: `session_${suffix}` as SessionId,
        childThreadId: `thread_${suffix}` as ThreadId,
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

  try {
    const service = new TeamControlService({ store, now: () => 60 as TimestampMs });
    const team = await service.createTeam({ name: "fifo-team", leadPath: "/root" as AgentPath });
    await service.addMember({
      teamId: team.id,
      path: "/root/worker" as AgentPath,
      name: "worker",
      role: "implementer",
      childSessionId: "session_worker" as SessionId,
      childThreadId: "thread_worker" as ThreadId,
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
    await service.addMember({
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      childSessionId: workerSessionId,
      childThreadId: "thread_worker" as ThreadId,
    });
    await service.addMember({
      teamId: team.id,
      path: peerPath,
      name: "peer",
      role: "reviewer",
      childSessionId: peerSessionId,
      childThreadId: "thread_peer" as ThreadId,
    });
    await service.addMember({
      teamId: team.id,
      path: "/root/colliding" as AgentPath,
      name: "colliding",
      role: "legacy-worker",
      childSessionId: rootSessionId,
      childThreadId: "thread_colliding" as ThreadId,
    });

    await expect(service.sendMessage({
      teamId: team.id,
      sessionId: rootSessionId,
      from: "worker",
      to: "peer",
      content: "root impersonation",
    })).rejects.toBeInstanceOf(TeamMessageSenderUnauthorizedError);
    await expect(service.sendMessage({
      teamId: team.id,
      sessionId: rootSessionId,
      from: "colliding",
      to: "peer",
      content: "root session collision impersonation",
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

    await service.addMember({
      teamId: team.id,
      path: "/root/duplicate-session" as AgentPath,
      name: "duplicate-session",
      role: "legacy-worker",
      childSessionId: workerSessionId,
      childThreadId: "thread_duplicate" as ThreadId,
    });
    await expect(service.sendMessage({
      teamId: team.id,
      sessionId: workerSessionId,
      from: "worker",
      to: "peer",
      content: "ambiguous child session",
    })).rejects.toBeInstanceOf(TeamMessageSenderUnauthorizedError);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("routes a worker team message back to the owning lead endpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-message-lead-roundtrip-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const rootSessionId = "session_root" as SessionId;
  const rootThreadId = "thread_root" as ThreadId;
  const workerSessionId = "session_worker" as SessionId;
  const rootPath = "/root" as AgentPath;
  const workerPath = "/root/worker" as AgentPath;

  try {
    const service = new TeamControlService({ store, now: () => 80 as TimestampMs });
    const team = await service.createTeam({
      sessionId: rootSessionId,
      threadId: rootThreadId,
      name: "roundtrip-team",
      leadPath: rootPath,
      leadName: "lead",
    });
    await service.addMember({
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      childSessionId: workerSessionId,
      childThreadId: "thread_worker" as ThreadId,
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
        childSessionId: rootSessionId,
        childThreadId: rootThreadId,
        triggerTurn: true,
      }),
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix: string) => `${prefix}_${++next}`;
}
