import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { ToolResult } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor, type ChiliToolExecutionContext } from "@chili/tools";
import type { DoomLoopGuardOptions } from "./doom-loop-guard.js";
import type { ModelRouter, ModelStreamEvent } from "./runtime.js";
import { SingleAgentRuntime } from "./single-agent-runtime.js";

const stores: SqliteEventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function harness(options: {
  calls: Array<{ name: string; input: unknown }>;
  compose: (context: ChiliToolExecutionContext) => Promise<ToolResult>;
  doomLoopGuard?: DoomLoopGuardOptions;
  maxConcurrentToolCalls?: number;
  inspect?: () => Promise<void>;
}) {
  const store = new SqliteEventStore(":memory:");
  stores.push(store);
  const registry = new InMemoryToolRegistry();
  const executed: unknown[] = [];
  registry.register({
    name: "inspect",
    description: "Inspect a value.",
    risk: "read",
    codeMode: true,
    isConcurrencySafe: true,
    inputSchema: { type: "object" },
    approval: () => false,
    async execute(input) {
      executed.push(input);
      await options.inspect?.();
      return { title: "inspect", output: "observed" };
    },
  });
  registry.register({
    name: "compose",
    description: "Compose tools through the host dispatcher.",
    risk: "read",
    isOrchestrator: true,
    inputSchema: { type: "object" },
    approval: () => false,
    execute: (_input, context) => options.compose(context),
  });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      for (const call of options.calls) yield { type: "tool_call", ...call };
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
    ...(options.doomLoopGuard ? { doomLoopGuard: options.doomLoopGuard } : {}),
    ...(options.maxConcurrentToolCalls ? { maxConcurrentToolCalls: options.maxConcurrentToolCalls } : {}),
  });
  return { runtime, store, executed };
}

test("nested calls share the turn budget and cannot hide guard failures by catching them", async () => {
  const fixture = harness({
    calls: [{ name: "inspect", input: { value: "direct" } }, { name: "compose", input: {} }],
    doomLoopGuard: { maxToolCallsPerTurn: 3 },
    async compose(context) {
      await context.invokeTool!("inspect", { value: "nested" });
      await context.invokeTool!("inspect", { value: "blocked" }).catch(() => undefined);
      return { title: "compose", output: "caught the error" };
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  const result = await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() });

  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.name).toBe("DoomLoopError");
  expect(fixture.executed).toEqual([{ value: "direct" }, { value: "nested" }]);
  expect(await fixture.store.events({ sessionId, type: "turn.guard_triggered" })).toMatchObject([
    { payload: { reason: "tool_call_limit", toolName: "inspect", count: 4 } },
  ]);
  const parts = (await fixture.store.messages(sessionId)).flatMap((message) => message.parts);
  expect(parts.filter((part) => part.type === "tool_call")).toHaveLength(2);
  expect(parts.filter((part) => part.type === "tool_result")).toHaveLength(2);
  expect(await fixture.store.events({ sessionId, type: "tool.call_started" })).toHaveLength(4);
});

test("nested calls share repeated-input history with direct calls", async () => {
  const fixture = harness({
    calls: [{ name: "inspect", input: { value: "same" } }, { name: "compose", input: {} }],
    doomLoopGuard: { maxRepeatedToolCalls: 1 },
    async compose(context) {
      await context.invokeTool!("inspect", { value: "same" });
      return { title: "compose", output: "unreachable" };
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  expect((await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() })).status).toBe("failed");
  expect(fixture.executed).toEqual([{ value: "same" }]);
  expect(await fixture.store.events({ sessionId, type: "turn.guard_triggered" })).toMatchObject([
    { payload: { reason: "repeated_tool_call", toolName: "inspect", count: 2 } },
  ]);
});

test("concurrent turns have independent nested-call scopes", async () => {
  const fixture = harness({
    calls: [{ name: "compose", input: {} }],
    doomLoopGuard: { maxToolCallsPerTurn: 2, maxRepeatedToolCalls: 1 },
    async compose(context) {
      await context.invokeTool!("inspect", { value: "same" });
      return { title: "compose", output: "done" };
    },
  });
  const sessions = await Promise.all([
    fixture.runtime.createSession({ cwd: tmpdir() }),
    fixture.runtime.createSession({ cwd: tmpdir() }),
  ]);
  const results = await Promise.all(sessions.map((sessionId) => fixture.runtime.runTurn({ sessionId, cwd: tmpdir() })));
  expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
  expect(fixture.executed).toHaveLength(2);
  expect(await fixture.store.events({ type: "turn.guard_triggered" })).toEqual([]);
});

test("nested calls inherit the runtime concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const fixture = harness({
    calls: [{ name: "compose", input: {} }],
    maxConcurrentToolCalls: 2,
    async compose(context) {
      await Promise.all([1, 2, 3, 4].map((value) => context.invokeTool!("inspect", { value })));
      return { title: "compose", output: "done" };
    },
    async inspect() {
      peak = Math.max(peak, ++active);
      await Bun.sleep(10);
      active--;
    },
  });
  const sessionId = await fixture.runtime.createSession({ cwd: tmpdir() });
  expect((await fixture.runtime.runTurn({ sessionId, cwd: tmpdir() })).status).toBe("completed");
  expect(fixture.executed).toHaveLength(4);
  expect(peak).toBe(2);
});
