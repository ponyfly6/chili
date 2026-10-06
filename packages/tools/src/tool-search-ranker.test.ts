import { expect, test } from "bun:test";
import { searchTools } from "./tool-search-ranker.js";
import type { ChiliToolDefinition } from "./types.js";

function tool(name: string, description: string, aliases: string[] = []): ChiliToolDefinition {
  return { name, description, aliases, risk: "read", inputSchema: {}, execute: async () => ({ title: name, output: "" }) };
}

test("exact aliases beat repeated keywords and select preserves requested order", () => {
  const tools = [tool("noisy", "memory ".repeat(100)), tool("memory", "Remember durable facts.", ["save_memory"])];
  expect(searchTools(tools, "memory", 1)[0]?.name).toBe("memory");
  expect(searchTools(tools, "save_memory", 1)[0]?.name).toBe("memory");
  expect(searchTools(tools, "select:save_memory,noisy,memory", 8).map((entry) => entry.name)).toEqual(["memory", "noisy"]);
});

test("capability ranking splits identifiers and searches Chinese metadata", () => {
  const tools = [tool("calendar_listEvents", "List calendar events."), tool("memory", "保存长期记忆和用户偏好。"), tool("unrelated", "Other")];
  expect(searchTools(tools, "calendar events", 1)[0]?.name).toBe("calendar_listEvents");
  expect(searchTools(tools, "长期记忆", 1)[0]?.name).toBe("memory");
  expect(searchTools(tools, "absent", 8)).toEqual([]);
  expect(searchTools(tools, "select:", 8)).toEqual([]);
});

test("identifier fragments remain intact instead of matching another namespace through common tokens", () => {
  const tools = [tool("mcp__b_only__lookup", "Only look up records"), tool("mcp__shared__lookup", "Read a record")];
  expect(searchTools(tools, "a_only", 8)).toEqual([]);
  expect(searchTools(tools, "b_only", 8).map((entry) => entry.name)).toEqual(["mcp__b_only__lookup"]);
});
