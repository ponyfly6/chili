import type { SlashCompletion } from "../slash/types.js";

export function CommandList(props: {
  title: string;
  items: readonly SlashCompletion[];
  selectedIndex: number;
}) {
  return (
    <box width="100%" flexDirection="column" border borderStyle="single" borderColor="#30363d" paddingX={1}>
      <text fg="#f8f8f2" wrapMode="none" truncate>{props.title}</text>
      {props.items.length === 0 ? (
        <text fg="#6e7681" wrapMode="none" truncate>{"  no commands"}</text>
      ) : (
        props.items.slice(0, 8).map((item, index) => (
          <text key={item.value} fg={index === props.selectedIndex ? "#f8f8f2" : "#8f9baa"} wrapMode="none" truncate>
            {`${index === props.selectedIndex ? ">" : " "} ${item.label} - ${item.description}`}
          </text>
        ))
      )}
    </box>
  );
}

