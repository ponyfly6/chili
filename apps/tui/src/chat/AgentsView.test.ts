import { expect, test } from "bun:test";
import { createRuntimeView, runtimeDelegationStatus } from "@chili/sdk";
import type { AgentPath, SessionId, TaskId, TeamId, ToolCallId } from "@chili/protocol";
import { adHocAgentsText, agentCapabilityText, agentsViewModel } from "./AgentsView.js";

test("observed agent events override stale model catalog capability metadata", () => {
  const status = runtimeDelegationStatus(createRuntimeView(), { generatedAt: "now" });
  status.delegation.observed = true;
  expect(agentCapabilityText(status, false)).toBe("available (used this session)");

  status.delegation.observed = false;
  expect(agentCapabilityText(status, false)).toBe("unknown (model catalog reports tool calls unsupported)");
});

test("agents summary distinguishes an all-failed spawn from a partially spawned batch", () => {
  const status = runtimeDelegationStatus(createRuntimeView(), { generatedAt: "now" });
  status.lastBatch = {
    callId: "tool_all_failed" as ToolCallId,
    taskIds: [],
    expected: 3,
    untracked: 3,
    spawnedCount: 0,
    spawnFailureCount: 3,
    total: 0,
    pending: 0,
    running: 0,
    active: 0,
    completed: 0,
    incomplete: 0,
    failed: 0,
    cancelled: 0,
    mixed: false,
    partial: false,
    status: "failed",
    updatedAt: 1,
  };
  expect(adHocAgentsText(status)).toBe("0 active; latest batch failed: 3 of 3 agent tasks failed to spawn");

  const firstTaskId = "task_partial_first" as TaskId;
  const thirdTaskId = "task_partial_third" as TaskId;
  status.agents.counts = {
    total: 2,
    pending: 2,
    running: 0,
    active: 2,
    completed: 0,
    incomplete: 0,
    failed: 0,
    cancelled: 0,
  };
  status.lastBatch = {
    ...status.lastBatch,
    callId: "tool_partial" as ToolCallId,
    taskIds: [firstTaskId, thirdTaskId],
    untracked: 1,
    spawnedCount: 2,
    spawnFailureCount: 1,
    total: 2,
    pending: 2,
    active: 2,
    partial: true,
    status: "partial",
    updatedAt: 2,
  };
  expect(adHocAgentsText(status)).toBe("2 active, 2 total; latest batch partial: 1 of 3 agent task failed to spawn");
});

test("agents view model keeps every scoped persistent team and member outcome", () => {
  const view = createRuntimeView();
  const sessionId = "session_main" as SessionId;
  const teamA = "team_alpha" as TeamId;
  const teamB = "team_beta" as TeamId;
  const lead = "/root" as AgentPath;
  const reader = "/root/reader" as AgentPath;
  const tester = "/root/tester" as AgentPath;
  const failedTask = "task_failed" as TaskId;
  const completedTask = "task_completed" as TaskId;

  view.sessionIds.push(sessionId);
  view.sessions[sessionId] = {
    id: sessionId,
    cwd: "/repo",
    lifecycle: "active",
    status: "idle",
    messageIds: [],
    toolCallIds: [],
    approvalIds: [],
    agentRunIds: [],
    taskIds: [failedTask, completedTask],
    updatedAt: 20,
  };
  view.teamIds.push(teamA, teamB);
  view.teams[teamA] = {
    id: teamA,
    name: "alpha",
    leadPath: lead,
    status: "active",
    memberIds: [`${teamA}:${lead}`, `${teamA}:${reader}`],
    taskIds: [failedTask],
    messageIds: [],
    runIds: [],
    createdAt: 1,
    updatedAt: 20,
    sessionId,
  };
  view.teams[teamB] = {
    id: teamB,
    name: "beta",
    leadPath: lead,
    status: "active",
    memberIds: [`${teamB}:${tester}`],
    taskIds: [completedTask],
    messageIds: [],
    runIds: [],
    createdAt: 2,
    updatedAt: 19,
    sessionId,
  };
  view.teamMemberIds.push(`${teamA}:${lead}`, `${teamA}:${reader}`, `${teamB}:${tester}`);
  view.teamMembers[`${teamA}:${lead}`] = {
    id: `${teamA}:${lead}`,
    teamId: teamA,
    path: lead,
    name: "lead",
    role: "lead",
    status: "idle",
    createdAt: 1,
    updatedAt: 20,
  };
  view.teamMembers[`${teamA}:${reader}`] = {
    id: `${teamA}:${reader}`,
    teamId: teamA,
    path: reader,
    name: "reader",
    role: "research",
    status: "blocked",
    currentTaskId: failedTask,
    createdAt: 2,
    updatedAt: 20,
  };
  view.teamMembers[`${teamB}:${tester}`] = {
    id: `${teamB}:${tester}`,
    teamId: teamB,
    path: tester,
    name: "tester",
    role: "verification",
    status: "idle",
    currentTaskId: completedTask,
    createdAt: 3,
    updatedAt: 19,
  };
  view.taskIds.push(failedTask, completedTask);
  view.tasks[failedTask] = {
    id: failedTask,
    status: "failed",
    generation: 0,
    createdAt: 4,
    updatedAt: 20,
    teamId: teamA,
    sessionId,
    ownerPath: reader,
    title: "Read implementation",
    error: "provider rejected the request",
  };
  view.tasks[completedTask] = {
    id: completedTask,
    status: "completed",
    generation: 0,
    createdAt: 5,
    updatedAt: 19,
    teamId: teamB,
    sessionId,
    ownerPath: tester,
    title: "Run verification",
    summary: "all focused tests passed",
  };

  const status = runtimeDelegationStatus(view, {
    sessionId,
    delegationConfig: { sessionId, policy: "explicit", source: "default" },
    generatedAt: "2026-08-19T00:00:00.000Z",
  });
  const model = agentsViewModel({ runtimeView: view, status, sessionId, capabilitySupported: true });

  expect(model).toMatchObject({
    parentExecution: "idle",
    capability: "available (used this session)",
    delegation: "on request (explicit; source default)",
    persistentTeamSummary: "2 total, 2 active",
  });
  expect(model.teams.map((team) => team.title)).toEqual(["alpha (team_alpha)", "beta (team_beta)"]);
  expect(model.teams[0]?.members[1]).toMatchObject({
    title: "member reader · research",
    status: "blocked",
    detail: "provider rejected the request",
    error: true,
  });
  expect(model.teams[1]?.members[0]).toMatchObject({
    title: "member tester · verification",
    status: "idle",
    detail: "all focused tests passed",
    error: false,
  });
});
