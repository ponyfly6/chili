import { chiliDarkTheme, tuiThemes } from "./palettes.js";
import type { TuiTheme } from "./types.js";

export type { TuiTheme } from "./types.js";
export { chiliDarkTheme, terminalDarkTheme, tuiThemes } from "./palettes.js";

export const DEFAULT_TUI_THEME_ID = chiliDarkTheme.id;

export interface TuiThemeEnvironment {
  CHILI_TUI_THEME?: string | undefined;
}

export function resolveTuiTheme(themeId?: string | null, env?: TuiThemeEnvironment): TuiTheme {
  const envThemeId = env === undefined ? process.env.CHILI_TUI_THEME : env.CHILI_TUI_THEME;
  const requested = themeId?.trim() || envThemeId?.trim() || DEFAULT_TUI_THEME_ID;
  return tuiThemes.find((theme) => theme.id === requested) ?? chiliDarkTheme;
}
