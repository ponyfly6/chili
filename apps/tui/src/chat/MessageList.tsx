import type { ChatMessagePart, ChatMessageRow, ChatSessionView, ChatToolCallRow, ChatTranscriptItem } from "@chili/sdk";
import { shorten } from "../components/helpers.js";
import type { TuiTheme } from "../theme/index.js";
import type { LocalTranscriptItem } from "./types.js";

export function MessageList(props: {
  chatView: ChatSessionView;
  localItems: readonly LocalTranscriptItem[];
  width?: number;
  visibleLimit?: number;
  scrollOffset?: number;
  theme: TuiTheme;
}) {
  const allItems = [...props.chatView.items, ...props.localItems];
  const allLines = transcriptLines(allItems, Math.max(24, props.width ?? 80), props.theme);
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

type TranscriptSourceItem = ChatTranscriptItem | LocalTranscriptItem;

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

function transcriptLines(items: readonly TranscriptSourceItem[], width: number, theme: TuiTheme): TranscriptLineModel[] {
  return items.flatMap((item) => {
    if (item.kind === "local") {
      return wrapLine(`${item.level}: ${item.text}`, {
        key: item.id,
        fg: item.level === "error" ? theme.colors.status.error : theme.colors.text.muted,
        width,
      });
    }
    if (item.kind === "message") return messageLines(item, width, theme);
    if (item.kind === "tool") return toolLines(item, width, theme);
    return approvalLines(item, width, theme);
  });
}

function messageLines(item: ChatMessageRow, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const role = item.role === "user" ? "You" : item.role === "assistant" ? "Assistant" : item.role;
  const fg = item.role === "user" ? theme.colors.text.primary : theme.colors.text.secondary;
  const lines: TranscriptLineModel[] = [];
  for (const [index, part] of item.parts.entries()) {
    if (part.type === "text") {
      lines.push(...wrapLine(`${role}: ${part.text || "..."}`, {
        key: `${item.kind}:${item.id}:text:${part.id}:${index}`,
        fg,
        width,
        hangingIndent: "    ",
      }));
      continue;
    }
    if (part.type === "reasoning") {
      lines.push(...reasoningLines(item, part, width, index, theme));
      continue;
    }
    if (part.type === "tool_result") {
      lines.push(...toolResultLines(`${item.kind}:${item.id}:result:${part.id}:${index}`, part.callId, part.error ?? part.output, Boolean(part.error), width, theme));
      continue;
    }
    if (part.type === "tool_call") {
      lines.push(...wrapLine(`tool ${part.toolName} ${part.displayStatus ?? part.status}`, {
        key: `${item.kind}:${item.id}:tool:${part.id}:${index}`,
        fg: theme.colors.text.muted,
        width,
      }));
      continue;
    }
    lines.push(...wrapLine(part.text, {
      key: `${item.kind}:${item.id}:summary:${part.id}:${index}`,
      fg: theme.colors.text.muted,
      width,
      hangingIndent: "    ",
    }));
  }
  if (lines.length === 0) {
    return wrapLine(`${role}: ...`, {
      key: `${item.kind}:${item.id}`,
      fg,
      width,
      hangingIndent: "    ",
    });
  }
  return lines;
}

function reasoningLines(item: ChatMessageRow, part: Extract<ChatMessagePart, { type: "reasoning" }>, width: number, index: number, theme: TuiTheme): TranscriptLineModel[] {
  const lines: TranscriptLineModel[] = [
    { key: `${item.kind}:${item.id}:thinking:${part.id}:${index}:label`, fg: theme.colors.text.muted, text: "Thinking" },
  ];
  lines.push(...wrapLine(`| ${part.text || "..."}`, {
    key: `${item.kind}:${item.id}:thinking:${part.id}:${index}`,
    fg: theme.colors.text.muted,
    width,
    hangingIndent: "| ",
  }));
  return lines;
}

function toolLines(item: ChatToolCallRow, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const displayStatus = item.displayStatus ?? item.status;
  const bits = [`tool ${item.toolName}`, displayStatus];
  const detail = toolDetail(item);
  if (detail) bits.push(detail);
  const fg = displayStatus === "failed" || displayStatus === "rejected"
    ? theme.colors.status.error
    : displayStatus === "waiting_permission"
      ? theme.colors.status.pending
      : theme.colors.text.muted;
  const lines = wrapLine(bits.join(" "), {
    key: `${item.kind}:${item.id}`,
    fg,
    width,
    hangingIndent: "  ",
  });
  if (item.error) {
    lines.push(...toolResultLines(`${item.kind}:${item.id}:error`, item.id, item.error, true, width, theme));
  } else if (item.output) {
    lines.push(...toolResultLines(`${item.kind}:${item.id}:output`, item.id, item.output, false, width, theme));
  }
  return lines;
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

function toolDetail(item: ChatToolCallRow): string | undefined {
  const summary = item.inputSummary ?? { title: item.toolName };
  if (summary.command) return summary.command;
  if (summary.diffSummary && summary.path) return `${summary.path} ${summary.diffSummary}`;
  if (summary.path) return summary.path;
  if (summary.pattern && summary.scope) return `${summary.pattern} in ${summary.scope}`;
  if (summary.pattern) return summary.pattern;
  return summary.detail ?? summary.scope;
}

function toolResultLines(key: string, callId: string, value: string, error: boolean, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const fg = error ? theme.colors.status.error : theme.colors.text.muted;
  const label = error ? "error" : "result";
  if (!isLargeOutput(value)) {
    return wrapLine(`${label} ${callId}: ${shorten(value.replace(/\s+/g, " ").trim(), 140)}`, {
      key,
      fg,
      width,
      hangingIndent: "  ",
    });
  }
  const preview = value.split("\n").slice(0, 8).join("\n");
  return [
    { key: `${key}:head`, fg, text: `${label} ${callId}` },
    ...wrapLine(preview, {
      key: `${key}:body`,
      fg,
      width,
      hangingIndent: "  ",
    }),
  ];
}

function isLargeOutput(value: string): boolean {
  return value.length > 180 || value.includes("\n") || /^diff --git/m.test(value);
}

function wrapLine(text: string, options: { key: string; fg: string; width: number; hangingIndent?: string }): TranscriptLineModel[] {
  const lines: TranscriptLineModel[] = [];
  const paragraphs = text.split("\n");
  const width = Math.max(8, options.width);
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const source = paragraph.length > 0 ? paragraph : " ";
    let current = "";
    let currentWidth = 0;
    let lineIndex = 0;
    const push = () => {
      const prefix = lineIndex === 0 ? "" : options.hangingIndent ?? "";
      lines.push({
        key: `${options.key}:${paragraphIndex}:${lineIndex}`,
        fg: options.fg,
        text: `${prefix}${current || " "}`,
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
