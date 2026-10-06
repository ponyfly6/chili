import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "./sqlite-event-store.js";

for (const existingColumn of [undefined, "provider_call_id", "parent_call_id"] as const) {
  test(`migrates ${existingColumn ?? "legacy"} tool rows and preserves nested calls across reopen without model messages`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "chili-nested-tools-"));
    const path = join(dir, "events.sqlite");
    const legacy = new Database(path);
    legacy.exec(`create table tool_calls (
      id text primary key, ${existingColumn ? `${existingColumn} text,` : ""} session_id text, turn_id text, tool_name text not null,
      status text not null, input_json text, output text, error text,
      synthetic integer not null default 0, started_at integer not null, updated_at integer not null
    )`);
    legacy.query(`insert into tool_calls (id, tool_name, status, started_at, updated_at)
      values ('legacy_read', 'read', 'completed', 1, 1)`).run();
    if (existingColumn) legacy.query(`update tool_calls set ${existingColumn} = 'legacy_identity' where id = 'legacy_read'`).run();
    legacy.close();
    const sessionId = "session_nested_tools" as SessionId;
    const turnId = "turn_nested_tools" as TurnId;
    const parentCallId = "call_script" as ToolCallId;
    const callId = "call_read" as ToolCallId;
    const events: ChiliEvent[] = [
      {
        id: "event_script_started", type: "tool.call_started", time: 2 as TimestampMs, sessionId,
        payload: { turnId, callId: parentCallId, providerCallId: "provider_script", toolName: "code_mode", input: { code: "await tools.read({filePath:'README.md'})" } },
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
      expect(await store.events({ sessionId, compactRequests: true })).toEqual(events);
      expect(await store.messages(sessionId)).toEqual([]);
      const db = new Database(path, { readonly: true });
      try {
        expect(db.query("select parent_call_id, provider_call_id from tool_calls where id = 'legacy_read'").get())
          .toEqual({
            parent_call_id: existingColumn === "parent_call_id" ? "legacy_identity" : null,
            provider_call_id: existingColumn === "provider_call_id" ? "legacy_identity" : null,
          });
        expect(db.query("select id, provider_call_id, parent_call_id, status, output from tool_calls where parent_call_id = ?").all(parentCallId))
          .toEqual([{ id: callId, provider_call_id: null, parent_call_id: parentCallId, status: "completed", output: "file contents" }]);
        expect(db.query("select provider_call_id, parent_call_id from tool_calls where id = ?").get(parentCallId))
          .toEqual({ provider_call_id: "provider_script", parent_call_id: null });
      } finally {
        db.close();
      }
    } finally {
      store?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("provider identifiers can repeat while nested internal identities remain fenced by session and turn", async () => {
  const store = new SqliteEventStore(":memory:");
  const sessionId = "session_a" as SessionId;
  const turnId = "turn_a" as TurnId;
  const parentCallId = "parent_a" as ToolCallId;
  const callId = "child_a" as ToolCallId;
  const first: Extract<ChiliEvent, { type: "tool.call_started" }> = {
    id: "start_child_a", type: "tool.call_started", time: 2 as TimestampMs, sessionId,
    payload: { turnId, callId, parentCallId, providerCallId: "provider_reused", toolName: "read", input: {} },
  };
  try {
    await store.appendMany([
      {
        id: "start_parent_a", type: "tool.call_started", time: 1 as TimestampMs, sessionId,
        payload: { turnId, callId: parentCallId, providerCallId: "provider_parent_reused", toolName: "code_mode", input: {} },
      },
      first,
      {
        id: "start_parent_b", type: "tool.call_started", time: 3 as TimestampMs, sessionId: "session_b" as SessionId,
        payload: { turnId: "turn_b" as TurnId, callId: "parent_b" as ToolCallId, providerCallId: "provider_parent_reused", toolName: "code_mode", input: {} },
      },
      {
        ...first, id: "start_child_b", sessionId: "session_b" as SessionId, time: 4 as TimestampMs,
        payload: { ...first.payload, turnId: "turn_b" as TurnId, callId: "child_b" as ToolCallId, parentCallId: "parent_b" as ToolCallId },
      },
      {
        id: "update_child_a", type: "tool.call_updated", sessionId, time: 5 as TimestampMs,
        payload: { callId, providerCallId: "provider_reused", status: "running" },
      },
    ]);
    await expect(store.append({ ...first, id: "wrong_session", sessionId: "session_b" as SessionId }))
      .rejects.toThrow("Tool call identity conflict");
    await expect(store.append({ ...first, id: "wrong_turn", payload: { ...first.payload, turnId: "turn_b" as TurnId } }))
      .rejects.toThrow("Tool call identity conflict");
    await expect(store.append({
      id: "wrong_finish", type: "tool.call_finished", sessionId: "session_b" as SessionId, time: 6 as TimestampMs,
      payload: { callId, status: "completed" },
    })).rejects.toThrow("Tool call identity conflict");
    const db = (store as unknown as { db: Database }).db;
    expect(db.query("select id, parent_call_id, provider_call_id from tool_calls where provider_call_id = ? order by id").all("provider_reused"))
      .toEqual([
        { id: "child_a", parent_call_id: "parent_a", provider_call_id: "provider_reused" },
        { id: "child_b", parent_call_id: "parent_b", provider_call_id: "provider_reused" },
      ]);
    expect((await store.events({ sessionId })).map((event) => event.id))
      .toEqual(["start_parent_a", "start_child_a", "update_child_a"]);
  } finally {
    store.close();
  }
});
