import { expect, test } from "bun:test";
import type {
  Message,
  MessageId,
  PartId,
  SessionId,
  ThreadId,
  TimestampMs,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import { AnthropicCompatibleModelRouter } from "./anthropic-compatible-model.js";

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
    threadId: "thread_test" as ThreadId,
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
    model: "MiniMax-M2.7-highspeed",
    apiKey: "test-key",
    baseUrl: "https://model.test",
    fetch: fetchImpl,
  });

  for await (const _event of router.stream({
    sessionId: "session_test" as SessionId,
    threadId: "thread_test" as ThreadId,
    turnId: "turn_test" as TurnId,
    messages: [],
    tools: [],
    system: [],
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
  })) {
    // drain stream
  }

  expect(body.model).toBe("MiniMax-M2.7-highspeed");
});

test("legacy Anthropic-compatible router sends controlled tool execution context", async () => {
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
    model: "MiniMax-M2.7-highspeed",
    apiKey: "test-key",
    baseUrl: "https://model.test",
    fetch: fetchImpl,
  });

  for await (const _event of router.stream({
    sessionId,
    threadId: "thread_test" as ThreadId,
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
