import type { ChatSessionView, ChatTranscriptItem } from "@chili/sdk";
import { shorten } from "../components/helpers.js";
import type { TuiTheme } from "../theme/index.js";
import { markdownToTerminalLines, wrapTerminalText, type MarkdownLineTone } from "./markdown.js";
import { buildChatDisplayItems, type ChatDisplayItem, type ToolActivityDisplay } from "./presentation.js";
import { splitStreamingMarkdown } from "./streaming.js";
import type { ToolActivityDetail } from "./tool-renderers.js";
import type { LocalTranscriptItem } from "./types.js";

export function MessageList(props: {
  chatView: ChatSessionView;
  localItems: readonly LocalTranscriptItem[];
  width?: number;
  visibleLimit?: number;
  scrollOffset?: number;
  showToolDetails?: boolean;
  theme: TuiTheme;
}) {
  const allLines = transcriptLines(props.chatView.items, props.localItems, {
    width: Math.max(24, props.width ?? 80),
    showToolDetails: props.showToolDetails === true,
    sessionStatus: props.chatView.status,
    activeToolCount: props.chatView.activeTools.length,
    theme: props.theme,
  });
  const limit = Math.max(1, props.visibleLimit ?? 18);
  const contentLimit = allLines.length > limit ? Math.max(1, limit - 1) : limit;
  const maxOffset = Math.max(0, allLines.length - contentLimit);
  const offset = Math.min(Math.max(0, props.scrollOffset ?? 0), maxOffset);
  const end = allLines.length - offset;
  const start = Math.max(0, end - contentLimit);
  const lines = allLines.slice(start, end);
  return (
    <box width="100%" height="100%" flexDirection="column">
      {lines.length === 0 ? (
        <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{"Start a conversation from the prompt below."}</text>
      ) : (
        <>
          {allLines.length > contentLimit ? (
            <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>
              {`History ${start + 1}-${end}/${allLines.length} PgUp/PgDn Shift+Up/Down`}
            </text>
          ) : null}
          {lines.map((line) => <TranscriptLine key={line.key} line={line} />)}
        </>
      )}
    </box>
  );
}

interface TranscriptLineModel {
  key: string;
  text: string;
  fg: string;
}

function TranscriptLine(props: { line: TranscriptLineModel }) {
  return (
    <text fg={props.line.fg} wrapMode="none" truncate>
      {props.line.text}
    </text>
  );
}

function transcriptLines(
  items: readonly ChatTranscriptItem[],
  localItems: readonly LocalTranscriptItem[],
  options: { width: number; showToolDetails: boolean; sessionStatus: ChatSessionView["status"]; activeToolCount: number; theme: TuiTheme },
): TranscriptLineModel[] {
  const displayItems = buildChatDisplayItems(items, {
    showToolDetails: options.showToolDetails,
    sessionStatus: options.sessionStatus,
    activeToolCount: options.activeToolCount,
  });
  return [
    ...displayItems.flatMap((item) => displayItemLines(item, options.width, options.theme)),
    ...localItems.flatMap((item) => localItemLines(item, options.width, options.theme)),
  ];
}

function displayItemLines(item: ChatDisplayItem, width: number, theme: TuiTheme): TranscriptLineModel[] {
  if (item.kind === "user_text") {
    return wrapLine(`🥔: ${item.text || "..."}`, {
      key: `display:${item.kind}:${item.id}`,
      fg: theme.colors.text.primary,
      width,
      hangingIndent: "    ",
    });
  }
  if (item.kind === "assistant_text") {
    if (item.streaming) return streamingAssistantLines(item, width, theme);
    return markdownToTerminalLines(item.text || "...", {
      key: `display:${item.kind}:${item.id}`,
      width,
      prefix: "🌶️: ",
      hangingIndent: "    ",
    }).map((line) => ({
      key: line.key,
      text: line.text,
      fg: markdownFg(line.tone, theme),
    }));
  }
  if (item.kind === "reasoning") return reasoningLines(item, width, theme);
  if (item.kind === "tool_activity") return toolActivityLines(item.activity, width, theme);
  if (item.kind === "tool_group") return toolGroupLines(item, width, theme);
  if (item.kind === "summary") {
    return wrapLine(`summary: ${item.text || "..."}`, {
      key: `display:${item.kind}:${item.id}`,
      fg: theme.colors.text.muted,
      width,
      hangingIndent: "  ",
    });
  }
  return approvalLines(item.approval, width, theme);
}

function streamingAssistantLines(item: Extract<ChatDisplayItem, { kind: "assistant_text" }>, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const { stableText, activeTail } = splitStreamingMarkdown(item.text);
  const lines = stableText.length > 0
    ? markdownToTerminalLines(stableText, {
      key: `display:${item.kind}:${item.id}:stable`,
      width,
      prefix: "🌶️: ",
      hangingIndent: "    ",
    }).map((line) => ({
      key: line.key,
      text: line.text,
      fg: markdownFg(line.tone, theme),
    }))
    : [];

  const tail = activeTail || (lines.length === 0 ? "..." : "");
  if (!tail) return lines;
  const prefix = lines.length === 0 ? "🌶️: " : "    ";
  lines.push(...wrapLine(`${prefix}${tail}`, {
    key: `display:${item.kind}:${item.id}:active-tail`,
    fg: markdownFg("text", theme),
    width,
    hangingIndent: "    ",
  }));
  return lines;
}

function localItemLines(item: LocalTranscriptItem, width: number, theme: TuiTheme): TranscriptLineModel[] {
  return wrapLine(`${item.level}: ${item.text}`, {
    key: item.id,
    fg: item.level === "error" ? theme.colors.status.error : theme.colors.text.muted,
    width,
  });
}

function reasoningLines(item: Extract<ChatDisplayItem, { kind: "reasoning" }>, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const compact = shorten((item.text || "...").replace(/\s+/g, " ").trim(), 180);
  return wrapLine(`Thinking: ${compact}`, {
    key: `display:${item.kind}:${item.id}`,
    fg: theme.colors.text.muted,
    width,
    hangingIndent: "  ",
  });
}

function toolActivityLines(item: ToolActivityDisplay, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const lines = wrapLine(item.label, {
    key: `display:tool:${item.id}`,
    fg: toolFg(item.tone, theme),
    width,
    hangingIndent: "  ",
  });
  if (item.outputHint) {
    lines.push(...wrapLine(`  ${item.outputHint}`, {
      key: `display:tool:${item.id}:output-hint`,
      fg: theme.colors.text.disabled,
      width,
      hangingIndent: "    ",
    }));
  }
  if (item.compactErrorLines?.length) {
    lines.push(...detailPreviewLines(`display:tool:${item.id}:compact-error`, "error", item.compactErrorLines, false, width, theme.colors.status.error));
  }
  for (const detail of item.details) {
    lines.push(...toolDetailLines(`display:tool:${item.id}:detail:${detail.label}`, detail, width, theme));
  }
  return lines;
}

function toolGroupLines(item: Extract<ChatDisplayItem, { kind: "tool_group" }>, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const lines = wrapLine(item.label, {
    key: `display:${item.kind}:${item.id}`,
    fg: toolFg(item.tone, theme),
    width,
    hangingIndent: "  ",
  });
  for (const activity of item.activities) {
    if (activity.compactErrorLines?.length) {
      lines.push(...detailPreviewLines(`display:${item.kind}:${item.id}:${activity.id}:error`, "error", activity.compactErrorLines, false, width, theme.colors.status.error));
    }
    if (activity.details.length > 0) {
      lines.push(...wrapLine(`  ${activity.label}`, {
        key: `display:${item.kind}:${item.id}:${activity.id}:label`,
        fg: theme.colors.text.muted,
        width,
        hangingIndent: "    ",
      }));
    }
    for (const detail of activity.details) {
      lines.push(...toolDetailLines(`display:${item.kind}:${item.id}:${activity.id}:detail:${detail.label}`, detail, width, theme));
    }
  }
  return lines;
}

function toolDetailLines(key: string, detail: ToolActivityDetail, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const fg = detail.tone === "error" ? theme.colors.status.error : theme.colors.text.muted;
  return detailPreviewLines(key, detail.label, detail.lines, detail.truncated, width, fg);
}

function detailPreviewLines(key: string, label: string, lines: readonly string[], truncated: boolean, width: number, fg: string): TranscriptLineModel[] {
  const output: TranscriptLineModel[] = [];
  const suffix = truncated ? " (truncated)" : "";
  output.push(...wrapLine(`  ${label}${suffix}:`, {
    key: `${key}:label`,
    fg,
    width,
    hangingIndent: "    ",
  }));
  for (const [index, line] of lines.entries()) {
    output.push(...wrapLine(`    ${line || " "}`, {
      key: `${key}:line:${index}`,
      fg,
      width,
      hangingIndent: "    ",
    }));
  }
  return output;
}

function approvalLines(item: Extract<ChatTranscriptItem, { kind: "approval" }>, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const tool = item.toolName ?? item.permission;
  const decision = item.decision ? ` ${item.decision}` : "";
  const summary = item.inputSummary ?? { title: tool, detail: item.patterns.join(", "), scope: item.patterns.join(", ") };
  const detail = summary.detail ?? summary.scope;
  return wrapLine(`approval ${tool} ${item.status}${decision}${detail ? ` ${detail}` : ""}`, {
    key: `${item.kind}:${item.id}`,
    fg: item.status === "pending" ? theme.colors.status.pending : item.decision === "deny" ? theme.colors.status.error : theme.colors.text.muted,
    width,
    hangingIndent: "  ",
  });
}

function markdownFg(tone: MarkdownLineTone, theme: TuiTheme): string {
  if (tone === "heading") return theme.colors.text.primary;
  if (tone === "quote" || tone === "code" || tone === "muted") return theme.colors.text.muted;
  return theme.colors.text.secondary;
}

function toolFg(tone: "muted" | "pending" | "error", theme: TuiTheme): string {
  if (tone === "error") return theme.colors.status.error;
  if (tone === "pending") return theme.colors.status.pending;
  return theme.colors.text.muted;
}

function wrapLine(text: string, options: { key: string; fg: string; width: number; hangingIndent?: string }): TranscriptLineModel[] {
  return wrapTerminalText(text, {
    key: options.key,
    width: options.width,
    ...(options.hangingIndent === undefined ? {} : { hangingIndent: options.hangingIndent }),
  }).map((line) => ({ key: line.key, text: line.text, fg: options.fg }));
}
