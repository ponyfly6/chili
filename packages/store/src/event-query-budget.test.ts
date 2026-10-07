import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, SessionId, TimestampMs } from "@chili/protocol";
import { ObservableEventStore } from "./observable-event-store.js";
import { SqliteEventStore, UnknownEventCursorError } from "./sqlite-event-store.js";
import { EventPageTooLargeError } from "./types.js";

const sessionId = "session_budget" as SessionId;

function renamed(index: number, title = `标题 ${index}`): RuntimeEvent {
  return { id: `event_${index}`, type: "session.renamed", sessionId, time: (100 - index) as TimestampMs, payload: { sessionId, title } };
}

function dbOf(store: SqliteEventStore): Database {
  return (store as unknown as { db: Database }).db;
}

test("byte pages preserve consecutive durable order and measure UTF-8 rather than characters", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    const events = [renamed(1), renamed(2), renamed(3)];
    await store.appendMany(events);
    const maxBytes = Buffer.byteLength(JSON.stringify(events[0])) + Buffer.byteLength(JSON.stringify(events[1]));
    expect(await store.events({ sessionId, maxBytes })).toEqual(events.slice(0, 2));
    expect(await store.events({ sessionId, afterEventId: events[1]!.id, maxBytes })).toEqual(events.slice(2));
    expect(await store.events({ sessionId, tail: true, maxBytes })).toEqual(events.slice(1));
    expect(await store.events({ sessionId, afterEventId: events[0]!.id, tail: true, maxBytes })).toEqual(events.slice(1));
  } finally { store.close(); }
});

test("an oversized row stops the prefix and reports its cursor without skipping following events", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    await store.appendMany([renamed(1), renamed(2, "x".repeat(1_000_000)), renamed(3)]);
    const page = await store.events({ maxBytes: 1_024 });
    expect(page.map((event) => event.id)).toEqual(["event_1"]);
    await expect(store.events({ afterEventId: "event_1", maxBytes: 1_024 })).rejects.toMatchObject({
      name: "EventPageTooLargeError", eventId: "event_2", maxBytes: 1_024,
    });
    // Reverse collection also stops at that row, preserving the newest suffix.
    expect((await store.events({ tail: true, maxBytes: 1_024 })).map((event) => event.id)).toEqual(["event_3"]);
    await expect(store.events({ beforeEventId: "event_3", tail: true, maxBytes: 1_024 })).rejects.toBeInstanceOf(EventPageTooLargeError);
  } finally { store.close(); }
});

test("byte-limited pages compact large request audit bodies before moving payloads into JS", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    dbOf(store).query("insert into events (id, type, time, session_id, payload_json) values (?, ?, ?, ?, ?)").run(
      "request_huge", "model.request_prepared", 1, sessionId,
      JSON.stringify({ turnId: "turn_budget", request: { contentVersion: 7, content: "x".repeat(1_000_000) } }),
    );
    await expect(store.events({ maxBytes: 1_024 })).rejects.toBeInstanceOf(EventPageTooLargeError);
    const page = await store.events({ compactRequests: true, maxBytes: 1_024 });
    expect(page).toHaveLength(1);
    expect(page[0]!.payload).toEqual({ turnId: "turn_budget", contentVersion: 7 });
  } finally { store.close(); }
});

test("replay metadata sizes a tail and resume without reading oversized or malformed bodies", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    const db = dbOf(store);
    const insert = db.query("insert into events (id, type, time, session_id, payload_json) values (?, ?, ?, ?, ?)");
    db.transaction(() => {
      for (let i = 0; i < 5_010; i++) insert.run(`metadata_${i}`, "session.renamed", 5_010 - i, sessionId, "{invalid");
      insert.run("other_session_event", "session.renamed", 1, "other_session", "{invalid");
    })();
    expect(await store.eventReplayBoundary({ sessionId, tail: true, limit: 5_000 })).toEqual({ afterEventId: "metadata_9", count: 5_000 });
    expect(await store.eventReplayBoundary({ sessionId, afterEventId: "metadata_9", limit: 5_001 })).toEqual({ afterEventId: "metadata_9", count: 5_000 });
    expect(await store.eventReplayBoundary({ sessionId, afterEventId: "metadata_0", limit: 5_001 })).toEqual({ afterEventId: "metadata_0", count: 5_001 });
    expect(await store.eventReplayBoundary({ sessionId, afterEventId: "metadata_5009", limit: 5_001 })).toEqual({ afterEventId: "metadata_5009", count: 0 });
    await expect(store.eventReplayBoundary({ sessionId, afterEventId: "absent" })).rejects.toBeInstanceOf(UnknownEventCursorError);
    await expect(store.eventReplayBoundary({ sessionId: "other" as SessionId, afterEventId: "metadata_0" })).rejects.toBeInstanceOf(UnknownEventCursorError);
  } finally { store.close(); }
});

test("extreme request bodies report resync before SQLite JSON parsing", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    // Deliberately invalid JSON: a compaction attempt would throw malformed
    // JSON instead of yielding the actionable durable cursor below.
    dbOf(store).query("insert into events (id, type, time, session_id, payload_json) values (?, ?, ?, ?, ?)").run(
      "request_extreme", "model.request_prepared", 1, sessionId, "{" + "x".repeat(17 * 1024 * 1024),
    );
    await expect(store.events({ compactRequests: true, maxBytes: 256 * 1024 })).rejects.toMatchObject({
      name: "EventPageTooLargeError", eventId: "request_extreme",
    });
  } finally { store.close(); }
});

test("observable wrappers preserve optional replay capabilities and byte budgets", async () => {
  const base = new SqliteEventStore(":memory:");
  const store = new ObservableEventStore(new ObservableEventStore(base));
  try {
    await store.appendMany([renamed(1), renamed(2)]);
    expect(await store.eventReplayBoundary!({ tail: true, limit: 1 })).toEqual({ afterEventId: "event_1", count: 1 });
    expect(await store.runtimeSnapshot!({ sessionId })).toMatchObject({ version: 1, afterEventId: "event_2" });
    await expect(store.events({ maxBytes: 1 })).rejects.toBeInstanceOf(EventPageTooLargeError);
    const unsupported = new ObservableEventStore({
      append: async () => {}, appendMany: async () => {}, events: async () => [],
      sessions: async () => [], messages: async () => [], pendingApprovals: async () => [],
    });
    expect(unsupported.eventReplayBoundary).toBeUndefined();
    expect(unsupported.runtimeSnapshot).toBeUndefined();
  } finally { base.close(); }
});

test("byte-page early completion and oversized errors release SQLite read statements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-budget-lock-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  try {
    await store.appendMany([renamed(1), renamed(2, "x".repeat(2_048))]);
    expect(await store.events({ maxBytes: 1_024 })).toHaveLength(1);
    expect(() => dbOf(store).exec("pragma wal_checkpoint(TRUNCATE)")).not.toThrow();
    await expect(store.events({ afterEventId: "event_1", maxBytes: 1_024 })).rejects.toBeInstanceOf(EventPageTooLargeError);
    expect(() => dbOf(store).exec("pragma wal_checkpoint(TRUNCATE)")).not.toThrow();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
