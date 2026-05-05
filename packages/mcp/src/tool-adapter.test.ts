import { expect, test } from "bun:test";
import type { McpServerConfig } from "./config.js";
import { createMcpChiliTool, createMcpChiliTools, inferConcurrencySafe, inferRisk } from "./tool-adapter.js";

const server: McpServerConfig = {
  name: "GitHub Enterprise",
  type: "http",
  url: "https://example.test/mcp",
  headers: {},
  enabled: true,
  required: false,
  trust: false,
  source: "user",
  raw: {},
};

test("adapts MCP tool approval to Chili mcp permission and raw server/tool pattern", () => {
  const tool = createMcpChiliTool({
    server,
    tool: {
      name: "issues.search",
      description: "Search issues",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    manager: {
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    },
  });

  expect(tool.name).toBe("mcp__github_enterprise__issues_search");
  expect(tool.risk).toBe("read");
  expect(tool.shouldDefer).toBe(true);
  expect(tool.isReadOnly).toBe(true);
  expect(tool.isConcurrencySafe).toBe(true);
  expect(tool.mcp).toMatchObject({
    rawServerName: "GitHub Enterprise",
    rawToolName: "issues.search",
  });
  expect(tool.approval?.({})).toMatchObject({
    permission: "mcp",
    patterns: ["GitHub Enterprise/issues.search"],
    metadata: {
      server: "GitHub Enterprise",
      tool: "issues.search",
      modelName: "mcp__github_enterprise__issues_search",
    },
  });
});

test("infers MCP tool risk and concurrency from annotations", () => {
  expect(inferRisk({ destructiveHint: true, readOnlyHint: true })).toBe("dangerous");
  expect(inferRisk({ openWorldHint: true, readOnlyHint: true })).toBe("network");
  expect(inferRisk({ readOnlyHint: true })).toBe("read");
  expect(inferRisk({})).toBe("network");

  expect(inferConcurrencySafe({ destructiveHint: true, idempotentHint: true })).toBe(false);
  expect(inferConcurrencySafe({ idempotentHint: true })).toBe(true);
  expect(inferConcurrencySafe({ readOnlyHint: true })).toBe(true);
  expect(inferConcurrencySafe({})).toBe(false);
});

test("adds stable suffixes when sanitized MCP tool names collide", () => {
  const tools = createMcpChiliTools(server, [
    { name: "issues.search" },
    { name: "issues/search" },
  ], {
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });

  expect(tools[0]?.name.startsWith("mcp__github_enterprise__issues_search__")).toBe(true);
  expect(tools[1]?.name.startsWith("mcp__github_enterprise__issues_search__")).toBe(true);
  expect(tools[0]?.name).not.toBe(tools[1]?.name);
  expect(tools[0]?.mcp.modelName).toBe(tools[0]?.name);
  expect(tools[1]?.mcp.modelName).toBe(tools[1]?.name);
});
