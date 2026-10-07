import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopReadingSettings } from "./reading-settings.js";
import { parseDesktopRequest, parseDesktopResponse } from "../shared/contracts.js";

test("reading preferences survive restart with ordered atomic saves and private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-reading-settings-"));
  const path = join(directory, "reading-settings.json");
  try {
    const settings = new DesktopReadingSettings(path);
    await settings.initialize();
    expect(await settings.get()).toEqual({ expandWork: false, autoOpenResults: true });
    await Promise.all([settings.set({ expandWork: false, autoOpenResults: true }), settings.set({ expandWork: true, autoOpenResults: true })]);
    const restored = new DesktopReadingSettings(path);
    await restored.initialize();
    expect(await restored.get()).toEqual({ expandWork: true, autoOpenResults: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(await restored.get());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeFile(path, JSON.stringify({ autoResult: true, expandWork: true }));
    await restored.initialize();
    expect(await restored.get()).toEqual({ expandWork: true, autoOpenResults: true });
    await settings.set({ expandWork: true, autoOpenResults: false });
    await restored.initialize();
    expect(await restored.get()).toEqual({ expandWork: true, autoOpenResults: false });
    await writeFile(path, "corrupted");
    await restored.initialize();
    expect(await restored.get()).toEqual({ expandWork: false, autoOpenResults: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reading preferences reject non-boolean or extra renderer fields at both IPC boundaries", () => {
  const request = { type: "reading.set", expandWork: true, autoOpenResults: true } as const;
  expect(parseDesktopRequest(request)).toEqual(request);
  expect(parseDesktopResponse(request, { expandWork: true, autoOpenResults: true })).toEqual({ expandWork: true, autoOpenResults: true });
  for (const invalid of [{ ...request, expandWork: "false" }, { ...request, autoResult: true }, { ...request, path: "/tmp/file" }, { type: "reading.set" }]) {
    expect(() => parseDesktopRequest(invalid)).toThrow();
  }
  expect(() => parseDesktopResponse({ type: "reading.get" }, {})).toThrow();
  expect(() => parseDesktopResponse({ type: "reading.get" }, { autoResult: true, expandWork: true })).toThrow();
});
