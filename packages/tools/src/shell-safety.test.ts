import { expect, test } from "bun:test";
import { isReadOnlyShellCommand } from "./shell-safety.js";

test("read-only shell classification rejects in-place sed and awk", () => {
  expect(isReadOnlyShellCommand("sed -i 's/a/b/' file")).toBe(false);
  expect(isReadOnlyShellCommand("sed -Ei 's/a/b/' file")).toBe(false);
  expect(isReadOnlyShellCommand("sed 'w out' file")).toBe(false);
  expect(isReadOnlyShellCommand("awk -i inplace '{print}' file")).toBe(false);
  expect(isReadOnlyShellCommand("awk '{print > \"out\"}' file")).toBe(false);
  expect(isReadOnlyShellCommand("awk '{system(\"date\")}' file")).toBe(false);
  expect(isReadOnlyShellCommand("sed -n '1p' file")).toBe(true);
  expect(isReadOnlyShellCommand("awk '{print $1}' file")).toBe(true);
});

test("read-only shell classification keeps safe git branch and status commands", () => {
  expect(isReadOnlyShellCommand("git branch -D foo")).toBe(false);
  expect(isReadOnlyShellCommand("git branch foo")).toBe(false);
  expect(isReadOnlyShellCommand("git branch")).toBe(true);
  expect(isReadOnlyShellCommand("git branch --list")).toBe(true);
  expect(isReadOnlyShellCommand("git branch --list foo")).toBe(true);
  expect(isReadOnlyShellCommand("git status")).toBe(true);
  expect(isReadOnlyShellCommand("git diff")).toBe(true);
});
