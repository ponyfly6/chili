import type { TuiTheme } from "../theme/index.js";
import { detailPreviewLines, TranscriptLines, type TranscriptLineModel, wrapLine } from "./lines.js";
import type { ChatDisplayItem, ToolActivityDisplay } from "./presentation.js";
import type { ToolActivityDetail } from "./tool-renderers.js";

type ToolGroupDisplay = Extract<ChatDisplayItem, { kind: "tool_group" }>;
type ToolCellBaseProps = { width: number; theme: TuiTheme; keyPrefix?: string | undefined };

export function ToolInlineCell(props: ToolCellBaseProps & { activity: ToolActivityDisplay }) {
  return <TranscriptLines lines={toolInlineCellLines(props.activity, props.width, props.theme, props.keyPrefix)} />;
}

export function ToolBlockCell(props: ToolCellBaseProps & { activity: ToolActivityDisplay }) {
  return <TranscriptLines lines={toolBlockCellLines(props.activity, props.width, props.theme, props.keyPrefix)} />;
}

export function ToolGroupCell(props: ToolCellBaseProps & { group: ToolGroupDisplay }) {
  return <TranscriptLines lines={toolGroupCellLines(props.group, props.width, props.theme, props.keyPrefix)} />;
}

export function ToolCell(props: ToolCellBaseProps & { activity: ToolActivityDisplay }) {
  return shouldRenderBlockCell(props.activity)
    ? <ToolBlockCell activity={props.activity} width={props.width} theme={props.theme} keyPrefix={props.keyPrefix} />
    : <ToolInlineCell activity={props.activity} width={props.width} theme={props.theme} keyPrefix={props.keyPrefix} />;
}

// TODO: Replace these fallback lines with true ToolCell partial rendering once
// OpenTUI code/diff components can render clipped slices directly.
export function toolCellLines(activity: ToolActivityDisplay, width: number, theme: TuiTheme, keyPrefix = "display:tool"): TranscriptLineModel[] {
  if (shouldRenderBlockCell(activity)) return toolBlockCellLines(activity, width, theme, keyPrefix);
  return toolInlineCellLines(activity, width, theme, keyPrefix);
}

export function toolGroupCellLines(group: ToolGroupDisplay, width: number, theme: TuiTheme, keyPrefix = `display:${group.kind}`): TranscriptLineModel[] {
  const lines = wrapLine(group.label, {
    key: `${keyPrefix}:${group.id}`,
    fg: toolFg(group.tone, theme),
    width,
    hangingIndent: "  ",
  });
  for (const activity of group.activities) {
    if (activity.compactErrorLines?.length) {
      lines.push(...detailPreviewLines(`${keyPrefix}:${group.id}:${activity.id}:error`, "error", activity.compactErrorLines, false, width, theme.colors.status.error));
    }
    if (activity.details.length > 0 || activity.bodyLines.length > 0) {
      lines.push(...wrapLine(`  ${activity.label}`, {
        key: `${keyPrefix}:${group.id}:${activity.id}:label`,
        fg: theme.colors.text.muted,
        width,
        hangingIndent: "    ",
      }));
    }
    lines.push(...toolSupplementLines(`${keyPrefix}:${group.id}:${activity.id}`, activity, width, theme));
  }
  return lines;
}

function shouldRenderBlockCell(activity: ToolActivityDisplay): boolean {
  return activity.mode === "block" || activity.bodyLines.length > 0 || activity.details.length > 0;
}

function toolInlineCellLines(activity: ToolActivityDisplay, width: number, theme: TuiTheme, keyPrefix = "display:tool"): TranscriptLineModel[] {
  const lines = toolLabelLines(activity, width, theme, keyPrefix);
  lines.push(...toolCompactSupplementLines(`${keyPrefix}:${activity.id}`, activity, width, theme));
  return lines;
}

function toolBlockCellLines(activity: ToolActivityDisplay, width: number, theme: TuiTheme, keyPrefix = "display:tool"): TranscriptLineModel[] {
  const lines = toolLabelLines(activity, width, theme, keyPrefix);
  lines.push(...toolCompactSupplementLines(`${keyPrefix}:${activity.id}`, activity, width, theme));
  lines.push(...toolSupplementLines(`${keyPrefix}:${activity.id}`, activity, width, theme));
  return lines;
}

function toolLabelLines(activity: ToolActivityDisplay, width: number, theme: TuiTheme, keyPrefix: string): TranscriptLineModel[] {
  return wrapLine(activity.label, {
    key: `${keyPrefix}:${activity.id}`,
    fg: toolFg(activity.tone, theme),
    width,
    hangingIndent: "  ",
  });
}

function toolCompactSupplementLines(key: string, activity: ToolActivityDisplay, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const lines: TranscriptLineModel[] = [];
  if (activity.outputHint) {
    lines.push(...wrapLine(`  ${activity.outputHint}`, {
      key: `${key}:output-hint`,
      fg: theme.colors.text.disabled,
      width,
      hangingIndent: "    ",
    }));
  }
  if (activity.compactErrorLines?.length) {
    lines.push(...detailPreviewLines(`${key}:compact-error`, "error", activity.compactErrorLines, false, width, theme.colors.status.error));
  }
  return lines;
}

function toolSupplementLines(key: string, activity: ToolActivityDisplay, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const lines: TranscriptLineModel[] = [];
  const bodyDetail = bodyDetailForActivity(activity);
  if (activity.bodyLines.length > 0) {
    lines.push(...toolBodyLines(`${key}:body:${activity.bodyKind}`, activity, bodyDetail, width, theme));
  }
  for (const detail of activity.details) {
    if (detail === bodyDetail) continue;
    lines.push(...toolDetailLines(`${key}:detail:${detail.label}`, detail, width, theme));
  }
  return lines;
}

function toolBodyLines(
  key: string,
  activity: ToolActivityDisplay,
  detail: ToolActivityDetail | undefined,
  width: number,
  theme: TuiTheme,
): TranscriptLineModel[] {
  if (activity.bodyKind === "diff") return diffBodyLines(key, activity, width, theme);
  if (activity.bodyKind === "code") return codeBodyLines(key, activity, width, theme);
  if (activity.bodyKind === "error") {
    return detailPreviewLinesWithTones(key, "error", activity.bodyLines, activity.bodyTruncated, detail?.lineTones, width, theme);
  }
  if (activity.bodyKind === "text") {
    return detailPreviewLinesWithTones(key, detail?.label ?? "output", activity.bodyLines, activity.bodyTruncated, detail?.lineTones, width, theme);
  }
  return [];
}

function diffBodyLines(key: string, activity: ToolActivityDisplay, width: number, theme: TuiTheme): TranscriptLineModel[] {
  // TODO: Replace this labeled text block with an OpenTUI <diff> component.
  return detailPreviewLines(key, "diff", activity.bodyLines, activity.bodyTruncated, width, theme.colors.text.muted);
}

function codeBodyLines(key: string, activity: ToolActivityDisplay, width: number, theme: TuiTheme): TranscriptLineModel[] {
  // TODO: Replace this labeled text block with an OpenTUI <code> component.
  return detailPreviewLines(key, "code", activity.bodyLines, activity.bodyTruncated, width, theme.colors.text.muted);
}

function bodyDetailForActivity(activity: ToolActivityDisplay): ToolActivityDetail | undefined {
  if (activity.bodyLines.length === 0 || activity.bodyKind === "none") return undefined;
  const candidates = activity.details.filter((detail) => detail.truncated === activity.bodyTruncated && sameLines(detail.lines, activity.bodyLines));
  if (activity.bodyKind === "error") return candidates.find((detail) => detail.tone === "error") ?? candidates[0];
  return candidates.find((detail) => detail.label === "live output")
    ?? candidates.find((detail) => detail.label === "output")
    ?? candidates.find((detail) => detail.label === "input")
    ?? candidates[0];
}

function toolDetailLines(key: string, detail: ToolActivityDetail, width: number, theme: TuiTheme): TranscriptLineModel[] {
  return detailPreviewLinesWithTones(key, detail.label, detail.lines, detail.truncated, detail.lineTones, width, theme, detail.tone);
}

function detailPreviewLinesWithTones(
  key: string,
  label: string,
  lines: readonly string[],
  truncated: boolean,
  lineTones: readonly ("muted" | "error")[] | undefined,
  width: number,
  theme: TuiTheme,
  fallbackTone: "muted" | "error" = "muted",
): TranscriptLineModel[] {
  if (!lineTones?.length) {
    const fg = fallbackTone === "error" ? theme.colors.status.error : theme.colors.text.muted;
    return detailPreviewLines(key, label, lines, truncated, width, fg);
  }
  const output: TranscriptLineModel[] = [];
  const labelFg = fallbackTone === "error" ? theme.colors.status.error : theme.colors.text.muted;
  const suffix = truncated ? " (truncated)" : "";
  output.push(...wrapLine(`  ${label}${suffix}:`, {
    key: `${key}:label`,
    fg: labelFg,
    width,
    hangingIndent: "    ",
  }));
  for (const [index, line] of lines.entries()) {
    output.push(...wrapLine(`    ${line || " "}`, {
      key: `${key}:line:${index}`,
      fg: lineTones[index] === "error" ? theme.colors.status.error : theme.colors.text.muted,
      width,
      hangingIndent: "    ",
    }));
  }
  return output;
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function toolFg(tone: "muted" | "pending" | "error", theme: TuiTheme): string {
  if (tone === "error") return theme.colors.status.error;
  if (tone === "pending") return theme.colors.status.pending;
  return theme.colors.text.muted;
}
