import { expect, test } from "bun:test";
import type { SessionId, ToolCallId, ToolResult, TurnId } from "@chili/protocol";
import { createCodeModeTool, type ChiliToolExecutionContext } from "@chili/tools";
import { LocalSubagentConcurrencyLimiter } from "./subagent-run-limiter.js";

test("real code mode preserves permit ownership across Worker capability callbacks", async () => {
  const limiter = new LocalSubagentConcurrencyLimiter(1);
  let childRan = false;
  const result = await run(limiter, "parent", async () => {
    try {
      return await createCodeModeTool().execute({ code: 'text((await tools.agent_spawn({})).output);', timeoutMs: 2_000 },
        context(async () => limiter.suspend("parent", () => run(limiter, "child", async () => {
          childRan = true;
          return { title: "child", output: "child finished" };
        }))));
    } finally {
      await limiter.waitForResume("parent");
    }
  });
  expect(childRan).toBe(true);
  expect(result.output).toBe("child finished");
  expect(limiter.snapshot()).toEqual({ maxActiveRuns: 1, activeRuns: 0, queuedRuns: 0 });
});

test("code mode boundary preserves immediate background handles without releasing a parent slot", async () => {
  const limiter = new LocalSubagentConcurrencyLimiter(1);
  let childRan = false;
  let child: Promise<void> | undefined;
  await run(limiter, "parent", async () => {
    try {
      const result = await createCodeModeTool().execute({ code: 'text((await tools.agent_spawn({})).output);' },
        context(async () => {
          child = run(limiter, "background", async () => { childRan = true; });
          return { title: "Agent", output: "background handle" };
        }));
      expect(result.output).toBe("background handle");
    } finally {
      await limiter.waitForResume("parent");
    }
    expect(childRan).toBe(false);
    expect(limiter.snapshot().activeRuns).toBe(1);
    await limiter.suspend("parent", async () => { await child; });
    expect(childRan).toBe(true);
  });
  expect(limiter.snapshot().activeRuns).toBe(0);
});

test("bounded VM cleanup cannot advance the parent before its permit is restored", async () => {
  const limiter = new LocalSubagentConcurrencyLimiter(1);
  const childStarted = deferred<void>();
  const finishChild = deferred<void>();
  const boundaryEntered = deferred<void>();
  let continued = false;
  let child: Promise<void> | undefined;
  const parent = run(limiter, "parent", async () => {
    child = run(limiter, "background", async () => {
      childStarted.resolve();
      await finishChild.promise;
    });
    try {
      await createCodeModeTool().execute({ code: "await tools.agent_wait({});", timeoutMs: 200 },
        context(async (_name, _input, signal) => limiter.suspend("parent", () =>
          new Promise<ToolResult>((_resolve, reject) => {
            signal!.addEventListener("abort", () => reject(new Error("wait cancelled")), { once: true });
          }))));
      throw new Error("Expected VM timeout");
    } catch (error) {
      expect(String(error)).toContain("termination is unconfirmed");
    } finally {
      boundaryEntered.resolve();
      await limiter.waitForResume("parent");
    }
    expect(limiter.snapshot().activeRuns).toBe(1);
    continued = true;
  });
  await childStarted.promise;
  await boundaryEntered.promise;
  expect(continued).toBe(false);
  expect(limiter.snapshot()).toEqual({ maxActiveRuns: 1, activeRuns: 1, queuedRuns: 1 });
  finishChild.resolve();
  await parent;
  await child;
  expect(continued).toBe(true);
  expect(limiter.snapshot()).toEqual({ maxActiveRuns: 1, activeRuns: 0, queuedRuns: 0 });
});

function context(invokeTool: NonNullable<ChiliToolExecutionContext["invokeTool"]>): ChiliToolExecutionContext {
  return {
    sessionId: "parent" as SessionId,
    turnId: "turn_test" as TurnId,
    callId: "call_test" as ToolCallId,
    outputArtifactId: "call_test" as ToolCallId,
    signal: new AbortController().signal,
    cwd: process.cwd(),
    metadata: async () => {},
    streamOutput: async () => {},
    requestApproval: async () => ({ action: "deny" }),
    registerPersistedOutput: async () => {},
    visibleTools: () => ["agent_spawn", "agent_wait"].map((name) => ({
      name, description: name, risk: "read", codeMode: true, inputSchema: { type: "object" },
      execute: async () => ({ title: name, output: "" }),
    })),
    invokeTool,
  };
}

async function run<T>(limiter: LocalSubagentConcurrencyLimiter, sessionId: string, operation: () => Promise<T>): Promise<T> {
  const permit = await limiter.acquireRun(sessionId);
  try { return await permit.run(operation); } finally { permit.release(); }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}
