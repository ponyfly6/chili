import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionId } from "@chili/protocol";
import { SqliteEventStore, ObservableEventStore } from "@chili/store";
import { HttpRuntimeClient } from "@chili/sdk";
import { createRuntimeHttpHandler, type RuntimeHttpService } from "./runtime-http.js";

test("HTTP history reads the requested descendant only and rejects unrelated sessions", async () => {
  const store = new SqliteEventStore(":memory:");
  const append = async (id: string, sessionId: string, type: string, payload: unknown) => store.append({ id, sessionId, type, payload, time: 1 } as RuntimeEvent);
  try {
    await append("root_created", "root", "session.created", { sessionId: "root", cwd: "/repo" });
    await append("child_created", "child", "session.created", { sessionId: "child", cwd: "/repo", agent: { parentSessionId: "root", name: "child", path: "/root/child", policy: {} } });
    await append("other_created", "other", "session.created", { sessionId: "other", cwd: "/other" });
    for (const sessionId of ["root", "child", "other"]) {
      await append(`message_${sessionId}`, sessionId, "message.created", { messageId: `m_${sessionId}`, role: "assistant" });
      await append(`part_${sessionId}`, sessionId, "message.part_added", { messageId: `m_${sessionId}`, part: { id: `p_${sessionId}`, messageId: `m_${sessionId}`, sessionId, type: "text", text: sessionId } });
    }
    const reads: string[] = [];
    const handler = createRuntimeHttpHandler({ store: new ObservableEventStore(store), service: { async assertSessionReadAllowed(id) { reads.push(id); if (id !== "root") throw new Error("root required"); } } as RuntimeHttpService });
    const client = new HttpRuntimeClient({ baseUrl: "http://test", fetch: (async (input, init) => handler(new Request(input, init))) as typeof fetch });
    const root = "root" as SessionId;
    expect((await client.conversationPage({ sessionId: root })).messages[0]?.parts[0]?.text).toBe("root");
    expect((await client.conversationPage({ sessionId: root, targetSessionId: "child" })).messages[0]?.parts[0]?.text).toBe("child");
    expect((await client.historyContent({ sessionId: root, targetSessionId: "child", kind: "part", id: "p_child", field: "text" })).text).toBe("child");
    await expect(client.conversationPage({ sessionId: root, targetSessionId: "other" })).rejects.toThrow();
    await expect(client.historyContent({ sessionId: root, targetSessionId: "child", kind: "part", id: "p_other", field: "text" })).rejects.toThrow();
    expect(new Set(reads)).toEqual(new Set(["root"]));
    const controls = await client.eventSnapshot({ sessionId: root, controlsOnly: true });
    expect(controls.events.some((event) => event.type.startsWith("message."))).toBe(false);
    for (const query of ["limit=0", "limit=51", "partOffset=-1", "kind=tool&id=x&field=bogus", "unknown=1"]) {
      const response = await handler(new Request(`http://test/sessions/root/history?${query}`));
      expect(response.ok).toBe(false);
    }
  } finally { store.close(); }
});
