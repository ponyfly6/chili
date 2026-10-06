import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import {
  AnthropicCompatibleModel,
  buildAnthropicRequestBody,
  createMiniMaxM3Model,
  MINIMAX_ANTHROPIC_BASE_URL,
  MINIMAX_M3_MODEL,
  normalizeAnthropicToolCallId,
  ProviderBackpressureCoordinator,
  ProviderError,
} from "./index.js";
import type { ModelStreamEvent, ModelTool } from "./types.js";

const sessionId = "session_test" as SessionId;
const createdAt = 1 as TimestampMs;

test("converts Chili messages and tools into an Anthropic request body", () => {
  const toolCallId = "toolcall_weather" as ToolCallId;
  const messages = [
    message("system", [{ type: "text", text: "stored system" }]),
    message("user", [{ type: "text", text: "hello" }]),
    message("assistant", [
      { type: "text", text: "I will check." },
      { type: "tool_call", callId: toolCallId, toolName: "weather", input: { city: "Shanghai" }, status: "pending" },
    ]),
    message("user", [{ type: "tool_result", callId: toolCallId, output: "sunny" }]),
  ];
  const tools: ModelTool[] = [
    {
      name: "weather",
      description: "Read weather.",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ];

  const body = buildAnthropicRequestBody(
    {
      messages,
      tools,
      system: ["runtime system"],
    },
    {
      model: "test-model",
      maxTokens: 123,
      temperature: 0.2,
      stream: true,
    },
  );

  expect(body).toEqual({
    model: "test-model",
    max_tokens: 123,
    stream: true,
    temperature: 0.2,
    system: "runtime system\n\nstored system",
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will check." },
          { type: "tool_use", id: toolCallId, name: "weather", input: { city: "Shanghai" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolCallId, content: "sunny" }] },
    ],
    tools: [
      {
        name: "weather",
        description: "Read weather.",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
  });
});

test("adds MiniMax thinking and priority fields only when explicitly configured", () => {
  const input = { messages: [], tools: [], system: [] };
  const plain = buildAnthropicRequestBody(input, {
    model: "test-model",
    stream: true,
  });
  const adaptiveFast = buildAnthropicRequestBody(input, {
    model: MINIMAX_M3_MODEL,
    reasoning: true,
    serviceTier: "fast",
    stream: true,
  });
  const disabledStandard = buildAnthropicRequestBody(input, {
    model: MINIMAX_M3_MODEL,
    reasoning: false,
    serviceTier: "standard",
    stream: true,
  });

  expect(plain).not.toHaveProperty("thinking");
  expect(plain).not.toHaveProperty("service_tier");
  expect(adaptiveFast).toMatchObject({
    thinking: { type: "adaptive" },
    service_tier: "priority",
  });
  expect(disabledStandard).toMatchObject({
    thinking: { type: "disabled" },
  });
  expect(disabledStandard).not.toHaveProperty("service_tier");
});

test("does not serialize an OpenAI-only encrypted reasoning state as an empty Anthropic block", () => {
  const body = buildAnthropicRequestBody(
    {
      messages: [
        message("assistant", [{
          type: "reasoning",
          text: "",
          modelOutput: {
            apiFamily: "openai-responses",
            outputIndex: 0,
            item: { type: "reasoning", encrypted_content: "ciphertext" },
          },
        }]),
        message("user", [{ type: "text", text: "Continue." }]),
      ],
      tools: [],
      system: [],
    },
    { model: "test-model", stream: true },
  );

  expect(body.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Continue." }] },
  ]);
});

test("normalizes Anthropic tool ids and synthesizes missing tool results in request bodies", () => {
  const invalidToolCallId = "responses|tool call with spaces!" as ToolCallId;
  const normalizedToolCallId = normalizeAnthropicToolCallId(invalidToolCallId);
  const messages = [
    message("assistant", [
      { type: "reasoning", text: "opaque", redacted: true },
      { type: "tool_call", callId: invalidToolCallId, toolName: "bash", input: { cmd: "pwd" }, status: "pending" },
    ]),
    message("user", [{ type: "text", text: "new request" }]),
  ];

  const body = buildAnthropicRequestBody(
    {
      messages,
      tools: [],
      system: [],
    },
    {
      model: "test-model",
      stream: true,
    },
  );

  expect(body.messages).toEqual([
    {
      role: "assistant",
      content: [{ type: "tool_use", id: normalizedToolCallId, name: "bash", input: { cmd: "pwd" } }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: normalizedToolCallId,
          content: "No result provided\n\nError: No result provided",
          is_error: true,
        },
        { type: "text", text: "new request" },
      ],
    },
  ]);
});

test("converts image tool results into Anthropic image blocks", () => {
  const callId = "toolcall_image" as ToolCallId;
  const body = buildAnthropicRequestBody(
    {
      messages: [
        message("assistant", [
          { type: "tool_call", callId, toolName: "read_image", input: { filePath: "pixel.png" }, status: "completed" },
        ]),
        message("user", [
          {
            type: "tool_result",
            callId,
            output: "Image read: pixel.png",
            executionContext: {
              sandbox: "macos-seatbelt",
              executionMode: "sandboxed",
              exitCode: 1,
            },
            content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          },
        ]),
      ],
      tools: [],
      system: [],
    },
    {
      model: "test-model",
      stream: true,
    },
  );

  expect((body.messages as unknown[]).at(-1)).toEqual({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: callId,
        content: [
          {
            type: "text",
            text: [
              "Image read: pixel.png",
              "",
              "[tool execution context]",
              "sandbox: macos-seatbelt",
              "execution_mode: sandboxed",
              "exit_code: 1",
            ].join("\n"),
          },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
        ],
      },
    ],
  });
});

test("converts pasted user images into Anthropic image blocks", () => {
  const body = buildAnthropicRequestBody(
    {
      messages: [
        message("user", [
          { type: "text", text: "What is in this image? [Image #1]" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png", filename: "pixel.png" },
        ]),
      ],
      tools: [],
      system: [],
    },
    {
      model: "test-model",
      stream: true,
    },
  );

  expect(body.messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image? [Image #1]" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
      ],
    },
  ]);
});

test("MiniMax M3 includes image tool results as multimodal context", async () => {
  const callId = "toolcall_image" as ToolCallId;
  let fetchCalled = false;
  let body: Record<string, unknown> | undefined;
  const model = createMiniMaxM3Model({
    apiKey: "test-key",
    model: MINIMAX_M3_MODEL,
    fetch: (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      fetchCalled = true;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "msg_text",
        model: MINIMAX_M3_MODEL,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });

  const events = await collect(model.stream({
    messages: [
      message("assistant", [
        { type: "tool_call", callId, toolName: "read_image", input: { filePath: "pixel.png" }, status: "completed" },
      ]),
      message("user", [
        {
          type: "tool_result",
          callId,
          output: "Image read: pixel.png",
          content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
        },
      ]),
    ],
    tools: [],
    system: [],
  }));

  expect(fetchCalled).toBe(true);
  expect((body?.messages as unknown[]).at(-1)).toEqual({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: callId,
        content: [
          { type: "text", text: "Image read: pixel.png" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
        ],
      },
    ],
  });
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "end_turn" });
});

test("adds developer fragments to system and contextual fragments as synthetic user context", () => {
  const body = buildAnthropicRequestBody(
    {
      messages: [message("user", [{ type: "text", text: "hello" }])],
      tools: [],
      system: ["base instructions"],
      developer: ["skills catalog"],
      contextualUser: ["memory context"],
    },
    {
      model: "test-model",
      stream: true,
    },
  );

  expect(body.system).toBe("base instructions\n\nskills catalog");
  expect(body.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "memory context" }, { type: "text", text: "hello" }] },
  ]);
});

test("converts assistant-attached tool results into Anthropic user tool results", () => {
  const firstCallId = "toolcall_ls" as ToolCallId;
  const secondCallId = "toolcall_glob" as ToolCallId;
  const messages = [
    message("user", [{ type: "text", text: "总结这个仓库" }]),
    message("assistant", [
      { type: "tool_call", callId: firstCallId, toolName: "bash", input: { command: "ls -la" }, status: "pending" },
      { type: "tool_call", callId: secondCallId, toolName: "glob", input: { pattern: "*" }, status: "pending" },
      { type: "tool_result", callId: firstCallId, output: "package.json\nREADME.md" },
      { type: "tool_result", callId: secondCallId, output: "apps\npackages" },
    ]),
  ];

  const body = buildAnthropicRequestBody(
    {
      messages,
      tools: [],
      system: [],
    },
    {
      model: "test-model",
      stream: true,
    },
  );

  expect(body.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "总结这个仓库" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: firstCallId, name: "bash", input: { command: "ls -la" } },
        { type: "tool_use", id: secondCallId, name: "glob", input: { pattern: "*" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: firstCallId, content: "package.json\nREADME.md" },
        { type: "tool_result", tool_use_id: secondCallId, content: "apps\npackages" },
      ],
    },
  ]);
  expect(JSON.stringify(body.messages)).not.toContain("No result provided");
});

test("passes AbortSignal through to fetch and requests streaming", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | null | undefined;
  let body: Record<string, unknown> | undefined;
  let url = "";
  const fetchImpl = (async (input, init) => {
    url = String(input);
    signal = init?.signal;
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "msg_json", content: [], stop_reason: "end_turn" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const model = createMiniMaxM3Model({
    apiKey: "test-key",
    baseUrl: MINIMAX_ANTHROPIC_BASE_URL,
    env: {},
    fetch: fetchImpl,
    maxTokens: 64,
  });

  const events = await collect(
    model.stream({
      messages: [],
      tools: [],
      system: [],
      signal: controller.signal,
    }),
  );

  expect(url).toBe(`${MINIMAX_ANTHROPIC_BASE_URL}/v1/messages`);
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(body?.model).toBe(MINIMAX_M3_MODEL);
  expect(body?.max_tokens).toBe(64);
  expect(body?.stream).toBe(true);
  expect(body?.thinking).toEqual({ type: "adaptive" });
  expect(events.at(-1)).toEqual({ type: "finish", reason: "end_turn", responseId: "msg_json" });
});

test("does not send MiniMax request controls for other Anthropic-compatible providers", async () => {
  let body: Record<string, unknown> = {};
  const model = new AnthropicCompatibleModel({
    provider: "zai",
    model: "test-model",
    apiKey: "test-key",
    baseUrl: "https://model.test",
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "msg_zai", content: [], stop_reason: "end_turn" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  await collect(model.stream({
    messages: [],
    tools: [],
    system: [],
    reasoning: "high",
    serviceTier: "fast",
  }));

  expect(body).not.toHaveProperty("thinking");
  expect(body).not.toHaveProperty("service_tier");
});

test("parses Anthropic SSE text and tool deltas", async () => {
  const model = new AnthropicCompatibleModel({
    provider: "minimax",
    model: "test-model",
    apiKey: "test-key",
    baseUrl: "https://model.test",
    fetch: sseFetch([
      event("message_start", {
        type: "message_start",
        message: {
          id: "msg_sse",
          model: "test-model",
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      }),
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hi " },
      }),
      event("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "bash", input: {} },
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{\"cmd\"" },
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: ":\"ls\"}" },
      }),
      event("content_block_stop", {
        type: "content_block_stop",
        index: 1,
      }),
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 7 },
      }),
      event("message_stop", {
        type: "message_stop",
      }),
    ]),
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(events.map((streamEvent) => streamEvent.type)).toEqual([
    "metadata",
    "text_delta",
    "tool_call_start",
    "tool_call_delta",
    "tool_call_delta",
    "tool_call_end",
    "metadata",
    "finish",
  ]);
  expect(events[0]).toMatchObject({
    type: "metadata",
    provider: "minimax",
    model: "test-model",
    responseId: "msg_sse",
    usage: { inputTokens: 3, outputTokens: 0, totalTokens: 3 },
  });
  expect(events[1]).toEqual({ type: "text_delta", text: "hi ", index: 0 });
  expect(events[2]).toEqual({ type: "tool_call_start", toolCallId: "toolu_1", name: "bash", index: 1 });
  expect(events[3]).toEqual({
    type: "tool_call_delta",
    toolCallId: "toolu_1",
    name: "bash",
    delta: "{\"cmd\"",
    index: 1,
  });
  expect(events[4]).toEqual({
    type: "tool_call_delta",
    toolCallId: "toolu_1",
    name: "bash",
    delta: ":\"ls\"}",
    index: 1,
    partialInput: { cmd: "ls" },
  });
  expect(events[5]).toEqual({
    type: "tool_call_end",
    toolCallId: "toolu_1",
    name: "bash",
    input: { cmd: "ls" },
    index: 1,
  });
  expect(events[7]).toMatchObject({
    type: "finish",
    reason: "tool_use",
    responseId: "msg_sse",
    usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
  });
});

test("normalizes hostile Anthropic stream tool call ids consistently", async () => {
  const model = new AnthropicCompatibleModel({
    provider: "minimax",
    model: "test-model",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    backpressureCoordinator: new ProviderBackpressureCoordinator(),
    fetch: sseFetch([
      event("message_start", {
        type: "message_start",
        message: { id: "msg_hostile_id", model: "test-model", usage: { input_tokens: 1, output_tokens: 0 } },
      }),
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "__proto__", name: "lookup", input: {} },
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"query\":\"chili\"}" },
      }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
      event("message_stop", { type: "message_stop" }),
    ]),
  });

  const events = (await collect(model.stream({ messages: [], tools: [], system: [] })))
    .filter((streamEvent) => streamEvent.type.startsWith("tool_call_"));
  const ids = events.flatMap((streamEvent) => "toolCallId" in streamEvent ? [streamEvent.toolCallId] : []);
  expect(ids).toHaveLength(3);
  expect(new Set(ids).size).toBe(1);
  expect(ids[0]).toMatch(/^toolcall_invalid_[a-f0-9]{16}$/u);
});

test("marks invalid Anthropic streaming tool arguments", async () => {
  const model = new AnthropicCompatibleModel({
    provider: "minimax",
    model: "test-model",
    apiKey: "test-key",
    baseUrl: "https://model.test",
    fetch: sseFetch([
      event("message_start", {
        type: "message_start",
        message: {
          id: "msg_invalid_args",
          model: "test-model",
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      }),
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_invalid", name: "bash", input: {} },
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"cmd\":" },
      }),
      event("content_block_stop", {
        type: "content_block_stop",
        index: 0,
      }),
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 7 },
      }),
      event("message_stop", { type: "message_stop" }),
    ]),
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(events.find((streamEvent) => streamEvent.type === "tool_call_end")).toMatchObject({
    type: "tool_call_end",
    toolCallId: "toolu_invalid",
    name: "bash",
    input: {},
    inputParseError: expect.stringContaining("not valid JSON"),
    index: 0,
  });
});

test("falls back to non-streaming JSON responses", async () => {
  const model = new AnthropicCompatibleModel({
    provider: "minimax",
    model: "test-model",
    apiKey: "test-key",
    baseUrl: "https://model.test",
    fetch: jsonFetch({
      id: "msg_json",
      model: "test-model",
      content: [
        { type: "text", text: "done" },
        { type: "tool_use", id: "toolu_2", name: "edit", input: { filePath: "README.md" } },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 6 },
    }),
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(events.map((streamEvent) => streamEvent.type)).toEqual([
    "metadata",
    "text_delta",
    "tool_call_start",
    "tool_call_end",
    "finish",
  ]);
  expect(events[0]).toMatchObject({
    type: "metadata",
    responseId: "msg_json",
    usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
  });
  expect(events[1]).toEqual({ type: "text_delta", text: "done" });
  expect(events[2]).toEqual({ type: "tool_call_start", toolCallId: "toolu_2", name: "edit" });
  expect(events[3]).toEqual({
    type: "tool_call_end",
    toolCallId: "toolu_2",
    name: "edit",
    input: { filePath: "README.md" },
  });
  expect(events[4]).toMatchObject({ type: "finish", reason: "end_turn", responseId: "msg_json" });
});

test("types MiniMax 2062 as non-retryable and short-circuits sibling requests", async () => {
  let fetchCalls = 0;
  const coordinator = new ProviderBackpressureCoordinator();
  const fetchImpl = (async () => {
    fetchCalls++;
    return new Response(JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "Traffic is currently high—please retry shortly. (2062)",
      },
    }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const options = {
    provider: "minimax",
    model: MINIMAX_M3_MODEL,
    apiKey: "shared-key",
    baseUrl: "https://api.minimaxi.test/anthropic",
    fetch: fetchImpl,
    backpressureCoordinator: coordinator,
  };
  const first = new AnthropicCompatibleModel(options);
  const sibling = new AnthropicCompatibleModel(options);

  const firstError = await caught(collect(first.stream({ messages: [], tools: [], system: [] })));
  expect(firstError).toBeInstanceOf(ProviderError);
  expect(firstError).toMatchObject({
    provider: "minimax",
    status: 429,
    code: "2062",
    category: "plan_capacity",
    retryable: false,
    opensCircuit: true,
  });
  expect(firstError.message).toBe("Model request failed with HTTP 429 Too Many Requests");
  expect(firstError.message).not.toContain("Traffic is currently high");

  const siblingError = await caught(collect(sibling.stream({ messages: [], tools: [], system: [] })));
  expect(siblingError).toMatchObject({ category: "plan_capacity", retryable: false, code: "2062" });
  expect(fetchCalls).toBe(1);
});

test("honors Retry-After across Anthropic-compatible requests", async () => {
  let now = 10_000;
  const waits: number[] = [];
  const coordinator = new ProviderBackpressureCoordinator({
    now: () => now,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return new Response(JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Too many requests" },
      }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "2" },
      });
    }
    return new Response(JSON.stringify({ id: "msg_after_wait", content: [], stop_reason: "end_turn" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const model = new AnthropicCompatibleModel({
    provider: "minimax",
    model: MINIMAX_M3_MODEL,
    apiKey: "rate-key",
    baseUrl: "https://api.minimaxi.test/anthropic",
    fetch: fetchImpl,
    backpressureCoordinator: coordinator,
  });

  const rateError = await caught(collect(model.stream({ messages: [], tools: [], system: [] })));
  expect(rateError).toMatchObject({
    category: "rate_limit",
    retryable: true,
    opensCircuit: false,
    retryAfterMs: 2_000,
  });
  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(waits).toEqual([2_000]);
  expect(fetchCalls).toBe(2);
  expect(events.at(-1)).toMatchObject({ type: "finish", responseId: "msg_after_wait" });
});

test("types Anthropic SSE error events before exposing them to core", async () => {
  const model = new AnthropicCompatibleModel({
    provider: "minimax",
    model: "test-model",
    apiKey: "sse-error-key",
    baseUrl: "https://model.test",
    backpressureCoordinator: new ProviderBackpressureCoordinator(),
    fetch: sseFetch([
      event("error", {
        type: "error",
        error: { type: "rate_limit_error", code: 1002, message: "Rate limited" },
      }),
    ]),
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "error",
    error: {
      name: "ProviderError",
      category: "rate_limit",
      retryable: true,
      code: "1002",
    },
  });
});

test("normalizes Anthropic-compatible HTTP and raw SSE failures without exposing response bodies", async () => {
  const html = "<!DOCTYPE html><html><body>gateway 10.9.8.7 bearer-secret-123</body></html>";
  const httpModel = new AnthropicCompatibleModel({
    provider: "minimax",
    model: "test-model",
    apiKey: "http-error-key",
    baseUrl: "https://safe-error.test/v1",
    backpressureCoordinator: new ProviderBackpressureCoordinator(),
    fetch: (async () => new Response(html, { status: 502 })) as unknown as typeof fetch,
  });

  const httpError = await caught(collect(httpModel.stream({ messages: [] })));
  expect(httpError).toMatchObject({
    name: "ProviderError",
    status: 502,
    category: "server_error",
    retryable: true,
    message: "Model request failed with HTTP 502 Bad Gateway",
  });
  expect(httpError.message).not.toContain("10.9.8.7");
  expect(httpError.message).not.toContain("bearer-secret-123");

  const sseModel = new AnthropicCompatibleModel({
    provider: "minimax",
    model: "test-model",
    apiKey: "sse-raw-key",
    baseUrl: "https://safe-sse.test/v1",
    backpressureCoordinator: new ProviderBackpressureCoordinator(),
    fetch: sseFetch([`event: error\ndata: ${html}\n\n`]),
  });
  const events = await collect(sseModel.stream({ messages: [] }));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "error",
    error: { name: "ProviderError", message: "Model stream failed", category: "unknown" },
  });
  expect(String(events[0]?.type === "error" ? events[0].error : "")).not.toContain("10.9.8.7");
});

test("preserves structured safe fields on Anthropic SSE errors", async () => {
  const model = new AnthropicCompatibleModel({
    provider: "minimax",
    model: "test-model",
    apiKey: "sse-structured-key",
    baseUrl: "https://structured-sse.test/v1",
    backpressureCoordinator: new ProviderBackpressureCoordinator(),
    fetch: sseFetch([event("error", {
      type: "error",
      error: {
        message: "Quota exhausted credential=hunter2 password=swordfish client_secret=private-client",
        code: 2056,
        type: "rate_limit_error",
        param: "session_cookie",
      },
    })], { "x-request-id": "req_anthropic_sse_1", "retry-after": "7" }),
  });

  const events = await collect(model.stream({ messages: [] }));
  expect(events[0]).toMatchObject({
    type: "error",
    error: {
      code: "2056",
      requestId: "req_anthropic_sse_1",
      retryAfterMs: 7_000,
      status: 200,
      category: "quota_exhausted",
      retryable: false,
      message: "Model stream failed (request id: req_anthropic_sse_1)",
    },
  });
  const error = events[0]?.type === "error" ? events[0].error : undefined;
  expect(error).toBeInstanceOf(ProviderError);
  expect((error as ProviderError | undefined)?.param).toBeUndefined();
  expect(String(error)).not.toContain("hunter2");
  expect(String(error)).not.toContain("swordfish");
  expect(String(error)).not.toContain("private-client");
});

test("preserves header hints on Anthropic 2xx JSON error envelopes", async () => {
  const model = new AnthropicCompatibleModel({
    provider: "minimax",
    model: "test-model",
    apiKey: "json-error-key",
    baseUrl: "https://json-error.test/v1",
    backpressureCoordinator: new ProviderBackpressureCoordinator(),
    fetch: jsonFetch({ error: { message: "Rate limited", code: 1002 } }, {
      "x-request-id": "req_anthropic_json_1",
      "retry-after": "9",
    }),
  });

  const events = await collect(model.stream({ messages: [] }));
  expect(events[0]).toMatchObject({
    type: "error",
    error: {
      status: 200,
      code: "1002",
      requestId: "req_anthropic_json_1",
      retryAfterMs: 9_000,
      category: "rate_limit",
      retryable: true,
    },
  });
});

test("uses the resolved messages URL as the shared backpressure scope", async () => {
  let fetchCalls = 0;
  const coordinator = new ProviderBackpressureCoordinator();
  const fetchImpl = (async () => {
    fetchCalls++;
    return new Response(JSON.stringify({
      type: "error",
      error: { message: "Traffic is currently high. (2062)" },
    }), { status: 429 });
  }) as unknown as typeof fetch;
  const common = {
    provider: "minimax",
    model: "test-model",
    apiKey: "same-key",
    fetch: fetchImpl,
    backpressureCoordinator: coordinator,
  };
  const baseV1 = new AnthropicCompatibleModel({ ...common, baseUrl: "https://equivalent.test/v1" });
  const messagesUrl = new AnthropicCompatibleModel({ ...common, baseUrl: "https://equivalent.test/v1/messages" });

  await caught(collect(baseV1.stream({ messages: [] })));
  const siblingError = await caught(collect(messagesUrl.stream({ messages: [] })));

  expect(siblingError).toMatchObject({ category: "plan_capacity", code: "2062" });
  expect(fetchCalls).toBe(1);
});

test("preserves URL queries and partitions backpressure by the actual request URL", async () => {
  const requestedUrls: string[] = [];
  const coordinator = new ProviderBackpressureCoordinator();
  const fetchImpl = (async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify({
      type: "error",
      error: { message: "Traffic is currently high. (2062)" },
    }), { status: 429 });
  }) as unknown as typeof fetch;
  const common = {
    provider: "minimax",
    model: "test-model",
    apiKey: "same-key",
    fetch: fetchImpl,
    backpressureCoordinator: coordinator,
  };

  await caught(collect(new AnthropicCompatibleModel({
    ...common,
    baseUrl: "https://tenant.test/v1?deployment=a#ignored",
  }).stream({ messages: [] })));
  await caught(collect(new AnthropicCompatibleModel({
    ...common,
    baseUrl: "https://tenant.test/v1?deployment=b",
  }).stream({ messages: [] })));

  expect(requestedUrls).toEqual([
    "https://tenant.test/v1/messages?deployment=a",
    "https://tenant.test/v1/messages?deployment=b",
  ]);
});

test("handles malformed Anthropic error field types without bypassing classification", async () => {
  const model = new AnthropicCompatibleModel({
    provider: "minimax",
    model: "test-model",
    apiKey: "malformed-key",
    baseUrl: "https://malformed.test/v1",
    backpressureCoordinator: new ProviderBackpressureCoordinator(),
    fetch: (async () => new Response(JSON.stringify({
      error: { message: { private: true }, type: 42, code: 1002 },
    }), { status: 429 })) as unknown as typeof fetch,
  });

  const error = await caught(collect(model.stream({ messages: [] })));
  expect(error).toMatchObject({
    name: "ProviderError",
    code: "1002",
    category: "rate_limit",
    retryable: true,
  });
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const streamEvent of stream) events.push(streamEvent);
  return events;
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    return new Error(String(error));
  }
  throw new Error("Expected promise to reject");
}

function message(role: Message["role"], parts: Array<Record<string, unknown>>): Message {
  const messageId = `msg_${role}_${Math.random().toString(16).slice(2)}` as MessageId;
  return {
    id: messageId,
    sessionId,
    role,
    parts: parts.map((part, index) => ({
      id: `part_${index}` as PartId,
      messageId,
      sessionId,
      ...part,
    })) as Message["parts"],
    createdAt,
  };
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseFetch(events: string[], extraHeaders: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(streamText(events.join("")), {
      status: 200,
      headers: { "content-type": "text/event-stream", ...extraHeaders },
    })) as unknown as typeof fetch;
}

function jsonFetch(data: unknown, extraHeaders: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json", ...extraHeaders },
    })) as unknown as typeof fetch;
}

function streamText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}
