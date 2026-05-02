import { expect, test } from "bun:test";
import { evaluatePolicy, parsePermissionSpec } from "./index.js";

test("parses Tool(content) permission specs", () => {
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
  expect(decision.source).toBe("policy_rule");
  expect(decision.reason).toContain("Matched allow rule");

  const denied = evaluatePolicy("bash", "rm -rf dist", [
    [{ permission: "Bash(rm *)", pattern: "*", action: "deny" }],
  ]);
  expect(denied.action).toBe("deny");
});

test("deny has hard priority over later ask or allow rules", () => {
  const decision = evaluatePolicy("read", ".chili/config.toml", [
    [
      { permission: "read(*)", pattern: "*", action: "allow" },
      { permission: "read(.chili/**)", pattern: "*", action: "deny" },
      { permission: "read(.chili/config.toml)", pattern: "*", action: "ask" },
      { permission: "read(.chili/config.toml)", pattern: "*", action: "allow" },
    ],
  ]);
  expect(decision.action).toBe("deny");
  expect(decision.matchedRule?.action).toBe("deny");
});

test("later non-deny rules can override broad ask fallbacks", () => {
  const allowed = evaluatePolicy("bash", "git status --short", [
    [
      { permission: "bash(*)", pattern: "*", action: "ask" },
      { permission: "bash(git status*)", pattern: "*", action: "allow" },
    ],
  ]);
  expect(allowed.action).toBe("allow");

  const asked = evaluatePolicy("bash", "npm test", [
    [
      { permission: "bash(*)", pattern: "*", action: "allow" },
      { permission: "bash(npm *)", pattern: "*", action: "ask" },
    ],
  ]);
  expect(asked.action).toBe("ask");
});
