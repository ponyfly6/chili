import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import { normalizeAnthropicToolCallId, transformModelMessages } from "./index.js";

const sessionId = "session_transform" as SessionId;
const createdAt = 1 as TimestampMs;

test("normalizes tool call ids and maps matching tool results", () => {
  const originalCallId = "response|tool call with spaces and punctuation!" as ToolCallId;
  const normalizedCallId = normalizeAnthropicToolCallId(originalCallId);
  const messages = [
    message("assistant", [
      { type: "tool_call", callId: originalCallId, toolName: "bash", input: { cmd: "pwd" }, status: "pending" },
    ]),
    message("user", [{ type: "tool_result", callId: originalCallId, output: "/tmp" }]),
  ];

  const transformed = transformModelMessages(messages, {
    normalizeToolCallId: normalizeAnthropicToolCallId,
    now: () => 2,
  });

  expect(normalizedCallId).not.toBe(originalCallId);
  expect(normalizedCallId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  expect(transformed[0]?.parts[0]).toMatchObject({ type: "tool_call", callId: normalizedCallId });
  expect(transformed[1]?.parts[0]).toMatchObject({ type: "tool_result", callId: normalizedCallId });
});

test("inserts synthetic tool results before user text interrupts a pending tool call", () => {
  const callId = "toolu_missing" as ToolCallId;
  const messages = [
    message("assistant", [
      { type: "tool_call", callId, toolName: "read_file", input: { path: "README.md" }, status: "pending" },
    ]),
    message("user", [{ type: "text", text: "Actually, do something else." }]),
  ];

  const transformed = transformModelMessages(messages, { now: () => 123 });

  expect(transformed.map((item) => item.role)).toEqual(["assistant", "user", "user"]);
  expect(transformed[1]).toMatchObject({
    role: "user",
    createdAt: 123,
    parts: [
      {
        type: "tool_result",
        callId,
        output: "No result provided",
        error: "No result provided",
        synthetic: true,
      },
    ],
  });
});

test("does not synthesize tool results when a following result satisfies the call", () => {
  const callId = "toolu_done" as ToolCallId;
  const messages = [
    message("assistant", [
      { type: "tool_call", callId, toolName: "read_file", input: { path: "README.md" }, status: "pending" },
    ]),
    message("user", [{ type: "tool_result", callId, output: "contents" }]),
  ];

  const transformed = transformModelMessages(messages, { now: () => 123 });

  expect(transformed).toHaveLength(2);
  expect(transformed[1]?.parts[0]).toMatchObject({ type: "tool_result" });
  expect("synthetic" in (transformed[1]?.parts[0] ?? {})).toBe(false);
});

test("hoists assistant-attached tool results before missing-result synthesis", () => {
  const callId = "toolu_attached" as ToolCallId;
  const messages = [
    message("assistant", [
      { type: "tool_call", callId, toolName: "read_file", input: { path: "README.md" }, status: "pending" },
      { type: "tool_result", callId, output: "contents" },
    ]),
    message("assistant", [{ type: "text", text: "I read it." }]),
  ];

  const transformed = transformModelMessages(messages, { now: () => 123 });

  expect(transformed.map((item) => item.role)).toEqual(["assistant", "user", "assistant"]);
  expect(transformed[0]?.parts).toEqual([expect.objectContaining({ type: "tool_call", callId })]);
  expect(transformed[1]?.parts).toEqual([expect.objectContaining({ type: "tool_result", callId, output: "contents" })]);
  expect(transformed[1]?.parts[0]).toMatchObject({ messageId: transformed[1]?.id });
  expect(JSON.stringify(transformed)).not.toContain("No result provided");
});

test("drops redacted reasoning blocks before provider replay", () => {
  const messages = [
    message("assistant", [
      { type: "reasoning", text: "opaque", redacted: true },
      { type: "reasoning", text: "plain reasoning" },
      { type: "text", text: "answer" },
    ]),
  ];

  const transformed = transformModelMessages(messages);

  expect(transformed[0]?.parts).toEqual([
    expect.objectContaining({ type: "reasoning", text: "plain reasoning" }),
    expect.objectContaining({ type: "text", text: "answer" }),
  ]);
});

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
