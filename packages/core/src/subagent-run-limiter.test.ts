import { describe, expect, test } from "bun:test";
import { LocalSubagentConcurrencyLimiter } from "./subagent-run-limiter.js";

describe("suspension-aware subagent concurrency", () => {
  test("recursive inline children run with one permit and restore capacity before returning", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(1);
    const visited: string[] = [];
    const recurse = (sessionId: string, depth: number): Promise<number> => run(limiter, sessionId, async () => {
      expect(limiter.snapshot().activeRuns).toBe(1);
      visited.push(sessionId);
      if (depth === 0) return 1;
      const result = await limiter.suspend(sessionId, () =>
        // Nested wrappers must not try to resume an already-suspended owner.
        limiter.suspend(sessionId, () => recurse(`${sessionId}/child`, depth - 1)));
      expect(limiter.snapshot().activeRuns).toBe(1);
      return result + 1;
    });

    expect(await recurse("parent", 4)).toBe(5);
    expect(visited).toHaveLength(5);
    expect(limiter.snapshot()).toEqual({ maxActiveRuns: 1, activeRuns: 0, queuedRuns: 0 });
  });

  test("concurrent sibling waits do not reacquire ahead of an unfinished descendant", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(1);
    const events: string[] = [];
    const results = await run(limiter, "parent", async () => {
      const results = await Promise.all(["a", "b", "c"].map((id) =>
        limiter.suspend("parent", async () => {
          const result = await run(limiter, id, async () => {
            events.push(`start:${id}`);
            const child = await limiter.suspend(id, () => run(limiter, `${id}/child`, async () => id));
            events.push(`end:${id}`);
            return child;
          });
          return result;
        }).then((result) => {
          events.push(`parent:${result}`);
          return result;
        })));
      expect(limiter.snapshot().activeRuns).toBe(1);
      return results;
    });

    expect(results).toEqual(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) {
      expect(events.indexOf(`end:${id}`)).toBeLessThan(events.indexOf(`parent:${id}`));
    }
    expect(limiter.snapshot().activeRuns).toBe(0);
  });

  test("a completed spawn can signal another concurrently awaited child", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(1);
    const finishWaitingChild = deferred<string>();
    await run(limiter, "parent", async () => {
      const waiting = limiter.suspend("parent", () => finishWaitingChild.promise);
      const spawned = await limiter.suspend("parent", () => run(limiter, "child-a", async () => "answer from A"));
      // Code-mode scripts can send A's result to B while their earlier wait(B)
      // remains outstanding. Holding this result until B finishes deadlocks.
      expect(spawned).toBe("answer from A");
      expect(limiter.snapshot().activeRuns).toBe(0);
      finishWaitingChild.resolve(spawned);
      expect(await waiting).toBe(spawned);
      expect(limiter.snapshot().activeRuns).toBe(1);
    });
    expect(limiter.snapshot()).toEqual({ maxActiveRuns: 1, activeRuns: 0, queuedRuns: 0 });
  });

  test("a failed concurrent operation can recover without waiting for a sibling", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(1);
    const finishWaitingChild = deferred<void>();
    const expected = new Error("child failed");
    await run(limiter, "parent", async () => {
      const waiting = limiter.suspend("parent", () => finishWaitingChild.promise);
      try {
        await limiter.suspend("parent", async () => { throw expected; });
        throw new Error("Expected child failure");
      } catch (error) {
        expect(error).toBe(expected);
        finishWaitingChild.resolve();
      }
      await waiting;
      expect(limiter.snapshot().activeRuns).toBe(1);
    });
    expect(limiter.snapshot().activeRuns).toBe(0);
  });

  test("a new suspension lets a result already waiting for restoration continue", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(1);
    const completeFirst = deferred<string>();
    const completeSecond = deferred<string>();
    await run(limiter, "parent", async () => {
      const first = limiter.suspend("parent", () => completeFirst.promise);
      const releaseBlocker = await limiter.acquire();
      completeFirst.resolve("first");
      await until(() => limiter.snapshot().queuedRuns === 1);
      const second = limiter.suspend("parent", () => completeSecond.promise);
      expect(await first).toBe("first");
      completeSecond.resolve("second");
      releaseBlocker();
      expect(await second).toBe("second");
      expect(limiter.snapshot().activeRuns).toBe(1);
    });
    expect(limiter.snapshot()).toEqual({ maxActiveRuns: 1, activeRuns: 0, queuedRuns: 0 });
  });

  test("background children receive a fresh owner instead of their creator's async context", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(1);
    const childStarted = deferred<void>();
    const allowChild = deferred<void>();
    let child: Promise<string> | undefined;
    const parent = run(limiter, "parent", async () => {
      await limiter.suspend("parent", async () => {
        child = Promise.resolve().then(() => run(limiter, "child", async () => {
          childStarted.resolve();
          await allowChild.promise;
          // A mismatched session must never release this child's permit.
          await limiter.suspend("parent", async () => expect(limiter.snapshot().activeRuns).toBe(1));
          return limiter.suspend("child", () => run(limiter, "grandchild", async () => "done"));
        }));
        await childStarted.promise;
      });
      expect(limiter.snapshot().activeRuns).toBe(1);
    });
    await childStarted.promise;
    allowChild.resolve();
    await parent;
    expect(await child).toBe("done");
    expect(limiter.snapshot().activeRuns).toBe(0);
  });

  test("new waits release earlier tool results without releasing the outer run boundary", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(1);
    const firstDone = deferred<void>();
    const secondDone = deferred<void>();
    await run(limiter, "parent", async () => {
      const first = limiter.suspend("parent", () => firstDone.promise);
      const releaseBlocker = await limiter.acquire();
      firstDone.resolve();
      await until(() => limiter.snapshot().queuedRuns === 1);
      let resumed = false;
      const boundary = limiter.waitForResume("parent").then(() => { resumed = true; });
      const second = limiter.suspend("parent", () => secondDone.promise);
      await first;
      expect(resumed).toBe(false);
      releaseBlocker();
      await Bun.sleep(1);
      expect(resumed).toBe(false);
      secondDone.resolve();
      await second;
      await boundary;
      expect(resumed).toBe(true);
      expect(limiter.snapshot().activeRuns).toBe(1);
    });
    expect(limiter.snapshot().activeRuns).toBe(0);
  });

  test("aborting the owner rejects its outer boundary even while a call remains pending", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(1);
    const controller = new AbortController();
    const finishTool = deferred<void>();
    const boundaryStarted = deferred<void>();
    let tool: Promise<void> | undefined;
    const parent = run(limiter, "parent", async () => {
      tool = limiter.suspend("parent", () => finishTool.promise);
      const boundary = limiter.waitForResume("parent");
      boundaryStarted.resolve();
      await boundary;
    }, controller.signal);
    const rejected = parent.catch((error: unknown) => error);
    await boundaryStarted.promise;
    controller.abort();
    expect(await rejected).toHaveProperty("name", "AbortError");
    const toolRejected = tool!.catch((error: unknown) => error);
    finishTool.resolve();
    expect(await toolRejected).toHaveProperty("name", "AbortError");
    expect(limiter.snapshot()).toEqual({ maxActiveRuns: 1, activeRuns: 0, queuedRuns: 0 });
  });

  test("errors restore the parent permit before reaching its continuation", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(1);
    const operationDone = deferred<void>();
    const failOperation = deferred<void>();
    const expected = new Error("descendant failed");
    let caught = false;
    const parent = run(limiter, "parent", async () => {
      try {
        await limiter.suspend("parent", async () => {
          operationDone.resolve();
          await failOperation.promise;
          throw expected;
        });
      } catch (error) {
        expect(error).toBe(expected);
        expect(limiter.snapshot().activeRuns).toBe(1);
        caught = true;
      }
    });
    await operationDone.promise;
    const releaseBlocker = await limiter.acquire();
    failOperation.resolve();
    await until(() => limiter.snapshot().queuedRuns === 1);
    expect(caught).toBe(false);
    releaseBlocker();
    await parent;
    expect(caught).toBe(true);
    expect(limiter.snapshot().activeRuns).toBe(0);
  });

  test("aborting a suspended owner cancels its reacquisition without leaking permits", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(1);
    const controller = new AbortController();
    const suspended = deferred<void>();
    const continueOperation = deferred<void>();
    const parent = run(limiter, "parent", () => limiter.suspend("parent", async () => {
      suspended.resolve();
      await continueOperation.promise;
    }), controller.signal);
    const rejected = parent.then(() => { throw new Error("Expected the parent to abort"); }, (error: unknown) => error);
    await suspended.promise;
    const releaseBlocker = await limiter.acquire();
    continueOperation.resolve();
    await until(() => limiter.snapshot().queuedRuns === 1);
    controller.abort();
    expect(await rejected).toHaveProperty("name", "AbortError");
    expect(limiter.snapshot()).toEqual({ maxActiveRuns: 1, activeRuns: 1, queuedRuns: 0 });
    releaseBlocker();
    expect(limiter.snapshot().activeRuns).toBe(0);
  });

  test("releasing an owner cancels an in-flight restoration", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(1);
    const permit = await limiter.acquireRun("parent");
    const suspended = deferred<void>();
    const continueOperation = deferred<void>();
    const parent = permit.run(() => limiter.suspend("parent", async () => {
      suspended.resolve();
      await continueOperation.promise;
    }));
    const rejected = parent.then(() => { throw new Error("Expected the parent to abort"); }, (error: unknown) => error);
    await suspended.promise;
    const releaseBlocker = await limiter.acquire();
    continueOperation.resolve();
    await until(() => limiter.snapshot().queuedRuns === 1);
    permit.release();
    expect(await rejected).toHaveProperty("name", "AbortError");
    expect(limiter.snapshot().queuedRuns).toBe(0);
    releaseBlocker();
    permit.release();
    expect(limiter.snapshot().activeRuns).toBe(0);
  });

  test("root calls without owned permits leave the shared pool unchanged", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(1);
    const release = await limiter.acquire();
    expect(await limiter.suspend("root", async () => limiter.snapshot().activeRuns)).toBe(1);
    release();
  });

  test("nested operations cannot start after their suspended owner is aborted", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(1);
    const controller = new AbortController();
    let nestedStarted = false;
    const parent = run(limiter, "parent", () => limiter.suspend("parent", async () => {
      controller.abort();
      await limiter.suspend("parent", async () => { nestedStarted = true; });
    }), controller.signal);
    await expect(parent).rejects.toHaveProperty("name", "AbortError");
    expect(nestedStarted).toBe(false);
    expect(limiter.snapshot()).toEqual({ maxActiveRuns: 1, activeRuns: 0, queuedRuns: 0 });
  });

  test("multiple recursive trees respect the global limit", async () => {
    const limiter = new LocalSubagentConcurrencyLimiter(3);
    let peak = 0;
    const recurse = (id: string, depth: number): Promise<void> => run(limiter, id, async () => {
      peak = Math.max(peak, limiter.snapshot().activeRuns);
      expect(limiter.snapshot().activeRuns).toBeLessThanOrEqual(3);
      if (depth > 0) {
        await Promise.all(["left", "right"].map((child) => limiter.suspend(id, () => recurse(`${id}/${child}`, depth - 1))));
      }
      expect(limiter.snapshot().activeRuns).toBeLessThanOrEqual(3);
    });
    await Promise.all(["a", "b", "c", "d"].map((id) => recurse(id, 3)));
    expect(peak).toBe(3);
    expect(limiter.snapshot()).toEqual({ maxActiveRuns: 3, activeRuns: 0, queuedRuns: 0 });
  });
});

async function run<T>(limiter: LocalSubagentConcurrencyLimiter, sessionId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const permit = await limiter.acquireRun(sessionId, signal);
  try {
    return await permit.run(operation);
  } finally {
    permit.release();
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error("Concurrency condition did not become true");
}
