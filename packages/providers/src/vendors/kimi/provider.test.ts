import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import { ProviderBackpressureCoordinator } from "../../runtime/backpressure.js";
import type { ChiliModel, ModelStreamEvent } from "../../types.js";
import {
  createKimiModel,
  createKimiProvider,
  KIMI_K3_MODEL,
  KIMI_K27_CODE_MODEL,
  KIMI_K27_CODE_HIGHSPEED_MODEL,
  KIMI_OPENAI_BASE_URL,
  KIMI_PROVIDER_ID,
} from "./provider.js";
import { buildKimiResponsesRequestBody, resolveKimiResponsesRequestOptions, resolveKimiResponsesUrl } from "./request.js";

test("Kimi K3 uses Responses with its own environment and request contract", async () => {
  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const model = createKimiModel({
    env: {
      MOONSHOT_API_KEY: "env-key", KIMI_API_KEY: "other-key",
      MOONSHOT_BASE_URL: KIMI_OPENAI_BASE_URL, MOONSHOT_MODEL: KIMI_K3_MODEL,
    },
    temperature: 0.2,
    fetch: (async (input, init) => {
      url = String(input);
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return eventResponse([completed()]);
    }) as typeof fetch,
  });
  const events = await collect(model.stream({ messages: [], tools: [], system: [], metadata: { sessionId: "session_kimi" } }));
  expect(url).toBe("https://api.moonshot.cn/v1/responses");
  expect(headers.get("authorization")).toBe("Bearer env-key");
  expect(body).toEqual({ model: KIMI_K3_MODEL, input: [], max_output_tokens: 131072, stream: true, prompt_cache_key: "session_kimi" });
  for (const name of ["chatgpt-account-id", "originator", "openai-beta", "session_id"]) expect(headers.get(name)).toBeNull();
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop", responseId: "resp_kimi" });
});

test("Kimi credentials are required and do not fall back to another vendor", () => {
  expect(() => createKimiModel({ env: { OPENAI_API_KEY: "other-vendor" } }))
    .toThrow("Kimi provider requires MOONSHOT_API_KEY or KIMI_API_KEY");
  expect(() => createKimiModel({ apiKey: "  ", env: {} })).toThrow("requires");
});

test("Kimi K3 selects supported reasoning efforts and honors request overrides", async () => {
  for (const [requested, expected] of [["off", "low"], ["medium", "high"], ["xhigh", "max"]] as const) {
    let body: Record<string, unknown> = {};
    const model = createKimiModel({
      env: {}, apiKey: "key", reasoningEffort: "high", maxTokens: 123,
      fetch: (async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return eventResponse([completed()]);
      }) as typeof fetch,
    });
    await collect(model.stream({ messages: [], reasoningLevel: requested, maxTokens: 456 }));
    expect(body).toMatchObject({ reasoning: { effort: expected }, max_output_tokens: 456 });
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
  }
  expect(resolveKimiResponsesRequestOptions({ messages: [] }, { model: KIMI_K3_MODEL, reasoning: false }))
    .toMatchObject({ reasoningEffort: "low" });
});

test("Kimi catalog exposes Responses only for K3 and preserves configured defaults", () => {
  const models = createKimiProvider({ env: { MOONSHOT_MODEL: KIMI_K27_CODE_MODEL, MOONSHOT_BASE_URL: "https://moonshot.test/v1" } }).models();
  expect(models.find((model) => model.model === KIMI_K3_MODEL)).toMatchObject({
    provider: KIMI_PROVIDER_ID, apiFamily: "openai-responses", baseUrl: "https://moonshot.test/v1",
  });
  expect(models.find((model) => model.default)).toMatchObject({ model: KIMI_K27_CODE_MODEL, apiFamily: "openai-completions" });
  expect(models.filter((model) => model.default)).toHaveLength(1);
});

test("K2.7 models retain Chat Completions and thinking retention", async () => {
  for (const modelId of [KIMI_K27_CODE_MODEL, KIMI_K27_CODE_HIGHSPEED_MODEL]) {
    let url = "";
    let body: Record<string, unknown> = {};
    const model = createKimiModel({
      apiKey: "key", env: {}, model: modelId, reasoning: false, reasoningEffort: "max",
      fetch: (async (input, init) => {
        url = String(input);
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return chatResponse();
      }) as typeof fetch,
    });
    await collect(model.stream({ messages: [] }));
    expect(url).toBe("https://api.moonshot.cn/v1/chat/completions");
    expect(body).toMatchObject({ model: modelId, max_completion_tokens: 131072, thinking: { type: "enabled", keep: "all" } });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("max_output_tokens");
  }
});

test("Kimi custom models do not inherit K3 protocol, image support, or token budget", async () => {
  let body: Record<string, unknown> = {};
  let calls = 0;
  const model = createKimiModel({
    env: {}, apiKey: "key", model: "custom-kimi",
    fetch: (async (_url, init) => {
      calls++;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return chatResponse();
    }) as typeof fetch,
  });
  await collect(model.stream({ messages: [] }));
  expect(body).toMatchObject({ model: "custom-kimi", max_tokens: 8192 });
  expect(body).not.toHaveProperty("reasoning_effort");
  await expect(collect(model.stream({ messages: [message("user", [{ type: "image", mimeType: "image/png", data: "eA==" }])] })))
    .rejects.toThrow("does not support image input");
  expect(calls).toBe(1);
  const descriptor = createKimiProvider({ env: {}, model: "custom-kimi" }).models().find((entry) => entry.default);
  expect(descriptor).toMatchObject({ model: "custom-kimi", apiFamily: "openai-completions" });
  expect(descriptor).not.toHaveProperty("inputCapabilities");
  expect(descriptor).not.toHaveProperty("maxOutputTokens");
});

test("Kimi Responses builds tools, images, instructions and history without OpenAI-only fields", () => {
  const body = buildKimiResponsesRequestBody({
    messages: [
      message("user", [{ type: "image", mimeType: "image/png", data: "eA==" }]),
      message("assistant", [{ type: "text", text: "Checking", phase: "commentary" }]),
    ],
    system: ["System"], developer: ["Developer"], contextualUser: ["Context"],
    tools: [{ name: "lookup", description: "Look up information", inputSchema: { type: "object" } }],
  }, { model: KIMI_K3_MODEL, reasoningEffort: "high" });
  expect(body).toMatchObject({ instructions: "System\n\nDeveloper", reasoning: { effort: "high" }, tool_choice: "auto" });
  expect(body.input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "Context" }] },
    { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,eA==" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Checking" }] },
  ]);
  expect(body.tools).toEqual([{ type: "function", name: "lookup", description: "Look up information", parameters: { type: "object" } }]);
  for (const key of ["store", "background", "include", "text", "parallel_tool_calls", "temperature", "service_tier", "previous_response_id"]) {
    expect(body).not.toHaveProperty(key);
  }
});

test("Kimi Responses replays complete reasoning once, preserves long call IDs, and scopes original items", async () => {
  const providerCallId = `lookup:/namespace/${"x".repeat(90)}`;
  const item = { type: "reasoning", id: "rs_kimi", status: "completed", encrypted_content: null,
    summary: [{ type: "summary_text", text: "Check the repository." }] };
  const first = streamModel([
    { type: "response.created", response: { id: "resp_kimi", model: KIMI_K3_MODEL } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", summary: [] } },
    { type: "response.reasoning_text.delta", output_index: 0, content_index: 0, item_id: "rs_kimi", delta: "Check the " },
    { type: "response.reasoning_text.done", output_index: 0, content_index: 0, item_id: "rs_kimi", text: "Check the repository." },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.output_item.added", output_index: 1, item: { id: "fc_kimi", type: "function_call", call_id: providerCallId, name: "lookup", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_kimi", delta: "{\"query\":" },
    { type: "response.function_call_arguments.done", item_id: "fc_kimi", arguments: "{\"query\":\"test\"}" },
    { type: "response.output_item.done", output_index: 1, item: { id: "fc_kimi", type: "function_call", call_id: providerCallId, name: "lookup", arguments: "{\"query\":\"test\"}" } },
    completed(),
  ]);
  const events = await collect(first.stream({ messages: [] }));
  expect(events.filter((event) => event.type === "reasoning_delta").map((event) => event.text).join(""))
    .toBe("Check the repository.");
  expect(events.filter((event) => event.type === "reasoning_end")).toHaveLength(1);
  const reasoning = events.find((event) => event.type === "reasoning_item");
  expect(reasoning?.output).toMatchObject({ apiFamily: "openai-responses", item, source: { provider: "kimi" } });
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_end", toolCallId: providerCallId, name: "lookup", input: { query: "test" } }));
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool_use" });
  const callId = "call_internal" as ToolCallId;
  const history = [
    message("assistant", [
      { type: "reasoning", text: "Check the repository.", modelOutput: reasoning?.output },
      { type: "tool_call", callId, providerCallId: providerCallId, toolName: "lookup", input: { query: "test" }, status: "completed" },
    ]),
    message("tool", [{ type: "tool_result", callId, providerCallId: providerCallId, output: "found" }]),
  ];
  for (const [apiKey, shouldReplay] of [["test-key", true], ["different-key", false]] as const) {
    let body: Record<string, unknown> = {};
    const second = createKimiModel({
      env: {}, apiKey,
      fetch: (async (_url, init) => { body = JSON.parse(String(init?.body)) as Record<string, unknown>; return eventResponse([completed()]); }) as typeof fetch,
    });
    await collect(second.stream({ messages: history }));
    const input = body.input as Array<Record<string, unknown>>;
    expect(input.filter((entry) => entry.type === "reasoning")).toEqual(shouldReplay
      ? [{ type: "reasoning", id: "rs_kimi", status: "completed", summary: item.summary }]
      : []);
    expect(input.filter((entry) => entry.type === "function_call" || entry.type === "function_call_output")).toEqual([
      { type: "function_call", call_id: providerCallId, name: "lookup", arguments: "{\"query\":\"test\"}" },
      { type: "function_call_output", call_id: providerCallId, output: "found" },
    ]);
    if (shouldReplay) expect(input[0]).toEqual({ type: "reasoning", id: "rs_kimi", status: "completed", summary: item.summary });
  }
  expect(reasoning?.output.item).toEqual(item);
});

test("Kimi migrates visible Chat reasoning without inventing opaque state or replaying redacted text", () => {
  const body = buildKimiResponsesRequestBody({ messages: [
    message("assistant", [
      { type: "reasoning", text: "Inspect the files." },
      { type: "reasoning", text: " Hidden material", redacted: true },
      { type: "text", text: "I will inspect the files.", phase: "commentary" },
      { type: "tool_call", callId: "local", providerCallId: "legacy:/call", toolName: "read", input: { path: "README.md" }, status: "completed" },
    ]),
    message("tool", [{ type: "tool_result", callId: "local", providerCallId: "legacy:/call", output: "README" }]),
    message("assistant", [{ type: "reasoning", text: "", redacted: true }, { type: "text", text: "Done." }]),
  ] }, { model: KIMI_K3_MODEL });
  expect(body.input).toEqual([
    { type: "reasoning", content: [{ type: "reasoning_text", text: "Inspect the files." }] },
    { role: "assistant", content: [{ type: "output_text", text: "I will inspect the files." }] },
    { type: "function_call", call_id: "legacy:/call", name: "read", arguments: "{\"path\":\"README.md\"}" },
    { type: "function_call_output", call_id: "legacy:/call", output: "README" },
    { role: "assistant", content: [{ type: "output_text", text: "Done." }] },
  ]);
});

test("Kimi K3 accepts base and Responses URLs and rejects old protocol-specific URLs", () => {
  expect(resolveKimiResponsesUrl("https://moonshot.test")).toBe("https://moonshot.test/v1/responses");
  expect(resolveKimiResponsesUrl("https://moonshot.test/v1/")).toBe("https://moonshot.test/v1/responses");
  expect(resolveKimiResponsesUrl("https://moonshot.test/v1/responses/")).toBe("https://moonshot.test/v1/responses");
  expect(resolveKimiResponsesUrl("https://moonshot.test/v1?route=kimi")).toBe("https://moonshot.test/v1/responses?route=kimi");
  for (const suffix of ["chat/completions", "messages"]) {
    expect(() => createKimiModel({ env: {}, apiKey: "key", baseUrl: `https://moonshot.test/v1/${suffix}` })).toThrow("Kimi K3 uses Responses");
  }
  expect(() => createKimiModel({ env: {}, apiKey: "key", model: KIMI_K27_CODE_MODEL, baseUrl: "https://moonshot.test/v1/responses" }))
    .toThrow("currently supports only kimi-k3");
});

test("Kimi Responses rejects cross-provider and unsupported per-request model selection before dispatch", async () => {
  let calls = 0;
  const model = createKimiModel({ env: {}, apiKey: "key", fetch: (async () => { calls++; return eventResponse([completed()]); }) as unknown as typeof fetch });
  await expect(collect(model.stream({ messages: [], provider: "openai" }))).rejects.toThrow("cannot stream provider");
  await expect(collect(model.stream({ messages: [], model: KIMI_K27_CODE_MODEL }))).rejects.toThrow("supports only kimi-k3");
  expect(calls).toBe(0);
});

test("Kimi Responses never dispatches a pre-cancelled request", async () => {
  let calls = 0;
  const model = createKimiModel({ env: {}, apiKey: "key", fetch: (async () => { calls++; return eventResponse([completed()]); }) as unknown as typeof fetch });
  await expect(collect(model.stream({ messages: [], signal: AbortSignal.abort() }))).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(0);
});

test("Kimi Responses cancels a live response body", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const model = createKimiModel({
    env: {}, apiKey: "key", backpressureCoordinator: new ProviderBackpressureCoordinator(),
    fetch: (async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_live" } })}\n\n`)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
  });
  const events: ModelStreamEvent[] = [];
  await expect((async () => {
    for await (const event of model.stream({ messages: [], signal: controller.signal })) {
      events.push(event);
      if (event.type === "metadata" && event.responseId) controller.abort();
    }
  })()).rejects.toMatchObject({ name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(cancelled).toBe(true);
  expect(events.some((event) => event.type === "finish")).toBe(false);
});

test("Kimi Responses distinguishes truncation, incomplete output, and failure", async () => {
  const partialEvents = [
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_kimi" } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" },
  ];
  await expect(collect(streamModel(partialEvents).stream({ messages: [] }))).rejects.toMatchObject({ code: "incomplete_stream" });
  const incomplete = await collect(streamModel([...partialEvents,
    { type: "response.incomplete", response: { id: "resp_kimi", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
  ]).stream({ messages: [] }));
  expect(incomplete.at(-1)).toMatchObject({ type: "finish", reason: "length" });
  await expect(collect(streamModel([{ type: "response.failed", response: { status: "failed", error: { message: "Kimi unavailable", code: "server_error" } } }]).stream({ messages: [] })))
    .rejects.toMatchObject({ provider: "kimi", code: "server_error" });
});

function streamModel(events: unknown[]): ChiliModel {
  return createKimiModel({ env: {}, apiKey: "test-key", backpressureCoordinator: new ProviderBackpressureCoordinator(),
    fetch: (async () => eventResponse(events)) as unknown as typeof fetch });
}
function completed(): unknown {
  return { type: "response.completed", response: { id: "resp_kimi", model: KIMI_K3_MODEL, status: "completed" } };
}
function eventResponse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
function chatResponse(): Response {
  return Response.json({ id: "chatcmpl_kimi", choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }] });
}
async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function message(role: Message["role"], parts: Array<Record<string, unknown>>): Message {
  const id = `msg_${role}` as MessageId;
  const sessionId = "session_kimi" as SessionId;
  return { id, sessionId, role, createdAt: 1 as TimestampMs,
    parts: parts.map((part, index) => ({ id: `part_${index}` as PartId, messageId: id, sessionId, ...part })) as Message["parts"],
  };
}
