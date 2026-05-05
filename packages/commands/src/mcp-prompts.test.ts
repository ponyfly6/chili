import { expect, test } from "bun:test";
import { createMcpPromptCommand, parseMcpPromptArguments, type McpPromptController } from "./mcp-prompts.js";

test("mcp prompt adapter creates command definitions with mcp source", async () => {
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
  const command = createMcpPromptCommand({
    serverName: "docs",
    name: "review-doc",
    description: "Review a doc",
    arguments: [{ name: "target", required: true }],
  }, controller);

  expect(command.source).toBe("mcp");
  expect(command.category).toBe("mcp");
  expect(command.name).toBe("docs review-doc");
  expect(command.argumentHint).toBe("<target>");

  const result = await command.run({}, {
    raw: "README.md",
    argv: ["README.md"],
    invocation: "review-doc",
    input: "README.md",
  });

  expect(calls).toEqual([{
    serverName: "docs",
    promptName: "review-doc",
    arguments: { target: "README.md" },
  }]);
  expect(result).toEqual({
    type: "prompt",
    prompt: "USER: Review README.md",
    metadata: {
      commandName: "docs review-doc",
      source: "mcp",
      model: "test-model",
      allowedTools: ["read"],
    },
  });
});

test("mcp prompt argument parser supports named and positional arguments", () => {
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
