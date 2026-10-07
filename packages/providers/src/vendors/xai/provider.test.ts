import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import { createXaiModel, createXaiProvider, XAI_GROK_46_MODEL, XAI_PROVIDER_ID } from "./provider.js";
import { buildXaiResponsesRequestBody, resolveXaiResponsesUrl } from "./request.js";
import type { ModelStreamEvent } from "../../types.js";

const emptyInput = { messages: [], tools: [], system: [] };

test("xAI defaults to Responses with isolated request fields and both reasoning event variants", async () => {
  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const model = createXaiModel({
    env: { XAI_API_KEY: "env-key", XAI_MODEL: XAI_GROK_46_MODEL },
    fetch: (async (input, init) => {
      url = String(input);
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        { type: "response.output_item.added", output_index: 0, item: { id: "rs_xai", type: "reasoning" } },
        { type: "response.reasoning_text.delta", output_index: 0, content_index: 0, delta: "thinking " },
        { type: "response.reasoning_text.done", output_index: 0, content_index: 0, text: "thinking " },
        { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "summary " },
        { type: "response.reasoning_summary_text.done", output_index: 0, summary_index: 0, text: "summary " },
        { type: "response.output_item.added", output_index: 1, item: { id: "msg_xai", type: "message", role: "assistant" } },
        { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "done" },
        { type: "response.output_text.done", output_index: 1, content_index: 0, text: "done" },
        completed({ input_tokens: 12, input_tokens_details: { cached_tokens: 4 }, output_tokens: 8, total_tokens: 20 }),
      ]);
    }) as typeof fetch,
  });
  const events = await collect(model.stream(emptyInput));
  expect(url).toBe("https://api.x.ai/v1/responses");
  expect(headers.get("authorization")).toBe("Bearer env-key");
  expect(headers.get("chatgpt-account-id")).toBeNull();
  expect(headers.get("openai-beta")).toBeNull();
  expect(body).toMatchObject({
    model: XAI_GROK_46_MODEL, max_output_tokens: 128_000,
    reasoning: { effort: "high" }, stream: true, store: false, include: ["reasoning.encrypted_content"],
  });
  for (const field of ["max_tokens", "max_completion_tokens", "reasoning_effort", "thinking", "stream_options", "text", "service_tier", "prompt_cache_key", "previous_response_id"]) {
    expect(body).not.toHaveProperty(field);
  }
  expect(events.filter((event) => event.type === "reasoning_delta").map((event) => event.text)).toEqual(["thinking ", "summary "]);
  expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", text: "done" }));
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop", responseId: "resp_xai" });
  expect(events).toContainEqual(expect.objectContaining({ type: "metadata", usage: expect.objectContaining({ inputTokens: 8, cacheReadInputTokens: 4, outputTokens: 8, totalTokens: 20 }) }));
});

test("xAI preserves tools, images and instructions without OpenAI-only phase or verbosity", () => {
  const callId = "call_internal" as ToolCallId;
  const body = buildXaiResponsesRequestBody({
    system: ["System instruction"], developer: ["Developer instruction"], contextualUser: ["Context"],
    messages: [
      message("user", [{ type: "image", mimeType: "image/png", data: "YWJj" }]),
      message("assistant", [
        { type: "text", text: "Checking", phase: "commentary" },
        { type: "tool_call", callId, providerCallId: "call_xai", toolName: "lookup", input: { q: 1 }, status: "completed" },
      ]),
      message("tool", [{ type: "tool_result", callId, providerCallId: "call_xai", output: "found" }]),
    ],
    tools: [{ name: "lookup", description: "Look up a value", inputSchema: { type: "object" } }],
  }, { model: "grok-4.7", inputCapabilities: ["text", "image"], temperature: 0.2, reasoningEffort: "ultra", reasoningMode: "pro", reasoningContext: "all_turns", reasoningSummary: "off", textVerbosity: "high", serviceTier: "fast" });
  expect(body.instructions).toBe("System instruction\n\nDeveloper instruction");
  expect(body).toMatchObject({ reasoning: { effort: "xhigh" }, temperature: 0.2, tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }], parallel_tool_calls: true });
  expect(body.input).toContainEqual({ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,YWJj" }] });
  expect(body.input).toContainEqual({ role: "assistant", content: [{ type: "output_text", text: "Checking" }] });
  expect(body.input).toContainEqual({ type: "function_call", call_id: "call_xai", name: "lookup", arguments: "{\"q\":1}" });
  expect(body.input).toContainEqual({ type: "function_call_output", call_id: "call_xai", output: "found" });
  expect(body).not.toHaveProperty("text");
  expect(body).not.toHaveProperty("service_tier");
  expect(body.reasoning).not.toHaveProperty("mode");
  expect(body.reasoning).not.toHaveProperty("context");
  expect(body.reasoning).not.toHaveProperty("summary");
});

test("xAI replays finalized encrypted reasoning only to its originating connection before tool output", async () => {
  const providerCallId = `call/xai:${"long-provider-id-".repeat(5)}`;
  const item = { type: "reasoning", id: "rs_xai", encrypted_content: "ciphertext", summary: [], vendor_extension: { keep: true } };
  const responseEvents = [
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_xai", call_id: providerCallId, name: "lookup", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_xai", delta: "{\"q\":1}" },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_xai", call_id: providerCallId, name: "lookup", arguments: "{\"q\":1}" } },
    completed(),
  ];
  const bodies: Array<Record<string, unknown>> = [];
  const fakeFetch = (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sseResponse(responseEvents); }) as typeof fetch;
  const options = { env: {}, apiKey: "first-key", baseUrl: "https://xai.invalid/v1", fetch: fakeFetch };
  const model = createXaiModel(options);
  const events = await collect(model.stream(emptyInput));
  const persisted = events.find((event) => event.type === "reasoning_item");
  expect(persisted?.output.item).toEqual(item);
  expect(persisted?.output.source?.provider).toBe("xai");
  expect(persisted?.output.source?.connection).toMatch(/^sha256:/);
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_end", toolCallId: providerCallId, name: "lookup", input: { q: 1 } }));
  const callId = "call_internal" as ToolCallId;
  const messages = [
    message("assistant", [
      { type: "reasoning", text: "", modelOutput: persisted?.output },
      { type: "tool_call", callId, providerCallId, toolName: "lookup", input: { q: 1 }, status: "completed" },
    ]),
    message("tool", [{ type: "tool_result", callId, providerCallId, output: "found" }]),
  ];
  expect((buildXaiResponsesRequestBody({ messages }, { model: "grok-4.7" }).input as Array<Record<string, unknown>>)[0]).toEqual(item);
  await collect(model.stream({ messages }));
  await collect(createXaiModel({ ...options, apiKey: "second-key" }).stream({ messages }));
  await collect(createXaiModel({ ...options, baseUrl: "https://other-xai.invalid/v1" }).stream({ messages }));
  const sameConnection = bodies[1]?.input as Array<Record<string, unknown>>;
  expect(sameConnection.map((part) => part.type)).toEqual(["reasoning", "function_call", "function_call_output"]);
  expect(sameConnection[0]).toEqual(item);
  expect(sameConnection[1]?.call_id).toBe(providerCallId);
  expect(sameConnection[2]?.call_id).toBe(providerCallId);
  for (const body of bodies.slice(2)) {
    expect((body.input as Array<Record<string, unknown>>).some((part) => part.type === "reasoning")).toBe(false);
  }
});

test("xAI model catalog uses Responses and does not borrow known capabilities for custom IDs", async () => {
  const models = createXaiProvider({ env: { XAI_MODEL: XAI_GROK_46_MODEL, XAI_BASE_URL: "https://xai.test/v1" } }).models();
  expect(models.find((model) => model.model === XAI_GROK_46_MODEL)).toMatchObject({ provider: XAI_PROVIDER_ID, apiFamily: "openai-responses", baseUrl: "https://xai.test/v1", inputCapabilities: ["text", "image"], default: true });
  expect(models.filter((model) => model.default)).toHaveLength(1);
  const custom = createXaiProvider({ model: "custom-id", env: {} }).models()[0];
  expect(custom).toMatchObject({ model: "custom-id", apiFamily: "openai-responses" });
  expect(custom?.contextWindowTokens).toBeUndefined();
  expect(custom?.inputCapabilities).toBeUndefined();
  let body: Record<string, unknown> = {};
  const model = createXaiModel({ apiKey: "test", model: "custom-id", env: {}, reasoningEffort: "ultra", fetch: (async (_url, init) => { body = JSON.parse(String(init?.body)); return sseResponse([completed()]); }) as typeof fetch });
  await collect(model.stream(emptyInput));
  expect(body.max_output_tokens).toBe(4096);
  expect(body.reasoning).toBeUndefined();
});

test("xAI clamps disabled reasoning to low and accepts per-request controls", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const model = createXaiModel({ apiKey: "test", env: {}, reasoning: false, fetch: (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sseResponse([completed()]); }) as typeof fetch });
  await collect(model.stream(emptyInput));
  await collect(model.stream({ messages: [], reasoning: "ultra", maxTokens: 2048, temperature: 0.2 }));
  expect(bodies[0]?.reasoning).toEqual({ effort: "low" });
  expect(bodies[1]).toMatchObject({ reasoning: { effort: "xhigh" }, max_output_tokens: 2048, temperature: 0.2 });
});

test("xAI refuses pre-cancelled requests and cancels an active response reader", async () => {
  let calls = 0;
  let cancelled = false;
  const controller = new AbortController();
  const model = createXaiModel({ apiKey: "test", env: {}, fetch: (async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode([
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_cancel","role":"assistant"}}\n\n',
          'data: {"type":"response.output_text.delta","output_index":0,"delta":"partial"}\n\n',
        ].join("")));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch });
  await expect(collect(model.stream({ messages: [], signal: AbortSignal.abort() }))).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(0);
  await expect((async () => {
    for await (const event of model.stream({ messages: [], signal: controller.signal })) {
      if (event.type === "text_delta") controller.abort();
    }
  })()).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelled).toBe(true);
  expect(calls).toBe(1);
});

test("xAI endpoint migration and missing-key errors are explicit", () => {
  expect(resolveXaiResponsesUrl("https://api.x.ai/v1")).toBe("https://api.x.ai/v1/responses");
  expect(resolveXaiResponsesUrl("https://proxy.test/v1/chat/completions?route=xai")).toBe("https://proxy.test/v1/responses?route=xai");
  expect(resolveXaiResponsesUrl("https://api.x.ai/v1/responses")).toBe("https://api.x.ai/v1/responses");
  expect(() => resolveXaiResponsesUrl("file:///tmp/test")).toThrow("absolute HTTP(S)");
  expect(() => createXaiModel({ env: {} })).toThrow("xAI provider requires XAI_API_KEY");
});

function completed(usage?: Record<string, unknown>): Record<string, unknown> {
  return { type: "response.completed", response: { id: "resp_xai", status: "completed", ...(usage ? { usage } : {}) } };
}

function sseResponse(events: readonly Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function message(role: Message["role"], parts: Array<Record<string, unknown>>): Message {
  const id = `msg_${role}` as MessageId;
  const sessionId = "session_xai" as SessionId;
  return { id, sessionId, role, createdAt: 1 as TimestampMs,
    parts: parts.map((part, index) => ({ id: `part_${index}` as PartId, messageId: id, sessionId, ...part })) as Message["parts"],
  };
}
