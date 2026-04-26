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
      yield { type: "metadata", provider: "test", model: "rich", responseId: "resp_1" };
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
  const toolStartedIndex = store.items.findIndex((event) => event.type === "tool.call_started");
  expect(toolCallPartIndex).toBeGreaterThan(-1);
  expect(toolStartedIndex).toBeGreaterThan(toolCallPartIndex);
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

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
