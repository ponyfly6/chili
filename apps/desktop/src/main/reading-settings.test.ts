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
    expect(await settings.get()).toEqual({ autoResult: true, expandWork: false });
    await Promise.all([settings.set({ autoResult: true, expandWork: true }), settings.set({ autoResult: false, expandWork: true })]);
    const restored = new DesktopReadingSettings(path);
    await restored.initialize();
    expect(await restored.get()).toEqual({ autoResult: false, expandWork: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(await restored.get());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeFile(path, "corrupted");
    await restored.initialize();
    expect(await restored.get()).toEqual({ autoResult: true, expandWork: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reading preferences reject non-boolean or extra renderer fields at both IPC boundaries", () => {
  const request = { type: "reading.set", autoResult: false, expandWork: true } as const;
  expect(parseDesktopRequest(request)).toEqual(request);
  expect(parseDesktopResponse(request, { autoResult: false, expandWork: true })).toEqual({ autoResult: false, expandWork: true });
  for (const invalid of [{ ...request, autoResult: "false" }, { ...request, path: "/tmp/file" }, { type: "reading.set" }]) {
    expect(() => parseDesktopRequest(invalid)).toThrow();
  }
  expect(() => parseDesktopResponse({ type: "reading.get" }, { autoResult: true })).toThrow();
});
