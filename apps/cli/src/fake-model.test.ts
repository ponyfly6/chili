import { expect, test } from "bun:test";
import type { ModelStreamEvent, ModelStreamInput } from "@chili/core";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { FakeModelRouter } from "./fake-model.js";

const sessionId = "session_fake_model" as SessionId;

test("desktop input fixture emits one deterministic single-select request", async () => {
  const events = await streamEvents("desktop input fixture");

  expect(events).toEqual([
    {
      type: "tool_call",
      name: "request_user_input",
      input: {
        questions: [
          {
            id: "desktop_fixture",
            header: "Desktop QA",
            question: "Choose a response for the desktop input fixture.",
            options: [
              { label: "Continue", description: "Resolve the fixture with the primary choice." },
              { label: "Alternate", description: "Resolve the fixture with the alternate choice." },
            ],
          },
        ],
      },
    },
    { type: "finish", reason: "tool_use" },
  ]);
});

test("desktop approval fixture emits one harmless once-only escalated bash request", async () => {
  const events = await streamEvents("desktop approval fixture");

  expect(events).toEqual([
    {
      type: "tool_call",
      name: "bash",
      input: {
        command: "/usr/bin/true",
        sandbox_permissions: "require_escalated",
        justification: "Allow the harmless desktop approval fixture to run once.",
      },
    },
    { type: "finish", reason: "tool_use" },
  ]);
});

test("desktop fixtures use the existing generic completion after a tool result", async () => {
  for (const text of ["desktop input fixture", "desktop approval fixture"]) {
    const events = await streamEvents(text, true);
    expect(events).toEqual([
      { type: "text_delta", text: "I read the file and the tool loop works." },
      { type: "finish", reason: "stop" },
    ]);
  }
});

test("ordinary fake-model prompts still echo unchanged", async () => {
  const events = await streamEvents("ordinary desktop prompt");

  expect(events).toEqual([
    { type: "text_delta", text: "Echo: ordinary desktop prompt" },
    { type: "finish", reason: "stop" },
  ]);
});

async function streamEvents(text: string, includeToolResult = false): Promise<ModelStreamEvent[]> {
  const router = new FakeModelRouter();
  const events: ModelStreamEvent[] = [];
  for await (const event of router.stream(input(text, includeToolResult))) events.push(event);
  return events;
}

function input(text: string, includeToolResult: boolean): ModelStreamInput {
  const userMessageId = "message_fake_user" as MessageId;
  const messages: Message[] = [
    {
      id: userMessageId,
      sessionId,
      role: "user",
      createdAt: 1 as TimestampMs,
      parts: [
        {
          id: "part_fake_user" as PartId,
          messageId: userMessageId,
          sessionId,
          type: "text",
          text,
        },
      ],
    },
  ];

  if (includeToolResult) {
    const toolMessageId = "message_fake_tool" as MessageId;
    messages.push({
      id: toolMessageId,
      sessionId,
      role: "tool",
      createdAt: 2 as TimestampMs,
      parts: [
        {
          id: "part_fake_tool" as PartId,
          messageId: toolMessageId,
          sessionId,
          type: "tool_result",
          callId: "toolcall_fake" as ToolCallId,
          output: "fixture resolved",
        },
      ],
    });
  }

  return {
    sessionId,
    turnId: "turn_fake_model" as TurnId,
    messages,
    tools: [],
    system: [],
  };
}
