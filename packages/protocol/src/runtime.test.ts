import { expect, test } from "bun:test";
import { normalizeSessionTitle, SESSION_TITLE_MAX_CHARS } from "./runtime.js";

test("normalizes session title whitespace through one canonical boundary", () => {
  expect(normalizeSessionTitle("  Overnight   Agent\nconsole  ")).toBe("Overnight Agent console");
});

test("accepts the canonical session title limit after normalization", () => {
  const maximumTitle = "x".repeat(SESSION_TITLE_MAX_CHARS);
  expect(normalizeSessionTitle(`  ${maximumTitle}  `)).toBe(maximumTitle);
});

test("rejects empty and over-limit normalized session titles", () => {
  expect(() => normalizeSessionTitle(" \n\t ")).toThrow("cannot be empty");
  expect(() => normalizeSessionTitle("x".repeat(SESSION_TITLE_MAX_CHARS + 1))).toThrow(
    `${SESSION_TITLE_MAX_CHARS} characters or fewer`,
  );
});
