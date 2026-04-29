import type { PanelProps } from "./types.js";
import { VISIBLE_LIMITS } from "./types.js";
import { focusLabel, rowMarker, shorten, visibleWindow } from "./helpers.js";

export function MembersPanel(props: PanelProps) {
  const members = props.model.selected?.members ?? [];
  const window = visibleWindow(members, props.selectedIndex, VISIBLE_LIMITS.members);
  return (
    <box flexGrow={1} minWidth={20} height="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? "#88c0d0" : "#3b4252"} paddingX={1}>
      <text fg="#f8f8f2" truncate wrapMode="none">{focusLabel(`Members${window.label}`, props.focused)}</text>
      {members.length === 0 ? (
        <text fg="#8f9baa" truncate wrapMode="none">{"  none"}</text>
      ) : (
        window.rows.map(({ item: member, index }) => {
          const current = member.currentTaskTitle ? ` task:${shorten(member.currentTaskTitle, 32)}` : "";
          const session = member.sessionId ? ` session:${shorten(member.sessionId, 12)}` : "";
          return (
            <text key={member.id} fg={index === props.selectedIndex ? "#f8f8f2" : "#d8dee9"} truncate wrapMode="none">
              {`${rowMarker(props.focused, index === props.selectedIndex)} ${member.isLead ? "lead" : "node"} ${shorten(member.name || member.path, 18)} [${member.role}] ${member.status}${current}${session}`}
            </text>
          );
        })
      )}
    </box>
  );
}
