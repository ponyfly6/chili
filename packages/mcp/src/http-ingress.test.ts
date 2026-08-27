import { expect, test } from "bun:test";
import {
  createBoundedMcpFetch,
  DEFAULT_MCP_HTTP_INGRESS_LIMITS,
  McpHttpIngressLimitError,
  type McpHttpIngressLimits,
} from "./http-ingress.js";

const encoder = new TextEncoder();
const smallLimits: McpHttpIngressLimits = {
  maxBodyBytes: 8,
  maxErrorBodyBytes: 8,
  maxSseFrameBytes: 10,
  maxSseFrameLines: 2,
};

test("defaults JSON bodies and individual SSE frames to exactly 4 MiB", () => {
  expect(DEFAULT_MCP_HTTP_INGRESS_LIMITS.maxBodyBytes).toBe(4 * 1024 * 1024);
  expect(DEFAULT_MCP_HTTP_INGRESS_LIMITS.maxSseFrameBytes).toBe(4 * 1024 * 1024);
});

test("accepts an exact-limit chunked JSON success body and preserves response metadata", async () => {
  const fixture = chunkedResponse(["{\"ok\"", ":1}"], {
    headers: { "content-type": "application/json" },
  });
  defineResponseMetadata(fixture.response, {
    url: "https://example.test/final",
    redirected: true,
    type: "cors",
  });
  const boundedFetch = createBoundedMcpFetch(fetchReturning(fixture.response), { limits: smallLimits });

  const response = await boundedFetch("https://example.test/mcp");

  expect(await response.json()).toEqual({ ok: 1 });
  expect(response.url).toBe("https://example.test/final");
  expect(response.redirected).toBe(true);
  expect(response.type).toBe("cors");
  expect(fixture.cancelled).toBe(false);
});

test("rejects a limit-plus-one chunked JSON success body before forwarding the crossing chunk", async () => {
  const fixture = chunkedResponse(["{\"ok\":1", "0}"], {
    headers: { "content-type": "application/json" },
  });
  const fatalErrors: McpHttpIngressLimitError[] = [];
  const boundedFetch = createBoundedMcpFetch(fetchReturning(fixture.response), {
    limits: smallLimits,
    onLimit: (error) => fatalErrors.push(error),
  });

  const response = await boundedFetch("https://example.test/mcp");

  await expect(response.json()).rejects.toMatchObject({
    name: "McpHttpIngressLimitError",
    code: "MCP_HTTP_INGRESS_LIMIT",
    kind: "response-body-bytes",
    limit: 8,
    observed: 9,
    source: "stream",
  });
  expect(fixture.cancelled).toBe(true);
  expect(fatalErrors).toHaveLength(1);
});

test("bounds a chunked HTTP error body before response.text completes", async () => {
  const fixture = chunkedResponse(["{\"e\":10", "0}"], {
    status: 500,
    headers: { "content-type": "text/event-stream" },
  });
  const fatalErrors: McpHttpIngressLimitError[] = [];
  const boundedFetch = createBoundedMcpFetch(fetchReturning(fixture.response), {
    limits: smallLimits,
    onLimit: (error) => fatalErrors.push(error),
  });

  const response = await boundedFetch("https://example.test/mcp");

  await expect(response.text()).rejects.toMatchObject({
    kind: "error-body-bytes",
    limit: 8,
    observed: 9,
    source: "stream",
  });
  expect(fixture.cancelled).toBe(true);
  expect(fatalErrors).toHaveLength(1);
});

test("accepts an exact-limit chunked HTTP error body", async () => {
  const fixture = chunkedResponse(["{\"e\"", ":10}"], {
    status: 500,
    headers: { "content-type": "application/json" },
  });
  const boundedFetch = createBoundedMcpFetch(fetchReturning(fixture.response), { limits: smallLimits });

  const response = await boundedFetch("https://example.test/mcp");

  expect(await response.text()).toBe("{\"e\":10}");
  expect(fixture.cancelled).toBe(false);
});

test("does not forward the chunk that crosses a response body limit", async () => {
  const fixture = chunkedResponse(["1234567", "89"], {
    headers: { "content-type": "application/json" },
  });
  const boundedFetch = createBoundedMcpFetch(fetchReturning(fixture.response), { limits: smallLimits });
  const response = await boundedFetch("https://example.test/mcp");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("expected bounded response body");

  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(first.value && new TextDecoder().decode(first.value)).toBe("1234567");
  await expect(reader.read()).rejects.toMatchObject({
    kind: "response-body-bytes",
    observed: 9,
  });
  expect(fixture.cancelled).toBe(true);
});

test("fails from oversized content-length without pulling the response body", async () => {
  const fixture = chunkedResponse(["never-read"], {
    headers: {
      "content-length": "9",
      "content-type": "application/json",
    },
  });
  const fatalErrors: McpHttpIngressLimitError[] = [];
  const boundedFetch = createBoundedMcpFetch(fetchReturning(fixture.response), {
    limits: smallLimits,
    onLimit: (error) => fatalErrors.push(error),
  });

  await expect(boundedFetch("https://example.test/mcp")).rejects.toMatchObject({
    kind: "response-body-bytes",
    limit: 8,
    observed: 9,
    source: "content-length",
  });
  expect(fixture.pulls).toBe(0);
  expect(fixture.cancelled).toBe(true);
  expect(fatalErrors).toHaveLength(1);
});

for (const testCase of [
  {
    name: "LF",
    chunks: ["data:abc\n", "\ndata:abc", "\n\n"],
  },
  {
    name: "CRLF",
    chunks: ["data:abc\r", "\n\r", "\ndata:abc\r", "\n\r\n"],
  },
  {
    name: "bare CR",
    chunks: ["data:abc\r", "\rdata:abc\r", "\r"],
  },
] as const) {
  test(`resets the SSE frame byte limit across chunk-split ${testCase.name} separators`, async () => {
    const fixture = chunkedResponse(testCase.chunks, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
    const boundedFetch = createBoundedMcpFetch(fetchReturning(fixture.response), { limits: smallLimits });

    const response = await boundedFetch("https://example.test/mcp");

    expect(await response.text()).toBe(testCase.chunks.join(""));
    expect(fixture.cancelled).toBe(false);
  });
}

test("allows a long SSE connection whose many legal frames exceed the per-frame limit in aggregate", async () => {
  const body = "data:x\n\n".repeat(20);
  const fixture = chunkedResponse(Array.from({ length: 20 }, () => "data:x\n\n"), {
    headers: { "content-type": "text/event-stream" },
  });
  const boundedFetch = createBoundedMcpFetch(fetchReturning(fixture.response), { limits: smallLimits });

  const response = await boundedFetch("https://example.test/mcp");

  expect(await response.text()).toBe(body);
  expect(body.length).toBeGreaterThan(smallLimits.maxSseFrameBytes);
  expect(fixture.cancelled).toBe(false);
});

test("rejects one oversized SSE frame split across chunks and cancels upstream", async () => {
  const fixture = chunkedResponse(["data:ab", "cd", "\n\n"], {
    headers: { "content-type": "text/event-stream" },
  });
  const fatalErrors: McpHttpIngressLimitError[] = [];
  const boundedFetch = createBoundedMcpFetch(fetchReturning(fixture.response), {
    limits: { ...smallLimits, maxSseFrameBytes: 8 },
    onLimit: (error) => fatalErrors.push(error),
  });

  const response = await boundedFetch("https://example.test/mcp");

  await expect(response.text()).rejects.toMatchObject({
    kind: "sse-frame-bytes",
    limit: 8,
    observed: 9,
    source: "stream",
  });
  expect(fixture.cancelled).toBe(true);
  expect(fatalErrors).toHaveLength(1);
});

test("counts raw UTF-8 bytes and content-line newline overhead in an SSE frame", async () => {
  const exactFixture = chunkedResponse(["data:界\n", "\n"], {
    headers: { "content-type": "text/event-stream" },
  });
  const exactFetch = createBoundedMcpFetch(fetchReturning(exactFixture.response), {
    limits: { ...smallLimits, maxSseFrameBytes: 9 },
  });
  const exactResponse = await exactFetch("https://example.test/mcp");

  expect(await exactResponse.text()).toBe("data:界\n\n");

  const oversizedFixture = chunkedResponse(["data:界", "\n\n"], {
    headers: { "content-type": "text/event-stream" },
  });
  const oversizedFetch = createBoundedMcpFetch(fetchReturning(oversizedFixture.response), {
    limits: { ...smallLimits, maxSseFrameBytes: 8 },
  });
  const oversizedResponse = await oversizedFetch("https://example.test/mcp");

  await expect(oversizedResponse.text()).rejects.toMatchObject({
    kind: "sse-frame-bytes",
    limit: 8,
    observed: 9,
  });
  expect(oversizedFixture.cancelled).toBe(true);
});

test("rejects an SSE frame with too many short lines", async () => {
  const fixture = chunkedResponse(["data:a\ndata:b\n", "data:c\n\n"], {
    headers: { "content-type": "text/event-stream" },
  });
  const fatalErrors: McpHttpIngressLimitError[] = [];
  const boundedFetch = createBoundedMcpFetch(fetchReturning(fixture.response), {
    limits: { ...smallLimits, maxSseFrameBytes: 128 },
    onLimit: (error) => fatalErrors.push(error),
  });

  const response = await boundedFetch("https://example.test/mcp");

  await expect(response.text()).rejects.toMatchObject({
    kind: "sse-frame-lines",
    limit: 2,
    observed: 3,
    source: "stream",
  });
  expect(fixture.cancelled).toBe(true);
  expect(fatalErrors).toHaveLength(1);
});

interface ChunkedResponseFixture {
  response: Response;
  readonly pulls: number;
  readonly cancelled: boolean;
}

function chunkedResponse(chunks: readonly string[], init: ResponseInit = {}): ChunkedResponseFixture {
  let index = 0;
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const response = new Response(body, init);
  return {
    response,
    get pulls() {
      return pulls;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

function fetchReturning(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

function defineResponseMetadata(
  response: Response,
  metadata: { url: string; redirected: boolean; type: ResponseType },
): void {
  Object.defineProperties(response, {
    url: { configurable: true, value: metadata.url },
    redirected: { configurable: true, value: metadata.redirected },
    type: { configurable: true, value: metadata.type },
  });
}
