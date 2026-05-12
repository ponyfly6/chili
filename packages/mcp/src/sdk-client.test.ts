import { expect, test } from "bun:test";
import type { McpServerConfig } from "./config.js";
import { createSdkMcpTransport } from "./sdk-client.js";

test("stdio MCP transports suppress child stderr by default", () => {
  const server: McpServerConfig = {
    name: "local",
    type: "stdio",
    command: "node",
    args: ["server.js"],
    enabled: true,
    required: false,
    trust: false,
    source: "user",
    raw: {},
  };

  const transport = createSdkMcpTransport(server) as unknown as { _serverParams?: { stderr?: unknown } };
  expect(transport._serverParams?.stderr).toBe("ignore");
});
