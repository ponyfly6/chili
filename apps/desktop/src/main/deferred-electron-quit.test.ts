import { describe, expect, test } from "bun:test";
import { DeferredElectronQuit } from "./deferred-electron-quit.js";

describe("deferred native Electron quit", () => {
  test("prevents native quit once and exits exactly once after containment", () => {
    const exits: number[] = [];
    let prevented = 0;
    const quit = new DeferredElectronQuit((code) => exits.push(code));
    const event = { preventDefault: () => { prevented += 1; } };

    expect(quit.defer(event)).toBe(true);
    expect(quit.defer(event)).toBe(false);
    expect(prevented).toBe(2);
    expect(exits).toEqual([]);

    expect(quit.complete(17)).toBe(true);
    expect(quit.complete(99)).toBe(false);
    expect(quit.defer(event)).toBe(false);
    expect(prevented).toBe(2);
    expect(exits).toEqual([17]);
  });
});
