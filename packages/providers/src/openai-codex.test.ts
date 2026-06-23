import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import {
  buildOpenAICodexResponsesRequestBody,
  clampOpenAICodexReasoningEffort,
  exchangeOpenAICodexAuthorizationCode,
  OpenAICodexResponsesModel,
  refreshOpenAICodexToken,
  resolveOpenAICodexStreamRequestOptions,
  resolveOpenAICodexResponsesUrl,
} from "./index.js";
import type { ModelStreamEvent, ModelTool } from "./types.js";

const sessionId = "session_codex" as SessionId;
const createdAt = 1 as TimestampMs;

test("converts Chili messages and tools into a Codex Responses body", () => {
  const callId = "call_weather" as ToolCallId;
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

  const body = buildOpenAICodexResponsesRequestBody(
    {
      messages: [
        message("system", [{ type: "text", text: "stored system" }]),
        message("user", [{ type: "text", text: "hello" }]),
        message("assistant", [
          { type: "text", text: "I will check." },
          { type: "tool_call", callId, toolName: "weather", input: { city: "Shanghai" }, status: "pending" },
        ]),
        message("user", [{ type: "tool_result", callId, output: "sunny" }]),
      ],
      tools,
      system: ["runtime system"],
      metadata: { sessionId: "session_codex" },
    },
    {
      model: "gpt-5.5",
      maxTokens: 123,
      sessionId: "session_codex",
      reasoningEffort: "minimal",
    },
  );

  expect(body).toMatchObject({
    model: "gpt-5.5",
    store: false,
    stream: true,
    instructions: "runtime system\n\nstored system",
    prompt_cache_key: "session_codex",
    max_output_tokens: 123,
    text: { verbosity: "medium" },
    reasoning: { effort: "low", summary: "auto" },
    input: [
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { role: "assistant", content: [{ type: "output_text", text: "I will check." }] },
      { type: "function_call", call_id: callId, name: "weather", arguments: "{\"city\":\"Shanghai\"}" },
      { type: "function_call_output", call_id: callId, output: "sunny" },
    ],
    tools: [
      {
        type: "function",
        name: "weather",
        description: "Read weather.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
        strict: null,
      },
    ],
  });
});

test("adds developer fragments to instructions and contextual fragments to input", () => {
  const body = buildOpenAICodexResponsesRequestBody(
    {
      messages: [message("user", [{ type: "text", text: "hello" }])],
      tools: [],
      system: ["base instructions"],
      developer: ["skills catalog"],
      contextualUser: ["memory context"],
    },
    {
      model: "gpt-5.5",
    },
  );

  expect(body).toMatchObject({
    instructions: "base instructions\n\nskills catalog",
    input: [
      { role: "user", content: [{ type: "input_text", text: "memory context" }] },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ],
  });
});

test("sets Codex service tier only for fast mode", () => {
  const fastBody = buildOpenAICodexResponsesRequestBody(
    {
      messages: [message("user", [{ type: "text", text: "hello" }])],
      tools: [],
      system: [],
    },
    {
      model: "gpt-5.5",
      serviceTier: "fast",
    },
  );
  expect(fastBody.service_tier).toBe("priority");

  const standardBody = buildOpenAICodexResponsesRequestBody(
    {
      messages: [message("user", [{ type: "text", text: "hello" }])],
      tools: [],
      system: [],
    },
    {
      model: "gpt-5.5",
      serviceTier: "standard",
    },
  );
  expect(standardBody).not.toHaveProperty("service_tier");
});

test("adds image tool results as Codex input images", () => {
  const callId = "call_image" as ToolCallId;
  const body = buildOpenAICodexResponsesRequestBody(
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
            content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          },
        ]),
      ],
      tools: [],
      system: [],
    },
    {
      model: "gpt-5.5",
    },
  );

  expect(body.input).toContainEqual({
    type: "function_call_output",
    call_id: callId,
    output: "Image read: pixel.png",
  });
  expect(body.input).toContainEqual({
    role: "user",
    content: [
      { type: "input_text", text: `Image returned by tool call ${callId}.` },
      { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
    ],
  });
});

test("adds pasted user images as Codex input images", () => {
  const body = buildOpenAICodexResponsesRequestBody(
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
      model: "gpt-5.5",
    },
  );

  expect(body.input).toEqual([
    {
      role: "user",
      content: [
        { type: "input_text", text: "What is in this image? [Image #1]" },
        { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
      ],
    },
  ]);
});

test("omits image tool result blocks for text-only Codex request bodies", () => {
  const callId = "call_image" as ToolCallId;
  const body = buildOpenAICodexResponsesRequestBody(
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
            content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          },
        ]),
      ],
      tools: [],
      system: [],
    },
    {
      model: "gpt-5.3-codex-spark",
      inputCapabilities: ["text"],
    },
  );

  expect(body.input).toContainEqual({
    type: "function_call_output",
    call_id: callId,
    output: "Image read: pixel.png",
  });
  expect(JSON.stringify(body.input)).not.toContain("input_image");
});

test("resolves Codex Responses URL variants", () => {
  expect(resolveOpenAICodexResponsesUrl()).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(resolveOpenAICodexResponsesUrl("https://chatgpt.com/backend-api")).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(resolveOpenAICodexResponsesUrl("https://chatgpt.com/backend-api/codex")).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(resolveOpenAICodexResponsesUrl("https://chatgpt.com/backend-api/codex/responses")).toBe(
    "https://chatgpt.com/backend-api/codex/responses",
  );
  expect(resolveOpenAICodexResponsesUrl("https://api.codexapi.space/v1")).toBe(
    "https://api.codexapi.space/v1/responses",
  );
  expect(resolveOpenAICodexResponsesUrl("https://api.codexapi.space/v1/responses")).toBe(
    "https://api.codexapi.space/v1/responses",
  );
});

test("resolves per-stream Codex model and reasoning request options", () => {
  expect(
    resolveOpenAICodexStreamRequestOptions(
      {
        messages: [],
        model: "openai-codex/gpt-5.1:xhigh",
        reasoning: "low",
        metadata: { sessionId: "session_2" },
      },
      { model: "gpt-5.5", reasoningEffort: "medium" },
    ),
  ).toMatchObject({
    model: "gpt-5.1",
    reasoningEffort: "low",
    sessionId: "session_2",
  });

  expect(
    resolveOpenAICodexStreamRequestOptions(
      {
        messages: [],
        model: "openai-codex/gpt-5.1:xhigh",
      },
      { model: "gpt-5.5", reasoningEffort: "medium" },
    ),
  ).toMatchObject({
    model: "gpt-5.1",
    reasoningEffort: "xhigh",
  });
});

test("clamps and omits Codex reasoning levels for the request body", () => {
  expect(clampOpenAICodexReasoningEffort("gpt-5.1", "xhigh")).toBe("high");
  expect(clampOpenAICodexReasoningEffort("gpt-5.5", "minimal")).toBe("low");

  const body = buildOpenAICodexResponsesRequestBody(
    { messages: [] },
    {
      model: "gpt-5.5",
      reasoningEffort: "off",
    },
  );

  expect(body).not.toHaveProperty("reasoning");
});

test("accepts OpenAI Codex token exchange fields from id_token", async () => {
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 7200;
  const idToken = jwtWithPayload({
    exp: expiresAtSeconds,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_from_id" },
  });
  const accessToken = jwtWithPayload({ sub: "access_without_account_claim" });
  let body = new URLSearchParams();
  const fetchImpl = (async (_input, init) => {
    body = new URLSearchParams(String(init?.body));
    return new Response(JSON.stringify({
      id_token: idToken,
      access_token: accessToken,
      refresh_token: "refresh_1",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const result = await exchangeOpenAICodexAuthorizationCode("code_1", "verifier_1", fetchImpl);

  expect(body.get("grant_type")).toBe("authorization_code");
  expect(body.get("code")).toBe("code_1");
  expect(body.get("code_verifier")).toBe("verifier_1");
  expect(result.type).toBe("success");
  if (result.type !== "success") throw new Error("expected token exchange to succeed");
  expect(result.credentials).toEqual({
    access: accessToken,
    refresh: "refresh_1",
    expires: expiresAtSeconds * 1000,
    accountId: "acct_from_id",
  });
});

test("refresh preserves existing token fields when Codex omits optional fields", async () => {
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600;
  const accessToken = jwtWithPayload({ exp: expiresAtSeconds, sub: "new_access" });
  let headers = new Headers();
  let body: unknown;
  const fetchImpl = (async (_input, init) => {
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as unknown;
    return new Response(JSON.stringify({ access_token: accessToken }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const credentials = await refreshOpenAICodexToken("refresh_old", {
    fetch: fetchImpl,
    previous: {
      access: "old_access",
      refresh: "refresh_old",
      expires: Date.now() - 1000,
      accountId: "acct_existing",
    },
  });

  expect(headers.get("content-type")).toBe("application/json");
  expect(body).toMatchObject({
    grant_type: "refresh_token",
    refresh_token: "refresh_old",
  });
  expect(credentials).toEqual({
    access: accessToken,
    refresh: "refresh_old",
    expires: expiresAtSeconds * 1000,
    accountId: "acct_existing",
  });
});

test("sends ChatGPT Codex headers and parses Responses SSE events", async () => {
  const token = jwtWithAccount("acct_test");
  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(streamText([
      data({ type: "response.created", response: { id: "resp_1", model: "gpt-test" } }),
      data({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } }),
      data({ type: "response.output_text.delta", output_index: 0, delta: "hello" }),
      data({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
      }),
      data({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"q\"" }),
      data({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{\"q\":\"chili\"}" }),
      data({
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"chili\"}" },
      }),
      data({
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "gpt-test",
          status: "completed",
          usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12, input_tokens_details: { cached_tokens: 2 } },
        },
      }),
    ].join("")), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const model = new OpenAICodexResponsesModel({
    model: "gpt-test",
    reasoningEffort: "medium",
    apiKey: token,
    fetch: fetchImpl,
  });
  const events = await collect(
    model.stream({
      messages: [],
      model: "openai-codex/gpt-dynamic:high",
      tools: [],
      system: [],
      metadata: { sessionId: "session_1" },
    }),
  );

  expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(headers.get("chatgpt-account-id")).toBe("acct_test");
  expect(headers.get("originator")).toBe("chili");
  expect(headers.get("openai-beta")).toBe("responses=experimental");
  expect(headers.get("session_id")).toBe("session_1");
  expect(body).toMatchObject({
    model: "gpt-dynamic",
    prompt_cache_key: "session_1",
    reasoning: { effort: "high", summary: "auto" },
  });
  expect(events.map((event) => event.type)).toEqual([
    "metadata",
    "metadata",
    "text_delta",
    "tool_call_start",
    "tool_call_delta",
    "tool_call_delta",
    "tool_call_end",
    "metadata",
    "finish",
  ]);
  expect(events[2]).toEqual({ type: "text_delta", text: "hello", index: 0 });
  expect(events[6]).toEqual({
    type: "tool_call_end",
    toolCallId: "call_1",
    name: "lookup",
    input: { q: "chili" },
    index: 1,
  });
  expect(events.at(-1)).toMatchObject({
    type: "finish",
    reason: "tool_use",
    responseId: "resp_1",
    usage: { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 2, totalTokens: 12 },
  });
});

test("sends OpenAI-compatible Codex requests without ChatGPT account headers", async () => {
  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(streamText([
      data({ type: "response.created", response: { id: "resp_gateway", model: "gpt-5.5" } }),
      data({ type: "response.output_text.delta", output_index: 0, delta: "ok" }),
      data({ type: "response.completed", response: { id: "resp_gateway", model: "gpt-5.5", status: "completed" } }),
    ].join("")), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const model = new OpenAICodexResponsesModel({
    model: "gpt-5.5",
    apiKey: "codexapi-key",
    baseUrl: "https://api.codexapi.space/v1",
    reasoningEffort: "xhigh",
    serviceTier: "fast",
    fetch: fetchImpl,
  });
  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(url).toBe("https://api.codexapi.space/v1/responses");
  expect(headers.get("authorization")).toBe("Bearer codexapi-key");
  expect(headers.get("chatgpt-account-id")).toBeNull();
  expect(headers.get("openai-beta")).toBeNull();
  expect(body).toMatchObject({
    model: "gpt-5.5",
    reasoning: { effort: "xhigh", summary: "auto" },
    service_tier: "priority",
  });
  expect(events).toContainEqual({ type: "text_delta", text: "ok", index: 0 });
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
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

function streamText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function jwtWithAccount(accountId: string): string {
  return jwtWithPayload({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
}

function jwtWithPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}
