import { expect, test } from "bun:test";
import { isTransientEvent } from "./event.js";
import { parseChiliEvent } from "./runtime-validation.js";

const part = { id: "part_1", messageId: "message_1", sessionId: "session_1", type: "reasoning", text: "考虑过的内容", ordinal: 0 };
const envelope = { id: "event_1", sessionId: "session_1", time: 1 };

test("completed and interrupted content retain their full text as durable records", () => {
  for (const completion of ["completed", "cancelled", "failed"] as const) {
    const event = parseChiliEvent({ ...envelope, type: "message.part_committed", payload: { messageId: part.messageId, part: { ...part, completion } } });
    expect(isTransientEvent(event)).toBe(false);
    expect(event.payload).toMatchObject({ part: { text: part.text, completion } });
  }
});

test("live content is transient and validates its identity and offset", () => {
  const event = { ...envelope, type: "message.part_stream_delta", payload: {
    messageId: part.messageId, partId: part.id, partType: "reasoning", offset: 2, ordinal: 0, delta: "内容",
  } };
  expect(isTransientEvent(parseChiliEvent(event))).toBe(true);
  for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => parseChiliEvent({ ...event, payload: { ...event.payload, offset } })).toThrow();
  }
  expect(() => parseChiliEvent({ ...event, sessionId: undefined })).toThrow();
});

test("live bootstrap cannot impersonate a committed or different message", () => {
  const event = { ...envelope, type: "message.part_stream_snapshot", payload: { messageId: part.messageId, part } };
  expect(isTransientEvent(parseChiliEvent(event))).toBe(true);
  for (const change of [{ completion: "completed" }, { messageId: "other" }, { sessionId: "other" }, { ordinal: -1 }]) {
    expect(() => parseChiliEvent({ ...event, payload: { ...event.payload, part: { ...part, ...change } } })).toThrow();
  }
});
