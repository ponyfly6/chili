import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { applyRuntimeEvent, HttpRuntimeClient, isEventTransportResyncRequiredError, reduceRuntimeEvents } from "@chili/sdk";
import type { ChiliEvent, MessageId, PartId, SessionId, TimestampMs } from "@chili/protocol";
import { createRuntimeHttpHandler, type RuntimeHttpService } from "./runtime-http.js";

const sessionId = "snapshot_http_session" as SessionId;
const messageId = "snapshot_http_message" as MessageId;
const partId = "snapshot_http_part" as PartId;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "chili-snapshot-http-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(sqlite);
  const service = { assertSessionReadAllowed: async () => {} } as unknown as RuntimeHttpService;
  const handler = createRuntimeHttpHandler({ service, store });
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test",
    fetch: ((input, init) => handler(new Request(input, init))) as typeof fetch,
  });
  return {
    store, sqlite, handler, client,
    async close() {
      sqlite.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function initialEvents(): ChiliEvent[] {
  return [
    { id: "snapshot_created", type: "session.created", time: 1 as TimestampMs,
      sessionId, payload: { sessionId, cwd: "/repo" } },
    { id: "snapshot_message", type: "message.created", time: 2 as TimestampMs,
      sessionId, payload: { messageId, role: "assistant" } },
    { id: "snapshot_part", type: "message.part_added", time: 3 as TimestampMs,
      sessionId, payload: { messageId, part: { id: partId, messageId, sessionId, type: "text", text: "before" } } },
  ];
}

test("snapshot HTTP watermark includes uncheckpointed text and resumes writes after its read boundary", async () => {
  const f = await fixture();
  try {
    await f.store.appendMany(initialEvents());
    const firstDelta: ChiliEvent = { id: "snapshot_delta_before", type: "message.part_delta",
      time: 4 as TimestampMs, sessionId, payload: { messageId, partId, field: "text", delta: " snapshot" } };
    const laterDelta: ChiliEvent = { id: "snapshot_delta_after", type: "message.part_delta",
      time: 5 as TimestampMs, sessionId, payload: { messageId, partId, field: "text", delta: " + live" } };
    await f.store.append(firstDelta);
    const readSnapshot = f.store.runtimeSnapshot!.bind(f.store);
    Object.defineProperty(f.store, "runtimeSnapshot", { value: async (input: Parameters<typeof readSnapshot>[0]) => {
      const result = await readSnapshot(input);
      await f.store.append(laterDelta);
      return result;
    } });
    const snapshot = await f.client.eventSnapshot({ sessionId });
    expect(snapshot.afterEventId).toBe(firstDelta.id);
    const view = reduceRuntimeEvents(snapshot.events);
    expect(view.messages[messageId]?.parts[0]).toMatchObject({ text: "before snapshot" });
    const abort = new AbortController();
    const stream = f.client.streamEvents({ sessionId, afterEventId: snapshot.afterEventId!, signal: abort.signal });
    try {
      const next = await stream[Symbol.asyncIterator]().next();
      expect(next.done).toBe(false);
      expect(next.value?.id).toBe(laterDelta.id);
      if (next.value) applyRuntimeEvent(view, next.value);
      expect(view.messages[messageId]?.parts[0]).toMatchObject({ text: "before snapshot + live" });
    } finally {
      abort.abort();
    }
  } finally { await f.close(); }
});

test("an empty snapshot resumes from the beginning even when writes arrive before SSE connects", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.client.eventSnapshot();
    expect(snapshot.afterEventId).toBeUndefined();
    expect(snapshot.events).toEqual([]);
    await f.store.appendMany(initialEvents());
    const stream = f.client.streamEvents({ fromStart: true });
    const seen: string[] = [];
    for await (const event of stream) {
      seen.push(event.id);
      if (seen.length === initialEvents().length) break;
    }
    expect(seen).toEqual(initialEvents().map((event) => event.id));
  } finally { await f.close(); }
});

test("snapshot requests validate scope, do not cache state, and skip pre-cancelled reads", async () => {
  const f = await fixture();
  try {
    await f.store.appendMany(initialEvents());
    const response = await f.handler(new Request(`http://chili.test/events/snapshot?sessionId=${sessionId}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await f.handler(new Request("http://chili.test/events/snapshot?unexpected=1"))).status).toBe(400);
    expect((await f.handler(new Request("http://chili.test/events/snapshot?sessionId=missing"))).status).toBe(404);
    const abort = new AbortController();
    abort.abort();
    let calls = 0;
    const readSnapshot = f.store.runtimeSnapshot!.bind(f.store);
    Object.defineProperty(f.store, "runtimeSnapshot", { value: (input: Parameters<typeof readSnapshot>[0]) => {
      calls += 1; return readSnapshot(input);
    } });
    expect((await f.handler(new Request("http://chili.test/events/snapshot", { signal: abort.signal }))).status).toBe(499);
    expect(calls).toBe(0);
  } finally { await f.close(); }
});

test("an oversized persisted event recovers through the real SDK snapshot and continues beyond its cursor", async () => {
  const f = await fixture();
  try {
    await f.store.appendMany(initialEvents());
    await f.store.append({ id: "snapshot_legacy_poison", type: "session.status_changed",
      sessionId, time: 4 as TimestampMs, payload: { sessionId, status: "failed", reason: "x".repeat(4_100_000) } });
    let failure: unknown;
    try {
      for await (const _event of f.client.streamEvents({ sessionId, afterEventId: "snapshot_part" })) {
        throw new Error("The poison row must request recovery instead of becoming a runtime event");
      }
    } catch (error) { failure = error; }
    expect(isEventTransportResyncRequiredError(failure)).toBe(true);
    const snapshot = await f.client.eventSnapshot({ sessionId });
    expect(snapshot.afterEventId).toBe("snapshot_legacy_poison");
    expect(snapshot.truncated).toBe(true);
    const view = reduceRuntimeEvents(snapshot.events);
    expect(view.sessions[sessionId]?.status).toBe("failed");
    await f.store.append({ id: "snapshot_after_poison", type: "session.renamed",
      sessionId, time: 5 as TimestampMs, payload: { sessionId, title: "recovered" } });
    for await (const event of f.client.streamEvents({ sessionId, afterEventId: snapshot.afterEventId! })) {
      expect(event.id).toBe("snapshot_after_poison");
      applyRuntimeEvent(view, event);
      break;
    }
    expect(view.sessions[sessionId]?.title).toBe("recovered");
  } finally { await f.close(); }
});

test("snapshot recovery fails explicitly for stores without an atomic snapshot capability", async () => {
  const f = await fixture();
  try {
    Object.defineProperty(f.store, "runtimeSnapshot", { value: undefined });
    const response = await f.handler(new Request("http://chili.test/events/snapshot"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { message: "This event store does not support atomic state recovery." },
    });
  } finally { await f.close(); }
});
