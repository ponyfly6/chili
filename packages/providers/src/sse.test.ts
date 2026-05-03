import { expect, test } from "bun:test";
import { readSseEvents } from "./sse.js";

test("times out when an SSE stream goes idle without closing", async () => {
  const iterator = readSseEvents(hangingStream("event: message\ndata: {\"ok\":true}\n\n"), {
    idleTimeoutMs: 10,
  })[Symbol.asyncIterator]();

  expect(await iterator.next()).toEqual({
    done: false,
    value: {
      event: "message",
      data: "{\"ok\":true}",
    },
  });

  await expect(iterator.next()).rejects.toThrow("SSE stream timed out after 10ms without data");
});

test("parses a final SSE event when the stream closes without a blank terminator", async () => {
  const events = [];
  for await (const event of readSseEvents(closedStream("event: message\ndata: done"), { idleTimeoutMs: 10 })) {
    events.push(event);
  }

  expect(events).toEqual([{ event: "message", data: "done" }]);
});

function hangingStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
    },
  });
}

function closedStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}
