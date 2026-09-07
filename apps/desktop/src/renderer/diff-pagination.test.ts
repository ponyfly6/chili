import { expect, test } from "bun:test";
import { splitRawDiff } from "./diff-pagination.js";

test("raw pages preserve all text, including line endings and final warnings", () => {
  const text = "diff --git a/file b/file\r\n" + "+a line of content\r\n".repeat(25_000) + "# diff output truncated by the safety limit";
  const pages = splitRawDiff(text);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.join("")).toBe(text);
  expect(pages.every((page) => page.length <= 64 * 1024)).toBe(true);
  expect(pages.at(-1)).toContain("# diff output truncated by the safety limit");
});

test("raw pagination prefers whole lines and handles giant Unicode lines", () => {
  expect(splitRawDiff("first\nsecond\nthird", 10)).toEqual(["first\n", "second\n", "third"]);
  const text = "😀".repeat(100);
  const pages = splitRawDiff(text, 9);
  expect(pages.join("")).toBe(text);
  expect(pages.every((page) => page.length <= 9 && !/[\ud800-\udbff]$/.test(page))).toBe(true);
  expect(splitRawDiff("", 2)).toEqual([""]);
  expect(() => splitRawDiff("test", 1)).toThrow(RangeError);
});
