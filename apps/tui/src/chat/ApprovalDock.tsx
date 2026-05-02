import type { ApprovalId } from "@chili/protocol";
import type { ChatApprovalRow } from "@chili/sdk";
import type { ChatApprovalGrantScope } from "../useChatRuntime.js";
import type { TuiTheme } from "../theme/index.js";

const MAX_APPROVAL_BODY_LINES = 7;

export function ApprovalDock(props: {
  approvals: readonly ChatApprovalRow[];
  width?: number;
  onApprove: (approvalId: ApprovalId, scope: ChatApprovalGrantScope) => void;
  onReject: (approvalId: ApprovalId) => void;
  theme: TuiTheme;
}) {
  if (props.approvals.length === 0) return null;
  const width = Math.max(24, props.width ?? 80);
  const lines = approvalDockLines(props.approvals, width, props.theme);
  return (
    <box width="100%" height={lines.length + 2} flexDirection="column" border borderStyle="single" borderColor={props.theme.colors.border.warning} paddingX={1}>
      {lines.map((line) => (
        <text key={line.key} fg={line.fg} wrapMode="none" truncate>
          {line.text}
        </text>
      ))}
    </box>
  );
}

export function approvalDockHeight(approvals: readonly ChatApprovalRow[], width: number | undefined, theme: TuiTheme): number {
  if (approvals.length === 0) return 0;
  return approvalDockLines(approvals, Math.max(24, width ?? 80), theme).length + 2;
}

interface ApprovalDockLine {
  key: string;
  text: string;
  fg: string;
}

interface ApprovalRiskMetadata {
  permission?: unknown;
  pattern?: unknown;
  patterns?: unknown;
  action?: unknown;
  reason?: unknown;
  level?: unknown;
  severity?: unknown;
  source?: unknown;
  matchedRule?: unknown;
}

interface TuiApprovalMetadata {
  metadata?: Record<string, unknown>;
  reason?: unknown;
  source?: unknown;
  danger?: unknown;
  dangerLevel?: unknown;
  risk?: unknown;
  riskLevel?: unknown;
  policySource?: unknown;
  matchedRule?: unknown;
}

function approvalDockLines(approvals: readonly ChatApprovalRow[], width: number, theme: TuiTheme): ApprovalDockLine[] {
  const visible = approvals.slice(0, 3);
  const contentWidth = Math.max(12, width - 6);
  const lines: ApprovalDockLine[] = [
    { key: "title", text: "Approval required", fg: theme.colors.status.pending },
  ];
  const body: ApprovalDockLine[] = [];

  visible.forEach((approval, index) => {
    const active = index === 0;
    const tool = approval.toolName ?? approval.permission;
    body.push({
      key: `${approval.id}:head`,
      text: `${active ? ">" : " "} ${tool} ${approval.toolDisplayStatus ?? "waiting_permission"} (${approval.permission})`,
      fg: active ? theme.colors.text.primary : theme.colors.text.secondary,
    });

    if (!active) {
      const summary = approvalSummary(approval);
      const compact = summary.detail ?? summary.scope;
      if (compact) body.push(...wrapDetail(`${approval.id}:compact`, `  ${compact}`, contentWidth, theme.colors.text.muted));
      return;
    }

    const summary = approvalSummary(approval);
    body.push(...wrapDetail(`${approval.id}:permission`, `  permission: ${approval.permission}`, contentWidth, theme.colors.text.secondary));
    if (approval.patterns.length > 0) {
      body.push(...wrapDetail(`${approval.id}:patterns`, `  patterns: ${approval.patterns.join(", ")}`, contentWidth, theme.colors.text.secondary));
    }
    for (const line of approvalMetadataLines(approval)) {
      const fg = line.kind === "danger" ? theme.colors.status.error : line.kind === "reason" ? theme.colors.status.warning : theme.colors.text.secondary;
      body.push(...wrapDetail(`${approval.id}:${line.kind}:${line.index}`, `  ${line.label}: ${line.value}`, contentWidth, fg));
    }
    if (summary.command) {
      body.push(...wrapDetail(`${approval.id}:command`, `  command: ${summary.command}`, contentWidth, theme.colors.text.primary));
    }
    if (summary.path) {
      body.push(...wrapDetail(`${approval.id}:path`, `  path: ${summary.path}`, contentWidth, theme.colors.text.secondary));
    }
    if (summary.pattern) {
      body.push(...wrapDetail(`${approval.id}:pattern`, `  pattern: ${summary.pattern}`, contentWidth, theme.colors.text.secondary));
    }
    if (summary.scope && summary.scope !== summary.path) {
      body.push(...wrapDetail(`${approval.id}:scope`, `  scope: ${summary.scope}`, contentWidth, theme.colors.text.secondary));
    }
    if (summary.diffSummary) {
      body.push(...wrapDetail(`${approval.id}:diff`, `  change: ${summary.diffSummary}`, contentWidth, theme.colors.text.secondary));
    }
    if (!summary.command && !summary.path && !summary.pattern && !summary.scope && summary.detail) {
      body.push(...wrapDetail(`${approval.id}:detail`, `  ${summary.detail}`, contentWidth, theme.colors.text.secondary));
    }
  });

  if (approvals.length > visible.length) {
    body.push({ key: "more", text: `  +${approvals.length - visible.length} more approval(s)`, fg: theme.colors.text.muted });
  }

  const foldedCount = Math.max(0, body.length - MAX_APPROVAL_BODY_LINES);
  lines.push(...body.slice(0, MAX_APPROVAL_BODY_LINES));
  if (foldedCount > 0) {
    lines.push({ key: "folded", text: `  +${foldedCount} lines folded`, fg: theme.colors.text.muted });
  }
  lines.push({ key: "hint", text: "a once | s session | A always | x deny", fg: theme.colors.text.muted });
  return lines;
}

function approvalSummary(approval: ChatApprovalRow): ChatApprovalRow["inputSummary"] {
  return approval.inputSummary ?? {
    title: approval.toolName ?? approval.permission,
    detail: approval.patterns.join(", "),
    scope: approval.patterns.join(", "),
  };
}

function approvalMetadataLines(approval: ChatApprovalRow): Array<{ index: number; kind: "reason" | "source" | "danger"; label: string; value: string }> {
  const extended = approval as ChatApprovalRow & TuiApprovalMetadata;
  const metadata = isRecord(extended.metadata) ? extended.metadata : {};
  const lines: Array<{ index: number; kind: "reason" | "source" | "danger"; label: string; value: string }> = [];
  const seen = new Set<string>();

  const add = (kind: "reason" | "source" | "danger", label: string, value: unknown) => {
    const text = metadataValueText(value);
    if (!text) return;
    const key = `${kind}:${label}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ index: lines.length, kind, label, value: text });
  };

  add("reason", "reason", extended.reason ?? metadata.reason ?? metadata.decisionReason ?? metadata.approvalReason);
  add("source", "source", extended.source ?? metadata.source ?? metadata.policySource ?? metadata.hookSource);
  add("source", "matched", extended.matchedRule ?? metadata.matchedRule ?? metadata.rule);
  add("danger", "danger", extended.danger ?? extended.dangerLevel ?? metadata.danger ?? metadata.dangerLevel ?? metadata.destructiveWarning);
  add("danger", "risk", extended.risk ?? extended.riskLevel ?? metadata.risk ?? metadata.riskLevel);

  for (const decision of approvalRisks(metadata.patternDecisions)) {
    add("reason", "reason", decisionSummary(decision));
    add("source", "source", decision.source);
    add("source", "matched", decision.matchedRule);
  }

  for (const [index, risk] of approvalRisks(metadata.approvalRisks ?? metadata.risks).entries()) {
    const parts = [
      stringValue(risk.action),
      stringValue(risk.level ?? risk.severity),
      stringValue(risk.reason),
      patternText(risk.pattern ?? risk.patterns) ? `pattern ${patternText(risk.pattern ?? risk.patterns)}` : undefined,
      stringValue(risk.source),
    ].filter((part): part is string => Boolean(part));
    add("danger", index === 0 ? "risk" : "risk", parts.join(" - "));
  }

  return lines;
}

function decisionSummary(decision: ApprovalRiskMetadata): string | undefined {
  const parts = [
    stringValue(decision.action),
    stringValue(decision.reason),
    patternText(decision.pattern ?? decision.patterns) ? `pattern ${patternText(decision.pattern ?? decision.patterns)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" - ") || undefined;
}

function approvalRisks(value: unknown): ApprovalRiskMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function metadataValueText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!isRecord(value)) return undefined;
  const typed = value as ApprovalRiskMetadata & { type?: unknown; name?: unknown; rule?: unknown };
  const parts = [
    stringValue(typed.type),
    stringValue(typed.name),
    stringValue(typed.action),
    stringValue(typed.permission),
    patternText(typed.pattern ?? typed.patterns),
    stringValue(typed.level ?? typed.severity),
    stringValue(typed.reason),
    stringValue(typed.rule),
    stringValue(typed.source),
  ].filter((part): part is string => Boolean(part));
  return parts.join(" - ") || undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function patternText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const joined = value.map(stringValue).filter((part): part is string => Boolean(part)).join(", ");
    return joined || undefined;
  }
  return stringValue(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
