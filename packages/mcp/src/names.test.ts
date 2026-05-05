import { expect, test } from "bun:test";
import { createMcpModelToolName, sanitizeMcpServerName, sanitizeMcpToolName, toMcpModelToolName } from "./names.js";

test("sanitizes MCP server and tool names for model-visible tool names", () => {
  expect(sanitizeMcpServerName("GitHub Enterprise")).toBe("github_enterprise");
  expect(sanitizeMcpToolName("issues.search/v2")).toBe("issues_search_v2");
  expect(sanitizeMcpToolName("123")).toBe("tool_123");
  expect(toMcpModelToolName("GitHub Enterprise", "issues.search/v2")).toBe("mcp__github_enterprise__issues_search_v2");
});

test("keeps raw MCP names alongside sanitized names", () => {
  const name = createMcpModelToolName("GitHub Enterprise", "issues.search/v2");

  expect(name).toEqual({
    rawServerName: "GitHub Enterprise",
    rawToolName: "issues.search/v2",
    serverName: "github_enterprise",
    toolName: "issues_search_v2",
    modelName: "mcp__github_enterprise__issues_search_v2",
  });
});
