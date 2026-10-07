import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type {
  RuntimeEvent,
  MessageId,
  MessagePart,
  PartId,
  SessionId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import { SqliteEventStore } from "./sqlite-event-store.js";

const sessionId = "session_message_order" as SessionId;
const turnId = "turn_message_order" as TurnId;

test("messages and session preview follow creation commits across connections and clock rollback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-message-order-"));
  const path = join(dir, "events.sqlite");
  let store = new SqliteEventStore(path);
  const peer = new SqliteEventStore(path);
  const userId = "ffffffff-ffff-4fff-afff-ffffffffffff" as MessageId;
  const assistantId = "00000000-0000-4000-a000-000000000000" as MessageId;
  const nextUserId = "11111111-1111-4111-a111-111111111111" as MessageId;

  try {
    await store.append({
      id: "event_session",
      type: "session.created",
      sessionId,
      time: 100 as TimestampMs,
      payload: { sessionId, cwd: dir },
    });
    await store.appendMany([
      creation("event_first_user", userId, "user", 100),
      textPart("event_first_user_text", userId, "part_first_user", "Original question", 100),
    ]);
    await peer.append(creation("event_assistant", assistantId, "assistant", 100));
    await store.appendMany([
      creation("event_next_user", nextUserId, "user", 50),
      textPart("event_next_user_text", nextUserId, "part_next_user", "Latest question", 50),
    ]);

    const expected = [userId, assistantId, nextUserId];
    expect((await store.messages(sessionId)).map((message) => String(message.id))).toEqual(expected);
    expect((await peer.messages(sessionId)).map((message) => String(message.id))).toEqual(expected);
    expect((await store.messages(sessionId)).map((message) => Number(message.createdAt))).toEqual([100, 100, 50]);
    expect((await store.sessions())[0]?.preview).toBe("Latest question");

    // Repeated creation and late edits do not move the original message.
    await peer.appendMany([
      creation("event_duplicate_creation", userId, "user", 200),
      textPart("event_first_user_edit", userId, "part_first_user", "Edited original", 200),
    ]);
    expect((await store.messages(sessionId)).map((message) => String(message.id))).toEqual(expected);
    expect((await store.messages(sessionId))[0]).toMatchObject({
      createdAt: 100,
      parts: [{ text: "Edited original" }],
    });
    expect((await store.sessions())[0]?.preview).toBe("Latest question");

    peer.close();
    store.close();
    store = new SqliteEventStore(path);
    expect((await store.messages(sessionId)).map((message) => String(message.id))).toEqual(expected);
    expect((await store.sessions())[0]?.preview).toBe("Latest question");
  } finally {
    peer.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("streaming parts and compaction messages retain the same causal history after checkpoint and reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-compaction-order-"));
  const path = join(dir, "events.sqlite");
  let store = new SqliteEventStore(path);
  const userId = "message_z_user" as MessageId;
  const assistantId = "message_a_assistant" as MessageId;
  const summaryId = "message_0_summary" as MessageId;
  const assistantPartId = "part_assistant" as PartId;
  const compaction: MessagePart = {
    id: "part_compaction" as PartId,
    messageId: summaryId,
    sessionId,
    type: "compaction",
    boundaryMessageId: assistantId,
    sourceMessageIds: [userId, assistantId],
    reason: "manual",
    summary: "The question was answered.",
  };

  try {
    await store.appendMany([
      creation("event_user", userId, "user", 100),
      creation("event_assistant", assistantId, "assistant", 100),
      textPart("event_assistant_text", assistantId, assistantPartId, "Answ", 100),
      {
        id: "event_assistant_delta",
        type: "message.part_delta",
        time: 100 as TimestampMs,
        sessionId,
        payload: { messageId: assistantId, partId: assistantPartId, field: "text", delta: "er" },
      },
      creation("event_summary", summaryId, "user", 50),
      {
        id: "event_compaction",
        type: "message.part_added",
        time: 50 as TimestampMs,
        sessionId,
        payload: { messageId: summaryId, part: compaction },
      },
    ]);
    const beforeCheckpoint = await store.messages(sessionId);
    expect(beforeCheckpoint.map((message) => String(message.id))).toEqual([userId, assistantId, summaryId]);
    expect(beforeCheckpoint[1]?.parts).toMatchObject([{ text: "Answer" }]);
    expect(beforeCheckpoint[2]?.parts).toEqual([compaction]);

    await store.append({
      id: "event_turn_completed",
      type: "turn.completed",
      time: 200 as TimestampMs,
      sessionId,
      payload: { turnId, status: "completed" },
    });
    expect(await store.messages(sessionId)).toEqual(beforeCheckpoint);
    store.close();
    store = new SqliteEventStore(path);
    expect(await store.messages(sessionId)).toEqual(beforeCheckpoint);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function creation(
  id: string,
  messageId: MessageId,
  role: "user" | "assistant",
  time: number,
): Extract<RuntimeEvent, { type: "message.created" }> {
  return {
    id,
    type: "message.created",
    sessionId,
    time: time as TimestampMs,
    payload: { messageId, role, turnId },
  };
}

function textPart(
  id: string,
  messageId: MessageId,
  partId: string,
  text: string,
  time: number,
): RuntimeEvent {
  return {
    id,
    type: "message.part_added",
    sessionId,
    time: time as TimestampMs,
    payload: {
      messageId,
      part: { id: partId as PartId, messageId, sessionId, type: "text", text },
    },
  };
}
