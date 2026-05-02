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
  const colors = props.theme.colors;
  const placeholder = props.disabled && props.disabledReason ? props.disabledReason : PROMPT_PLACEHOLDER;
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
            onInput={props.onPromptChange}
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

function feedbackColor(status: string, theme: TuiTheme): string {
  if (status === "success") return theme.colors.status.success;
  if (status === "error") return theme.colors.status.error;
  if (status === "pending") return theme.colors.status.pending;
  return theme.colors.text.muted;
}
