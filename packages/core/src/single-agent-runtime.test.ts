import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { MessagePart, ModelUsage, RuntimeEvent, SessionId } from "@chili/protocol";
import { CodexApiResponsesModel, ProviderBackpressureCoordinator } from "@chili/providers";
import { SqliteEventStore } from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import type { DoomLoopGuardOptions } from "./doom-loop-guard.js";
import type { ModelRouter, ModelStreamEvent } from "./runtime.js";
import { RuntimeService } from "./runtime-service.js";
import { SingleAgentRuntime } from "./single-agent-runtime.js";

const resources: Array<{ service: RuntimeService; store: SqliteEventStore }> = [];
const usage: ModelUsage = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };

afterEach(async () => {
  for (const { service, store } of resources.splice(0)) {
    await service.shutdown();
    store.close();
  }
});

function harness(model: ModelRouter, doomLoopGuard?: DoomLoopGuardOptions) {
  const store = new SqliteEventStore(":memory:");
  const emitted: RuntimeEvent[] = [];
  const append = store.append.bind(store);
  store.append = async (event, options) => {
    emitted.push(structuredClone(event));
    await append(event, options);
  };
  const registry = new InMemoryToolRegistry();
  const executed: SessionId[] = [];
  registry.register({
    name: "inspect",
    description: "Inspect a fake file.",
    risk: "read",
    inputSchema: { type: "object" },
    resources: () => false,
    execute: async (_input, context) => {
      executed.push(context.sessionId);
      return { title: "inspect", output: "unchanged" };
    },
  });
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      gate: { review: async () => ({ decision: "allow" }) },
    }),
    retryPolicy: { maxAttempts: 3, initialDelayMs: 0 },
    ...(doomLoopGuard ? { doomLoopGuard } : {}),
  });
  const service = new RuntimeService({ runtime, store, cwd: tmpdir(), maxTurns: 8 });
  resources.push({ service, store });
  return { store, registry, runtime, service, executed, emitted };
}

for (const toolFormat of ["legacy", "streamed"] as const) {
  test(`rejects EOF after a complete ${toolFormat} tool input and preserves usage`, async () => {
    let requests = 0;
    const fixture = harness({
      async *stream(): AsyncIterable<ModelStreamEvent> {
        requests++;
        yield { type: "metadata", usage };
        if (toolFormat === "legacy") {
          yield { type: "tool_call", name: "inspect", input: { path: "same" } };
        } else {
          yield { type: "tool_call_start", toolCallId: "call_inspect", name: "inspect" };
          yield { type: "tool_call_end", toolCallId: "call_inspect", name: "inspect", input: { path: "same" } };
        }
      },
    });
    const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
    const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.name).toBe("ModelStreamIncompleteError");
    expect(result.error.message).toContain("explicit finish event");
    expect(result.usage).toEqual(usage);
    expect(fixture.executed).toEqual([]);
    expect(requests).toBe(1);
    expect(await fixture.store.events({ sessionId, type: "tool.call_finished" })).toMatchObject([
      { payload: { status: "failed", synthetic: true } },
    ]);
    expect(await fixture.store.events({ sessionId, type: "turn.completed" })).toMatchObject([
      { payload: { status: "failed" } },
    ]);
    const messages = await fixture.store.messages(sessionId);
    expect(messages.flatMap((message) => message.parts).some((part) => part.type === "text")).toBe(false);
  });
}

for (const reason of ["length", "max_tokens", "max_output_tokens"] as const) {
  for (const withTool of [false, true]) {
    test(`fails ${reason} completion with ${withTool ? "valid tool JSON" : "text only"}`, async () => {
      const fixture = harness({
        async *stream(): AsyncIterable<ModelStreamEvent> {
          yield { type: "metadata", usage };
          yield { type: "text_delta", text: "Partial response" };
          if (withTool) yield { type: "tool_call", name: "inspect", input: {} };
          yield { type: "finish", reason, usage };
        },
      });
      const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
      const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(result.error.name).toBe("ModelOutputLimitError");
      expect(result.usage).toEqual(usage);
      expect(fixture.executed).toEqual([]);
      const messages = await fixture.store.messages(sessionId);
      expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "text"))
        .toMatchObject([{ text: "Partial response" }]);
    });
  }
}

test("does not promote text EOF to a successful prompt or final answer", async () => {
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", phase: "commentary", text: "Still checking." };
      yield { type: "metadata", usage };
    },
  });
  const session = await fixture.service.createSession({ cwd: tmpdir() });
  const result = await fixture.service.submitPrompt({ sessionId: session.sessionId, text: "Inspect the file." });

  expect(result.status).toBe("failed");
  expect(result.turns).toHaveLength(1);
  expect(result.turns[0]?.usage).toEqual(usage);
  const statuses = await fixture.store.events({ sessionId: session.sessionId, type: "session.status_changed" });
  expect(statuses.at(-1)).toMatchObject({ payload: { status: "failed" } });
  const parts = (await fixture.store.messages(session.sessionId)).flatMap((message) => message.parts);
  expect(parts.filter((part) => part.type === "text" && !part.synthetic && part.phase === "final_answer")).toEqual([]);
});

test("rejects an empty finish reason", async () => {
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call", name: "inspect", input: {} };
      yield { type: "finish", reason: " " };
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() });
  expect(result.status).toBe("failed");
  expect(fixture.executed).toEqual([]);
});

test("fails all queued tools if another tool is unfinished at explicit finish", async () => {
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call", name: "inspect", input: {} };
      yield { type: "tool_call_start", name: "inspect", toolCallId: "unfinished" };
      yield { type: "finish", reason: "tool_use", usage };
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() });
  expect(result.status).toBe("failed");
  expect(result.usage).toEqual(usage);
  expect(fixture.executed).toEqual([]);
  expect(await fixture.store.events({ sessionId, type: "tool.call_finished" })).toMatchObject([
    { payload: { status: "failed" } },
    { payload: { status: "failed" } },
  ]);
});

test("preserves a provider error and terminalizes its complete pending tools", async () => {
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call", name: "inspect", input: {} };
      yield { type: "error", error: new Error("provider failed after input"), usage };
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() });
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.error.message).toBe("provider failed after input");
  expect(result.usage).toEqual(usage);
  expect(fixture.executed).toEqual([]);
  expect(await fixture.store.events({ sessionId, type: "tool.call_finished" })).toMatchObject([
    { payload: { status: "failed", error: "provider failed after input" } },
  ]);
});

test("preserves cancellation and usage when aborted after complete tool input", async () => {
  const controller = new AbortController();
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "metadata", usage };
      yield { type: "tool_call", name: "inspect", input: {} };
      controller.abort();
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir(), signal: controller.signal });
  expect(result.status).toBe("cancelled");
  expect(result.usage).toEqual(usage);
  expect(fixture.executed).toEqual([]);
  expect(await fixture.store.events({ sessionId, type: "tool.call_finished" })).toMatchObject([
    { payload: { status: "cancelled" } },
  ]);
});

test("terminalizes pending tools when generator cleanup aborts after explicit finish", async () => {
  const controller = new AbortController();
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      try {
        yield { type: "tool_call_start", toolCallId: "inspect_after_finish", name: "inspect" };
        yield { type: "tool_call_end", toolCallId: "inspect_after_finish", name: "inspect", input: {} };
        yield { type: "finish", reason: "tool_use", usage };
      } finally {
        controller.abort();
      }
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir(), signal: controller.signal });
  expect(result.status).toBe("cancelled");
  expect(result.usage).toEqual(usage);
  expect(fixture.executed).toEqual([]);
  expect(await fixture.store.events({ sessionId, type: "tool.call_finished" })).toMatchObject([
    { payload: { providerCallId: "inspect_after_finish", status: "cancelled", synthetic: true } },
  ]);
  const parts = (await fixture.store.messages(sessionId)).flatMap((message) => message.parts);
  expect(parts.filter((part) => part.type === "tool_result"))
    .toMatchObject([{ providerCallId: "inspect_after_finish", synthetic: true }]);
});

test("cancels remaining serial tools without changing the first completed tool", async () => {
  const controller = new AbortController();
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      for (const callId of ["inspect_first", "inspect_second"]) {
        yield { type: "tool_call_start", toolCallId: callId, name: "inspect" };
        yield { type: "tool_call_end", toolCallId: callId, name: "inspect", input: { path: callId } };
      }
      yield { type: "finish", reason: "tool_use", usage };
    },
  });
  const append = fixture.store.append.bind(fixture.store);
  fixture.store.append = async (event, options) => {
    await append(event, options);
    if (event.type === "tool.call_finished" && event.payload.providerCallId === "inspect_first") controller.abort();
  };
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir(), signal: controller.signal });
  expect(result.status).toBe("cancelled");
  expect(result.usage).toEqual(usage);
  expect(fixture.executed).toEqual([sessionId]);
  expect(await fixture.store.events({ sessionId, type: "tool.call_finished" })).toMatchObject([
    { payload: { providerCallId: "inspect_first", status: "completed", output: "unchanged" } },
    { payload: { providerCallId: "inspect_second", status: "cancelled", synthetic: true } },
  ]);
  const parts = (await fixture.store.messages(sessionId)).flatMap((message) => message.parts);
  expect(parts.filter((part) => part.type === "tool_result"))
    .toMatchObject([{ providerCallId: "inspect_first", output: "unchanged" }, { providerCallId: "inspect_second", synthetic: true }]);
});

test("preserves completed parallel results when cancellation precedes the next serial tool", async () => {
  const controller = new AbortController();
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      for (const [callId, name] of [["parallel_first", "parallel"], ["parallel_second", "parallel"], ["serial_last", "inspect"]] as const) {
        yield { type: "tool_call_start", toolCallId: callId, name };
        yield { type: "tool_call_end", toolCallId: callId, name, input: { path: callId } };
      }
      yield { type: "finish", reason: "tool_use" };
    },
  });
  let started = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => { release = resolve; });
  fixture.registry.register({
    name: "parallel",
    description: "A parallel fake inspection.",
    risk: "read",
    inputSchema: { type: "object" },
    resources: () => false,
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async () => {
      if (++started === 2) release();
      await bothStarted;
      return { title: "parallel", output: "parallel complete" };
    },
  });
  let completed = 0;
  const append = fixture.store.append.bind(fixture.store);
  fixture.store.append = async (event, options) => {
    await append(event, options);
    if (event.type === "tool.call_finished" && event.payload.status === "completed" && ++completed === 2) controller.abort();
  };
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir(), signal: controller.signal });
  expect(result.status).toBe("cancelled");
  expect(started).toBe(2);
  expect(fixture.executed).toEqual([]);
  const finished = await fixture.store.events({ sessionId, type: "tool.call_finished" });
  expect(finished).toHaveLength(3);
  expect(finished).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ providerCallId: "parallel_first", status: "completed" }) }));
  expect(finished).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ providerCallId: "parallel_second", status: "completed" }) }));
  expect(finished).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ providerCallId: "serial_last", status: "cancelled", synthetic: true }) }));
  const parts = (await fixture.store.messages(sessionId)).flatMap((message) => message.parts);
  expect(parts.filter((part) => part.type === "tool_result")).toMatchObject([
    { providerCallId: "parallel_first", output: "parallel complete" },
    { providerCallId: "parallel_second", output: "parallel complete" },
    { providerCallId: "serial_last", synthetic: true },
  ]);
});

test("fails undispatched tools after a planning error without repeating completed tool events", async () => {
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      for (const callId of ["planned_first", "planned_second", "planned_third"]) {
        yield { type: "tool_call_start", toolCallId: callId, name: "planned" };
        yield { type: "tool_call_end", toolCallId: callId, name: "planned", input: { path: callId } };
      }
      yield { type: "finish", reason: "tool_use" };
    },
  });
  let executed = 0;
  fixture.registry.register({
    name: "planned",
    description: "A fake tool with a failing concurrency predicate.",
    risk: "read",
    inputSchema: { type: "object" },
    resources: () => false,
    isConcurrencySafe: (input: { path: string }) => {
      if (input.path === "planned_second") throw new Error("tool scheduling failed");
      return false;
    },
    execute: async () => {
      executed++;
      return { title: "planned", output: "first complete" };
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() });
  expect(result.status).toBe("failed");
  expect(executed).toBe(1);
  if (result.status === "failed") expect(result.error.message).toBe("tool scheduling failed");
  expect(await fixture.store.events({ sessionId, type: "tool.call_finished" })).toMatchObject([
    { payload: { providerCallId: "planned_first", status: "completed", output: "first complete" } },
    { payload: { providerCallId: "planned_second", status: "failed", error: "tool scheduling failed", synthetic: true } },
    { payload: { providerCallId: "planned_third", status: "failed", error: "tool scheduling failed", synthetic: true } },
  ]);
});

test("blocks repeated tool inputs across model turns and resets on the next prompt", async () => {
  let requests = 0;
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      requests++;
      yield { type: "tool_call", name: "inspect", input: { path: "same" } };
      yield { type: "finish", reason: "tool_use" };
    },
  }, { maxRepeatedToolCalls: 1 });
  const session = await fixture.service.createSession({ cwd: tmpdir() });
  for (const text of ["Inspect the file.", "Try again."]) {
    const result = await fixture.service.submitPrompt({ sessionId: session.sessionId, text });
    expect(result.status).toBe("failed");
    expect(result.turns.map((turn) => turn.status)).toEqual(["completed", "failed"]);
    if (result.status === "failed") expect(result.error).toMatchObject({ name: "DoomLoopError" });
  }
  expect(requests).toBe(4);
  expect(fixture.executed).toEqual([session.sessionId, session.sessionId]);
  expect(await fixture.store.events({ sessionId: session.sessionId, type: "turn.guard_triggered" })).toMatchObject([
    { payload: { reason: "repeated_tool_call", count: 2 } },
    { payload: { reason: "repeated_tool_call", count: 2 } },
  ]);
});

test("keeps concurrent sessions' repeated input histories separate", async () => {
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call", name: "inspect", input: {} };
      yield { type: "finish", reason: "tool_use" };
    },
  }, { maxRepeatedToolCalls: 1 });
  const sessions = await Promise.all([
    fixture.service.createSession({ cwd: tmpdir() }),
    fixture.service.createSession({ cwd: tmpdir() }),
  ]);
  const results = await Promise.all(sessions.map((session) => fixture.service.submitPrompt({
    sessionId: session.sessionId,
    text: "Inspect the file.",
  })));
  expect(results.map((result) => result.turns.map((turn) => turn.status))).toEqual([
    ["completed", "failed"],
    ["completed", "failed"],
  ]);
  expect(fixture.executed.toSorted()).toEqual(sessions.map((session) => session.sessionId).toSorted());
});

test("keeps the total call allowance independent for successive model turns", async () => {
  let requests = 0;
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      requests++;
      if (requests <= 3) {
        yield { type: "tool_call", name: "inspect", input: { path: `file-${requests}` } };
        yield { type: "finish", reason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "Inspection complete." };
        yield { type: "finish", reason: "stop" };
      }
    },
  }, { maxRepeatedToolCalls: 1, maxToolCallsPerTurn: 1 });
  const session = await fixture.service.createSession({ cwd: tmpdir() });
  const result = await fixture.service.submitPrompt({ sessionId: session.sessionId, text: "Inspect three files." });
  expect(result.status).toBe("completed");
  expect(fixture.executed).toHaveLength(3);
  expect(requests).toBe(4);
});

test("rejects a prompt execution scope belonging to a different session", async () => {
  let requests = 0;
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      requests++;
      yield { type: "finish", reason: "stop" };
    },
  });
  const first = await fixture.runtime.createSession({ cwd: tmpdir() });
  const second = await fixture.runtime.createSession({ cwd: tmpdir() });
  const result = await fixture.runtime.runTurn({
    sessionId: second,
    cwd: tmpdir(),
    promptExecution: { sessionId: first },
  });
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("different session");
  expect(requests).toBe(0);
});

test("standalone model turns retain independent guards when no scope is supplied", async () => {
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call", name: "inspect", input: {} };
      yield { type: "finish", reason: "tool_use" };
    },
  }, { maxRepeatedToolCalls: 1, maxToolCallsPerTurn: 1 });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  for (let index = 0; index < 2; index++) {
    expect((await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() })).status).toBe("completed");
  }
  expect(fixture.executed).toHaveLength(2);
});


test("keeps live fragments in memory and commits each completed content block in its original order", async () => {
  const persistedDuringStream: MessagePart[][] = [];
  const fixture = harness({
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      yield { type: "reasoning_delta", index: 0, text: "先😀" };
      yield { type: "reasoning_delta", index: 0, text: "检查" };
      persistedDuringStream.push((await fixture.store.messages(input.sessionId)).flatMap((message) => message.parts));
      yield { type: "reasoning_end", index: 0 };
      persistedDuringStream.push((await fixture.store.messages(input.sessionId)).flatMap((message) => message.parts));
      yield { type: "text_delta", index: 1, phase: "commentary", text: "First " };
      yield { type: "text_delta", index: 2, phase: "final_answer", text: "Second" };
      yield { type: "text_end", index: 2, phase: "final_answer" };
      yield { type: "text_delta", index: 1, phase: "commentary", text: "block" };
      yield { type: "text_end", index: 1, phase: "commentary" };
      yield { type: "finish", reason: "stop" };
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() });
  expect(result.status).toBe("completed");
  expect(persistedDuringStream).toHaveLength(2);
  expect(persistedDuringStream[0]).toEqual([]);
  expect(persistedDuringStream[1]).toMatchObject([
    { type: "reasoning", text: "先😀检查", completion: "completed", ordinal: 0 },
  ]);
  const parts = (await fixture.store.messages(sessionId)).flatMap((message) => message.parts);
  expect(parts).toMatchObject([
    { type: "reasoning", text: "先😀检查", completion: "completed", ordinal: 0 },
    { type: "text", text: "First block", phase: "commentary", completion: "completed", ordinal: 1 },
    { type: "text", text: "Second", phase: "final_answer", completion: "completed", ordinal: 2 },
  ]);
  const live = fixture.emitted.filter((event) => event.type === "message.part_stream_delta");
  expect(live.map((event) => event.payload.offset)).toEqual([0, 3, 0, 0, 6]);
  const durable = await fixture.store.events({ sessionId });
  expect(durable.some((event) => event.type === "message.part_stream_delta" || event.type === "message.part_delta")).toBe(false);
  expect(durable.filter((event) => event.type === "message.part_committed")).toHaveLength(3);
  expect(durable.filter((event) => event.type === "message.part_added")).toHaveLength(0);
});

test("flushes complete text and reasoning at response finish when block end signals are unavailable", async () => {
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "reasoning_delta", text: "Preserve " };
      yield { type: "reasoning_delta", text: "all thinking." };
      yield { type: "text_delta", text: "Full " };
      yield { type: "text_delta", text: "answer." };
      yield { type: "finish", reason: "stop" };
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  expect((await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() })).status).toBe("completed");
  expect((await fixture.store.messages(sessionId)).flatMap((message) => message.parts)).toMatchObject([
    { type: "reasoning", text: "Preserve all thinking.", completion: "completed" },
    { type: "text", text: "Full answer.", completion: "completed" },
  ]);
});

for (const termination of ["cancelled", "failed", "eof"] as const) {
  test(`preserves completed blocks and saves unfinished content once on ${termination}`, async () => {
    const controller = new AbortController();
    let requests = 0;
    const fixture = harness({
      async *stream(): AsyncIterable<ModelStreamEvent> {
        requests++;
        yield { type: "reasoning_delta", index: 0, text: "Completed thinking." };
        yield { type: "reasoning_end", index: 0 };
        yield { type: "reasoning_delta", index: 1, text: "More " };
        yield { type: "reasoning_delta", index: 1, text: "thinking" };
        yield { type: "text_delta", text: "Partial " };
        yield { type: "text_delta", text: "answer" };
        if (termination === "cancelled") controller.abort();
        else if (termination === "failed") yield { type: "error", error: new Error("network connection closed") };
      },
    });
    const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
    const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir(), signal: controller.signal });
    const completion = termination === "cancelled" ? "cancelled" : "failed";
    expect(result.status).toBe(completion);
    if (result.status === "completed") throw new Error("expected a partial model response");
    expect(await fixture.store.events({ sessionId, type: "turn.completed" })).toMatchObject([
      { payload: { status: completion, reason: result.error.message } },
    ]);
    expect(requests).toBe(1);
    const parts = (await fixture.store.messages(sessionId)).flatMap((message) => message.parts);
    expect(parts).toMatchObject([
      { type: "reasoning", text: "Completed thinking.", completion: "completed" },
      { type: "reasoning", text: "More thinking", completion },
      { type: "text", text: "Partial answer", completion },
    ]);
    expect(await fixture.store.events({ sessionId, type: "message.part_committed" })).toHaveLength(3);
    expect(await fixture.store.events({ sessionId, type: "message.part_delta" })).toHaveLength(0);
  });
}

test("keeps tool calls in first-observed order while earlier text is still uncommitted", async () => {
  const modelOutput = { apiFamily: "openai-responses", outputIndex: 1, item: { type: "reasoning", encrypted_content: "opaque provider value", summary: [] } };
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", text: "Before tools." };
      yield { type: "tool_call_start", toolCallId: "ordered", name: "inspect", index: 2 };
      yield { type: "reasoning_item", output: modelOutput };
      yield { type: "tool_call_end", toolCallId: "ordered", name: "inspect", input: {}, index: 2 };
      yield { type: "finish", reason: "tool_use" };
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  expect((await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() })).status).toBe("completed");
  const parts = (await fixture.store.messages(sessionId)).flatMap((message) => message.parts);
  expect(parts.map((part) => part.type)).toEqual(["text", "tool_call", "reasoning", "tool_result"]);
  expect(parts.map((part) => part.ordinal)).toEqual([0, 1, 2, 3]);
  expect(parts[2]).toMatchObject({ modelOutput, completion: "completed" });
});

test("rejects late deltas without changing an already committed content block", async () => {
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", text: "Committed." };
      yield { type: "text_end" };
      yield { type: "text_delta", text: "Late duplicate." };
      yield { type: "finish", reason: "stop" };
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  expect((await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() })).status).toBe("failed");
  expect((await fixture.store.messages(sessionId)).flatMap((message) => message.parts)).toMatchObject([
    { type: "text", text: "Committed.", completion: "completed" },
  ]);
  expect(await fixture.store.events({ sessionId, type: "message.part_committed" })).toHaveLength(1);
});


test("keeps filtered output partial and does not execute queued tools", async () => {
  const fixture = harness({
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", text: "Unfinished response" };
      yield { type: "tool_call", name: "inspect", input: {} };
      yield { type: "finish", reason: "content_filter" };
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() });
  expect(result.status).toBe("failed");
  expect(fixture.executed).toEqual([]);
  expect((await fixture.store.messages(sessionId)).flatMap((message) => message.parts).filter((part) => part.type === "text"))
    .toMatchObject([{ text: "Unfinished response", completion: "failed" }]);
});


for (const fragments of [1, 200]) {
  test(`persists complete tool arguments once instead of ${fragments} growing partial inputs`, async () => {
    const completeInput = { path: "x".repeat(200) };
    let updatesBeforeEnd: unknown[] = [];
    let executedBeforeFinish: SessionId[] = [];
    const fixture = harness({
      async *stream(input): AsyncIterable<ModelStreamEvent> {
        yield { type: "tool_call_start", toolCallId: "arguments", name: "inspect", index: 0 };
        for (let index = 1; index <= fragments; index++) {
          yield {
            type: "tool_call_delta", toolCallId: "arguments", name: "inspect", index: 0,
            delta: "x".repeat(200 / fragments),
            partialInput: { path: completeInput.path.slice(0, index * (200 / fragments)) },
          };
        }
        updatesBeforeEnd = await fixture.store.events({ sessionId: input.sessionId, type: "tool.call_updated" });
        yield { type: "tool_call_end", toolCallId: "arguments", name: "inspect", index: 0, input: completeInput };
        executedBeforeFinish = [...fixture.executed];
        yield { type: "finish", reason: "tool_use" };
      },
    });
    const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
    expect((await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() })).status).toBe("completed");
    expect(updatesBeforeEnd).toMatchObject([{ payload: { toolName: "inspect", input: {} } }]);
    const updates = fixture.emitted.filter((event) => event.type === "tool.call_updated" && event.payload.toolName !== undefined);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({ payload: { toolName: "inspect", input: completeInput } });
    const durableUpdates = await fixture.store.events({ sessionId, type: "tool.call_updated" });
    expect(durableUpdates.filter((event) => (event.payload as { toolName?: string }).toolName !== undefined)).toHaveLength(2);
    expect(executedBeforeFinish).toEqual([]);
    expect(fixture.executed).toEqual([sessionId]);
  });
}


test("persists incomplete Codex reasoning as failed after its SSE summary done event", async () => {
  const body = [
    { type: "response.reasoning_summary_text.delta", item_id: "reasoning_partial", output_index: 0, summary_index: 0, delta: "Truncated " },
    { type: "response.reasoning_summary_part.done", item_id: "reasoning_partial", output_index: 0, summary_index: 0, status: "incomplete", part: { type: "summary_text", text: "Truncated reasoning" } },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
  ].map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
  const provider = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "test-key",
    baseUrl: "https://gateway.test/v1",
    env: {},
    backpressureCoordinator: new ProviderBackpressureCoordinator(),
    fetch: (async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
  });
  const fixture = harness({
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      yield* provider.stream({ messages: input.messages, ...(input.signal ? { signal: input.signal } : {}) });
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() });
  expect(result.status).toBe("failed");
  const parts = (await fixture.store.messages(sessionId)).flatMap((message) => message.parts);
  expect(parts).toMatchObject([{ type: "reasoning", text: "Truncated reasoning", completion: "failed" }]);
  expect(await fixture.store.events({ sessionId, type: "message.part_committed" })).toHaveLength(1);
  expect(fixture.executed).toEqual([]);
});


test("text fragmentation does not increase durable record count or change stored content", async () => {
  const body = "x".repeat(200);
  const snapshots: Array<{ events: string[]; parts: unknown[] }> = [];
  for (const fragments of [1, 200]) {
    const fixture = harness({
      async *stream(): AsyncIterable<ModelStreamEvent> {
        const size = body.length / fragments;
        for (let index = 0; index < fragments; index++) {
          yield { type: "text_delta", text: body.slice(index * size, (index + 1) * size) };
        }
        yield { type: "finish", reason: "stop" };
      },
    });
    const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
    expect((await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() })).status).toBe("completed");
    snapshots.push({
      events: (await fixture.store.events({ sessionId })).map((event) => event.type),
      parts: (await fixture.store.messages(sessionId)).flatMap((message) => message.parts).map((part) => ({
        type: part.type, ordinal: part.ordinal,
        ...(part.type === "text" ? { text: part.text, completion: part.completion } : {}),
      })),
    });
  }
  expect(snapshots[1]).toEqual(snapshots[0]);
  expect(snapshots[0]?.events.filter((type) => type === "message.part_committed")).toHaveLength(1);
  expect(snapshots[0]?.parts).toEqual([{ type: "text", ordinal: 0, text: body, completion: "completed" }]);
});
