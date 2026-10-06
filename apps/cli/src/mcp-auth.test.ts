import { expect, test } from "bun:test";
import { waitForMcpAuthorization } from "./mcp-auth.js";

test("CLI keeps polling pending browser authorization until it completes", async () => {
  let polls = 0;
  await waitForMcpAuthorization({ list: async () => ({ servers: [{ name: "docs", enabled: true, status: "stopped", auth: {
    required: true, authenticated: ++polls === 3,
  } }] }) }, "docs", "/tmp", new AbortController().signal, { intervalMs: 1 });
  expect(polls).toBe(3);
});

test("CLI authorization wait propagates callback failure and shutdown", async () => {
  const control = { list: async () => ({ servers: [{ name: "docs", enabled: true, status: "stopped" as const,
    auth: { required: true, error: "MCP authorization failed." } }] }) };
  await expect(waitForMcpAuthorization(control, "docs", "/tmp", new AbortController().signal)).rejects.toThrow("authorization failed");
  const abort = new AbortController();
  abort.abort(new Error("shutdown"));
  await expect(waitForMcpAuthorization(control, "docs", "/tmp", abort.signal)).rejects.toThrow("shutdown");
});
