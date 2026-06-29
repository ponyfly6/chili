import type { ChatTranscriptItem } from "@chili/sdk";
import type { LocalTranscriptItem } from "./types.js";

export type ChronologicalTranscriptEntry =
  | { kind: "chat"; item: ChatTranscriptItem; index: number }
  | { kind: "local"; item: LocalTranscriptItem; index: number };

type SortableTranscriptEntry = ChronologicalTranscriptEntry & {
  time: number;
  sourceOrder: number;
};

export function chronologicalTranscriptEntries(
  items: readonly ChatTranscriptItem[],
  localItems: readonly LocalTranscriptItem[],
): ChronologicalTranscriptEntry[] {
  return [
    ...items.map((item, index): SortableTranscriptEntry => ({
      kind: "chat",
      item,
      index,
      time: chatTranscriptItemTime(item),
      sourceOrder: 0,
    })),
    ...localItems.map((item, index): SortableTranscriptEntry => ({
      kind: "local",
      item,
      index,
      time: localTranscriptItemTime(item),
      sourceOrder: 1,
    })),
  ]
    .sort((left, right) => left.time - right.time || left.sourceOrder - right.sourceOrder || left.index - right.index)
    .map(({ kind, item, index }) => ({ kind, item, index }) as ChronologicalTranscriptEntry);
}

export function chatTranscriptItemTime(item: ChatTranscriptItem): number {
  if (item.kind === "message") return item.createdAt;
  if (item.kind === "tool") return item.updatedAt;
  return item.resolvedAt ?? item.createdAt;
}

export function localTranscriptItemTime(item: LocalTranscriptItem): number {
  if (typeof item.createdAt === "number" && Number.isFinite(item.createdAt)) return item.createdAt;
  const match = item.id.match(/^(\d+)(?=:)/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}
