import type { TuiCommandSuggestion } from "../commands/types.js";
import type { TuiTheme } from "../theme/index.js";

export function CommandList(props: {
  title: string;
  items: readonly TuiCommandSuggestion[];
  selectedIndex: number;
  theme: TuiTheme;
  maxItems?: number | undefined;
  compact?: boolean | undefined;
  emptyText?: string | undefined;
}) {
  const maxItems = Math.max(1, props.maxItems ?? DEFAULT_COMMAND_LIST_MAX_ITEMS);
  const height = commandListHeight(props.items, maxItems);
  const visible = visibleItemsWithinHeight(props.items, props.selectedIndex, maxItems, height);
  return (
    <box width="100%" height={height} flexDirection="column" border borderStyle="single" borderColor={props.theme.colors.border.default} paddingX={1}>
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{props.title}</text>
      {props.items.length === 0 ? (
        <text fg={props.theme.colors.menu.muted} wrapMode="none" truncate>{`  ${props.emptyText ?? "no commands"}`}</text>
      ) : (
        visible.map(({ item, index }, visibleIndex) => (
          <box key={`${item.value}:${item.description}:${index}`} width="100%" flexDirection="column">
            {visibleIndex === 0 || visible[visibleIndex - 1]?.item.group !== item.group ? (
              <text fg={props.theme.colors.menu.muted} wrapMode="none" truncate>{` ${item.group.toUpperCase()}`}</text>
            ) : null}
            <text
              fg={index === props.selectedIndex ? props.theme.colors.menu.selectedText : item.enabled ? props.theme.colors.menu.text : props.theme.colors.menu.muted}
              bg={index === props.selectedIndex ? props.theme.colors.menu.selectedBackground : props.theme.colors.menu.background}
              wrapMode="none"
              truncate
            >
              {commandLabel(item, index === props.selectedIndex, Boolean(props.compact))}
            </text>
          </box>
        ))
      )}
      <box flexGrow={1} />
      <text fg={props.theme.colors.menu.muted} wrapMode="none" truncate>{" ↑↓ move · Tab/→ expand · Enter run · Esc close"}</text>
    </box>
  );
}

export const DEFAULT_COMMAND_LIST_MAX_ITEMS = 5;

export function commandListHeight(
  items: readonly TuiCommandSuggestion[],
  maxItems = DEFAULT_COMMAND_LIST_MAX_ITEMS,
): number {
  // The first window establishes the viewport height. Selection changes must
  // scroll within that viewport instead of moving the composer and footer.
  const visible = visibleItems(items, 0, Math.max(1, maxItems)).map(({ item }) => item);
  const itemRows = Math.max(visible.length, 1);
  const groupRows = visibleGroupRows(visible);
  return itemRows + groupRows + 4;
}

function visibleItemsWithinHeight(
  items: readonly TuiCommandSuggestion[],
  selectedIndex: number,
  maxItems: number,
  height: number,
): Array<{ item: TuiCommandSuggestion; index: number }> {
  const contentRows = Math.max(1, height - 4);
  // Group labels consume rows too. Windows that cross more groups therefore
  // show fewer commands while keeping both the selection and frame stable.
  for (let itemLimit = Math.min(maxItems, Math.max(items.length, 1)); itemLimit >= 1; itemLimit -= 1) {
    const visible = visibleItems(items, selectedIndex, itemLimit);
    const rows = Math.max(visible.length, 1) + visibleGroupRows(visible.map(({ item }) => item));
    if (rows <= contentRows) return visible;
  }
  return visibleItems(items, selectedIndex, 1);
}

function visibleGroupRows(items: readonly TuiCommandSuggestion[]): number {
  return items.reduce((rows, item, index) => (
    index === 0 || items[index - 1]?.group !== item.group ? rows + 1 : rows
  ), 0);
}

function visibleItems<T>(items: readonly T[], selectedIndex: number, maxItems: number): Array<{ item: T; index: number }> {
  if (items.length <= maxItems) return items.map((item, index) => ({ item, index }));
  const selected = Math.min(Math.max(0, selectedIndex), items.length - 1);
  const half = Math.floor(maxItems / 2);
  const start = Math.min(Math.max(0, selected - half), Math.max(0, items.length - maxItems));
  return items.slice(start, start + maxItems).map((item, offset) => ({ item, index: start + offset }));
}

function commandLabel(item: TuiCommandSuggestion, selected: boolean, compact: boolean): string {
  const marker = selected ? ">" : " ";
  const status = item.enabled ? "" : ` [disabled${item.disabledReason ? `: ${item.disabledReason}` : ""}]`;
  const source = item.source === "builtin" ? "" : ` · ${item.source}`;
  return compact
    ? `${marker} ${item.label}${status}`
    : `${marker} ${item.label} — ${item.description}${source}${status}`;
}
