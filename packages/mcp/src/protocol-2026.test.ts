import { expect, test } from "bun:test";
import { JsonRpcMcpClient, MCP_CURRENT_PROTOCOL_VERSION } from "./client.js";
import type { McpServerConfig } from "./config.js";
import { createSdkMcpClient } from "./sdk-client.js";
import { McpHttpIngressLimitError } from "./http-ingress.js";

const VERSION = "2026-07-28";
type WireRequest = { id?: number | string; method: string; params?: Record<string, unknown> };
type Observed = { body: WireRequest; headers: Headers };

function fixture(respond: (body: WireRequest) => Response | Record<string, unknown>) {
  const requests: Observed[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await request.json() as WireRequest;
      requests.push({ body, headers: request.headers });
      const response = respond(body);
      return response instanceof Response ? response : Response.json({ jsonrpc: "2.0", id: body.id, ...response });
    },
  });
  const config: McpServerConfig = {
    name: "protocol-2026-fixture", type: "http", url: server.url.href,
    headers: {}, enabled: true, required: false, trust: false, source: "user", raw: {},
  };
  return { config, requests, close: () => server.stop(true) };
}

function discover() {
  return { result: {
    resultType: "complete", supportedVersions: [VERSION], capabilities: { tools: {} },
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-only", version: "2.0.0" } },
  } };
}

test("negotiates modern-only HTTP and keeps request metadata, pagination and primitive structured output", async () => {
  const remote = fixture((request) => {
    if (request.method === "server/discover") return discover();
    if (request.method === "tools/list") return { result: {
      resultType: "complete", ttlMs: 0, cacheScope: "private",
      tools: request.params?.cursor ? [{ name: "second", inputSchema: { type: "object" } }] : [{
        name: "answer", inputSchema: { type: "object" }, outputSchema: { type: "integer" },
      }],
      ...(request.params?.cursor ? {} : { nextCursor: "page-2" }),
    } };
    if (request.method === "tools/call") return { result: {
      resultType: "complete", content: [], structuredContent: 42,
    } };
    return { error: { code: -32601, message: "This server has no legacy handshake" } };
  });
  const client = createSdkMcpClient(remote.config);
  try {
    expect(await client.initialize()).toMatchObject({ protocolVersion: VERSION, serverInfo: { name: "modern-only" } });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["answer", "second"]);
    expect(await client.callTool("answer", {})).toMatchObject({ structuredContent: 42, content: [] });
    expect(remote.requests.map((request) => request.body.method)).toEqual([
      "server/discover", "tools/list", "tools/list", "tools/call",
    ]);
    for (const { body, headers } of remote.requests) {
      expect(body.params?._meta).toMatchObject({
        "io.modelcontextprotocol/protocolVersion": VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
      });
      expect(headers.get("mcp-protocol-version")).toBe(VERSION);
      expect(headers.get("mcp-method")).toBe(body.method);
      expect(headers.has("mcp-session-id")).toBe(false);
    }
  } finally {
    await client.close();
    await remote.close();
  }
});

test("auto discovery falls back to legacy HTTP and reports the negotiated version", async () => {
  const remote = fixture((request) => {
    if (request.method === "server/discover") return { error: { code: -32601, message: "Method not found" } };
    if (request.method === "initialize") return { result: {
      protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1" },
    } };
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    return { result: { content: [{ type: "text", text: "legacy result" }] } };
  });
  const client = createSdkMcpClient(remote.config);
  try {
    expect(await client.initialize()).toMatchObject({ protocolVersion: "2025-11-25" });
    expect(await client.callTool("legacy", {})).toMatchObject({ content: [{ type: "text", text: "legacy result" }] });
    expect(remote.requests.map((request) => request.body.method)).toEqual([
      "server/discover", "initialize", "notifications/initialized", "tools/call",
    ]);
  } finally {
    await client.close();
    await remote.close();
  }
});

for (const status of [401, 403, 503]) {
  test(`HTTP ${status} during discovery cannot trigger a legacy fallback`, async () => {
    const remote = fixture(() => new Response("unavailable", { status }));
    const client = createSdkMcpClient(remote.config);
    try {
      await expect(client.initialize()).rejects.toBeInstanceOf(Error);
      expect(remote.requests.map((request) => request.body.method)).toEqual(["server/discover"]);
    } finally {
      await client.close();
      await remote.close();
    }
  });
}

test("unsupported multi-round input is a failure and never silently retries a tool", async () => {
  const remote = fixture((request) => request.method === "server/discover" ? discover() : { result: {
    resultType: "input_required", inputRequests: {}, requestState: "opaque-fixture-state",
  } });
  const client = createSdkMcpClient(remote.config);
  try {
    await client.initialize();
    await expect(client.callTool("needs-input", {})).rejects.toBeInstanceOf(Error);
    expect(remote.requests.filter((request) => request.body.method === "tools/call")).toHaveLength(1);
  } finally {
    await client.close();
    await remote.close();
  }
});

test("explicit legacy version pins the handshake instead of reporting an unused option", async () => {
  const remote = fixture((request) => request.method === "initialize" ? { result: {
    protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "pinned", version: "1" },
  } } : new Response(null, { status: 202 }));
  const client = createSdkMcpClient(remote.config);
  try {
    expect(await client.initialize({ protocolVersion: "2025-03-26" })).toMatchObject({ protocolVersion: "2025-03-26" });
    expect(remote.requests[0]?.body.params?.protocolVersion).toBe("2025-03-26");
    expect(remote.requests.some((request) => request.body.method === "server/discover")).toBe(false);
  } finally {
    await client.close();
    await remote.close();
  }
});

test("legacy JSON-RPC adapter refuses to advertise a modern handshake", async () => {
  const remote = fixture(() => ({}));
  let started = false;
  const client = new JsonRpcMcpClient(remote.config, {
    async start() { started = true; },
    async request<T>() { return {} as T; },
    async close() {},
  });
  try {
    await expect(client.initialize({ protocolVersion: MCP_CURRENT_PROTOCOL_VERSION })).rejects.toThrow("handshake revisions only");
    expect(started).toBe(false);
  } finally {
    await remote.close();
  }
});

test("modern list changes arrive over the opted-in POST subscription", async () => {
  let subscription: ReadableStreamDefaultController<Uint8Array> | undefined;
  let subscriptionId: number | string | undefined;
  const encode = (message: unknown) => new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  const remote = fixture((request) => {
    if (request.method === "server/discover") {
      const result = discover();
      result.result.capabilities.tools = { listChanged: true };
      return result;
    }
    if (request.method === "subscriptions/listen") {
      subscriptionId = request.id;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          subscription = controller;
          controller.enqueue(encode({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: {
            notifications: { toolsListChanged: true },
            _meta: { "io.modelcontextprotocol/subscriptionId": request.id },
          } }));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (request.method === "tools/list") return { result: { resultType: "complete", tools: [] } };
    return new Response(null, { status: 202 });
  });
  const client = createSdkMcpClient(remote.config);
  let changed = 0;
  const unsubscribe = client.onToolsChanged(() => { changed++; });
  try {
    await client.initialize({ signal: AbortSignal.timeout(1_000) });
    expect(remote.requests.map(({ body }) => body.method)).toEqual(["server/discover", "subscriptions/listen"]);
    expect(remote.requests[1]?.body.params?.notifications).toEqual({ toolsListChanged: true });
    subscription!.enqueue(encode({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {
      _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId },
    } }));
    const deadline = Date.now() + 1_000;
    while (changed === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(changed).toBe(1);
  } finally {
    unsubscribe();
    await client.close();
    await remote.close();
  }
});

test("modern oversized discovery fails before any fallback handshake", async () => {
  const remote = fixture(() => ({ ...discover(), padding: "x".repeat(2_048) }));
  const client = createSdkMcpClient(remote.config, { ingressLimits: { maxBodyBytes: 1_024 } });
  try {
    await expect(client.initialize()).rejects.toBeInstanceOf(McpHttpIngressLimitError);
    expect(remote.requests.map(({ body }) => body.method)).toEqual(["server/discover"]);
  } finally {
    await client.close();
    await remote.close();
  }
});

test("a truncated modern tool stream does not replay a possibly mutating call", async () => {
  const remote = fixture((request) => request.method === "server/discover" ? discover() : new Response(
    'event: message\ndata: {"jsonrpc":"2.0","id":',
    { headers: { "content-type": "text/event-stream" } },
  ));
  const client = createSdkMcpClient(remote.config);
  try {
    await client.initialize();
    await expect(client.callTool("mutate", {}, { signal: AbortSignal.timeout(500) })).rejects.toBeInstanceOf(Error);
    expect(remote.requests.filter(({ body }) => body.method === "tools/call")).toHaveLength(1);
  } finally {
    await client.close();
    await remote.close();
  }
});

test("modern concurrent multi-round input stays bound to its caller and echoes only each round's answers", async () => {
  const pending = new Map<string, (value: { action: "accept"; content: { answer: string } }) => void>();
  const remote = fixture((request) => {
    if (request.method === "server/discover") return discover();
    const name = String(request.params?.name);
    const state = request.params?.requestState;
    if (state === `${name}:second`) return { result: { resultType: "complete", content: [], structuredContent: request.params?.inputResponses } };
    return { result: {
      resultType: "input_required", requestState: `${name}:${state ? "second" : "first"}`,
      inputRequests: { [state ? "second" : "first"]: { method: "elicitation/create", params: {
        mode: "form", message: name, requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
      } } },
    } };
  });
  const client = createSdkMcpClient(remote.config, { enableElicitation: true });
  let rechecks = 0;
  try {
    await client.initialize();
    const calls = ["a", "b"].map((name) => client.callTool(name, {}, {
      beforeRetry: async () => { rechecks++; },
      elicitation: async (request) => {
        expect(request.message).toBe(name);
        return new Promise((resolve) => { pending.set(name, resolve); });
      },
    }));
    for (let round = 0; round < 2; round++) {
      for (let attempt = 0; pending.size < 2 && attempt < 100; attempt++) await Bun.sleep(5);
      expect(pending.size).toBe(2);
      const answers = [...pending.entries()].reverse();
      pending.clear();
      for (const [name, resolve] of answers) resolve({ action: "accept", content: { answer: `${name}-${round}` } });
    }
    const results = await Promise.all(calls);
    expect(results.map((result) => result.structuredContent)).toEqual([
      { second: { action: "accept", content: { answer: "a-1" } } },
      { second: { action: "accept", content: { answer: "b-1" } } },
    ]);
    expect(rechecks).toBe(4);
    const requests = remote.requests.filter(({ body }) => body.method === "tools/call");
    expect(new Set(requests.map(({ body }) => body.id)).size).toBe(6);
  } finally { await client.close(); await remote.close(); }
});

test("MCP continuation cannot execute after its approval is revoked", async () => {
  const remote = fixture((request) => request.method === "server/discover" ? discover() : { result: {
    resultType: "input_required", requestState: "pending", inputRequests: { confirm: {
      method: "elicitation/create", params: { mode: "url", message: "Confirm", url: "https://example.test/confirm" },
    } },
  } });
  const client = createSdkMcpClient(remote.config, { enableElicitation: true });
  try {
    await client.initialize();
    await expect(client.callTool("mutate", {}, {
      elicitation: async () => ({ action: "accept" }),
      beforeRetry: async () => { throw new Error("Approval revoked"); },
    })).rejects.toThrow("Approval revoked");
    expect(remote.requests.filter(({ body }) => body.method === "tools/call")).toHaveLength(1);
  } finally { await client.close(); await remote.close(); }
});

test("cancelling a modern input wait cannot resend the tool", async () => {
  const remote = fixture((request) => request.method === "server/discover" ? discover() : { result: {
    resultType: "input_required", requestState: "waiting", inputRequests: { question: {
      method: "elicitation/create", params: { mode: "url", message: "Confirm", url: "https://example.test/confirm" },
    } },
  } });
  const client = createSdkMcpClient(remote.config, { enableElicitation: true });
  const abort = new AbortController();
  try {
    await client.initialize();
    await expect(client.callTool("mutate", {}, { signal: abort.signal, elicitation: async (_request, signal) => {
      abort.abort(new Error("Interrupted input"));
      signal.throwIfAborted();
      return { action: "accept" };
    } })).rejects.toThrow("Interrupted input");
    expect(remote.requests.filter(({ body }) => body.method === "tools/call")).toHaveLength(1);
  } finally { await client.close(); await remote.close(); }
});

test("legacy fallback does not advertise uncorrelated server-initiated input", async () => {
  const remote = fixture((request) => {
    if (request.method === "server/discover") return { error: { code: -32601, message: "Method not found" } };
    if (request.method === "initialize") return { result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "legacy", version: "1" } } };
    return new Response(null, { status: 202 });
  });
  const client = createSdkMcpClient(remote.config, { enableElicitation: true });
  try {
    await client.initialize();
    expect(remote.requests.find(({ body }) => body.method === "initialize")?.body.params?.capabilities).toEqual({});
  } finally { await client.close(); await remote.close(); }
});
