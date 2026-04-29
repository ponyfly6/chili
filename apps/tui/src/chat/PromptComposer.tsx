import type { ChatRequestStatus } from "../useChatRuntime.js";
import type { SlashCompletion } from "../slash/types.js";
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
}) {
  const placeholder = props.disabled && props.disabledReason ? props.disabledReason : PROMPT_PLACEHOLDER;
  return (
    <box width={props.width} flexDirection="column">
      {props.paletteOpen ? (
        <CommandList title="Command Palette" items={props.paletteItems} selectedIndex={props.paletteIndex} />
      ) : props.completions.length > 0 ? (
        <CommandList title="Commands" items={props.completions} selectedIndex={0} />
      ) : null}
      {props.feedback ? (
        <text fg={feedbackColor(props.feedback.status)} wrapMode="none" truncate>
          {props.feedback.status === "error" ? props.feedback.message : `${props.feedback.status}: ${props.feedback.message}`}
        </text>
      ) : null}
      <box width="100%" height={3} border borderStyle="single" borderColor={props.disabled ? "#262b33" : "#30363d"} paddingX={1} alignItems="center">
        <text fg={props.disabled ? "#8f9baa" : "#f8f8f2"} wrapMode="none" truncate>{"> "}</text>
        {props.disabled ? (
          <text fg="#8f9baa" wrapMode="none" truncate>{props.prompt || placeholder}</text>
        ) : (
          <input
            width={Math.max(1, props.width - 6)}
            value={props.prompt}
            placeholder={placeholder}
            focused={props.focused}
            showCursor={props.focused}
            textColor="#f8f8f2"
            focusedTextColor="#f8f8f2"
            backgroundColor="#050505"
            focusedBackgroundColor="#050505"
            placeholderColor="#6e7681"
            cursorColor="#f8f8f2"
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

function feedbackColor(status: string): string {
  if (status === "success") return "#a3be8c";
  if (status === "error") return "#ff7b72";
  if (status === "pending") return "#ffd166";
  return "#8f9baa";
}
