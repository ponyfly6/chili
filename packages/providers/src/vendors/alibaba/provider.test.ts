import { expect, test } from "bun:test";
import type { Message, MessagePart, PersistedModelOutput } from "@chili/protocol";
import type { ModelStreamEvent, ModelStreamInput } from "../../types.js";
import { createAlibabaModel, createAlibabaProvider } from "./provider.js";
import { ALIBABA_MODELS, ALIBABA_OPENAI_BASE_URL, QWEN_38_MAX_MODEL, QWEN_38_FLASH_MODEL } from "./models.js";

test("Alibaba defaults to Responses with isolated credentials and only documented fields", async () => {
  const request = captureRequest();
  await collect(createAlibabaModel({
    env: { DASHSCOPE_API_KEY: "dash-key", ALIBABA_API_KEY: "other-key", OPENAI_API_KEY: "wrong-provider" },
    fetch: request.fetch,
  }).stream({ messages: [], system: ["system"], developer: ["developer"], metadata: { sessionId: "session_no_codex_headers" } }));
  expect(request.url).toBe(`${ALIBABA_OPENAI_BASE_URL}/responses`);
  expect(request.headers.get("authorization")).toBe("Bearer dash-key");
  expect(request.body).toEqual({
    model: QWEN_38_MAX_MODEL, max_output_tokens: 131072, stream: true, store: false,
    reasoning: { effort: "xhigh" }, input: [], instructions: "system\n\ndeveloper",
  });
  for (const name of ["chatgpt-account-id", "openai-beta", "originator", "session_id"]) expect(request.headers.has(name)).toBe(false);
  expect(() => createAlibabaModel({ env: { OPENAI_API_KEY: "wrong-provider" } })).toThrow("DASHSCOPE_API_KEY or ALIBABA_API_KEY");
});

test("Alibaba Responses supports workspace URLs and explicit overrides without a Chat fallback", async () => {
  const request = captureRequest();
  await collect(createAlibabaModel({
    env: { ALIBABA_API_KEY: "alias-key", ALIBABA_BASE_URL: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/", ALIBABA_MODEL: QWEN_38_FLASH_MODEL },
    fetch: request.fetch,
  }).stream({ messages: [] }));
  expect(request.url).toBe("https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses");
  expect(request.headers.get("authorization")).toBe("Bearer alias-key");
  expect(request.body.model).toBe(QWEN_38_FLASH_MODEL);
  await collect(createAlibabaModel({
    env: { DASHSCOPE_API_KEY: "env-key", DASHSCOPE_BASE_URL: "https://ignored.test/v1" },
    apiKey: "explicit-key", baseUrl: "https://proxy.test/custom/responses", maxTokens: 8000,
    headers: { "x-project": "chili" }, fetch: request.fetch,
  }).stream({ messages: [] }));
  expect(request.url).toBe("https://proxy.test/custom/responses");
  expect(request.headers.get("authorization")).toBe("Bearer explicit-key");
  expect(request.headers.get("x-project")).toBe("chili");
  expect(request.body.max_output_tokens).toBe(8000);
  expect(() => createAlibabaModel({ apiKey: "key", baseUrl: "https://proxy.test/v1/chat/completions" })).toThrow("Alibaba uses Responses");
  const failure = captureRequest(() => new Response("Responses not available", { status: 404 }));
  await expect(collect(createAlibabaModel({ apiKey: "key", fetch: failure.fetch }).stream({ messages: [] }))).rejects.toThrow();
  expect(failure.calls).toBe(1);
  expect(failure.url.endsWith("/responses")).toBe(true);
});

test("Alibaba maps Qwen effort inside reasoning and per-request off to none", async () => {
  const request = captureRequest();
  const model = createAlibabaModel({ apiKey: "test-key", reasoningEffort: "high", fetch: request.fetch });
  for (const [requested, expected] of [[undefined, "xhigh"], ["off", "none"], ["minimal", "low"], ["medium", "medium"], ["ultra", "xhigh"]] as const) {
    await collect(model.stream({ messages: [], ...(requested ? { reasoningLevel: requested } : {}) }));
    expect(request.body.reasoning).toEqual({ effort: expected });
    for (const key of ["reasoning_effort", "thinking", "enable_thinking", "preserve_thinking", "thinking_budget", "include", "text", "service_tier"]) {
      expect(request.body).not.toHaveProperty(key);
    }
  }
});

test("Alibaba resolves Responses paths while preserving query parameters and discarding fragments", async () => {
  const request = captureRequest();
  for (const path of ["/compatible-mode/v1/", "/compatible-mode/v1/responses/"]) {
    await collect(createAlibabaModel({
      apiKey: "key", baseUrl: `https://gateway.test${path}?api-version=2026-10-07&token=example%2Fvalue#panel`, fetch: request.fetch,
    }).stream({ messages: [] }));
    expect(request.url).toBe("https://gateway.test/compatible-mode/v1/responses?api-version=2026-10-07&token=example%2Fvalue");
  }
  expect(() => createAlibabaModel({ apiKey: "key", baseUrl: "https://gateway.test/v1/chat/completions?route=example#panel" })).toThrow("Alibaba uses Responses");
});

test("Alibaba streams plain reasoning and tool arguments then replays the finalized reasoning item", async () => {
  const reasoningItem = { type: "reasoning", id: "qwen_reason_1", summary: [{ type: "summary_text", text: "Check the file." }], status: "completed" };
  const request = captureRequest(() => sse([
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "qwen_reason_1", summary: [] } },
    { type: "response.reasoning_text.delta", output_index: 0, item_id: "qwen_reason_1", delta: "Check the file." },
    { type: "response.reasoning_text.done", output_index: 0, item_id: "qwen_reason_1", text: "Check the file." },
    { type: "response.output_item.done", output_index: 0, item: reasoningItem },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "qwen_item_1", call_id: "qwen/tool:1", name: "read", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "qwen_item_1", delta: '{"path":' },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "qwen_item_1", delta: '"app.ts"}' },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "qwen_item_1", call_id: "qwen/tool:1", name: "read", arguments: '{"path":"app.ts"}' } },
    { type: "response.completed", response: { id: "qwen-response", status: "completed", usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19, input_tokens_details: { cached_tokens: 2 } } } },
  ]));
  const model = createAlibabaModel({ apiKey: "test-key", fetch: request.fetch });
  const events = await collect(model.stream({ messages: [], tools: [readTool] }));
  expect(events.filter((event) => event.type === "reasoning_delta").map((event) => event.text).join("")).toBe("Check the file.");
  expect(events).toContainEqual({ type: "tool_call_end", toolCallId: "qwen/tool:1", name: "read", input: { path: "app.ts" }, index: 1 });
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool_use", usage: { inputTokens: 10, cacheReadInputTokens: 2, outputTokens: 7 } });
  const output = events.find((event) => event.type === "reasoning_item")?.output;
  expect(output?.item).toEqual(reasoningItem);
  expect(output?.source?.provider).toBe("alibaba");
  expect(output?.source?.connection).toMatch(/^sha256:/);
  await collect(model.stream({ messages: [assistantHistory(output!)], tools: [readTool] }));
  expect(request.body.input).toMatchObject([
    reasoningItem,
    { role: "assistant", content: [{ type: "output_text", text: "Reading now." }] },
    { type: "function_call", call_id: "qwen/tool:1", name: "read", arguments: '{"path":"app.ts"}' },
    { type: "function_call_output", call_id: "qwen/tool:1", output: "file contents" },
  ]);
  expect((request.body.input as Record<string, unknown>[])[1]).not.toHaveProperty("phase");
  expect(request.body.tools).toEqual([{ type: "function", name: "read", description: "Read a file", parameters: { type: "object" } }]);
  const switched = captureRequest();
  await collect(createAlibabaModel({ apiKey: "other-account-key", fetch: switched.fetch }).stream({ messages: [assistantHistory(output!)] }));
  expect((switched.body.input as Record<string, unknown>[]).some((item) => item.type === "reasoning")).toBe(false);
  expect((switched.body.input as Record<string, unknown>[]).some((item) => item.type === "function_call_output")).toBe(true);
});

test("Alibaba keeps each result immediately after its matching tool call", async () => {
  const request = captureRequest();
  await collect(createAlibabaModel({ apiKey: "key", fetch: request.fetch }).stream({ messages: [message("assistant", [
    part({ type: "tool_call", callId: "internal_one", providerCallId: "external:one/123", toolName: "read", input: {}, status: "completed" }),
    part({ type: "tool_call", callId: "internal_two", providerCallId: "external:two/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", toolName: "read", input: {}, status: "completed" }),
    part({ type: "tool_result", callId: "internal_two", providerCallId: "external:two/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", output: "second" }),
    part({ type: "tool_result", callId: "internal_one", providerCallId: "external:one/123", output: "first" }),
  ])] }));
  expect(request.body.input).toMatchObject([
    { type: "function_call", call_id: "external:one/123" }, { type: "function_call_output", call_id: "external:one/123", output: "first" },
    { type: "function_call", call_id: "external:two/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }, { type: "function_call_output", call_id: "external:two/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", output: "second" },
  ]);
});

test("Alibaba unknown models use conservative Responses capabilities and known models accept images", async () => {
  const request = captureRequest();
  const imageInput: ModelStreamInput = { messages: [message("user", [part({ type: "image", data: "YWJj", mimeType: "image/png" })])] };
  await collect(createAlibabaModel({ apiKey: "test-key", fetch: request.fetch }).stream(imageInput));
  expect(request.body.input).toMatchObject([{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,YWJj" }] }]);
  const custom = createAlibabaModel({ apiKey: "test-key", model: "custom-deployment", fetch: request.fetch });
  await collect(custom.stream({ messages: [], reasoningLevel: "high" }));
  expect(request.body).toEqual({ model: "custom-deployment", max_output_tokens: 4096, store: false, stream: true, input: [] });
  await expect(collect(custom.stream(imageInput))).rejects.toThrow("does not support image input");
  const catalog = createAlibabaProvider({ model: "custom-deployment", env: {} }).models();
  expect(catalog[0]).toMatchObject({ model: "custom-deployment", default: true, apiFamily: "openai-responses" });
  for (const key of ["inputCapabilities", "capabilities", "reasoningLevels", "contextWindowTokens", "maxOutputTokens", "cost"]) expect(catalog[0]).not.toHaveProperty(key);
  expect(ALIBABA_MODELS.every((model) => model.apiFamily === "openai-responses" && model.contextWindowTokens === 800000)).toBe(true);
});

test("Alibaba explicit custom Responses metadata can enable reasoning and images", async () => {
  const request = captureRequest();
  await collect(createAlibabaModel({
    apiKey: "key", model: "custom-profile", fetch: request.fetch,
    compatibility: { reasoningEffortMap: { high: "low" } }, reasoningEffort: "high", inputCapabilities: ["text", "image"],
  }).stream({ messages: [] }));
  expect(request.body.reasoning).toEqual({ effort: "low" });
});

test("Alibaba cancellation prevents dispatch and cleans up an active Responses stream", async () => {
  const request = captureRequest();
  await expect(collect(createAlibabaModel({ apiKey: "key", fetch: request.fetch }).stream({ messages: [], signal: AbortSignal.abort() }))).rejects.toThrow();
  expect(request.calls).toBe(0);
  const controller = new AbortController();
  let cancelled = false;
  let transportSignal: AbortSignal | null | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(source) { source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "partial" })}\n\n`)); },
    cancel() { cancelled = true; },
  });
  const model = createAlibabaModel({ apiKey: "key", fetch: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    transportSignal = init?.signal;
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch });
  const consume = async () => {
    for await (const event of model.stream({ messages: [], signal: controller.signal })) if (event.type === "text_delta") controller.abort();
  };
  await expect(consume()).rejects.toThrow();
  expect(cancelled).toBe(true);
  expect(transportSignal?.aborted).toBe(true);
  expect(stream.locked).toBe(false);
});

const readTool = { name: "read", description: "Read a file", inputSchema: { type: "object" } };
function assistantHistory(modelOutput: PersistedModelOutput): Message {
  return message("assistant", [
    part({ type: "reasoning", text: "", modelOutput }),
    part({ type: "text", text: "Reading now.", phase: "commentary" }),
    part({ type: "tool_call", callId: "qwen/tool:1", toolName: "read", input: { path: "app.ts" }, status: "completed" }),
    part({ type: "tool_result", callId: "qwen/tool:1", output: "file contents" }),
  ]);
}
function captureRequest(response: () => Response = () => sse([{ type: "response.completed", response: { id: "qwen-response", status: "completed" } }])) {
  const state = { calls: 0, url: "", headers: new Headers(), body: {} as Record<string, unknown>, fetch: undefined as unknown as typeof fetch };
  state.fetch = (async (input, init) => {
    state.calls++;
    state.url = String(input);
    state.headers = new Headers(init?.headers);
    state.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response();
  }) as typeof fetch;
  return state;
}
function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
function message(role: Message["role"], parts: MessagePart[]): Message {
  return { id: "msg_test", sessionId: "session_test", createdAt: 1, role, parts } as Message;
}
function part(input: Record<string, unknown>): MessagePart {
  return { id: "part_test", messageId: "msg_test", sessionId: "session_test", ...input } as unknown as MessagePart;
}
async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
