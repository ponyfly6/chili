import { chiliDarkTheme, tuiThemes } from "./palettes.js";
import type { TuiTheme } from "./types.js";

export type { TuiTheme } from "./types.js";
export { chiliDarkTheme, chiliLightTheme, terminalDarkTheme, tuiThemes, warmLightTheme } from "./palettes.js";
export { generateSystemTheme, normalizeHexColor, type SystemPaletteInput } from "./system.js";

export const DEFAULT_TUI_THEME_ID = chiliDarkTheme.id;
export const SYSTEM_TUI_THEME_ID = "system";

export interface TuiThemeOption {
  id: string;
  name: string;
}

export const selectableTuiThemeOptions: readonly TuiThemeOption[] = [
  { id: "chili-dark", name: "Chili Dark" },
  { id: "terminal-dark", name: "Terminal Dark" },
  { id: SYSTEM_TUI_THEME_ID, name: "System" },
  { id: "chili-light", name: "Chili Light" },
  { id: "warm-light", name: "Warm Light" },
];

export interface TuiThemeEnvironment {
  CHILI_TUI_THEME?: string | undefined;
}

export interface ResolveTuiThemeExtra {
  systemTheme?: TuiTheme | undefined;
}

export function initialTuiThemeId(themeId?: string | null, env?: TuiThemeEnvironment): string {
  const envThemeId = env === undefined ? process.env.CHILI_TUI_THEME : env.CHILI_TUI_THEME;
  return themeId?.trim() || envThemeId?.trim() || DEFAULT_TUI_THEME_ID;
}

export function resolveTuiTheme(themeId?: string | null, env?: TuiThemeEnvironment, extra?: ResolveTuiThemeExtra): TuiTheme {
  const requested = initialTuiThemeId(themeId, env);
  if (requested === SYSTEM_TUI_THEME_ID) return extra?.systemTheme ?? chiliDarkTheme;
  return tuiThemes.find((theme) => theme.id === requested) ?? chiliDarkTheme;
}
