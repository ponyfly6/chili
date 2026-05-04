import { RGBA, SyntaxStyle } from "@opentui/core";
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
  const keyPrefix = props.keyPrefix ?? "display:tool";
  const key = `${keyPrefix}:${props.activity.id}`;
  const bodyDetail = bodyDetailForActivity(props.activity);
  const headerLines = [
    ...toolLabelLines(props.activity, props.width, props.theme, keyPrefix),
    ...toolCompactSupplementLines(key, props.activity, props.width, props.theme),
  ];

  return (
    <box width={props.width} maxWidth={props.width} flexDirection="column" overflow="hidden">
      <TranscriptLines lines={headerLines} />
      <ToolBodyBlock
        activity={props.activity}
        detail={bodyDetail}
        width={props.width}
        theme={props.theme}
        cellKey={key}
      />
      {props.activity.details
        .filter((detail) => detail !== bodyDetail)
        .map((detail) => (
          <TranscriptLines
            key={`${key}:detail:${detail.label}`}
            lines={toolDetailLines(`${key}:detail:${detail.label}`, detail, props.width, props.theme)}
          />
        ))}
    </box>
  );
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

function ToolBodyBlock(props: {
  activity: ToolActivityDisplay;
  detail: ToolActivityDetail | undefined;
  width: number;
  theme: TuiTheme;
  cellKey: string;
}) {
  const { activity, detail, width, theme, cellKey } = props;
  if (activity.bodyLines.length === 0) return null;
  if (activity.bodyKind !== "diff" && activity.bodyKind !== "code") {
    return <TranscriptLines lines={toolBodyLines(`${cellKey}:body:${activity.bodyKind}`, activity, detail, width, theme)} />;
  }

  const kind = activity.bodyKind;
  const labelLines = richBodyLabelLines(`${cellKey}:body:${kind}`, kind, activity.bodyTruncated, width, theme);
  const content = activity.bodyLines.join("\n") || " ";
  const richWidth = Math.max(1, width - 4);
  const richHeight = Math.max(1, activity.bodyLines.length);
  const syntaxStyle = toolSyntaxStyle(theme);
  const useNativeDiff = kind === "diff" && canRenderNativeDiff(content);
  const codeFiletype = kind === "diff" ? "diff" : toolCodeFiletype(activity);

  return (
    <box width={width} maxWidth={width} flexDirection="column" overflow="hidden">
      <TranscriptLines lines={labelLines} />
      <box marginLeft={4} width={richWidth} maxWidth={richWidth} height={richHeight} overflow="hidden">
        {useNativeDiff ? (
          <diff
            id={toolRichBodyRenderableId(cellKey, kind)}
            diff={content}
            width={richWidth}
            height={richHeight}
            fg={theme.colors.text.muted}
            syntaxStyle={syntaxStyle}
            view="unified"
            wrapMode="none"
            showLineNumbers={false}
            addedSignColor={theme.colors.status.success}
            removedSignColor={theme.colors.status.error}
            lineNumberFg={theme.colors.text.disabled}
            lineNumberBg={theme.colors.panel}
          />
        ) : (
          <code
            id={toolRichBodyRenderableId(cellKey, kind)}
            content={content}
            {...(codeFiletype === undefined ? {} : { filetype: codeFiletype })}
            syntaxStyle={syntaxStyle}
            width={richWidth}
            height={richHeight}
            fg={kind === "diff" ? theme.colors.text.muted : theme.colors.accent.secondary}
            wrapMode="none"
            truncate
            conceal={false}
            drawUnstyledText
          />
        )}
      </box>
    </box>
  );
}

export function toolRichBodyRenderableId(cellKey: string, kind: "code" | "diff"): string {
  return `${cellKey}:rich:${kind}`;
}

function richBodyLabelLines(key: string, label: "code" | "diff", truncated: boolean, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const suffix = truncated ? " (truncated)" : "";
  return wrapLine(`  ${label}${suffix}:`, {
    key: `${key}:label`,
    fg: theme.colors.text.muted,
    width,
    hangingIndent: "    ",
  });
}

function diffBodyLines(key: string, activity: ToolActivityDisplay, width: number, theme: TuiTheme): TranscriptLineModel[] {
  // Text fallback for transcript/copy paths and partial scroll slices.
  return detailPreviewLines(key, "diff", activity.bodyLines, activity.bodyTruncated, width, theme.colors.text.muted);
}

function codeBodyLines(key: string, activity: ToolActivityDisplay, width: number, theme: TuiTheme): TranscriptLineModel[] {
  // Text fallback for transcript/copy paths and partial scroll slices.
  return detailPreviewLines(key, "code", activity.bodyLines, activity.bodyTruncated, width, theme.colors.text.muted);
}

function canRenderNativeDiff(content: string): boolean {
  return /^@@ /m.test(content) || /^--- .*\n\+\+\+ /m.test(content);
}

const toolSyntaxStyleCache = new Map<string, SyntaxStyle>();

function toolSyntaxStyle(theme: TuiTheme): SyntaxStyle {
  const cacheKey = [
    theme.id,
    theme.colors.text.secondary,
    theme.colors.text.muted,
    theme.colors.text.disabled,
    theme.colors.accent.secondary,
    theme.colors.status.success,
    theme.colors.status.error,
    theme.colors.status.info,
    theme.colors.status.warning,
  ].join("\0");
  const cached = toolSyntaxStyleCache.get(cacheKey);
  if (cached) return cached;

  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(theme.colors.text.muted) },
    comment: { fg: RGBA.fromHex(theme.colors.text.disabled), dim: true },
    keyword: { fg: RGBA.fromHex(theme.colors.status.info) },
    string: { fg: RGBA.fromHex(theme.colors.status.success) },
    number: { fg: RGBA.fromHex(theme.colors.status.warning) },
    function: { fg: RGBA.fromHex(theme.colors.accent.secondary) },
    variable: { fg: RGBA.fromHex(theme.colors.text.secondary) },
    operator: { fg: RGBA.fromHex(theme.colors.text.muted) },
    punctuation: { fg: RGBA.fromHex(theme.colors.text.muted) },
  });
  toolSyntaxStyleCache.set(cacheKey, syntaxStyle);
  return syntaxStyle;
}

function toolCodeFiletype(activity: ToolActivityDisplay): string | undefined {
  const path = activity.inputSummary?.path ?? activity.inputSummary?.scope ?? activity.inputSummary?.detail;
  const extension = path?.match(/\.([a-zA-Z0-9_+-]+)(?:[:\s].*)?$/)?.[1]?.toLowerCase();
  if (!extension) return undefined;
  if (extension === "ts" || extension === "tsx") return "typescript";
  if (extension === "js" || extension === "jsx" || extension === "mjs" || extension === "cjs") return "javascript";
  if (extension === "py") return "python";
  if (extension === "rs") return "rust";
  if (extension === "go") return "go";
  if (extension === "rb") return "ruby";
  if (extension === "sh" || extension === "bash" || extension === "zsh") return "bash";
  if (extension === "json") return "json";
  if (extension === "md" || extension === "mdx") return "markdown";
  if (extension === "yml" || extension === "yaml") return "yaml";
  if (extension === "html" || extension === "css" || extension === "sql" || extension === "java" || extension === "kt" || extension === "swift") return extension;
  return undefined;
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
