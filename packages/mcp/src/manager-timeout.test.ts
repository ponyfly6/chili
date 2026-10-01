import { expect, spyOn, test } from "bun:test";
import type { McpCallToolResult, McpClient, McpInitializeResult, McpListToolsResult } from "./client.js";
import type { McpServerConfig } from "./config.js";
import { McpClientManager } from "./manager.js";

function fixture(overrides: Partial<McpClient> = {}, timeouts: { startupTimeoutMs?: number; toolTimeoutMs?: number } = {}) {
  const server: McpServerConfig = {
    name: "test", type: "stdio", command: "unused", args: [], enabled: true,
    required: false, trust: false, source: "user", raw: {}, ...timeouts,
  };
  let closes = 0;
  const client: McpClient = {
    server,
    initialize: async () => ({ capabilities: {} }),
    listTools: async () => ({ tools: [] }),
    listPrompts: async () => ({ prompts: [] }),
    listResources: async () => ({ resources: [] }),
    callTool: async () => ({ content: [] }),
    getPrompt: async () => ({ messages: [] }),
    readResource: async () => ({ contents: [] }),
    close: async () => { closes += 1; },
    ...overrides,
  };
  const manager = new McpClientManager({ config: { servers: { test: server } }, createClient: () => client });
  return { manager, closes: () => closes };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("tool deadline aborts the client once and keeps the timeout error", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const { manager } = fixture({
    callTool: async (_name, _input, options) => {
      calls += 1;
      signal = options?.signal;
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("SDK aborted")), { once: true }));
    },
  }, { toolTimeoutMs: 15 });
  await manager.connect();
  await expect(manager.callTool("test", "write", {})).rejects.toThrow("MCP operation timed out after 15ms");
  expect(signal?.aborted).toBe(true);
  expect(calls).toBe(1);
  expect(manager.getState("test")?.status).toBe("connected");
});

test("caller cancellation aborts a client even without a configured deadline", async () => {
  let signal: AbortSignal | undefined;
  const pending = deferred<McpCallToolResult>();
  const { manager } = fixture({ callTool: async (_name, _input, options) => {
    signal = options?.signal;
    return pending.promise;
  } });
  await manager.connect();
  const caller = new AbortController();
  const remove = spyOn(caller.signal, "removeEventListener");
  const result = manager.callTool("test", "write", {}, caller.signal);
  await tick();
  caller.abort();
  await expect(result).rejects.toThrow("MCP operation aborted");
  expect(signal?.aborted).toBe(true);
  expect(remove).toHaveBeenCalledTimes(1);
  pending.resolve({ content: [{ type: "text", text: "late" }] });
  await tick();
  expect(manager.getState("test")?.status).toBe("connected");
  remove.mockRestore();
});

test("pre-aborted callers never start the operation", async () => {
  let calls = 0;
  const { manager } = fixture({ callTool: async () => { calls += 1; return {}; } });
  await manager.connect();
  const caller = new AbortController();
  caller.abort();
  await expect(manager.callTool("test", "write", {}, caller.signal)).rejects.toThrow("MCP operation aborted");
  expect(calls).toBe(0);
});

test("successful calls detach caller listeners and clear deadline timers", async () => {
  let signal: AbortSignal | undefined;
  const { manager } = fixture({ callTool: async (_name, _input, options) => {
    signal = options?.signal;
    return { content: [] };
  } }, { toolTimeoutMs: 15 });
  await manager.connect();
  const caller = new AbortController();
  const remove = spyOn(caller.signal, "removeEventListener");
  await manager.callTool("test", "read", {}, caller.signal);
  expect(remove).toHaveBeenCalledTimes(1);
  caller.abort();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(signal?.aborted).toBe(false);
  remove.mockRestore();
});

test("initialization deadline aborts before closing and late completion cannot connect", async () => {
  const pending = deferred<McpInitializeResult>();
  let signal: AbortSignal | undefined;
  let lists = 0;
  const { manager, closes } = fixture({
    initialize: async (options) => { signal = options?.signal; return pending.promise; },
    listTools: async () => { lists += 1; return { tools: [] }; },
  }, { startupTimeoutMs: 15 });
  await manager.connect();
  expect(signal?.aborted).toBe(true);
  expect(manager.getState("test")?.status).toBe("failed");
  expect(manager.getState("test")?.error?.message).toBe("MCP operation timed out after 15ms");
  expect(closes()).toBe(1);
  pending.resolve({ capabilities: {} });
  await tick();
  expect(lists).toBe(0);
  expect(manager.getState("test")?.status).toBe("failed");
});

test("startup list deadline reaches every request and prevents late pagination or state refill", async () => {
  const pending = deferred<McpListToolsResult>();
  const signals: AbortSignal[] = [];
  let pages = 0;
  const { manager, closes } = fixture({
    listTools: async (options) => { pages += 1; signals.push(options!.signal!); return pending.promise; },
    listPrompts: async (options) => { signals.push(options!.signal!); return { prompts: [] }; },
    listResources: async (options) => { signals.push(options!.signal!); return { resources: [] }; },
  }, { startupTimeoutMs: 15 });
  await manager.connect();
  expect(signals).toHaveLength(3);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  pending.resolve({ tools: [{ name: "late" }], nextCursor: "next" });
  await tick();
  expect(pages).toBe(1);
  expect(manager.listTools()).toEqual([]);
  expect(manager.getState("test")?.status).toBe("failed");
  expect(closes()).toBe(1);
});

test("one failed startup request cancels its pending siblings", async () => {
  let siblingSignal: AbortSignal | undefined;
  const pending = deferred<McpListToolsResult>();
  const { manager } = fixture({
    listTools: async (options) => { siblingSignal = options?.signal; return pending.promise; },
    listPrompts: async () => { throw new Error("broken list"); },
  });
  await manager.connect();
  expect(siblingSignal?.aborted).toBe(true);
  pending.resolve({ tools: [{ name: "late" }] });
  await tick();
  expect(manager.listTools()).toEqual([]);
});
