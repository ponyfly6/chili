import type { ChatMessagePart, ChatSessionView, ChatTranscriptItem } from "@chili/sdk";
import { shorten } from "../components/helpers.js";
import type { LocalTranscriptItem } from "./types.js";

export function MessageList(props: {
  chatView: ChatSessionView;
  localItems: readonly LocalTranscriptItem[];
  width?: number;
  visibleLimit?: number;
  scrollOffset?: number;
}) {
  const allItems = [...props.chatView.items, ...props.localItems];
  const allLines = transcriptLines(allItems, Math.max(24, props.width ?? 80));
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
        <text fg="#6e7681" wrapMode="none" truncate>{"Start a conversation from the prompt below."}</text>
      ) : (
        <>
          {allLines.length > contentLimit ? (
            <text fg="#6e7681" wrapMode="none" truncate>
              {`History ${start + 1}-${end}/${allLines.length} PgUp/PgDn Ctrl+Y/V`}
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

function transcriptLines(items: readonly TranscriptSourceItem[], width: number): TranscriptLineModel[] {
  return items.flatMap((item) => {
    if (item.kind === "local") {
      return wrapLine(`${item.level}: ${item.text}`, {
        key: item.id,
        fg: item.level === "error" ? "#ff7b72" : "#8f9baa",
        width,
      });
    }
    if (item.kind === "message") {
      const role = item.role === "user" ? "You" : item.role;
      const fg = item.role === "user" ? "#f8f8f2" : "#a3be8c";
      const body = messageText(item.parts);
      return wrapLine(`${role}: ${body || "..."}`, {
        key: `${item.kind}:${item.id}`,
        fg,
        width,
        hangingIndent: "    ",
      });
    }
    if (item.kind === "tool") {
      const suffix = item.error ? ` error:${shorten(item.error, 120)}` : item.output ? ` output:${shorten(item.output, 120)}` : "";
      return wrapLine(`tool ${item.toolName} ${item.status}${suffix}`, {
        key: `${item.kind}:${item.id}`,
        fg: item.status === "failed" ? "#ff7b72" : "#8f9baa",
        width,
      });
    }
    return wrapLine(`approval ${item.permission} ${item.status}`, {
      key: `${item.kind}:${item.id}`,
      fg: item.status === "pending" ? "#ffd166" : "#8f9baa",
      width,
    });
  });
}

function messageText(parts: readonly ChatMessagePart[]): string {
  return parts.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "reasoning") return `thinking: ${part.text}`;
    if (part.type === "tool_call") return `tool ${part.toolName} ${part.status}`;
    if (part.type === "tool_result") return `result ${part.callId} ${shorten(part.error ?? part.output, 100)}`;
    return part.text;
  }).join(" ");
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
