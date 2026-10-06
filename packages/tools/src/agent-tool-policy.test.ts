import { expect, test } from "bun:test";
import { isToolVisible } from "./tool-policy.js";
import type { ChiliToolDefinition } from "./types.js";

function tool(name: string): ChiliToolDefinition {
  return { name, description: name, risk: "read", resourcePolicy: "internal", inputSchema: { type: "object" },
    execute: async () => ({ title: name, output: "ok" }) };
}

test("canonical Agent tools preserve explicit denials for merged legacy names", () => {
  for (const [current, previous] of [
    ["agent_spawn", "task"], ["agent_spawn", "task_batch"],
    ["agent_list", "task_list"], ["agent_list", "agent_message_list"],
    ["agent_send", "agent_message_send"], ["agent_wait", "task_wait"],
    ["agent_wait", "task_wait_batch"], ["agent_stop", "task_close"],
    ["agent_resume", "task_followup"],
  ] as const) {
    expect(isToolVisible(tool(current), { allowedTools: ["*"], deniedTools: [previous] })).toBe(false);
  }
});

test("persisted messaging grants survive migration without granting lifecycle controls", () => {
  const policy = { allowedTools: ["agent_message_send", "agent_message_list"], writeScope: [] };
  expect(isToolVisible(tool("agent_send"), policy)).toBe(true);
  expect(isToolVisible(tool("agent_list"), policy)).toBe(true);
  for (const name of ["agent_spawn", "agent_wait", "agent_stop", "agent_resume"]) {
    expect(isToolVisible(tool(name), policy)).toBe(false);
  }
  expect(isToolVisible(tool("agent_send"), { ...policy, deniedTools: ["agent_message_send"] })).toBe(false);
  expect(isToolVisible(tool("agent_list"), { ...policy, deniedTools: ["agent_message_list"] })).toBe(false);
});
