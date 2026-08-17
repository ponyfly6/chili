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
