import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAppearanceSettings } from "./appearance-settings.js";

test("theme saves survive immediate restart and use a private settings file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-appearance-"));
  const path = join(directory, "appearance-settings.json");
  try {
    const settings = new DesktopAppearanceSettings(path);
    expect(await settings.initialize()).toBe("system");
    for (const theme of ["light", "dark", "system"] as const) {
      expect(await settings.setTheme(theme)).toBe(theme);
      expect(await new DesktopAppearanceSettings(path).initialize()).toBe(theme);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme });
    }
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rapid theme selections save in order and reads wait for the last selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-appearance-"));
  const path = join(directory, "appearance-settings.json");
  try {
    const settings = new DesktopAppearanceSettings(path);
    await settings.initialize();
    const first = settings.setTheme("light");
    const second = settings.setTheme("dark");
    const third = settings.setTheme("system");
    expect(await settings.getTheme()).toBe("system");
    expect(await Promise.all([first, second, third])).toEqual(["light", "dark", "system"]);
    expect(await new DesktopAppearanceSettings(path).initialize()).toBe("system");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid saved settings fall back to system and can be replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-appearance-"));
  const path = join(directory, "appearance-settings.json");
  try {
    for (const invalid of ["broken", "null", '{"theme":"unknown"}', "{}"]) {
      await writeFile(path, invalid);
      const settings = new DesktopAppearanceSettings(path);
      expect(await settings.initialize()).toBe("system");
      expect(await settings.setTheme("light")).toBe("light");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed write retains the saved theme and allows a later retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-appearance-"));
  const blocked = join(directory, "blocked");
  try {
    await writeFile(blocked, "file prevents directory creation");
    const settings = new DesktopAppearanceSettings(join(blocked, "appearance-settings.json"));
    await settings.initialize();
    await expect(settings.setTheme("dark")).rejects.toThrow();
    expect(await settings.getTheme()).toBe("system");
    await rm(blocked);
    expect(await settings.setTheme("light")).toBe("light");
    expect(await settings.getTheme()).toBe("light");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
