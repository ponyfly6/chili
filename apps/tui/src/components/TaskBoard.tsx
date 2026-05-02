import type { PanelProps } from "./types.js";
import { VISIBLE_LIMITS } from "./types.js";
import { focusLabel, rowMarker, shorten, visibleWindow } from "./helpers.js";

export function TaskBoard(props: PanelProps) {
  const tasks = props.model.selected?.tasks ?? [];
  const window = visibleWindow(tasks, props.selectedIndex, VISIBLE_LIMITS.tasks);
  const { theme } = props;
  return (
    <box flexGrow={2} minWidth={28} height="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? theme.colors.border.focus : theme.colors.border.subtle} paddingX={1}>
      <text fg={theme.colors.text.primary} truncate wrapMode="none">{focusLabel(`Task Board${window.label}`, props.focused)}</text>
      {tasks.length === 0 ? (
        <text fg={theme.colors.text.muted} truncate wrapMode="none">{"  none"}</text>
      ) : (
        window.rows.map(({ item: task, index }) => {
          const state = task.merge ? `merge:${task.merge.status}` : task.verifier ? `verify:${task.verifier.status}` : task.status;
          const error = task.error ? ` error:${shorten(task.error, 28)}` : "";
          return (
            <text key={task.id} fg={index === props.selectedIndex ? theme.colors.text.primary : task.blocked ? theme.colors.status.warning : theme.colors.text.secondary} truncate wrapMode="none">
              {`${rowMarker(props.focused, index === props.selectedIndex)} ${state} ${shorten(task.title, 6)}${error}`}
            </text>
          );
        })
      )}
    </box>
  );
}
