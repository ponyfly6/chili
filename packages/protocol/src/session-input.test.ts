import { expect, test } from "bun:test";
import { parseChiliEvent, parseRuntimeSessionInput } from "./runtime-validation.js";

const input = {
  inputId: "input_1",
  submissionId: "submission_1",
  sessionId: "session_1",
  mode: "queue",
  state: "settled",
  revision: 2,
  sequence: 1,
  text: "Review the patch",
  acceptedAt: 1,
  updatedAt: 2,
  messageId: "message_prompt",
  turnId: "turn_initial",
  outcome: "completed",
};

test("session inputs retain a result message separately from the admitted prompt", () => {
  expect<unknown>(parseRuntimeSessionInput(input)).toEqual(input);
  const completed = { ...input, resultMessageId: "message_final" };
  expect<unknown>(parseRuntimeSessionInput(completed)).toEqual(completed);
  const event = {
    id: "event_queue",
    type: "session.input_queue_changed",
    sessionId: input.sessionId,
    time: 2,
    payload: {
      sessionId: input.sessionId,
      paused: false,
      revision: 2,
      pendingCount: 0,
      interruptedCount: 0,
      items: [completed],
    },
  };
  expect<unknown>(parseChiliEvent(event)).toEqual(event);
});

test("result message identifiers reject malformed persisted pointers", () => {
  for (const resultMessageId of [null, 7, {}, "", "message\nother", "x".repeat(513)]) {
    expect(() => parseRuntimeSessionInput({ ...input, resultMessageId })).toThrow("resultMessageId");
  }
});
