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

test("replacing an HTTP target never inherits credentials or target trust", () => {
  const { config } = parseMcpConfig({ servers: { same: {
    url: "https://trusted.invalid/mcp", headers: { Authorization: "Bearer FAKE_SECRET" },
    oauth: { clientId: "fake-client", clientSecret: "FAKE_SECRET" }, trust: true,
  } } }, { servers: { same: { url: "https://other.invalid/mcp", trust: true } } });
  expect(config.servers.same).toMatchObject({ url: "https://other.invalid/mcp", headers: {}, trust: false });
  expect(JSON.stringify(config.servers.same)).not.toContain("FAKE_SECRET");
});

test("a same-target project may retain user headers, but changed stdio arguments cannot retain env secrets", () => {
  const { config } = parseMcpConfig({ servers: {
    web: { url: "https://trusted.invalid/mcp", headers: { Authorization: "Bearer FAKE_SECRET" } },
    process: { command: "node", args: ["trusted.js"], env: { SECRET: "FAKE_SECRET" }, trust: true },
  } }, { servers: { web: { includeTools: ["read"] }, process: { args: ["other.js"] } } });
  expect(config.servers.web).toMatchObject({ headers: { Authorization: "Bearer FAKE_SECRET" } });
  expect(config.servers.process).toMatchObject({ args: ["other.js"], trust: false });
  expect(config.servers.process?.raw.env).toBeUndefined();
});

test("changing OAuth authority drops inherited credentials even at the same resource URL", () => {
  const { config } = parseMcpConfig({ servers: { same: {
    url: "https://trusted.invalid/mcp", headers: { Authorization: "Bearer FAKE_SECRET" },
    oauth: { clientId: "fake", tokenUrl: "https://trusted.invalid/token", clientSecret: "FAKE_SECRET" },
  } } }, { servers: { same: { oauth: { tokenUrl: "https://other.invalid/token" } } } });
  expect(config.servers.same).toMatchObject({ headers: {}, oauth: { tokenUrl: "https://other.invalid/token" } });
  expect(JSON.stringify(config.servers.same)).not.toContain("FAKE_SECRET");
});


test("replacing a command cannot inherit credential-bearing arguments", () => {
  const { config } = parseMcpConfig({ servers: { same: {
    command: "trusted", args: ["--token", "FAKE_SECRET"], trust: true,
  } } }, { servers: { same: { command: "replacement" } } });
  expect(config.servers.same).toMatchObject({ command: "replacement", args: [], trust: false });
  expect(JSON.stringify(config.servers.same)).not.toContain("FAKE_SECRET");
});
