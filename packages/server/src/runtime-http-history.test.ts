import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionId, TimestampMs } from "@chili/protocol";
import { HttpRuntimeClient, type RuntimeSessionEventWindow } from "@chili/sdk";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { createRuntimeHttpHandler, type RuntimeHttpService } from "./runtime-http.js";

const sessionId = "history_root" as SessionId;

function event(id: string, type: string, payload: unknown): RuntimeEvent {
  // Deliberately use equal timestamps: paging must follow durable sequence.
  return { id, type, time: 1 as TimestampMs, sessionId, payload } as RuntimeEvent;
}

async function fixture(run: (context: {
  store: SqliteEventStore;
  client: HttpRuntimeClient;
  handler: (request: Request) => Promise<Response>;
}) => Promise<void>): Promise<void> {
  const store = new SqliteEventStore(":memory:");
  await store.append(event("created", "session.created", { sessionId, cwd: "/repo" }));
  const handler = createRuntimeHttpHandler({
    store: new ObservableEventStore(store),
    service: {} as RuntimeHttpService,
    maxSessionEventWindowBytes: 20_000,
  });
  const client = new HttpRuntimeClient({ baseUrl: "http://chili.test", fetch: (
    async (input, init) => handler(new Request(input, init))
  ) as typeof fetch });
  try { await run({ store, client, handler }); } finally { store.close(); }
}

test("SQLite history cursors traverse every retained row without timestamp or ID sorting", async () => {
  await fixture(async ({ store, client }) => {
    const rows = Array.from({ length: 35 }, (_, index) => event(`row_${35 - index}`, "session.renamed", {
      sessionId, title: `history ${index}`,
    }));
    await store.appendMany(rows);
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let beforeEventId: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const window = await client.sessionEventWindow({ sessionId, limit: 6, ...(beforeEventId ? { beforeEventId } : {}) });
      expect(Buffer.byteLength(JSON.stringify(window))).toBeLessThanOrEqual(20_000);
      expect(window.events.length).toBeLessThanOrEqual(6);
      for (const row of window.events) seen.add(row.id);
      beforeEventId = window.nextBeforeEventId;
      if (!beforeEventId) break;
      expect(cursors.has(beforeEventId)).toBe(false);
      cursors.add(beforeEventId);
    }
    expect([...seen].sort()).toEqual(["created", ...rows.map((row) => row.id)].sort());
    expect(cursors.size).toBeGreaterThan(1);
  });
});

test("recovered distant anchors do not skip intervening history", async () => {
  await fixture(async ({ store, client }) => {
    await store.append(event("message", "message.created", { messageId: "message_old", role: "assistant" }));
    const rows = Array.from({ length: 40 }, (_, index) => event(`middle_${index}`, "session.renamed", {
      sessionId, title: `middle ${index}`,
    }));
    await store.appendMany(rows);
    await store.append(event("part", "message.part_added", { messageId: "message_old", part: {
      id: "part_old", messageId: "message_old", sessionId, type: "text", text: "old answer",
    } }));
    let window = await client.sessionEventWindow({ sessionId, limit: 8 });
    expect(window.events.map((row) => row.id)).toContain("message");
    expect(window.nextBeforeEventId).toStartWith("middle_");
    const seen = new Set(window.events.map((row) => row.id));
    for (let page = 0; window.nextBeforeEventId && page < 20; page += 1) {
      window = await client.sessionEventWindow({ sessionId, limit: 8, beforeEventId: window.nextBeforeEventId });
      for (const row of window.events) seen.add(row.id);
    }
    expect(rows.every((row) => seen.has(row.id))).toBe(true);
  });
});

test("historical dependency scans cross multiple SQLite pages without importing future events or pending controls", async () => {
  await fixture(async ({ store, client }) => {
    await store.appendMany(Array.from({ length: 16 }, (_, index) => event(`early_${index}`, "session.renamed", { sessionId, title: "early" })));
    await store.append(event("old_message", "message.created", { messageId: "old_message_id", role: "assistant" }));
    await store.appendMany(Array.from({ length: 18 }, (_, index) => event(`later_${index}`, "session.renamed", { sessionId, title: "later" })));
    await store.append(event("old_part", "message.part_added", { messageId: "old_message_id", part: {
      id: "old_part_id", messageId: "old_message_id", sessionId, type: "text", text: "readable historical answer",
    } }));
    await store.append(event("boundary", "session.renamed", { sessionId, title: "boundary" }));
    await store.append(event("future", "message.created", { messageId: "future_message", role: "assistant" }));
    const window = await client.sessionEventWindow({ sessionId, limit: 6, beforeEventId: "boundary" });
    const ids = window.events.map((row) => row.id);
    expect(ids).toContain("old_message");
    expect(ids).toContain("old_part");
    expect(ids).not.toContain("boundary");
    expect(ids).not.toContain("future");
    expect(window.pendingApprovals).toEqual([]);
  });
});

test("history cursor validation rejects unknown and foreign session cursors", async () => {
  await fixture(async ({ store, handler }) => {
    await store.append({ ...event("foreign", "session.created", { sessionId: "foreign_session", cwd: "/other" }), sessionId: "foreign_session" as SessionId });
    for (const cursor of ["unknown", "foreign", "__proto__", ""]) {
      const response = await handler(new Request(`http://chili.test/sessions/${sessionId}/events?window=replayable&beforeEventId=${cursor}`));
      expect(response.ok).toBe(false);
    }
  });
});

test("historical pages recover nearby message anchors past the initial dependency scan budget", async () => {
  await fixture(async ({ store, client }) => {
    await store.appendMany(Array.from({ length: 4_200 }, (_, index) => event(`old_${index}`, "session.renamed", { sessionId, title: "old" })));
    await store.append(event("recent_message", "message.created", { messageId: "recent_message_id", role: "assistant" }));
    await store.appendMany(Array.from({ length: 20 }, (_, index) => event(`near_${index}`, "session.renamed", { sessionId, title: "near" })));
    await store.append(event("recent_part", "message.part_added", { messageId: "recent_message_id", part: {
      id: "recent_part_id", messageId: "recent_message_id", sessionId, type: "text", text: "answer past the first 4096 events",
    } }));
    await store.append(event("boundary", "session.renamed", { sessionId, title: "boundary" }));
    const window = await client.sessionEventWindow({ sessionId, limit: 6, beforeEventId: "boundary" });
    expect(window.events.map((row) => row.id)).toContain("recent_part");
    expect(window.events.map((row) => row.id)).toContain("recent_message");
    const newest = await client.sessionEventWindow({ sessionId, limit: 6, history: true });
    expect(newest.events.map((row) => row.id)).toContain("recent_part");
    expect(newest.events.map((row) => row.id)).toContain("recent_message");
  });
});

test("the first history page excludes current authoritative approvals and their distant pins", async () => {
  await fixture(async ({ store, client }) => {
    await store.append(event("approval_tool", "tool.call_started", {
      turnId: "turn_approval", callId: "call_approval", toolName: "bash", input: {},
    }));
    await store.append(event("approval_request", "approval.requested", {
      approvalId: "approval_current", callId: "call_approval", permission: "tool.bash", patterns: ["bun test"],
    }));
    await store.appendMany(Array.from({ length: 30 }, (_, index) => event(`title_${index}`, "session.renamed", { sessionId, title: "recent" })));
    expect((await store.pendingApprovals(sessionId)).length).toBe(1);
    const window = await client.sessionEventWindow({ sessionId, limit: 6, history: true });
    expect(window.pendingApprovals).toEqual([]);
    expect(window.events.map((row) => row.id)).not.toContain("approval_request");
    expect(window.events.map((row) => row.id)).not.toContain("approval_tool");
  });
});

test("active pins inside a tail cannot hide intervening evicted rows from paging", async () => {
  await fixture(async ({ store, client }) => {
    await store.append(event("tool_start", "tool.call_started", {
      turnId: "turn_1", callId: "call_1", toolName: "bash", input: {},
    }));
    const rows = Array.from({ length: 10 }, (_, index) => event(`middle_${index}`, "session.renamed", { sessionId, title: "middle" }));
    await store.append(event("active_pin", "tool.call_updated", { callId: "call_1", status: "running" }));
    await store.appendMany(rows);
    let window = await client.sessionEventWindow({ sessionId, limit: 11 });
    expect(window.events.map((row) => row.id)).toContain("active_pin");
    const seen = new Set(window.events.map((row) => row.id));
    for (let page = 0; window.nextBeforeEventId && page < 20; page += 1) {
      window = await client.sessionEventWindow({ sessionId, limit: 11, beforeEventId: window.nextBeforeEventId });
      for (const row of window.events) seen.add(row.id);
    }
    expect(rows.every((row) => seen.has(row.id))).toBe(true);
  });
});

test("a future message anchor cannot make an earlier orphan part appear in a historical page", async () => {
  await fixture(async ({ store, client }) => {
    await store.append(event("orphan", "message.part_added", { messageId: "future_message_id", part: {
      id: "orphan_part", messageId: "future_message_id", sessionId, type: "text", text: "orphan",
    } }));
    await store.append(event("boundary", "session.renamed", { sessionId, title: "boundary" }));
    await store.append(event("future_anchor", "message.created", { messageId: "future_message_id", role: "assistant" }));
    const window = await client.sessionEventWindow({ sessionId, limit: 6, beforeEventId: "boundary" });
    expect(window.events.map((row) => row.id)).not.toContain("future_anchor");
    expect(window.events.map((row) => row.id)).not.toContain("orphan");
    expect(window.truncated).toBe(true);
  });
});

test("concurrent history pages use distinct admission keys", async () => {
  await fixture(async ({ store, client }) => {
    await store.appendMany(Array.from({ length: 20 }, (_, index) => event(`row_${index}`, "session.renamed", { sessionId, title: `${index}` })));
    const [older, newer]: RuntimeSessionEventWindow[] = await Promise.all([
      client.sessionEventWindow({ sessionId, limit: 4, beforeEventId: "row_8" }),
      client.sessionEventWindow({ sessionId, limit: 4, beforeEventId: "row_18" }),
    ]);
    expect(older!.events.at(-1)?.id).toBe("row_7");
    expect(newer!.events.at(-1)?.id).toBe("row_17");
    expect(older!.nextBeforeEventId).not.toBe(newer!.nextBeforeEventId);
  });
});
