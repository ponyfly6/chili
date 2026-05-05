import { expect, test } from "bun:test";
import { parseMcpConfig } from "./config.js";

test("parses user and project MCP server configs with project override", () => {
  const result = parseMcpConfig(
    {
      mcpServers: {
        fs: {
          command: "node",
          args: ["server.js"],
          env: { NODE_ENV: "test" },
          enabled: true,
          required: true,
          trust: true,
          includeTools: ["read"],
          startupTimeoutMs: 1000,
        },
        web: {
          type: "http",
          url: "https://example.test/mcp",
          headers: { authorization: "Bearer user" },
        },
      },
    },
    {
      servers: {
        web: {
          headers: { authorization: "Bearer project" },
          excludeTools: ["delete"],
          toolTimeoutMs: 5000,
          supportsParallelToolCalls: true,
        },
        events: {
          type: "sse",
          url: "https://example.test/sse",
          headers: { accept: "text/event-stream" },
          oauth: {
            clientId: "client",
            scopes: ["tools"],
          },
        },
      },
    },
  );

  expect(result.diagnostics).toEqual([]);
  expect(result.config.servers.fs).toMatchObject({
    type: "stdio",
    command: "node",
    args: ["server.js"],
    env: { NODE_ENV: "test" },
    required: true,
    trust: true,
    includeTools: ["read"],
    startupTimeoutMs: 1000,
  });
  expect(result.config.servers.web).toMatchObject({
    type: "http",
    url: "https://example.test/mcp",
    headers: { authorization: "Bearer project" },
    excludeTools: ["delete"],
    toolTimeoutMs: 5000,
    supportsParallelToolCalls: true,
    source: "project",
  });
  expect(result.config.servers.events).toMatchObject({
    type: "sse",
    oauth: { clientId: "client", scopes: ["tools"] },
  });
});

test("reports diagnostics and omits servers without a valid transport", () => {
  const result = parseMcpConfig({
    mcpServers: {
      broken: {
        enabled: "yes",
        args: "not-array",
      },
      invalidHttp: {
        type: "http",
        url: "",
      },
    },
  });

  expect(Object.keys(result.config.servers)).toEqual([]);
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("invalid_boolean");
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("missing_transport");
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("invalid_url");
});
