export type DesktopTheme = "system" | "dark" | "light";

export function parseDesktopTheme(value: unknown): DesktopTheme {
  return value === "dark" || value === "light" ? value : "system";
}
