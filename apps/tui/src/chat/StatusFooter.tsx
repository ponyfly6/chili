import type { ChatSessionView, TeamLiveView } from "@chili/sdk";
import { shorten } from "../components/helpers.js";
import type { TuiTheme } from "../theme/index.js";

export function TeamStatusRow(props: { model: TeamLiveView; theme: TuiTheme }) {
  const selected = props.model.selected;
  const counts = selected?.health.counts;
  const line = selected
    ? `Team: ${selected.team.taskCount} tasks | ${counts?.runningTasks ?? 0} running | ${counts?.pendingApprovals ?? 0} approval | /team`
    : "Team: idle | /team";
  return (
    <box width="100%" paddingX={2}>
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{line}</text>
    </box>
  );
}

export function StatusFooter(props: {
  options: { modeName: string; modelName: string; providerName: string; cwd: string };
  chatView: ChatSessionView;
  canSubmit: boolean;
  theme: TuiTheme;
}) {
  const busy = props.chatView.status === "running" || props.chatView.status === "waiting_for_approval";
  const actionHint = busy ? "ctrl+x interrupt" : props.canSubmit ? "/ commands" : "waiting";
  return (
    <box width="100%" height={1} flexDirection="row" paddingX={2}>
      <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{shorten(props.options.cwd, 54)}</text>
      <box flexGrow={1} />
      <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{`${props.options.modeName} | ${props.options.modelName} | ${props.options.providerName} | ${actionHint} | tab agents | ctrl+p commands`}</text>
    </box>
  );
}
