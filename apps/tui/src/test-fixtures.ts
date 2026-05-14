import type { AgentPath, ApprovalId, SessionId, TaskId, TeamId, TeamRunSummaryCounts, ToolCallId } from "@chili/protocol";
import type { TeamLiveAction, TeamLiveView } from "@chili/sdk";

export function teamLiveFixture(): TeamLiveView {
  const teamId = "team_live" as TeamId;
  const taskId = "task_live" as TaskId;
  const approvalId = "approval_live" as ApprovalId;
  const toolCallId = "tool_live" as ToolCallId;
  const leadPath = "/root" as AgentPath;
  const memberPath = "/root/worker" as AgentPath;
  const sessionId = "session_live" as SessionId;
  const childSessionId = "session_child_live" as SessionId;

  return {
    connection: { status: "streaming", lastEventId: "event_live" },
    scope: { teamId, sessionId, teamIds: [teamId], sessionIds: [sessionId, childSessionId] },
    selectedTeamId: teamId,
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
    selected: {
      team: {
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
          sessionId,
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
          sessionId: childSessionId,
          childSessionId,
          currentTaskId: taskId,
          currentTaskTitle: "Build cockpit",
          currentTaskStatus: "in_progress",
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
          verifier: { status: "pending" },
          worktree: { path: "/repo/.chili/worktrees/live", status: "active" },
          merge: { teamId, taskId, title: "Build cockpit", ownerPath: memberPath, status: "pending" },
          dispatch: { agentStatus: "running" },
          blocked: false,
          final: false,
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
          mode: "background",
          once: true,
          maxConcurrentDispatches: 4,
          counts: counts({ dispatched: 1, stillRunning: 1 }),
          updatedAt: 10,
        },
      ],
      activeTools: [
        {
          id: toolCallId,
          toolName: "read_file",
          status: "running",
          updatedAt: 12,
          sessionId: childSessionId,
          waitingForApproval: false,
        },
      ],
      pendingApprovals: [
        {
          id: approvalId,
          permission: "tool.edit",
          patterns: ["apps/tui/*"],
          status: "pending",
          createdAt: 11,
          sessionId,
          toolName: "edit",
        },
      ],
      mergeQueue: [{ teamId, taskId, title: "Build cockpit", ownerPath: memberPath, status: "pending" }],
      recentActivity: [
        {
          id: toolCallId,
          kind: "tool",
          time: 12,
          label: "read_file",
          status: "running",
          toolName: "read_file",
        },
      ],
      availableActions: [
        { type: "run_loop", teamId, enabled: false, reason: "run_active" },
        { type: "merge", teamId, taskId, enabled: true },
        { type: "approve", approvalId, sessionId, enabled: true },
        { type: "reject", approvalId, sessionId, enabled: true },
        { type: "interrupt", sessionId: childSessionId, enabled: true },
      ],
      health: {
        status: "attention",
        reasons: ["pending_approvals", "pending_merge"],
        counts: {
          runningTasks: 1,
          pendingTasks: 0,
          blockedTasks: 0,
          failedTasks: 0,
          pendingApprovals: 1,
          activeTools: 1,
          pendingMerges: 1,
          conflictedMerges: 0,
          errors: 0,
        },
      },
    },
    globalActivity: [
      {
        id: toolCallId,
        kind: "tool",
        time: 12,
        label: "read_file",
        status: "running",
        toolName: "read_file",
      },
    ],
    availableActions: [
      { type: "run_loop", teamId, enabled: true },
      { type: "merge", teamId, taskId, enabled: true },
      { type: "approve", approvalId, sessionId, enabled: true },
      { type: "reject", approvalId, sessionId, enabled: true },
      { type: "interrupt", sessionId: childSessionId, enabled: true },
    ],
    generatedAt: "1970-01-01T00:00:00.000Z",
    lastEventId: "event_live",
  };
}

export function emptyTeamLiveFixture(status: TeamLiveView["connection"]["status"] = "connecting"): TeamLiveView {
  return {
    connection: { status },
    scope: { teamIds: [], sessionIds: [] },
    teams: [],
    globalActivity: [],
    availableActions: [
      { type: "run_loop", enabled: false, reason: "no_team" },
      { type: "merge", enabled: false, reason: "no_team" },
      { type: "interrupt", enabled: false, reason: "no_session" },
    ],
    generatedAt: "1970-01-01T00:00:00.000Z",
  };
}

export function withConnection(view: TeamLiveView, connection: TeamLiveView["connection"]): TeamLiveView {
  return { ...view, connection };
}

export function withMultipleTeams(view: TeamLiveView): TeamLiveView {
  const secondTeamId = "team_second" as TeamId;
  return {
    ...view,
    scope: { ...view.scope, teamIds: [...view.scope.teamIds, secondTeamId] },
    teams: [
      ...view.teams,
      {
        id: secondTeamId,
        name: "second",
        status: "active",
        leadPath: "/root/two" as AgentPath,
        memberCount: 1,
        taskCount: 3,
        runningTaskCount: 0,
        pendingTaskCount: 3,
        pendingApprovalCount: 0,
        updatedAt: 14,
      },
    ],
  };
}

export function withLongText(view: TeamLiveView): TeamLiveView {
  const selected = view.selected;
  if (!selected) return view;
  return {
    ...view,
    selected: {
      ...selected,
      tasks: selected.tasks.map((task) => ({
        ...task,
        title: "Build a very long Team Live cockpit surface that keeps text clipped inside terminal panels without layout shift",
        summary: "This summary is intentionally long so the OpenTUI frame test exercises truncation and wrapping paths.",
      })),
    },
  };
}

export function withActions(view: TeamLiveView, actions: readonly TeamLiveAction[]): TeamLiveView {
  const next: TeamLiveView = {
    ...view,
    availableActions: [...actions],
  };
  if (view.selected) next.selected = { ...view.selected, availableActions: [...actions] };
  return next;
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
