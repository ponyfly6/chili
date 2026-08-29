export type MenuNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

export function trappedTabTarget(
  currentIndex: number,
  itemCount: number,
  reverse: boolean,
): number | undefined {
  if (itemCount <= 0) return undefined;
  if (currentIndex < 0) return reverse ? itemCount - 1 : 0;
  if (reverse && currentIndex === 0) return itemCount - 1;
  if (!reverse && currentIndex === itemCount - 1) return 0;
  return undefined;
}

export function menuNavigationTarget(
  key: MenuNavigationKey,
  currentIndex: number,
  itemCount: number,
): number | undefined {
  if (itemCount <= 0) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown") return currentIndex < 0 ? 0 : (currentIndex + 1) % itemCount;
  return currentIndex < 0 ? itemCount - 1 : (currentIndex - 1 + itemCount) % itemCount;
}

export function isMenuNavigationKey(key: string): key is MenuNavigationKey {
  return key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End";
}
