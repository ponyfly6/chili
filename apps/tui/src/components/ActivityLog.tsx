import type { PanelProps } from "./types.js";
import { VISIBLE_LIMITS } from "./types.js";
import { activityLine, focusLabel, rowMarker, visibleWindow } from "./helpers.js";

export function ActivityLog(props: PanelProps) {
  const activity = props.model.selected?.recentActivity ?? props.model.globalActivity;
  const window = visibleWindow(activity, props.selectedIndex, VISIBLE_LIMITS.activity);
  const { theme } = props;
  return (
    <box flexGrow={1} minHeight={6} width="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? theme.colors.border.focus : theme.colors.border.subtle} paddingX={1}>
      <text fg={theme.colors.text.primary} truncate wrapMode="none">{focusLabel(`Activity${window.label}`, props.focused)}</text>
      {activity.length === 0 ? (
        <text fg={theme.colors.text.muted} truncate wrapMode="none">{"  none"}</text>
      ) : (
        window.rows.map(({ item, index }) => (
          <text key={`${item.kind}:${item.id}`} fg={index === props.selectedIndex ? theme.colors.text.primary : theme.colors.text.secondary} truncate wrapMode="none">
            {`${rowMarker(props.focused, index === props.selectedIndex)} ${activityLine(item)}`}
          </text>
        ))
      )}
    </box>
  );
}
