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

test("Git read classification supports inspection flags but rejects write and executable options", () => {
  for (const command of [
    "git --no-optional-locks status --short",
    "git --no-pager --no-optional-locks diff --no-ext-diff --no-textconv --stat",
    "git -P log -5 --oneline",
    "git --no-pager show HEAD:README.md",
    "git --no-optional-locks branch --list 'feature/*'",
    "git diff -- '--output=literal-file-name'",
  ]) expect(isReadOnlyShellCommand(command)).toBe(true);

  for (const command of [
    "git diff --output=changes.patch",
    "git --no-pager log --output changes.txt",
    "git show --output=changes.txt HEAD",
    "git diff --ext-diff",
    "git show --textconv HEAD:README.md",
    "git grep --open-files-in-pager=sh needle",
    "git grep -Osh needle",
    "git -c alias.inspect='!touch marker' inspect",
    "git -c core.fsmonitor=helper status",
    "git -C ../other status",
    "git --git-dir=../other/.git status",
    "git inspect",
    "git --no-optional-locks add README.md",
  ]) expect(isReadOnlyShellCommand(command)).toBe(false);
});

test("read-only shell classification rejects substitutions and adjacent redirections", () => {
  for (const command of [
    "git status>status.txt",
    "git diff 2>errors.txt",
    "git status&>status.txt",
    "git status>>status.txt",
    "git show $(touch marker)",
    "git show \"$(touch marker)\"",
    "git show `touch marker`",
    "cat <(touch marker)",
    "git diff $DIFF_OPTIONS",
    "git diff \"$DIFF_OPTIONS\"",
    "git diff \"'$DIFF_OPTIONS'\"",
  ]) expect(isReadOnlyShellCommand(command)).toBe(false);

  for (const command of [
    "git grep '>'",
    "git grep \">\"",
    "git grep '$(literal)'",
    "git grep '`literal`'",
    "git grep '\"$literal\"'",
    "git status | head -n 10",
  ]) expect(isReadOnlyShellCommand(command)).toBe(true);
});

test("read-only shell classification does not discard invocation environment changes", () => {
  for (const command of [
    "LC_ALL=C rg needle .",
    "PATH=./bin ls",
    "env LC_ALL=C rg needle .",
    "env -C subdir pwd",
    "command env HOME=./home git status",
  ]) {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  }
  expect(isReadOnlyShellCommand("command pwd")).toBe(true);
  expect(isReadOnlyShellCommand("rg needle . | head -n 10")).toBe(true);
});
