import { expect, test } from "bun:test";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import type { ChiliEvent, MessageId, PartId, SessionId, TimestampMs } from "@chili/protocol";
import { eventStream, type EventStreamOptions } from "./event-stream.js";

const sessionId = "session_streaming" as SessionId;
const messageId = "message_streaming" as MessageId;
const partId = "part_streaming" as PartId;

async function fixture() {
  const base = new SqliteEventStore(":memory:");
  const store = new ObservableEventStore(base);
  await store.appendMany([
    { id: "created_session", type: "session.created", sessionId, time: 1 as TimestampMs, payload: { sessionId, cwd: "/repo" } },
    { id: "created_message", type: "message.created", sessionId, time: 2 as TimestampMs, payload: { messageId, role: "assistant" } },
  ]);
  const options: EventStreamOptions = {
    store, request: new Request("http://chili.test/events"), sessionId, afterEventId: "created_message",
    maxBacklogEvents: 5_000, maxBufferedBytes: 4_000_000, maxTransientBytes: 256_000,
    maxPageBytes: 256_000, pollIntervalMs: 10_000, stallTimeoutMs: 1_000,
  };
  return { base, store, options };
}

function delta(id: string, text: string, offset: number): ChiliEvent {
  return { id, type: "message.part_stream_delta", sessionId, time: 3 as TimestampMs,
    payload: { messageId, partId, partType: "text", delta: text, offset, ordinal: 0 } };
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ text: string; event: ChiliEvent }> {
  const result = await reader.read();
  if (result.done) throw new Error("SSE ended before expected event");
  const text = new TextDecoder().decode(result.value);
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  if (!data) throw new Error(`Missing SSE event data: ${text}`);
  return { text, event: JSON.parse(data.slice(6)) as ChiliEvent };
}

test("SSE reconnect captures full active text before waiting for the replay boundary", async () => {
  const { base, store, options } = await fixture();
  try {
    await store.append(delta("delta_before_connect", "hello", 0));
    const readBoundary = base.eventReplayBoundary.bind(base);
    base.eventReplayBoundary = async (query) => {
      await store.append(delta("delta_during_boundary", " world", 5));
      return readBoundary(query);
    };
    const response = await eventStream(options);
    const reader = response.body!.getReader();
    try {
      const first = await readFrame(reader);
      expect(first.event).toMatchObject({ type: "message.part_stream_snapshot", payload: { part: { text: "hello", ordinal: 0 } } });
      expect(first.text).not.toContain("id: ");
      expect((await readFrame(reader)).event).toMatchObject({ type: "message.part_stream_delta", payload: { offset: 5, delta: " world" } });
    } finally { await reader.cancel(); }
  } finally { base.close(); }
});

test("full active bootstrap has a separate budget from incremental output", async () => {
  const { base, store, options } = await fixture();
  try {
    const text = "x".repeat(300_000);
    await store.append(delta("long_active", text, 0));
    const response = await eventStream(options);
    const reader = response.body!.getReader();
    try {
      expect((await readFrame(reader)).event).toMatchObject({ type: "message.part_stream_snapshot", payload: { part: { text } } });
    } finally { await reader.cancel(); }
  } finally { base.close(); }
});

test("a commit during replay precedes the captured active prefix without changing its cursor", async () => {
  const { base, store, options } = await fixture();
  try {
    await store.append(delta("before_commit", "prefix", 0));
    const readBoundary = base.eventReplayBoundary.bind(base);
    base.eventReplayBoundary = async (query) => {
      await store.append({ id: "committed", type: "message.part_committed", sessionId, time: 4 as TimestampMs,
        payload: { messageId, part: { id: partId, messageId, sessionId, type: "text", text: "prefix final", completion: "completed" } } });
      return readBoundary(query);
    };
    const reader = (await eventStream(options)).body!.getReader();
    try {
      const committed = await readFrame(reader);
      expect(committed.event.type).toBe("message.part_committed");
      expect(committed.text).toContain("id: committed\n");
      const active = await readFrame(reader);
      expect(active.event).toMatchObject({ type: "message.part_stream_snapshot", payload: { part: { text: "prefix" } } });
      expect(active.text).not.toContain("id: ");
    } finally { await reader.cancel(); }
  } finally { base.close(); }
});

test("oversized active bootstrap requests resync instead of silently dropping current text", async () => {
  const { base, store, options } = await fixture();
  try {
    await store.append(delta("oversized_active", "x".repeat(2_000), 0));
    const reader = (await eventStream({ ...options, maxBufferedBytes: 1_024 })).body!.getReader();
    try {
      const frame = await readFrame(reader);
      expect(frame.text).toContain("event: chili.resync\n");
      expect(frame.event).toMatchObject({ reason: "event_transport_limit", afterEventId: "created_message" });
      expect((await reader.read()).done).toBe(true);
    } finally { await reader.cancel(); }
  } finally { base.close(); }
});
