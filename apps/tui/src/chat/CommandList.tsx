import type { SlashCompletion } from "../slash/types.js";
import type { TuiTheme } from "../theme/index.js";

export function CommandList(props: {
  title: string;
  items: readonly SlashCompletion[];
  selectedIndex: number;
  theme: TuiTheme;
}) {
  return (
    <box width="100%" flexDirection="column" border borderStyle="single" borderColor={props.theme.colors.border.default} paddingX={1}>
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{props.title}</text>
      {props.items.length === 0 ? (
        <text fg={props.theme.colors.menu.muted} wrapMode="none" truncate>{"  no commands"}</text>
      ) : (
        props.items.slice(0, 8).map((item, index) => (
          <text
            key={item.value}
            fg={index === props.selectedIndex ? props.theme.colors.menu.selectedText : props.theme.colors.menu.text}
            bg={index === props.selectedIndex ? props.theme.colors.menu.selectedBackground : props.theme.colors.menu.background}
            wrapMode="none"
            truncate
          >
            {`${index === props.selectedIndex ? ">" : " "} ${item.label} - ${item.description}`}
          </text>
        ))
      )}
    </box>
  );
}
