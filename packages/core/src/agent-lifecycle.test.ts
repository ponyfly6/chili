import { afterEach, expect, test } from "bun:test";
import type { AgentPath, MessageId, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type { AgentLifecycleHooks, AgentRunContext, AgentRunOutcome } from "./agent-lifecycle.js";
import type { AgentRunner, RunTurnInput, RunTurnResult } from "./runner.js";
import { RuntimeService, type RuntimeServiceOptions } from "./runtime-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

test("one Agent input emits one lifecycle across model turns after durable settlement", async () => {
  const f = await fixture({ run: async (input, index) => complete(input, index < 3 ? "tool_use" : "stop") });
  const result = await f.service.submitPrompt({ sessionId: f.sessionId, text: "work" });
  expect(result.status).toBe("completed");
  expect(result.turns).toHaveLength(3);
  expect(f.started).toHaveLength(1);
  expect(f.ended).toHaveLength(1);
  expect(f.ended[0]).toMatchObject({ ...f.started[0], status: "completed", turnCount: 3 });
  expect(f.started[0]).toMatchObject({ agentRole: "root", cwd: "/repo", sessionId: f.sessionId });
  expect(f.started[0]!.runId).toBe(f.started[0]!.executionRef);
  expect(f.started[0]!.inputId).toBeDefined();
  expect(f.ended[0]!.endedAt).toBeGreaterThanOrEqual(f.started[0]!.startedAt);
  expect(f.settledSnapshots).toEqual([{ state: "settled", outcome: "completed", hasLease: false, running: false }]);
  expect((await f.store.events({ sessionId: f.sessionId, type: "session.status_changed" })).at(-1)?.payload)
    .toMatchObject({ status: "idle" });
});

test("Agent lifecycle records runner failure while observer exceptions cannot change the result", async () => {
  const f = await fixture({
    run: async () => { throw new Error("runner failed"); },
    lifecycle: {
      started() { throw new Error("start observer failed"); },
      ended() { return Promise.reject(new Error("accidental async observer failed")); },
    },
  });
  expect((await f.service.submitPrompt({ sessionId: f.sessionId, text: "fail" })).status).toBe("failed");
  expect(f.started).toHaveLength(1);
  expect(f.ended).toHaveLength(1);
  expect(f.ended[0]).toMatchObject({ status: "failed", error: "runner failed", turnCount: 0 });
  expect(f.settledSnapshots).toEqual([{ state: "settled", outcome: "failed", hasLease: false, running: false }]);
});

test("cancelled Agent end waits for resource cleanup and is observed before reentrant shutdown completes", async () => {
  const entered = deferred();
  const resourceStarted = deferred();
  const resourceFinished = deferred();
  const order: string[] = [];
  let reentrantShutdown: Promise<void> | undefined;
  const f = await fixture({
    run: async (input) => {
      entered.resolve();
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { status: "cancelled", turnId: input.turnId!, error: new Error("stopped") };
    },
    serviceOptions: { stopSessionResources: async () => {
      resourceStarted.resolve();
      await resourceFinished.promise;
      order.push("resources-settled");
      return true;
    } },
    lifecycle: { ended() {
      order.push("ended");
      reentrantShutdown = f.service.shutdown();
    } },
  });
  const prompt = f.service.submitPrompt({ sessionId: f.sessionId, text: "wait" });
  await entered.promise;
  const interrupt = f.service.interrupt(f.sessionId);
  await resourceStarted.promise;
  const shutdown = f.service.shutdown().then(() => { order.push("shutdown"); });
  try {
    await Promise.resolve();
    expect(f.ended).toEqual([]);
    expect(f.store.sessionRunClaim(f.sessionId)).toBeDefined();
  } finally {
    resourceFinished.resolve();
  }
  expect((await prompt).status).toBe("cancelled");
  await interrupt;
  await shutdown;
  await reentrantShutdown;
  expect(f.ended).toHaveLength(1);
  expect(f.ended[0]).toMatchObject({ status: "cancelled", turnCount: 1 });
  expect(f.settledSnapshots).toEqual([{ state: "settled", outcome: "interrupted", hasLease: false, running: false }]);
  expect(order).toEqual(["resources-settled", "ended", "shutdown"]);
});

test("a child input uses its persisted child identity through the same lifecycle", async () => {
  const f = await fixture({ agentRole: "child" });
  expect((await f.service.submitPrompt({ sessionId: f.sessionId, text: "child work" })).status).toBe("completed");
  expect(f.started).toHaveLength(1);
  expect(f.started[0]).toMatchObject({ sessionId: f.sessionId, agentRole: "child" });
  expect(f.ended[0]).toMatchObject({ ...f.started[0], status: "completed", turnCount: 1 });
  expect(f.settledSnapshots[0]).toMatchObject({ state: "settled", hasLease: false });
});

test("input cancellation before a run permit and non-prompt operations emit no Agent lifecycle", async () => {
  const waiting = deferred();
  const f = await fixture({ serviceOptions: { runInput: async (_sessionId, signal) => {
    waiting.resolve();
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    throw new Error("unreachable");
  } } });
  await f.service.withSessionOperation(f.sessionId, () => undefined);
  expect((await f.service.compactSession({ sessionId: f.sessionId })).status).toBe("skipped");
  expect(f.started).toEqual([]);
  expect(f.ended).toEqual([]);
  const prompt = f.service.submitPrompt({ sessionId: f.sessionId, text: "never started" });
  await waiting.promise;
  await f.service.shutdown();
  expect((await prompt).status).toBe("cancelled");
  expect(f.started).toEqual([]);
  expect(f.ended).toEqual([]);
});

test("separate concurrent inputs retain independent Agent identities and max-turn outcomes", async () => {
  const f = await fixture({ run: async (input) => complete(input, "tool_use"), serviceOptions: { maxTurns: 1 } });
  const secondId = "lifecycle_second" as SessionId;
  await seed(f.store, secondId);
  const results = await Promise.all([f.sessionId, secondId].map((sessionId) => f.service.submitPrompt({ sessionId, text: "continue" })));
  expect(results.map((result) => result.status)).toEqual(["max_turns", "max_turns"]);
  expect(f.started).toHaveLength(2);
  expect(new Set(f.started.map((run) => run.runId)).size).toBe(2);
  expect(f.ended).toHaveLength(2);
  expect(f.ended.map((run) => [run.status, run.turnCount])).toEqual([["max_turns", 2], ["max_turns", 2]]);
  expect(f.settledSnapshots.every((entry) => entry.state === "settled" && !entry.hasLease && !entry.running)).toBe(true);
});

async function fixture(options: {
  agentRole?: "root" | "child";
  run?: (input: RunTurnInput, index: number) => Promise<RunTurnResult>;
  lifecycle?: AgentLifecycleHooks;
  serviceOptions?: Pick<RuntimeServiceOptions, "runInput" | "stopSessionResources" | "maxTurns">;
} = {}) {
  const store = new SqliteEventStore(":memory:");
  const sessionId = "lifecycle_input" as SessionId;
  const started: AgentRunContext[] = [];
  const ended: AgentRunOutcome[] = [];
  const settledSnapshots: Array<{ state?: string; outcome?: string; hasLease: boolean; running: boolean }> = [];
  const turns: RunTurnInput[] = [];
  const runner: AgentRunner & { compactContext(): Promise<{ status: "skipped"; reason: string }> } = {
    createSession: async () => sessionId,
    appendUserMessage: async () => { throw new Error("Durable input promotion must be atomic"); },
    runTurn: async (input) => {
      turns.push(input);
      return options.run ? options.run(input, turns.length) : complete(input);
    },
    compactContext: async () => ({ status: "skipped", reason: "No history" }),
  };
  if (options.agentRole === "child") await seed(store, "lifecycle_parent" as SessionId);
  await seed(store, sessionId, options.agentRole);
  const service = new RuntimeService({
    store, runtime: runner, cwd: "/repo", sessionAccess: options.agentRole ?? "root",
    ...options.serviceOptions,
    agentLifecycle: {
      started(context) { started.push(context); return options.lifecycle?.started?.(context); },
      ended(outcome) {
        ended.push(outcome);
        const input = outcome.inputId ? store.sessionInputById(outcome.sessionId, outcome.inputId) : undefined;
        settledSnapshots.push({ ...(input ? { state: input.state } : {}), ...(input?.outcome ? { outcome: input.outcome } : {}),
          hasLease: store.sessionRunClaim(outcome.sessionId) !== undefined, running: service.isRunning(outcome.sessionId) });
        return options.lifecycle?.ended?.(outcome);
      },
    },
  });
  cleanups.push(async () => { await service.shutdown(); await store.flushInputMirrors(); store.close(); });
  return { service, store, sessionId, started, ended, settledSnapshots };
}

async function seed(store: SqliteEventStore, sessionId: SessionId, role?: "root" | "child") {
  await store.append({ id: crypto.randomUUID(), type: "session.created", sessionId, time: Date.now() as TimestampMs,
    payload: { sessionId, cwd: "/repo", ...(role === "child" ? { agent: {
      parentSessionId: "lifecycle_parent" as SessionId, name: "child", path: "/root/child" as AgentPath, policy: {},
    } } : {}) } });
}

function complete(input: RunTurnInput, finishReason = "stop"): RunTurnResult {
  return { status: "completed", turnId: input.turnId ?? crypto.randomUUID() as TurnId, assistantMessageId: "answer" as MessageId, finishReason };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
