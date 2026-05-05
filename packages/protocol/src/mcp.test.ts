import { expect, test } from "bun:test";
import type {
  ChiliEvent,
  EventEnvelope,
  McpAuthStatus,
  McpDiagnostic,
  McpProgressPayload,
  McpPromptRef,
  McpResourceRef,
  McpServerConfigSummary,
  McpServerStatus,
  McpToolRef,
  SessionId,
  ThreadId,
  TimestampMs,
} from "./index.js";

const time = 1 as TimestampMs;
const sessionId = "session-1" as SessionId;
const threadId = "thread-1" as ThreadId;

test("MCP refs and summaries are constructible", () => {
  const config: McpServerConfigSummary = {
    name: "filesystem",
    enabled: true,
    transport: "stdio",
    command: "mcp-server-filesystem",
    args: ["/tmp"],
    envKeys: ["MCP_TOKEN"],
    timeoutMs: 30000,
    capabilities: {
      tools: true,
      resources: true,
    },
  };
  const status: McpServerStatus = "running";
  const authStatus: McpAuthStatus = "authenticated";
  const tool: McpToolRef = {
    serverName: "filesystem",
    name: "read_file",
    title: "Read file",
    inputSchema: {
      type: "object",
    },
    enabled: true,
  };
  const resource: McpResourceRef = {
    serverName: "filesystem",
    uri: "file:///tmp/a.txt",
    mimeType: "text/plain",
  };
  const prompt: McpPromptRef = {
    serverName: "filesystem",
    name: "summarize_file",
    arguments: [
      {
        name: "path",
        required: true,
      },
    ],
  };
  const diagnostic: McpDiagnostic = {
    serverName: "filesystem",
    level: "info",
    message: "Connected",
  };

  expect(config.name).toBe("filesystem");
  expect(status).toBe("running");
  expect(authStatus).toBe("authenticated");
  expect(tool.name).toBe("read_file");
  expect(resource.uri).toBe("file:///tmp/a.txt");
  expect(prompt.arguments?.[0]?.required).toBe(true);
  expect(diagnostic.level).toBe("info");
});

test("MCP events are accepted by ChiliEvent", () => {
  const statusChanged: ChiliEvent = {
    id: "mcp-1",
    type: "mcp.server_status_changed",
    time,
    sessionId,
    threadId,
    payload: {
      serverName: "filesystem",
      status: "running",
      previousStatus: "starting",
      toolCount: 1,
      promptCount: 1,
      resourceCount: 1,
      auth: {
        status: "not_required",
        required: false,
      },
      capabilities: {
        tools: true,
        prompts: true,
        resources: true,
      },
    },
  };
  const toolsChanged: ChiliEvent = {
    id: "mcp-2",
    type: "mcp.tools_changed",
    time,
    sessionId,
    threadId,
    payload: {
      serverName: "filesystem",
      toolCount: 1,
      tools: [
        {
          serverName: "filesystem",
          name: "read_file",
        },
      ],
      status: "running",
      revision: "tools-1",
    },
  };
  const promptsChanged: ChiliEvent = {
    id: "mcp-3",
    type: "mcp.prompts_changed",
    time,
    sessionId,
    threadId,
    payload: {
      serverName: "filesystem",
      promptCount: 1,
      prompts: [
        {
          serverName: "filesystem",
          name: "summarize_file",
        },
      ],
      status: "running",
    },
  };
  const resourcesChanged: ChiliEvent = {
    id: "mcp-4",
    type: "mcp.resources_changed",
    time,
    sessionId,
    threadId,
    payload: {
      serverName: "filesystem",
      resourceCount: 1,
      resources: [
        {
          serverName: "filesystem",
          uri: "file:///tmp/a.txt",
        },
      ],
      status: "running",
    },
  };
  const diagnostic: ChiliEvent = {
    id: "mcp-5",
    type: "mcp.diagnostic",
    time,
    sessionId,
    threadId,
    payload: {
      serverName: "filesystem",
      level: "warning",
      message: "Resource list is stale",
      status: "running",
    },
  };
  const progress: ChiliEvent = {
    id: "mcp-6",
    type: "mcp.progress",
    time,
    sessionId,
    threadId,
    payload: {
      serverName: "filesystem",
      operation: "list_tools",
      status: "completed",
      completed: 1,
      total: 1,
    },
  };

  const events: ChiliEvent[] = [
    statusChanged,
    toolsChanged,
    promptsChanged,
    resourcesChanged,
    diagnostic,
    progress,
  ];

  expect(events.map((event) => event.type)).toEqual([
    "mcp.server_status_changed",
    "mcp.tools_changed",
    "mcp.prompts_changed",
    "mcp.resources_changed",
    "mcp.diagnostic",
    "mcp.progress",
  ]);
});

test("MCP payload types can be used with EventEnvelope", () => {
  const event: EventEnvelope<"mcp.progress", McpProgressPayload> = {
    id: "mcp-progress",
    type: "mcp.progress",
    time,
    payload: {
      serverName: "github",
      operation: "authenticate",
      status: "failed",
      error: {
        message: "OAuth timed out",
        recoverable: true,
      },
    },
  };

  const accepted: ChiliEvent = event;
  expect(accepted.payload.serverName).toBe("github");
});
