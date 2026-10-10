import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionId } from "@chili/protocol";
import { SqliteEventStore } from "./sqlite-event-store.js";
import { ObservableEventStore } from "./observable-event-store.js";

const sid = "history" as SessionId;
const event = (id: string, type: string, payload: unknown, sessionId = sid): RuntimeEvent => ({ id, type, payload, time: 1, sessionId }) as RuntimeEvent;
async function fixture(run: (store: SqliteEventStore) => Promise<void>) {
  const store = new SqliteEventStore(":memory:");
  try { await store.append(event("created", "session.created", { sessionId: sid, cwd: "/repo" })); await run(store); }
  finally { store.close(); }
}
async function message(store: SqliteEventStore, id: string, text: string) {
  await store.append(event(`m_${id}`, "message.created", { messageId: id, role: "assistant" }));
  await store.append(event(`p_${id}`, "message.part_added", { messageId: id, part: { id: `part_${id}`, messageId: id, sessionId: sid, type: "text", text } }));
}

test("message pagination crosses oversized content and equal timestamps without losing a message", async () => fixture(async (store) => {
  for (let i = 0; i < 53; i++) await message(store, `message_${53 - i}`, i === 26 ? "大🙂".repeat(700_000) : `text ${i}`);
  const ids: string[] = [];
  let beforeMessageId: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await store.conversationPage({ sessionId: sid, limit: 10, ...(beforeMessageId ? { beforeMessageId } : {}) });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(100_000);
    ids.unshift(...result.messages.map((message) => message.id));
    beforeMessageId = result.nextBeforeMessageId;
    if (!beforeMessageId) break;
  }
  expect(ids).toEqual(Array.from({ length: 53 }, (_, i) => `message_${53 - i}`));
  expect((await store.historyMessage({ sessionId: sid, messageId: "message_27" })).parts[0]?.hasMore).toBe(true);
}));

test("large Unicode content can be reconstructed through bounded byte cursors", async () => fixture(async (store) => {
  const text = "a🙂中文\n".repeat(80_000);
  await message(store, "large", text);
  let offset = 0;
  let rebuilt = "";
  do {
    const chunk = await store.historyContent({ sessionId: sid, kind: "part", id: "part_large", field: "text", offset });
    expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(32768);
    expect(chunk.text).not.toContain("�");
    rebuilt += chunk.text;
    if (chunk.nextOffset === undefined) break;
    expect(chunk.nextOffset).toBeGreaterThan(offset);
    offset = chunk.nextOffset;
  } while (true);
  expect(rebuilt).toBe(text);
}));

test("message parts page independently so a single huge message never consumes all history", async () => fixture(async (store) => {
  await message(store, "many", "first");
  for (let i = 1; i < 70; i++) await store.append(event(`part_event_${i}`, "message.part_added", { messageId: "many", part: { id: `part_${i}`, messageId: "many", sessionId: sid, type: "text", text: `body ${i}` } }));
  const seen: string[] = [];
  let partOffset = 0;
  do {
    const page = await store.historyMessage({ sessionId: sid, messageId: "many", partOffset });
    seen.push(...page.parts.map((part) => part.id));
    if (page.nextPartOffset === undefined) break;
    partOffset = page.nextPartOffset;
  } while (true);
  expect(new Set(seen).size).toBe(70);
}));

test("legacy uncheckpointed deltas remain readable without replaying or merging the whole transcript", async () => fixture(async (store) => {
  await message(store, "legacy", "base🙂");
  const chunks = ["一".repeat(40_000), "🙂last"];
  for (const [i, delta] of chunks.entries()) await store.append(event(`delta_${i}`, "message.part_delta", { messageId: "legacy", partId: "part_legacy", field: "text", delta }));
  const preview = (await store.conversationPage({ sessionId: sid })).messages[0]!.parts[0]!;
  expect(preview.hasMore).toBe(true);
  expect(preview.text.startsWith("base🙂一")).toBe(true);
  let offset = 0;
  let rebuilt = "";
  for (;;) {
    const chunk = await store.historyContent({ sessionId: sid, kind: "part", id: preview.id, field: "text", offset });
    rebuilt += chunk.text;
    if (chunk.nextOffset === undefined) break;
    expect(chunk.nextOffset).toBeGreaterThan(offset);
    offset = chunk.nextOffset;
  }
  expect(rebuilt).toBe(`base🙂${chunks.join("")}`);
}));

test("tools carry no arguments or results in message previews and children load separately", async () => fixture(async (store) => {
  await store.append(event("m", "message.created", { messageId: "tool_message", role: "assistant" }));
  await store.append(event("call_part", "message.part_added", { messageId: "tool_message", part: { id: "tool_part", messageId: "tool_message", sessionId: sid, type: "tool_call", callId: "parent", toolName: "code_mode", input: { private: "ARGUMENT_SECRET" }, status: "completed" } }));
  await store.append(event("call_start", "tool.call_started", { callId: "parent", turnId: "turn", toolName: "code_mode", input: { private: "ARGUMENT_SECRET" } }));
  await store.append(event("call_finish", "tool.call_finished", { callId: "parent", status: "completed", output: "RESULT_SECRET".repeat(50_000) }));
  for (let i = 0; i < 55; i++) await store.append(event(`child_${i}`, "tool.call_started", { callId: `nested_${i}`, parentCallId: "parent", turnId: "turn", toolName: "bash", input: { command: "hidden" } }));
  const page = await store.conversationPage({ sessionId: sid });
  expect(JSON.stringify(page)).not.toContain("SECRET");
  expect(JSON.stringify(page)).not.toContain("nested_");
  expect((await store.historyContent({ sessionId: sid, kind: "tool", id: "parent", field: "input" })).text).toContain("ARGUMENT_SECRET");
  expect((await store.historyContent({ sessionId: sid, kind: "tool", id: "parent", field: "output" })).nextOffset).toBeDefined();
  const first = await store.historyTools({ sessionId: sid, parentCallId: "parent" });
  expect(first.tools).toHaveLength(50);
  expect((await store.historyTools({ sessionId: sid, parentCallId: "parent", afterToolId: first.nextAfterToolId! })).tools).toHaveLength(5);
}));

test("history queries reject foreign cursors, messages, parts and tools", async () => fixture(async (store) => {
  await message(store, "known", "hello");
  await expect(store.conversationPage({ sessionId: "foreign", beforeMessageId: "known" })).rejects.toThrow();
  await expect(store.historyMessage({ sessionId: "foreign", messageId: "known" })).rejects.toThrow();
  await expect(store.historyContent({ sessionId: "foreign", kind: "part", id: "part_known", field: "text" })).rejects.toThrow();
  await expect(store.historyTools({ sessionId: sid, parentCallId: "missing" })).rejects.toThrow();
}));

test("oversized tool arguments serialize in bounded chunks without hydrating opaque references", async () => fixture(async (store) => {
  const input = { code: '中文🙂\\\"\n'.repeat(100_000), nested: [true, { literal: { $chiliContent: { key: "untrusted" } } }] };
  await store.append(event("large_input", "tool.call_started", { callId: "large_tool", turnId: "turn", toolName: "code_mode", input }));
  let offset = 0;
  let rebuilt = "";
  for (;;) {
    const chunk = await store.historyContent({ sessionId: sid, kind: "tool", id: "large_tool", field: "input", offset });
    expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(32768);
    rebuilt += chunk.text;
    if (chunk.nextOffset === undefined) break;
    expect(chunk.nextOffset).toBeGreaterThan(offset);
    offset = chunk.nextOffset;
  }
  expect(JSON.parse(rebuilt)).toEqual(input);
}));

test("state-only snapshot does not hydrate even an oversized latest message", async () => fixture(async (store) => {
  await message(store, "huge", "x".repeat(4_100_000));
  const snapshot = await store.runtimeSnapshot({ sessionId: sid, controlsOnly: true });
  expect(snapshot.events.some((event) => event.type.startsWith("message."))).toBe(false);
  expect(snapshot.truncated).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(10_000);
}));

test("in-progress streamed text appears in message previews before the durable commit", async () => fixture(async (store) => {
  const live = new ObservableEventStore(store);
  await live.append(event("live_message", "message.created", { messageId: "live", role: "assistant" }));
  await live.append(event("live_delta", "message.part_stream_delta", { messageId: "live", partId: "stream", partType: "text", delta: "streamed text", offset: 0 }));
  expect((await live.conversationPage!({ sessionId: sid })).messages[0]?.parts[0]?.text).toBe("streamed text");
  expect((await live.historyContent!({ sessionId: sid, kind: "part", id: "stream", field: "text" })).text).toBe("streamed text");
}));
