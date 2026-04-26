import { expect, test } from "bun:test";
import type { ChiliEvent, MessageId, PartId, SessionId, ThreadId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { createRuntimeView, pendingApprovals, reduceRuntimeEvents, sessionMessages } from "./projection.js";

test("replays session, message, tool, and approval events into a runtime view", () => {
  const sessionId = "session_test" as SessionId;
  const threadId = "thread_test" as ThreadId;
  const turnId = "turn_test" as TurnId;
  const messageId = "msg_test" as MessageId;
  const partId = "part_test" as PartId;
  const callId = "toolcall_test" as ToolCallId;

  const events: ChiliEvent[] = [
    {
      id: "event_1",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      threadId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_2",
      type: "message.created",
      time: 2 as TimestampMs,
      sessionId,
      threadId,
      payload: { messageId, role: "assistant" },
    },
    {
      id: "event_3",
      type: "message.part_added",
      time: 3 as TimestampMs,
      sessionId,
      threadId,
      payload: {
        messageId,
        part: { id: partId, messageId, sessionId, type: "text", text: "hello" },
      },
    },
    {
      id: "event_4",
      type: "message.part_delta",
      time: 4 as TimestampMs,
      sessionId,
      threadId,
      payload: { messageId, partId, field: "text", delta: " world" },
    },
    {
      id: "event_5",
      type: "tool.call_started",
      time: 5 as TimestampMs,
      sessionId,
      threadId,
      payload: { turnId, callId, toolName: "read", input: { filePath: "README.md" } },
    },
    {
      id: "event_6",
      type: "tool.call_updated",
      time: 6 as TimestampMs,
      sessionId,
      threadId,
      payload: { callId, status: "waiting_for_approval" },
    },
    {
      id: "event_7",
      type: "approval.requested",
      time: 7 as TimestampMs,
      sessionId,
      threadId,
      payload: { approvalId: "approval_test" as never, callId, permission: "tool.read", patterns: ["README.md"] },
    },
    {
      id: "event_8",
      type: "approval.resolved",
      time: 8 as TimestampMs,
      sessionId,
      threadId,
      payload: { approvalId: "approval_test" as never, decision: "allow_once" },
    },
    {
      id: "event_9",
      type: "tool.call_finished",
      time: 9 as TimestampMs,
      sessionId,
      threadId,
      payload: { callId, status: "completed", output: "ok" },
    },
    {
      id: "event_10",
      type: "turn.completed",
      time: 10 as TimestampMs,
      sessionId,
      threadId,
      payload: { turnId, status: "completed" },
    },
  ];

  const view = reduceRuntimeEvents(events, createRuntimeView());
  const [message] = sessionMessages(view, sessionId);

  expect(view.sessions[sessionId]?.cwd).toBe("/repo");
  expect(view.sessions[sessionId]?.status).toBe("idle");
  expect(message?.parts[0]?.type).toBe("text");
  expect(message?.parts[0]?.type === "text" ? message.parts[0].text : "").toBe("hello world");
  expect(view.toolCalls[callId]?.status).toBe("completed");
  expect(pendingApprovals(view, sessionId)).toHaveLength(0);
});
