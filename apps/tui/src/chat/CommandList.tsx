import type { SlashCompletion } from "../slash/types.js";
import type { TuiTheme } from "../theme/index.js";

export function CommandList(props: {
  title: string;
  items: readonly SlashCompletion[];
  selectedIndex: number;
  theme: TuiTheme;
  maxItems?: number | undefined;
  compact?: boolean | undefined;
}) {
  const maxItems = Math.max(1, props.maxItems ?? DEFAULT_COMMAND_LIST_MAX_ITEMS);
  const visible = visibleItems(props.items, props.selectedIndex, maxItems);
  return (
    <box width="100%" flexDirection="column" border borderStyle="single" borderColor={props.theme.colors.border.default} paddingX={1}>
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{props.title}</text>
      {props.items.length === 0 ? (
        <text fg={props.theme.colors.menu.muted} wrapMode="none" truncate>{"  no commands"}</text>
      ) : (
        visible.map(({ item, index }) => (
          <text
            key={item.value}
            fg={index === props.selectedIndex ? props.theme.colors.menu.selectedText : props.theme.colors.menu.text}
            bg={index === props.selectedIndex ? props.theme.colors.menu.selectedBackground : props.theme.colors.menu.background}
            wrapMode="none"
            truncate
          >
            {commandLabel(item, index === props.selectedIndex, Boolean(props.compact))}
          </text>
        ))
      )}
    </box>
  );
}

export const DEFAULT_COMMAND_LIST_MAX_ITEMS = 5;

export function commandListHeight(items: readonly unknown[], maxItems = DEFAULT_COMMAND_LIST_MAX_ITEMS): number {
  const visibleRows = Math.min(Math.max(items.length, 1), Math.max(1, maxItems));
  return visibleRows + 3;
}

function visibleItems<T>(items: readonly T[], selectedIndex: number, maxItems: number): Array<{ item: T; index: number }> {
  if (items.length <= maxItems) return items.map((item, index) => ({ item, index }));
  const selected = Math.min(Math.max(0, selectedIndex), items.length - 1);
  const half = Math.floor(maxItems / 2);
  const start = Math.min(Math.max(0, selected - half), Math.max(0, items.length - maxItems));
  return items.slice(start, start + maxItems).map((item, offset) => ({ item, index: start + offset }));
}

function commandLabel(item: SlashCompletion, selected: boolean, compact: boolean): string {
  const marker = selected ? ">" : " ";
  return compact ? `${marker} ${item.label}` : `${marker} ${item.label} - ${item.description}`;
}
