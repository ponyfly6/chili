import { expect, test } from "bun:test";
import type { SessionId, TurnId } from "@chili/protocol";
import {
  withModelLifecycle,
  type ModelLifecycleContext,
  type ModelLifecycleDiagnostic,
  type ModelLifecycleOutcome,
} from "./model-lifecycle.js";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";

function input(sessionId = "root", overrides: Partial<ModelStreamInput> = {}): ModelStreamInput {
  return { sessionId: sessionId as SessionId, turnId: `turn_${sessionId}` as TurnId, messages: [], tools: [], system: [], ...overrides };
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("model lifecycle passes through the exact request and stream, keeping optional router methods", async () => {
  const request = input();
  const finish: ModelStreamEvent = { type: "finish", reason: "stop" };
  const outcomes: ModelLifecycleOutcome[] = [];
  let received: ModelStreamInput | undefined;
  const router: ModelRouter = {
    async *stream(value) { received = value; yield finish; },
    listModels() { expect(this).toBe(router); return []; },
    resolveRequestLimits(value) { expect(this).toBe(router); expect(value).toEqual({}); return { contextWindowTokens: 50 }; },
  };
  let now = 10;
  const model = withModelLifecycle(router, { ended: (outcome) => { outcomes.push(outcome); } }, { now: () => now++ });
  const events = await collect(model.stream(request));
  expect(received).toBe(request);
  expect(events[0]).toBe(finish);
  expect(model.listModels?.()).toEqual([]);
  expect(model.resolveRequestLimits?.({})).toEqual({ contextWindowTokens: 50 });
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: "completed", termination: "finish", durationMs: 1 });
  expect(outcomes[0]?.context).toMatchObject({ sessionId: "root", turnId: "turn_root", purpose: "task", agentRole: "root", startedAt: 10 });
  const minimal = withModelLifecycle({ async *stream() {} }, {});
  expect(minimal.listModels).toBeUndefined();
  expect(minimal.resolveRequestLimits).toBeUndefined();
});

test("parallel requests resolve their own purpose, role, parent and identity", async () => {
  const contexts: ModelLifecycleContext[] = [];
  const outcomes: ModelLifecycleOutcome[] = [];
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const model = withModelLifecycle({ async *stream() { yield { type: "finish", reason: "stop" }; } }, {
    started: (context) => { contexts.push(context); }, ended: (outcome) => { outcomes.push(outcome); },
  }, {
    resolveContext: async (request) => {
      if (request.sessionId === "slow_child") await slow;
      return request.sessionId.endsWith("child") ? { agentRole: "child", parentSessionId: "root" as SessionId } : { agentRole: "root" };
    },
  });
  const child = collect(model.stream(input("slow_child", { purpose: "review" })));
  await Promise.all([
    collect(model.stream(input("root", { purpose: "task" }))),
    collect(model.stream(input("compact_child", { purpose: "compaction" }))),
    collect(model.stream(input("verify_child", { purpose: "validation" }))),
  ]);
  releaseSlow();
  await child;
  expect(new Set(contexts.map((context) => context.requestId)).size).toBe(4);
  expect(contexts.find((context) => context.sessionId === "slow_child")).toMatchObject({ purpose: "review", agentRole: "child", parentSessionId: "root" });
  expect(contexts.find((context) => context.sessionId === "compact_child")).toMatchObject({ purpose: "compaction", agentRole: "child" });
  expect(contexts.find((context) => context.sessionId === "verify_child")).toMatchObject({ purpose: "validation", agentRole: "child" });
  for (const outcome of outcomes) expect(contexts).toContainEqual(outcome.context);
});

test("usage merges cumulative snapshots once and sums distinct provider responses", async () => {
  const outcomes: ModelLifecycleOutcome[] = [];
  const model = withModelLifecycle({ async *stream() {
    yield { type: "metadata", usage: { inputTokens: 10, cacheReadInputTokens: 3 } };
    yield { type: "metadata", responseId: "response_1", provider: "provider", model: "model", usage: { inputTokens: 10, outputTokens: 2 } };
    yield { type: "metadata", responseId: "response_1", usage: { outputTokens: 4 } };
    yield { type: "finish", reason: "stop", responseId: "response_1", usage: { inputTokens: 10, outputTokens: 4 } };
    yield { type: "metadata", responseId: "response_2", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } };
    yield { type: "finish", reason: "stop", responseId: "response_2", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } };
  } }, { ended: (outcome) => { outcomes.push(outcome); } });
  expect(await collect(model.stream(input()))).toHaveLength(6);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ provider: "provider", model: "model", responseId: "response_2", usage: { inputTokens: 15, outputTokens: 5, cacheReadInputTokens: 3, totalTokens: 23 } });
});

test("a stream closing without finish is incomplete", async () => {
  const outcomes: ModelLifecycleOutcome[] = [];
  const model = withModelLifecycle({ async *stream() { yield { type: "text_delta", text: "partial" }; } }, {
    ended: (outcome) => { outcomes.push(outcome); },
  });
  expect(await collect(model.stream(input()))).toEqual([{ type: "text_delta", text: "partial" }]);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: "incomplete", termination: "end" });
});

for (const [reason, status, termination] of [
  ["error", "failed", "error"],
  ["cancelled", "cancelled", "abort"],
  ["canceled", "cancelled", "abort"],
  ["length", "completed", "finish"],
  ["max_tokens", "completed", "finish"],
  ["max_output_tokens", "completed", "finish"],
] as const) {
  test(`finish reason ${reason} reports ${status} without rewriting the event`, async () => {
    const outcomes: ModelLifecycleOutcome[] = [];
    const event: ModelStreamEvent = { type: "finish", reason };
    const model = withModelLifecycle({ async *stream() { yield event; } }, {
      ended: (outcome) => { outcomes.push(outcome); },
    });
    const events = await collect(model.stream(input()));
    expect(events).toHaveLength(1);
    expect(events[0]).toBe(event);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status, termination, finishReason: reason });
  });
}

test("an error event is observed but remains an event, including provider cleanup afterward", async () => {
  const outcomes: ModelLifecycleOutcome[] = [];
  let cleaned = false;
  const error = new Error("provider failed");
  const model = withModelLifecycle({ async *stream() {
    try { yield { type: "error", error, usage: { inputTokens: 7 } }; }
    finally { cleaned = true; }
  } }, { ended: (outcome) => { expect(cleaned).toBe(true); outcomes.push(outcome); } });
  const events = await collect(model.stream(input()));
  expect(events).toEqual([{ type: "error", error, usage: { inputTokens: 7 } }]);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: "failed", termination: "error", error: { message: "provider failed" }, usage: { inputTokens: 7 } });
});

test("provider exceptions propagate unchanged and end after cleanup exactly once", async () => {
  const outcomes: ModelLifecycleOutcome[] = [];
  let cleaned = false;
  const error = new Error("provider threw");
  const model = withModelLifecycle({ async *stream() {
    try { yield { type: "metadata", usage: { inputTokens: 2 } }; throw error; }
    finally { cleaned = true; }
  } }, { ended: (outcome) => { expect(cleaned).toBe(true); outcomes.push(outcome); } });
  await expect(collect(model.stream(input()))).rejects.toBe(error);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: "failed", termination: "throw", error: { message: "provider threw" } });
});

test("consumer return closes the provider once before lifecycle end", async () => {
  const order: string[] = [];
  const outcomes: ModelLifecycleOutcome[] = [];
  const model = withModelLifecycle({ async *stream() {
    try { yield { type: "text_delta", text: "first" }; order.push("drained"); yield { type: "finish", reason: "stop" }; }
    finally { order.push("cleanup"); }
  } }, { ended: (outcome) => { outcomes.push(outcome); order.push("ended"); } });
  const iterator = model.stream(input())[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return?.();
  await iterator.return?.();
  expect(order).toEqual(["cleanup", "ended"]);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: "incomplete", termination: "return" });
});

test("return immediately after finish cleans up without detached draining", async () => {
  const outcomes: ModelLifecycleOutcome[] = [];
  const order: string[] = [];
  const model = withModelLifecycle({ async *stream() {
    try { yield { type: "finish", reason: "stop" }; order.push("tail"); }
    finally { order.push("cleanup"); }
  } }, { ended: (outcome) => { outcomes.push(outcome); order.push("ended"); } });
  for await (const event of model.stream(input())) { if (event.type === "finish") break; }
  expect(order).toEqual(["cleanup", "ended"]);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: "completed", termination: "finish" });
});

test("a provider cleanup exception after finish replaces success and still ends once", async () => {
  const outcomes: ModelLifecycleOutcome[] = [];
  const error = new Error("cleanup failed");
  const model = withModelLifecycle({ async *stream() {
    try { yield { type: "finish", reason: "stop" }; }
    finally { throw error; }
  } }, { ended: (outcome) => { outcomes.push(outcome); } });
  const consume = async () => { for await (const _event of model.stream(input())) break; };
  await expect(consume()).rejects.toBe(error);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: "failed", termination: "throw", finishReason: "stop" });
});

test("a synchronous stream construction exception retains its original value", async () => {
  const outcomes: ModelLifecycleOutcome[] = [];
  const error = new Error("could not construct request");
  const model = withModelLifecycle({ stream() { throw error; } }, { ended: (outcome) => { outcomes.push(outcome); } });
  await expect(collect(model.stream(input()))).rejects.toBe(error);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: "failed", termination: "throw" });
});

test("fully consuming a finish keeps late metadata and errors visible", async () => {
  const outcomes: ModelLifecycleOutcome[] = [];
  const error = new Error("tail failed");
  const model = withModelLifecycle({ async *stream() {
    yield { type: "finish", reason: "stop", usage: { inputTokens: 1 } };
    yield { type: "metadata", usage: { inputTokens: 1, outputTokens: 2 } };
    throw error;
  } }, { ended: (outcome) => { outcomes.push(outcome); } });
  await expect(collect(model.stream(input()))).rejects.toBe(error);
  expect(outcomes[0]).toMatchObject({ status: "failed", termination: "throw", finishReason: "stop", usage: { totalTokens: 3 } });
});

test("an aborted request waits for the provider to settle and keeps its exception", async () => {
  const controller = new AbortController();
  const outcomes: ModelLifecycleOutcome[] = [];
  let release!: () => void;
  const settled = new Promise<void>((resolve) => { release = resolve; });
  const model = withModelLifecycle({ async *stream(request) {
    yield { type: "text_delta", text: "pending" };
    await settled;
    request.signal?.throwIfAborted();
  } }, { ended: (outcome) => { outcomes.push(outcome); } });
  const iterator = model.stream(input("root", { signal: controller.signal }))[Symbol.asyncIterator]();
  await iterator.next();
  const pending = iterator.next();
  controller.abort();
  expect(outcomes).toHaveLength(0);
  release();
  await expect(pending).rejects.toBe(controller.signal.reason);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: "cancelled", termination: "abort", error: { name: "AbortError" } });
});

test("observer errors and accidental async rejection cannot change stream execution", async () => {
  const diagnostics: ModelLifecycleDiagnostic[] = [];
  let eventCalls = 0;
  const model = withModelLifecycle({ async *stream() {
    yield { type: "text_delta", text: "first" };
    yield { type: "text_delta", text: "second" };
    yield { type: "finish", reason: "stop" };
  } }, {
    started: () => { throw new Error("observer failure"); },
    event: async () => { eventCalls++; throw new Error("async rejection"); },
    ended: () => { throw new Error("ended failure"); },
  }, { onError: (diagnostic) => { diagnostics.push(diagnostic); } });
  expect(await collect(model.stream(input()))).toHaveLength(3);
  await Promise.resolve();
  expect(eventCalls).toBe(1);
  expect(diagnostics.map((diagnostic) => diagnostic.point)).toEqual(["started", "event", "ended"]);
});

test("event snapshots are immutable and cannot modify the provider event", async () => {
  const event: ModelStreamEvent = { type: "tool_call", name: "read", input: { path: "original" } };
  const seen: ModelStreamEvent[] = [];
  const model = withModelLifecycle({ async *stream() { yield event; yield { type: "finish", reason: "stop" }; } }, {
    event: (_context, value) => { seen.push(value); },
  });
  const events = await collect(model.stream(input()));
  expect(events[0]).toBe(event);
  expect(seen[0]).not.toBe(event);
  expect(Object.isFrozen(seen[0])).toBe(true);
  if (seen[0]?.type !== "tool_call") throw new Error("Expected tool call");
  const observedInput = seen[0].input as { path: string };
  expect(Object.isFrozen(observedInput)).toBe(true);
  expect(() => { observedInput.path = "mutated"; }).toThrow();
  expect(event.input).toEqual({ path: "original" });
});

test("no event subscription means no traversal or snapshot of raw event payloads", async () => {
  let accessed = 0;
  const payload = { get secret() { accessed++; throw new Error("must not inspect"); } };
  const event: ModelStreamEvent = { type: "tool_call", name: "read", input: payload };
  const outcomes: ModelLifecycleOutcome[] = [];
  const model = withModelLifecycle({ async *stream() { yield event; yield { type: "finish", reason: "stop" }; } }, {
    ended: (outcome) => { outcomes.push(outcome); },
  });
  expect((await collect(model.stream(input())))[0]).toBe(event);
  expect(accessed).toBe(0);
  expect(outcomes).toHaveLength(1);
});

test("context and diagnostic failures remain observational", async () => {
  const contexts: ModelLifecycleContext[] = [];
  const diagnostics: ModelLifecycleDiagnostic[] = [];
  const model = withModelLifecycle({ async *stream() { yield { type: "finish", reason: "stop" }; } }, {
    started: (context) => { contexts.push(context); },
  }, {
    resolveContext: async () => { throw new Error("store unavailable"); },
    onError: async (diagnostic) => { diagnostics.push(diagnostic); throw new Error("diagnostics unavailable"); },
  });
  expect(await collect(model.stream(input("child", { purpose: "review" })))).toHaveLength(1);
  expect(contexts[0]).toMatchObject({ sessionId: "child", purpose: "review", agentRole: "unknown" });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ point: "context", context: contexts[0], error: { message: "store unavailable" } });
});

test("cancelling pending context resolution starts and ends once without starting the provider", async () => {
  const contexts: ModelLifecycleContext[] = [];
  const outcomes: ModelLifecycleOutcome[] = [];
  const diagnostics: ModelLifecycleDiagnostic[] = [];
  let entered!: () => void;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  let requests = 0;
  const model = withModelLifecycle({ async *stream() { requests++; yield { type: "finish", reason: "stop" }; } }, {
    started: (context) => { contexts.push(context); }, ended: (outcome) => { outcomes.push(outcome); },
  }, {
    resolveContext: async () => { entered(); await pending; return { agentRole: "child" }; },
    onError: (diagnostic) => { diagnostics.push(diagnostic); },
  });
  const iterator = model.stream(input("child", { signal: controller.signal }))[Symbol.asyncIterator]();
  const next = iterator.next();
  await began;
  controller.abort();
  const closing = iterator.return?.();
  await expect(next).rejects.toBe(controller.signal.reason);
  await closing;
  expect(requests).toBe(0);
  expect(contexts).toHaveLength(1);
  expect(contexts[0]).toMatchObject({ agentRole: "unknown", sessionId: "child" });
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ context: contexts[0], status: "cancelled", termination: "abort" });
  expect(diagnostics).toHaveLength(1);
  release();
  await Promise.resolve();
  await Promise.resolve();
  expect(requests).toBe(0);
  expect(outcomes).toHaveLength(1);
});

test("an already aborted request does not start its resolver or provider", async () => {
  const contexts: ModelLifecycleContext[] = [];
  const outcomes: ModelLifecycleOutcome[] = [];
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  let resolutions = 0;
  const model = withModelLifecycle({ async *stream() { requests++; yield { type: "finish", reason: "stop" }; } }, {
    started: (context) => { contexts.push(context); }, ended: (outcome) => { outcomes.push(outcome); },
  }, { resolveContext: () => { resolutions++; return { agentRole: "root" }; } });
  await expect(collect(model.stream(input("root", { signal: controller.signal })))).rejects.toBe(controller.signal.reason);
  expect(requests).toBe(0);
  expect(resolutions).toBe(0);
  expect(contexts).toHaveLength(1);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: "cancelled", termination: "abort" });
});

test("provider errors and raw usage with non-data fields still deliver terminal observation", async () => {
  const outcomes: ModelLifecycleOutcome[] = [];
  const events: ModelStreamEvent[] = [];
  const diagnostics: ModelLifecycleDiagnostic[] = [];
  let getterCalls = 0;
  const details: Record<string, unknown> = { serialize: () => "must not call" };
  details.circular = details;
  Object.defineProperty(details, "hidden", { get() { getterCalls++; throw new Error("must not access"); } });
  const error = Object.assign(new TypeError("provider failure"), { details });
  const model = withModelLifecycle({ async *stream() {
    yield { type: "error", error, usage: { inputTokens: 1, raw: details } };
  } }, {
    event: (_context, event) => { events.push(event); }, ended: (outcome) => { outcomes.push(outcome); },
  }, { onError: (diagnostic) => { diagnostics.push(diagnostic); } });
  await collect(model.stream(input()));
  expect(events).toHaveLength(1);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: "failed", error: { name: "TypeError", message: "provider failure", details: {
    serialize: "[Function]", hidden: "[Accessor]", circular: "[Circular]",
  } } });
  expect(getterCalls).toBe(0);
  expect(diagnostics).toEqual([]);
});
