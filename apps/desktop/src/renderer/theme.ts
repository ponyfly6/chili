import type { DesktopTheme } from "../shared/appearance.js";
export { parseDesktopTheme, type DesktopTheme } from "../shared/appearance.js";

export const desktopThemeOptions: readonly { id: DesktopTheme; label: string; description: string }[] = [
  { id: "system", label: "System", description: "Match your Mac" },
  { id: "dark", label: "Dark", description: "Warm charcoal" },
  { id: "light", label: "Light", description: "Soft ivory" },
];

export function applyDesktopTheme(theme: DesktopTheme, root: Pick<HTMLElement, "setAttribute"> = document.documentElement): void {
  // CSS color-scheme follows OS changes automatically when the preference is system.
  root.setAttribute("data-theme", theme);
}
