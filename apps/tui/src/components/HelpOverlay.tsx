import type { TuiTheme } from "../theme/index.js";

export function HelpOverlay(props: { theme: TuiTheme }) {
  const { theme } = props;
  return (
    <box position="absolute" left={4} top={2} width="88%" height={18} flexDirection="column" border borderStyle="double" borderColor={theme.colors.border.focus} backgroundColor={theme.colors.overlay} zIndex={20} paddingX={2} paddingY={1}>
      <text fg={theme.colors.text.primary} truncate>{"Team Live Help"}</text>
      <text fg={theme.colors.text.secondary} truncate>{"q / Ctrl+C  exit"}</text>
      <text fg={theme.colors.text.secondary} truncate>{"r           reconnect stream"}</text>
      <text fg={theme.colors.text.secondary} truncate>{"Tab         next region"}</text>
      <text fg={theme.colors.text.secondary} truncate>{"Shift+Tab   previous region"}</text>
      <text fg={theme.colors.text.secondary} truncate>{"Up / Down   select item"}</text>
      <text fg={theme.colors.text.secondary} truncate>{"Enter       open detail or execute selected action"}</text>
      <text fg={theme.colors.text.secondary} truncate>{"a           approve selected pending approval"}</text>
      <text fg={theme.colors.text.secondary} truncate>{"x           reject selected approval or interrupt session"}</text>
      <text fg={theme.colors.text.secondary} truncate>{"m           merge selected pending task"}</text>
      <text fg={theme.colors.text.secondary} truncate>{"l           run team loop"}</text>
      <text fg={theme.colors.text.secondary} truncate>{"Esc         close overlay or detail"}</text>
    </box>
  );
}
