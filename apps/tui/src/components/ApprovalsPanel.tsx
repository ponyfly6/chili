import type { PanelProps } from "./types.js";
import { VISIBLE_LIMITS } from "./types.js";
import { focusLabel, rowMarker, shorten, visibleWindow } from "./helpers.js";

export function ApprovalsPanel(props: PanelProps) {
  const approvals = props.model.selected?.pendingApprovals ?? [];
  const window = visibleWindow(approvals, props.selectedIndex, VISIBLE_LIMITS.approvals);
  return (
    <box flexGrow={1} minWidth={24} height="100%" flexDirection="column" border borderStyle="single" borderColor={props.focused ? "#88c0d0" : "#3b4252"} paddingX={1}>
      <text fg="#f8f8f2" truncate wrapMode="none">{focusLabel(`Approvals${window.label}`, props.focused)}</text>
      {approvals.length === 0 ? (
        <text fg="#8f9baa" truncate wrapMode="none">{"  none"}</text>
      ) : (
        window.rows.map(({ item: approval, index }) => (
          <text key={approval.id} fg={index === props.selectedIndex ? "#f8f8f2" : "#ffd166"} truncate wrapMode="none">
            {`${rowMarker(props.focused, index === props.selectedIndex)} ${approval.permission} ${shorten(approval.toolName ?? approval.id, 10)}`}
          </text>
        ))
      )}
    </box>
  );
}
