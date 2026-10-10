import { expect, test } from "bun:test";
import type { ConversationPage, HistoryMessage } from "@chili/protocol";
import { MessageHistory } from "./message-history.js";
const message = (id: string): HistoryMessage => ({ id, sessionId: "s", role: "user", createdAt: 1, parts: [] });
const page = (ids: string[], nextBeforeMessageId?: string): ConversationPage => ({ sessionId: "s", messages: ids.map(message), ...(nextBeforeMessageId ? { nextBeforeMessageId } : {}) });

test("older pages prepend without duplicate boundary messages or timestamp sorting", async () => {
  const history = new MessageHistory(async (before) => before ? page(["z", "b"]) : page(["a", "c"], "a"), () => {});
  await history.refresh(); await history.older();
  expect(history.state.messages.map((message) => message.id)).toEqual(["z", "b", "a", "c"]);
  expect(history.state.before).toBeUndefined();
});
test("refresh bridges multiple new pages after a reconnect without dropping an intermediate message", async () => {
  let initial = true;
  const history = new MessageHistory(async (before) => initial ? page(["a", "b"], "a") : before === "e" ? page(["c", "d"], "c") : before === "c" ? page(["a", "b"], "a") : page(["e", "f"], "e"), () => {});
  await history.refresh(); initial = false; await history.refresh();
  expect(history.state.messages.map((message) => message.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
  expect(history.state.before).toBe("a");
});
test("failed older read preserves content and cursor for retry", async () => {
  let fail = true;
  const history = new MessageHistory(async (before) => { if (!before) return page(["new"], "new"); if (fail) throw new Error("offline"); return page(["old"]); }, () => {});
  await history.refresh(); await history.older();
  expect(history.state.messages[0]?.id).toBe("new"); expect(history.state.before).toBe("new");
  fail = false; await history.older(); expect(history.state.messages[0]?.id).toBe("old");
});
test("unmounted project cannot publish a delayed page", async () => {
  let resolve!: (value: ConversationPage) => void;
  let publications = 0;
  const history = new MessageHistory(() => new Promise((done) => { resolve = done; }), () => { publications++; });
  const pending = history.refresh(); history.dispose(); resolve(page(["old_project"])); await pending;
  expect(publications).toBe(1); expect(history.state.messages).toEqual([]);
});
