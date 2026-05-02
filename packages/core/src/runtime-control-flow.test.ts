import { expect, test } from "bun:test";
import type {
  ChiliEvent,
  EventEnvelope,
  Message,
  MessagePart,
  SessionId,
  ThreadId,
  TimestampMs,
  ToolCallId,
} from "@chili/protocol";
import type { ApprovalRow, EventQuery, EventStore, SessionRow } from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";
import { RuntimeService } from "./runtime-service.js";
import { SingleAgentRuntime } from "./single-agent-runtime.js";

test("does not retry aborted model requests", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelCalls++;
      expect(input.signal?.aborted).toBe(true);
      throw abortError("provider aborted");
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    retryPolicy: { maxAttempts: 3, initialDelayMs: 0 },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const controller = new AbortController();
  controller.abort();

  const result = await runtime.runTurn({
    sessionId: "session_abort" as SessionId,
    threadId: "thread_abort" as ThreadId,
    cwd: "/repo",
    signal: controller.signal,
  });

  expect(result.status).toBe("cancelled");
  expect(modelCalls).toBe(1);
  expect(store.items.some((event) => event.type === "turn.retry_scheduled")).toBe(false);
});

test("consumes rich model streams and executes tool calls after the stream finishes", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let streamFinished = false;
  const toolInputs: unknown[] = [];
  registry.register({
    name: "echo",
    description: "Echo a value.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async (input) => {
      expect(streamFinished).toBe(true);
      toolInputs.push(input);
      return { title: "Echo", output: `echo:${JSON.stringify(input)}` };
    },
  });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield {
        type: "metadata",
        provider: "test",
        model: "rich",
        responseId: "resp_1",
        contextWindowTokens: 64000,
      };
      yield { type: "reasoning_delta", text: "think" };
      yield { type: "text_delta", text: "hel" };
      yield { type: "text_delta", text: "lo" };
      yield { type: "tool_call_start", toolCallId: "tool_provider_1", name: "echo" };
      yield { type: "tool_call_delta", toolCallId: "tool_provider_1", delta: "{\"value\"", name: "echo" };
      yield {
        type: "tool_call_delta",
        toolCallId: "tool_provider_1",
        delta: ":\"ok\"}",
        name: "echo",
        partialInput: { value: "ok" },
      };
      yield { type: "tool_call_end", toolCallId: "tool_provider_1", name: "echo", input: { value: "ok" } };
      streamFinished = true;
      yield { type: "finish", reason: "tool_use" };
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await runtime.runTurn({
    sessionId: "session_rich_stream" as SessionId,
    threadId: "thread_rich_stream" as ThreadId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  if (result.status === "completed") {
    expect(result.finishReason).toBe("tool_use");
  }
  expect(toolInputs).toEqual([{ value: "ok" }]);
  expect(
    store.items
      .filter((event) => event.type === "turn.model_metadata")
      .map((event) => event.payload),
  ).toEqual([
    {
      turnId: "turn_1" as never,
      provider: "test",
      model: "rich",
      responseId: "resp_1",
      contextWindowTokens: 64000,
    },
  ]);
  expect(textParts(store).map((part) => part.text)).toEqual(["hello"]);
  expect(reasoningParts(store).map((part) => part.text)).toEqual(["think"]);
  expect(toolCallParts(store)).toEqual([
    {
      id: expect.any(String),
      messageId: expect.any(String),
      sessionId: "session_rich_stream" as SessionId,
      type: "tool_call",
      callId: "tool_provider_1" as ToolCallId,
      toolName: "echo",
      input: { value: "ok" },
      status: "pending",
    },
  ]);
  expect(toolResultParts(store).map((part) => part.output)).toEqual(['echo:{"value":"ok"}']);

  const toolCallPartIndex = store.items.findIndex(
    (event) => event.type === "message.part_added" && event.payload.part.type === "tool_call",
  );
  const liveToolUpdates = store.items.filter(
    (event) => event.type === "tool.call_updated" && event.payload.callId === "tool_provider_1" && event.payload.toolName !== undefined,
  );
  expect(liveToolUpdates.map((event) => event.payload)).toEqual([
    { callId: "tool_provider_1" as ToolCallId, status: "running", toolName: "echo", input: {} },
    { callId: "tool_provider_1" as ToolCallId, status: "running", toolName: "echo", input: { value: "ok" } },
    { callId: "tool_provider_1" as ToolCallId, status: "running", toolName: "echo", input: { value: "ok" } },
  ]);
  const liveToolUpdateIndex = store.items.findIndex(
    (event) => event.type === "tool.call_updated" && event.payload.callId === "tool_provider_1" && event.payload.toolName === "echo",
  );
  const toolStartedIndex = store.items.findIndex((event) => event.type === "tool.call_started");
  expect(liveToolUpdateIndex).toBeGreaterThan(-1);
  expect(liveToolUpdateIndex).toBeLessThan(toolCallPartIndex);
  expect(toolCallPartIndex).toBeGreaterThan(-1);
  expect(toolStartedIndex).toBeGreaterThan(toolCallPartIndex);
});

test("keeps live tool output deltas out of model-facing tool result parts", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  registry.register({
    name: "streamer",
    description: "Emit live output before final result.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async (_input, context) => {
      await context.streamOutput({ stream: "stdout", delta: "partial stdout\n" });
      await context.streamOutput({ stream: "stderr", delta: "partial stderr\n" });
      return { title: "streamer", output: "canonical final output" };
    },
  });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call", name: "streamer", input: {} };
      yield { type: "finish", reason: "tool_use" };
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_tool_output_delta" as SessionId,
    threadId: "thread_tool_output_delta" as ThreadId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  const deltas = store.items.filter((event): event is Extract<ChiliEvent, { type: "tool.output_delta" }> => event.type === "tool.output_delta");
  expect(deltas.map((event) => ({ stream: event.payload.stream, delta: event.payload.delta }))).toEqual([
    { stream: "stdout", delta: "partial stdout\n" },
    { stream: "stderr", delta: "partial stderr\n" },
  ]);
  expect(toolResultParts(store).map((part) => part.output)).toEqual(["canonical final output"]);
  expect(messageParts(store).map((part) => JSON.stringify(part)).join("\n")).not.toContain("partial stdout");
});

test("finishes live streaming tool rows as failed when the model errors before tool_call_end", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call_start", toolCallId: "tool_error", name: "bash" };
      yield { type: "tool_call_delta", toolCallId: "tool_error", name: "bash", delta: "{\"command\"", partialInput: { command: "bun test" } };
      yield { type: "error", error: new Error("provider exploded") };
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_stream_error" as SessionId,
    threadId: "thread_stream_error" as ThreadId,
    cwd: "/repo",
  });

  expect(result.status).toBe("failed");
  expect(toolCallParts(store)).toEqual([]);
  expect(toolFinishedPayloads(store)).toEqual([
    { callId: "tool_error" as ToolCallId, status: "failed", error: "provider exploded", synthetic: true },
  ]);
});

test("finishes live streaming tool rows as cancelled when aborted before tool_call_end", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  const controller = new AbortController();
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call_start", toolCallId: "tool_abort", name: "bash" };
      controller.abort();
      yield { type: "text_delta", text: "after abort" };
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_stream_abort" as SessionId,
    threadId: "thread_stream_abort" as ThreadId,
    cwd: "/repo",
    signal: controller.signal,
  });

  expect(result.status).toBe("cancelled");
  expect(toolCallParts(store)).toEqual([]);
  expect(toolFinishedPayloads(store)).toEqual([
    { callId: "tool_abort" as ToolCallId, status: "cancelled", error: "Turn aborted", synthetic: true },
  ]);
});

test("finishes live streaming tool rows as failed when finish arrives before tool_call_end", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call_start", toolCallId: "tool_unfinished", name: "bash" };
      yield { type: "tool_call_delta", toolCallId: "tool_unfinished", name: "bash", delta: "{\"command\"", partialInput: { command: "bun test" } };
      yield { type: "finish", reason: "end_turn" };
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_stream_finish" as SessionId,
    threadId: "thread_stream_finish" as ThreadId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  expect(toolCallParts(store)).toEqual([]);
  expect(toolResultParts(store)).toEqual([]);
  expect(toolFinishedPayloads(store)).toEqual([
    {
      callId: "tool_unfinished" as ToolCallId,
      status: "failed",
      error: "Tool call stream ended before tool_call_end",
      synthetic: true,
    },
  ]);
});

test("finishes live streaming tool rows as failed when the stream ends before tool_call_end", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call_start", toolCallId: "tool_eof", name: "bash" };
      yield { type: "tool_call_delta", toolCallId: "tool_eof", name: "bash", delta: "{\"command\"", partialInput: { command: "bun test" } };
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_stream_eof" as SessionId,
    threadId: "thread_stream_eof" as ThreadId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  expect(toolCallParts(store)).toEqual([]);
  expect(toolFinishedPayloads(store)).toEqual([
    {
      callId: "tool_eof" as ToolCallId,
      status: "failed",
      error: "Tool call stream ended before tool_call_end",
      synthetic: true,
    },
  ]);
});

test("runtime hides unauthorized tools from model input", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  registry.register({
    name: "read",
    description: "Read",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({ title: "read", output: "ok" }),
  });
  registry.register({
    name: "write",
    description: "Write",
    risk: "write",
    inputSchema: { type: "object" },
    approval: () => ({ permission: "write", patterns: ["src/a.ts"] }),
    execute: async () => ({ title: "write", output: "ok" }),
  });
  const seenTools: string[][] = [];
  const policyResolver = {
    resolve: () => ({
      allowedTools: ["read"],
      writeScope: [],
    }),
  };
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      seenTools.push(input.tools.map((tool) => tool.name));
      yield { type: "finish", reason: "end_turn" };
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
      policyResolver,
    }),
    toolPolicyResolver: policyResolver,
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await runtime.runTurn({
    sessionId: "session_scoped_tools" as SessionId,
    threadId: "thread_scoped_tools" as ThreadId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  expect(seenTools).toEqual([["read"]]);
});

test("runtime hides all tools when tool mode is disabled", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  registry.register({
    name: "read",
    description: "Read",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({ title: "read", output: "ok" }),
  });
  const seenTools: string[][] = [];
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      seenTools.push(input.tools.map((tool) => tool.name));
      yield { type: "finish", reason: "end_turn" };
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_no_tools" as SessionId,
    threadId: "thread_no_tools" as ThreadId,
    cwd: "/repo",
    toolMode: "disabled",
  });

  expect(result.status).toBe("completed");
  expect(seenTools).toEqual([[]]);
});

test("runs concurrency-safe tool calls in parallel and preserves result order", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let running = 0;
  let maxRunning = 0;
  registry.register({
    name: "parallel",
    description: "Parallel read tool.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async (input) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      const value = isRecord(input) && typeof input.value === "string" ? input.value : "";
      await sleepMs(value === "first" ? 30 : 1);
      running--;
      return { title: value, output: value };
    },
  });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call", name: "parallel", input: { value: "first" } };
      yield { type: "tool_call", name: "parallel", input: { value: "second" } };
      yield { type: "finish", reason: "tool_use" };
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await runtime.runTurn({
    sessionId: "session_parallel_tools" as SessionId,
    threadId: "thread_parallel_tools" as ThreadId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  expect(maxRunning).toBe(2);
  expect(toolResultParts(store).map((part) => part.output)).toEqual(["first", "second"]);
});

test("clears the reserved runtime when the initial running status write fails", async () => {
  const store = new ThrowingStatusStore();
  const service = new RuntimeService({
    runtime: {} as SingleAgentRuntime,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_status_failure" as SessionId;

  await expect(
    service.submitPrompt({
      sessionId,
      threadId: "thread_status_failure" as ThreadId,
      text: "hello",
    }),
  ).rejects.toThrow("status write failed");
  expect(service.isRunning(sessionId)).toBe(false);
});

class MemoryEventStore implements EventStore {
  readonly items: ChiliEvent[] = [];

  async append(event: ChiliEvent): Promise<void> {
    this.items.push(event);
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    const afterIndex = query.afterEventId
      ? this.items.findIndex((event) => event.id === query.afterEventId)
      : -1;
    const limit = query.limit ?? 500;
    return this.items
      .slice(afterIndex + 1)
      .filter((event) => {
        if (query.sessionId && event.sessionId !== query.sessionId) return false;
        if (query.threadId && event.threadId !== query.threadId) return false;
        if (query.type && event.type !== query.type) return false;
        return true;
      })
      .slice(0, limit);
  }

  async sessions(): Promise<SessionRow[]> {
    return [];
  }

  async messages(): Promise<Message[]> {
    return [];
  }

  async pendingApprovals(): Promise<ApprovalRow[]> {
    return [];
  }
}

class ThrowingStatusStore extends MemoryEventStore {
  override async append(event: ChiliEvent): Promise<void> {
    if (event.type === "session.status_changed") {
      throw new Error("status write failed");
    }
    await super.append(event);
  }
}

function testRuntime(store: MemoryEventStore, registry: InMemoryToolRegistry, model: ModelRouter): SingleAgentRuntime {
  return new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

function messageParts(store: MemoryEventStore): MessagePart[] {
  const parts = new Map<string, MessagePart>();
  for (const event of store.items) {
    if (event.type === "message.part_added") {
      parts.set(event.payload.part.id, event.payload.part);
    }
    if (event.type === "message.part_delta") {
      const part = parts.get(event.payload.partId);
      if (part && event.payload.field === "text" && (part.type === "text" || part.type === "reasoning")) {
        part.text += event.payload.delta;
      }
    }
  }
  return [...parts.values()];
}

function textParts(store: MemoryEventStore): Extract<MessagePart, { type: "text" }>[] {
  return messageParts(store).filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text");
}

function reasoningParts(store: MemoryEventStore): Extract<MessagePart, { type: "reasoning" }>[] {
  return messageParts(store).filter(
    (part): part is Extract<MessagePart, { type: "reasoning" }> => part.type === "reasoning",
  );
}

function toolCallParts(store: MemoryEventStore): Extract<MessagePart, { type: "tool_call" }>[] {
  return messageParts(store).filter(
    (part): part is Extract<MessagePart, { type: "tool_call" }> => part.type === "tool_call",
  );
}

function toolResultParts(store: MemoryEventStore): Extract<MessagePart, { type: "tool_result" }>[] {
  return messageParts(store).filter(
    (part): part is Extract<MessagePart, { type: "tool_result" }> => part.type === "tool_result",
  );
}

function toolFinishedPayloads(
  store: MemoryEventStore,
): Array<Extract<ChiliEvent, { type: "tool.call_finished" }>["payload"]> {
  return store.items
    .filter((event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished")
    .map((event) => event.payload);
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
