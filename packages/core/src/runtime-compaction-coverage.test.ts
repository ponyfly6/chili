import { afterEach, expect, test } from "bun:test";
import type { EventAppendOptions } from "@chili/store";
import { SqliteEventStore } from "@chili/store";
import type { PreparedModelRequest, RuntimeEvent, SessionId } from "@chili/protocol";
import { InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import { messagesForContext } from "./cancelled-turn-context.js";
import { compactedMessageView } from "./context/window.js";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";
import { SingleAgentRuntime, type SingleAgentRuntimeOptions } from "./single-agent-runtime.js";
import { RuntimeService } from "./runtime-service.js";

const stores: SqliteEventStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(model: ModelRouter, options: Partial<SingleAgentRuntimeOptions> = {}, store = new SqliteEventStore(":memory:")) {
  if (!stores.includes(store)) stores.push(store);
  const registry = new InMemoryToolRegistry();
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({ registry, events: { publish: (event) => store.append(event) }, gate: { review: async () => ({ decision: "allow" }) } }),
    retryPolicy: { maxAttempts: 1 },
    ...options,
  });
  return { store, runtime };
}

function isCompaction(input: ModelStreamInput): boolean {
  return input.system.some((text) => text.includes("context compression engine"));
}

function requestText(input: ModelStreamInput): string {
  return input.messages.flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

async function committedSummaries(store: SqliteEventStore, sessionId: SessionId) {
  return (await store.messages(sessionId)).filter((message) => message.parts.some((part) => part.type === "compaction"));
}

test("failed automatic compaction never sends the budget-evicted history and leaves the original usable", async () => {
  let mainRequests = 0;
  const failed = fixture({
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      if (isCompaction(input)) throw new Error("summary unavailable");
      mainRequests++;
      yield { type: "finish", reason: "stop" };
    },
  }, { contextBudget: { maxInputChars: 200, preserveRecentMessages: 1 } });
  const sessionId = await failed.runtime.createSession({ cwd: "/repo" });
  const oldId = await failed.runtime.appendUserMessage({ sessionId, text: `ORIGINAL_CONSTRAINT ${"x".repeat(500)}` });
  const recentId = await failed.runtime.appendUserMessage({ sessionId, text: "current request" });
  const result = await failed.runtime.runTurn({ sessionId, cwd: "/repo" });
  expect(result.status).toBe("failed");
  expect(mainRequests).toBe(0);
  expect(await committedSummaries(failed.store, sessionId)).toHaveLength(0);
  expect((await messagesForContext(failed.store, sessionId)).map((message) => message.id)).toEqual([oldId, recentId]);

  const resumed = fixture({
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      expect(isCompaction(input)).toBe(false);
      expect(requestText(input)).toContain("ORIGINAL_CONSTRAINT");
      expect(input.messages.map((message) => message.id)).toEqual([oldId, recentId]);
      yield { type: "text_delta", text: "continued" };
      yield { type: "finish", reason: "stop" };
    },
  }, { contextBudget: { maxInputChars: 10_000 } }, failed.store);
  expect((await resumed.runtime.runTurn({ sessionId, cwd: "/repo" })).status).toBe("completed");
});

test("failed proactive compaction can continue when the complete original history still fits", async () => {
  let mainRequests = 0;
  const { runtime, store } = fixture({
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      if (isCompaction(input)) throw new Error("temporary summary failure");
      mainRequests++;
      expect(requestText(input)).toContain("KEEP_COMPLETE_HISTORY");
      yield { type: "text_delta", text: "done" };
      yield { type: "finish", reason: "stop" };
    },
  }, { contextBudget: { maxInputChars: 1_000, compactionThresholdRatio: 0.1, preserveRecentMessages: 0 } });
  const sessionId = await runtime.createSession({ cwd: "/repo" });
  await runtime.appendUserMessage({ sessionId, text: `KEEP_COMPLETE_HISTORY ${"x".repeat(150)}` });
  expect((await runtime.runTurn({ sessionId, cwd: "/repo" })).status).toBe("completed");
  expect(mainRequests).toBe(1);
  expect(await committedSummaries(store, sessionId)).toHaveLength(0);
});

test("automatic compaction rejects summary plus retained tail before committing any replacement", async () => {
  let mainRequests = 0;
  const { runtime, store } = fixture({
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      if (!isCompaction(input)) mainRequests++;
      yield { type: "text_delta", text: `<context_summary>${"s".repeat(100)}</context_summary>` };
      yield { type: "finish", reason: "stop" };
    },
  }, { contextBudget: { maxInputChars: 200, preserveRecentMessages: 1 } });
  const sessionId = await runtime.createSession({ cwd: "/repo" });
  const oldId = await runtime.appendUserMessage({ sessionId, text: "x".repeat(500) });
  const tailId = await runtime.appendUserMessage({ sessionId, text: "tail".repeat(15) });
  expect((await runtime.runTurn({ sessionId, cwd: "/repo" })).status).toBe("failed");
  expect(mainRequests).toBe(0);
  expect(await committedSummaries(store, sessionId)).toHaveLength(0);
  expect((await messagesForContext(store, sessionId)).map((message) => message.id)).toEqual([oldId, tailId]);
});

test("manual compaction validates the complete summary against the request budget before commit", async () => {
  const { runtime, store } = fixture({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", text: `<context_summary>${"s".repeat(300)}</context_summary>` };
      yield { type: "finish", reason: "stop" };
    },
  }, { contextBudget: { maxInputChars: 200 } });
  const sessionId = await runtime.createSession({ cwd: "/repo" });
  const sourceId = await runtime.appendUserMessage({ sessionId, text: "x".repeat(500) });
  expect((await runtime.compactContext({ sessionId })).status).toBe("failed");
  expect(await committedSummaries(store, sessionId)).toHaveLength(0);
  expect((await messagesForContext(store, sessionId)).map((message) => message.id)).toEqual([sourceId]);
});

test("manual compaction rejects a summary that a later message-part limit would truncate", async () => {
  const { runtime, store } = fixture({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", text: `<context_summary>${"s".repeat(200)}</context_summary>` };
      yield { type: "finish", reason: "stop" };
    },
  }, { contextBudget: { maxInputChars: 10_000, maxMessagePartChars: 100 } });
  const sessionId = await runtime.createSession({ cwd: "/repo" });
  await runtime.appendUserMessage({ sessionId, text: "x".repeat(500) });
  const result = await runtime.compactContext({ sessionId });
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("truncate the context summary");
  expect(await committedSummaries(store, sessionId)).toHaveLength(0);
});

for (const failAt of ["draft", "verification", "cancel"] as const) {
  test(`manual ${failAt} failure leaves the previous boundary and original history usable`, async () => {
    const controller = new AbortController();
    let requests = 0;
    const { runtime, store } = fixture({
      async *stream(input): AsyncIterable<ModelStreamEvent> {
        requests++;
        if (failAt === "draft" || (failAt === "verification" && requests === 2)) throw new Error("summary request failed");
        if (failAt === "cancel") controller.abort();
        yield { type: "text_delta", text: "<context_summary>draft</context_summary>" };
        yield { type: "finish", reason: "stop" };
      },
    });
    const sessionId = await runtime.createSession({ cwd: "/repo" });
    const sourceId = await runtime.appendUserMessage({ sessionId, text: "unmodified source" });
    expect((await runtime.compactContext({ sessionId, signal: controller.signal })).status).toBe(failAt === "cancel" ? "cancelled" : "failed");
    expect(await committedSummaries(store, sessionId)).toHaveLength(0);
    expect((await messagesForContext(store, sessionId)).map((message) => message.id)).toEqual([sourceId]);
  });
}

test("manual compaction commits as one store batch and the next model request uses its summary", async () => {
  const batches: RuntimeEvent[][] = [];
  class RecordingStore extends SqliteEventStore {
    override async appendMany(events: readonly RuntimeEvent[], options?: EventAppendOptions): Promise<void> {
      batches.push([...events]);
      await super.appendMany(events, options);
    }
  }
  const store = new RecordingStore(":memory:");
  const { runtime } = fixture({
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      if (isCompaction(input)) {
        yield { type: "text_delta", text: "<context_summary>committed handoff</context_summary>" };
      } else {
        expect(requestText(input)).toContain("committed handoff");
        expect(requestText(input)).not.toContain("original source");
        yield { type: "text_delta", text: "continued" };
      }
      yield { type: "finish", reason: "stop" };
    },
  }, {}, store);
  const sessionId = await runtime.createSession({ cwd: "/repo" });
  await runtime.appendUserMessage({ sessionId, text: "original source" });
  expect((await runtime.compactContext({ sessionId })).status).toBe("completed");
  expect(batches).toHaveLength(1);
  expect(batches[0]?.map((event) => event.type)).toEqual(["message.created", "message.part_added", "message.part_added", "turn.compaction_completed", "turn.completed"]);
  expect((await runtime.runTurn({ sessionId, cwd: "/repo" })).status).toBe("completed");
});

test("cancellation after the atomic commit does not mark successful manual compaction failed", async () => {
  const controller = new AbortController();
  class CancellingStore extends SqliteEventStore {
    override async appendMany(events: readonly RuntimeEvent[], options?: EventAppendOptions): Promise<void> {
      await super.appendMany(events, options);
      if (events.some((event) => event.type === "turn.compaction_completed")) controller.abort();
    }
  }
  const store = new CancellingStore(":memory:");
  const { runtime } = fixture({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", text: "<context_summary>committed handoff</context_summary>" };
      yield { type: "finish", reason: "stop" };
    },
  }, {}, store);
  const sessionId = await runtime.createSession({ cwd: "/repo" });
  await runtime.appendUserMessage({ sessionId, text: "original source" });
  expect((await runtime.compactContext({ sessionId, signal: controller.signal })).status).toBe("completed");
  expect(await store.events({ sessionId, type: "turn.compaction_failed" })).toHaveLength(0);
  expect(compactedMessageView(await messagesForContext(store, sessionId))).toHaveLength(1);
});

test("RuntimeService preserves completed compaction when cancellation arrives after the SQLite commit", async () => {
  const controller = new AbortController();
  class CancellingStore extends SqliteEventStore {
    override async appendMany(events: readonly RuntimeEvent[], options?: EventAppendOptions): Promise<void> {
      await super.appendMany(events, options);
      if (events.some((event) => event.type === "turn.compaction_completed")) controller.abort();
    }
  }
  const store = new CancellingStore(":memory:");
  const { runtime } = fixture({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", text: "<context_summary>committed service handoff</context_summary>" };
      yield { type: "finish", reason: "stop" };
    },
  }, {}, store);
  const service = new RuntimeService({ runtime, store, cwd: "/repo" });
  try {
    const { sessionId } = await service.createSession({ cwd: "/repo" });
    await runtime.appendUserMessage({ sessionId, text: "original service source" });
    const result = await service.compactSession({ sessionId, signal: controller.signal });
    expect(controller.signal.aborted).toBe(true);
    expect(result.status).toBe("completed");
    expect(await store.events({ sessionId, type: "turn.compaction_failed" })).toHaveLength(0);
    expect(await store.events({ sessionId, type: "turn.compaction_completed" })).toHaveLength(1);
    const statuses = await store.events({ sessionId, type: "session.status_changed" });
    expect(statuses.at(-1)?.payload).toMatchObject({ status: "idle" });
    const restored = compactedMessageView(await messagesForContext(store, sessionId));
    expect(restored).toHaveLength(1);
    expect(restored[0]?.parts.some((part) => part.type === "text" && part.text.includes("committed service handoff"))).toBe(true);
  } finally {
    await service.shutdown();
  }
});

test("a committed automatic summary remains effective after the following main request fails", async () => {
  const { runtime, store } = fixture({
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      if (!isCompaction(input)) throw new Error("main provider unavailable");
      yield { type: "text_delta", text: "<context_summary>durable handoff</context_summary>" };
      yield { type: "finish", reason: "stop" };
    },
  }, { contextBudget: { maxInputChars: 300, compactionThresholdRatio: 0.5, preserveRecentMessages: 0 } });
  const sessionId = await runtime.createSession({ cwd: "/repo" });
  await runtime.appendUserMessage({ sessionId, text: "x".repeat(500) });
  expect((await runtime.runTurn({ sessionId, cwd: "/repo" })).status).toBe("failed");
  const summaries = await committedSummaries(store, sessionId);
  expect(summaries).toHaveLength(1);
  const restored = compactedMessageView(await messagesForContext(store, sessionId));
  expect(restored.map((message) => message.id)).toEqual([summaries[0]!.id]);
  expect(restored[0]?.parts.some((part) => part.type === "text" && part.text.includes("durable handoff"))).toBe(true);
});

test("failed RuntimeService turns retain the committed summary's user boundary without replaying covered history", async () => {
  let mainRequests = 0;
  const { runtime, store } = fixture({
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      if (isCompaction(input)) {
        yield { type: "text_delta", text: "<context_summary>durable service handoff</context_summary>" };
      } else {
        if (++mainRequests === 1) throw new Error("main provider unavailable");
        expect(requestText(input)).toContain("durable service handoff");
        expect(requestText(input)).not.toContain("FIRST_HISTORY");
        expect(requestText(input)).not.toContain("FAILED_CURRENT");
        yield { type: "text_delta", text: "continued from summary" };
      }
      yield { type: "finish", reason: "stop" };
    },
  }, { contextBudget: { maxInputChars: 2_000, compactionThresholdRatio: 0.4, preserveRecentMessages: 0 } });
  const service = new RuntimeService({ runtime, store, cwd: "/repo" });
  try {
    const { sessionId } = await service.createSession({ cwd: "/repo" });
    await runtime.appendUserMessage({ sessionId, text: `FIRST_HISTORY ${"x".repeat(500)}` });
    expect((await service.submitPrompt({ sessionId, text: `FAILED_CURRENT ${"y".repeat(500)}` })).status).toBe("failed");
    const stored = await store.messages(sessionId);
    const boundary = stored.find((message) => message.parts.some((part) => part.type === "text" && part.text.startsWith("FAILED_CURRENT")));
    const summaries = await committedSummaries(store, sessionId);
    expect(boundary?.turnId).toBeDefined();
    expect((await store.events({ sessionId, type: "turn.compaction_requested" }))[0]?.payload).toMatchObject({ boundaryMessageId: boundary?.id });
    expect(await store.events({ sessionId, type: "turn.compaction_failed" })).toEqual([]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.parts.find((part) => part.type === "compaction")).toMatchObject({ boundaryMessageId: boundary?.id });
    const filtered = await messagesForContext(store, sessionId);
    expect(filtered.some((message) => message.id === boundary?.id)).toBe(true);
    expect(compactedMessageView(filtered).map((message) => message.id)).toEqual([summaries[0]!.id]);
    expect((await service.submitPrompt({ sessionId, text: "continue" })).status).toBe("completed");
    expect(mainRequests).toBe(2);
  } finally {
    await service.shutdown();
  }
});

test("consecutive manual compactions cover the preceding summary and only newly added history", async () => {
  const prompts: string[] = [];
  const { runtime, store } = fixture({
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      prompts.push(requestText(input));
      yield { type: "text_delta", text: `<context_summary>handoff ${prompts.length}</context_summary>` };
      yield { type: "finish", reason: "stop" };
    },
  }, { contextCompaction: { verifySummary: false } });
  const sessionId = await runtime.createSession({ cwd: "/repo" });
  const firstSource = await runtime.appendUserMessage({ sessionId, text: "FIRST_SOURCE_ONLY_ONCE" });
  const first = await runtime.compactContext({ sessionId });
  expect(first.status).toBe("completed");
  if (first.status !== "completed") return;
  const secondSource = await runtime.appendUserMessage({ sessionId, text: "SECOND_SOURCE" });
  const second = await runtime.compactContext({ sessionId });
  expect(second.status).toBe("completed");
  if (second.status !== "completed") return;
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain("FIRST_SOURCE_ONLY_ONCE");
  expect(prompts[1]).not.toContain("FIRST_SOURCE_ONLY_ONCE");
  expect(prompts[1]).toContain("handoff 1");
  expect(prompts[1]).toContain("SECOND_SOURCE");
  const summaries = await committedSummaries(store, sessionId);
  expect(summaries[0]?.parts.find((part) => part.type === "compaction")).toMatchObject({ sourceMessageIds: [firstSource], boundaryMessageId: firstSource });
  expect(summaries[1]?.parts.find((part) => part.type === "compaction")).toMatchObject({ sourceMessageIds: [first.messageId, secondSource], boundaryMessageId: secondSource });
  expect(compactedMessageView(await messagesForContext(store, sessionId)).map((message) => message.id)).toEqual([second.messageId]);
});

test("a later failed compaction preserves the previous committed boundary and newly added history", async () => {
  let summaryRequests = 0;
  const { runtime, store } = fixture({
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      if (isCompaction(input)) {
        if (++summaryRequests > 1) throw new Error("later summary failed");
        yield { type: "text_delta", text: "<context_summary>previous valid summary</context_summary>" };
      } else {
        expect(requestText(input)).toContain("previous valid summary");
        expect(requestText(input)).toContain("new history still present");
        yield { type: "text_delta", text: "continued" };
      }
      yield { type: "finish", reason: "stop" };
    },
  }, { contextCompaction: { verifySummary: false } });
  const sessionId = await runtime.createSession({ cwd: "/repo" });
  await runtime.appendUserMessage({ sessionId, text: "old history" });
  const first = await runtime.compactContext({ sessionId });
  expect(first.status).toBe("completed");
  if (first.status !== "completed") return;
  const newId = await runtime.appendUserMessage({ sessionId, text: "new history still present" });
  expect((await runtime.compactContext({ sessionId })).status).toBe("failed");
  expect(compactedMessageView(await messagesForContext(store, sessionId)).map((message) => message.id)).toEqual([first.messageId, newId]);
  expect((await runtime.runTurn({ sessionId, cwd: "/repo" })).status).toBe("completed");
});

test("a rejected compaction commit leaves no partial summary message or advanced boundary", async () => {
  class RejectingStore extends SqliteEventStore {
    override async appendMany(events: readonly RuntimeEvent[], options?: EventAppendOptions): Promise<void> {
      if (events.some((event) => event.type === "turn.compaction_completed")) throw new Error("atomic write rejected");
      await super.appendMany(events, options);
    }
  }
  const store = new RejectingStore(":memory:");
  const { runtime } = fixture({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", text: "<context_summary>handoff</context_summary>" };
      yield { type: "finish", reason: "stop" };
    },
  }, {}, store);
  const sessionId = await runtime.createSession({ cwd: "/repo" });
  const sourceId = await runtime.appendUserMessage({ sessionId, text: "original source" });
  expect((await runtime.compactContext({ sessionId })).status).toBe("failed");
  expect((await store.messages(sessionId)).map((message) => message.id)).toEqual([sourceId]);
  expect(await store.events({ sessionId, type: "turn.compaction_completed" })).toHaveLength(0);
});

test("reactive recovery applies the same precommit budget contract", async () => {
  let mainRequests = 0;
  const { runtime, store } = fixture({
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      if (!isCompaction(input)) {
        mainRequests++;
        throw new Error("context window exceeded");
      }
      yield { type: "text_delta", text: `<context_summary>${"s".repeat(400)}</context_summary>` };
      yield { type: "finish", reason: "stop" };
    },
  }, { contextBudget: { maxInputChars: 300, compactionThresholdRatio: 1, preserveRecentMessages: 0 } });
  const sessionId = await runtime.createSession({ cwd: "/repo" });
  const sourceId = await runtime.appendUserMessage({ sessionId, text: "original short request" });
  expect((await runtime.runTurn({ sessionId, cwd: "/repo" })).status).toBe("failed");
  expect(mainRequests).toBe(1);
  expect(await committedSummaries(store, sessionId)).toHaveLength(0);
  expect(compactedMessageView(await messagesForContext(store, sessionId)).map((message) => message.id)).toEqual([sourceId]);
});

test("saved compaction requests identify the complete source of each draft and review batch", async () => {
  const { runtime, store } = fixture({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", text: "<context_summary>bounded batch handoff</context_summary>" };
      yield { type: "finish", reason: "stop" };
    },
  }, { contextCompaction: { maxSourceChars: 1_500 } });
  const sessionId = await runtime.createSession({ cwd: "/repo" });
  const first = await runtime.appendUserMessage({ sessionId, text: "a".repeat(1_000) });
  const second = await runtime.appendUserMessage({ sessionId, text: "b".repeat(1_000) });
  expect((await runtime.compactContext({ sessionId })).status).toBe("completed");
  const events = await store.events({ sessionId, type: "model.request_prepared" });
  const requests = events.map((event) => (event.payload as { request: PreparedModelRequest }).request);
  expect(requests).toHaveLength(4);
  requests.forEach((request, index) => {
    const expectedId = index < 2 ? first : second;
    expect(request.sources.filter((source) => source.reason === "compaction_serialized_source").map((source) => source.id)).toEqual([expectedId]);
    const submitted = request.sources.find((source) => source.reason === "compaction_request");
    expect(submitted?.metadata).toMatchObject({
      batch: index < 2 ? 1 : 2, stage: index % 2 === 0 ? "draft" : "verification", sourceMessageIds: [expectedId],
    });
    if (index >= 2) expect(submitted?.metadata?.previousSummaryVersion).toBeString();
    if (index % 2 === 1) expect(submitted?.metadata?.draftSummaryVersion).toBeString();
    expect(request.sources.find((source) => source.id === (index < 2 ? second : first)))
      .toMatchObject({ status: "omitted", reason: "outside_compaction_batch" });
  });
});
