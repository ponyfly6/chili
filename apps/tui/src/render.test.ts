import { expect, test } from "bun:test";
import type { AgentPath, SessionId, TaskId, TeamId, TeamRunSummaryCounts } from "@chili/protocol";
import type { TeamLiveCockpitView } from "@chili/sdk";
import { parseArgs } from "./index.js";
import { renderTeamLiveCockpit, selectedTeamId } from "./render.js";

test("renders Team Live cockpit sections and detail panel", () => {
  const view = teamLiveFixture();

  const output = renderTeamLiveCockpit(view, {
    width: 96,
    height: 40,
    selectedTeamIndex: 0,
    detailOpen: true,
  });

  expect(output).toContain("Chili Team Live Cockpit");
  expect(output).toContain("Teams");
  expect(output).toContain("> live");
  expect(output).toContain("Run / Counts");
  expect(output).toContain("teamrun_live");
  expect(output).toContain("Lead / Members");
  expect(output).toContain("worker [builder] running");
  expect(output).toContain("Task Board");
  expect(output).toContain("Build cockpit");
  expect(output).toContain("Verifier / Merge / Worktree");
  expect(output).toContain("worktree task_live");
  expect(output).toContain("Pending Approvals");
  expect(output).toContain("tool.edit");
  expect(output).toContain("Recent Activity");
  expect(output).toContain("tool");
  expect(output).toContain("Detail");
  expect(output.split("\n")).toHaveLength(40);
});

test("selects teams by clamped index and parses runtime flags", () => {
  const view = teamLiveFixture();

  expect(selectedTeamId(view, 50)).toBe(view.team?.id);
  expect(parseArgs([])).toMatchObject({
    baseUrl: "http://127.0.0.1:4777",
  });
  expect(parseArgs(["--url", "http://runtime.test", "--team", "team_live", "--run-loop", "--once", "--max-cycles", "2"])).toMatchObject({
    baseUrl: "http://runtime.test",
    teamId: "team_live",
    runLoop: true,
    once: true,
    maxCycles: 2,
  });
});

function teamLiveFixture(): TeamLiveCockpitView {
  const teamId = "team_live" as TeamId;
  const taskId = "task_live" as TaskId;
  const leadPath = "/root" as AgentPath;
  const memberPath = "/root/worker" as AgentPath;
  const sessionId = "session_live" as SessionId;

  return {
    teamIds: [teamId],
    teams: [
      {
        id: teamId,
        name: "live",
        status: "active",
        leadPath,
        memberCount: 2,
        taskCount: 1,
        runningTaskCount: 1,
        pendingTaskCount: 0,
        pendingApprovalCount: 1,
        activeRunId: "teamrun_live",
        updatedAt: 12,
      },
    ],
    team: {
      id: teamId,
      name: "live",
      leadPath,
      status: "active",
      memberIds: [`${teamId}:${leadPath}`, `${teamId}:${memberPath}`],
      taskIds: [taskId],
      messageIds: ["teammsg_live"],
      runIds: ["teamrun_live"],
      sessionId,
      createdAt: 1,
      updatedAt: 12,
      activeRunId: "teamrun_live",
    },
    lead: {
      id: `${teamId}:${leadPath}`,
      teamId,
      path: leadPath,
      name: "lead",
      role: "leader",
      status: "running",
      isLead: true,
      depth: 0,
      taskIds: [],
      deliveryIds: [],
      updatedAt: 2,
    },
    members: [
      {
        id: `${teamId}:${leadPath}`,
        teamId,
        path: leadPath,
        name: "lead",
        role: "leader",
        status: "running",
        isLead: true,
        depth: 0,
        taskIds: [],
        deliveryIds: [],
        updatedAt: 2,
      },
      {
        id: `${teamId}:${memberPath}`,
        teamId,
        path: memberPath,
        name: "worker",
        role: "builder",
        status: "running",
        isLead: false,
        depth: 1,
        taskIds: [taskId],
        deliveryIds: ["mailbox_live"],
        currentTaskId: taskId,
        currentTaskTitle: "Build cockpit",
        writeScope: ["apps/tui"],
        updatedAt: 8,
      },
    ],
    tasks: [
      {
        id: taskId,
        teamId,
        title: "Build cockpit",
        status: "in_progress",
        ownerPath: memberPath,
        ownerName: "worker",
        metadata: {
          dispatch: { agentStatus: "running" },
          verification: { status: "pending" },
          worktree: { path: "/repo/.chili/worktrees/live", status: "active" },
          merge: { status: "pending" },
        },
        updatedAt: 8,
      },
    ],
    runs: [
      {
        id: "teamrun_live",
        teamId,
        status: "running",
        cycle: 1,
        phase: "dispatch",
        counts: counts({ dispatched: 1, stillRunning: 1 }),
        createdAt: 9,
        updatedAt: 10,
      },
    ],
    activeRun: {
      id: "teamrun_live",
      teamId,
      status: "running",
      cycle: 1,
      phase: "dispatch",
      counts: counts({ dispatched: 1, stillRunning: 1 }),
      createdAt: 9,
      updatedAt: 10,
    },
    pendingApprovals: [
      {
        id: "approval_live" as never,
        permission: "tool.edit",
        patterns: ["apps/tui/*"],
        status: "pending",
        createdAt: 11,
        sessionId,
      },
    ],
    mailbox: [
      {
        id: "mailbox_live",
        path: memberPath,
        from: leadPath,
        status: "queued",
        triggerTurn: true,
        queuedAt: 7,
        teamId,
        teamMessageId: "teammsg_live",
        taskId,
        deliveryStatus: "queued",
      },
    ],
    metadata: {
      dispatches: [{ taskId, title: "Build cockpit", status: "in_progress", ownerPath: memberPath, value: { agentStatus: "running" } }],
      verifications: [{ taskId, title: "Build cockpit", status: "in_progress", ownerPath: memberPath, value: { status: "pending" } }],
      worktrees: [{ taskId, title: "Build cockpit", status: "in_progress", ownerPath: memberPath, value: { path: "/repo/.chili/worktrees/live" } }],
      merges: [{ taskId, title: "Build cockpit", status: "in_progress", ownerPath: memberPath, value: { status: "pending" } }],
    },
    toolCounts: [{ toolName: "read_file", total: 1, running: 1, completed: 0, failed: 0 }],
    recentActivity: [
      {
        id: "tool_live",
        kind: "tool",
        time: 12,
        label: "read_file",
        status: "running",
        toolName: "read_file",
      },
    ],
    lastEventId: "event_live",
  };
}

function counts(input: Partial<TeamRunSummaryCounts>): TeamRunSummaryCounts {
  return {
    dispatched: 0,
    completed: 0,
    accepted: 0,
    reopened: 0,
    merged: 0,
    mergeFailed: 0,
    mergeConflicted: 0,
    mergeSkipped: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    stillRunning: 0,
    errors: 0,
    ...input,
  };
}
