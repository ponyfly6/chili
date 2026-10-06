import { setTimeout } from "node:timers/promises";
import type { RuntimeMcpListResponse } from "@chili/protocol";

/** Keep the CLI Host and its loopback callback alive until the browser returns. */
export async function waitForMcpAuthorization(
  control: { list(input?: { cwd?: string }): Promise<RuntimeMcpListResponse> },
  server: string, cwd: string, signal: AbortSignal,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 305_000);
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const state = (await control.list({ cwd })).servers.find((candidate) => candidate.name === server);
    if (!state) throw new Error("MCP server was removed while waiting for authorization");
    if (state.auth?.error) throw new Error(state.auth.error);
    if (state.auth?.authenticated) return;
    await setTimeout(options.intervalMs ?? 500, undefined, { signal });
  }
  throw new Error("MCP authorization timed out. Run mcp auth again.");
}
