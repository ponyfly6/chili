import { describe, expect, test } from "bun:test";
import { shouldUseMockKeychain } from "./keychain-policy.js";

describe("desktop Keychain policy", () => {
  test("uses the mock Keychain for local ad-hoc macOS builds", () => {
    expect(shouldUseMockKeychain({
      platform: "darwin",
      localAdHocBuild: true,
      smokeMode: false,
    })).toBe(true);
  });

  test("keeps the system Keychain for stable signed macOS builds", () => {
    expect(shouldUseMockKeychain({
      platform: "darwin",
      localAdHocBuild: false,
      smokeMode: false,
    })).toBe(false);
  });

  test("keeps smoke isolated without changing other platforms", () => {
    expect(shouldUseMockKeychain({
      platform: "darwin",
      localAdHocBuild: false,
      smokeMode: true,
    })).toBe(true);
    expect(shouldUseMockKeychain({
      platform: "linux",
      localAdHocBuild: true,
      smokeMode: true,
    })).toBe(false);
  });
});
