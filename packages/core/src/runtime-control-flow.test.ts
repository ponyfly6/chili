import { expect, test } from "bun:test";
import type {
  ChiliEvent,
  EventEnvelope,
  Message,
  MessagePart,
  SessionId,
  TimestampMs,
  ToolCallId,
} from "@chili/protocol";
import type { ApprovalRow, EventQuery, EventStore, SessionRow } from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";
import { RuntimeService } from "./runtime-service.js";
import { SingleAgentRuntime } from "./single-agent-runtime.js";

test("does not start or retry already aborted model requests", async () => {
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
    cwd: "/repo",
    signal: controller.signal,
  });

  expect(result.status).toBe("cancelled");
  expect(modelCalls).toBe(0);
  expect(store.items.some((event) => event.type === "turn.retry_scheduled")).toBe(false);
});

test("retries transient socket failures before assistant output", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      modelCalls++;
      const usage = modelCalls === 1
        ? { inputTokens: 4, outputTokens: 1, totalTokens: 5 }
        : { inputTokens: 6, outputTokens: 2, totalTokens: 8 };
      yield { type: "metadata", provider: "openai-codex", model: "gpt-5.5", usage };
      if (modelCalls === 1) {
        throw new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
      }
      yield { type: "text_delta", text: "ok" };
      yield { type: "finish", reason: "stop", usage };
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
    retryPolicy: { maxAttempts: 2, initialDelayMs: 0 },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await runtime.runTurn({
    sessionId: "session_socket_retry" as SessionId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  expect(modelCalls).toBe(2);
  expect(textParts(store).map((part) => part.text).join("")).toBe("ok");
  expect(store.items.some((event) => event.type === "turn.retry_scheduled" && event.payload.reason.includes("socket connection"))).toBe(true);
});

test("does not retry provider errors explicitly marked non-retryable", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      modelCalls++;
      throw Object.assign(new Error("Traffic is currently high (2062)"), {
        status: 429,
        retryable: false,
        category: "plan_capacity",
      });
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

  const result = await runtime.runTurn({
    sessionId: "session_plan_capacity" as SessionId,
    cwd: "/repo",
  });

  expect(result.status).toBe("failed");
  expect(modelCalls).toBe(1);
  expect(store.items.some((event) => event.type === "turn.retry_scheduled")).toBe(false);
});

test("preserves bounded nested retry classification and Retry-After after discarding cause", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET", retryAfterMs: 1 });
        throw Object.assign(new Error("wrapped provider failure"), { cause });
      }
      yield { type: "text_delta", text: "recovered" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const runtime = testRuntime(store, registry, model, { maxAttempts: 2, initialDelayMs: 0 });

  const result = await runtime.runTurn({ sessionId: "session_nested_retry" as SessionId, cwd: "/repo" });
  expect(result.status).toBe("completed");
  expect(modelCalls).toBe(2);
  expect(store.items).toContainEqual(expect.objectContaining({
    type: "turn.retry_scheduled",
    payload: expect.objectContaining({ delayMs: 1 }),
  }));
});

test("preserves a nested explicit non-retryable veto after discarding cause", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      throw Object.assign(new Error("socket connection was closed unexpectedly"), {
        cause: Object.assign(new Error("quota exhausted"), { retryable: false }),
      });
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({ sessionId: "session_nested_retry_veto" as SessionId, cwd: "/repo" });
  expect(result.status).toBe("failed");
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
      ordinal: 2,
      type: "tool_call",
      callId: expect.any(String), providerCallId: "tool_provider_1",
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
    (event) => event.type === "tool.call_updated" && event.payload.providerCallId === "tool_provider_1" && event.payload.toolName !== undefined,
  );
  expect(liveToolUpdates.map((event) => event.payload)).toEqual([
    { callId: expect.any(String), providerCallId: "tool_provider_1", status: "running", toolName: "echo", input: {} },
    { callId: expect.any(String), providerCallId: "tool_provider_1", status: "running", toolName: "echo", input: { value: "ok" } },
  ]);
  const liveToolUpdateIndex = store.items.findIndex(
    (event) => event.type === "tool.call_updated" && event.payload.providerCallId === "tool_provider_1" && event.payload.toolName === "echo",
  );
  const toolStartedIndex = store.items.findIndex((event) => event.type === "tool.call_started");
  expect(liveToolUpdateIndex).toBeGreaterThan(-1);
  expect(liveToolUpdateIndex).toBeLessThan(toolCallPartIndex);
  expect(toolCallPartIndex).toBeGreaterThan(-1);
  expect(toolStartedIndex).toBeGreaterThan(toolCallPartIndex);
});

test("bounds complete tool inputs at persistence and desktop boundaries", async () => {
  const hugeInput = "\u0000".repeat(4 * 1024 * 1024);
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let executedInputBytes = 0;
  registry.register({
    name: "large_input",
    description: "Receives a large provider input.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async (input: { payload?: string }) => {
      executedInputBytes = Buffer.byteLength(input.payload ?? "", "utf8");
      return { title: "large input", output: "ok" };
    },
  });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call_start", toolCallId: "tool_large_input", name: "large_input" };
      yield {
        type: "tool_call_delta",
        toolCallId: "tool_large_input",
        name: "large_input",
        delta: "partial",
        partialInput: { payload: hugeInput },
      };
      yield {
        type: "tool_call_end",
        toolCallId: "tool_large_input",
        name: "large_input",
        input: { payload: hugeInput },
      };
      yield { type: "finish", reason: "tool_use" };
    },
  };

  const result = await testRuntime(store, registry, model).runTurn({
    sessionId: "session_large_tool_input" as SessionId,
    cwd: "/repo",
  });
  expect(result.status).toBe("completed");
  expect(executedInputBytes).toBe(4 * 1024 * 1024);
  const inputEvents = store.items.filter((event) =>
    (event.type === "tool.call_updated" || event.type === "tool.call_started")
      && event.payload.providerCallId === "tool_large_input"
  );
  const toolCallPartEvents = store.items.filter((event) =>
    event.type === "message.part_added" && event.payload.part.type === "tool_call"
  );
  expect(inputEvents.length).toBeGreaterThanOrEqual(3);
  expect(toolCallPartEvents).toHaveLength(1);
  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  for (const event of [...inputEvents, ...toolCallPartEvents]) {
    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThan(520_000);
    expect(() => parseDesktopEvent({ type: "runtime.event", event })).not.toThrow();
  }
});

test("keeps one desktop-safe call id across provider stream, message parts, and executor events", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  registry.register({
    name: "stable_call_id",
    description: "Return a small result.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({ title: "stable", output: "ok" }),
  });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call_start", toolCallId: "__proto__", name: "stable_call_id", index: 7 };
      yield {
        type: "tool_call_delta",
        toolCallId: "__proto__",
        name: "stable_call_id",
        delta: "{}",
        partialInput: {},
        index: 7,
      };
      yield { type: "tool_call_end", toolCallId: "__proto__", name: "stable_call_id", input: {}, index: 7 };
      yield { type: "finish", reason: "tool_use" };
    },
  };

  const result = await testRuntime(store, registry, model).runTurn({
    sessionId: "session_hostile_provider_call_id" as SessionId,
    cwd: "/repo",
  });
  expect(result.status).toBe("completed");

  const callEvents = store.items.filter((event): event is Extract<ChiliEvent, {
    type: "tool.call_started" | "tool.call_updated" | "tool.call_finished" | "message.part_added";
  }> =>
    event.type === "tool.call_started"
      || event.type === "tool.call_updated"
      || event.type === "tool.call_finished"
      || (event.type === "message.part_added"
        && (event.payload.part.type === "tool_call" || event.payload.part.type === "tool_result"))
  );
  const ids = callEvents.map((event) => event.type === "message.part_added"
    ? (event.payload.part as Extract<MessagePart, { type: "tool_call" | "tool_result" }>).callId
    : event.payload.callId);
  expect(ids.length).toBeGreaterThanOrEqual(6);
  expect(new Set(ids).size).toBe(1);
  expect(ids[0]).toMatch(/^toolcall_/u);
  expect(toolCallParts(store)[0]?.providerCallId).toMatch(/^toolcall_invalid_[a-f0-9]{16}$/u);
  expect(ids[0]).not.toBe(toolCallParts(store)[0]?.providerCallId);

  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  for (const event of callEvents) {
    expect(() => parseDesktopEvent({ type: "runtime.event", event })).not.toThrow();
  }
});

test("RuntimeService shutdown fences a signal-ignoring model EOF before tool execution and completion", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  const sessionId = "session_shutdown_model_eof" as SessionId;
  store.addSession(sessionId);
  let executions = 0;
  registry.register({
    name: "must_not_run_after_shutdown",
    description: "Must remain fenced after shutdown.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => {
      executions += 1;
      return { title: "unexpected", output: "unexpected" };
    },
  });
  let reachedEofGateResolve: (() => void) | undefined;
  const reachedEofGate = new Promise<void>((resolve) => { reachedEofGateResolve = resolve; });
  let releaseEofResolve: (() => void) | undefined;
  const releaseEof = new Promise<void>((resolve) => { releaseEofResolve = resolve; });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", text: "queued" };
      yield { type: "tool_call", name: "must_not_run_after_shutdown", input: {} };
      reachedEofGateResolve?.();
      await releaseEof;
      return;
    },
  };
  const createId = createSequentialId();
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
      createId,
      now: () => 1 as TimestampMs,
    }),
    createId,
    now: () => 1 as TimestampMs,
  });
  const service = new RuntimeService({
    runtime,
    store,
    cwd: "/repo",
    maxTurns: 1,
    createId,
    now: () => 1 as TimestampMs,
  });

  const prompt = service.submitPrompt({ sessionId, text: "start" });
  await reachedEofGate;
  const shutdown = service.shutdown("test_shutdown_model_eof");
  releaseEofResolve?.();
  const result = await prompt;
  await shutdown;

  expect(result.status).toBe("cancelled");
  expect(executions).toBe(0);
  expect(store.items.some(
    (event) => event.type === "turn.completed" && event.payload.status === "completed",
  )).toBe(false);
  expect(store.items.some(
    (event) => event.type === "turn.completed" && event.payload.status === "cancelled",
  )).toBe(true);
});

test("copies only allowlisted tool metadata into model-visible execution context", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  registry.register({
    name: "sandboxed_command",
    description: "Run a sandboxed command.",
    risk: "execute",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({
      title: "exit 1",
      output: "command failed",
      metadata: {
        sandbox: "macos-seatbelt",
        executionMode: "sandboxed",
        exitCode: 1,
        timedOut: false,
        aborted: false,
        signal: null,
        command: "secret command that must not enter model context",
        cwd: "/private/workspace",
        durationMs: 42,
        arbitrary: { nested: "untrusted metadata" },
      },
    }),
  });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield {
        type: "tool_call_end",
        toolCallId: "tool_sandboxed",
        name: "sandboxed_command",
        input: {},
      };
      yield { type: "finish", reason: "tool_use" };
    },
  };

  const result = await testRuntime(store, registry, model).runTurn({
    sessionId: "session_tool_context" as SessionId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  const [part] = toolResultParts(store);
  expect(part?.executionContext).toEqual({
    sandbox: "macos-seatbelt",
    executionMode: "sandboxed",
    exitCode: 1,
    timedOut: false,
    aborted: false,
    signal: null,
  });
  expect(part).not.toHaveProperty("metadata");
  expect(JSON.stringify(part)).not.toContain("secret command");
  expect(JSON.stringify(part)).not.toContain("untrusted metadata");
});

test("keeps indexed reasoning sections in separate message parts", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "reasoning_delta", index: 0, text: "**Inspecting " };
      yield { type: "reasoning_delta", index: 0, text: "core**" };
      yield { type: "reasoning_delta", index: 1, text: "**Checking " };
      yield { type: "reasoning_delta", index: 1, text: "schema**" };
      yield { type: "finish", reason: "stop" };
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
    sessionId: "session_reasoning_sections" as SessionId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  expect(reasoningParts(store).map((part) => part.text)).toEqual([
    "**Inspecting core**",
    "**Checking schema**",
  ]);
});

test("keeps indexed assistant phases in separate text parts", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", index: 0, phase: "commentary", text: "Checking " };
      yield { type: "text_delta", index: 2, phase: "final_answer", text: "Done." };
      yield { type: "text_delta", index: 0, phase: "commentary", text: "files." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_text_phases" as SessionId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  expect(textParts(store).map((part) => ({ text: part.text, phase: part.phase }))).toEqual([
    { text: "Checking files.", phase: "commentary" },
    { text: "Done.", phase: "final_answer" },
  ]);
});

test("fails when one assistant text index changes phase", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", index: 0, phase: "commentary", text: "Working" };
      yield { type: "text_delta", index: 0, phase: "final_answer", text: "Done" };
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_phase_conflict" as SessionId,
    cwd: "/repo",
  });

  expect(result.status).toBe("failed");
  if (result.status === "failed") {
    expect(result.error.message).toContain("assistant text index 0 changed phase from commentary to final_answer");
  }
  expect(textParts(store).map((part) => ({ text: part.text, phase: part.phase }))).toEqual([
    { text: "Working", phase: "commentary" },
  ]);
});

test("does not execute tool calls from output-limited model responses", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let executed = false;
  registry.register({
    name: "write_file",
    description: "Write a file.",
    risk: "write",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => {
      executed = true;
      return { title: "write_file", output: "should not run" };
    },
  });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call", name: "write_file", input: { filePath: "danger.txt", content: "partial" } };
      yield { type: "finish", reason: "length" };
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_output_limited" as SessionId,
    cwd: "/repo",
  });

  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("output token limit");
  expect(executed).toBe(false);
  expect(toolFinishedPayloads(store)).toContainEqual(expect.objectContaining({
    status: "failed",
    synthetic: true,
    error: expect.stringContaining("output token limit"),
  }));
  expect(toolResultParts(store)[0]).toMatchObject({
    type: "tool_result",
    output: "",
    synthetic: true,
    error: expect.stringContaining("finish reason: length"),
  });
});

test("does not execute tool calls when the provider reports invalid JSON arguments", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let executed = false;
  registry.register({
    name: "write_file",
    description: "Write a file.",
    risk: "write",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => {
      executed = true;
      return { title: "write_file", output: "should not run" };
    },
  });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call_start", toolCallId: "tool_invalid", name: "write_file" };
      yield {
        type: "tool_call_end",
        toolCallId: "tool_invalid",
        name: "write_file",
        input: {},
        inputParseError: "Tool call arguments were not valid JSON: Unexpected end of JSON input",
      };
      yield { type: "finish", reason: "tool_use" };
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_invalid_tool_args" as SessionId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  expect(executed).toBe(false);
  expect(toolFinishedPayloads(store)).toContainEqual(expect.objectContaining({
    status: "failed",
    synthetic: true,
    error: expect.stringContaining("not valid JSON"),
  }));
  expect(toolResultParts(store)[0]).toMatchObject({
    output: "",
    synthetic: true,
    error: expect.stringContaining("not valid JSON"),
  });
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
    cwd: "/repo",
  });

  expect(result.status).toBe("failed");
  expect(toolCallParts(store)).toEqual([]);
  expect(toolFinishedPayloads(store)).toEqual([
    { callId: expect.any(String), providerCallId: "tool_error", status: "failed", error: "provider exploded", synthetic: true },
  ]);
});

test("surfaces model startup failures in the assistant message", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      throw new Error("Kimi provider requires MOONSHOT_API_KEY or KIMI_API_KEY");
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_model_startup_error" as SessionId,
    cwd: "/repo",
  });

  expect(result.status).toBe("failed");
  expect(textParts(store).map((part) => part.text)).toContain(
    "Model request failed: Kimi provider requires MOONSHOT_API_KEY or KIMI_API_KEY",
  );
  expect(textParts(store).find((part) => part.text.startsWith("Model request failed:"))?.synthetic).toBe(true);
});

test("suppresses MCP image understanding tools when direct image input is available", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  const visibleToolNames: string[][] = [];
  registry.register({
    name: "read_image",
    description: "Read an image from the workspace.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({ title: "read", output: "ok" }),
  });
  registry.register({
    name: "mcp__minimax__understand_image",
    description: "Analyze and describe image content.",
    risk: "network",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({ title: "mcp", output: "ok" }),
    mcp: {
      rawServerName: "MiniMax",
      rawToolName: "understand_image",
      serverName: "minimax",
      toolName: "understand_image",
      modelName: "mcp__minimax__understand_image",
    },
  } as Parameters<InMemoryToolRegistry["register"]>[0] & { mcp: Record<string, unknown> });
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      visibleToolNames.push(input.tools.map((tool) => tool.name));
      yield { type: "finish", reason: "stop" };
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_suppress_image_tools" as SessionId,
    cwd: "/repo",
    suppressExternalImageTools: true,
  });

  expect(result.status).toBe("completed");
  expect(visibleToolNames).toEqual([["read_image"]]);
});

test("prefers MCP image understanding tools over read_image for path-only image prompts", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  const visibleToolNames: string[][] = [];
  registry.register({
    name: "read_image",
    aliases: ["view_image", "image_read"],
    description: "Read an image and return it as an image block.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({ title: "read", output: "ok" }),
  });
  registry.register({
    name: "mcp__minimax__understand_image",
    description: "Analyze and describe image content.",
    risk: "network",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({ title: "mcp", output: "ok" }),
    mcp: {
      rawServerName: "MiniMax",
      rawToolName: "understand_image",
      serverName: "minimax",
      toolName: "understand_image",
      modelName: "mcp__minimax__understand_image",
    },
  } as Parameters<InMemoryToolRegistry["register"]>[0] & { mcp: Record<string, unknown> });
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      visibleToolNames.push(input.tools.map((tool) => tool.name));
      yield { type: "finish", reason: "stop" };
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_prefer_external_image_tools" as SessionId,
    cwd: "/repo",
    preferExternalImageTools: true,
  });

  expect(result.status).toBe("completed");
  expect(visibleToolNames).toEqual([["mcp__minimax__understand_image"]]);
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
    cwd: "/repo",
    signal: controller.signal,
  });

  expect(result.status).toBe("cancelled");
  expect(toolCallParts(store)).toEqual([]);
  expect(toolFinishedPayloads(store)).toEqual([
    { callId: expect.any(String), providerCallId: "tool_abort", status: "cancelled", error: "Turn aborted", synthetic: true },
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
    cwd: "/repo",
  });

  expect(result.status).toBe("failed");
  expect(toolCallParts(store)).toEqual([]);
  expect(toolResultParts(store)).toEqual([]);
  expect(toolFinishedPayloads(store)).toEqual([
    {
      callId: expect.any(String), providerCallId: "tool_unfinished",
      status: "failed",
      error: "Tool call stream ended before tool_call_end",
      errorDetails: expect.objectContaining({ name: "ModelStreamIncompleteError" }),
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
    cwd: "/repo",
  });

  expect(result.status).toBe("failed");
  expect(toolCallParts(store)).toEqual([]);
  expect(toolFinishedPayloads(store)).toEqual([
    {
      callId: expect.any(String), providerCallId: "tool_eof",
      status: "failed",
      error: "Model stream ended before an explicit finish event",
      errorDetails: expect.objectContaining({ name: "ModelStreamIncompleteError" }),
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
    resourcePolicy: "internal",
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
    cwd: "/repo",
    toolMode: "disabled",
  });

  expect(result.status).toBe("completed");
  expect(seenTools).toEqual([[]]);
});

test("runtime refuses model-emitted tool calls when tool mode is disabled", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let executed = false;
  registry.register({
    name: "read",
    description: "Read",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => {
      executed = true;
      return { title: "read", output: "should not run" };
    },
  });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call", name: "read", input: { filePath: "secret.txt" } };
      yield { type: "finish", reason: "tool_use" };
    },
  };
  const runtime = testRuntime(store, registry, model);

  const result = await runtime.runTurn({
    sessionId: "session_no_tool_execution" as SessionId,
    cwd: "/repo",
    toolMode: "disabled",
  });

  expect(result.status).toBe("completed");
  expect(executed).toBe(false);
  expect(toolFinishedPayloads(store)).toContainEqual(expect.objectContaining({
    status: "failed",
    synthetic: true,
    error: expect.stringContaining("Tool use is disabled"),
  }));
  expect(toolResultParts(store)[0]).toMatchObject({
    output: "",
    synthetic: true,
    error: expect.stringContaining("Tool use is disabled"),
  });
});

test("runtime applies per-turn tool policy to visible and executed tools", async () => {
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
    name: "bash",
    description: "Shell",
    risk: "execute",
    inputSchema: { type: "object" },
    approval: () => ({ permission: "bash", patterns: ["ls"] }),
    execute: async () => ({ title: "bash", output: "unexpected" }),
  });
  const seenTools: string[][] = [];
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      seenTools.push(input.tools.map((tool) => tool.name));
      yield { type: "tool_call", name: "bash", input: {} };
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
    sessionId: "session_turn_policy" as SessionId,
    cwd: "/repo",
    toolPolicy: { allowedTools: ["read"] },
  });

  expect(result.status).toBe("completed");
  expect(seenTools).toEqual([["read"]]);
  expect(store.items).toContainEqual(expect.objectContaining({
    type: "tool.call_finished",
    payload: expect.objectContaining({
      status: "failed",
      error: "Tool denied: bash. Tool is not allowed by the current worker policy.",
    }),
  }));
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
  store.addSession(sessionId);

  await expect(
    service.submitPrompt({
      sessionId,
      text: "hello",
    }),
  ).rejects.toThrow("status write failed");
  expect(service.isRunning(sessionId)).toBe(false);
});

test("preserves failed model event usage and provider response metadata", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  const createId = createSequentialId();
  const sessionId = "session_model_error_usage" as SessionId;
  store.addSession(sessionId);
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield {
        type: "error",
        error: new Error("provider charged then failed"),
        responseId: "response_charged_failure",
        usage: {
          inputTokens: 20,
          outputTokens: 2,
          cacheReadInputTokens: 3,
          totalTokens: 25,
        },
      };
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
    createId,
    now: () => 1 as TimestampMs,
  });
  const service = new RuntimeService({
    runtime,
    store,
    cwd: "/repo",
    createId,
    now: () => 1 as TimestampMs,
  });
  const result = await service.submitPrompt({ sessionId, text: "run once" });

  expect(result.status).toBe("failed");
  expect(result.turns[0]?.usage).toEqual({
    inputTokens: 20,
    outputTokens: 2,
    cacheReadInputTokens: 3,
    totalTokens: 25,
  });
  expect(store.items.some(
    (event) => event.type === "turn.model_metadata" && event.payload.responseId === "response_charged_failure",
  )).toBe(true);
});

class MemoryEventStore implements EventStore {
  readonly items: ChiliEvent[] = [];
  readonly sessionRows: SessionRow[] = [];

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
        if (query.type && event.type !== query.type) return false;
        return true;
      })
      .slice(0, limit);
  }

  async sessions(): Promise<SessionRow[]> {
    return this.sessionRows.map((row) => ({ ...row }));
  }

  addSession(sessionId: SessionId): void {
    this.sessionRows.push({
      id: sessionId,
      cwd: "/repo",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
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

function testRuntime(
  store: MemoryEventStore,
  registry: InMemoryToolRegistry,
  model: ModelRouter,
  retryPolicy?: ConstructorParameters<typeof SingleAgentRuntime>[0]["retryPolicy"],
): SingleAgentRuntime {
  return new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    ...(retryPolicy ? { retryPolicy } : {}),
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
    if (event.type === "message.part_added" || event.type === "message.part_committed") {
      parts.set(event.payload.part.id, { ...event.payload.part });
    }
    if (event.type === "message.part_delta") {
      const part = parts.get(event.payload.partId);
      if (part && event.payload.field === "text" && (part.type === "text" || part.type === "reasoning")) {
        part.text += event.payload.delta;
      }
    }
  }
  return [...parts.values()].sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0));
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
