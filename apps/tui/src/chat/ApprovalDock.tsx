import type { ApprovalId } from "@chili/protocol";
import type { ChatApprovalRow } from "@chili/sdk";
import { shorten } from "../components/helpers.js";

export function ApprovalDock(props: {
  approvals: readonly ChatApprovalRow[];
  onApprove: (approvalId: ApprovalId) => void;
  onReject: (approvalId: ApprovalId) => void;
}) {
  if (props.approvals.length === 0) return null;
  const visibleApprovals = props.approvals.slice(0, 3);
  return (
    <box width="100%" height={visibleApprovals.length + 4} flexDirection="column" border borderStyle="single" borderColor="#544a20" paddingX={1}>
      <text fg="#ffd166" wrapMode="none" truncate>{"Approval required"}</text>
      {visibleApprovals.map((approval, index) => (
        <text key={approval.id} fg={index === 0 ? "#f8f8f2" : "#d8dee9"} wrapMode="none" truncate>
          {`${index === 0 ? ">" : " "} ${approval.permission} ${shorten(approval.toolName ?? approval.id, 18)} ${shorten(approval.patterns.join(", "), 48)}`}
        </text>
      ))}
      <text fg="#8f9baa" wrapMode="none" truncate>{"a approve once | x reject"}</text>
    </box>
  );
}
