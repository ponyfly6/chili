import type { TeamLiveView } from "@chili/sdk";
import type { TuiTheme } from "../theme/index.js";
import type { FocusRegion, SelectionState } from "./types.js";
import { countsCompact, focusLabel, shorten } from "./helpers.js";

export function DetailPane(props: {
  model: TeamLiveView;
  focus: FocusRegion;
  focused: boolean;
  selection: SelectionState;
  width?: number;
  theme: TuiTheme;
}) {
  const lines = detailLines(props.model, props.focus, props.selection);
  const { theme } = props;
  return (
    <box width={props.width ?? 36} height="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? theme.colors.border.focus : theme.colors.border.subtle} paddingX={1}>
      <text fg={theme.colors.text.primary} truncate>{focusLabel("Detail", props.focused)}</text>
      {lines.map((line, index) => (
        <text key={`${index}:${line}`} fg={index === 0 ? theme.colors.text.primary : theme.colors.text.secondary} wrapMode="word">
          {shorten(line, 96)}
        </text>
      ))}
    </box>
  );
}

function detailLines(model: TeamLiveView, focus: FocusRegion, selection: SelectionState): string[] {
  const selected = model.selected;
  if (!selected) return ["No selected team.", `connection:${model.connection.status}`];
  if (focus === "teams") {
    return [
      `${selected.team.name || selected.team.id}`,
      `id:${selected.team.id}`,
      `lead:${selected.team.leadPath}`,
      `members:${selected.team.memberCount} tasks:${selected.team.taskCount} approvals:${selected.team.pendingApprovalCount}`,
    ];
  }
  if (focus === "runs") {
    const run = selected.runs[selection.runs] ?? selected.runs[0];
    if (!run) return ["No run yet.", `active tools:${selected.activeTools.length}`];
    return [
      `run:${run.id}`,
      `status:${run.phase ?? run.status} cycle:${run.cycle}`,
      `counts:${countsCompact(run.counts)}`,
      `stop:${run.stopReason ?? "none"}`,
    ];
  }
  if (focus === "members") {
    const member = selected.members[selection.members] ?? selected.members[0];
    if (!member) return ["No members."];
    return [
      `${member.name || member.path} [${member.role}]`,
      `status:${member.status} session:${member.sessionId ?? "none"}`,
      `path:${member.path}`,
      `task:${member.currentTaskTitle ?? member.currentTaskId ?? "none"}`,
      `write:${member.writeScope?.join(",") ?? "not declared"}`,
    ];
  }
  if (focus === "tasks") {
    const task = selected.tasks[selection.tasks] ?? selected.tasks[0];
    if (!task) return ["No tasks."];
    return [
      `${task.title}`,
      `id:${task.id} status:${task.status}`,
      `owner:${task.ownerName ?? task.ownerPath ?? "unassigned"}`,
      `verifier:${task.verifier?.status ?? "none"} merge:${task.merge?.status ?? "none"}`,
      `worktree:${task.worktree?.path ?? "none"}`,
      `summary:${task.summary ?? task.error ?? "none"}`,
    ];
  }
  if (focus === "approvals") {
    const approval = selected.pendingApprovals[selection.approvals] ?? selected.pendingApprovals[0];
    if (!approval) return ["No pending approvals."];
    return [
      `approval:${approval.id}`,
      `permission:${approval.permission}`,
      `tool:${approval.toolName ?? approval.callId ?? "unknown"}`,
      `session:${approval.sessionId ?? "none"}`,
      `patterns:${approval.patterns.join(", ")}`,
    ];
  }
  if (focus === "activity") {
    const activity = selected.recentActivity[selection.activity] ?? selected.recentActivity[0] ?? model.globalActivity[0];
    if (!activity) return ["No activity."];
    return [
      `${activity.kind}:${activity.label}`,
      `status:${activity.status ?? "none"} time:${activity.time}`,
      `detail:${activity.detail ?? "none"}`,
      `task:${activity.taskId ?? "none"} team:${activity.teamId ?? "none"}`,
    ];
  }
  if (focus === "actions") {
    const action = selected.availableActions[selection.actions] ?? selected.availableActions[0] ?? model.availableActions[0];
    if (!action) return ["No actions."];
    return [
      `action:${action.type}`,
      `enabled:${String(action.enabled)} reason:${action.reason ?? "none"}`,
      "Use Enter to run the highlighted action.",
    ];
  }
  return [
    `team:${selected.team.name || selected.team.id}`,
    `health:${selected.health.status}`,
    `reasons:${selected.health.reasons.join(",") || "none"}`,
  ];
}
