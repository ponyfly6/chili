import { expect, test } from "bun:test";
import type {
  Message,
  MessageId,
  PartId,
  SessionId,
  TimestampMs,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import {
  AnthropicCompatibleModelRouter,
  createMiniMaxM3Router,
  MINIMAX_M3_MODEL,
} from "./anthropic-compatible-model.js";

test("MiniMax M3 router defaults to 131072 output tokens and supports image input", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ content: [], stop_reason: "stop" }), { status: 200 });
  }) as typeof fetch;
  const sessionId = "session_image" as SessionId;
  const messageId = "message_image" as MessageId;
  const router = createMiniMaxM3Router({
    apiKey: "test-key",
    baseUrl: "https://model.test",
    env: {},
    fetch: fetchImpl,
  });

  for await (const _event of router.stream({
    sessionId,
    turnId: "turn_test" as TurnId,
    messages: [{
      id: messageId,
      sessionId,
      role: "user",
      parts: [{
        id: "part_image" as PartId,
        messageId,
        sessionId,
        type: "image",
        data: "aW1hZ2U=",
        mimeType: "image/png",
      }],
      createdAt: 1 as TimestampMs,
    }],
    tools: [],
    system: [],
  })) {
    // drain stream
  }

  expect(body.model).toBe(MINIMAX_M3_MODEL);
  expect(body.max_tokens).toBe(131072);
  expect(body.thinking).toEqual({ type: "adaptive" });
  expect(body).not.toHaveProperty("service_tier");
  expect(body.messages).toEqual([{
    role: "user",
    content: [{
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
    }],
  }]);
});

test("MiniMax M3 request controls override router defaults", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ content: [], stop_reason: "stop" }), { status: 200 });
  }) as typeof fetch;
  const adaptiveFast = createMiniMaxM3Router({
    apiKey: "test-key",
    baseUrl: "https://model.test",
    env: {},
    reasoning: true,
    serviceTier: "fast",
    fetch: fetchImpl,
  });
  const disabledStandard = createMiniMaxM3Router({
    apiKey: "test-key",
    baseUrl: "https://model.test",
    env: {},
    reasoning: false,
    serviceTier: "standard",
    fetch: fetchImpl,
  });
  const baseInput = {
    sessionId: "session_controls" as SessionId,
    turnId: "turn_controls" as TurnId,
    messages: [],
    tools: [],
    system: [],
  };

  for await (const _event of adaptiveFast.stream({
    ...baseInput,
    reasoningLevel: "off",
    serviceTier: "standard",
  })) {
    // drain stream
  }
  for await (const _event of disabledStandard.stream({
    ...baseInput,
    reasoningLevel: "high",
    serviceTier: "fast",
  })) {
    // drain stream
  }

  expect(bodies[0]?.thinking).toEqual({ type: "disabled" });
  expect(bodies[0]).not.toHaveProperty("service_tier");
  expect(bodies[1]?.thinking).toEqual({ type: "adaptive" });
  expect(bodies[1]?.service_tier).toBe("priority");
});

test("MiniMax M3 env precedence matches the provider and supports MINIMAX_BASE_URL", async () => {
  const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input, init) => {
    requests.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ content: [], stop_reason: "stop" }), { status: 200 });
  }) as typeof fetch;
  const preferred = createMiniMaxM3Router({
    env: {
      MINIMAX_API_KEY: "minimax-key",
      ANTHROPIC_API_KEY: "anthropic-key",
      MINIMAX_MODEL: "minimax-model",
      ANTHROPIC_MODEL: "anthropic-model",
      MINIMAX_ANTHROPIC_BASE_URL: "https://preferred.test/anthropic",
      ANTHROPIC_BASE_URL: "https://anthropic.test/anthropic",
      MINIMAX_BASE_URL: "https://fallback.test/v1",
    },
    fetch: fetchImpl,
  });
  const genericBaseUrl = createMiniMaxM3Router({
    env: {
      MINIMAX_API_KEY: "fallback-key",
      MINIMAX_BASE_URL: "https://fallback-only.test/v1",
    },
    fetch: fetchImpl,
  });
  const baseInput = {
    sessionId: "session_env" as SessionId,
    turnId: "turn_env" as TurnId,
    messages: [],
    tools: [],
    system: [],
  };

  for await (const _event of preferred.stream(baseInput)) {
    // drain stream
  }
  for await (const _event of genericBaseUrl.stream(baseInput)) {
    // drain stream
  }

  expect(requests[0]).toMatchObject({
    url: "https://preferred.test/anthropic/v1/messages",
    headers: { authorization: "Bearer minimax-key" },
    body: { model: "minimax-model" },
  });
  expect(requests[1]).toMatchObject({
    url: "https://fallback-only.test/v1/messages",
    headers: { authorization: "Bearer fallback-key" },
    body: { model: MINIMAX_M3_MODEL },
  });
});

test("passes AbortSignal through to the provider fetch", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | null | undefined;
  const fetchImpl = (async (_url, init) => {
    signal = init?.signal;
    return new Response(JSON.stringify({ content: [], stop_reason: "stop" }), { status: 200 });
  }) as typeof fetch;

  const router = new AnthropicCompatibleModelRouter({
    model: "test-model",
    apiKey: "test-key",
    baseUrl: "https://model.test",
    fetch: fetchImpl,
  });

  const events = [];
  for await (const event of router.stream({
    sessionId: "session_test" as SessionId,
    turnId: "turn_test" as TurnId,
    messages: [],
    tools: [],
    system: [],
    signal: controller.signal,
  })) {
    events.push(event);
  }

  expect(signal).toBe(controller.signal);
  expect(events).toEqual([{ type: "finish", reason: "stop" }]);
});

test("fixed Anthropic-compatible router ignores cross-provider model selections", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ content: [], stop_reason: "stop" }), { status: 200 });
  }) as typeof fetch;

  const router = new AnthropicCompatibleModelRouter({
    model: MINIMAX_M3_MODEL,
    apiKey: "test-key",
    baseUrl: "https://model.test",
    fetch: fetchImpl,
  });

  for await (const _event of router.stream({
    sessionId: "session_test" as SessionId,
    turnId: "turn_test" as TurnId,
    messages: [],
    tools: [],
    system: [],
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
  })) {
    // drain stream
  }

  expect(body.model).toBe(MINIMAX_M3_MODEL);
});

test("Anthropic-compatible router sends controlled tool execution context", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ content: [], stop_reason: "stop" }), { status: 200 });
  }) as typeof fetch;
  const sessionId = "session_tool_context" as SessionId;
  const callId = "call_sandboxed" as ToolCallId;
  const assistantMessageId = "message_assistant" as MessageId;
  const resultMessageId = "message_result" as MessageId;
  const messages: Message[] = [
    {
      id: assistantMessageId,
      sessionId,
      role: "assistant",
      parts: [{
        id: "part_call" as PartId,
        messageId: assistantMessageId,
        sessionId,
        type: "tool_call",
        callId,
        toolName: "bash",
        input: {},
        status: "completed",
      }],
      createdAt: 1 as TimestampMs,
    },
    {
      id: resultMessageId,
      sessionId,
      role: "user",
      parts: [{
        id: "part_result" as PartId,
        messageId: resultMessageId,
        sessionId,
        type: "tool_result",
        callId,
        output: "command failed",
        executionContext: {
          sandbox: "macos-seatbelt",
          executionMode: "sandboxed",
          exitCode: 1,
        },
      }],
      createdAt: 1 as TimestampMs,
    },
  ];
  const router = new AnthropicCompatibleModelRouter({
    model: MINIMAX_M3_MODEL,
    apiKey: "test-key",
    baseUrl: "https://model.test",
    fetch: fetchImpl,
  });

  for await (const _event of router.stream({
    sessionId,
    turnId: "turn_test" as TurnId,
    messages,
    tools: [],
    system: [],
  })) {
    // drain stream
  }

  expect(body.messages).toEqual([
    {
      role: "assistant",
      content: [{ type: "tool_use", id: callId, name: "bash", input: {} }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: callId,
        content: [
          "command failed",
          "",
          "[tool execution context]",
          "sandbox: macos-seatbelt",
          "execution_mode: sandboxed",
          "exit_code: 1",
        ].join("\n"),
      }],
    },
  ]);
});

test("legacy Anthropic-compatible router parses successful responses larger than 64 KiB", async () => {
  const text = `large-success-${"x".repeat(72 * 1024)}`;
  const router = legacyRouter(() => new Response(JSON.stringify({
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
  }), { status: 200 }));

  expect(await collectLegacy(router, "large_success")).toEqual([
    { type: "text_delta", text },
    { type: "finish", reason: "end_turn" },
  ]);
});

test("legacy Anthropic-compatible router bounds opaque HTTP error bodies", async () => {
  let cancelled = false;
  const chunk = new TextEncoder().encode(`private-upstream 10.20.30.40 ${"x".repeat(16 * 1024)}`);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const router = legacyRouter(() => new Response(body, { status: 502, headers: { "content-type": "text/html" } }));

  const error = await captureLegacyError(router, "bounded_error");

  expect(error).toMatchObject({ status: 502, message: "Model request failed with HTTP 502 Bad Gateway" });
  expect(error.message).not.toContain("private-upstream");
  expect(error.message).not.toContain("10.20.30.40");
  expect(cancelled).toBe(true);
});

test("legacy Anthropic-compatible router sanitizes structured errors in 2xx envelopes", async () => {
  const router = legacyRouter(() => new Response(JSON.stringify({
    error: {
      message: "Authentication failed for Bearer bearer-secret-123, api_key=secret-key-456, and API key is SUPERSECRET12345 at 10.20.30.40 / 2001:db8::1234",
      code: "invalid_api_key",
      type: "authentication_error",
      param: "token",
      request_id: "req_2xx_error",
      internal_debug: "must-never-appear",
    },
  }), { status: 200 }));

  const error = await captureLegacyError(router, "payload_error");

  expect(error).toMatchObject({
    status: 200,
    code: "invalid_api_key",
    type: "authentication_error",
    param: "token",
    requestId: "req_2xx_error",
  });
  expect(error.message).toContain("Authentication failed");
  expect(error.message).not.toContain("bearer-secret-123");
  expect(error.message).not.toContain("secret-key-456");
  expect(error.message).not.toContain("SUPERSECRET12345");
  expect(error.message).not.toContain("10.20.30.40");
  expect(error.message).not.toContain("2001:db8::1234");
  expect(error.message).not.toContain("must-never-appear");
  expect(new TextEncoder().encode(error.message).byteLength).toBeLessThanOrEqual(1024);
});

test("legacy Anthropic-compatible router does not echo invalid successful responses", async () => {
  const router = legacyRouter(() => new Response("private-invalid-success <html>failure</html>", { status: 200 }));

  const error = await captureLegacyError(router, "invalid_success");

  expect(error.message).toBe("Model response was not valid JSON");
  expect(error.message).not.toContain("private-invalid-success");
});

type LegacyProviderError = Error & {
  status?: number;
  code?: string;
  type?: string;
  param?: string;
  requestId?: string;
};

function legacyRouter(response: () => Response): AnthropicCompatibleModelRouter {
  return new AnthropicCompatibleModelRouter({
    model: "test-model",
    apiKey: "test-key",
    baseUrl: "https://model.test",
    fetch: (async () => response()) as unknown as typeof fetch,
  });
}

async function collectLegacy(router: AnthropicCompatibleModelRouter, id: string) {
  const events = [];
  for await (const event of router.stream({
    sessionId: `session_${id}` as SessionId,
    turnId: `turn_${id}` as TurnId,
    messages: [],
    tools: [],
    system: [],
  })) {
    events.push(event);
  }
  return events;
}

async function captureLegacyError(router: AnthropicCompatibleModelRouter, id: string): Promise<LegacyProviderError> {
  try {
    await collectLegacy(router, id);
  } catch (error) {
    return error as LegacyProviderError;
  }
  throw new Error("Expected router stream to fail");
}
