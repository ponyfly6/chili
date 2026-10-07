import { expect, test } from "bun:test";
import { createMiniMaxM3Model, createMiniMaxProvider, resolveMiniMaxResponsesUrl, MINIMAX_M3_MODEL, MINIMAX_PROVIDER_ID } from "./provider.js";
import type { Message, MessageId, PartId, SessionId, TimestampMs } from "@chili/protocol";
import { MINIMAX_BASE_URL, MINIMAX_M31_FLASH_PREVIEW_MODEL } from "./models.js";
import type { ModelStreamEvent } from "../../types.js";

const rawCallId = "call/minimax:" + "x".repeat(100);

test("MiniMax M3 model factory resolves model, baseUrl, and API key from env", async () => {
  let url = "";
  let headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse([{ type: "response.completed", response: { id: "msg_env", status: "completed" } }]);
  }) as typeof fetch;

  const model = createMiniMaxM3Model({
    env: {
      MINIMAX_API_KEY: "env-key",
      MINIMAX_BASE_URL: "https://env.minimax.test/v1",
      MINIMAX_MODEL: MINIMAX_M3_MODEL,
    },
    fetch: fetchImpl,
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(url).toBe("https://env.minimax.test/v1/responses");
  expect(headers.authorization).toBe("Bearer env-key");
  expect(body.model).toBe(MINIMAX_M3_MODEL);
  expect(body).not.toHaveProperty("thinking");
  expect(body).not.toHaveProperty("messages");
  expect(body).not.toHaveProperty("include");
  expect(body.max_output_tokens).toBe(131072);
  expect(body.reasoning).toEqual({ effort: "high" });
  expect(body).not.toHaveProperty("service_tier");
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop", responseId: "msg_env" });
});

test("MiniMax rejects Anthropic-only credentials before issuing a request", () => {
  let requested = false;
  expect(() => createMiniMaxM3Model({
    env: {
      ANTHROPIC_API_KEY: "anthropic-only-key",
      ANTHROPIC_BASE_URL: "https://anthropic.test",
      ANTHROPIC_MODEL: "claude-custom",
    },
    fetch: (async () => {
      requested = true;
      throw new Error("unexpected request");
    }) as unknown as typeof fetch,
  })).toThrow("requires an API key");
  expect(requested).toBe(false);
});

test("MiniMax ignores removed Anthropic base URL env", async () => {
  let url = "";
  const fetchImpl = (async (input) => {
    url = String(input);
    return sseResponse([{ type: "response.completed", response: { id: "msg_url", status: "completed" } }]);
  }) as typeof fetch;

  const model = createMiniMaxM3Model({
    env: {
      MINIMAX_API_KEY: "env-key",
      MINIMAX_BASE_URL: "https://api.minimax.cn/v1",
      MINIMAX_ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
    },
    fetch: fetchImpl,
  });

  await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(url).toBe("https://api.minimax.cn/v1/responses");
});

test("MiniMax provider lists a configured custom default model without dropping catalog models", () => {
  const provider = createMiniMaxProvider({
    env: {
      MINIMAX_MODEL: "custom-minimax-model",
      MINIMAX_BASE_URL: "https://custom.minimax.test/v1",
    },
  });

  const models = provider.models();

  expect(models[0]).toMatchObject({
    provider: MINIMAX_PROVIDER_ID,
    model: "custom-minimax-model",
    apiFamily: "openai-responses",
    baseUrl: "https://custom.minimax.test/v1",
    default: true,
  });
  expect(models[0]?.inputCapabilities).toEqual(["text"]);
  for (const key of ["capabilities", "compatibility", "contextWindowTokens", "maxOutputTokens", "cost", "reasoningLevels"]) {
    expect(models[0]).not.toHaveProperty(key);
  }
  expect(models.some((model) => model.model === MINIMAX_M3_MODEL)).toBe(true);
  expect(models.filter((model) => model.default)).toHaveLength(1);
});

test("MiniMax provider marks an env-selected catalog model as default", () => {
  const provider = createMiniMaxProvider({
    env: {
      MINIMAX_MODEL: MINIMAX_M3_MODEL,
      MINIMAX_BASE_URL: "https://catalog.minimax.test/v1",
    },
  });

  const models = provider.models();

  expect(models.find((model) => model.model === MINIMAX_M3_MODEL)).toMatchObject({
    model: MINIMAX_M3_MODEL,
    baseUrl: "https://catalog.minimax.test/v1",
    default: true,
  });
  expect(models.filter((model) => model.default)).toHaveLength(1);
});

test("MiniMax maps explicit reasoning and fast service tier options", async () => {
  let body: Record<string, unknown> = {};
  const model = createMiniMaxM3Model({
    apiKey: "test-key",
    env: {},
    reasoning: false,
    serviceTier: "fast",
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([{ type: "response.completed", response: { id: "msg_options", status: "completed" } }]);
    }) as typeof fetch,
  });

  await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(body.model).toBe(MINIMAX_M3_MODEL);
  expect(body.max_output_tokens).toBe(131072);
  expect(body.reasoning).toEqual({ effort: "none" });
  expect(body.service_tier).toBe("priority");
});

test("MiniMax per-request reasoning and service tier override model options", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return sseResponse([{ type: "response.completed", response: { id: "msg_override", status: "completed" } }]);
  }) as typeof fetch;
  const adaptiveFast = createMiniMaxM3Model({
    apiKey: "test-key",
    env: {},
    reasoning: true,
    serviceTier: "fast",
    fetch: fetchImpl,
  });
  const disabledStandard = createMiniMaxM3Model({
    apiKey: "test-key",
    env: {},
    reasoning: false,
    serviceTier: "standard",
    fetch: fetchImpl,
  });

  await collect(adaptiveFast.stream({
    messages: [],
    tools: [],
    system: [],
    reasoning: "off",
    serviceTier: "standard",
  }));
  await collect(disabledStandard.stream({
    messages: [],
    tools: [],
    system: [],
    reasoning: "high",
    serviceTier: "fast",
  }));

  expect(bodies[0]?.reasoning).toEqual({ effort: "none" });
  expect(bodies[0]).not.toHaveProperty("service_tier");
  expect(bodies[1]?.reasoning).toEqual({ effort: "high" });
  expect(bodies[1]?.service_tier).toBe("priority");
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const streamEvent of stream) events.push(streamEvent);
  return events;
}


test("MiniMax M3.1 Responses reasoning is always on and accepts bounded effort", async () => {
  const bodies: Record<string, unknown>[] = [];
  const model = createMiniMaxM3Model({
    apiKey: "test", env: {}, model: MINIMAX_M31_FLASH_PREVIEW_MODEL,
    fetch: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return completedResponse();
    }) as typeof fetch,
  });
  await collect(model.stream({ messages: [] }));
  await collect(model.stream({ messages: [], reasoning: "off" }));
  await collect(model.stream({ messages: [], reasoning: "ultra" }));
  expect(bodies[0]).not.toHaveProperty("reasoning");
  expect(bodies[1]?.reasoning).toEqual({ effort: "low" });
  expect(bodies[2]?.reasoning).toEqual({ effort: "max" });
});

test("MiniMax Responses formats tools, preserves tool IDs, omits assistant phase and accepts images", async () => {
  let body: Record<string, unknown> = {};
  const model = createMiniMaxM3Model({
    apiKey: "test", env: {},
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return completedResponse();
    }) as typeof fetch,
  });
  await collect(model.stream({
    system: ["system"], developer: ["developer"], contextualUser: ["context"],
    tools: [{ name: "read", description: "Read file", inputSchema: { type: "object" } }],
    messages: [
      message("user", [{ type: "text", text: "Inspect" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]),
      message("assistant", [
        { type: "text", text: "Checking", phase: "commentary" },
        { type: "tool_call", callId: "internal", providerCallId: rawCallId, toolName: "read", input: { path: "file.ts" }, status: "completed" },
      ]),
      message("tool", [{ type: "tool_result", callId: "internal", providerCallId: rawCallId, output: "contents" }]),
    ],
  }));
  expect(body.instructions).toBe("system\n\ndeveloper");
  expect(body.tools).toEqual([{ type: "function", name: "read", description: "Read file", parameters: { type: "object" } }]);
  expect(body.input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "context" }] },
    { role: "user", content: [{ type: "input_text", text: "Inspect" }, { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Checking" }] },
    { type: "function_call", call_id: rawCallId, name: "read", arguments: '{"path":"file.ts"}' },
    { type: "function_call_output", call_id: rawCallId, output: "contents" },
  ]);
});

test("MiniMax Responses streams reasoning and tool arguments, then replays returned reasoning with the same connection", async () => {
  const reasoning = { id: "rs_1", type: "reasoning", status: "completed", summary: [], content: [{ type: "reasoning_text", text: "Inspect files." }] };
  const bodies: Record<string, unknown>[] = [];
  const model = createMiniMaxM3Model({
    apiKey: "test", env: {},
    fetch: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length > 1) return completedResponse();
      return sseResponse([
        { type: "response.created", response: { id: "resp_1", model: MINIMAX_M3_MODEL, status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...reasoning, status: "in_progress", content: [] } },
        { type: "response.reasoning_text.delta", output_index: 0, content_index: 0, delta: "Inspect files." },
        { type: "response.reasoning_text.done", output_index: 0, content_index: 0, text: "Inspect files." },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        { type: "response.output_item.added", output_index: 1, item: { id: "fc_1", type: "function_call", call_id: rawCallId, name: "read", arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: '{"path":"file.ts"}' },
        { type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_1", arguments: '{"path":"file.ts"}' },
        { type: "response.output_item.done", output_index: 1, item: { id: "fc_1", type: "function_call", call_id: rawCallId, name: "read", arguments: '{"path":"file.ts"}', status: "completed" } },
        { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      ]);
    }) as typeof fetch,
  });
  const events = await collect(model.stream({ messages: [] }));
  expect(events.filter((event) => event.type === "reasoning_delta").map((event) => event.text).join("")).toBe("Inspect files.");
  expect(events).toContainEqual({ type: "tool_call_end", toolCallId: rawCallId, name: "read", input: { path: "file.ts" }, index: 1 });
  const output = events.find((event) => event.type === "reasoning_item");
  expect(output?.output.item).toEqual(reasoning);
  await collect(model.stream({ messages: [message("assistant", [
    { type: "reasoning", text: "Inspect files." },
    { type: "reasoning", text: "", modelOutput: output?.output },
    { type: "text", text: "done" },
  ])] }));
  expect(bodies[1]?.input).toEqual([
    { type: "reasoning", summary: [{ type: "summary_text", text: "Inspect files." }] },
    { role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ]);
});

test("MiniMax Responses default endpoint stays domestic and old endpoint settings are ignored", async () => {
  let url = "";
  const model = createMiniMaxM3Model({ env: { MINIMAX_API_KEY: "test", MINIMAX_ANTHROPIC_BASE_URL: "https://legacy.test/anthropic" }, fetch: (async (input) => {
    url = String(input);
    return completedResponse();
  }) as typeof fetch });
  await collect(model.stream({ messages: [] }));
  expect(MINIMAX_BASE_URL).toBe("https://api.minimax.cn/v1");
  expect(url).toBe("https://api.minimax.cn/v1/responses");
});

test("MiniMax Responses cancellation closes stream and pre-abort avoids dispatch", async () => {
  let requests = 0;
  let cancelled = false;
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_live","status":"in_progress"}}\n\n'));
    },
    cancel() { cancelled = true; },
  });
  const model = createMiniMaxM3Model({ apiKey: "test", env: {}, fetch: (async () => {
    requests++;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch });
  const stream = model.stream({ messages: [], signal: abort.signal })[Symbol.asyncIterator]();
  expect(await stream.next()).toMatchObject({ done: false, value: { type: "metadata", provider: "minimax" } });
  expect(await stream.next()).toMatchObject({ done: false, value: { type: "metadata", responseId: "resp_live" } });
  abort.abort();
  await expect(stream.next()).rejects.toThrow();
  expect(cancelled).toBe(true);
  await expect(collect(model.stream({ messages: [], signal: abort.signal }))).rejects.toThrow();
  expect(requests).toBe(1);
});

function completedResponse(): Response {
  return sseResponse([{ type: "response.completed", response: { id: "resp_test", status: "completed" } }]);
}

function sseResponse(events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function message(role: Message["role"], parts: Record<string, unknown>[]): Message {
  const id = `msg_${role}` as MessageId;
  const sessionId = "session_minimax" as SessionId;
  return { id, sessionId, role, createdAt: 1 as TimestampMs, parts: parts.map((part, index) => ({ id: `part_${index}` as PartId, messageId: id, sessionId, ...part })) as Message["parts"] };
}


test("unknown MiniMax models use a conservative request allowance and reject unverified image input", async () => {
  const bodies: Record<string, unknown>[] = [];
  const router = createMiniMaxM3Model({
    apiKey: "test", env: {}, model: "custom-minimax-model",
    fetch: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return completedResponse();
    }) as typeof fetch,
  });
  await collect(router.stream({ messages: [message("user", [{ type: "text", text: "hello" }])] }));
  expect(bodies[0]?.max_output_tokens).toBe(4096);
  expect(bodies[0]).not.toHaveProperty("reasoning");
  await expect(collect(router.stream({ messages: [message("user", [
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  ])] }))).rejects.toThrow("image");
  expect(bodies).toHaveLength(1);
});

test("MiniMax rejects legacy Messages URLs and preserves valid Responses query parameters", () => {
  for (const baseUrl of ["https://api.minimaxi.com/anthropic", "https://api.minimaxi.com/anthropic/v1", "https://api.minimaxi.com/anthropic/v1/messages", "https://proxy.test/v1/messages/"]) {
    expect(() => resolveMiniMaxResponsesUrl(baseUrl)).toThrow("migrate MINIMAX_BASE_URL");
  }
  expect(resolveMiniMaxResponsesUrl("https://proxy.test?deployment=test#remove")).toBe("https://proxy.test/v1/responses?deployment=test");
  expect(resolveMiniMaxResponsesUrl("https://proxy.test/v1/?deployment=test")).toBe("https://proxy.test/v1/responses?deployment=test");
  expect(resolveMiniMaxResponsesUrl("https://proxy.test/custom/responses?deployment=test")).toBe("https://proxy.test/custom/responses?deployment=test");
});
