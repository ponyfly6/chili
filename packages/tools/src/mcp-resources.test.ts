import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { createMcpResourceReadTool, createMcpResourcesListTool, type McpResourcesController } from "./builtins/mcp-resources.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ToolExecutionGate, ToolReviewRequest, ChiliToolDefinition, ExecuteToolInput } from "./types.js";

test("mcp_resources_list is read-only and still enters the execution gate", async () => {
  const events: ChiliEvent[] = [];
  let reviews = 0;
  const controller: McpResourcesController = {
    listResources: () => [{ serverName: "docs", uri: "file://README.md", name: "README", mimeType: "text/markdown" }],
    readResource: () => {
      throw new Error("not used");
    },
  };
  const tool = createMcpResourcesListTool(controller);
  const executor = createExecutor([tool], events, {
    review: async () => {
      reviews += 1;
      return { decision: "allow" };
    },
  });

  expect(tool.isReadOnly).toBe(true);
  const result = await executor.execute(toolInput("mcp_resources_list", { serverName: "docs" }));

  expect(result.status).toBe("completed");
  expect(reviews).toBe(1);
  expect(events.map((event) => event.type)).not.toContain("approval.requested");
  if (result.status === "completed") {
    expect(result.result.output).toContain("docs: README (file://README.md) [text/markdown]");
  }
});

test("mcp_resource_read presents the exact target to the execution gate", async () => {
  const events: ChiliEvent[] = [];
  const reviews: ToolReviewRequest[] = [];
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
    review: async (request) => {
      expect(request.toolName).toBe("mcp_resource_read");
      expect(request.input).toEqual({ serverName: "docs", uri: "file://README.md" });
      reviews.push(request);
      return { decision: "allow" };
    },
  });

  expect(tool.isReadOnly).toBe(true);
  const result = await executor.execute(toolInput("mcp_resource_read", {
    serverName: "docs",
    uri: "file://README.md",
  }));

  expect(result.status).toBe("completed");
  expect(reviews).toHaveLength(1);
  expect(events.map((event) => event.type)).not.toContain("approval.requested");
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
  gate: ToolExecutionGate,
): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  for (const tool of tools) registry.register(tool);
  return new ToolExecutor({
    registry,
    events: { publish: async (event) => { events.push(event); } },
    gate,
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
