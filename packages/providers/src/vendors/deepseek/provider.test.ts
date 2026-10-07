import { expect, test } from "bun:test";
import type { Message, MessagePart } from "@chili/protocol";
import {
  createDeepSeekProvider, createDeepSeekV4Model, DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_OPENAI_BASE_URL, DEEPSEEK_PROVIDER_ID, DEEPSEEK_V4_FLASH_MODEL,
  DEEPSEEK_V4_PRO_MODEL, resolveDeepSeekCompletionsUrl, resolveDeepSeekResponsesUrl,
} from "./provider.js";
import { buildDeepSeekResponsesRequestBody } from "./request.js";
import type { ModelStreamEvent, ReasoningLevel } from "../../types.js";

test("all verified DeepSeek models use the stateless Responses API with vendor-only credentials", async () => {
  for (const selected of [DEEPSEEK_V4_PRO_MODEL, DEEPSEEK_FLASH_MODEL, DEEPSEEK_V4_FLASH_MODEL]) {
    const transport = captureFetch();
    const model = createDeepSeekV4Model({
      env: {
        DEEPSEEK_API_KEY: "deepseek-key", DEEPSEEK_BASE_URL: DEEPSEEK_OPENAI_BASE_URL,
        DEEPSEEK_MODEL: selected, OPENAI_API_KEY: "ignored-key",
      },
      fetch: transport.fetch,
    });
    const events = await collect(model.stream({ messages: [], system: ["Use tools."], metadata: { sessionId: "session-not-a-cache-key" } }));
    const request = transport.requests[0]!;
    expect(request.url).toBe("https://api.deepseek.com/responses");
    expect(request.headers.get("authorization")).toBe("Bearer deepseek-key");
    expect(request.body).toEqual({ model: selected, stream: true, input: [], instructions: "Use tools.", max_output_tokens: 131072, reasoning: { effort: "high" } });
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop", responseId: "resp_ok" });
  }
  expect(() => createDeepSeekV4Model({ env: { OPENAI_API_KEY: "wrong-vendor" } })).toThrow("DEEPSEEK_API_KEY");
});

test("DeepSeek catalog marks an environment-selected model as default without mutating registered capabilities", () => {
  const models = createDeepSeekProvider({ env: { DEEPSEEK_MODEL: DEEPSEEK_V4_FLASH_MODEL, DEEPSEEK_BASE_URL: "https://deepseek.test" } }).models();
  expect(models.find((model) => model.model === DEEPSEEK_V4_FLASH_MODEL)).toMatchObject({
    provider: DEEPSEEK_PROVIDER_ID, model: DEEPSEEK_V4_FLASH_MODEL, apiFamily: "openai-responses", baseUrl: "https://deepseek.test", default: true,
  });
  expect(models.find((model) => model.model === DEEPSEEK_V4_PRO_MODEL)?.default).toBeUndefined();
  expect(models.filter((model) => model.default)).toHaveLength(1);
});

test("DeepSeek factory and per-request effort map to none, low, high, and max", async () => {
  const cases: readonly [ReasoningLevel, string][] = [
    ["off", "none"], ["minimal", "low"], ["low", "low"], ["medium", "high"], ["high", "high"], ["xhigh", "high"], ["max", "max"], ["ultra", "max"],
  ];
  for (const [reasoningEffort, expected] of cases) {
    const transport = captureFetch();
    const model = createDeepSeekV4Model({ apiKey: "key", env: {}, reasoningEffort, fetch: transport.fetch });
    await collect(model.stream({ messages: [] }));
    await collect(model.stream({ messages: [], reasoning: "off", maxTokens: 128, temperature: 0.2 }));
    expect(transport.requests[0]?.body.reasoning).toEqual({ effort: expected });
    expect(transport.requests[1]?.body).toMatchObject({ reasoning: { effort: "none" }, max_output_tokens: 128, temperature: 0.2 });
  }
  const transport = captureFetch();
  await collect(createDeepSeekV4Model({ apiKey: "key", env: {}, reasoning: false, reasoningEffort: "max", fetch: transport.fetch }).stream({ messages: [] }));
  expect(transport.requests[0]?.body.reasoning).toEqual({ effort: "none" });
});

test("DeepSeek receives plain reasoning and tools, then replays completed reasoning once with paired tool IDs", async () => {
  const callId = `tool:/original-provider-call-${"x".repeat(100)}`;
  const reasoning = { id: "rs_1", type: "reasoning", status: "completed", content: [{ type: "reasoning_text", text: "Inspect the file." }] };
  const transport = captureFetch(responses([
    { type: "response.created", response: { id: "resp_tools", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", content: [] } },
    { type: "response.reasoning_text.delta", output_index: 0, item_id: "rs_1", content_index: 0, delta: "Inspect " },
    { type: "response.reasoning_text.done", output_index: 0, item_id: "rs_1", content_index: 0, text: "Inspect the file." },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { id: "fc_1", type: "function_call", call_id: callId, name: "read", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: '{"path":' },
    { type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_1", arguments: '{"path":"README.md"}' },
    { type: "response.output_item.done", output_index: 1, item: { id: "fc_1", type: "function_call", call_id: callId, name: "read", arguments: '{"path":"README.md"}', status: "completed" } },
    { type: "response.completed", response: { id: "resp_tools", status: "completed", usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 30 }, output_tokens: 8, total_tokens: 58 } } },
  ]));
  const model = createDeepSeekV4Model({ apiKey: "key", env: {}, fetch: transport.fetch });
  const events = await collect(model.stream({ messages: [], tools: [{ name: "read", description: "Read file", inputSchema: { type: "object" } }] }));
  expect(events.filter((event) => event.type === "reasoning_delta").map((event) => event.text).join("")).toBe("Inspect the file.");
  expect(events.filter((event) => event.type === "reasoning_end")).toHaveLength(1);
  expect(events).toContainEqual({ type: "tool_call_end", toolCallId: callId, name: "read", input: { path: "README.md" }, index: 1 });
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool_use", usage: { inputTokens: 20, cacheReadInputTokens: 30, outputTokens: 8, totalTokens: 58 } });
  expect(transport.requests[0]?.body.tools).toEqual([{ type: "function", name: "read", description: "Read file", parameters: { type: "object" } }]);
  const item = events.find((event) => event.type === "reasoning_item");
  expect(item?.type).toBe("reasoning_item");
  if (item?.type !== "reasoning_item") throw new Error("missing replay item");
  expect(item.output.item).toEqual(reasoning);
  const history = message("assistant", [
    { type: "reasoning", text: "Inspect the file." },
    { type: "reasoning", text: "", modelOutput: item.output },
    { type: "tool_call", callId: "internal_read", providerCallId: callId, toolName: "read", input: { path: "README.md" }, status: "completed" },
    { type: "tool_result", callId: "internal_read", providerCallId: callId, output: "file contents" },
  ]);
  await collect(model.stream({ messages: [history] }));
  expect(transport.requests[1]?.body.input).toEqual([
    { type: "reasoning", content: [{ type: "reasoning_text", text: "Inspect the file." }] },
    { type: "function_call", call_id: callId, name: "read", arguments: '{"path":"README.md"}' },
    { type: "function_call_output", call_id: callId, output: "file contents" },
  ]);
});

test("DeepSeek converts existing Chat reasoning into plain Responses content without OpenAI fields", () => {
  const body = buildDeepSeekResponsesRequestBody({
    messages: [message("assistant", [
      { type: "reasoning", text: "Old stream reasoning." },
      { type: "text", text: "Answer", phase: "final_answer" },
    ])],
    system: ["System"], developer: ["Developer"],
  }, {
    model: DEEPSEEK_V4_PRO_MODEL, maxTokens: 100, sessionId: "do-not-send", reasoningSummary: "auto", serviceTier: "fast",
  });
  expect(body).toEqual({
    model: DEEPSEEK_V4_PRO_MODEL, stream: true, reasoning: { effort: "high" }, max_output_tokens: 100,
    instructions: "System\n\nDeveloper",
    input: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "Old stream reasoning." }] },
      { role: "assistant", content: [{ type: "output_text", text: "Answer" }] },
    ],
  });
});

test("DeepSeek Responses handles Flash images and rejects images for Pro before dispatch", async () => {
  const transport = captureFetch();
  const messages = [message("user", [{ type: "text", text: "Describe" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }])];
  await collect(createDeepSeekV4Model({ apiKey: "key", env: {}, model: DEEPSEEK_FLASH_MODEL, fetch: transport.fetch }).stream({ messages }));
  expect(transport.requests[0]?.body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Describe" }, { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" }] }]);
  await expect(collect(createDeepSeekV4Model({ apiKey: "key", env: {}, fetch: transport.fetch }).stream({ messages }))).rejects.toThrow("does not support image input");
  expect(transport.requests).toHaveLength(1);
});

test("DeepSeek migrates only visible reasoning text and never reconstructs opaque or redacted state", () => {
  const body = buildDeepSeekResponsesRequestBody({ messages: [message("assistant", [
    { type: "reasoning", text: "Visible prior thought." },
    { type: "reasoning", text: "redacted-secret", redacted: true },
    { type: "reasoning", text: "", modelOutput: {
      apiFamily: "openai-responses", item: { type: "reasoning", encrypted_content: "opaque-secret", summary: [{ text: "private item summary" }] },
    } },
    { type: "reasoning", text: "foreign signed display text", modelOutput: {
      apiFamily: "anthropic-messages", item: { type: "thinking", thinking: "foreign signed display text", signature: "signed-secret" },
    } },
  ])] }, { model: DEEPSEEK_V4_PRO_MODEL });
  expect(body.input).toEqual([{ type: "reasoning", content: [{ type: "reasoning_text", text: "Visible prior thought." }] }]);
  expect(JSON.stringify(body)).not.toContain("secret");
  expect(JSON.stringify(body)).not.toContain("private item summary");
});

test("DeepSeek cancellation before dispatch and during SSE releases the stream", async () => {
  const preCancelled = new AbortController();
  preCancelled.abort(new Error("cancel before request"));
  const transport = captureFetch();
  await expect(collect(createDeepSeekV4Model({ apiKey: "key", env: {}, fetch: transport.fetch }).stream({ messages: [], signal: preCancelled.signal }))).rejects.toThrow("cancel before request");
  expect(transport.requests).toHaveLength(0);
  const abort = new AbortController();
  let cancelled = false;
  const model = createDeepSeekV4Model({
    apiKey: "key", env: {}, fetch: (async (_input, _init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"inflight","status":"in_progress"}}\n\n')); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch,
  });
  const output = model.stream({ messages: [], signal: abort.signal })[Symbol.asyncIterator]();
  await output.next(); // Request identity metadata, before the transport.
  await output.next(); // response.created metadata from the transport.
  abort.abort(new Error("cancel active response"));
  await expect(output.next()).rejects.toThrow("cancel active response");
  expect(cancelled).toBe(true);
});

test("DeepSeek HTTP and failed stream errors surface, and premature EOF cannot finish successfully", async () => {
  const http = createDeepSeekV4Model({ apiKey: "key", env: {}, fetch: (async (_input, _init) => new Response('{"error":{"message":"Invalid key"}}', { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch });
  await expect(collect(http.stream({ messages: [] }))).rejects.toMatchObject({ status: 401, provider: "deepseek" });
  const failed = createDeepSeekV4Model({ apiKey: "key", env: {}, fetch: (async (_input, _init) => responses([{ type: "response.failed", response: { status: "failed", error: { message: "model failed", code: "server_error" } } }])) as typeof fetch });
  await expect(collect(failed.stream({ messages: [] }))).rejects.toMatchObject({ provider: "deepseek", code: "server_error" });
  const partial = createDeepSeekV4Model({ apiKey: "key", env: {}, fetch: (async (_input, _init) => responses([{ type: "response.created", response: { id: "partial", status: "in_progress" } }])) as typeof fetch });
  await expect(collect(partial.stream({ messages: [] }))).rejects.toMatchObject({ code: "incomplete_stream" });
});

test("DeepSeek rejects legacy Chat endpoints for verified models; unknown deployments remain conservative Chat", async () => {
  expect(resolveDeepSeekResponsesUrl("https://api.deepseek.com/")).toBe("https://api.deepseek.com/responses");
  expect(resolveDeepSeekResponsesUrl("https://proxy.test/v1")).toBe("https://proxy.test/v1/responses");
  expect(resolveDeepSeekResponsesUrl("https://proxy.test/v1/responses?route=custom")).toBe("https://proxy.test/v1/responses?route=custom");
  expect(() => createDeepSeekV4Model({ apiKey: "key", env: {}, baseUrl: "https://proxy.test/chat/completions" })).toThrow("use Responses");
  expect(() => createDeepSeekV4Model({ apiKey: "key", env: {}, model: "deployment-custom", baseUrl: "https://proxy.test/responses" })).toThrow("not verified");
  expect(resolveDeepSeekCompletionsUrl(DEEPSEEK_OPENAI_BASE_URL)).toBe("https://api.deepseek.com/chat/completions");
  const transport = captureFetch(new Response(JSON.stringify({ id: "custom", choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } }));
  await collect(createDeepSeekV4Model({ apiKey: "key", env: {}, model: "deployment-custom", fetch: transport.fetch }).stream({ messages: [], reasoning: "max" }));
  expect(transport.requests[0]?.url).toBe("https://api.deepseek.com/chat/completions");
  expect(transport.requests[0]?.body).toMatchObject({ model: "deployment-custom", max_tokens: 4096 });
  expect(transport.requests[0]?.body).not.toHaveProperty("thinking");
  const custom = createDeepSeekProvider({ env: {}, model: "deployment-custom" }).models().find((model) => model.default);
  expect(custom).not.toHaveProperty("contextWindowTokens");
  expect(custom).not.toHaveProperty("maxOutputTokens");
});

function captureFetch(first?: Response) {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  return {
    requests,
    fetch: (async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (requests.length === 1 && first) return first;
      return responses([
        { type: "response.output_item.added", output_index: 0, item: { id: "msg_ok", type: "message", role: "assistant", content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
        { type: "response.output_item.done", output_index: 0, item: { id: "msg_ok", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] } },
        { type: "response.completed", response: { id: "resp_ok", status: "completed" } },
      ]);
    }) as typeof fetch,
  };
}

function responses(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function message(role: Message["role"], parts: Array<Record<string, unknown>>): Message {
  return {
    id: `msg_${role}`, sessionId: "session_deepseek", role, createdAt: 0,
    parts: parts.map((part, index) => ({ id: `part_${index}`, messageId: `msg_${role}`, sessionId: "session_deepseek", ...part })) as MessagePart[],
  } as Message;
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
