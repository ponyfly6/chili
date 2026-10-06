import { expect, test } from "bun:test";
import { isToolVisible } from "./tool-policy.js";
import type { ChiliToolDefinition } from "./types.js";
import { AGENT_CONTROL_TOOLS } from "./tool-catalog.js";
import { DELEGATION_OFF_DENIED_TOOL_NAMES } from "./builtins/delegation.js";

const tool = (name: string): ChiliToolDefinition => ({
  name, description: name, resourcePolicy: "internal", risk: "write", inputSchema: {},
  execute: async () => ({ title: name, output: "ok" }),
});

test("Agent controls require their own grants and explicit denials always win", () => {
  for (const name of AGENT_CONTROL_TOOLS) {
    expect(isToolVisible(tool(name), { allowedTools: [name], writeScope: [], executeScope: [] })).toBe(true);
    expect(isToolVisible(tool(name), { allowedTools: [name], deniedTools: [name] })).toBe(false);
    expect(isToolVisible(tool(name), { allowedTools: ["read"] })).toBe(false);
    expect(isToolVisible(tool(name), { deniedTools: ["*"] })).toBe(false);
  }
});

test("delegation off denies new work and retains observation and stopping", () => {
  expect([...DELEGATION_OFF_DENIED_TOOL_NAMES].sort()).toEqual(["agent_resume", "agent_send", "agent_spawn"]);
  for (const name of AGENT_CONTROL_TOOLS) {
    expect(isToolVisible(tool(name), { deniedTools: DELEGATION_OFF_DENIED_TOOL_NAMES }))
      .toBe(!["agent_spawn", "agent_send", "agent_resume"].includes(name));
  }
});
