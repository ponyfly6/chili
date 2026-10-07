import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import type { ModelStreamEvent, ReasoningLevel } from "../../types.js";
import { createDoubaoModel, createDoubaoProvider } from "./provider.js";
import {
  DOUBAO_MODELS,
  DOUBAO_OPENAI_BASE_URL,
  DOUBAO_SEED_21_LITE_MODEL,
  DOUBAO_SEED_21_PRO_MODEL,
  DOUBAO_SEED_COMPATIBILITY,
} from "./models.js";

test("Doubao uses the official Ark v3 endpoint, bearer auth, and Seed request controls", async () => {
  const requests = captureRequests();
  const model = createDoubaoModel({ env: { ARK_API_KEY: "ark-key" }, fetch: requests.fetch });
  await collect(model.stream({ messages: [] }));

  expect(model.provider).toBe("doubao");
  expect(model.model).toBe(DOUBAO_SEED_21_PRO_MODEL);
  expect(requests.calls[0]?.url).toBe(`${DOUBAO_OPENAI_BASE_URL}/chat/completions`);
  expect(requests.calls[0]?.headers.get("authorization")).toBe("Bearer ark-key");
  expect(requests.calls[0]?.body).toMatchObject({
    model: DOUBAO_SEED_21_PRO_MODEL,
    max_tokens: 65536,
    thinking: { type: "enabled" },
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(requests.calls[0]?.body).not.toHaveProperty("max_completion_tokens");
  expect(requests.calls[0]?.body).not.toHaveProperty("store");
});

test("Doubao environment aliases work and explicit connection options take precedence", async () => {
  const requests = captureRequests();
  const env = {
    DOUBAO_API_KEY: "alias-key",
    DOUBAO_BASE_URL: "https://ark-alias.test/api/v3",
    DOUBAO_MODEL: DOUBAO_SEED_21_LITE_MODEL,
  };
  await collect(createDoubaoModel({ env, fetch: requests.fetch }).stream({ messages: [] }));
  await collect(createDoubaoModel({
    env,
    apiKey: "explicit-key",
    model: DOUBAO_SEED_21_PRO_MODEL,
    baseUrl: "https://ark-explicit.test/api/v3/chat/completions",
    headers: { "x-test-route": "explicit" },
    maxTokens: 1234,
    fetch: requests.fetch,
  }).stream({ messages: [] }));

  expect(requests.calls[0]?.url).toBe("https://ark-alias.test/api/v3/chat/completions");
  expect(requests.calls[0]?.headers.get("authorization")).toBe("Bearer alias-key");
  expect(requests.calls[0]?.body.model).toBe(DOUBAO_SEED_21_LITE_MODEL);
  expect(requests.calls[1]?.url).toBe("https://ark-explicit.test/api/v3/chat/completions");
  expect(requests.calls[1]?.headers.get("authorization")).toBe("Bearer explicit-key");
  expect(requests.calls[1]?.headers.get("x-test-route")).toBe("explicit");
  expect(requests.calls[1]?.body).toMatchObject({ model: DOUBAO_SEED_21_PRO_MODEL, max_tokens: 1234 });
});

test("Doubao disables thinking and maps requested effort to effective Seed levels", async () => {
  const requests = captureRequests();
  const model = createDoubaoModel({ apiKey: "key", env: {}, fetch: requests.fetch });
  const cases: Array<[ReasoningLevel, string | undefined]> = [
    ["off", undefined], ["low", "low"], ["medium", "medium"], ["high", "high"],
    ["xhigh", "high"], ["max", "high"], ["ultra", "high"],
  ];
  for (const [level, effort] of cases) {
    await collect(model.stream({ messages: [], reasoningLevel: level }));
    const body = requests.calls.at(-1)?.body;
    expect(body?.thinking).toEqual({ type: level === "off" ? "disabled" : "enabled" });
    if (effort === undefined) expect(body).not.toHaveProperty("reasoning_effort");
    else expect(body?.reasoning_effort).toBe(effort);
  }
});

test("Doubao custom endpoint IDs remain unchanged and do not inherit Seed capabilities", async () => {
  const requests = captureRequests();
  const endpointId = "ep-20261007123456-custom";
  const provider = createDoubaoProvider({
    apiKey: "key", env: {}, model: endpointId, fetch: requests.fetch,
  });
  const descriptor = provider.models().find((entry) => entry.default);
  expect(descriptor).toMatchObject({ provider: "doubao", model: endpointId, default: true });
  expect(descriptor).not.toHaveProperty("contextWindowTokens");
  expect(descriptor).not.toHaveProperty("maxOutputTokens");
  expect(descriptor).not.toHaveProperty("inputCapabilities");
  expect(descriptor).not.toHaveProperty("reasoningLevels");
  expect(descriptor).not.toHaveProperty("cost");

  const model = provider.getModel();
  await collect(model.stream({ messages: [] }));
  expect(requests.calls[0]?.body).toMatchObject({ model: endpointId, max_tokens: 4096 });
  expect(requests.calls[0]?.body).not.toHaveProperty("thinking");
  expect(requests.calls[0]?.body).not.toHaveProperty("reasoning_effort");
  await expect(collect(model.stream({ messages: [imageMessage()] }))).rejects.toThrow("does not support image input");
  expect(requests.calls).toHaveLength(1);
});

test("Doubao known Seed models accept text and image input and select one catalog default", async () => {
  const requests = captureRequests();
  const provider = createDoubaoProvider({
    apiKey: "key", env: { ARK_MODEL: DOUBAO_SEED_21_LITE_MODEL }, fetch: requests.fetch,
  });
  expect(provider.models().filter((entry) => entry.default).map((entry) => entry.model)).toEqual([DOUBAO_SEED_21_LITE_MODEL]);
  expect(provider.models().find((entry) => entry.default)?.inputCapabilities).toEqual(["text", "image"]);
  expect(DOUBAO_MODELS).toHaveLength(4);
  await collect(provider.getModel().stream({ messages: [imageMessage()] }));
  expect(requests.calls[0]?.body.messages).toEqual([{
    role: "user",
    content: [
      { type: "text", text: "Explain this screenshot." },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
    ],
  }]);
});

test("Doubao streams tool arguments, reasoning summary, and a distinct opaque continuation", async () => {
  const encryptedContent = "opaque-ciphertext-not-for-display";
  const model = createDoubaoModel({ apiKey: "key", env: {}, fetch: (async () => sseResponse([
    { id: "chatcmpl_doubao", choices: [{ index: 0, delta: { reasoning_content: "I will inspect the file." } }] },
    { choices: [{ index: 0, delta: { content: "", reasoning_content: "", encrypted_content: encryptedContent } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: "{\"path\":" } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"README.md\"}" } }] }, finish_reason: "tool_calls" }] },
  ])) as unknown as typeof fetch });
  const events = await collect(model.stream({ messages: [], tools: [readTool] }));
  expect(events).toContainEqual({ type: "reasoning_delta", text: "I will inspect the file.", index: 0 });
  expect(events).toContainEqual({
    type: "reasoning_item",
    output: {
      apiFamily: "doubao-chat-completions", outputIndex: 0,
      item: { type: "reasoning", provider: "doubao", model: DOUBAO_SEED_21_PRO_MODEL, encrypted_content: encryptedContent },
    },
  });
  expect(events).toContainEqual({ type: "tool_call_end", toolCallId: "call_read", name: "read", input: { path: "README.md" }, index: 0 });
  expect(events.filter((event) => event.type === "reasoning_item")).toHaveLength(1);
  expect(events.some((event) => event.type === "text_delta" && event.text.includes(encryptedContent))).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool_use", responseId: "chatcmpl_doubao" });
});

test("Doubao partial compatibility overrides preserve Seed thinking and continuation behavior", async () => {
  let body: Record<string, unknown> = {};
  const model = createDoubaoModel({
    apiKey: "key", env: {}, reasoningEffort: "max",
    compatibility: { supportsUsageInStreaming: false },
    fetch: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        { choices: [{ index: 0, delta: { encrypted_content: "override-ciphertext" } }] },
        { choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] },
      ]);
    }) as unknown as typeof fetch,
  });
  const events = await collect(model.stream({ messages: [] }));
  expect(body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 65536 });
  expect(body).not.toHaveProperty("stream_options");
  expect(events.find((event) => event.type === "reasoning_item")).toMatchObject({
    output: { apiFamily: "doubao-chat-completions", item: { encrypted_content: "override-ciphertext" } },
  });
});

test("Doubao JSON responses preserve opaque continuation as well as visible text", async () => {
  const model = createDoubaoModel({ apiKey: "key", env: {}, fetch: (async () => Response.json({
    id: "chatcmpl_json",
    choices: [{ index: 0, message: { content: "done", reasoning_content: "summary", encrypted_content: "json-ciphertext" }, finish_reason: "stop" }],
  })) as unknown as typeof fetch });
  const events = await collect(model.stream({ messages: [] }));
  expect(events).toContainEqual({ type: "text_delta", text: "done", index: 0 });
  expect(events.find((event) => event.type === "reasoning_item")).toMatchObject({
    output: { apiFamily: "doubao-chat-completions", item: { encrypted_content: "json-ciphertext" } },
  });
});

test("Doubao replays encrypted reasoning only for its original provider and model", async () => {
  const requests = captureRequests();
  const callId = "call_read" as ToolCallId;
  const scenarios = [
    { provider: "doubao", model: DOUBAO_SEED_21_PRO_MODEL, apiFamily: "doubao-chat-completions", expected: true },
    { provider: "doubao", model: DOUBAO_SEED_21_LITE_MODEL, apiFamily: "doubao-chat-completions", expected: false },
    { provider: "other", model: DOUBAO_SEED_21_PRO_MODEL, apiFamily: "doubao-chat-completions", expected: false },
    { provider: "doubao", model: DOUBAO_SEED_21_PRO_MODEL, apiFamily: "openai-responses", expected: false },
  ];
  for (const scenario of scenarios) {
    const model = createDoubaoModel({ apiKey: "key", env: {}, fetch: requests.fetch });
    await collect(model.stream({
      messages: [
        message("assistant", [
          { type: "reasoning", text: "summary" },
          { type: "reasoning", text: "", modelOutput: {
            apiFamily: scenario.apiFamily,
            item: { type: "reasoning", provider: scenario.provider, model: scenario.model, encrypted_content: "preserved-ciphertext" },
          } },
          { type: "tool_call", callId, toolName: "read", input: { path: "README.md" }, status: "completed" },
        ]),
        message("user", [{ type: "tool_result", callId, output: "file contents" }]),
      ],
      tools: [readTool],
    }));
    const messages = requests.calls.at(-1)?.body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({
      role: "assistant", reasoning_content: "summary",
      tool_calls: [{ id: callId, type: "function", function: { name: "read", arguments: "{\"path\":\"README.md\"}" } }],
    });
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: callId, content: "file contents" });
    if (scenario.expected) expect(messages[0]?.encrypted_content).toBe("preserved-ciphertext");
    else expect(messages[0]).not.toHaveProperty("encrypted_content");
  }
});

test("Doubao pre-cancelled requests never dispatch", async () => {
  const requests = captureRequests();
  const model = createDoubaoModel({ apiKey: "key", env: {}, fetch: requests.fetch });
  await expect(collect(model.stream({ messages: [], signal: AbortSignal.abort() }))).rejects.toMatchObject({ name: "AbortError" });
  expect(requests.calls).toHaveLength(0);
});

test("an explicitly described Ark deployment supports thinking and opaque-only continuation", async () => {
  const requests = captureRequests();
  const model = createDoubaoModel({
    apiKey: "key", env: {}, model: "ep-described-seed", fetch: requests.fetch,
    compatibility: DOUBAO_SEED_COMPATIBILITY, reasoningEffort: "medium", inputCapabilities: ["text", "image"],
  });
  await collect(model.stream({ messages: [
    message("assistant", [{ type: "reasoning", text: "", modelOutput: {
      apiFamily: "doubao-chat-completions",
      item: { type: "reasoning", provider: "doubao", model: "ep-described-seed", encrypted_content: "opaque-only" },
    } }]),
    imageMessage(),
  ] }));
  expect(requests.calls[0]?.body).toMatchObject({
    model: "ep-described-seed", max_tokens: 4096, thinking: { type: "enabled" }, reasoning_effort: "medium",
    messages: [{ role: "assistant", content: null, reasoning_content: "", encrypted_content: "opaque-only" }, { role: "user" }],
  });
});

test("Doubao cancellation aborts the transport and releases an active SSE reader", async () => {
  const controller = new AbortController();
  let transportSignal: AbortSignal | null | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(source) {
      source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] })}\n\n`));
    },
    cancel() { cancelled = true; },
  });
  const model = createDoubaoModel({ apiKey: "key", env: {}, fetch: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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

function captureRequests() {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json({ id: "chatcmpl_test", choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }] });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function message(role: Message["role"], parts: Array<Record<string, unknown>>): Message {
  const id = `msg_${role}` as MessageId;
  const sessionId = "session_doubao" as SessionId;
  return {
    id, sessionId, role, createdAt: 1 as TimestampMs,
    parts: parts.map((part, index) => ({ id: `part_${index}` as PartId, messageId: id, sessionId, ...part })) as Message["parts"],
  };
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
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}
