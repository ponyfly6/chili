import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type {
  ChiliEvent,
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

test("older projection writers preserve creation order across live connections and reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-mixed-message-order-"));
  const path = join(dir, "events.sqlite");
  let store = new SqliteEventStore(path);
  const older = new Database(path, { strict: true });
  const firstId = "message_z_first" as MessageId;
  const laterId = "message_a_later" as MessageId;
  const afterReopenId = "message_0_after_reopen" as MessageId;

  try {
    await store.append({
      id: "event_session",
      type: "session.created",
      sessionId,
      time: 100 as TimestampMs,
      payload: { sessionId, cwd: dir },
    });
    await store.appendMany([
      creation("event_first", firstId, "user", 100),
      textPart("event_first_text", firstId, "part_first", "First question", 100),
    ]);
    appendOlderCreation(older, creation("event_later", laterId, "user", 50));
    await store.append(textPart("event_later_text", laterId, "part_later", "Latest question", 50));
    expect((await store.messages(sessionId)).map((message) => String(message.id))).toEqual([firstId, laterId]);
    expect((await store.sessions())[0]?.preview).toBe("Latest question");
    expect(older.query<{ created_event_seq: number | null }, [string]>(
      "select created_event_seq from messages where id = ?",
    ).get(laterId)?.created_event_seq).toBe(4);

    store.close();
    store = new SqliteEventStore(path);
    appendOlderCreation(older, creation("event_after_reopen", afterReopenId, "assistant", 0));
    expect((await store.messages(sessionId)).map((message) => String(message.id))).toEqual([
      firstId, laterId, afterReopenId,
    ]);

    // An old duplicate insert cannot move an existing message to the end.
    appendOlderCreation(older, creation("event_duplicate", firstId, "user", 200));
    expect((await store.messages(sessionId)).map((message) => String(message.id))).toEqual([
      firstId, laterId, afterReopenId,
    ]);
    expect((await store.sessions())[0]?.preview).toBe("Latest question");
  } finally {
    older.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("older projection inserts use the first scoped creation and leave unanchored rows unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-older-message-identity-"));
  const path = join(dir, "events.sqlite");
  const store = new SqliteEventStore(path);
  const older = new Database(path, { strict: true });
  const orphanId = "message_orphan" as MessageId;
  const anchoredId = "message_anchored" as MessageId;

  try {
    older.exec(`insert into events (seq, id, type, time, session_id, payload_json) values
      (1, 'event_other_session', 'message.created', 0, 'other_session', '{"messageId":"message_orphan","role":"user"}'),
      (2, 'event_original', 'message.created', 100, 'session_message_order', '{"messageId":"message_anchored","role":"user"}');
      insert into messages (id, session_id, role, created_at)
        values ('message_orphan', 'session_message_order', 'user', 0);`);
    appendOlderCreation(older, creation("event_duplicate_anchored", anchoredId, "user", 50));
    appendOlderCreation(older, creation("event_orphan_late", orphanId, "user", 200));

    expect(older.query<{ id: string; created_event_seq: number | null }, []>(
      "select id, created_event_seq from messages order by created_event_seq, created_at, id",
    ).all()).toEqual([
      { id: orphanId, created_event_seq: null },
      { id: anchoredId, created_event_seq: 2 },
    ]);
    expect((await store.messages(sessionId)).map((message) => String(message.id))).toEqual([orphanId, anchoredId]);
  } finally {
    older.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const existingSequenceColumn of [false, true]) {
  test(`migrates old message order from first scoped creation events (${existingSequenceColumn ? "resumed" : "new"} column)`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "chili-store-message-order-migration-"));
    const path = join(dir, "events.sqlite");
    const db = new Database(path, { create: true, strict: true });
    db.exec(`
      create table events (
        seq integer primary key,
        id text not null unique,
        type text not null,
        time integer not null,
        session_id text,
        payload_json text not null
      );
      create table messages (
        id text primary key,
        session_id text not null,
        role text not null,
        parent_id text,
        created_at integer not null
        ${existingSequenceColumn ? ", created_event_seq integer" : ""}
      );
    `);
    const insertEvent = db.query(`insert into events (seq, id, type, time, session_id, payload_json)
      values (?, ?, 'message.created', ?, ?, ?)`);
    insertEvent.run(1, "event_wrong_session", 0, "other_session", JSON.stringify({ messageId: "legacy_z", role: "user" }));
    insertEvent.run(20, "event_legacy_user", 100, sessionId, JSON.stringify({ messageId: "message_z", role: "user" }));
    insertEvent.run(21, "event_legacy_assistant", 100, sessionId, JSON.stringify({ messageId: "message_a", role: "assistant" }));
    insertEvent.run(22, "event_legacy_followup", 50, sessionId, JSON.stringify({ messageId: "message_b", role: "user" }));
    insertEvent.run(30, "event_duplicate_user", 200, sessionId, JSON.stringify({ messageId: "message_z", role: "user" }));
    const insertMessage = db.query(`insert into messages (id, session_id, role, created_at) values (?, ?, ?, ?)`);
    // Projection insertion order, IDs, and timestamps all disagree with events.
    insertMessage.run("message_a", sessionId, "assistant", 100);
    insertMessage.run("message_b", sessionId, "user", 50);
    insertMessage.run("message_z", sessionId, "user", 100);
    insertMessage.run("legacy_z", sessionId, "user", 500);
    insertMessage.run("legacy_a", sessionId, "user", 500);
    db.close();

    let store = new SqliteEventStore(path);
    try {
      const expected = ["legacy_a", "legacy_z", "message_z", "message_a", "message_b"];
      expect((await store.messages(sessionId)).map((message) => String(message.id))).toEqual(expected);
      const migrated = new Database(path, { readonly: true, strict: true });
      try {
        expect(migrated.query<{ id: string; created_event_seq: number | null }, []>(
          "select id, created_event_seq from messages order by created_event_seq, created_at, id",
        ).all()).toEqual([
          { id: "legacy_a", created_event_seq: null },
          { id: "legacy_z", created_event_seq: null },
          { id: "message_z", created_event_seq: 20 },
          { id: "message_a", created_event_seq: 21 },
          { id: "message_b", created_event_seq: 22 },
        ]);
      } finally {
        migrated.close();
      }

      await store.append(creation("event_after_migration", "message_0_new" as MessageId, "assistant", 0));
      // A late creation for an unanchored projection must not invent its origin.
      await store.append(creation("event_legacy_z_late", "legacy_z" as MessageId, "user", 1));
      store.close();
      store = new SqliteEventStore(path);
      expect((await store.messages(sessionId)).map((message) => String(message.id))).toEqual([...expected, "message_0_new"]);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("migrates pre-sequence events using their durable insertion order after legacy session identity migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-legacy-message-order-"));
  const path = join(dir, "events.sqlite");
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
    create table events (
      id text primary key,
      type text not null,
      time integer not null,
      session_id text,
      thread_id text,
      payload_json text not null
    );
    create table messages (
      id text primary key,
      session_id text,
      thread_id text,
      role text not null,
      parent_id text,
      created_at integer not null
    );
    insert into events values
      ('event_z_user', 'message.created', 100, 'session_message_order', 'thread_legacy', '{"messageId":"message_z","role":"user"}'),
      ('event_a_assistant', 'message.created', 50, null, 'thread_legacy', '{"messageId":"message_a","role":"assistant"}');
    insert into messages values
      ('message_a', null, 'thread_legacy', 'assistant', null, 50),
      ('message_z', null, 'thread_legacy', 'user', null, 100);
  `);
  db.close();
  const store = new SqliteEventStore(path);

  try {
    expect((await store.messages(sessionId)).map((message) => String(message.id))).toEqual(["message_z", "message_a"]);
    await store.append(creation("event_new", "message_0" as MessageId, "user", 0));
    expect((await store.messages(sessionId)).map((message) => String(message.id))).toEqual(["message_z", "message_a", "message_0"]);
    const older = new Database(path, { strict: true });
    try {
      appendOlderCreation(older, creation("event_older_writer", "message_older" as MessageId, "assistant", -1));
      expect((await store.messages(sessionId)).map((message) => String(message.id))).toEqual([
        "message_z", "message_a", "message_0", "message_older",
      ]);
    } finally {
      older.close();
    }
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
): Extract<ChiliEvent, { type: "message.created" }> {
  return {
    id,
    type: "message.created",
    sessionId,
    time: time as TimestampMs,
    payload: { messageId, role, turnId },
  };
}

function appendOlderCreation(
  db: Database,
  event: Extract<ChiliEvent, { type: "message.created" }>,
): void {
  // Match the prior store's transaction order and INSERT column list.
  db.transaction(() => {
    db.query(`insert into events (seq, id, type, time, session_id, payload_json)
      values ((select coalesce(max(seq), 0) + 1 from events), ?, ?, ?, ?, ?)`).run(
      event.id, event.type, event.time, event.sessionId ?? null, JSON.stringify(event.payload),
    );
    db.query(`insert into messages (id, session_id, turn_id, role, parent_id, created_at)
      values (?, ?, ?, ?, null, ?) on conflict(id) do nothing`).run(
      event.payload.messageId, event.sessionId ?? null, event.payload.turnId ?? null,
      event.payload.role, event.time,
    );
  })();
}

function textPart(
  id: string,
  messageId: MessageId,
  partId: string,
  text: string,
  time: number,
): ChiliEvent {
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
