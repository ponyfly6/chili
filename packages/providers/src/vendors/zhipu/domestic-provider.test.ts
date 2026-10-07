import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs } from "@chili/protocol";
import { findKnownModel } from "../../models.js";
import type { ModelStreamEvent } from "../../types.js";
import { createZhipuModel, createZhipuProvider } from "./domestic-provider.js";
import {
  ZHIPU_CODING_BASE_URL,
  ZHIPU_GLM_53_FLASH_MODEL,
  ZHIPU_GLM_53_MODEL,
  ZHIPU_MODELS,
  ZHIPU_OPENAI_BASE_URL,
} from "./domestic-models.js";

test("domestic BigModel uses its own credentials, endpoint, and GLM request dialect", async () => {
  const transport = captureFetch();
  const model = createZhipuModel({
    env: { ZHIPU_API_KEY: "domestic-key", ZAI_API_KEY: "international-key" },
    fetch: transport.fetch,
  });
  const events = await collect(model.stream({
    messages: [],
    developer: ["Review the source."],
    tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
  }));
  expect(transport.requests[0]).toMatchObject({
    url: `${ZHIPU_OPENAI_BASE_URL}/chat/completions`,
    body: {
      model: ZHIPU_GLM_53_MODEL,
      max_tokens: 131072,
      stream: true,
      thinking: { type: "enabled", clear_thinking: false },
      tool_stream: true,
      messages: [{ role: "system", content: "Review the source." }],
    },
  });
  expect(transport.requests[0]?.headers.get("authorization")).toBe("Bearer domestic-key");
  expect(transport.requests[0]?.body).not.toHaveProperty("store");
  expect(transport.requests[0]?.body).not.toHaveProperty("max_completion_tokens");
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop", responseId: "chatcmpl_zhipu" });
  expect(() => createZhipuModel({ env: { ZAI_API_KEY: "international-only" } })).toThrow("ZHIPU_API_KEY");
});

test("domestic Coding Plan endpoint is an explicit override with its own key", async () => {
  const transport = captureFetch();
  const model = createZhipuModel({
    env: {
      BIGMODEL_API_KEY: "plan-key",
      BIGMODEL_BASE_URL: ZHIPU_CODING_BASE_URL,
      BIGMODEL_MODEL: ZHIPU_GLM_53_FLASH_MODEL,
    },
    fetch: transport.fetch,
  });
  await collect(model.stream({ messages: [], maxTokens: 8192 }));
  expect(transport.requests[0]?.url).toBe(`${ZHIPU_CODING_BASE_URL}/chat/completions`);
  expect(transport.requests[0]?.headers.get("authorization")).toBe("Bearer plan-key");
  expect(transport.requests[0]?.body).toMatchObject({ model: ZHIPU_GLM_53_FLASH_MODEL, max_tokens: 8192 });
});

test("explicit GLM compatibility survives custom URLs and maps each request's reasoning effort", async () => {
  const transport = captureFetch();
  const model = createZhipuModel({ apiKey: "key", baseUrl: "https://proxy.example/v4", fetch: transport.fetch, env: {} });
  for (const reasoning of ["off", "medium", "ultra"] as const) {
    await collect(model.stream({ messages: [], reasoning }));
  }
  expect(transport.requests.map((request) => request.body.reasoning_effort)).toEqual(["low", "high", "max"]);
  for (const request of transport.requests) {
    expect(request.url).toBe("https://proxy.example/v4/chat/completions");
    expect(request.body.thinking).toEqual({ type: "enabled", clear_thinking: false });
  }
});

test("domestic GLM streaming retains reasoning, fragmented tool input, and usage", async () => {
  const events = await collect(createZhipuModel({
    apiKey: "key",
    env: {},
    fetch: (async () => new Response([
      { choices: [{ index: 0, delta: { reasoning_content: "Inspect first." } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_read", function: { name: "read", arguments: '{"path":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens: 7, total_tokens: 107 } },
    ].map((event) => `data: ${JSON.stringify({ id: "chatcmpl_stream", ...event })}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch,
  }).stream({ messages: [] }));
  expect(events).toContainEqual({ type: "reasoning_delta", text: "Inspect first.", index: 0 });
  expect(events).toContainEqual({ type: "tool_call_end", toolCallId: "call_read", name: "read", input: { path: "README.md" }, index: 0 });
  expect(events.at(-1)).toMatchObject({
    type: "finish", reason: "tool_use",
    usage: { inputTokens: 20, cacheReadInputTokens: 80, outputTokens: 7, totalTokens: 107 },
  });
});

test("domestic Flash sends image blocks while GLM-5.3 refuses unsupported images before dispatch", async () => {
  const transport = captureFetch();
  const messages = [message("user", [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }])];
  const imageModel = createZhipuModel({ apiKey: "key", model: ZHIPU_GLM_53_FLASH_MODEL, fetch: transport.fetch, env: {} });
  await collect(imageModel.stream({ messages }));
  expect(transport.requests[0]?.body.messages).toEqual([
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }] },
  ]);
  const textModel = createZhipuModel({ apiKey: "key", fetch: transport.fetch, env: {} });
  await expect(collect(textModel.stream({ messages }))).rejects.toThrow("does not support image input");
  expect(transport.requests).toHaveLength(1);
});

test("domestic GLM replays assistant reasoning together with tool calls", async () => {
  const transport = captureFetch();
  const model = createZhipuModel({ apiKey: "key", fetch: transport.fetch, env: {} });
  await collect(model.stream({ messages: [message("assistant", [
    { type: "reasoning", text: "Read the file first." },
    { type: "tool_call", callId: "call_read", toolName: "read", input: { path: "README.md" }, status: "pending" },
    { type: "tool_result", callId: "call_read", output: "contents" },
  ])] }));
  expect(transport.requests[0]?.body.messages).toEqual([
    {
      role: "assistant", content: null, reasoning_content: "Read the file first.",
      tool_calls: [{ id: "call_read", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }],
    },
    { role: "tool", tool_call_id: "call_read", content: "contents" },
  ]);
});

test("domestic provider catalog keeps CNY metadata isolated and does not mutate registered defaults", () => {
  const provider = createZhipuProvider({ env: { ZHIPU_MODEL: ZHIPU_GLM_53_FLASH_MODEL, ZHIPU_BASE_URL: ZHIPU_CODING_BASE_URL } });
  const models = provider.models();
  expect(models.filter((model) => model.default)).toHaveLength(1);
  expect(models.find((model) => model.default)).toMatchObject({ model: ZHIPU_GLM_53_FLASH_MODEL, baseUrl: ZHIPU_CODING_BASE_URL });
  expect(findKnownModel("zhipu", ZHIPU_GLM_53_MODEL)?.default).toBe(true);
  expect(ZHIPU_MODELS.map((model) => model.cost?.currency)).toEqual(["CNY", "CNY", "CNY"]);
  expect(findKnownModel("zai", ZHIPU_GLM_53_MODEL)?.baseUrl).not.toBe(ZHIPU_OPENAI_BASE_URL);
});

test("already cancelled domestic requests do not call the transport", async () => {
  const transport = captureFetch();
  const abort = new AbortController();
  abort.abort(new Error("cancelled before request"));
  const model = createZhipuModel({ apiKey: "key", fetch: transport.fetch, env: {} });
  await expect(collect(model.stream({ messages: [], signal: abort.signal }))).rejects.toThrow("cancelled before request");
  expect(transport.requests).toHaveLength(0);
});

test("unknown domestic model IDs do not inherit GLM-5.3 capabilities or output allowance", async () => {
  const transport = captureFetch();
  const model = createZhipuModel({ apiKey: "key", model: "custom-deployment", fetch: transport.fetch, env: {} });
  await collect(model.stream({ messages: [], reasoning: "max" }));
  expect(transport.requests[0]?.body).toMatchObject({ model: "custom-deployment", max_tokens: 4096 });
  expect(transport.requests[0]?.body).not.toHaveProperty("thinking");
  expect(transport.requests[0]?.body).not.toHaveProperty("reasoning_effort");
  const messages = [message("user", [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }])];
  await expect(collect(model.stream({ messages }))).rejects.toThrow("does not support image input");
  expect(transport.requests).toHaveLength(1);
  const customDescriptor = createZhipuProvider({ model: "custom-deployment", env: {} }).models().find((entry) => entry.default);
  expect(customDescriptor).not.toHaveProperty("contextWindowTokens");
  expect(customDescriptor).not.toHaveProperty("maxOutputTokens");
});

function captureFetch() {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  return {
    requests,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({
        id: "chatcmpl_zhipu", choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }],
      }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  };
}

function message(role: Message["role"], parts: Array<Record<string, unknown>>): Message {
  const id = `msg_${role}` as MessageId;
  const sessionId = "session_zhipu" as SessionId;
  return {
    id, sessionId, role, createdAt: 0 as TimestampMs,
    parts: parts.map((part, index) => ({ id: `part_${index}` as PartId, messageId: id, sessionId, ...part })) as Message["parts"],
  };
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
