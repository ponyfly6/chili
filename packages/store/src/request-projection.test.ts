import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ChiliEvent, EventEnvelope, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "./sqlite-event-store.js";

test("SQLite removes request bodies before decoding transport rows and preserves raw audit reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-request-projection-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const sessionId = "session_request_projection" as SessionId;
  const event = {
    id: "event_request_projection", type: "model.request_prepared", time: 1 as TimestampMs, sessionId,
    payload: {
      turnId: "turn_request_projection" as TurnId, requestId: "request_projection", attempt: 1,
      // Old request records without the duplicated contentVersion remain readable.
      request: {
        version: 1, purpose: "turn", contentVersion: "snapshot-hash", sessionRevision: 1,
        system: ["large audit snapshot" + "x".repeat(5_000_000)], developer: [], contextualUser: [],
        messages: [], tools: [], sources: [], budget: {},
      },
    },
  } as unknown as Extract<ChiliEvent, { type: "model.request_prepared" }>;
  try {
    await store.append(event);
    const decoder = store as unknown as { eventFromRow(row: { payload_json: string }): EventEnvelope };
    const decode = decoder.eventFromRow.bind(store);
    const decodedBytes: number[] = [];
    decoder.eventFromRow = (row) => { decodedBytes.push(row.payload_json.length); return decode(row); };
    for (const tail of [true, false]) {
      expect((await store.events({ sessionId, tail, compactRequests: true }))[0]).toEqual({
        ...event,
        payload: { turnId: event.payload.turnId, requestId: "request_projection", attempt: 1, contentVersion: "snapshot-hash" },
      });
    }
    expect(decodedBytes).toHaveLength(2);
    expect(Math.max(...decodedBytes)).toBeLessThan(256);
    expect(await store.events({ sessionId, type: "model.request_prepared" })).toEqual([event]);
    expect(decodedBytes.at(-1)).toBeGreaterThan(5_000_000);
    expect(await store.events({ sessionId, afterEventId: event.id, compactRequests: true })).toEqual([]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
