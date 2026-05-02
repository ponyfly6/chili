import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import {
  buildOpenAICompletionsRequestBody,
  OpenAICompletionsModel,
  resolveChatCompletionsUrl,
} from "./index.js";
import type { ModelStreamEvent, ModelTool } from "./types.js";

const sessionId = "session_openai" as SessionId;
const createdAt = 1 as TimestampMs;

test("converts Chili messages and tools into an OpenAI-compatible chat completions body", () => {
  const callId = "call_weather" as ToolCallId;
  const messages = [
    message("system", [{ type: "text", text: "stored system" }]),
    message("user", [{ type: "text", text: "hello" }]),
    message("assistant", [
      { type: "text", text: "I will check." },
      { type: "tool_call", callId, toolName: "weather", input: { city: "Shanghai" }, status: "pending" },
    ]),
    message("user", [{ type: "tool_result", callId, output: "sunny" }]),
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

  const body = buildOpenAICompletionsRequestBody(
    {
      messages,
      tools,
      system: ["runtime system"],
    },
    {
      provider: "openai",
      model: "gpt-test",
      baseUrl: "https://api.openai.com/v1",
      maxTokens: 123,
      temperature: 0.2,
      stream: true,
    },
  );

  expect(body).toEqual({
    model: "gpt-test",
    max_completion_tokens: 123,
    stream: true,
    store: false,
    stream_options: { include_usage: true },
    temperature: 0.2,
    messages: [
      { role: "system", content: "runtime system\n\nstored system" },
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "I will check.",
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: { name: "weather", arguments: "{\"city\":\"Shanghai\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: callId, content: "sunny" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "weather",
          description: "Read weather.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
  });
});

test("uses compatibility settings when shaping OpenAI-compatible requests", () => {
  const body = buildOpenAICompletionsRequestBody(
    {
      messages: [message("system", [{ type: "text", text: "system" }])],
      tools: [],
      system: ["runtime"],
    },
    {
      provider: "deepseek",
      model: "deepseek-reasoner",
      baseUrl: "https://api.deepseek.com",
      maxTokens: 64,
      stream: true,
      reasoning: true,
      compatibility: {
        maxTokensField: "max_tokens",
        supportsStore: false,
        supportsDeveloperRole: true,
        supportsUsageInStreaming: false,
      },
    },
  );

  expect(body).toMatchObject({
    model: "deepseek-reasoner",
    max_tokens: 64,
    stream: true,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    messages: [{ role: "developer", content: "runtime\n\nsystem" }],
  });
  expect(body).not.toHaveProperty("store");
  expect(body).not.toHaveProperty("stream_options");
  expect(body).not.toHaveProperty("max_completion_tokens");
});

test("routes developer and contextual user prompt fragments with system fallback", () => {
  const supported = buildOpenAICompletionsRequestBody(
    {
      messages: [message("user", [{ type: "text", text: "hello" }])],
      tools: [],
      system: ["base instructions"],
      developer: ["skills catalog"],
      contextualUser: ["memory context"],
    },
    {
      provider: "openai",
      model: "gpt-test",
      baseUrl: "https://api.openai.com/v1",
      stream: true,
      compatibility: { supportsDeveloperRole: true },
    },
  );

  expect(supported.messages).toEqual([
    { role: "system", content: "base instructions" },
    { role: "developer", content: "skills catalog" },
    { role: "user", content: "memory context" },
    { role: "user", content: "hello" },
  ]);

  const fallback = buildOpenAICompletionsRequestBody(
    {
      messages: [message("user", [{ type: "text", text: "hello" }])],
      tools: [],
      system: ["base instructions"],
      developer: ["skills catalog"],
      contextualUser: ["memory context"],
    },
    {
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      stream: true,
      compatibility: { supportsDeveloperRole: false, supportsStore: false, supportsUsageInStreaming: false },
    },
  );

  expect(fallback.messages).toEqual([
    { role: "system", content: "base instructions\n\nskills catalog" },
    { role: "user", content: "memory context" },
    { role: "user", content: "hello" },
  ]);
});

test("converts assistant-attached tool results into OpenAI tool messages", () => {
  const callId = "call_attached" as ToolCallId;
  const body = buildOpenAICompletionsRequestBody(
    {
      messages: [
        message("user", [{ type: "text", text: "read file" }]),
        message("assistant", [
          { type: "tool_call", callId, toolName: "read", input: { filePath: "README.md" }, status: "pending" },
          { type: "tool_result", callId, output: "contents" },
        ]),
        message("assistant", [{ type: "text", text: "contents summarized" }]),
      ],
      tools: [],
      system: [],
    },
    {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com",
      maxTokens: 64,
      stream: true,
    },
  );

  expect(body.messages).toEqual([
    { role: "user", content: "read file" },
    {
      role: "assistant",
      content: null,
      reasoning_content: "",
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: "read", arguments: "{\"filePath\":\"README.md\"}" },
        },
      ],
    },
    { role: "tool", tool_call_id: callId, content: "contents" },
    { role: "assistant", content: "contents summarized", reasoning_content: "" },
  ]);
});

test("resolves chat completions URL variants", () => {
  expect(resolveChatCompletionsUrl("https://api.test")).toBe("https://api.test/v1/chat/completions");
  expect(resolveChatCompletionsUrl("https://api.test/v1")).toBe("https://api.test/v1/chat/completions");
  expect(resolveChatCompletionsUrl("https://api.test/v1/chat/completions")).toBe(
    "https://api.test/v1/chat/completions",
  );
});

test("parses OpenAI-compatible SSE text, reasoning, tool deltas, and usage", async () => {
  const model = new OpenAICompletionsModel({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    fetch: sseFetch([
      data({
        id: "chatcmpl_1",
        model: "gpt-test",
        choices: [{ index: 0, delta: { reasoning_content: "think " } }],
      }),
      data({
        id: "chatcmpl_1",
        model: "gpt-test",
        choices: [{ index: 0, delta: { content: "hello " } }],
      }),
      data({
        id: "chatcmpl_1",
        model: "gpt-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: "{\"query\"" },
                },
              ],
            },
          },
        ],
      }),
      data({
        id: "chatcmpl_1",
        model: "gpt-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ":\"chili\"}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      data({
        id: "chatcmpl_1",
        model: "gpt-test",
        choices: [],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 4,
          total_tokens: 7,
          prompt_tokens_details: { cached_tokens: 1 },
        },
      }),
      "data: [DONE]\n\n",
    ]),
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(events.map((event) => event.type)).toEqual([
    "metadata",
    "reasoning_delta",
    "text_delta",
    "tool_call_start",
    "tool_call_delta",
    "tool_call_delta",
    "metadata",
    "tool_call_end",
    "finish",
  ]);
  expect(events[1]).toEqual({ type: "reasoning_delta", text: "think ", index: 0 });
  expect(events[2]).toEqual({ type: "text_delta", text: "hello ", index: 0 });
  expect(events[3]).toEqual({ type: "tool_call_start", toolCallId: "call_1", name: "lookup", index: 0 });
  expect(events[5]).toEqual({
    type: "tool_call_delta",
    toolCallId: "call_1",
    name: "lookup",
    delta: ":\"chili\"}",
    index: 0,
    partialInput: { query: "chili" },
  });
  expect(events.at(-2)).toEqual({
    type: "tool_call_end",
    toolCallId: "call_1",
    name: "lookup",
    input: { query: "chili" },
    index: 0,
  });
  expect(events.at(-1)).toMatchObject({
    type: "finish",
    reason: "tool_use",
    responseId: "chatcmpl_1",
    usage: { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 1, totalTokens: 7 },
  });
});

test("falls back to non-streaming OpenAI-compatible JSON responses", async () => {
  const model = new OpenAICompletionsModel({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    fetch: jsonFetch({
      id: "chatcmpl_json",
      model: "gpt-test",
      choices: [
        {
          index: 0,
          message: {
            content: "done",
            tool_calls: [
              {
                id: "call_2",
                type: "function",
                function: { name: "edit", arguments: "{\"filePath\":\"README.md\"}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    }),
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(events.map((event) => event.type)).toEqual([
    "metadata",
    "text_delta",
    "tool_call_start",
    "tool_call_end",
    "finish",
  ]);
  expect(events[0]).toMatchObject({
    type: "metadata",
    responseId: "chatcmpl_json",
    usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
  });
  expect(events[1]).toEqual({ type: "text_delta", text: "done", index: 0 });
  expect(events[3]).toEqual({
    type: "tool_call_end",
    toolCallId: "call_2",
    name: "edit",
    input: { filePath: "README.md" },
    index: 0,
  });
  expect(events[4]).toMatchObject({ type: "finish", reason: "tool_use", responseId: "chatcmpl_json" });
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

function data(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
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
