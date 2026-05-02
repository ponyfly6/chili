import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import {
  AnthropicCompatibleModel,
  buildAnthropicRequestBody,
  createMiniMaxM27HighspeedModel,
  MINIMAX_ANTHROPIC_BASE_URL,
  MINIMAX_M27_HIGHSPEED_MODEL,
  normalizeAnthropicToolCallId,
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

  const model = createMiniMaxM27HighspeedModel({
    apiKey: "test-key",
    baseUrl: MINIMAX_ANTHROPIC_BASE_URL,
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
  expect(signal).toBe(controller.signal);
  expect(body?.model).toBe(MINIMAX_M27_HIGHSPEED_MODEL);
  expect(body?.max_tokens).toBe(64);
  expect(body?.stream).toBe(true);
  expect(events.at(-1)).toEqual({ type: "finish", reason: "end_turn", responseId: "msg_json" });
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

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const streamEvent of stream) events.push(streamEvent);
  return events;
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

function sseFetch(events: string[]): typeof fetch {
  return (async () =>
    new Response(streamText(events.join("")), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
}

function jsonFetch(data: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
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
