import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs } from "@chili/protocol";
import { buildAnthropicRequestBody } from "../../protocols/messages.js";
import type { ModelStreamEvent } from "../../types.js";
import { createAnthropicProvider, createAnthropicRouter } from "./provider.js";
import { ANTHROPIC_HAIKU_45_MODEL, ANTHROPIC_MODELS, ANTHROPIC_OPUS_55_MODEL, ANTHROPIC_SONNET_55_MODEL } from "./models.js";

function requestCapture(response = jsonResponse()) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return response;
  }) as unknown as typeof fetch;
  return { requests, fetch: fetchImpl };
}

function jsonResponse(content: unknown[] = [{ type: "text", text: "done" }]): Response {
  return Response.json({ id: "msg_test", model: ANTHROPIC_OPUS_55_MODEL, content, stop_reason: "end_turn" });
}

function sseResponse(payloads: Record<string, unknown>[]): Response {
  return new Response(payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const result: ModelStreamEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

function message(role: Message["role"], parts: Record<string, unknown>[]): Message {
  const messageId = `msg_${role}` as MessageId;
  const sessionId = "session_claude" as SessionId;
  return {
    id: messageId, sessionId, role, createdAt: 1 as TimestampMs,
    parts: parts.map((part, index) => ({ id: `part_${index}` as PartId, messageId, sessionId, ...part })) as Message["parts"],
  };
}

function buildReplay(messages: Message[]) {
  return buildAnthropicRequestBody({ messages }, {
    provider: "anthropic", model: ANTHROPIC_OPUS_55_MODEL,
    compatibility: { supportsThinkingReplay: true, supportsAdaptiveReasoningEffort: true, supportsThinkingPrefixBinding: true },
  });
}

test("official Anthropic uses its own credentials, Messages headers and bound adaptive thinking", async () => {
  const capture = requestCapture();
  const router = createAnthropicRouter({
    env: { ANTHROPIC_API_KEY: "claude-key", MINIMAX_API_KEY: "other-key" },
    headers: { "anthropic-beta": "existing-beta" }, temperature: 0.2, ...capture,
  });
  await collect(router.stream({ messages: [message("user", [{ type: "text", text: "hello" }])], reasoning: "xhigh", serviceTier: "fast" }));
  const request = capture.requests[0]!;
  expect(request.url).toBe("https://api.anthropic.com/v1/messages");
  expect(request.headers.get("x-api-key")).toBe("claude-key");
  expect(request.headers.get("authorization")).toBeNull();
  expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
  expect(request.headers.get("anthropic-beta")).toBe("existing-beta,thinking-binding-controls-2026-08-01");
  expect(request.body).toMatchObject({
    model: ANTHROPIC_OPUS_55_MODEL, max_tokens: 128_000,
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort: "xhigh" },
  });
  expect(request.body).not.toHaveProperty("temperature");
  expect(request.body).not.toHaveProperty("service_tier");
  expect(() => createAnthropicRouter({ env: { MINIMAX_API_KEY: "other-key" } })).toThrow("API key");
});

test("Claude catalog has independent caps and clamps unavailable off to low for adaptive models", async () => {
  const opus = ANTHROPIC_MODELS.find((model) => model.model === ANTHROPIC_OPUS_55_MODEL)!;
  expect(opus).toMatchObject({ contextWindowTokens: 1_000_000, maxOutputTokens: 128_000, default: true });
  expect(opus.reasoningLevels).not.toContain("off");
  const capture = requestCapture();
  await collect(createAnthropicRouter({ apiKey: "test", model: ANTHROPIC_SONNET_55_MODEL, ...capture }).stream({ messages: [], reasoning: "off" }));
  expect(capture.requests[0]?.body.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  expect(capture.requests[0]?.body.output_config).toEqual({ effort: "low" });
});

test("Haiku uses bounded manual thinking and never sends adaptive effort or binding controls", async () => {
  const capture = requestCapture();
  await collect(createAnthropicRouter({ apiKey: "test", model: ANTHROPIC_HAIKU_45_MODEL, temperature: 0.3, ...capture }).stream({ messages: [], reasoning: "high", maxTokens: 128_000 }));
  expect(capture.requests[0]?.body).toMatchObject({ max_tokens: 64_000, temperature: 1, thinking: { type: "enabled", budget_tokens: 16384 } });
  expect(capture.requests[0]?.body).not.toHaveProperty("output_config");
  expect(capture.requests[0]?.headers.has("anthropic-beta")).toBe(false);
  const disabled = requestCapture();
  await collect(createAnthropicRouter({ apiKey: "test", model: ANTHROPIC_HAIKU_45_MODEL, ...disabled }).stream({ messages: [], reasoning: "off" }));
  expect(disabled.requests[0]?.body.thinking).toEqual({ type: "disabled" });
  const bounded = requestCapture();
  await collect(createAnthropicRouter({ apiKey: "test", model: ANTHROPIC_HAIKU_45_MODEL, maxTokens: 1200, ...bounded }).stream({ messages: [] }));
  expect(bounded.requests[0]?.body.thinking).toEqual({ type: "enabled", budget_tokens: 1199 });
});

test("unknown model IDs do not inherit guessed Claude limits or adaptive thinking", async () => {
  const provider = createAnthropicProvider({ model: "private-model", baseUrl: "https://tenant.test/v1" });
  expect(provider.models()[0]).toMatchObject({ model: "private-model", default: true, baseUrl: "https://tenant.test/v1" });
  expect(provider.models()[0]).not.toHaveProperty("maxOutputTokens");
  const capture = requestCapture();
  await collect(createAnthropicRouter({ apiKey: "test", model: "private-model", baseUrl: "https://tenant.test/v1", ...capture }).stream({ messages: [] }));
  expect(capture.requests[0]?.url).toBe("https://tenant.test/v1/messages");
  expect(capture.requests[0]?.body).not.toHaveProperty("thinking");
});

test("streamed signed thinking and redacted blocks replay exactly before tool results", async () => {
  const thinking = { type: "thinking", thinking: "Check files.", signature: "signed-state" };
  const redacted = { type: "redacted_thinking", data: "encrypted-state" };
  const capture = requestCapture(sseResponse([
    { type: "message_start", message: { id: "msg_tool", model: ANTHROPIC_OPUS_55_MODEL } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check files." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "state" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: redacted },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_read", name: "read", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"file.ts"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ]));
  const events = await collect(createAnthropicRouter({ apiKey: "test", ...capture }).stream({ messages: [] }));
  const outputs = events.filter((event) => event.type === "reasoning_item").map((event) => event.output);
  expect(outputs.map((output) => output.item.block)).toEqual([thinking, redacted]);
  expect(events).toContainEqual({ type: "tool_call_end", toolCallId: "toolu_read", name: "read", input: { path: "file.ts" }, index: 2 });
  const body = buildReplay([
    message("assistant", [
      { type: "reasoning", text: "Check files." },
      { type: "reasoning", text: "", modelOutput: outputs[0] },
      { type: "reasoning", text: "[Reasoning redacted]", redacted: true },
      { type: "reasoning", text: "", modelOutput: outputs[1] },
      { type: "tool_call", callId: "internal_read", providerCallId: "toolu_read", toolName: "read", input: { path: "file.ts" }, status: "completed" },
    ]),
    message("tool", [{ type: "tool_result", callId: "internal_read", providerCallId: "toolu_read", output: "export {}" }]),
  ]);
  expect(body.messages).toEqual([
    { role: "assistant", content: [thinking, redacted, { type: "tool_use", id: "toolu_read", name: "read", input: { path: "file.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "export {}" }] },
  ]);
});

test("omitted thinking still preserves its signature; foreign and unsigned state never replays", async () => {
  const block = { type: "thinking", thinking: "", signature: "opaque-signature" };
  const capture = requestCapture(jsonResponse([block]));
  const events = await collect(createAnthropicRouter({ apiKey: "test", ...capture }).stream({ messages: [] }));
  expect(events).toContainEqual({ type: "reasoning_item", output: { apiFamily: "anthropic-messages", outputIndex: 0, item: { provider: "anthropic", block } } });
  const body = buildReplay([message("assistant", [
    { type: "reasoning", text: "", modelOutput: { apiFamily: "anthropic-messages", item: { provider: "minimax", block } } },
    { type: "reasoning", text: "", modelOutput: { apiFamily: "anthropic-messages", item: { provider: "anthropic", block: { type: "thinking", thinking: "unsigned" } } } },
    { type: "text", text: "Visible answer." },
  ])]);
  expect(body.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "Visible answer." }] }]);
});

test("incomplete thinking never becomes an opaque completed item", async () => {
  for (const complete of [false, true]) {
    const capture = requestCapture(sseResponse([
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "partial" } },
      ...(complete ? [{ type: "content_block_stop", index: 0 }] : []),
      { type: "message_stop" },
    ]));
    const events: ModelStreamEvent[] = [];
    await expect((async () => {
      for await (const event of createAnthropicRouter({ apiKey: "test", ...capture }).stream({ messages: [] })) events.push(event);
    })()).rejects.toThrow();
    expect(events.some((event) => event.type === "reasoning_item")).toBe(false);
  }
});

test("a pre-aborted Anthropic request does not dispatch", async () => {
  const capture = requestCapture();
  const controller = new AbortController();
  controller.abort();
  await expect(collect(createAnthropicRouter({ apiKey: "test", ...capture }).stream({ messages: [], signal: controller.signal }))).rejects.toThrow();
  expect(capture.requests).toHaveLength(0);
});


test("cancelling an open thinking block closes its reader without persisting partial signatures", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode([
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "partial" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "partial-signature" } },
      ].map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")));
    },
    cancel() { cancelled = true; },
  });
  const capture = requestCapture(new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const iterator = createAnthropicRouter({ apiKey: "test", ...capture }).stream({ messages: [], signal: controller.signal })[Symbol.asyncIterator]();
  expect(await iterator.next()).toMatchObject({ done: false, value: { type: "reasoning_delta", text: "partial" } });
  controller.abort();
  await expect(iterator.next()).rejects.toThrow();
  expect(cancelled).toBe(true);
});
