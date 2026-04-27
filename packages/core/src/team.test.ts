import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, SessionId, TaskId, ThreadId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { TeamControlService } from "./team.js";

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
        taskId: task.id,
        content: "Please review the team control service.",
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
      "team.task_claimed",
      "team.task_updated",
      "team.member_status_changed",
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

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix: string) => `${prefix}_${++next}`;
}
