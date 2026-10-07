import { expect, test } from "bun:test";
import {
  classifyDangerousShellCommand,
  escalatedShellCommandRejection,
  isReadOnlyShellCommand,
} from "./shell-safety.js";

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

test("dangerous Git operations ask even when wrapped or using global options", () => {
  for (const command of [
    "git reset --hard HEAD",
    "git --no-optional-locks reset --hard",
    "git -C subdir -c core.quotePath=false reset --hard",
    "git --git-dir=repo/.git --work-tree=repo reset --hard",
    "git --git-dir repo/.git reset --hard",
    "env LC_ALL=C git clean -fdx",
    "git -c clean.requireForce=false clean -d",
    "git clean -i",
    "git checkout -- README.md",
    "git checkout README.md",
    "git checkout -f main",
    "git switch --discard-changes main",
    "git switch -f main",
    "git restore README.md",
    "git restore --worktree --staged README.md",
    "git restore -SW README.md",
    "git push --force origin main",
    "git push -f origin main",
    "git push --mirror origin",
    "git push --force-with-lease origin main",
    "git push --force-with-lease=main:abcd origin main",
    "git push origin +HEAD:main",
    "git status && git clean -fd",
    "command /usr/bin/git reset --hard",
    "bash -c 'git clean -fd'",
  ]) expect(classifyDangerousShellCommand(command)).toMatchObject({ action: "ask" });

  for (const command of [
    "git status --short",
    "git add -- README.md",
    "git commit -m 'Mention git reset --hard in documentation'",
    "git reset --soft HEAD~1",
    "git reset -- --hard",
    "git clean -ndfx",
    "git clean --dry-run -f",
    "git clean -h",
    "git switch main",
    "git restore --staged README.md",
    "git restore -S README.md",
    "git push origin main",
    "git push --dry-run --force origin main",
  ]) expect(classifyDangerousShellCommand(command)).toBeUndefined();
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

test("dangerous shell classification follows command separators and common wrappers", () => {
  for (const command of [
    "echo first\necho second\nrm -rf /",
    "echo first\r\nrm -rf /",
    "rm \\\n-rf /",
    "bash -lc 'rm -rf /'",
    "env bash -c 'rm -rf /'",
    "eval 'rm -rf /'",
    "rm -rf /tmp/../",
    "rm -rf ../../..",
    "rm -rf /?*",
    "rm -rf /[a-z]*",
    "rm -rf /{tmp,}",
    "rm -rf {.,}/*",
    "rm -rf ~+",
  ]) {
    expect(classifyDangerousShellCommand(command)).toMatchObject({ action: "deny" });
  }
});

test("dangerous shell classification protects workspace-relative recursive deletes", () => {
  for (const command of [
    "rm -rf \"$PWD\"",
    "rm -rf \"${PWD}\"",
    "rm -rf \"$OLDPWD\"",
  ]) {
    expect(classifyDangerousShellCommand(command)).toMatchObject({ action: "deny" });
  }
  for (const command of [
    "rm -rf \"${TARGET:-.}\"",
    "cd ..; rm -rf chili",
    "env -C .. rm -rf chili",
    "env --chdir=.. rm -rf chili",
  ]) {
    expect(classifyDangerousShellCommand(command)).toMatchObject({ action: "ask" });
  }
});

test("elevated shell validation rejects syntax that conceals the reviewed command", () => {
  expect(escalatedShellCommandRejection("echo first\nremindctl status")).toContain("single visible line");
  expect(escalatedShellCommandRejection("echo $(rm -rf /)")).toContain("command substitution");
  expect(escalatedShellCommandRejection("echo `rm -rf /`")).toContain("command substitution");
  expect(escalatedShellCommandRejection("cat < <(rm -rf /)")).toContain("command substitution");
  expect(escalatedShellCommandRejection("TARGET=/; rm -rf \"$TARGET\"")).toContain("variable expansion");
  expect(escalatedShellCommandRejection("TARGET=/ remindctl status")).toContain("environment assignments");
  expect(escalatedShellCommandRejection("cleanup() { rm -rf /; }; cleanup")).toContain("shell functions");
  for (const command of ["rm -rf /{tmp,}", "rm -rf /?*", "rm -rf /[a-z]*", "rm -rf {.,}/*", "rm -rf ~+"]) {
    expect(escalatedShellCommandRejection(command)).toContain("path expansion");
  }
  expect(escalatedShellCommandRejection("eval 'remindctl status'")).toContain("evaluate or source");
  expect(escalatedShellCommandRejection("printf payload | bash")).toContain("shell interpreter");
  expect(escalatedShellCommandRejection("bash -lc 'remindctl status'")).toContain("shell interpreter");
  expect(escalatedShellCommandRejection("cd ..; remindctl status")).toContain("working directory");
  expect(escalatedShellCommandRejection("env --chdir=.. remindctl status")).toContain("working directory");
  expect(escalatedShellCommandRejection("osascript -e 'tell application \"Reminders\" to return name'")).toBeUndefined();
});
