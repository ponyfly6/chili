import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultReadingPreferences, parseReadingPreferences, type ReadingPreferences } from "../shared/reading-preferences.js";

/** Native persistence survives both renderer origin changes and bounded app shutdown. */
export class DesktopReadingSettings {
  private value = { ...defaultReadingPreferences };
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    try { this.value = parseReadingPreferences(JSON.parse(await readFile(this.path, "utf8"))); }
    catch { this.value = { ...defaultReadingPreferences }; }
  }

  async get(): Promise<ReadingPreferences> {
    await this.pending;
    return { ...this.value };
  }

  set(value: ReadingPreferences): Promise<ReadingPreferences> {
    const next = { ...value };
    const operation = this.pending.then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      try {
        await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
        await rename(temporary, this.path);
        this.value = next;
      } finally { await rm(temporary, { force: true }); }
      return { ...next };
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
