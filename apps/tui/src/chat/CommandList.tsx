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
  const visible = visibleItems(props.items, props.selectedIndex, maxItems);
  return (
    <box width="100%" flexDirection="column" border borderStyle="single" borderColor={props.theme.colors.border.default} paddingX={1}>
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
      <text fg={props.theme.colors.menu.muted} wrapMode="none" truncate>{" ↑↓ move · Tab/→ expand · Enter run · Esc close"}</text>
    </box>
  );
}

export const DEFAULT_COMMAND_LIST_MAX_ITEMS = 5;

export function commandListHeight(
  items: readonly TuiCommandSuggestion[],
  maxItems = DEFAULT_COMMAND_LIST_MAX_ITEMS,
  selectedIndex = 0,
): number {
  const visible = visibleItems(items, selectedIndex, Math.max(1, maxItems)).map(({ item }) => item);
  const itemRows = Math.max(visible.length, 1);
  const groupRows = new Set(visible.map((item) => item.group)).size;
  return itemRows + groupRows + 4;
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
