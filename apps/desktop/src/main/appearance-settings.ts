import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parseDesktopTheme, type DesktopTheme } from "../shared/appearance.js";

export class DesktopAppearanceSettings {
  private theme: DesktopTheme = "system";
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly settingsPath: string) {}

  async initialize(): Promise<DesktopTheme> {
    try {
      const saved: unknown = JSON.parse(await readFile(this.settingsPath, "utf8"));
      this.theme = saved && typeof saved === "object" && "theme" in saved
        ? parseDesktopTheme(saved.theme)
        : "system";
    } catch {
      this.theme = "system";
    }
    return this.theme;
  }

  async getTheme(): Promise<DesktopTheme> {
    await this.pending;
    return this.theme;
  }

  setTheme(theme: DesktopTheme): Promise<DesktopTheme> {
    const operation = this.pending.then(async () => {
      const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.settingsPath), { recursive: true });
      try {
        await writeFile(temporary, `${JSON.stringify({ theme })}\n`, { mode: 0o600 });
        await rename(temporary, this.settingsPath);
        this.theme = theme;
      } finally {
        await rm(temporary, { force: true });
      }
      return theme;
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
