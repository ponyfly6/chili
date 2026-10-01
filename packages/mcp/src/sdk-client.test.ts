import { expect, test } from "bun:test";
import type { McpServerConfig } from "./config.js";
import {
  DEFAULT_MCP_HTTP_INGRESS_LIMITS,
  McpHttpIngressLimitError,
  type McpHttpIngressLimits,
} from "./http-ingress.js";
import { createSdkMcpClient, createSdkMcpTransport } from "./sdk-client.js";

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

test("streamable HTTP rejects a chunked oversized JSON success before SDK parsing", async () => {
  const fixture = createStreamableHttpFixture(({ id }) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "X".repeat(1_000) }] },
    });
    return chunkedResponse([body.slice(0, 500), body.slice(500)], {
      headers: { "content-type": "application/json" },
    });
  });
  const client = createSdkMcpClient(httpServer(), {
    fetch: fixture.fetch,
    ingressLimits: integrationLimits(),
  });

  try {
    await client.initialize();

    const error = await limitErrorWithin(client.callTool("huge", {}));

    expect(error).toMatchObject({ kind: "response-body-bytes", limit: 512, source: "stream" });
    expect(fixture.toolBodyCancelled).toBe(true);
    expect(fixture.requestHeaders.every((headers) => headers.get("x-mcp-secret") === "secret")).toBe(true);
    expect(await limitErrorWithin(client.listTools())).toBe(error);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("streamable HTTP default rejects an exact 4 MiB plus one chunked JSON response", async () => {
  const limit = DEFAULT_MCP_HTTP_INGRESS_LIMITS.maxBodyBytes;
  const fixture = createStreamableHttpFixture(({ id }) => {
    const body = jsonRpcToolResponseAtBytes(id, limit + 1);
    expect(new TextEncoder().encode(body).byteLength).toBe(limit + 1);
    return chunkedResponse([body.slice(0, limit), body.slice(limit)], {
      headers: { "content-type": "application/json" },
    });
  });
  const client = createSdkMcpClient(httpServer(), { fetch: fixture.fetch });

  try {
    await client.initialize();

    const error = await limitErrorWithin(client.callTool("default_huge", {}), 2_000);

    expect(error).toMatchObject({
      kind: "response-body-bytes",
      limit,
      observed: limit + 1,
      source: "stream",
    });
    expect(fixture.toolBodyCancelled).toBe(true);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("streamable HTTP rejects a chunked oversized error body without waiting for SDK timeout", async () => {
  const fixture = createStreamableHttpFixture(() => {
    return chunkedResponse(["E".repeat(32), "E"], {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
  });
  const client = createSdkMcpClient(httpServer(), {
    fetch: fixture.fetch,
    ingressLimits: integrationLimits(),
  });

  try {
    await client.initialize();

    const error = await limitErrorWithin(client.callTool("huge_error", {}));

    expect(error).toMatchObject({
      kind: "error-body-bytes",
      limit: 32,
      observed: 33,
      source: "stream",
    });
    expect(fixture.toolBodyCancelled).toBe(true);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("streamable HTTP closes and immediately rejects an oversized SSE response frame", async () => {
  const fixture = createStreamableHttpFixture(({ id }) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "S".repeat(1_000) }] },
    });
    const frame = `data: ${message}\n\n`;
    return chunkedResponse([frame.slice(0, 100), frame.slice(100)], {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const client = createSdkMcpClient(httpServer(), {
    fetch: fixture.fetch,
    ingressLimits: { ...integrationLimits(), maxSseFrameBytes: 128 },
  });

  try {
    await client.initialize();

    const error = await limitErrorWithin(client.callTool("huge_sse", {}));

    expect(error).toMatchObject({ kind: "sse-frame-bytes", limit: 128, source: "stream" });
    expect(fixture.toolBodyCancelled).toBe(true);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("legacy SSE rejects an oversized message after endpoint discovery and does not reconnect", async () => {
  const fixture = createLegacySseFixture("oversized-message");
  const client = createSdkMcpClient(sseServer(), {
    fetch: fixture.fetch,
    ingressLimits: { ...integrationLimits(), maxSseFrameBytes: 128 },
  });

  try {
    const error = await limitErrorWithin(client.initialize());

    expect(error).toMatchObject({ kind: "sse-frame-bytes", limit: 128, source: "stream" });
    expect(fixture.eventStreamCancelled).toBe(true);
    expect(fixture.getCalls).toBe(1);
    expect(fixture.requestHeaders.every((headers) => headers.get("x-mcp-secret") === "secret")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fixture.getCalls).toBe(1);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("legacy SSE GET default rejects an exact 4 MiB plus one event frame", async () => {
  const limit = DEFAULT_MCP_HTTP_INGRESS_LIMITS.maxSseFrameBytes;
  const fixture = createLegacySseFixture("oversized-message", { oversizedFrameBytes: limit + 1 });
  const client = createSdkMcpClient(sseServer(), { fetch: fixture.fetch });

  try {
    const error = await limitErrorWithin(client.initialize(), 2_000);

    expect(error).toMatchObject({
      kind: "sse-frame-bytes",
      limit,
      observed: limit + 1,
      source: "stream",
    });
    expect(fixture.eventStreamCancelled).toBe(true);
    expect(fixture.getCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fixture.getCalls).toBe(1);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("legacy SSE applies the bounded top-level fetch to an oversized POST error body", async () => {
  const fixture = createLegacySseFixture("post-error");
  const client = createSdkMcpClient(sseServer(), {
    fetch: fixture.fetch,
    ingressLimits: { ...integrationLimits(), maxSseFrameBytes: 512 },
  });

  try {
    await client.initialize();

    const error = await limitErrorWithin(client.callTool("post_error", {}));

    expect(error).toMatchObject({
      kind: "error-body-bytes",
      limit: 32,
      observed: 33,
      source: "stream",
    });
    expect(fixture.postErrorBodyCancelled).toBe(true);
    expect(fixture.eventStreamCancelled).toBe(true);
    expect(fixture.requestHeaders.every((headers) => headers.get("x-mcp-secret") === "secret")).toBe(true);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("legacy SSE POST default rejects an exact error-body limit plus one response", async () => {
  const limit = DEFAULT_MCP_HTTP_INGRESS_LIMITS.maxErrorBodyBytes;
  const fixture = createLegacySseFixture("post-error", { postErrorBodyBytes: limit + 1 });
  const client = createSdkMcpClient(sseServer(), { fetch: fixture.fetch });

  try {
    await client.initialize();

    const error = await limitErrorWithin(client.callTool("default_post_error", {}), 2_000);

    expect(error).toMatchObject({
      kind: "error-body-bytes",
      limit,
      observed: limit + 1,
      source: "stream",
    });
    expect(fixture.postErrorBodyCancelled).toBe(true);
    expect(fixture.eventStreamCancelled).toBe(true);
  } finally {
    await client.close().catch(() => undefined);
  }
});

interface JsonRpcRequest {
  id?: string | number;
  method: string;
}

interface ResponseFixture {
  response: Response;
  readonly cancelled: boolean;
}

interface StreamableHttpFixture {
  fetch: typeof fetch;
  requestHeaders: Headers[];
  readonly toolBodyCancelled: boolean;
}

function createStreamableHttpFixture(
  toolResponse: (request: Required<Pick<JsonRpcRequest, "id">> & JsonRpcRequest) => ResponseFixture,
): StreamableHttpFixture {
  let toolBody: ResponseFixture | undefined;
  const requestHeaders: Headers[] = [];
  const fixtureFetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    requestHeaders.push(new Headers(init?.headers));
    if (method === "GET") return new Response(null, { status: 405 });
    const request = parseRequest(init?.body);
    if (request.method === "server/discover" && request.id !== undefined) {
      return jsonResponse({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    }
    if (request.method === "initialize" && request.id !== undefined) {
      return jsonResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: initializeResult(),
      });
    }
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (request.method === "tools/call" && request.id !== undefined) {
      toolBody = toolResponse({ ...request, id: request.id });
      return toolBody.response;
    }
    throw new Error(`unexpected streamable HTTP request: ${request.method}`);
  }) as unknown as typeof fetch;
  return {
    fetch: fixtureFetch,
    requestHeaders,
    get toolBodyCancelled() {
      return toolBody?.cancelled ?? false;
    },
  };
}

type LegacyFixtureMode = "oversized-message" | "post-error";

interface LegacyFixtureOptions {
  oversizedFrameBytes?: number;
  postErrorBodyBytes?: number;
}

interface LegacySseFixture {
  fetch: typeof fetch;
  requestHeaders: Headers[];
  readonly getCalls: number;
  readonly eventStreamCancelled: boolean;
  readonly postErrorBodyCancelled: boolean;
}

function createLegacySseFixture(
  mode: LegacyFixtureMode,
  options: LegacyFixtureOptions = {},
): LegacySseFixture {
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let eventStreamCancelled = false;
  let postErrorBody: ResponseFixture | undefined;
  let getCalls = 0;
  const requestHeaders: Headers[] = [];
  const eventBody = new ReadableStream<Uint8Array>({
    start(controller) {
      eventController = controller;
      controller.enqueue(new TextEncoder().encode([
        "retry: 1",
        "event: endpoint",
        "data: /messages",
        "",
        "",
      ].join("\n")));
    },
    cancel() {
      eventStreamCancelled = true;
    },
  }, { highWaterMark: 0 });

  const fixtureFetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    requestHeaders.push(new Headers(init?.headers));
    if (method === "GET") {
      getCalls += 1;
      init?.signal?.addEventListener("abort", () => {
        eventStreamCancelled = true;
        try {
          eventController?.error(new DOMException("Aborted", "AbortError"));
        } catch {
          // The limiter may already have cancelled and closed the fixture stream.
        }
      }, { once: true });
      return new Response(eventBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }

    const request = parseRequest(init?.body);
    if (request.method === "initialize" && request.id !== undefined) {
      if (mode === "oversized-message") {
        if (options.oversizedFrameBytes === undefined) {
          enqueueEvent(eventController, {
            jsonrpc: "2.0",
            id: request.id,
            result: { ...initializeResult(), instructions: "I".repeat(1_000) },
          });
        } else {
          enqueueSizedInitializeEvent(eventController, request.id, options.oversizedFrameBytes);
        }
      } else {
        enqueueEvent(eventController, {
          jsonrpc: "2.0",
          id: request.id,
          result: initializeResult(),
        });
      }
      return new Response(null, { status: 202 });
    }
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (request.method === "tools/call" && request.id !== undefined && mode === "post-error") {
      const bodyBytes = options.postErrorBodyBytes ?? 33;
      postErrorBody = chunkedResponse(["P".repeat(bodyBytes - 1), "P"], {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
      return postErrorBody.response;
    }
    throw new Error(`unexpected legacy SSE request: ${request.method}`);
  }) as unknown as typeof fetch;

  return {
    fetch: fixtureFetch,
    requestHeaders,
    get getCalls() {
      return getCalls;
    },
    get eventStreamCancelled() {
      return eventStreamCancelled;
    },
    get postErrorBodyCancelled() {
      return postErrorBody?.cancelled ?? false;
    },
  };
}

function enqueueEvent(controller: ReadableStreamDefaultController<Uint8Array> | undefined, message: unknown): void {
  if (!controller) throw new Error("legacy SSE event stream was not started");
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
}

function enqueueSizedInitializeEvent(
  controller: ReadableStreamDefaultController<Uint8Array> | undefined,
  id: string | number,
  frameBytes: number,
): void {
  if (!controller) throw new Error("legacy SSE event stream was not started");
  const prefix = `data: {"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"0.0.0"},"instructions":"`;
  const suffix = `"}}\n\n`;
  const fixedFrameBytes = new TextEncoder().encode(`${prefix}"}}\n`).byteLength;
  const fillerBytes = frameBytes - fixedFrameBytes;
  if (fillerBytes < 0) throw new Error(`frame target ${frameBytes} is too small`);
  const frame = `${prefix}${"I".repeat(fillerBytes)}${suffix}`;
  expect(new TextEncoder().encode(frame.slice(0, -1)).byteLength).toBe(frameBytes);
  controller.enqueue(new TextEncoder().encode(frame));
}

function jsonRpcToolResponseAtBytes(id: string | number, bodyBytes: number): string {
  const prefix = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"content":[{"type":"text","text":"`;
  const suffix = `"}]}}`;
  const fixedBodyBytes = new TextEncoder().encode(`${prefix}${suffix}`).byteLength;
  const fillerBytes = bodyBytes - fixedBodyBytes;
  if (fillerBytes < 0) throw new Error(`body target ${bodyBytes} is too small`);
  return `${prefix}${"X".repeat(fillerBytes)}${suffix}`;
}

function chunkedResponse(chunks: readonly string[], init: ResponseInit): ResponseFixture {
  let index = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(chunk));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  return {
    response: new Response(body, init),
    get cancelled() {
      return cancelled;
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function parseRequest(body: BodyInit | null | undefined): JsonRpcRequest {
  if (typeof body !== "string") throw new Error("expected JSON string request body");
  return JSON.parse(body) as JsonRpcRequest;
}

function initializeResult(): Record<string, unknown> {
  return {
    protocolVersion: "2025-11-25",
    capabilities: { tools: {} },
    serverInfo: { name: "fixture", version: "0.0.0" },
  };
}

function integrationLimits(): McpHttpIngressLimits {
  return {
    maxBodyBytes: 512,
    maxErrorBodyBytes: 32,
    maxSseFrameBytes: 512,
    maxSseFrameLines: 32,
  };
}

function httpServer(): McpServerConfig {
  return {
    name: "http-fixture",
    type: "http",
    url: "https://example.test/mcp",
    headers: { "x-mcp-secret": "secret" },
    enabled: true,
    required: false,
    trust: false,
    source: "user",
    raw: {},
  };
}

function sseServer(): McpServerConfig {
  return {
    name: "sse-fixture",
    type: "sse",
    url: "https://example.test/events",
    headers: { "x-mcp-secret": "secret" },
    enabled: true,
    required: false,
    trust: false,
    source: "user",
    raw: {},
  };
}

async function limitErrorWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<McpHttpIngressLimitError> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => Promise.reject(new Error("expected MCP ingress limit rejection")),
        (error: unknown) => {
          if (error instanceof McpHttpIngressLimitError) return error;
          throw error;
        },
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`MCP request did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
