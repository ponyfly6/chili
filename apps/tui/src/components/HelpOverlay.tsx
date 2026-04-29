export function HelpOverlay() {
  return (
    <box position="absolute" left={4} top={2} width="88%" height={18} flexDirection="column" border borderStyle="double" borderColor="#88c0d0" backgroundColor="#111827" zIndex={20} paddingX={2} paddingY={1}>
      <text fg="#f8f8f2" truncate>{"Team Live Help"}</text>
      <text fg="#d8dee9" truncate>{"q / Ctrl+C  exit"}</text>
      <text fg="#d8dee9" truncate>{"r           reconnect stream"}</text>
      <text fg="#d8dee9" truncate>{"Tab         next region"}</text>
      <text fg="#d8dee9" truncate>{"Shift+Tab   previous region"}</text>
      <text fg="#d8dee9" truncate>{"Up / Down   select item"}</text>
      <text fg="#d8dee9" truncate>{"Enter       open detail or execute selected action"}</text>
      <text fg="#d8dee9" truncate>{"a           approve selected pending approval"}</text>
      <text fg="#d8dee9" truncate>{"x           reject selected approval or interrupt session"}</text>
      <text fg="#d8dee9" truncate>{"m           merge selected pending task"}</text>
      <text fg="#d8dee9" truncate>{"l           run team loop"}</text>
      <text fg="#d8dee9" truncate>{"Esc         close overlay or detail"}</text>
    </box>
  );
}
