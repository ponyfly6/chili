import { expect, test } from "bun:test";
import { evaluatePolicy, parsePermissionSpec } from "./index.js";

test("parses Claude Code style Tool(content) permission specs", () => {
  expect(parsePermissionSpec("Bash(git status *)")).toEqual({
    permission: "Bash",
    content: "git status *",
  });
});

test("matches Tool(content) rules against approval patterns", () => {
  const decision = evaluatePolicy("bash", "git status --short", [
    [{ permission: "Bash(git status *)", pattern: "*", action: "allow" }],
  ]);
  expect(decision.action).toBe("allow");

  const denied = evaluatePolicy("bash", "rm -rf dist", [
    [{ permission: "Bash(rm *)", pattern: "*", action: "deny" }],
  ]);
  expect(denied.action).toBe("deny");
});
