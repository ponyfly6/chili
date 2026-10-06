import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "./sqlite-event-store.js";

test("migrates legacy tool rows and preserves nested calls across reopen without model messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-nested-tools-"));
  const path = join(dir, "events.sqlite");
  const legacy = new Database(path);
  legacy.exec(`create table tool_calls (
    id text primary key, session_id text, turn_id text, tool_name text not null,
    status text not null, input_json text, output text, error text,
    synthetic integer not null default 0, started_at integer not null, updated_at integer not null
  )`);
  legacy.query(`insert into tool_calls (id, tool_name, status, started_at, updated_at)
    values ('legacy_read', 'read', 'completed', 1, 1)`).run();
  legacy.close();
  const sessionId = "session_nested_tools" as SessionId;
  const turnId = "turn_nested_tools" as TurnId;
  const parentCallId = "call_script" as ToolCallId;
  const callId = "call_read" as ToolCallId;
  const events: ChiliEvent[] = [
    {
      id: "event_script_started", type: "tool.call_started", time: 2 as TimestampMs, sessionId,
      payload: { turnId, callId: parentCallId, toolName: "code_mode", input: { code: "await tools.read({filePath:'README.md'})" } },
    },
    {
      id: "event_read_started", type: "tool.call_started", time: 3 as TimestampMs, sessionId,
      payload: { turnId, callId, parentCallId, toolName: "read", input: { filePath: "README.md" } },
    },
    {
      id: "event_read_finished", type: "tool.call_finished", time: 4 as TimestampMs, sessionId,
      payload: { callId, status: "completed", output: "file contents" },
    },
    {
      id: "event_script_finished", type: "tool.call_finished", time: 5 as TimestampMs, sessionId,
      payload: { callId: parentCallId, status: "completed", output: "selected result" },
    },
  ];
  let store: SqliteEventStore | undefined;
  try {
    store = new SqliteEventStore(path);
    await store.appendMany(events);
    store.close();
    store = new SqliteEventStore(path);
    expect(await store.events({ sessionId })).toEqual(events);
    expect(await store.messages(sessionId)).toEqual([]);
    const db = new Database(path, { readonly: true });
    try {
      expect(db.query("select parent_call_id from tool_calls where id = 'legacy_read'").get())
        .toEqual({ parent_call_id: null });
      expect(db.query("select id, parent_call_id, status, output from tool_calls where parent_call_id = ?").all(parentCallId))
        .toEqual([{ id: callId, parent_call_id: parentCallId, status: "completed", output: "file contents" }]);
    } finally {
      db.close();
    }
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
