import { expect, test } from "bun:test";
import { parseDesktopRequest, parseDesktopResponse } from "./contracts.js";

test("MCP connection requests admit only configured server identity and owner scope", () => {
  for (const type of ["mcp.connect", "mcp.disconnect"] as const) {
    expect(parseDesktopRequest({ type, server: "github/issues", sessionId: "session", projectId: "project" }))
      .toEqual({ type, server: "github/issues", sessionId: "session", projectId: "project" });
    for (const extra of [{ url: "https://external.test" }, { command: "anything" }, { env: { key: "value" } }, { headers: {} }]) {
      expect(() => parseDesktopRequest({ type, server: "server", ...extra })).toThrow();
    }
    expect(() => parseDesktopRequest({ type, server: "bad\nname" })).toThrow();
    expect(() => parseDesktopRequest({ type, server: "" })).toThrow();
  }
});

test("MCP mutations return only matched server state, never connection secrets", () => {
  const request = { type: "mcp.connect", server: "MiniMax" } as const;
  const response = { name: "MiniMax", status: "running", enabled: true, transport: "stdio", toolCount: 2 } as const;
  expect(parseDesktopResponse(request, response)).toEqual(response);
  for (const altered of [{ ...response, name: "other" }, { ...response, args: ["credential"] }, { ...response, url: "https://private.test" }, { ...response, toolCount: -1 }, { ...response, status: "connected" }]) {
    expect(() => parseDesktopResponse(request, altered)).toThrow();
  }
});
