import { expect, test } from "bun:test";
import type { ApprovalId, ChiliEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { applyRuntimeEvent, chatSessionView, reduceRuntimeEvents } from "./projection.js";
import { retainReplayableRuntimeEvents } from "./replay-window.js";

const sessionId = "session_nested" as SessionId;
const turnId = "turn_nested" as TurnId;
const parentCallId = "call_script" as ToolCallId;
const callId = "call_nested_read" as ToolCallId;

function started(id: ToolCallId, parent?: ToolCallId): ChiliEvent {
  return {
    id: `start_${id}`, type: "tool.call_started", sessionId, time: (parent ? 2 : 1) as TimestampMs,
    payload: { turnId, callId: id, toolName: parent ? "read" : "code_mode", input: {}, ...(parent ? { parentCallId: parent } : {}) },
  };
}

test("projects nested provenance and independent approvals without fabricating model messages", () => {
  const events: ChiliEvent[] = [started(parentCallId), started(callId, parentCallId), {
    id: "approval_nested", type: "approval.requested", sessionId, time: 3 as TimestampMs,
    payload: { approvalId: "approval_read" as ApprovalId, callId, permission: "read", patterns: ["README.md"] },
  }];
  const view = reduceRuntimeEvents(events);
  expect(view.toolCalls[callId]?.parentCallId).toBe(parentCallId);
  const chat = chatSessionView(view, { sessionId });
  expect(chat.items.find((item) => item.id === callId)).toMatchObject({
    kind: "tool", parentCallId, status: "waiting_for_approval", approvalId: "approval_read",
  });
  expect(chat.items.find((item) => item.id === parentCallId)).toMatchObject({ kind: "tool", status: "running" });
  expect(Object.values(view.messages)).toEqual([]);
  applyRuntimeEvent(view, {
    id: "nested_cancelled", type: "tool.call_finished", sessionId, time: 4 as TimestampMs,
    payload: { callId, status: "cancelled", error: "Script cancelled" },
  });
  expect(view.toolCalls[callId]).toMatchObject({ parentCallId, status: "cancelled" });
});

test("bounded replay retains the parent and its terminal state with a nested result", () => {
  const childFinished: ChiliEvent = {
    id: "child_finished", type: "tool.call_finished", sessionId, time: 3 as TimestampMs,
    payload: { callId, status: "completed", output: "child result" },
  };
  const parentFinished: ChiliEvent = {
    id: "parent_finished", type: "tool.call_finished", sessionId, time: 4 as TimestampMs,
    payload: { callId: parentCallId, status: "completed", output: "script result" },
  };
  const retained = retainReplayableRuntimeEvents([
    started(parentCallId), started(callId, parentCallId), childFinished, parentFinished,
    ...Array.from({ length: 20 }, (_, index): ChiliEvent => ({
      id: `noise_${index}`, type: "session.status_changed", sessionId, time: (index + 5) as TimestampMs,
      payload: { sessionId, status: "idle" },
    })),
  ], { maxEvents: 4, maxBytes: 10_000, pinnedEventIds: [childFinished.id] });
  expect(retained.events.map((event) => event.id)).toEqual([
    `start_${parentCallId}`, `start_${callId}`, childFinished.id, parentFinished.id,
  ]);
  const view = reduceRuntimeEvents(retained.events);
  expect(view.toolCalls[callId]).toMatchObject({ parentCallId, status: "completed" });
  expect(view.toolCalls[parentCallId]?.status).toBe("completed");
});

test("bounded replay drops nested calls whose parent anchor is unavailable", () => {
  const retained = retainReplayableRuntimeEvents([started(callId, parentCallId)], { maxEvents: 10, maxBytes: 10_000 });
  expect(retained.events).toEqual([]);
  expect(retained.missingDependencies).toHaveLength(1);
});
