import { expect, test } from "bun:test";
import type { ChiliEvent, MessageId, PartId, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { ObservableEventStore } from "./observable-event-store.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

const sessionId = "session_live" as SessionId;
const messageId = "message_live" as MessageId;
const partId = "part_live" as PartId;
const turnId = "turn_live" as TurnId;

async function fixture() {
  const base = new SqliteEventStore(":memory:");
  const store = new ObservableEventStore(base);
  await store.appendMany([
    { id: "session_created", type: "session.created", sessionId, time: 1 as TimestampMs, payload: { sessionId, cwd: "/repo" } },
    { id: "turn_started", type: "turn.started", sessionId, time: 2 as TimestampMs, payload: { turnId } },
    { id: "message_created", type: "message.created", sessionId, time: 3 as TimestampMs, payload: { messageId, role: "assistant", turnId } },
  ]);
  return { base, store };
}

function delta(id: string, text: string, offset: number): ChiliEvent {
  return { id, type: "message.part_stream_delta", sessionId, time: 4 as TimestampMs,
    payload: { messageId, partId, partType: "reasoning", delta: text, offset, ordinal: 0, redacted: false } };
}

function committed(text: string): ChiliEvent {
  return { id: "part_committed", type: "message.part_committed", sessionId, time: 5 as TimestampMs,
    payload: { messageId, part: { id: partId, type: "reasoning", messageId, sessionId, text, ordinal: 0, completion: "completed" } } };
}

test("observable history includes active Unicode text without persisting each delta", async () => {
  const { base, store } = await fixture();
  try {
    await store.append(delta("delta_1", "想🙂", 0));
    await store.append(delta("delta_2", "🙂清楚", 1));
    await store.append(delta("delta_duplicate", "🙂清楚", 1));
    expect((await store.messages(sessionId))[0]?.parts).toEqual([
      { id: partId, type: "reasoning", messageId, sessionId, text: "想🙂清楚", ordinal: 0, redacted: false },
    ]);
    expect((await base.messages(sessionId))[0]?.parts).toEqual([]);
    expect((await base.events()).map((event) => event.type)).toEqual(["session.created", "turn.started", "message.created"]);
    expect(store.activeMessageParts({ sessionId: "other" as SessionId })).toEqual([]);
    const snapshot = store.activeMessageParts()[0]!;
    if (snapshot.type !== "message.part_stream_snapshot") throw new Error("Expected active snapshot");
    snapshot.payload.part.text = "mutated by caller";
    expect(store.activeMessageParts()[0]?.payload).toMatchObject({ part: { text: "想🙂清楚" } });

    await store.append(committed("想🙂清楚"));
    expect(store.activeMessageParts()).toEqual([]);
    expect((await store.messages(sessionId))[0]?.parts[0]).toMatchObject({ text: "想🙂清楚", completion: "completed" });
  } finally { base.close(); }
});

test("snapshot preserves the captured active prefix when a commit follows its durable watermark", async () => {
  const { base, store } = await fixture();
  try {
    await store.append(delta("delta_before_snapshot", "working", 0));
    const readSnapshot = base.runtimeSnapshot.bind(base);
    base.runtimeSnapshot = async (query) => {
      const snapshot = await readSnapshot(query);
      await store.append(committed("working done"));
      return snapshot;
    };
    const snapshot = await store.runtimeSnapshot!({ sessionId });
    expect(snapshot.afterEventId).toBe("message_created");
    expect(snapshot.events.at(-1)).toMatchObject({ type: "message.part_stream_snapshot", payload: { part: { text: "working" } } });
    expect((await store.events({ afterEventId: snapshot.afterEventId! })).map((event) => event.id)).toEqual(["part_committed"]);
    expect(store.activeMessageParts()).toEqual([]);
  } finally { base.close(); }
});

test("snapshot never overlays an active prefix on a committed final part", async () => {
  const { base, store } = await fixture();
  try {
    await store.append(delta("delta_before_commit", "working", 0));
    const readSnapshot = base.runtimeSnapshot.bind(base);
    base.runtimeSnapshot = async (query) => {
      await store.append(committed("working done"));
      return readSnapshot(query);
    };
    const snapshot = await store.runtimeSnapshot!({ sessionId });
    expect(snapshot.afterEventId).toBe("part_committed");
    expect(snapshot.events.some((event) => event.type === "message.part_stream_snapshot")).toBe(false);
    expect(snapshot.events.filter((event) => event.type === "message.part_added").at(-1)?.payload).toMatchObject({ part: { text: "working done", completion: "completed" } });
  } finally { base.close(); }
});

test("live message reads keep generation order and preserve a commit that wins the read race", async () => {
  const { base, store } = await fixture();
  try {
    await store.append(delta("active_reasoning", "first", 0));
    await store.append({ id: "later_block", type: "message.part_committed", sessionId, time: 5 as TimestampMs,
      payload: { messageId, part: { id: "part_later" as PartId, type: "text", messageId, sessionId, text: "second", ordinal: 1, completion: "completed" } } });
    expect((await store.messages(sessionId))[0]?.parts.map((part) => part.id)).toEqual([partId, "part_later" as PartId]);

    const readMessages = base.messages.bind(base);
    base.messages = async (id) => {
      await store.append(committed("first finished"));
      return readMessages(id);
    };
    expect((await store.messages(sessionId))[0]?.parts[0]).toMatchObject({ id: partId, text: "first finished", completion: "completed" });
  } finally { base.close(); }
});

test("active snapshot fails its byte budget rather than truncating the delta offset baseline", async () => {
  const { base, store } = await fixture();
  try {
    await store.append(delta("delta_long", "文".repeat(1_000), 0));
    expect(() => store.activeMessageParts({ maxBytes: 1_000 })).toThrow("snapshot capacity");
    await expect(store.runtimeSnapshot!({ sessionId, maxBytes: 1_000 })).rejects.toMatchObject({ name: "RuntimeSnapshotLimitError" });
    expect(store.activeMessageParts()[0]?.payload).toMatchObject({ part: { text: "文".repeat(1_000) } });
  } finally { base.close(); }
});

test("nested observable wrappers include one complete active snapshot", async () => {
  const { base, store: inner } = await fixture();
  const store = new ObservableEventStore(inner);
  try {
    await store.append(delta("nested_delta", "thinking", 0));
    const snapshot = await store.runtimeSnapshot!({ sessionId });
    expect(snapshot.events.filter((event) => event.type === "message.part_stream_snapshot")).toHaveLength(1);
    expect((await store.messages(sessionId))[0]?.parts).toHaveLength(1);
  } finally { base.close(); }
});
