import type { ChatSessionView } from "@chili/sdk";
import type { TuiTheme } from "../theme/index.js";
import { wrapTerminalText } from "./markdown.js";
import { buildTranscriptLines, type TranscriptLineTone, type TranscriptSourceLine } from "./transcript.js";
import type { LocalTranscriptItem } from "./types.js";

export function TranscriptView(props: {
  chatView: ChatSessionView;
  localItems: readonly LocalTranscriptItem[];
  width?: number;
  visibleLimit?: number;
  scrollOffset?: number;
  theme: TuiTheme;
}) {
  const width = Math.max(24, props.width ?? 80);
  const sourceLines = [
    ...buildTranscriptLines(props.chatView.items),
    ...props.localItems.flatMap(localTranscriptSourceLines),
  ];
  const allLines = sourceLines.flatMap((line) => wrapSourceLine(line, width, props.theme));
  const limit = Math.max(1, props.visibleLimit ?? 18);
  const bodyLimit = Math.max(1, limit - 1);
  const maxOffset = Math.max(0, allLines.length - bodyLimit);
  const offset = Math.min(Math.max(0, props.scrollOffset ?? 0), maxOffset);
  const end = allLines.length - offset;
  const start = Math.max(0, end - bodyLimit);
  const lines = allLines.slice(start, end);
  const title = allLines.length > bodyLimit
    ? `Transcript ${start + 1}-${end}/${allLines.length} PgUp/PgDn Shift+Up/Down Esc chat`
    : "Transcript";

  return (
    <box width="100%" height="100%" flexDirection="column">
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{title}</text>
      {lines.length === 0 ? (
        <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{"No transcript items yet."}</text>
      ) : (
        lines.map((line) => <TranscriptLine key={line.key} line={line} />)
      )}
    </box>
  );
}

function localTranscriptSourceLines(item: LocalTranscriptItem): TranscriptSourceLine[] {
  if (item.kind === "local") {
    return [{
      key: item.id,
      text: `${item.level}: ${item.text}`,
      tone: item.level === "error" ? "error" as const : "muted" as const,
    }];
  }

  const lines: TranscriptSourceLine[] = [{
    key: `${item.id}:command`,
    text: `! ${item.command}`,
    tone: "text",
  }];
  const output = item.output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (output.at(-1) === "") output.pop();
  if (output.length === 0) {
    lines.push({ key: `${item.id}:empty`, text: "  (no output)", tone: "muted" });
  } else {
    output.slice(0, 80).forEach((line, index) => {
      lines.push({ key: `${item.id}:output:${index}`, text: `  ${line}`, tone: "text" });
    });
    if (output.length > 80) {
      lines.push({ key: `${item.id}:truncated-view`, text: "  [output preview truncated after 80 lines]", tone: "muted" });
    }
  }
  if (item.stdoutTruncated) lines.push({ key: `${item.id}:stdout-truncated`, text: "  stdout truncated", tone: "muted" });
  if (item.stderrTruncated) lines.push({ key: `${item.id}:stderr-truncated`, text: "  stderr truncated", tone: "muted" });
  if (item.timedOut) lines.push({ key: `${item.id}:timed-out`, text: "  process timed out", tone: "muted" });
  if (item.error) lines.push({ key: `${item.id}:error`, text: `  ${item.error}`, tone: "error" });
  lines.push({
    key: `${item.id}:status`,
    text: `  ${localShellStatusText(item)}`,
    tone: item.status === "completed" && item.exitCode === 0 ? "muted" : item.status === "running" ? "muted" : "error",
  });
  return lines;
}

function localShellStatusText(item: Extract<LocalTranscriptItem, { kind: "shell" }>): string {
  if (item.status === "running") return `running in ${item.cwd}`;
  const duration = item.durationMs === undefined ? "" : ` in ${item.durationMs}ms`;
  if (item.exitCode !== undefined) return `exit ${item.exitCode ?? "signal"}${duration}`;
  if (item.signal !== undefined && item.signal !== null) return `signal ${item.signal}${duration}`;
  return item.status;
}

interface WrappedTranscriptLine {
  key: string;
  text: string;
  fg: string;
}

function TranscriptLine(props: { line: WrappedTranscriptLine }) {
  return (
    <text fg={props.line.fg} wrapMode="none" truncate>
      {props.line.text}
    </text>
  );
}

function wrapSourceLine(line: TranscriptSourceLine, width: number, theme: TuiTheme): WrappedTranscriptLine[] {
  const hangingIndent = continuationIndent(line.text);
  return wrapTerminalText(line.text, {
    key: `transcript:${line.key}`,
    width,
    hangingIndent,
  }).map((wrapped) => ({
    key: wrapped.key,
    text: wrapped.text,
    fg: transcriptFg(line.tone, theme),
  }));
}

function continuationIndent(text: string): string {
  const leading = text.match(/^\s*/)?.[0] ?? "";
  return `${leading}  `;
}

function transcriptFg(tone: TranscriptLineTone, theme: TuiTheme): string {
  if (tone === "heading") return theme.colors.text.primary;
  if (tone === "error") return theme.colors.status.error;
  if (tone === "muted") return theme.colors.text.muted;
  return theme.colors.text.secondary;
}
