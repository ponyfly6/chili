import type { InputRenderable } from "@opentui/core";
import { useCallback, useRef } from "react";
import type { ChatRequestStatus } from "../useChatRuntime.js";
import type { SlashCompletion } from "../slash/types.js";
import type { TuiTheme } from "../theme/index.js";
import { commandListHeight, DEFAULT_COMMAND_LIST_MAX_ITEMS, CommandList } from "./CommandList.js";

export const PROMPT_PLACEHOLDER = 'Ask anything... "fix failing tests"';
export const PROMPT_INPUT_HEIGHT = 3;

export function PromptComposer(props: {
  width: number;
  prompt: string;
  disabled: boolean;
  disabledReason?: string | undefined;
  completions: readonly SlashCompletion[];
  completionOpen?: boolean | undefined;
  paletteOpen: boolean;
  paletteItems: readonly SlashCompletion[];
  paletteIndex: number;
  completionTitle?: string | undefined;
  emptyCompletionText?: string | undefined;
  focused: boolean;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  feedback?: { status: ChatRequestStatus | string; message: string } | undefined;
  completionIndex: number;
  theme: TuiTheme;
  maxCommandItems?: number | undefined;
}) {
  const inputRef = useRef<InputRenderable | null>(null);
  const colors = props.theme.colors;
  const placeholder = props.disabled && props.disabledReason ? props.disabledReason : PROMPT_PLACEHOLDER;
  const handlePromptInput = useCallback((value: string) => {
    props.onPromptChange(value);
    correctTrailingUnicodeCursor(inputRef.current, value);
  }, [props.onPromptChange]);
  const maxCommandItems = props.maxCommandItems ?? DEFAULT_COMMAND_LIST_MAX_ITEMS;
  const compactCommands = props.width < 72;
  const height = promptComposerHeight({
    completions: props.completions,
    completionOpen: props.completionOpen,
    paletteOpen: props.paletteOpen,
    paletteItems: props.paletteItems,
    feedback: props.feedback,
    maxCommandItems,
  });
  return (
    <box width={props.width} height={height} flexDirection="column">
      {props.feedback ? (
        <text fg={feedbackColor(props.feedback.status, props.theme)} wrapMode="none" truncate>
          {props.feedback.status === "error" ? props.feedback.message : `${props.feedback.status}: ${props.feedback.message}`}
        </text>
      ) : null}
      {props.paletteOpen ? (
        <CommandList title="Command Palette" items={props.paletteItems} selectedIndex={props.paletteIndex} maxItems={maxCommandItems} compact={compactCommands} theme={props.theme} />
      ) : props.completionOpen || props.completions.length > 0 ? (
        <CommandList title={props.completionTitle ?? "Commands"} items={props.completions} selectedIndex={props.completionIndex} maxItems={maxCommandItems} compact={compactCommands} theme={props.theme} emptyText={props.emptyCompletionText} />
      ) : null}
      <box width="100%" height={PROMPT_INPUT_HEIGHT} border borderStyle="single" borderColor={props.disabled ? colors.input.disabledBorder : colors.border.default} paddingX={1} alignItems="center">
        <text fg={props.disabled ? colors.input.disabledText : colors.input.text} wrapMode="none" truncate>{"> "}</text>
        {props.disabled ? (
          <text fg={colors.input.disabledText} wrapMode="none" truncate>{props.prompt || placeholder}</text>
        ) : (
          <input
            ref={inputRef}
            width={Math.max(1, props.width - 6)}
            value={props.prompt}
            placeholder={placeholder}
            focused={props.focused}
            showCursor={props.focused}
            textColor={colors.input.text}
            focusedTextColor={colors.input.text}
            backgroundColor={colors.input.background}
            focusedBackgroundColor={colors.input.background}
            placeholderColor={colors.input.placeholder}
            cursorColor={colors.input.cursor}
            cursorStyle={{ style: "block", blinking: true }}
            onInput={handlePromptInput}
            onChange={props.onPromptChange}
            onSubmit={props.onSubmit}
          />
        )}
      </box>
    </box>
  );
}

export function promptComposerHeight(input: {
  completions: readonly SlashCompletion[];
  completionOpen?: boolean | undefined;
  paletteOpen: boolean;
  paletteItems: readonly SlashCompletion[];
  feedback?: unknown;
  maxCommandItems?: number | undefined;
}): number {
  const maxCommandItems = input.maxCommandItems ?? DEFAULT_COMMAND_LIST_MAX_ITEMS;
  const commandItems = input.paletteOpen ? input.paletteItems : input.completions;
  const commandHeight = input.paletteOpen || input.completionOpen || input.completions.length > 0
    ? commandListHeight(commandItems, maxCommandItems)
    : 0;
  return PROMPT_INPUT_HEIGHT + commandHeight + (input.feedback ? 1 : 0);
}

function correctTrailingUnicodeCursor(input: InputRenderable | null, value: string): void {
  if (!input || !value) return;

  // OpenTUI's input reports cursor offsets as UTF-16 positions after text input.
  // For wide Unicode graphemes (emoji, CJK), that places the native terminal
  // cursor too far to the right when the user is typing at the end of the prompt.
  // The editor accepts display-cell offsets for end positions, so normalize only
  // trailing cursors and leave mid-line navigation/edits untouched.
  const width = terminalDisplayWidth(value);
  if (input.cursorOffset < width) return;
  if (width !== input.cursorOffset) input.cursorOffset = width;
}

function terminalDisplayWidth(value: string): number {
  let width = 0;
  for (const cluster of graphemeClusters(value)) {
    width += graphemeDisplayWidth(cluster);
  }
  return width;
}

function graphemeClusters(value: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), (segment) => segment.segment);
  }
  return Array.from(value);
}

function graphemeDisplayWidth(cluster: string): number {
  if (cluster.length === 0) return 0;
  if (isZeroWidthCluster(cluster)) return 0;
  if (isWideCluster(cluster)) return 2;
  return 1;
}

function isZeroWidthCluster(cluster: string): boolean {
  return /^[\u0300-\u036f\ufe00-\ufe0f\u200d]+$/u.test(cluster);
}

function isWideCluster(cluster: string): boolean {
  return /\p{Extended_Pictographic}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(cluster);
}

function feedbackColor(status: string, theme: TuiTheme): string {
  if (status === "success") return theme.colors.status.success;
  if (status === "error") return theme.colors.status.error;
  if (status === "pending") return theme.colors.status.pending;
  return theme.colors.text.muted;
}
