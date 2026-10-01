import { expect, test } from "bun:test";
import { Client, serializeMessage, type JSONRPCMessage } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "./config.js";
import { createSdkMcpClient } from "./sdk-client.js";
import {
  createBoundedStdioClientTransport,
  BoundedStdioReadBuffer,
  DEFAULT_MCP_STDIO_MAX_FRAME_BYTES,
  McpStdioFrameTooLargeError,
} from "./stdio-client-transport.js";

test("bounded stdio accepts a frame exactly at the byte limit", () => {
  const message = notification("exact");
  const encoded = Buffer.from(serializeMessage(message));
  const errors: Error[] = [];
  const buffer = new BoundedStdioReadBuffer(encoded.byteLength - 1, (error) => errors.push(error));

  buffer.append(encoded);

  expect(buffer.readMessage()).toEqual(message);
  expect(buffer.readMessage()).toBeNull();
  expect(errors).toEqual([]);
});

test("bounded stdio rejects limit plus one byte without a newline exactly once", () => {
  const errors: Error[] = [];
  const buffer = new BoundedStdioReadBuffer(8, (error) => errors.push(error));

  buffer.append(Buffer.alloc(8, 0x78));
  buffer.append(Buffer.alloc(1, 0x78));
  buffer.append(Buffer.alloc(9, 0x79));

  expect(buffer.bufferedBytes).toBe(0);
  expect(buffer.readMessage()).toBeNull();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(McpStdioFrameTooLargeError);
  expect(errors[0]?.message).toBe("MCP stdio frame exceeds 8 bytes before newline.");
});

test("bounded stdio counts each frame independently within one chunk", () => {
  const first = notification("first");
  const second = notification("second");
  const firstBytes = Buffer.from(serializeMessage(first));
  const secondBytes = Buffer.from(serializeMessage(second));
  const errors: Error[] = [];
  const maxFrameBytes = Math.max(firstBytes.byteLength, secondBytes.byteLength) - 1;
  const buffer = new BoundedStdioReadBuffer(maxFrameBytes, (error) => errors.push(error));

  buffer.append(Buffer.concat([firstBytes, secondBytes]));

  expect(buffer.readMessage()).toEqual(first);
  expect(buffer.readMessage()).toEqual(second);
  expect(buffer.readMessage()).toBeNull();
  expect(errors).toEqual([]);
});

test("bounded stdio applies the limit to UTF-8 bytes rather than characters", () => {
  const message = notification("通知");
  const serialized = serializeMessage(message);
  const encoded = Buffer.from(serialized);
  const frameCharacters = serialized.length - 1;
  const frameBytes = encoded.byteLength - 1;
  const errors: Error[] = [];
  const buffer = new BoundedStdioReadBuffer(frameCharacters, (error) => errors.push(error));

  expect(frameBytes).toBeGreaterThan(frameCharacters);
  buffer.append(encoded);

  expect(buffer.readMessage()).toBeNull();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(McpStdioFrameTooLargeError);
});

test("oversized real stdio child is closed and pending initialization rejects", async () => {
  const maxFrameBytes = 64;
  const fixture = fileURLToPath(new URL("./fixtures/oversized-stdio-server.mjs", import.meta.url));
  const transport = createBoundedStdioClientTransport({
    command: process.execPath,
    args: [fixture, String(maxFrameBytes + 1), "50"],
    stderr: "ignore",
  }, { maxFrameBytes });
  const client = new Client({ name: "bounded-stdio-test", version: "0.0.0" });
  const errors: Error[] = [];
  let closeCount = 0;
  transport.onclose = () => {
    closeCount += 1;
  };
  client.onerror = (error) => errors.push(error);

  let childPid: number | null = null;
  try {
    const connectPromise = client.connect(transport, { timeout: 2_000 });
    childPid = await eventuallyValue(() => transport.pid);

    await expect(connectPromise).rejects.toThrow("Connection closed");
    await eventually(() => {
      expect(closeCount).toBe(1);
      expect(errors.filter((error) => error instanceof McpStdioFrameTooLargeError)).toHaveLength(1);
      expect(processExists(childPid!)).toBe(false);
    });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});

test("public stdio client preserves one fatal frame-limit error across calls", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/oversized-stdio-server.mjs", import.meta.url));
  const server: McpServerConfig = {
    name: "oversized-stdio",
    type: "stdio",
    command: process.execPath,
    args: [fixture, String(DEFAULT_MCP_STDIO_MAX_FRAME_BYTES + 1), "0"],
    enabled: true,
    required: false,
    trust: false,
    source: "user",
    raw: {},
  };
  const client = createSdkMcpClient(server);

  try {
    const initializeError = await rejectionOf(client.initialize());

    expect(initializeError).toBeInstanceOf(McpStdioFrameTooLargeError);
    expect(initializeError).toMatchObject({
      name: "McpStdioFrameTooLargeError",
      code: "MCP_STDIO_FRAME_TOO_LARGE",
      maxFrameBytes: DEFAULT_MCP_STDIO_MAX_FRAME_BYTES,
      message: `MCP stdio frame exceeds ${DEFAULT_MCP_STDIO_MAX_FRAME_BYTES} bytes before newline.`,
    });
    expect(await rejectionOf(client.listTools())).toBe(initializeError);
    expect(await rejectionOf(client.readResource("file:///after-overflow"))).toBe(initializeError);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test.each(["legacy", "modern"] as const)("auto negotiation uses a disposable bounded sibling for %s stdio", async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), "chili-mcp-stdio-negotiation-"));
  const logPath = join(dir, "requests.jsonl");
  const fixture = fileURLToPath(new URL("./fixtures/negotiating-stdio-server.mjs", import.meta.url));
  const server: McpServerConfig = {
    name: "stdio-negotiation", type: "stdio", command: process.execPath,
    args: [fixture, mode, logPath], enabled: true, required: false, trust: false, source: "user", raw: {},
  };
  const client = createSdkMcpClient(server);
  try {
    const initialized = await client.initialize();
    expect(initialized.protocolVersion).toBe(mode === "modern" ? "2026-07-28" : "2025-11-25");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"]);
    const requests = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      pid: number; method: string; params?: { _meta?: Record<string, unknown> };
    });
    const probe = requests.find((request) => request.method === "server/discover");
    const active = requests.find((request) => request.method === "tools/list");
    expect(probe).toBeDefined();
    expect(active).toBeDefined();
    expect(probe!.pid).not.toBe(active!.pid);
    expect(processExists(probe!.pid)).toBe(false);
    if (mode === "legacy") {
      expect(requests.filter((request) => request.pid === active!.pid).map((request) => request.method))
        .toEqual(["initialize", "notifications/initialized", "tools/list"]);
    } else {
      expect(requests.some((request) => request.method === "initialize")).toBe(false);
      expect(active!.params?._meta?.["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    }
    await client.close();
    await eventually(() => expect(processExists(active!.pid)).toBe(false));
  } finally {
    await client.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded transport preserves the SDK base identity used to create probe siblings", async () => {
  const transport = createBoundedStdioClientTransport({ command: process.execPath, stderr: "ignore" });
  expect(Object.getPrototypeOf(transport)).toBe(StdioClientTransport.prototype);
  expect(transport.constructor).toBe(StdioClientTransport);
  await transport.close();
});

test("an oversized probe remains bounded and both probe and failed session are reaped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-mcp-stdio-probe-limit-"));
  const logPath = join(dir, "requests.jsonl");
  const fixture = fileURLToPath(new URL("./fixtures/negotiating-stdio-server.mjs", import.meta.url));
  const errors: Error[] = [];
  let closeCount = 0;
  const transport = createBoundedStdioClientTransport({
    command: process.execPath, args: [fixture, "overflow", logPath], stderr: "ignore",
  }, { maxFrameBytes: 64, onFatalError: (error) => errors.push(error) });
  transport.onclose = () => { closeCount += 1; };
  const client = new Client({ name: "bounded-probe-test", version: "0" }, {
    versionNegotiation: { mode: "auto", probe: { timeoutMs: 200, maxRetries: 0 } },
  });
  try {
    await expect(client.connect(transport, { timeout: 1_000 })).rejects.toThrow("Connection closed");
    const requests = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { pid: number; method: string });
    expect(requests.map((request) => request.method)).toEqual(["server/discover", "initialize"]);
    expect(new Set(requests.map((request) => request.pid)).size).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(McpStdioFrameTooLargeError);
    await eventually(() => {
      expect(closeCount).toBe(1);
      for (const request of requests) expect(processExists(request.pid)).toBe(false);
    });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("closing during discovery reaps the probe without starting a session or emitting close twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-mcp-stdio-probe-close-"));
  const logPath = join(dir, "requests.jsonl");
  const fixture = fileURLToPath(new URL("./fixtures/negotiating-stdio-server.mjs", import.meta.url));
  const transport = createBoundedStdioClientTransport({
    command: process.execPath, args: [fixture, "wait", logPath], stderr: "ignore",
  });
  let closeCount = 0;
  transport.onclose = () => { closeCount += 1; };
  const client = new Client({ name: "cancel-probe-test", version: "0" }, {
    versionNegotiation: { mode: "auto", probe: { timeoutMs: 2_000, maxRetries: 0 } },
  });
  try {
    const connecting = rejectionOf(client.connect(transport));
    let probePid: number | undefined;
    for (let attempt = 0; attempt < 100 && !probePid; attempt += 1) {
      const content = await readFile(logPath, "utf8").catch(() => "");
      if (content.trim()) probePid = (JSON.parse(content.trim()) as { pid: number }).pid;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(probePid).toBeDefined();
    await transport.close();
    expect(await connecting).toMatchObject({ message: expect.stringContaining("closed during the server/discover probe") });
    expect(transport.pid).toBeNull();
    expect((await readFile(logPath, "utf8")).trim().split("\n")).toHaveLength(1);
    await eventually(() => {
      expect(closeCount).toBe(1);
      expect(processExists(probePid!)).toBe(false);
    });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

function notification(method: string): JSONRPCMessage {
  return { jsonrpc: "2.0", method };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function eventuallyValue<T>(read: () => T | null): Promise<T> {
  let value: T | null = null;
  await eventually(() => {
    value = read();
    expect(value).not.toBeNull();
  });
  return value!;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error
      ? (error as NodeJS.ErrnoException).code === "EPERM"
      : false;
  }
}
