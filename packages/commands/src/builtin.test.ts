import { expect, test } from "bun:test";
import { builtinCommands } from "./builtin.js";

function commandNamed(name: string) {
  return builtinCommands.find((command) => command.name === name);
}

test("builtin init command exists with builtin source", () => {
  const command = commandNamed("init");

  expect(command).toBeDefined();
  expect(command).toMatchObject({
    name: "init",
    source: "builtin",
    category: "builtin",
    argumentHint: "[focus]",
    supportsNonInteractive: true,
  });
});

test("builtin init expands focus arguments and contains repository guideline prompt requirements", async () => {
  const command = commandNamed("init");
  expect(command).toBeDefined();
  if (!command) return;

  const result = await command.run({}, {
    raw: "testing setup",
    argv: ["testing", "setup"],
    invocation: "/init",
    input: "/init testing setup",
  });

  expect(result.type).toBe("prompt");
  expect(result.metadata).toMatchObject({
    commandName: "init",
    source: "builtin",
    allowedTools: ["read", "glob", "grep", "git_status", "git_diff", "edit", "write", "apply_patch", "tool_search"],
    writeScope: ["AGENTS.md"],
  });
  expect(result.prompt).toContain("testing setup");
  expect(result.prompt).toContain("AGENTS.md");
  expect(result.prompt).toContain("# Repository Guidelines");
  expect(result.prompt).toContain("Use Chili's dedicated read-only repository tools");
  expect(result.prompt).toContain("Do not use shell commands");
  expect(result.prompt).toContain("README*");
  expect(result.prompt).toContain("package manifests");
  expect(result.prompt).toContain("Prefer executable sources over prose");
  expect(result.prompt).toContain("improve it in place without blind overwrite");
  expect(result.prompt).toContain("Do not generate .chili/memory.md or .chili/rules by default");
});
