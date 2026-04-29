import type { PanelProps } from "./types.js";
import { VISIBLE_LIMITS } from "./types.js";
import { focusLabel, rowMarker, shorten, visibleWindow } from "./helpers.js";

export function TaskBoard(props: PanelProps) {
  const tasks = props.model.selected?.tasks ?? [];
  const window = visibleWindow(tasks, props.selectedIndex, VISIBLE_LIMITS.tasks);
  return (
    <box flexGrow={2} minWidth={28} height="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? "#88c0d0" : "#3b4252"} paddingX={1}>
      <text fg="#f8f8f2" truncate wrapMode="none">{focusLabel(`Task Board${window.label}`, props.focused)}</text>
      {tasks.length === 0 ? (
        <text fg="#8f9baa" truncate wrapMode="none">{"  none"}</text>
      ) : (
        window.rows.map(({ item: task, index }) => {
          const state = task.merge ? `merge:${task.merge.status}` : task.verifier ? `verify:${task.verifier.status}` : task.status;
          const error = task.error ? ` error:${shorten(task.error, 28)}` : "";
          return (
            <text key={task.id} fg={index === props.selectedIndex ? "#f8f8f2" : task.blocked ? "#ffd166" : "#d8dee9"} truncate wrapMode="none">
              {`${rowMarker(props.focused, index === props.selectedIndex)} ${state} ${shorten(task.title, 6)}${error}`}
            </text>
          );
        })
      )}
    </box>
  );
}
