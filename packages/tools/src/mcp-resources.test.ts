import { expect, test } from "bun:test";
import type { ApprovalDecision, ChiliEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { createMcpResourceReadTool, createMcpResourcesListTool, type McpResourcesController } from "./builtins/mcp-resources.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ApprovalBroker, ChiliToolDefinition, ExecuteToolInput } from "./types.js";

test("mcp_resources_list is read-only and does not require approval", async () => {
  const events: ChiliEvent[] = [];
  let approvals = 0;
  const controller: McpResourcesController = {
    listResources: () => [{ serverName: "docs", uri: "file://README.md", name: "README", mimeType: "text/markdown" }],
    readResource: () => {
      throw new Error("not used");
    },
  };
  const tool = createMcpResourcesListTool(controller);
  const executor = createExecutor([tool], events, {
    decide: async () => {
      approvals += 1;
      return { action: "deny" };
    },
  });

  expect(tool.isReadOnly).toBe(true);
  const result = await executor.execute(toolInput("mcp_resources_list", { serverName: "docs" }));

  expect(result.status).toBe("completed");
  expect(approvals).toBe(0);
  expect(events.map((event) => event.type)).not.toContain("approval.requested");
  if (result.status === "completed") {
    expect(result.result.output).toContain("docs: README (file://README.md) [text/markdown]");
  }
});

test("mcp_resource_read is read-only but asks approval for the target resource", async () => {
  const events: ChiliEvent[] = [];
  const decisions: ApprovalDecision[] = [];
  const controller: McpResourcesController = {
    listResources: () => [],
    readResource: (input) => ({
      serverName: input.serverName,
      uri: input.uri,
      mimeType: "text/plain",
      text: "resource text",
    }),
  };
  const tool = createMcpResourceReadTool(controller);
  const executor = createExecutor([tool], events, {
    decide: async (request) => {
      expect(request.permission).toBe("mcp_resource_read");
      expect(request.patterns).toEqual(["docs:file://README.md"]);
      decisions.push({ action: "allow_once" });
      return { action: "allow_once" };
    },
  });

  expect(tool.isReadOnly).toBe(true);
  const result = await executor.execute(toolInput("mcp_resource_read", {
    serverName: "docs",
    uri: "file://README.md",
  }));

  expect(result.status).toBe("completed");
  expect(decisions).toHaveLength(1);
  expect(events.map((event) => event.type)).toContain("approval.requested");
  expect(events.some((event) => event.type === "tool.call_updated" && event.payload.status === "waiting_for_approval")).toBe(true);
  if (result.status === "completed") {
    expect(result.result.output).toBe("resource text");
    expect(result.result.metadata).toMatchObject({
      serverName: "docs",
      uri: "file://README.md",
      mimeType: "text/plain",
    });
  }
});

function createExecutor(
  tools: readonly ChiliToolDefinition[],
  events: ChiliEvent[],
  approvals: ApprovalBroker,
): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  for (const tool of tools) registry.register(tool);
  return new ToolExecutor({
    registry,
    events: { publish: async (event) => { events.push(event); } },
    approvals,
    createId: (prefix) => `${prefix}_test`,
    now: () => 1 as TimestampMs,
  });
}

function toolInput(toolName: string, input: unknown): ExecuteToolInput {
  return {
    sessionId: "session_test" as SessionId,
    turnId: "turn_test" as TurnId,
    callId: `toolcall_${toolName}` as ToolCallId,
    toolName,
    input,
    cwd: process.cwd(),
  };
}
