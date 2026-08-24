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

test("cancels an undelimited stream when its buffer exceeds the safety limit", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("data: 1234567890"));
    },
    cancel() {
      cancelled = true;
    },
  });

  const events = readSseEvents(body, { idleTimeoutMs: 0, maxBufferBytes: 32, maxEventBytes: 64 });

  await expect(events[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    name: "SseEventLimitError",
    message: "SSE buffer exceeded the 32-byte safety limit",
  });
  expect(cancelled).toBe(true);
});

test("rejects a delimited event larger than the per-event safety limit", async () => {
  const events = readSseEvents(closedStream(`data: ${"界".repeat(20)}\n\n`), {
    idleTimeoutMs: 10,
    maxEventBytes: 32,
    maxBufferBytes: 128,
  });

  await expect(events[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    name: "SseEventLimitError",
    message: "SSE event exceeded the 32-byte safety limit",
  });
});

test("rejects one oversized buffer even when it contains many small delimited events", async () => {
  const events = readSseEvents(closedStream("data: x\n\n".repeat(1_000)), {
    idleTimeoutMs: 10,
    maxEventBytes: 20,
    maxBufferBytes: 20,
  });

  await expect(events[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    name: "SseEventLimitError",
    message: "SSE buffer exceeded the 20-byte safety limit",
  });
});

test("aborting a pending read rejects instead of flushing a partial event", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode("data: private-partial"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const iterator = readSseEvents(body, { signal: controller.signal, idleTimeoutMs: 0 })[Symbol.asyncIterator]();
  const pending = iterator.next();
  await Promise.resolve();
  controller.abort();

  await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "Model stream aborted" });
  expect(cancelled).toBe(true);
});

test("cancels the source when a consumer stops before EOF", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });

  for await (const event of readSseEvents(body, { idleTimeoutMs: 0 })) {
    expect(event.data).toBe("first");
    break;
  }
  expect(cancelled).toBe(true);
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
