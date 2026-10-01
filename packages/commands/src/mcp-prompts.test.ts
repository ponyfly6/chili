import { expect, test } from "bun:test";
import { createMcpPromptCommands, parseMcpPromptArguments, type McpPromptController } from "./mcp-prompts.js";
import { createCommandRegistry } from "./registry.js";
import { resolveCommand } from "./resolve.js";

test("MCP prompts live under /prompt mcp server name and preserve render metadata", async () => {
  const calls: unknown[] = [];
  const controller: McpPromptController = {
    renderPrompt(request) {
      calls.push(request);
      return {
        messages: [{ role: "user", content: `Review ${request.arguments.target}` }],
        metadata: { model: "test-model", allowedTools: ["read"] },
      };
    },
  };
  const registry = createCommandRegistry(createMcpPromptCommands([{
    serverName: "docs",
    name: "review-doc",
    description: "Review a doc",
    arguments: [{ name: "target", required: true }],
  }], controller));

  const command = registry.findByPath("/prompt mcp docs review-doc");
  expect(command).toMatchObject({
    id: "prompt.mcp.docs.review-doc",
    source: "mcp",
    group: "prompt",
    argumentHint: "<target>",
  });
  expect(resolveCommand(registry, {}, "/docs review-doc README.md").status).toBe("unknown");

  const resolved = resolveCommand(registry, {}, "/prompt mcp docs review-doc README.md");
  expect(resolved.status).toBe("matched");
  if (resolved.status !== "matched" || !resolved.command.run) return;
  const result = await resolved.command.run({}, resolved.args);

  expect(calls).toEqual([{
    serverName: "docs",
    promptName: "review-doc",
    arguments: { target: "README.md" },
  }]);
  expect(result).toEqual({
    type: "prompt",
    prompt: "USER: Review README.md",
    metadata: {
      commandId: "prompt.mcp.docs.review-doc",
      commandPath: "/prompt mcp docs review-doc",
      source: "mcp",
      model: "test-model",
      allowedTools: ["read"],
    },
  });
});

test("MCP prompt argument parser supports named and positional arguments", () => {
  expect(parseMcpPromptArguments("target=src mode=fast extra=value", [
    { name: "target", required: true },
    { name: "mode" },
  ])).toEqual({ target: "src", mode: "fast", extra: "value" });

  expect(parseMcpPromptArguments("\"src folder\" slow", [
    { name: "target", required: true },
    { name: "mode" },
  ])).toEqual({ target: "src folder", mode: "slow" });

  expect(() => parseMcpPromptArguments("", [{ name: "target", required: true }]))
    .toThrow("Missing required MCP prompt argument: target");
});
