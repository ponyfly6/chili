import { expect, test } from "bun:test";
import { conversationTitle, matchingDesktopCommands, parseReadingPreferences } from "./conversation-design.js";

test("slash commands only intercept a single local command, preserving ordinary prompts", () => {
  expect(matchingDesktopCommands("/mo").map((command) => command.id)).toEqual(["model"]);
  expect(matchingDesktopCommands("/MODEL").map((command) => command.id)).toEqual(["model"]);
  expect(matchingDesktopCommands("/review this folder")).toEqual([]);
  expect(matchingDesktopCommands("Please check /settings")).toEqual([]);
  expect(matchingDesktopCommands("/unknown")).toEqual([]);
});

test("first message titles preserve whole Unicode characters and avoid long multiline titles", () => {
  expect(conversationTitle("  做一个花店网站\n自然简洁  ")).toBe("做一个花店网站");
  expect(Array.from(conversationTitle("🌶".repeat(60)))).toHaveLength(36);
  expect(conversationTitle(" ")).toBe("新会话");
});

test("reading preferences recover safely from old or invalid local values", () => {
  expect(parseReadingPreferences({ autoOpenResults: false, expandWork: true })).toEqual({ expandWork: true, autoOpenResults: false });
  expect(parseReadingPreferences(null)).toEqual({ expandWork: false, autoOpenResults: true });
  expect(parseReadingPreferences({ autoResult: false, expandWork: true })).toEqual({ expandWork: true, autoOpenResults: true });
  expect(parseReadingPreferences({ autoResult: "false", expandWork: 1 })).toEqual({ expandWork: false, autoOpenResults: true });
});
