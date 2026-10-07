import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { RuntimeEvent, SessionId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor, ToolValidationError, type ToolLifecycleOutcome } from "@chili/tools";
import type { ModelStreamEvent } from "./runtime.js";
import { SingleAgentRuntime } from "./single-agent-runtime.js";

const stores: SqliteEventStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

for (const failure of ["parse", "validation", "prepare", "unknown"] as const) {
  test(`runtime ${failure} refusal emits one failed tool end without entering its handler`, async () => {
    const f = await fixture({ failure });
    await f.run();
    await assertTerminal(f, "failed", "validating", 1);
    const parts = await toolResultParts(f);
    expect(parts).toMatchObject([{ type: "tool_result", synthetic: true, output: "", error: expect.any(String) }]);
  });
}

for (const restriction of ["disabled", "unloaded"] as const) {
  test(`${restriction} tool use emits blocked lifecycle while public audit remains failed`, async () => {
    const f = await fixture({ restriction });
    await f.run();
    await assertTerminal(f, "blocked", "authorizing", 1);
    expect(await toolResultParts(f)).toMatchObject([{ type: "tool_result", synthetic: true }]);
  });
}

for (const terminal of ["failed", "cancelled"] as const) {
  test(`complete pending calls emit one ${terminal} end when the model stream stops`, async () => {
    const f = await fixture({ terminal });
    expect((await f.run()).status).toBe(terminal);
    await assertTerminal(f, terminal, "starting", 1);
    expect(await toolResultParts(f)).toMatchObject([{ type: "tool_result", synthetic: true }]);
  });

  test(`incomplete streamed arguments emit one ${terminal} end without inventing message parts`, async () => {
    const f = await fixture({ terminal, incomplete: true });
    expect((await f.run()).status).toBe(terminal);
    await assertTerminal(f, terminal, "starting", 0);
    expect(f.ended[0]?.context.input).toEqual('{"path":');
    expect((await f.store.messages(f.sessionId)).flatMap((message) => message.parts)
      .filter((part) => part.type === "tool_call" || part.type === "tool_result")).toEqual([]);
  });
}

test("doom-loop refusal records blocked lifecycle once and preserves its guard and result events", async () => {
  const f = await fixture({ guard: true });
  expect((await f.run()).status).toBe("failed");
  await assertTerminal(f, "blocked", "authorizing", 1);
  expect(await f.store.events({ sessionId: f.sessionId, type: "turn.guard_triggered" })).toHaveLength(1);
  expect(await toolResultParts(f)).toMatchObject([{ type: "tool_result", synthetic: true, error: expect.stringContaining("blocked") }]);
});

test("a refused call whose terminal audit fails is not terminalized again by runtime cleanup", async () => {
  const f = await fixture({ failure: "parse", failTerminalAudit: true });
  expect((await f.run()).status).toBe("failed");
  expect(f.ended).toHaveLength(1);
  expect(f.ended[0]).toMatchObject({ status: "failed", phase: "publishing_result", handlerEntered: false, executionSucceeded: false });
  expect(f.attempted.filter((event) => event.type === "tool.call_started")).toHaveLength(1);
  expect(f.attempted.filter((event) => event.type === "tool.call_finished")).toHaveLength(1);
  expect(await f.store.events({ sessionId: f.sessionId, type: "tool.call_finished" })).toEqual([]);
  expect(f.executed).toEqual([]);
});

async function fixture(options: {
  failure?: "parse" | "validation" | "prepare" | "unknown";
  restriction?: "disabled" | "unloaded";
  terminal?: "failed" | "cancelled";
  incomplete?: boolean;
  guard?: boolean;
  failTerminalAudit?: boolean;
} = {}) {
  const store = new SqliteEventStore(":memory:");
  stores.push(store);
  const registry = new InMemoryToolRegistry();
  const ended: ToolLifecycleOutcome[] = [];
  const executed: SessionId[] = [];
  const attempted: RuntimeEvent[] = [];
  const controller = new AbortController();
  let gateCalls = 0;
  let resultProcessors = 0;
  registry.register({
    name: "inspect", description: "Inspect data", risk: "read", resources: () => false,
    inputSchema: { type: "object" },
    ...(options.failure === "validation" ? { validate: () => ({ ok: false as const, message: "invalid prepared input" }) } : {}),
    ...(options.failure === "prepare" ? { prepareInput: () => { throw new ToolValidationError("inspect", "cannot prepare input"); } } : {}),
    execute: async (_input, context) => { executed.push(context.sessionId); return { title: "ok", output: "ok" }; },
  });
  const runtime = new SingleAgentRuntime({
    store,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({ registry,
      events: { publish: async (event) => {
        attempted.push(event);
        if (options.failTerminalAudit && event.type === "tool.call_finished") throw new Error("terminal audit failed");
        await store.append(event);
      } },
      gate: { review: async () => { gateCalls++; return { decision: "allow" }; } },
      lifecycle: {
        processResult: async (_context, result) => { resultProcessors++; return result; },
        ended: (outcome) => { ended.push(outcome); },
      },
    }),
    ...(options.restriction === "unloaded" ? { toolExposure: { eagerTools: [] } } : {}),
    ...(options.guard ? { doomLoopGuard: { maxRepeatedToolCalls: 0 } } : {}),
    retryPolicy: { maxAttempts: 1 },
    model: { async *stream(): AsyncIterable<ModelStreamEvent> {
      const name = options.failure === "unknown" ? "missing" : "inspect";
      yield { type: "tool_call_start", name, toolCallId: "provider_attempt" };
      if (options.incomplete) {
        yield { type: "tool_call_delta", name, toolCallId: "provider_attempt", delta: '{"path":', partialInput: '{"path":' };
      } else {
        yield { type: "tool_call_end", name, toolCallId: "provider_attempt", input: { path: "item" },
          ...(options.failure === "parse" ? { inputParseError: "invalid tool JSON" } : {}) };
      }
      if (options.terminal === "cancelled") { controller.abort(); return; }
      if (options.terminal === "failed") { yield { type: "error", error: new Error("provider stopped") }; return; }
      yield { type: "finish", reason: "tool_use" };
    } },
  });
  const sessionId = await runtime.createSession({ cwd: tmpdir() });
  return { store, sessionId, ended, executed, attempted,
    gateCalls: () => gateCalls, resultProcessors: () => resultProcessors,
    run: () => runtime.runTurn({ sessionId, cwd: tmpdir(), signal: controller.signal,
      ...(options.restriction === "disabled" ? { toolMode: "disabled" as const } : {}) }),
  };
}

async function toolResultParts(f: Awaited<ReturnType<typeof fixture>>) {
  return (await f.store.messages(f.sessionId)).flatMap((message) => message.parts).filter((part) => part.type === "tool_result");
}

async function assertTerminal(f: Awaited<ReturnType<typeof fixture>>, status: ToolLifecycleOutcome["status"],
  phase: ToolLifecycleOutcome["phase"], resultPartCount: number) {
  expect(f.executed).toEqual([]);
  expect(f.gateCalls()).toBe(0);
  expect(f.resultProcessors()).toBe(0);
  expect(f.ended).toHaveLength(1);
  expect(f.ended[0]).toMatchObject({ status, phase, handlerEntered: false, executionSucceeded: false,
    context: { cwd: tmpdir(), sessionId: f.sessionId, providerCallId: "provider_attempt", prepared: false, invocationMode: "direct" } });
  const starts = await f.store.events({ sessionId: f.sessionId, type: "tool.call_started" });
  const finishes = await f.store.events({ sessionId: f.sessionId, type: "tool.call_finished" });
  expect(starts).toHaveLength(1);
  expect(finishes).toHaveLength(1);
  const started = starts[0] as Extract<RuntimeEvent, { type: "tool.call_started" }>;
  expect(finishes[0]).toMatchObject({ payload: { callId: started.payload.callId,
    status: status === "blocked" ? "failed" : status, synthetic: true } });
  expect(f.ended[0]?.context.callId).toBe(started.payload.callId);
  expect(await toolResultParts(f)).toHaveLength(resultPartCount);
}
