import type { TeamLiveAction } from "@chili/sdk";
import type { TeamLiveSurfaceRuntime } from "./types.js";
import { VISIBLE_LIMITS } from "./types.js";
import { actionLabel, focusLabel, pendingLabel, rowMarker, shorten, visibleWindow } from "./helpers.js";

export function ActionsBar(props: {
  actions: readonly TeamLiveAction[];
  focused: boolean;
  selectedIndex: number;
  runtime: TeamLiveSurfaceRuntime;
}) {
  const actions = visibleWindow(props.actions, props.selectedIndex, VISIBLE_LIMITS.actions);
  return (
    <box height={4} width="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? "#88c0d0" : "#3b4252"} paddingX={1}>
      <text fg="#f8f8f2" truncate wrapMode="none">{focusLabel(`Actions${actions.label}`, props.focused)}</text>
      <box width="100%" flexDirection="row" gap={1}>
        {actions.rows.length === 0 ? (
          <text fg="#8f9baa" truncate wrapMode="none">{"none"}</text>
        ) : (
          actions.rows.map(({ item: action, index }) => (
            <text key={`${action.type}:${index}`} fg={action.enabled ? (index === props.selectedIndex ? "#f8f8f2" : "#a3be8c") : "#8f9baa"} truncate wrapMode="none">
              {shorten(`${rowMarker(props.focused, index === props.selectedIndex)} ${actionLabel(action)}${pendingLabel(action, props.runtime.pendingActionKey)}`, 32)}
            </text>
          ))
        )}
      </box>
    </box>
  );
}
