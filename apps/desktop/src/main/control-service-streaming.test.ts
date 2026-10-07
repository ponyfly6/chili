import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId } from "@chili/protocol";
import { HttpRuntimeClient } from "@chili/sdk";
import { createRuntimeHttpHandler, type RuntimeHttpService } from "@chili/server";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { DesktopControlService } from "./control-service.js";
import { emptyInputQueue } from "./testing/input-receipts.js";
import { parseDesktopResponse } from "../shared/contracts.js";
import { appendRuntimeEvent, presentSession } from "../renderer/view-model.js";

test("opening an already-streaming root restores root and child prefixes before subsequent deltas", async () => {
  const fixture = await streamingFixture();
  const { base, store, service } = fixture;
  try {
    const historicalText = "earlier complete answer ".repeat(1_000);
    await store.appendMany([
      event("old_message", "message.created", "root", { messageId: "message_old", role: "assistant" }, 4),
      event("old_answer", "message.part_committed", "root", {
        messageId: "message_old", part: { id: "part_old", messageId: "message_old", sessionId: "root", type: "text", text: historicalText, completion: "completed" },
      }, 5),
      streamDelta("root_prefix", "root", "hello", 0),
      streamDelta("child_prefix", "child", "思考😀", 0),
    ]);
    expect((await base.events()).some((row) => row.type === "message.part_stream_delta")).toBe(false);
    const request = { type: "session.snapshot", sessionId: "root" } as const;
    let snapshot = parseDesktopResponse(request, await service.invoke(request));
    let view = presentSession(snapshot).runtime;
    expect(view.messages.message_root?.parts[0]).toMatchObject({ text: "hello" });
    expect(view.messages.message_child?.parts[0]).toMatchObject({ type: "reasoning", text: "思考😀" });
    // Bounded recovery history must not replace a complete historical file read.
    expect(view.messages.message_old?.parts[0]).toMatchObject({ text: historicalText });
    expect(snapshot.events.filter((row) => row.type === "message.part_stream_snapshot")).toHaveLength(2);

    const unsubscribe = store.subscribe((row) => { snapshot = appendRuntimeEvent(snapshot, row); });
    try {
      await store.append(streamDelta("root_suffix", "root", " world", 5));
      await store.append(streamDelta("child_suffix", "child", "完成", "思考😀".length));
    } finally { unsubscribe(); }
    view = presentSession(snapshot).runtime;
    expect(view.messages.message_root?.parts[0]).toMatchObject({ text: "hello world" });
    expect(view.messages.message_child?.parts[0]).toMatchObject({ text: "思考😀完成" });
    expect(view.partStreamGaps).toEqual({});

    const refreshed = parseDesktopResponse(request, await service.invoke(request));
    expect(presentSession(refreshed).runtime.messages.message_root?.parts[0]).toMatchObject({ text: "hello world" });
    expect(presentSession(refreshed).runtime.messages.message_child?.parts[0]).toMatchObject({ text: "思考😀完成" });
  } finally { base.close(); }
});

test("a block committed between active capture and history read replaces its captured prefix", async () => {
  const { base, store, client, service } = await streamingFixture();
  try {
    await store.append(streamDelta("root_prefix", "root", "hello", 0));
    const readHistory = client.sessionEventWindow.bind(client);
    let committed = false;
    client.sessionEventWindow = async (input) => {
      if (input.sessionId === "root" && !committed) {
        committed = true;
        await store.append(event("root_committed", "message.part_committed", "root", {
          messageId: "message_root", part: {
            id: "part_root", messageId: "message_root", sessionId: "root", type: "text", text: "hello world", completion: "completed",
          },
        }, 20));
      }
      return readHistory(input);
    };
    const snapshot = await service.invoke({ type: "session.snapshot", sessionId: "root" });
    expect(presentSession(snapshot).runtime.messages.message_root?.parts[0]).toMatchObject({ text: "hello world", completion: "completed" });
    expect(snapshot.events.some((row) => row.type === "message.part_stream_snapshot" && row.sessionId === "root")).toBe(false);
  } finally { base.close(); }
});

async function streamingFixture() {
  const base = new SqliteEventStore(":memory:");
  const store = new ObservableEventStore(base);
  await store.appendMany([
    event("session_root", "session.created", "root", { sessionId: "root", cwd: "/repo" }, 1),
    event("session_child", "session.created", "child", {
      sessionId: "child", cwd: "/repo", agent: { parentSessionId: "root", name: "child", path: "/root/child", policy: {} },
    }, 2),
    event("message_root", "message.created", "root", { messageId: "message_root", role: "assistant" }, 3),
    event("message_child", "message.created", "child", { messageId: "message_child", role: "assistant" }, 3),
  ]);
  const handler = createRuntimeHttpHandler({
    store,
    service: {
      assertSessionReadAllowed: async () => undefined,
      inputQueue: (sessionId: SessionId) => emptyInputQueue(sessionId),
    } as unknown as RuntimeHttpService,
    agents: { forSession: () => ({ listAgents: async () => [
      { agentId: "child", name: "child", path: "/root/child", parentAgentId: "root", state: "running" },
    ] }) } as never,
    userInputs: { list: async () => [], resolve: async () => false },
  });
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test",
    fetch: ((input, init) => handler(new Request(input, init))) as typeof fetch,
  });
  const service = new DesktopControlService({
    sidecar: {
      state: () => ({ sidecar: { phase: "healthy", attempt: 0 }, queuedBySession: {} }),
      getClient: () => client,
      getClientContext: () => ({ client, generation: 1 }),
      currentGeneration: () => 1,
      currentWorkspace: () => "/repo",
      setQueuedCount: () => undefined,
    } as never,
    selectWorkspace: async () => undefined,
    persistWorkspace: async () => undefined,
    emitQueue: () => undefined,
    onError: () => undefined,
  });
  return { base, store, client, service };
}

function streamDelta(id: string, sessionId: string, delta: string, offset: number): ChiliEvent {
  return event(id, "message.part_stream_delta", sessionId, {
    messageId: `message_${sessionId}`, partId: `part_${sessionId}`, partType: sessionId === "child" ? "reasoning" : "text",
    delta, offset, ordinal: 0,
  }, 10 + offset);
}

function event(id: string, type: string, sessionId: string, payload: unknown, time: number): ChiliEvent {
  return { id, type, sessionId, payload, time } as ChiliEvent;
}
