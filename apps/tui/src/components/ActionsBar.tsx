import type { TeamLiveAction } from "@chili/sdk";
import type { TuiTheme } from "../theme/index.js";
import type { TeamLiveSurfaceRuntime } from "./types.js";
import { VISIBLE_LIMITS } from "./types.js";
import { actionLabel, focusLabel, pendingLabel, rowMarker, shorten, visibleWindow } from "./helpers.js";

export function ActionsBar(props: {
  actions: readonly TeamLiveAction[];
  focused: boolean;
  selectedIndex: number;
  runtime: TeamLiveSurfaceRuntime;
  theme: TuiTheme;
}) {
  const actions = visibleWindow(props.actions, props.selectedIndex, VISIBLE_LIMITS.actions);
  const { theme } = props;
  return (
    <box height={4} width="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? theme.colors.border.focus : theme.colors.border.subtle} paddingX={1}>
      <text fg={theme.colors.text.primary} truncate wrapMode="none">{focusLabel(`Actions${actions.label}`, props.focused)}</text>
      <box width="100%" flexDirection="row" gap={1}>
        {actions.rows.length === 0 ? (
          <text fg={theme.colors.text.muted} truncate wrapMode="none">{"none"}</text>
        ) : (
          actions.rows.map(({ item: action, index }) => (
            <text key={`${action.type}:${index}`} fg={action.enabled ? (index === props.selectedIndex ? theme.colors.text.primary : theme.colors.status.success) : theme.colors.text.muted} truncate wrapMode="none">
              {shorten(`${rowMarker(props.focused, index === props.selectedIndex)} ${actionLabel(action)}${pendingLabel(action, props.runtime.pendingActionKey)}`, 32)}
            </text>
          ))
        )}
      </box>
    </box>
  );
}
