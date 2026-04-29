import type { PanelProps } from "./types.js";
import { VISIBLE_LIMITS } from "./types.js";
import { activityLine, focusLabel, rowMarker, visibleWindow } from "./helpers.js";

export function ActivityLog(props: PanelProps) {
  const activity = props.model.selected?.recentActivity ?? props.model.globalActivity;
  const window = visibleWindow(activity, props.selectedIndex, VISIBLE_LIMITS.activity);
  return (
    <box flexGrow={1} minHeight={6} width="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? "#88c0d0" : "#3b4252"} paddingX={1}>
      <text fg="#f8f8f2" truncate wrapMode="none">{focusLabel(`Activity${window.label}`, props.focused)}</text>
      {activity.length === 0 ? (
        <text fg="#8f9baa" truncate wrapMode="none">{"  none"}</text>
      ) : (
        window.rows.map(({ item, index }) => (
          <text key={`${item.kind}:${item.id}`} fg={index === props.selectedIndex ? "#f8f8f2" : "#d8dee9"} truncate wrapMode="none">
            {`${rowMarker(props.focused, index === props.selectedIndex)} ${activityLine(item)}`}
          </text>
        ))
      )}
    </box>
  );
}
