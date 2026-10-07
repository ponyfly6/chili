import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { MessagePart, RuntimeEvent, SessionId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "./sqlite-event-store.js";
import { EventPageTooLargeError } from "./types.js";

const sessionId = "session_content_files" as SessionId;
const event = (id: string, type: string, payload: unknown): RuntimeEvent => ({ id, type, payload, sessionId, time: 1 as TimestampMs }) as RuntimeEvent;
const dbOf = (store: SqliteEventStore): Database => (store as unknown as { db: Database }).db;

async function contentFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const scope of await readdir(directory)) {
    for (const file of await readdir(join(directory, scope))) files.push(join(directory, scope, file));
  }
  return files;
}

test("tool output is saved once across events, projections, structured results and request snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-content-shared-"));
  const path = join(directory, "events.sqlite");
  let store = new SqliteEventStore(path);
  const output = 'Result:你好 "quoted"\n'.repeat(1_000);
  const part = { id: "part_result", messageId: "message", sessionId, type: "tool_result", callId: "call", output,
    structuredData: { output }, content: [{ type: "text", text: output }] } as unknown as MessagePart;
  const events = [
    event("session", "session.created", { sessionId, cwd: "/repo" }),
    event("message", "message.created", { messageId: "message", role: "assistant" }),
    event("started", "tool.call_started", { callId: "call", turnId: "turn", toolName: "read", input: { path: "README.md" } }),
    event("finished", "tool.call_finished", { callId: "call", status: "completed", output }),
    event("result", "message.part_added", { messageId: "message", part }),
    event("request", "model.request_prepared", { requestId: "request", turnId: "turn", attempt: 1,
      request: { contentVersion: "v1", messages: [{ parts: [part] }] } }),
  ];
  try {
    await store.appendMany(events);
    const db = dbOf(store);
    const storedEvent = JSON.parse(db.query<{ payload_json: string }, []>("select payload_json from events where id = 'finished'").get()!.payload_json);
    const storedPart = JSON.parse(db.query<{ data_json: string }, []>("select data_json from message_parts").get()!.data_json);
    const storedTool = JSON.parse(db.query<{ output: string }, []>("select output from tool_calls").get()!.output);
    expect(storedEvent.output).toEqual(storedPart.output);
    expect(storedEvent.output).toEqual(storedTool.value);
    for (const row of db.query<{ payload_json: string }, []>("select payload_json from events").all()) expect(row.payload_json).not.toContain("Result:你好");
    const files = await contentFiles(join(directory, "contents", "events.sqlite"));
    const bodies = await Promise.all(files.map((file) => readFile(file, "utf8")));
    expect(bodies.filter((body) => body === output)).toHaveLength(1);
    expect(bodies.filter((body) => body.includes("Result:你好"))).toHaveLength(1);
    store.close();
    store = new SqliteEventStore(path);
    expect(await store.events()).toEqual(events);
    expect((await store.messages(sessionId))[0]!.parts).toEqual([part]);
    expect((await store.runtimeSnapshot({ sessionId })).events.find((item) => item.type === "tool.call_finished")?.payload).toMatchObject({ callId: "call", status: "completed" });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("event byte budgets use resolved Unicode bytes and reject oversized references before opening files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-content-budget-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  try {
    const small = event("small", "tool.call_finished", { callId: "small", status: "completed", output: "好" });
    const large = event("large", "tool.call_finished", { callId: "large", status: "completed", output: "大".repeat(10_000) });
    await store.appendMany([small, large]);
    expect(await store.events({ limit: 1, maxBytes: Buffer.byteLength(JSON.stringify(small)) })).toEqual([small]);
    await rm(join(directory, "contents"), { recursive: true, force: true });
    await expect(store.events({ afterEventId: "small", maxBytes: 1_000 })).rejects.toBeInstanceOf(EventPageTooLargeError);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy inline content and caller objects shaped like references remain ordinary data", async () => {
  const store = new SqliteEventStore(":memory:");
  const fake = { $chiliContent: { key: "not-a-real-reference", bytes: 10, jsonBytes: 12, encoding: "text" } };
  const raw = event("legacy", "tool.call_started", { callId: "legacy", turnId: "turn", toolName: "inspect", input: fake });
  try {
    const db = dbOf(store);
    db.query("insert into events (id, type, time, session_id, payload_json) values (?, ?, ?, ?, ?)").run(raw.id, raw.type, raw.time, sessionId, JSON.stringify(raw.payload));
    const current = event("new", "tool.call_started", { callId: "new", turnId: "turn", toolName: "inspect", input: fake });
    await store.append(current);
    expect(await store.events()).toEqual([raw, current]);
    const metadata = event("metadata", "approval.requested", { approvalId: "approval", permission: "read", patterns: [], metadata: { arbitrary: fake } });
    await store.append(metadata);
    expect((await store.events({ type: "approval.requested" }))[0]).toEqual(metadata);
  } finally { store.close(); }
});

test("committed parts keep first-generation order when blocks finish out of order", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    await store.append(event("message", "message.created", { messageId: "message", role: "assistant" }));
    const parts = [
      { id: "reasoning", messageId: "message", sessionId, type: "reasoning", text: "Thinking", ordinal: 0, completion: "completed" },
      { id: "text", messageId: "message", sessionId, type: "text", text: "Answer", ordinal: 1, completion: "completed" },
    ] as unknown as MessagePart[];
    await store.append(event("text_commit", "message.part_committed", { messageId: "message", part: parts[1] }));
    await store.append(event("reasoning_commit", "message.part_committed", { messageId: "message", part: parts[0] }));
    expect((await store.messages(sessionId))[0]!.parts).toEqual(parts);
    expect(await store.events({ type: "message.part_delta" })).toEqual([]);
  } finally { store.close(); }
});

test("opening the previous event schema keeps inline history and adds only budget metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-content-legacy-"));
  const path = join(directory, "events.sqlite");
  const legacy = event("old", "tool.call_finished", { callId: "call", status: "completed", output: "Old inline result" });
  const database = new Database(path);
  database.exec("create table events (seq integer primary key autoincrement, id text not null unique, type text not null, time integer not null, session_id text, payload_json text not null)");
  database.query("insert into events (id, type, time, session_id, payload_json) values (?, ?, ?, ?, ?)").run(legacy.id, legacy.type, legacy.time, sessionId, JSON.stringify(legacy.payload));
  database.close();
  const store = new SqliteEventStore(path);
  try {
    expect(await store.events({ maxBytes: 1_024 })).toEqual([legacy]);
    const row = dbOf(store).query<{ payload_json: string; payload_bytes: number | null }, []>("select payload_json, payload_bytes from events").get()!;
    expect(row.payload_json).toBe(JSON.stringify(legacy.payload));
    expect(row.payload_bytes).toBeNull();
    const next = event("next", "tool.call_finished", { callId: "next", status: "completed", output: "New file result" });
    await store.append(next);
    expect(await store.events({ maxBytes: 1_024 })).toEqual([legacy, next]);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy previews and tool inputs that resemble encoded wrappers remain literal user content", async () => {
  const store = new SqliteEventStore(":memory:");
  const text = '{"__chiliStoredValue":1, example';
  const input = { __chiliStoredValue: 1, value: { $chiliContent: { key: "not-a-real-file", bytes: 10, jsonBytes: 12, encoding: "text" } }, important: "keep this field" };
  try {
    await store.appendMany([
      event("session", "session.created", { sessionId, cwd: "/repo" }),
      event("message", "message.created", { messageId: "message", role: "user" }),
    ]);
    const part = { id: "legacy_part", messageId: "message", sessionId, type: "text", text };
    const db = dbOf(store);
    db.query("insert into message_parts (id, message_id, session_id, type, ordinal, data_json, created_at) values (?, ?, ?, 'text', 0, ?, 1)")
      .run(part.id, part.messageId, sessionId, JSON.stringify(part));
    db.query("insert into tool_calls (id, session_id, turn_id, tool_name, status, input_json, output, started_at, updated_at) values ('legacy_call', ?, 'turn', 'inspect', 'completed', ?, ?, 1, 1)")
      .run(sessionId, JSON.stringify(input), text);
    expect((await store.sessions())[0]?.preview).toBe(text);
    expect((await store.messages(sessionId))[0]?.parts[0]).toEqual(part as unknown as MessagePart);
    const snapshot = await store.runtimeSnapshot({ sessionId });
    expect(snapshot.events.find((entry) => entry.type === "tool.call_started")?.payload).toMatchObject({ input });
    expect(snapshot.events.find((entry) => entry.type === "tool.call_finished")?.payload).toMatchObject({ output: text });
  } finally { store.close(); }
});
