import { expect, test } from "bun:test";
import {
  applyDesktopTheme,
  parseDesktopTheme,
} from "./theme.js";

test("restores supported preferences and defaults missing or invalid values to system", () => {
  for (const value of ["system", "dark", "light"] as const) {
    expect(parseDesktopTheme(value)).toBe(value);
  }
  for (const value of [null, undefined, "unknown", "Dark", {}, 1]) {
    expect(parseDesktopTheme(value)).toBe("system");
  }
});

test("applies preferences at the document root so dialogs inherit the same theme", () => {
  const attributes = new Map<string, string>();
  const root = { setAttribute: (key: string, value: string) => { attributes.set(key, value); } };
  for (const theme of ["light", "dark", "system"] as const) {
    applyDesktopTheme(theme, root);
    expect(attributes.get("data-theme")).toBe(theme);
  }
});
