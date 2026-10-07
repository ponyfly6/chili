import { expect, test } from "bun:test";
import { conversationActivity, pendingConversationInputs } from "./conversation-activity.js";
import type { RuntimeInputQueue } from "@chili/protocol";

test("stopping cannot resume or stop again, and paused inputs remain queued", () => {
  const stopping = conversationActivity({ status: "cancelling", paused: true, pendingQuestions: 0, readOnly: false });
  expect(stopping.kind).toBe("stopping");
  expect(stopping.canStop).toBe(false);
  expect(stopping.queueInput).toBe(true);
  const paused = conversationActivity({ status: "cancelled", paused: true, pendingQuestions: 0, readOnly: false });
  expect(paused.kind).toBe("paused");
  expect(paused.queueInput).toBe(true);
  expect(conversationActivity({ status: "cancelled", paused: false, pendingQuestions: 0, readOnly: false }).kind).toBe("idle");
});

test("requests for information outrank running, and automatic review stays distinct", () => {
  expect(conversationActivity({ status: "running", paused: false, pendingQuestions: 1, readOnly: false }).kind).toBe("question");
  const reviewing = conversationActivity({ status: "waiting_for_approval", paused: true, pendingQuestions: 0, readOnly: false });
  expect(reviewing.kind).toBe("reviewing");
  expect(reviewing.canStop).toBe(true);
  expect(conversationActivity({ status: "running", paused: false, pendingQuestions: 1, readOnly: true }).canStop).toBe(false);
});

test("only pending inputs appear in sequence order, without mutating the runtime queue", () => {
  const queue = { items: [
    { inputId: "late", state: "pending", sequence: 3 },
    { inputId: "current", state: "claimed", sequence: 1 },
    { inputId: "early", state: "pending", sequence: 2 },
    { inputId: "interrupted", state: "settled", outcome: "interrupted", sequence: 0 },
  ] } as RuntimeInputQueue;
  expect(pendingConversationInputs(queue).map((input) => input.inputId)).toEqual(["early", "late"]);
  expect(queue.items[0]?.inputId).toBe("late");
  expect(pendingConversationInputs(undefined)).toEqual([]);
});
