import { expect, test } from "bun:test";
import type { ChiliEvent } from "@chili/protocol";
import { DesktopNotificationGate, desktopNotificationForEvent } from "./notifications.js";

test("native approval and user-input notifications never include untrusted runtime content", () => {
  const secret = "Bearer secret-token /private/workspace do-not-leak";
  const approval = desktopNotificationForEvent(event("approval.requested", {
    approvalId: "approval_1",
    permission: secret,
    patterns: [secret],
  }));
  const input = desktopNotificationForEvent(event("user_input.requested", {
    inputId: "input_1",
    callId: "call_1",
    questions: [{ id: "answer", header: "Answer", question: secret, options: [] }],
  }));

  expect(approval).toEqual({ title: "Chili needs approval", body: "A task is waiting for your approval." });
  expect(input).toEqual({ title: "Chili needs your input", body: "A task is waiting for your answer." });
  expect(JSON.stringify([approval, input])).not.toContain(secret);
});

test("native notification gate suppresses generation replay and duplicate events", () => {
  const gate = new DesktopNotificationGate();
  const payload = {
    approvalId: "approval_1",
    permission: "bash",
    patterns: ["bun test"],
  };

  gate.observeSidecarState("healthy", 7, 1_000);
  expect(gate.notificationForEvent(event("approval.requested", payload, "old", 999), 7)).toBeUndefined();
  expect(gate.notificationForEvent(event("approval.requested", payload, "current", 1_000), 7)).toEqual({
    title: "Chili needs approval",
    body: "A task is waiting for your approval.",
  });
  expect(gate.notificationForEvent(event("approval.requested", payload, "current", 1_000), 7)).toBeUndefined();

  // Healthy state refreshes in the same generation must not move the replay
  // watermark past events that are concurrently being streamed.
  gate.observeSidecarState("healthy", 7, 2_000);
  expect(gate.notificationForEvent(event("approval.requested", payload, "later", 1_001), 7)).toBeDefined();

  gate.observeSidecarState("recovering", 7, 2_100);
  expect(gate.notificationForEvent(event("approval.requested", payload, "while-down", 2_100), 7)).toBeUndefined();
  gate.observeSidecarState("healthy", 8, 3_000);
  expect(gate.notificationForEvent(event("approval.requested", payload, "replayed", 2_999), 8)).toBeUndefined();
  expect(gate.notificationForEvent(event("approval.requested", payload, "new", 3_000), 8)).toBeDefined();
  expect(gate.notificationForEvent(event("approval.requested", payload, "wrong-generation", 3_001), 7)).toBeUndefined();
});

function event(
  type: ChiliEvent["type"],
  payload: unknown,
  id = "event_1",
  time = 1,
): ChiliEvent {
  return { id, type, time, sessionId: "session_1", payload } as ChiliEvent;
}
