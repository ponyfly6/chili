import type { ChatSessionView, ChatTranscriptItem } from "@chili/sdk";
import { shorten } from "../components/helpers.js";
import type { TuiTheme } from "../theme/index.js";
import { AssistantMarkdownCell, assistantTextCellLines } from "./AssistantCells.js";
import { componentBackedCell, lineBackedCell, TranscriptCellSliceView, type TranscriptCellModel, windowTranscriptCells } from "./cells.js";
import { type TranscriptLineModel, wrapLine } from "./lines.js";
import { buildChatDisplayItems, type ChatDisplayItem } from "./presentation.js";
import { ToolCell, ToolGroupCell, toolCellLines, toolGroupCellLines } from "./ToolCells.js";
import type { LocalTranscriptItem } from "./types.js";

export function MessageList(props: {
  chatView: ChatSessionView;
  localItems: readonly LocalTranscriptItem[];
  width?: number;
  visibleLimit?: number;
  scrollOffset?: number;
  showToolDetails?: boolean;
  hideThinking?: boolean;
  theme: TuiTheme;
}) {
  const allCells = transcriptCells(props.chatView.items, props.localItems, {
    width: Math.max(24, props.width ?? 80),
    showToolDetails: props.showToolDetails === true,
    hideThinking: props.hideThinking === true,
    sessionStatus: props.chatView.status,
    activeToolCount: props.chatView.activeTools.length,
    theme: props.theme,
  });
  const limit = Math.max(1, props.visibleLimit ?? 18);
  const window = windowTranscriptCells(allCells, { visibleLimit: limit, scrollOffset: props.scrollOffset });
  return (
    <box width="100%" height="100%" flexDirection="column">
      {window.totalLineCount === 0 ? (
        <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{"Start a conversation from the prompt below."}</text>
      ) : (
        <>
          {window.totalLineCount > window.contentLimit ? (
            <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>
              {`History ${window.startLine + 1}-${window.endLine}/${window.totalLineCount} PgUp/PgDn Shift+Up/Down`}
            </text>
          ) : null}
          {window.slices.map((slice) => <TranscriptCellSliceView key={slice.key} slice={slice} />)}
        </>
      )}
    </box>
  );
}

function transcriptCells(
  items: readonly ChatTranscriptItem[],
  localItems: readonly LocalTranscriptItem[],
  options: { width: number; showToolDetails: boolean; hideThinking: boolean; sessionStatus: ChatSessionView["status"]; activeToolCount: number; theme: TuiTheme },
): TranscriptCellModel[] {
  const displayItems = buildChatDisplayItems(items, {
    showToolDetails: options.showToolDetails,
    hideThinking: options.hideThinking,
    sessionStatus: options.sessionStatus,
    activeToolCount: options.activeToolCount,
  });
  return [
    ...displayItems.map((item) => displayItemCell(item, options.width, options.theme, options.hideThinking)),
    ...localItems.map((item) => localItemCell(item, options.width, options.theme)),
  ];
}

function displayItemCell(item: ChatDisplayItem, width: number, theme: TuiTheme, hideThinking: boolean): TranscriptCellModel {
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
  return lineBackedCell(item.id, wrapLine(`${item.level}: ${item.text}`, {
    key: item.id,
    fg: item.level === "error" ? theme.colors.status.error : theme.colors.text.muted,
    width,
  }));
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
