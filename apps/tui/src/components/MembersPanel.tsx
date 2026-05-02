import type { PanelProps } from "./types.js";
import { VISIBLE_LIMITS } from "./types.js";
import { focusLabel, rowMarker, shorten, visibleWindow } from "./helpers.js";

export function MembersPanel(props: PanelProps) {
  const members = props.model.selected?.members ?? [];
  const window = visibleWindow(members, props.selectedIndex, VISIBLE_LIMITS.members);
  const { theme } = props;
  return (
    <box flexGrow={1} minWidth={20} height="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? theme.colors.border.focus : theme.colors.border.subtle} paddingX={1}>
      <text fg={theme.colors.text.primary} truncate wrapMode="none">{focusLabel(`Members${window.label}`, props.focused)}</text>
      {members.length === 0 ? (
        <text fg={theme.colors.text.muted} truncate wrapMode="none">{"  none"}</text>
      ) : (
        window.rows.map(({ item: member, index }) => {
          const current = member.currentTaskTitle ? ` task:${shorten(member.currentTaskTitle, 32)}` : "";
          const session = member.sessionId ? ` session:${shorten(member.sessionId, 12)}` : "";
          return (
            <text key={member.id} fg={index === props.selectedIndex ? theme.colors.text.primary : theme.colors.text.secondary} truncate wrapMode="none">
              {`${rowMarker(props.focused, index === props.selectedIndex)} ${member.isLead ? "lead" : "node"} ${shorten(member.name || member.path, 18)} [${member.role}] ${member.status}${current}${session}`}
            </text>
          );
        })
      )}
    </box>
  );
}
