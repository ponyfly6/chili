import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, PersistedModelOutput, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import type { ModelStreamEvent, ReasoningLevel } from "../../types.js";
import { createDoubaoModel, createDoubaoProvider } from "./provider.js";
import { DOUBAO_MODELS, DOUBAO_OPENAI_BASE_URL, DOUBAO_SEED_21_LITE_MODEL, DOUBAO_SEED_21_PRO_MODEL } from "./models.js";

const rawProviderCallId = `call:ark/path/${"long-provider-id-".repeat(6)}`;

test("Doubao defaults to Ark Responses with vendor-specific body and bearer authentication", async () => {
  const requests = captureRequests();
  const model = createDoubaoModel({ env: { ARK_API_KEY: "ark-key" }, fetch: requests.fetch });
  await collect(model.stream({ messages: [], system: ["Act as a coding assistant."] }));
  expect(model.model).toBe(DOUBAO_SEED_21_PRO_MODEL);
  expect(requests.calls[0]?.url).toBe(`${DOUBAO_OPENAI_BASE_URL}/responses`);
  expect(requests.calls[0]?.headers.get("authorization")).toBe("Bearer ark-key");
  expect(requests.calls[0]?.body).toMatchObject({
    model: DOUBAO_SEED_21_PRO_MODEL, max_output_tokens: 65536, thinking: { type: "enabled" },
    reasoning: { effort: "high" }, stream: true, store: false, instructions: "Act as a coding assistant.", input: [],
  });
  for (const field of ["max_tokens", "max_completion_tokens", "messages", "stream_options", "include", "text", "prompt_cache_key"]) {
    expect(requests.calls[0]?.body).not.toHaveProperty(field);
  }
  expect(requests.calls[0]?.headers.get("chatgpt-account-id")).toBeNull();
  expect(requests.calls[0]?.headers.get("openai-beta")).toBeNull();
});

test("Doubao aliases and explicit overrides preserve v3 paths and select Responses", async () => {
  const requests = captureRequests();
  const env = { DOUBAO_API_KEY: "alias-key", DOUBAO_BASE_URL: "https://ark-alias.test/api/v3", DOUBAO_MODEL: DOUBAO_SEED_21_LITE_MODEL };
  await collect(createDoubaoModel({ env, fetch: requests.fetch }).stream({ messages: [] }));
  await collect(createDoubaoModel({ env, apiKey: "explicit-key", model: DOUBAO_SEED_21_PRO_MODEL,
    baseUrl: "https://ark-explicit.test/api/v3/chat/completions", headers: { "x-test-route": "explicit" },
    maxTokens: 1234, fetch: requests.fetch,
  }).stream({ messages: [] }));
  expect(requests.calls[0]?.url).toBe("https://ark-alias.test/api/v3/responses");
  expect(requests.calls[0]?.headers.get("authorization")).toBe("Bearer alias-key");
  expect(requests.calls[0]?.body.model).toBe(DOUBAO_SEED_21_LITE_MODEL);
  expect(requests.calls[1]?.url).toBe("https://ark-explicit.test/api/v3/responses");
  expect(requests.calls[1]?.headers.get("authorization")).toBe("Bearer explicit-key");
  expect(requests.calls[1]?.headers.get("x-test-route")).toBe("explicit");
  expect(requests.calls[1]?.body.max_output_tokens).toBe(1234);
  await collect(createDoubaoModel({ apiKey: "key", env: {}, baseUrl: "https://custom.test/api/v3/responses", fetch: requests.fetch }).stream({ messages: [] }));
  expect(requests.calls[2]?.url).toBe("https://custom.test/api/v3/responses");
});

test("Doubao disables thinking and maps requested effort to effective Seed levels", async () => {
  const requests = captureRequests();
  const model = createDoubaoModel({ apiKey: "key", env: {}, fetch: requests.fetch });
  const cases: Array<[ReasoningLevel, string | undefined]> = [["off", undefined], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "high"], ["max", "high"], ["ultra", "high"]];
  for (const [level, effort] of cases) {
    await collect(model.stream({ messages: [], reasoningLevel: level }));
    const body = requests.calls.at(-1)?.body;
    expect(body?.thinking).toEqual({ type: level === "off" ? "disabled" : "enabled" });
    if (effort === undefined) expect(body).not.toHaveProperty("reasoning");
    else expect(body?.reasoning).toEqual({ effort });
  }
});

test("Doubao resolves Responses and legacy Chat paths without corrupting query parameters", async () => {
  const requests = captureRequests();
  for (const path of ["/api/v3/", "/api/v3/responses/", "/api/v3/chat/completions/"]) {
    await collect(createDoubaoModel({
      apiKey: "key", baseUrl: `https://gateway.test${path}?api-version=2026-10-07&token=example%2Fvalue#panel`, fetch: requests.fetch,
    }).stream({ messages: [] }));
    expect(requests.calls.at(-1)?.url).toBe("https://gateway.test/api/v3/responses?api-version=2026-10-07&token=example%2Fvalue");
  }
});

test("Doubao endpoint IDs use Responses without inheriting unverified Seed capabilities", async () => {
  const requests = captureRequests();
  const endpointId = "ep-20261007123456-custom";
  const provider = createDoubaoProvider({ apiKey: "key", env: {}, model: endpointId, fetch: requests.fetch });
  const descriptor = provider.models().find((entry) => entry.default);
  expect(descriptor).toMatchObject({ model: endpointId, apiFamily: "openai-responses" });
  for (const field of ["contextWindowTokens", "maxOutputTokens", "inputCapabilities", "reasoningLevels", "cost"]) expect(descriptor).not.toHaveProperty(field);
  const model = provider.getModel();
  await collect(model.stream({ messages: [], reasoningLevel: "high" }));
  expect(requests.calls[0]?.url).toBe(`${DOUBAO_OPENAI_BASE_URL}/responses`);
  expect(requests.calls[0]?.body).toMatchObject({ model: endpointId, max_output_tokens: 4096 });
  expect(requests.calls[0]?.body).not.toHaveProperty("thinking");
  expect(requests.calls[0]?.body).not.toHaveProperty("reasoning");
  await expect(collect(model.stream({ messages: [imageMessage()] }))).rejects.toThrow("does not support image input");
  expect(requests.calls).toHaveLength(1);
});

test("Doubao known Seed models accept image input and omit OpenAI assistant phases", async () => {
  const requests = captureRequests();
  const provider = createDoubaoProvider({ apiKey: "key", env: { ARK_MODEL: DOUBAO_SEED_21_LITE_MODEL }, fetch: requests.fetch });
  expect(provider.models().filter((entry) => entry.default).map((entry) => entry.model)).toEqual([DOUBAO_SEED_21_LITE_MODEL]);
  expect(DOUBAO_MODELS.every((entry) => entry.apiFamily === "openai-responses")).toBe(true);
  await collect(provider.getModel().stream({ messages: [imageMessage(), message("assistant", [{ type: "text", text: "Prior reply", phase: "final_answer" }])] }));
  expect(requests.calls[0]?.body.input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "Explain this screenshot." }, { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Prior reply" }] },
  ]);
});

test("explicit custom Ark reasoning normalizes Chili-only levels before sending", async () => {
  const requests = captureRequests();
  await collect(createDoubaoModel({
    apiKey: "key", env: {}, model: "ep-custom-reasoning", reasoning: true, fetch: requests.fetch,
  }).stream({ messages: [], reasoningLevel: "ultra" }));
  expect(requests.calls[0]?.body.reasoning).toEqual({ effort: "max" });
  expect(requests.calls[0]?.body.thinking).toEqual({ type: "enabled" });
  await expect(collect(createDoubaoModel({
    apiKey: "key", env: {}, model: "ep-custom-reasoning", reasoning: true,
    compatibility: { reasoningEffortMap: { high: "unsupported-level" } }, fetch: requests.fetch,
  }).stream({ messages: [], reasoningLevel: "high" }))).rejects.toThrow("Unsupported Doubao reasoning effort");
  expect(requests.calls).toHaveLength(1);
});

test("Doubao streams summary and tool arguments and persists complete encrypted reasoning separately", async () => {
  const model = createDoubaoModel({ apiKey: "key", env: {}, fetch: (async () => sseResponse(toolResponse())) as unknown as typeof fetch });
  const events = await collect(model.stream({ messages: [], tools: [readTool] }));
  expect(events).toContainEqual({ type: "reasoning_delta", text: "Read the file.", index: 0 });
  const opaque = events.filter((event) => event.type === "reasoning_item");
  expect(opaque).toHaveLength(1);
  expect(opaque[0]?.output).toMatchObject({
    apiFamily: "openai-responses", source: { provider: "doubao", connection: expect.stringMatching(/^sha256:/) },
    outputIndex: 0, item: reasoningItem,
  });
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_end", toolCallId: rawProviderCallId, name: "read", input: { path: "README.md" } }));
  expect(events.some((event) => event.type === "text_delta" && event.text.includes("ciphertext"))).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool_use", responseId: "resp_doubao" });
});

test("Doubao terminal response preserves encrypted reasoning when item.done is absent", async () => {
  const model = createDoubaoModel({ apiKey: "key", env: {}, fetch: (async () => sseResponse([
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_ark", status: "in_progress" } },
    { type: "response.completed", response: { id: "resp_doubao", status: "completed", output: [reasoningItem] } },
  ])) as unknown as typeof fetch });
  const events = await collect(model.stream({ messages: [] }));
  expect(events.filter((event) => event.type === "reasoning_item")).toEqual([
    { type: "reasoning_item", output: { apiFamily: "openai-responses", outputIndex: 0,
      source: { provider: "doubao", connection: expect.stringMatching(/^sha256:/) }, item: reasoningItem } },
  ]);
});

test("Doubao compatibility overrides keep its Responses body and effort mapping", async () => {
  const requests = captureRequests();
  await collect(createDoubaoModel({ apiKey: "key", env: {}, reasoningEffort: "max",
    compatibility: { sendSessionIdHeader: false }, fetch: requests.fetch,
  }).stream({ messages: [], tools: [readTool] }));
  expect(requests.calls[0]?.body).toMatchObject({ thinking: { type: "enabled" }, reasoning: { effort: "high" }, max_output_tokens: 65536 });
  expect(requests.calls[0]?.body.tools).toEqual([{ type: "function", name: "read", description: "Read a file", parameters: readTool.inputSchema }]);
});

test("Doubao stateless replay preserves long provider tool IDs with punctuation and scopes ciphertext to the connection and model", async () => {
  const events = await collect(createDoubaoModel({ apiKey: "original-key", env: {}, fetch: (async () => sseResponse(toolResponse())) as unknown as typeof fetch }).stream({ messages: [] }));
  const output = events.find((event) => event.type === "reasoning_item")?.output;
  expect(output).toBeDefined();
  const scenarios = [
    { apiKey: "original-key", expected: true, output },
    { apiKey: "different-key", expected: false, output },
    { apiKey: "original-key", model: DOUBAO_SEED_21_LITE_MODEL, expected: false, output },
    { apiKey: "original-key", baseUrl: "https://another.test/api/v3", expected: false, output },
    { apiKey: "original-key", expected: false, output: { ...output, source: { ...output?.source, provider: "openai" } } as PersistedModelOutput },
    { apiKey: "original-key", expected: false, output: { apiFamily: "openai-responses", item: reasoningItem } },
  ];
  for (const scenario of scenarios) {
    const requests = captureRequests();
    const callId = "call_internal" as ToolCallId;
    const messages = [message("assistant", [
      { type: "reasoning", text: "Read the file.", modelOutput: scenario.output },
      { type: "tool_call", callId, providerCallId: rawProviderCallId, toolName: "read", input: { path: "README.md" }, status: "completed" },
    ]), message("user", [{ type: "tool_result", callId, output: "file contents" }])];
    await collect(createDoubaoModel({ apiKey: scenario.apiKey, env: {},
      ...(scenario.baseUrl ? { baseUrl: scenario.baseUrl } : {}),
      ...(scenario.model ? { model: scenario.model } : {}), fetch: requests.fetch,
    }).stream({ messages, tools: [readTool] }));
    const input = requests.calls[0]?.body.input as Array<Record<string, unknown>>;
    expect(input.filter((item) => item.type === "reasoning")).toEqual(scenario.expected ? [reasoningItem] : []);
    expect(input.filter((item) => item.type !== "reasoning")).toEqual([
      { type: "function_call", call_id: rawProviderCallId, name: "read", arguments: "{\"path\":\"README.md\"}" },
      { type: "function_call_output", call_id: rawProviderCallId, output: "file contents" },
    ]);
    expect(messages[0]?.parts[0]).toMatchObject({ modelOutput: scenario.output });
    expect(requests.calls[0]?.body.store).toBe(false);
    expect(requests.calls[0]?.body).not.toHaveProperty("previous_response_id");
  }
});

test("Doubao HTTP failures never retry using Chat Completions", async () => {
  for (const status of [400, 404, 429, 500]) {
    const urls: string[] = [];
    const model = createDoubaoModel({ apiKey: `key-${status}`, env: {}, fetch: (async (input) => {
      urls.push(String(input));
      return Response.json({ error: { message: "request rejected", code: "InvalidParameter" } }, { status });
    }) as typeof fetch });
    await expect(collect(model.stream({ messages: [] }))).rejects.toThrow();
    expect(urls).toEqual([`${DOUBAO_OPENAI_BASE_URL}/responses`]);
  }
});

test("Doubao pre-cancelled requests never dispatch", async () => {
  const requests = captureRequests();
  const model = createDoubaoModel({ apiKey: "key", env: {}, fetch: requests.fetch });
  await expect(collect(model.stream({ messages: [], signal: AbortSignal.abort() }))).rejects.toMatchObject({ name: "AbortError" });
  expect(requests.calls).toHaveLength(0);
});

test("Doubao cancellation aborts its transport and releases the SSE reader", async () => {
  const controller = new AbortController();
  let transportSignal: AbortSignal | null | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(source) {
      source.enqueue(new TextEncoder().encode([
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_partial" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
    },
    cancel() { cancelled = true; },
  });
  const model = createDoubaoModel({ apiKey: "key", env: {}, fetch: (async (_input, init) => {
    transportSignal = init?.signal;
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch });
  const events: ModelStreamEvent[] = [];
  const consume = async () => {
    for await (const event of model.stream({ messages: [], signal: controller.signal })) {
      events.push(event);
      if (event.type === "text_delta") controller.abort();
    }
  };
  await expect(consume()).rejects.toMatchObject({ name: "AbortError" });
  expect(transportSignal?.aborted).toBe(true);
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
  expect(events.some((event) => event.type === "finish")).toBe(false);
});

test("Doubao explains both supported API key environment names", () => {
  expect(() => createDoubaoModel({ env: {} })).toThrow("Doubao provider requires ARK_API_KEY or DOUBAO_API_KEY");
});

const readTool = { name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } };
const reasoningItem = { id: "rs_ark", type: "reasoning", status: "completed", encrypted_content: "complete-ciphertext", summary: [{ type: "summary_text", text: "Read the file." }] };
function toolResponse(): Array<Record<string, unknown>> {
  return [
    { type: "response.output_item.added", output_index: 0, item: { id: "rs_ark", type: "reasoning", encrypted_content: "partial-ciphertext", status: "in_progress" } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, item_id: "rs_ark", delta: "Read the file." },
    { type: "response.output_item.done", output_index: 0, item: reasoningItem },
    { type: "response.output_item.added", output_index: 1, item: { id: "fc_ark", type: "function_call", call_id: rawProviderCallId, name: "read", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_ark", delta: "{\"path\":" },
    { type: "response.function_call_arguments.delta", item_id: "fc_ark", delta: "\"README.md\"}" },
    { type: "response.output_item.done", output_index: 1, item: { id: "fc_ark", type: "function_call", call_id: rawProviderCallId, name: "read", arguments: "{\"path\":\"README.md\"}" } },
    completed(),
  ];
}
function completed(): Record<string, unknown> {
  return { type: "response.completed", response: { id: "resp_doubao", model: DOUBAO_SEED_21_PRO_MODEL, status: "completed" } };
}
function captureRequests() {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return sseResponse([completed()]);
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}
function message(role: Message["role"], parts: Array<Record<string, unknown>>): Message {
  const id = `msg_${role}` as MessageId;
  const sessionId = "session_doubao" as SessionId;
  return { id, sessionId, role, createdAt: 1 as TimestampMs, parts: parts.map((part, index) => ({ id: `part_${index}` as PartId, messageId: id, sessionId, ...part })) as Message["parts"] };
}
function imageMessage(): Message {
  return message("user", [{ type: "text", text: "Explain this screenshot." }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
}
async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function sseResponse(chunks: readonly Record<string, unknown>[]): Response {
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
