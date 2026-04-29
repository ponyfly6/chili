import { TextAttributes } from "@opentui/core";
import type { TeamLiveConnectionState, TeamLiveView } from "@chili/sdk";
import type { FocusRegion, TeamLiveSurfaceRuntime } from "./types.js";
import { focusLabel, shorten } from "./helpers.js";

export function HeaderBar(props: {
  model: TeamLiveView;
  connection: TeamLiveConnectionState;
  runtime: TeamLiveSurfaceRuntime;
  focus: FocusRegion;
  width: number;
  height: number;
}) {
  const selected = props.model.selected;
  const health = selected?.health.status ?? "unknown";
  const reasons = selected?.health.reasons.join(",") || "none";
  const action = props.runtime.actionFeedback;
  const status = action ? `${action.status}: ${shorten(action.message, 72)}` : shorten(props.runtime.message, 72);
  const fg = props.connection.status === "error" || action?.status === "error" ? "#ff6b6b" : "#d8dee9";
  const titleLine = shorten(
    `Chili Team Live size:${props.width}x${props.height} team:${props.model.selectedTeamId ?? "none"} health:${health} ${focusLabel(props.focus, true)}`,
    Math.max(20, props.width - 4),
  );
  const statusLine = shorten(
    `connection:${props.connection.status} last:${props.connection.lastEventId ?? "none"} reasons:${reasons}  ${status}`,
    Math.max(20, props.width - 4),
  );

  return (
    <box height={4} width="100%" flexDirection="column" paddingX={1} border borderStyle="single" borderColor="#4c566a">
      <text height={1} fg="#f8f8f2" attributes={TextAttributes.BOLD} truncate wrapMode="none">
        {titleLine}
      </text>
      <text height={1} fg={fg} truncate wrapMode="none">
        {statusLine}
      </text>
    </box>
  );
}
