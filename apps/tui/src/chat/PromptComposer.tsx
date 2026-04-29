import type { ChatRequestStatus } from "../useChatRuntime.js";
import type { SlashCompletion } from "../slash/types.js";
import type { TuiTheme } from "../theme/index.js";
import { CommandList } from "./CommandList.js";

export const PROMPT_PLACEHOLDER = 'Ask anything... "fix failing tests"';

export function PromptComposer(props: {
  width: number;
  prompt: string;
  disabled: boolean;
  disabledReason?: string | undefined;
  completions: readonly SlashCompletion[];
  paletteOpen: boolean;
  paletteItems: readonly SlashCompletion[];
  paletteIndex: number;
  focused: boolean;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  feedback?: { status: ChatRequestStatus | string; message: string } | undefined;
  completionIndex: number;
  theme: TuiTheme;
}) {
  const colors = props.theme.colors;
  const placeholder = props.disabled && props.disabledReason ? props.disabledReason : PROMPT_PLACEHOLDER;
  return (
    <box width={props.width} flexDirection="column">
      {props.paletteOpen ? (
        <CommandList title="Command Palette" items={props.paletteItems} selectedIndex={props.paletteIndex} theme={props.theme} />
      ) : props.completions.length > 0 ? (
        <CommandList title="Commands" items={props.completions} selectedIndex={props.completionIndex} theme={props.theme} />
      ) : null}
      {props.feedback ? (
        <text fg={feedbackColor(props.feedback.status, props.theme)} wrapMode="none" truncate>
          {props.feedback.status === "error" ? props.feedback.message : `${props.feedback.status}: ${props.feedback.message}`}
        </text>
      ) : null}
      <box width="100%" height={3} border borderStyle="single" borderColor={props.disabled ? colors.input.disabledBorder : colors.border.default} paddingX={1} alignItems="center">
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

function feedbackColor(status: string, theme: TuiTheme): string {
  if (status === "success") return theme.colors.status.success;
  if (status === "error") return theme.colors.status.error;
  if (status === "pending") return theme.colors.status.pending;
  return theme.colors.text.muted;
}
