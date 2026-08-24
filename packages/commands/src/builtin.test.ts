import { expect, test } from "bun:test";
import { createCommandRegistry } from "./registry.js";
import { builtinPromptCommands } from "./builtin.js";
import { resolveCommand } from "./resolve.js";

test("builtin init exists only at /prompt builtin init", async () => {
  const registry = createCommandRegistry(builtinPromptCommands);

  expect(registry.findByPath("/init")).toBeUndefined();
  expect(registry.findByPath("/prompt builtin init")?.id).toBe("prompt.builtin.init");

  const resolved = resolveCommand(registry, {}, "/prompt builtin init testing setup");
  expect(resolved.status).toBe("matched");
  if (resolved.status !== "matched" || !resolved.command.run) return;
  const result = await resolved.command.run({}, resolved.args);

  expect(result.type).toBe("prompt");
  expect(result.prompt).toContain("testing setup");
  expect(result.prompt).toContain("# Repository Guidelines");
  expect(result.metadata).toMatchObject({
    commandId: "prompt.builtin.init",
    commandPath: "/prompt builtin init",
    source: "builtin",
    writeScope: ["AGENTS.md"],
  });
});
