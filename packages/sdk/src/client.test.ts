import { expect, test } from "bun:test";
import {
  EventCursorResyncRequiredError,
  HttpRuntimeClient,
  isEventCursorResyncRequiredError,
} from "./client.js";

test("streamEvents exposes a cursor resync signal for rejected resume cursors", async () => {
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test",
    fetch: (async () => new Response(JSON.stringify({
      error: { message: "Unknown event cursor. Reconnect without afterEventId to resync." },
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
  });

  let caught: unknown;
  try {
    for await (const _event of client.streamEvents({ afterEventId: "event_missing" })) {
      // A rejected cursor must fail before the stream yields an event.
    }
  } catch (error) {
    caught = error;
  }

  expect(isEventCursorResyncRequiredError(caught)).toBe(true);
  expect(caught).toBeInstanceOf(EventCursorResyncRequiredError);
  expect(caught).toMatchObject({
    name: "EventCursorResyncRequiredError",
    code: "EVENT_CURSOR_RESYNC_REQUIRED",
    status: 409,
    afterEventId: "event_missing",
    message: "Unknown event cursor. Reconnect without afterEventId to resync.",
  });
});

test("streamEvents keeps non-resume HTTP conflicts as ordinary errors", async () => {
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test",
    fetch: (async () => new Response(JSON.stringify({ error: { message: "conflict" } }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
  });

  let caught: unknown;
  try {
    for await (const _event of client.streamEvents()) {
      // A failed response must not yield events.
    }
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(isEventCursorResyncRequiredError(caught)).toBe(false);
  expect((caught as Error).message).toBe("conflict");
});
