import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { createToolSearchTool } from "./builtins/tool-search.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import { filterToolsByPolicy } from "./tool-policy.js";
import type { ChiliToolDefinition, ExecuteToolInput, ToolAccessPolicyResolver } from "./types.js";

test("in-memory registry keeps duplicate name and alias protections", () => {
  const registry = new InMemoryToolRegistry();
  registry.register(tool("read"));

  expect(() => registry.register(tool("read"))).toThrow("Tool already registered: read");
  expect(() => registry.register(tool("grep", ["read"]))).toThrow("Tool alias already registered: read");
});

test("registry can unregister dynamic source without leaving ghost names or aliases", async () => {
  const registry = new InMemoryToolRegistry();
  registry.register(createToolSearchTool(registry));
  registry.register(tool("read"));
  registry.register(tool("mcp__jira__search", ["jira_search"], "Search Jira issues."), { source: "mcp:jira" });
  registry.register(tool("mcp__jira__create", ["jira_create"], "Create Jira issues."), { source: "mcp:jira" });

  expect(registry.get("jira_search")?.name).toBe("mcp__jira__search");
  expect(await searchOutput(registry, "jira")).toContain("mcp__jira__search:");

  const removed = registry.unregisterSource("mcp:jira");

  expect(removed.map((entry) => entry.name)).toEqual(["mcp__jira__create", "mcp__jira__search"]);
  expect(registry.get("mcp__jira__search")).toBeUndefined();
  expect(registry.get("jira_search")).toBeUndefined();
  expect(await searchOutput(registry, "jira")).toBe("(no matching tools)");
  expect(registry.list().map((entry) => entry.name)).toEqual(["read", "tool_search"]);
});

test("registry can replace a reconnecting source atomically", async () => {
  const registry = new InMemoryToolRegistry();
  registry.register(createToolSearchTool(registry));
  registry.register(tool("read"));
  registry.register(tool("mcp__linear__issue_search", ["linear_search"], "Search old issues."), { source: "mcp:linear" });
  registry.register(tool("mcp__linear__issue_create", ["linear_create"], "Create old issues."), { source: "mcp:linear" });

  const removed = registry.replaceSource("mcp:linear", [
    tool("mcp__linear__issue_search", ["linear_find"], "Search current issues."),
    tool("mcp__linear__project_list", ["linear_projects"], "List Linear projects."),
  ]);

  expect(removed.map((entry) => entry.name)).toEqual(["mcp__linear__issue_create", "mcp__linear__issue_search"]);
  expect(registry.get("linear_search")).toBeUndefined();
  expect(registry.get("linear_create")).toBeUndefined();
  expect(registry.get("linear_find")?.name).toBe("mcp__linear__issue_search");
  expect(registry.get("linear_projects")?.name).toBe("mcp__linear__project_list");
  expect(await searchOutput(registry, "current projects")).toContain("mcp__linear__issue_search:");
});

test("deferred dynamic tools remain listed and searchable until runtime filtering is enabled", async () => {
  const registry = new InMemoryToolRegistry();
  registry.register(createToolSearchTool(registry));
  const deferred = tool("mcp__slow__lookup", ["slow_lookup"], "Lookup slow dynamic records.");
  deferred.shouldDefer = true;
  registry.register(deferred, { source: "mcp:slow" });

  expect(registry.list().map((entry) => entry.name)).toContain("mcp__slow__lookup");
  expect(registry.list({ includeDeferred: true }).map((entry) => entry.name)).toContain("mcp__slow__lookup");
  expect(await searchOutput(registry, "slow dynamic")).toContain("mcp__slow__lookup:");
});

test("registry can replace tools by MCP name prefix", () => {
  const registry = new InMemoryToolRegistry();
  registry.register(tool("read"));
  registry.register(tool("mcp__github__issue_search", ["gh_issue_search"]), { source: "mcp:github" });
  registry.register(tool("mcp__github__pull_search", ["gh_pull_search"]), { source: "mcp:github" });
  registry.register(tool("mcp__slack__search", ["slack_search"]), { source: "mcp:slack" });

  const removed = registry.replaceMatching(
    { namePrefix: "mcp__github__" },
    [tool("mcp__github__issue_list", ["gh_issue_list"])],
    { source: "mcp:github" },
  );

  expect(removed.map((entry) => entry.name)).toEqual(["mcp__github__issue_search", "mcp__github__pull_search"]);
  expect(registry.get("gh_issue_search")).toBeUndefined();
  expect(registry.get("mcp__slack__search")?.name).toBe("mcp__slack__search");
  expect(registry.entries().find((entry) => entry.tool.name === "mcp__github__issue_list")?.source).toBe("mcp:github");
});

test("replace is atomic when incoming dynamic tools collide with static aliases", () => {
  const registry = new InMemoryToolRegistry();
  registry.register(tool("read", ["file_read"]));
  registry.register(tool("mcp__docs__search", ["docs_search"]), { source: "mcp:docs" });

  expect(() => {
    registry.replaceSource("mcp:docs", [tool("mcp__docs__lookup", ["file_read"])]);
  }).toThrow("Tool alias already registered: file_read");

  expect(registry.get("docs_search")?.name).toBe("mcp__docs__search");
  expect(registry.get("mcp__docs__search")?.name).toBe("mcp__docs__search");
});

test("policy allowedTools matches MCP canonical names and aliases", () => {
  const jira = tool("mcp__jira__search", ["jira_search"]);
  const slack = tool("mcp__slack__search", ["slack_search"]);

  expect(filterToolsByPolicy([jira, slack], { allowedTools: ["mcp__jira__search"] }).map((entry) => entry.name)).toEqual([
    "mcp__jira__search",
  ]);
  expect(filterToolsByPolicy([jira, slack], { allowedTools: ["jira_search"] }).map((entry) => entry.name)).toEqual([
    "mcp__jira__search",
  ]);
});

function tool(name: string, aliases: string[] = [], description = `${name} tool`): ChiliToolDefinition {
  return {
    name,
    aliases,
    description,
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async () => ({ title: name, output: name }),
  };
}

async function searchOutput(registry: InMemoryToolRegistry, query: string): Promise<string> {
  const executor = createExecutor(registry);
  const result = await executor.execute(toolInput("tool_search", { query }, "/tmp"));
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return "";
  return result.result.output;
}

function createExecutor(registry: InMemoryToolRegistry, policyResolver?: ToolAccessPolicyResolver): ToolExecutor {
  return new ToolExecutor({
    registry,
    events: { publish: async (_event: ChiliEvent) => {} },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    ...(policyResolver ? { policyResolver } : {}),
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
}

function toolInput(toolName: string, input: unknown, cwd: string): ExecuteToolInput {
  return {
    sessionId: "session_registry" as SessionId,
    turnId: "turn_registry" as TurnId,
    toolName,
    input,
    cwd,
  };
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}
