import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, ToolCallId, TurnId } from "@chili/protocol";
import { createCodeModeTool } from "./builtins/code-mode.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ChiliToolDefinition, ExecuteToolInput, ToolExecutionGate, ToolReviewRequest, ToolReviewResult } from "./types.js";

test("every call enters the gate, including tools without resource descriptors", async () => {
  const requests: ToolReviewRequest[] = [];
  const fixture = setup({ review: async (request) => { requests.push(request); return { decision: "allow" }; } });
  expect((await fixture.executor.execute(call({ value: 1 }))).status).toBe("completed");
  expect((await fixture.executor.execute(call({ value: 2 }, "second"))).status).toBe("completed");
  expect(requests.map(({ input }) => input)).toEqual([{ value: 1 }, { value: 2 }]);
  expect(requests[0]?.resources).toBeUndefined();
  expect(fixture.effects).toEqual([{ value: 1 }, { value: 2 }]);
  expect(fixture.events.some((event) => event.type.startsWith("approval."))).toBe(false);
});

test("a denial returns its reason to the agent without executing", async () => {
  const fixture = setup({ review: async () => ({ decision: "deny", reason: "Target is outside the requested task." }) });
  const result = await fixture.executor.execute(call({ value: 1 }));
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("Target is outside the requested task.");
  expect(fixture.effects).toEqual([]);
});

test("review receives the prepared, deeply frozen input and execution uses the same object", async () => {
  let reviewed: unknown;
  let executed: unknown;
  const original = { nested: { target: "relative", content: "complete payload" } };
  const fixture = setup({ review: async (request) => {
    reviewed = request.input;
    expect(request).toMatchObject({ sessionId: "session_review", turnId: "turn_review", callId: "first", toolName: "effect", toolDescription: "Test effect", risk: "write", cwd: process.cwd() });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.input)).toBe(true);
    expect(Object.isFrozen((request.input as typeof original).nested)).toBe(true);
    expect(request.input).toEqual({ nested: { target: "resolved", content: "complete payload" } });
    original.nested.content = "changed after review";
    return { decision: "allow" };
  } }, { prepareInput: (input) => ({ nested: { ...input.nested, target: "resolved" } }), execute: async (input) => {
    executed = input;
    return { title: "done", output: "ok" };
  } });
  expect((await fixture.executor.execute(call(original))).status).toBe("completed");
  expect(executed).toBe(reviewed);
  expect(executed).toEqual({ nested: { target: "resolved", content: "complete payload" } });
});

for (const value of [undefined, null, {}, { decision: "surprise" }, { decision: "allow", assertCurrent: true }]) {
  test(`malformed review result ${JSON.stringify(value)} fails closed`, async () => {
    const fixture = setup({ review: async () => value as ToolReviewResult });
    expect((await fixture.executor.execute(call({}))).status).toBe("failed");
    expect(fixture.effects).toEqual([]);
  });
}

test("invalid resource descriptors fail before review or execution", async () => {
  for (const resources of [
    { permission: "effect", patterns: [] },
    { permission: "effect", patterns: [" "] },
    { permission: "x".repeat(513), patterns: ["target"] },
    { permission: "effect", patterns: ["x".repeat(8_192)] },
    { permission: "effect", patterns: Array.from({ length: 65 }, (_, index) => `target-${index}`) },
  ]) {
    let reviews = 0;
    const fixture = setup({ review: async () => { reviews++; return { decision: "allow" }; } }, { resources: () => resources });
    expect((await fixture.executor.execute(call({}))).status).toBe("failed");
    expect(reviews).toBe(0);
    expect(fixture.effects).toEqual([]);
  }
});

test("a failed reviewer request never executes the tool", async () => {
  const fixture = setup({ review: async () => { throw new Error("Reviewer unavailable"); } });
  const result = await fixture.executor.execute(call({}));
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("Reviewer unavailable");
  expect(fixture.effects).toEqual([]);
});

test("aborting review cancels execution and ignores a late allow", async () => {
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let resolveReview!: (review: ToolReviewResult) => void;
  const pending = new Promise<ToolReviewResult>((resolve) => { resolveReview = resolve; });
  const fixture = setup({ review: async (_request, signal) => {
    expect(signal).toBeDefined();
    markStarted();
    return pending;
  } });
  const execution = fixture.executor.execute({ ...call({}), signal: controller.signal });
  await started;
  controller.abort();
  expect((await execution).status).toBe("cancelled");
  resolveReview({ decision: "allow" });
  await Promise.resolve();
  expect(fixture.effects).toEqual([]);
  expect(fixture.events.filter((event) => event.type === "tool.call_finished")).toHaveLength(1);
});

test("authorization is rechecked after asynchronous lifecycle work without a second review", async () => {
  let revoked = false;
  let reviewed = 0;
  const fixture = setup({ review: async () => {
    reviewed++;
    return { decision: "allow", assertCurrent: async () => { if (revoked) throw new Error("Review settings changed"); } };
  } }, {}, (event) => {
    if (event.type === "tool.call_updated" && event.payload.status === "running") revoked = true;
  });
  const result = await fixture.executor.execute(call({}));
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("Review settings changed");
  expect(reviewed).toBe(1);
  expect(fixture.effects).toEqual([]);
});

test("nested code mode calls are reviewed separately with the child arguments", async () => {
  const requests: ToolReviewRequest[] = [];
  const fixture = setup({ review: async (request) => {
    requests.push(request);
    return request.toolName === "effect" ? { decision: "deny", reason: "Child denied" } : { decision: "allow" };
  } }, { codeMode: true });
  fixture.registry.register(createCodeModeTool());
  const result = await fixture.executor.execute({ ...call({ code: "text(await tools.effect({ value: 7 }));" }), toolName: "code_mode" });
  expect(result.status).toBe("failed");
  expect(requests.map(({ toolName }) => toolName)).toEqual(["code_mode", "effect"]);
  expect(requests[1]?.input).toEqual({ value: 7 });
  expect(requests[1]?.parentCallId).toBe(requests[0]?.callId);
  expect(fixture.effects).toEqual([]);
});

test("independent calls never reuse another call's allow result", async () => {
  const fixture = setup({ review: async ({ input }) => ({ decision: (input as { value: number }).value === 1 ? "allow" : "deny" }) });
  const results = await Promise.all([fixture.executor.execute(call({ value: 1 })), fixture.executor.execute(call({ value: 2 }, "second"))]);
  expect(results.map(({ status }) => status)).toEqual(["completed", "failed"]);
  expect(fixture.effects).toEqual([{ value: 1 }]);
});

function setup(gate: ToolExecutionGate, overrides: Partial<ChiliToolDefinition> = {}, publish?: (event: ChiliEvent) => void) {
  const effects: unknown[] = [];
  const events: ChiliEvent[] = [];
  const registry = new InMemoryToolRegistry();
  registry.register({ name: "effect", description: "Test effect", risk: "write", inputSchema: { type: "object" }, resources: () => false,
    execute: async (input) => { effects.push(input); return { title: "done", output: "ok" }; }, ...overrides });
  const executor = new ToolExecutor({ registry, gate, events: { publish: async (event) => { events.push(event); publish?.(event); } } });
  return { registry, executor, effects, events };
}

function call(input: unknown, callId = "first"): ExecuteToolInput {
  return { sessionId: "session_review" as SessionId, turnId: "turn_review" as TurnId, callId: callId as ToolCallId, toolName: "effect", input, cwd: process.cwd() };
}
