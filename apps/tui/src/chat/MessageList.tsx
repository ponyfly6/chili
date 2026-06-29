import type { ChatSessionView, ChatTranscriptItem } from "@chili/sdk";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { Ref } from "react";
import { shorten } from "../components/helpers.js";
import type { TuiTheme } from "../theme/index.js";
import { AssistantMarkdownCell, assistantTextCellLines } from "./AssistantCells.js";
import { componentBackedCell, lineBackedCell, TranscriptCellView, type TranscriptCellModel } from "./cells.js";
import { type OpenFileLinkHandler, type TranscriptLineModel, wrapLine } from "./lines.js";
import { localTranscriptItemTime } from "./local-transcript.js";
import { buildChatDisplayItems, groupExplorationTools, type ChatDisplayItem } from "./presentation.js";
import { ToolCell, ToolGroupCell, toolCellLines, toolGroupCellLines } from "./ToolCells.js";
import type { LocalTranscriptItem } from "./types.js";

export function MessageList(props: {
  chatView: ChatSessionView;
  localItems: readonly LocalTranscriptItem[];
  width?: number;
  scrollRef?: Ref<ScrollBoxRenderable> | undefined;
  showToolDetails?: boolean;
  hideThinking?: boolean;
  cwd?: string | undefined;
  onOpenFile?: OpenFileLinkHandler | undefined;
  theme: TuiTheme;
}) {
  const allCells = transcriptCells(props.chatView.items, props.localItems, {
    width: Math.max(24, props.width ?? 80),
    showToolDetails: props.showToolDetails === true,
    hideThinking: props.hideThinking === true,
    sessionStatus: props.chatView.status,
    activeToolCount: props.chatView.activeTools.length,
    theme: props.theme,
    cwd: props.cwd ?? process.cwd(),
  });
  const selectionColors = {
    selectionBg: props.theme.colors.menu.selectedBackground,
    selectionFg: props.theme.colors.menu.selectedText,
  };
  return (
    <scrollbox
      {...(props.scrollRef === undefined ? {} : { ref: props.scrollRef })}
      width="100%"
      height="100%"
      scrollY
      scrollX={false}
      stickyScroll
      stickyStart="bottom"
      viewportCulling
      contentOptions={{ flexDirection: "column" }}
      verticalScrollbarOptions={{ visible: false, width: 0 }}
      horizontalScrollbarOptions={{ visible: false, height: 0 }}
    >
      {allCells.length === 0 ? (
        <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{"Start a conversation from the prompt below."}</text>
      ) : (
        allCells.map((cell) => (
          <TranscriptCellView
            key={cell.key}
            cell={cell}
            onOpenFile={props.onOpenFile}
            selectionColors={selectionColors}
          />
        ))
      )}
    </scrollbox>
  );
}

function transcriptCells(
  items: readonly ChatTranscriptItem[],
  localItems: readonly LocalTranscriptItem[],
  options: { width: number; showToolDetails: boolean; hideThinking: boolean; sessionStatus: ChatSessionView["status"]; activeToolCount: number; theme: TuiTheme; cwd: string },
): TranscriptCellModel[] {
  const displayItems = buildChatDisplayItems(items, {
    showToolDetails: options.showToolDetails,
    hideThinking: options.hideThinking,
    sessionStatus: options.sessionStatus,
    activeToolCount: options.activeToolCount,
    groupExplorationTools: localItems.length === 0,
  });
  if (localItems.length === 0) {
    return displayItems.map((item) => displayItemCell(item, options.width, options.theme, options.hideThinking, options.cwd));
  }

  const output: TranscriptCellModel[] = [];
  let pendingDisplayItems: ChatDisplayItem[] = [];
  const flushDisplayItems = () => {
    if (pendingDisplayItems.length === 0) return;
    output.push(...groupExplorationTools(pendingDisplayItems).map((item) => displayItemCell(item, options.width, options.theme, options.hideThinking, options.cwd)));
    pendingDisplayItems = [];
  };

  for (const entry of chronologicalDisplayEntries(displayItems, localItems)) {
    if (entry.kind === "display") {
      pendingDisplayItems.push(entry.item);
      continue;
    }
    flushDisplayItems();
    output.push(localItemCell(entry.item, options.width, options.theme));
  }
  flushDisplayItems();
  return output;
}

type ChronologicalDisplayEntry =
  | { kind: "display"; item: ChatDisplayItem; index: number }
  | { kind: "local"; item: LocalTranscriptItem; index: number };

type SortableDisplayEntry = ChronologicalDisplayEntry & {
  time: number;
  sourceOrder: number;
};

function chronologicalDisplayEntries(
  displayItems: readonly ChatDisplayItem[],
  localItems: readonly LocalTranscriptItem[],
): ChronologicalDisplayEntry[] {
  return [
    ...displayItems.map((item, index): SortableDisplayEntry => ({
      kind: "display",
      item,
      index,
      time: chatDisplayItemTime(item),
      sourceOrder: 0,
    })),
    ...localItems.map((item, index): SortableDisplayEntry => ({
      kind: "local",
      item,
      index,
      time: localTranscriptItemTime(item),
      sourceOrder: 1,
    })),
  ]
    .sort((left, right) => left.time - right.time || left.sourceOrder - right.sourceOrder || left.index - right.index)
    .map(({ kind, item, index }) => ({ kind, item, index }) as ChronologicalDisplayEntry);
}

function chatDisplayItemTime(item: ChatDisplayItem): number {
  return typeof item.time === "number" && Number.isFinite(item.time) ? item.time : Number.MAX_SAFE_INTEGER;
}

function displayItemCell(item: ChatDisplayItem, width: number, theme: TuiTheme, hideThinking: boolean, cwd: string): TranscriptCellModel {
  if (item.kind === "user_text") {
    return lineBackedCell(`display:${item.kind}:${item.id}`, wrapLine(`🥔: ${item.text || "..."}`, {
      key: `display:${item.kind}:${item.id}`,
      fg: theme.colors.text.primary,
      width,
      hangingIndent: "    ",
    }));
  }
  if (item.kind === "assistant_text") {
    const key = `display:${item.kind}:${item.id}`;
    const lines = assistantTextCellLines({
      key,
      text: item.text,
      streaming: item.streaming === true,
      width,
      theme,
      cwd,
    });
    return componentBackedCell({
      key,
      render: () => (
        <AssistantMarkdownCell
          cellKey={key}
          text={item.text}
          streaming={item.streaming === true}
          width={width}
          theme={theme}
          fallbackLines={lines}
        />
      ),
      fallbackLines: lines,
    });
  }
  if (item.kind === "user_image") {
    return lineBackedCell(`display:${item.kind}:${item.id}`, wrapLine(`image: ${item.label || "[image]"}`, {
      key: `display:${item.kind}:${item.id}`,
      fg: theme.colors.text.secondary,
      width,
      hangingIndent: "    ",
    }));
  }
  if (item.kind === "reasoning") return lineBackedCell(`display:${item.kind}:${item.id}`, reasoningLines(item, width, theme, hideThinking));
  if (item.kind === "tool_activity") {
    return componentBackedCell({
      key: `display:tool:${item.activity.id}`,
      render: () => <ToolCell activity={item.activity} width={width} theme={theme} />,
      fallbackLines: toolCellLines(item.activity, width, theme),
    });
  }
  if (item.kind === "tool_group") {
    return componentBackedCell({
      key: `display:${item.kind}:${item.id}`,
      render: () => <ToolGroupCell group={item} width={width} theme={theme} />,
      fallbackLines: toolGroupCellLines(item, width, theme),
    });
  }
  if (item.kind === "summary") {
    return lineBackedCell(`display:${item.kind}:${item.id}`, wrapLine(`summary: ${item.text || "..."}`, {
      key: `display:${item.kind}:${item.id}`,
      fg: theme.colors.text.muted,
      width,
      hangingIndent: "  ",
    }));
  }
  return lineBackedCell(`${item.approval.kind}:${item.approval.id}`, approvalLines(item.approval, width, theme));
}

function localItemCell(item: LocalTranscriptItem, width: number, theme: TuiTheme): TranscriptCellModel {
  if (item.kind === "shell") return lineBackedCell(item.id, shellItemLines(item, width, theme));
  return lineBackedCell(item.id, wrapLine(`${item.level}: ${item.text}`, {
    key: item.id,
    fg: item.level === "error" ? theme.colors.status.error : theme.colors.text.muted,
    width,
  }));
}

function shellItemLines(item: Extract<LocalTranscriptItem, { kind: "shell" }>, width: number, theme: TuiTheme): TranscriptLineModel[] {
  const lines: TranscriptLineModel[] = [];
  lines.push(...wrapLine(`! ${item.command}`, {
    key: `${item.id}:command`,
    fg: theme.colors.text.primary,
    width,
    hangingIndent: "  ",
  }));

  if (item.status === "running" && !item.output) {
    lines.push(...wrapLine(`  running in ${item.cwd}`, {
      key: `${item.id}:running`,
      fg: theme.colors.status.pending,
      width,
      hangingIndent: "    ",
    }));
    return lines;
  }

  const outputLines = shellOutputPreviewLines(item.output);
  if (outputLines.length === 0) {
    lines.push(...wrapLine("  (no output)", {
      key: `${item.id}:empty`,
      fg: theme.colors.text.muted,
      width,
      hangingIndent: "    ",
    }));
  } else {
    outputLines.forEach((text, index) => {
      lines.push(...wrapLine(`  ${text}`, {
        key: `${item.id}:output:${index}`,
        fg: theme.colors.text.secondary,
        width,
        hangingIndent: "    ",
      }));
    });
  }

  for (const warning of shellOutputWarnings(item)) {
    lines.push(...wrapLine(`  ${warning}`, {
      key: `${item.id}:warning:${warning}`,
      fg: theme.colors.text.muted,
      width,
      hangingIndent: "    ",
    }));
  }

  lines.push(...wrapLine(`  ${shellStatusText(item)}`, {
    key: `${item.id}:status`,
    fg: item.status === "completed" && item.exitCode === 0 ? theme.colors.status.success : item.status === "running" ? theme.colors.status.pending : theme.colors.status.error,
    width,
    hangingIndent: "    ",
  }));
  return lines;
}

function shellOutputPreviewLines(output: string): string[] {
  if (!output) return [];
  const lines = output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const limit = 80;
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `[output preview truncated after ${limit} lines]`];
}

function shellOutputWarnings(item: Extract<LocalTranscriptItem, { kind: "shell" }>): string[] {
  const warnings: string[] = [];
  if (item.stdoutTruncated) warnings.push("stdout truncated");
  if (item.stderrTruncated) warnings.push("stderr truncated");
  if (item.timedOut) warnings.push("process timed out");
  if (item.error) warnings.push(item.error);
  return warnings;
}

function shellStatusText(item: Extract<LocalTranscriptItem, { kind: "shell" }>): string {
  if (item.status === "running") return `running in ${item.cwd}`;
  const duration = item.durationMs === undefined ? "" : ` in ${item.durationMs}ms`;
  if (item.exitCode !== undefined) return `exit ${item.exitCode ?? "signal"}${duration}`;
  if (item.signal !== undefined && item.signal !== null) return `signal ${item.signal}${duration}`;
  return item.status;
}

function reasoningLines(item: Extract<ChatDisplayItem, { kind: "reasoning" }>, width: number, theme: TuiTheme, hideThinking: boolean): TranscriptLineModel[] {
  const hiddenText = item.active === true ? "🫧 thinking..." : "🫧";
  const visibleThinking = item.active === true ? (item.text || "thinking...") : item.text;
  const text = hideThinking ? hiddenText : `Thinking: ${shorten((visibleThinking || "...").replace(/\s+/g, " ").trim(), 180)}`;
  return wrapLine(text, {
    key: `display:${item.kind}:${item.id}`,
    fg: theme.colors.text.muted,
    width,
    hangingIndent: "  ",
  });
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
