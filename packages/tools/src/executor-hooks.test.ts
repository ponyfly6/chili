import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeEvent, SessionId, TimestampMs, ToolCallId, ToolResult, TurnId } from "@chili/protocol";
import { createCodeModeTool } from "./builtins/code-mode.js";
import { ToolDispatchScope } from "./dispatch-scope.js";
import { ToolExecutor, validateToolResultPresentation } from "./executor.js";
import { toError } from "./errors.js";
import { InMemoryToolRegistry } from "./registry.js";
import type {
  ChiliToolDefinition, ExecuteToolInput, ToolExecutionGate, ToolLifecycleHooks,
  ToolLifecycleOutcome, ToolReviewResult,
} from "./types.js";

test("tool lifecycle transforms presentation after review and reports completion after releasing the permit", async () => {
  const order: string[] = [];
  let held = false;
  const scope = new ToolDispatchScope();
  const acquire = scope.acquire.bind(scope);
  scope.acquire = async (...args) => {
    const release = await acquire(...args);
    held = true;
    return () => { held = false; order.push("release"); release(); };
  };
  let heldAtEnd: boolean | undefined;
  let frozenAtProcessing = false;
  let clock = 100;
  const h = harness({
    now: () => ++clock as TimestampMs,
    gate: { async review() { order.push("review"); return { decision: "allow" }; } },
    tool: {
      prepareInput: (input) => ({ ...input, target: "prepared" }),
      async execute() {
        order.push("execute");
        return { title: "Canonical", output: "original output", structuredData: { value: 7 }, metadata: { sandbox: "none" } };
      },
    },
    lifecycle: {
      async processResult(context, result) {
        order.push("process");
        frozenAtProcessing = Object.isFrozen(context) && Object.isFrozen(context.input)
          && Object.isFrozen(result) && Object.isFrozen(result.structuredData);
        return { ...result, title: "Display", output: "shortened output", structuredData: { value: 99 }, metadata: { sandbox: "forged" } };
      },
      ended() { heldAtEnd = held; order.push("ended"); },
    },
    publish: (event) => { if (event.type === "tool.call_finished") order.push("finished"); },
  });
  const result = await h.executor.execute({ ...call({ target: "raw" }), dispatchScope: scope });
  expect(result.status).toBe("completed");
  if (result.status !== "completed") throw result.error;
  expect(result.result).toMatchObject({ title: "Display", output: "shortened output", structuredData: { value: 7 }, metadata: { sandbox: "none" } });
  expect(order).toEqual(["review", "execute", "process", "finished", "release", "ended"]);
  expect(frozenAtProcessing).toBe(true);
  expect(heldAtEnd).toBe(false);
  expect(h.events.find((event) => event.type === "tool.call_finished")).toMatchObject({ payload: { output: "original output", status: "completed" } });
  expect(h.outcomes).toHaveLength(1);
  expect(h.outcomes[0]).toMatchObject({
    context: { toolName: "effect", input: { target: "prepared" }, prepared: true, invocationMode: "direct" },
    status: "completed", phase: "completed", handlerEntered: true, executionSucceeded: true,
    result: { output: "shortened output" }, canonicalResult: { output: "original output" },
    startedAt: 101,
  });
  expect(h.outcomes[0]!.durationMs).toBe(h.outcomes[0]!.endedAt - h.outcomes[0]!.startedAt);
  expect(h.outcomes[0]!.durationMs).toBeGreaterThan(0);
  expect(Object.isFrozen(h.outcomes[0]!.result)).toBe(true);
});

test("tool lifecycle distinguishes validation, blocked review, reviewer failure, and handler failure", async () => {
  const cases = [
    { kind: "validation", phase: "validating", status: "failed", entered: false },
    { kind: "policy", phase: "authorizing", status: "blocked", entered: false },
    { kind: "deny", phase: "reviewing", status: "blocked", entered: false },
    { kind: "review-error", phase: "reviewing", status: "failed", entered: false },
    { kind: "handler-error", phase: "executing", status: "failed", entered: true },
  ] as const;
  for (const item of cases) {
    let processed = 0;
    const h = harness({
      gate: { async review() {
        if (item.kind === "review-error") throw new Error("Reviewer unavailable");
        return { decision: item.kind === "deny" ? "deny" : "allow", reason: "Review fixture" };
      } },
      tool: {
        ...(item.kind === "validation" ? { inputSchema: { type: "object", required: ["missing"] } } : {}),
        async execute() { throw new Error("Handler failed after entry"); },
      },
      lifecycle: { async processResult(_context, result) { processed++; return result; } },
    });
    const result = await h.executor.execute({ ...call({}), ...(item.kind === "policy" ? { policy: { deniedTools: ["effect"] } } : {}) });
    expect(result.status).toBe("failed");
    expect(processed).toBe(0);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]).toMatchObject({ status: item.status, phase: item.phase, handlerEntered: item.entered, executionSucceeded: false });
    expect(h.outcomes[0]!.error).toBeInstanceOf(Error);
    expect(h.events.filter((event) => event.type === "tool.call_finished")).toHaveLength(1);
  }
});

test("a failed result processor preserves successful effects and canonical output without creating another artifact", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chili-lifecycle-artifact-"));
  try {
    let effects = 0;
    const original = "canonical original output\n".repeat(100);
    const h = harness({
      maxResultOutputBytes: 64,
      tool: { async execute() { effects++; return { title: "Effect", output: original }; } },
      lifecycle: { async processResult() { throw new Error("Cannot format result"); } },
    });
    const result = await h.executor.execute({ ...call({}), cwd });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw result.error;
    expect(effects).toBe(1);
    expect(result.result.output).toContain("Tool execution succeeded");
    expect(result.result.output).toContain("Do not rerun the tool");
    expect(result.result.metadata).toMatchObject({ resultProcessingError: "Cannot format result", executionSucceeded: true });
    const path = join(cwd, String(result.result.metadata?.outputPath));
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await readdir(dirname(path))).filter((name) => name.endsWith(".txt"))).toHaveLength(1);
    expect(h.outcomes[0]).toMatchObject({ status: "completed", handlerEntered: true, executionSucceeded: true, resultProcessingError: { message: "Cannot format result" } });
    expect(h.outcomes[0]!.error).toBeUndefined();
    const finished = h.events.find((event) => event.type === "tool.call_finished");
    expect(finished).toMatchObject({ payload: { status: "completed", output: h.outcomes[0]!.canonicalResult!.output } });
    expect(JSON.stringify(finished)).not.toContain("Cannot format result");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("processors cannot forge errors or status, and malformed presentation never reruns the handler", async () => {
  const invalid = [
    undefined,
    { title: "forged", output: "failed", status: "failed", error: "forged" },
    { title: "bad", output: "bad", content: [{ type: "image", data: 7 }] },
    Object.defineProperty({}, "output", { get() { throw new Error("Getter must not run"); }, enumerable: true }),
  ];
  for (const value of invalid) {
    const h = harness({ lifecycle: { async processResult() { return value as ToolResult; } } });
    const result = await h.executor.execute(call({}));
    expect(result.status).toBe("completed");
    expect(h.effects).toHaveLength(1);
    expect(h.outcomes[0]).toMatchObject({ status: "completed", executionSucceeded: true });
    expect(h.outcomes[0]!.resultProcessingError).toBeInstanceOf(Error);
  }
  const h = harness({ lifecycle: { async processResult() { throw new DOMException("Pretend cancellation", "AbortError"); } } });
  expect((await h.executor.execute(call({}))).status).toBe("completed");
  expect(h.outcomes[0]).toMatchObject({ status: "completed", executionSucceeded: true });
});

test("the shared presentation validator rejects unknown fields and accessors without invoking getters", () => {
  let getterCalls = 0;
  const content = Object.defineProperty({ type: "text" }, "text", {
    enumerable: true, get() { getterCalls++; return "unsafe"; },
  });
  expect(() => validateToolResultPresentation({ title: "bad", output: "bad", content: [content] })).toThrow("accessors");
  const inheritedOutput = Object.create({ get output() { getterCalls++; return "unsafe"; } });
  inheritedOutput.title = "bad";
  expect(() => validateToolResultPresentation(inheritedOutput)).toThrow("string title and output");
  expect(() => validateToolResultPresentation({ title: "bad", output: "bad", status: "completed" })).toThrow("execution status");
  expect(getterCalls).toBe(0);
  expect(validateToolResultPresentation({ title: "valid", output: "display", metadata: { ignored: true }, structuredData: { ignored: true } }))
    .toEqual({ title: "valid", output: "display" });
});

test("ended observers receive copied errors without freezing execution or processor-owned errors", async () => {
  for (const source of ["handler", "processor"] as const) {
    const original = toError(new Error(`${source} failure`));
    const h = harness({
      ...(source === "handler" ? { tool: { async execute(): Promise<ToolResult> { throw original; } } } : {}),
      ...(source === "processor" ? { lifecycle: { async processResult(): Promise<ToolResult> { throw original; } } } : {}),
    });
    const result = await h.executor.execute(call({}));
    expect(result.status).toBe(source === "handler" ? "failed" : "completed");
    const observed = source === "handler" ? h.outcomes[0]!.error : h.outcomes[0]!.resultProcessingError;
    expect(observed).not.toBe(original);
    expect(observed).toMatchObject({ name: original.name, message: original.message });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
    original.message = "owner can still update its error";
    expect(observed?.message).toBe(`${source} failure`);
  }
});

test("processed output is bounded without replacing canonical program data, metadata, or artifact identities", async () => {
  const h = harness({
    maxResultOutputBytes: 80,
    tool: { async execute() { return { title: "Source", output: "canonical", structuredData: { value: 3 }, metadata: { source: "handler" } }; } },
    lifecycle: { async processResult(_context, result) {
      return { ...result, output: "x".repeat(20_000), title: "t".repeat(20_000), structuredData: { value: 0 },
        metadata: { outputPath: "outside-workspace", executionSucceeded: false }, artifactIds: ["forged" as never] };
    } },
  });
  const result = await h.executor.execute(call({}));
  expect(result.status).toBe("completed");
  if (result.status !== "completed") throw result.error;
  expect(result.result.output.length).toBeLessThan(200);
  expect(result.result.output).toContain("processed tool output truncated");
  expect(Buffer.byteLength(result.result.title)).toBeLessThanOrEqual(8_192);
  expect(result.result.structuredData).toEqual({ value: 3 });
  expect(result.result.metadata).toEqual({ source: "handler" });
  expect(result.result.artifactIds).toBeUndefined();
});

test("canonical result validation failure records that the tool handler already succeeded", async () => {
  let processed = false;
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const h = harness({
    tool: { async execute() { return { title: "Effect", output: "Effect was applied", structuredData: cycle }; } },
    lifecycle: { async processResult(_context, result) { processed = true; return result; } },
  });
  expect((await h.executor.execute(call({}))).status).toBe("failed");
  expect(processed).toBe(false);
  expect(h.outcomes[0]).toMatchObject({ status: "failed", phase: "processing_result", handlerEntered: true, executionSucceeded: true });
  expect(h.outcomes[0]!.resultProcessingError).toBeInstanceOf(Error);
});

test("ended observer failures cannot change success, denial, or audit failure", async () => {
  for (const kind of ["success", "deny", "audit"] as const) {
    const auditError = new Error("Audit storage unavailable");
    const h = harness({
      gate: { async review() { return { decision: kind === "deny" ? "deny" : "allow" }; } },
      publish(event) { if (kind === "audit" && event.type === "tool.call_started") throw auditError; },
      lifecycle: { ended() { throw new Error("Observer unavailable"); } },
    });
    if (kind === "audit") await expect(h.executor.execute(call({}))).rejects.toThrow("Audit storage unavailable");
    else expect((await h.executor.execute(call({}))).status).toBe(kind === "success" ? "completed" : "failed");
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]!.status).toBe(kind === "success" ? "completed" : kind === "deny" ? "blocked" : "failed");
    if (kind === "audit") expect(h.outcomes[0]).toMatchObject({ phase: "starting", handlerEntered: false, error: { message: "Audit storage unavailable" } });
  }
  const h = harness({ lifecycle: { ended: () => Promise.reject(new Error("Accidental async observer")) } });
  expect((await h.executor.execute(call({}))).status).toBe("completed");
  await Promise.resolve();
});

test("terminal audit failure retains successful execution facts and notifies once", async () => {
  const h = harness({ publish(event) { if (event.type === "tool.call_finished") throw new Error("Terminal audit unavailable"); } });
  await expect(h.executor.execute(call({}))).rejects.toThrow("Terminal audit unavailable");
  expect(h.effects).toHaveLength(1);
  expect(h.outcomes).toHaveLength(1);
  expect(h.outcomes[0]).toMatchObject({ status: "failed", phase: "publishing_result", handlerEntered: true, executionSucceeded: true });
});

test("cancelling review ignores a late permit and notifies one unexecuted outcome", async () => {
  const review = deferred<ToolReviewResult>();
  const began = deferred<void>();
  const controller = new AbortController();
  const h = harness({ gate: { async review() { began.resolve(); return review.promise; } } });
  const pending = h.executor.execute({ ...call({}), signal: controller.signal });
  await began.promise;
  controller.abort();
  expect((await pending).status).toBe("cancelled");
  review.resolve({ decision: "allow" });
  await Promise.resolve();
  expect(h.effects).toHaveLength(0);
  expect(h.outcomes).toHaveLength(1);
  expect(h.outcomes[0]).toMatchObject({ status: "cancelled", phase: "reviewing", handlerEntered: false, executionSucceeded: false });
});

test("cancelling a pending result processor reports an already successful effect without waiting for the processor", async () => {
  const processed = deferred<ToolResult>();
  const began = deferred<void>();
  const controller = new AbortController();
  const h = harness({ lifecycle: { async processResult() { began.resolve(); return processed.promise; } } });
  const pending = h.executor.execute({ ...call({}), signal: controller.signal });
  await began.promise;
  controller.abort();
  expect((await pending).status).toBe("cancelled");
  processed.resolve({ title: "Late", output: "too late" });
  await Promise.resolve();
  expect(h.effects).toHaveLength(1);
  expect(h.outcomes).toHaveLength(1);
  expect(h.outcomes[0]).toMatchObject({ status: "cancelled", phase: "processing_result", handlerEntered: true, executionSucceeded: true });
});

test("nested code-mode calls share lifecycle coverage and preserve canonical structured data", async () => {
  const h = harness({
    tool: { async execute() { return { title: "Child", output: "canonical child", structuredData: { answer: 42 } }; } },
    lifecycle: { async processResult(context, result) {
      return context.toolName === "effect" ? { ...result, output: "display child", structuredData: { answer: 0 } } : result;
    } },
  });
  h.registry.register(createCodeModeTool());
  const result = await h.executor.execute({ ...call({ code: 'const result = await tools.effect({}); text({output:result.output,answer:result.structuredData.answer});' }), toolName: "code_mode" });
  expect(result.status).toBe("completed");
  if (result.status !== "completed") throw result.error;
  expect(JSON.parse(result.result.output)).toEqual({ output: "display child", answer: 42 });
  expect(h.outcomes).toHaveLength(2);
  const child = h.outcomes.find((outcome) => outcome.context.toolName === "effect")!;
  const parent = h.outcomes.find((outcome) => outcome.context.toolName === "code_mode")!;
  expect(child.context).toMatchObject({ parentCallId: parent.context.callId, invocationMode: "code" });
  expect(child).toMatchObject({ status: "completed", result: { output: "display child" }, canonicalResult: { output: "canonical child" } });
  expect(h.outcomes.every((outcome) => outcome.handlerEntered && outcome.executionSucceeded)).toBe(true);
});

test("real MCP adapters retain review denial and report one canonical and presented successful execution", async () => {
  // MCP depends on tools. Load its actual adapter at runtime without creating a
  // reverse TypeScript project dependency just for this integration test.
  const adapterModulePath = "../../mcp/src/tool-adapter.js";
  const { createMcpChiliTool } = await import(adapterModulePath) as {
    createMcpChiliTool(options: unknown): ChiliToolDefinition;
  };
  let allow = false;
  let remoteCalls = 0;
  let processed = 0;
  const reviews: unknown[] = [];
  const tool = createMcpChiliTool({
    server: { name: "lifecycle-fixture", type: "http", url: "https://example.test/mcp", headers: {},
      enabled: true, required: false, trust: false, source: "user", raw: {} },
    tool: { name: "items.create", description: "Create an item", inputSchema: { type: "object" } },
    manager: { async callTool(_server: string, _name: string, input: unknown) {
      remoteCalls++;
      expect(input).toEqual({ title: "Approved item" });
      return { content: [{ type: "text", text: "Canonical MCP response" }], structuredContent: { itemId: 42 } };
    } },
  });
  const h = harness({
    gate: { async review(request) { reviews.push(request); return { decision: allow ? "allow" : "deny" }; } },
    lifecycle: { async processResult(_context, result) {
      processed++;
      return { ...result, output: "Displayed MCP response", structuredData: { itemId: 0 } };
    } },
  });
  h.registry.register(tool);
  const attempted = { ...call({ title: "Approved item" }), toolName: tool.name };
  expect((await h.executor.execute(attempted)).status).toBe("failed");
  expect(remoteCalls).toBe(0);
  expect(processed).toBe(0);
  expect(h.outcomes).toHaveLength(1);
  expect(h.outcomes[0]).toMatchObject({ status: "blocked", phase: "reviewing", handlerEntered: false, executionSucceeded: false });

  allow = true;
  const result = await h.executor.execute({ ...attempted, callId: "call_mcp_allowed" as ToolCallId });
  expect(result.status).toBe("completed");
  if (result.status !== "completed") throw result.error;
  expect(remoteCalls).toBe(1);
  expect(processed).toBe(1);
  expect(reviews).toHaveLength(2);
  expect(result.result).toMatchObject({ output: "Displayed MCP response", structuredData: { itemId: 42 } });
  expect(h.outcomes).toHaveLength(2);
  expect(h.outcomes[1]).toMatchObject({ status: "completed", handlerEntered: true, executionSucceeded: true,
    context: { toolName: tool.name, resources: { permission: "mcp", patterns: ["lifecycle-fixture/items.create"] } },
    result: { output: "Displayed MCP response" }, canonicalResult: { structuredData: { itemId: 42 } } });
  expect(h.outcomes[1]!.canonicalResult!.output).toContain("Canonical MCP response");
  expect(h.events.findLast((event) => event.type === "tool.call_finished")).toMatchObject({
    payload: { status: "completed", output: h.outcomes[1]!.canonicalResult!.output },
  });
});

function harness(options: {
  tool?: Partial<ChiliToolDefinition>;
  gate?: ToolExecutionGate;
  lifecycle?: ToolLifecycleHooks;
  publish?: (event: RuntimeEvent) => void;
  now?: () => TimestampMs;
  maxResultOutputBytes?: number;
} = {}) {
  const registry = new InMemoryToolRegistry();
  const effects: unknown[] = [];
  const events: RuntimeEvent[] = [];
  const outcomes: ToolLifecycleOutcome[] = [];
  registry.register({ name: "effect", description: "Lifecycle effect", risk: "write", codeMode: true,
    inputSchema: { type: "object" }, resources: () => false,
    async execute(input) { effects.push(input); return { title: "Effect", output: "canonical output" }; },
    ...options.tool,
  });
  const executor = new ToolExecutor({
    registry, gate: options.gate ?? { async review() { return { decision: "allow" }; } },
    events: { async publish(event) { options.publish?.(event); events.push(event); } },
    lifecycle: {
      ...(options.lifecycle?.processResult ? { processResult: options.lifecycle.processResult } : {}),
      ended(outcome) { outcomes.push(outcome); return options.lifecycle?.ended?.(outcome); },
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxResultOutputBytes === undefined ? {} : { maxResultOutputBytes: options.maxResultOutputBytes }),
  });
  return { executor, registry, effects, events, outcomes };
}

function call(input: unknown): ExecuteToolInput {
  return { sessionId: "session_lifecycle" as SessionId, turnId: "turn_lifecycle" as TurnId,
    callId: "call_lifecycle" as ToolCallId, toolName: "effect", input, cwd: process.cwd() };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
