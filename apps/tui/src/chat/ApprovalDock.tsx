import type { ApprovalId } from "@chili/protocol";
import type { ChatApprovalRow } from "@chili/sdk";

const MAX_APPROVAL_BODY_LINES = 3;

export function ApprovalDock(props: {
  approvals: readonly ChatApprovalRow[];
  width?: number;
  onApprove: (approvalId: ApprovalId) => void;
  onReject: (approvalId: ApprovalId) => void;
}) {
  if (props.approvals.length === 0) return null;
  const width = Math.max(24, props.width ?? 80);
  const lines = approvalDockLines(props.approvals, width);
  return (
    <box width="100%" height={lines.length + 2} flexDirection="column" border borderStyle="single" borderColor="#544a20" paddingX={1}>
      {lines.map((line) => (
        <text key={line.key} fg={line.fg} wrapMode="none" truncate>
          {line.text}
        </text>
      ))}
    </box>
  );
}

export function approvalDockHeight(approvals: readonly ChatApprovalRow[], width?: number): number {
  if (approvals.length === 0) return 0;
  return approvalDockLines(approvals, Math.max(24, width ?? 80)).length + 2;
}

interface ApprovalDockLine {
  key: string;
  text: string;
  fg: string;
}

function approvalDockLines(approvals: readonly ChatApprovalRow[], width: number): ApprovalDockLine[] {
  const visible = approvals.slice(0, 3);
  const contentWidth = Math.max(12, width - 6);
  const lines: ApprovalDockLine[] = [
    { key: "title", text: "Approval required", fg: "#ffd166" },
  ];
  const body: ApprovalDockLine[] = [];

  visible.forEach((approval, index) => {
    const active = index === 0;
    const tool = approval.toolName ?? approval.permission;
    body.push({
      key: `${approval.id}:head`,
      text: `${active ? ">" : " "} ${tool} ${approval.toolDisplayStatus ?? "waiting_permission"} (${approval.permission})`,
      fg: active ? "#f8f8f2" : "#d8dee9",
    });

    if (!active) {
      const summary = approvalSummary(approval);
      const compact = summary.detail ?? summary.scope;
      if (compact) body.push(...wrapDetail(`${approval.id}:compact`, `  ${compact}`, contentWidth, "#8f9baa"));
      return;
    }

    const summary = approvalSummary(approval);
    if (summary.command) {
      body.push(...wrapDetail(`${approval.id}:command`, `  command: ${summary.command}`, contentWidth, "#f8f8f2"));
    }
    if (summary.path) {
      body.push(...wrapDetail(`${approval.id}:path`, `  path: ${summary.path}`, contentWidth, "#d8dee9"));
    }
    if (summary.pattern) {
      body.push(...wrapDetail(`${approval.id}:pattern`, `  pattern: ${summary.pattern}`, contentWidth, "#d8dee9"));
    }
    if (summary.scope && summary.scope !== summary.path) {
      body.push(...wrapDetail(`${approval.id}:scope`, `  scope: ${summary.scope}`, contentWidth, "#d8dee9"));
    }
    if (summary.diffSummary) {
      body.push(...wrapDetail(`${approval.id}:diff`, `  change: ${summary.diffSummary}`, contentWidth, "#d8dee9"));
    }
    if (!summary.command && !summary.path && !summary.pattern && !summary.scope && summary.detail) {
      body.push(...wrapDetail(`${approval.id}:detail`, `  ${summary.detail}`, contentWidth, "#d8dee9"));
    }
  });

  if (approvals.length > visible.length) {
    body.push({ key: "more", text: `  +${approvals.length - visible.length} more approval(s)`, fg: "#8f9baa" });
  }

  const foldedCount = Math.max(0, body.length - MAX_APPROVAL_BODY_LINES);
  lines.push(...body.slice(0, MAX_APPROVAL_BODY_LINES));
  if (foldedCount > 0) {
    lines.push({ key: "folded", text: `  +${foldedCount} lines folded`, fg: "#8f9baa" });
  }
  lines.push({ key: "hint", text: "a approve once | x reject", fg: "#8f9baa" });
  return lines;
}

function approvalSummary(approval: ChatApprovalRow): ChatApprovalRow["inputSummary"] {
  return approval.inputSummary ?? {
    title: approval.toolName ?? approval.permission,
    detail: approval.patterns.join(", "),
    scope: approval.patterns.join(", "),
  };
}

function wrapDetail(key: string, text: string, width: number, fg: string): ApprovalDockLine[] {
  const lines: ApprovalDockLine[] = [];
  const paragraphs = text.split("\n");
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const source = paragraph.length > 0 ? paragraph : " ";
    let current = "";
    let currentWidth = 0;
    let lineIndex = 0;
    const push = () => {
      lines.push({
        key: `${key}:${paragraphIndex}:${lineIndex}`,
        text: `${lineIndex === 0 ? "" : "  "}${current || " "}`,
        fg,
      });
      current = "";
      currentWidth = 0;
      lineIndex += 1;
    };

    for (const char of source) {
      const nextWidth = charDisplayWidth(char);
      if (current && currentWidth + nextWidth > width) push();
      current += char;
      currentWidth += nextWidth;
    }
    push();
  }
  return lines;
}

function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  ) return 2;
  return 1;
}
