import type { PanelProps } from "./types.js";
import { VISIBLE_LIMITS } from "./types.js";
import { focusLabel, rowMarker, shorten, visibleWindow } from "./helpers.js";

export function ApprovalsPanel(props: PanelProps) {
  const approvals = props.model.selected?.pendingApprovals ?? [];
  const window = visibleWindow(approvals, props.selectedIndex, VISIBLE_LIMITS.approvals);
  const { theme } = props;
  return (
    <box flexGrow={1} minWidth={24} height="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? theme.colors.border.focus : theme.colors.border.subtle} paddingX={1}>
      <text fg={theme.colors.text.primary} truncate wrapMode="none">{focusLabel(`Approvals${window.label}`, props.focused)}</text>
      {approvals.length === 0 ? (
        <text fg={theme.colors.text.muted} truncate wrapMode="none">{"  none"}</text>
      ) : (
        window.rows.map(({ item: approval, index }) => (
          <text key={approval.id} fg={index === props.selectedIndex ? theme.colors.text.primary : theme.colors.status.warning} truncate wrapMode="none">
            {`${rowMarker(props.focused, index === props.selectedIndex)} ${approval.permission} ${shorten(approval.toolName ?? approval.id, 10)}`}
          </text>
        ))
      )}
    </box>
  );
}
