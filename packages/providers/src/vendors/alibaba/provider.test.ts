import { expect, test } from "bun:test";
import type { Message, MessagePart } from "@chili/protocol";
import type { ModelStreamEvent, ModelStreamInput } from "../../types.js";
import { createAlibabaModel, createAlibabaProvider } from "./provider.js";
import { ALIBABA_MODELS, ALIBABA_OPENAI_BASE_URL, QWEN_38_MAX_MODEL, QWEN_38_FLASH_MODEL } from "./models.js";

test("Alibaba uses isolated DashScope credentials, current model and protocol controls", async () => {
  const request = captureRequest();
  const model = createAlibabaModel({
    env: { DASHSCOPE_API_KEY: "dash-key", ALIBABA_API_KEY: "other-key", OPENAI_API_KEY: "wrong-provider" },
    fetch: request.fetch,
  });
  await collect(model.stream({ messages: [], system: ["system"], developer: ["developer"] }));
  expect(request.url).toBe(`${ALIBABA_OPENAI_BASE_URL}/chat/completions`);
  expect(request.headers.get("authorization")).toBe("Bearer dash-key");
  expect(request.body).toMatchObject({
    model: QWEN_38_MAX_MODEL,
    max_completion_tokens: 131072,
    stream: true,
    stream_options: { include_usage: true },
    enable_thinking: true,
    preserve_thinking: true,
    messages: [{ role: "system", content: "system\n\ndeveloper" }],
  });
  for (const key of ["thinking", "store", "max_tokens", "reasoning_effort", "thinking_budget"]) {
    expect(request.body).not.toHaveProperty(key);
  }
  expect(() => createAlibabaModel({ env: { OPENAI_API_KEY: "wrong-provider" } })).toThrow("DASHSCOPE_API_KEY or ALIBABA_API_KEY");
});

test("Alibaba supports region/workspace endpoints and explicit connection overrides", async () => {
  const request = captureRequest();
  const model = createAlibabaModel({
    env: { ALIBABA_API_KEY: "alias-key", ALIBABA_BASE_URL: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/", ALIBABA_MODEL: QWEN_38_FLASH_MODEL },
    fetch: request.fetch,
  });
  await collect(model.stream({ messages: [] }));
  expect(request.url).toBe("https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
  expect(request.headers.get("authorization")).toBe("Bearer alias-key");
  expect(request.body.model).toBe(QWEN_38_FLASH_MODEL);

  await collect(createAlibabaModel({
    env: { DASHSCOPE_API_KEY: "env-key", DASHSCOPE_BASE_URL: "https://ignored.test/v1" },
    apiKey: "explicit-key", baseUrl: "https://proxy.test/custom/chat/completions",
    maxTokens: 8000, headers: { "x-project": "chili" }, fetch: request.fetch,
  }).stream({ messages: [] }));
  expect(request.url).toBe("https://proxy.test/custom/chat/completions");
  expect(request.headers.get("authorization")).toBe("Bearer explicit-key");
  expect(request.headers.get("x-project")).toBe("chili");
  expect(request.body.max_completion_tokens).toBe(8000);
});

test("Alibaba maps Qwen effort and per-request off without a second thinking budget", async () => {
  const request = captureRequest();
  const model = createAlibabaModel({ apiKey: "test-key", reasoningEffort: "high", fetch: request.fetch });
  await collect(model.stream({ messages: [] }));
  expect(request.body.reasoning_effort).toBe("xhigh");
  await collect(model.stream({ messages: [], reasoningLevel: "off" }));
  expect(request.body.enable_thinking).toBe(false);
  expect(request.body).not.toHaveProperty("reasoning_effort");
  for (const [requested, expected] of [["minimal", "low"], ["medium", "medium"], ["ultra", "xhigh"]] as const) {
    await collect(model.stream({ messages: [], reasoningLevel: requested }));
    expect(request.body.reasoning_effort).toBe(expected);
    expect(request.body.enable_thinking).toBe(true);
    expect(request.body).not.toHaveProperty("thinking_budget");
  }
});

test("Alibaba streams tools and replays historical reasoning separately from the answer", async () => {
  const request = captureRequest(() => new Response([
    { id: "qwen-response", choices: [{ index: 0, delta: { reasoning_content: "Check the file." } }] },
    { choices: [{ index: 0, delta: { content: "Reading now." } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "qwen_tool_1", type: "function", function: { name: "read", arguments: '{"path":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"app.ts"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 2 } } },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
  const model = createAlibabaModel({ apiKey: "test-key", fetch: request.fetch });
  const events = await collect(model.stream({
    messages: [], tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
  }));
  expect(events).toContainEqual({ type: "reasoning_delta", text: "Check the file.", index: 0 });
  expect(events).toContainEqual({ type: "tool_call_end", toolCallId: "qwen_tool_1", name: "read", input: { path: "app.ts" }, index: 0 });
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool_use", usage: { inputTokens: 10, cacheReadInputTokens: 2, outputTokens: 7 } });

  await collect(model.stream({ messages: [message("assistant", [
    part({ type: "reasoning", text: "Check the file." }),
    part({ type: "text", text: "Reading now." }),
    part({ type: "tool_call", callId: "qwen_tool_1", toolName: "read", input: { path: "app.ts" }, status: "completed" }),
    part({ type: "tool_result", callId: "qwen_tool_1", output: "file contents" }),
  ])] }));
  expect(request.body.messages).toMatchObject([
    { role: "assistant", content: "Reading now.", reasoning_content: "Check the file.", tool_calls: [{ id: "qwen_tool_1" }] },
    { role: "tool", tool_call_id: "qwen_tool_1", content: "file contents" },
  ]);
});

test("Alibaba keeps unknown model metadata conservative and accepts image input only when known", async () => {
  const request = captureRequest();
  const imageInput: ModelStreamInput = { messages: [message("user", [part({ type: "image", data: "YWJj", mimeType: "image/png" })])] };
  await collect(createAlibabaModel({ apiKey: "test-key", fetch: request.fetch }).stream(imageInput));
  expect(request.body.messages).toMatchObject([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } }] }]);
  const custom = createAlibabaModel({ apiKey: "test-key", model: "custom-deployment", fetch: request.fetch });
  await collect(custom.stream({ messages: [], reasoningLevel: "high" }));
  expect(request.body).toMatchObject({ model: "custom-deployment", max_tokens: 4096 });
  for (const key of ["thinking", "enable_thinking", "reasoning_effort", "preserve_thinking"]) expect(request.body).not.toHaveProperty(key);
  await expect(collect(custom.stream(imageInput))).rejects.toThrow("does not support image input");
  const catalog = createAlibabaProvider({ model: "custom-deployment", env: {} }).models();
  expect(catalog[0]).toMatchObject({ model: "custom-deployment", default: true });
  for (const key of ["inputCapabilities", "capabilities", "reasoningLevels", "contextWindowTokens", "maxOutputTokens", "cost"]) {
    expect(catalog[0]).not.toHaveProperty(key);
  }
  expect(catalog.filter((model) => model.default)).toHaveLength(1);
  expect(ALIBABA_MODELS).toHaveLength(3);
});

test("Alibaba checks cancellation before sending an HTTP request", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const model = createAlibabaModel({ apiKey: "test-key", fetch: (async () => { calls++; return new Response(); }) as unknown as typeof fetch });
  await expect(collect(model.stream({ messages: [], signal: controller.signal }))).rejects.toThrow();
  expect(calls).toBe(0);
});

test("a partial Alibaba compatibility override preserves the vendor dialect", async () => {
  const request = captureRequest();
  await collect(createAlibabaModel({
    apiKey: "test-key", fetch: request.fetch,
    compatibility: { supportsUsageInStreaming: false }, reasoningEffort: "high",
  }).stream({ messages: [message("assistant", [part({ type: "reasoning", text: "previous thought" }), part({ type: "text", text: "previous answer" })])] }));
  expect(request.body).toMatchObject({
    enable_thinking: true, preserve_thinking: true, reasoning_effort: "xhigh",
    max_completion_tokens: 131072,
    messages: [{ role: "assistant", content: "previous answer", reasoning_content: "previous thought" }],
  });
  expect(request.body).not.toHaveProperty("stream_options");
  expect(request.body).not.toHaveProperty("store");
});

function captureRequest(response: () => Response = () => new Response(JSON.stringify({
  id: "qwen-response", choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
}), { headers: { "content-type": "application/json" } })) {
  const state = { url: "", headers: new Headers(), body: {} as Record<string, unknown>, fetch: undefined as unknown as typeof fetch };
  state.fetch = (async (input, init) => {
    state.url = String(input);
    state.headers = new Headers(init?.headers);
    state.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response();
  }) as typeof fetch;
  return state;
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
