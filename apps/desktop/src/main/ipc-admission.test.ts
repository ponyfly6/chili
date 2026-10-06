import { expect, test } from "bun:test";
import { DesktopIpcAdmission, DesktopIpcCapacityError } from "./ipc-admission.js";

test("bounds concurrent ordinary IPC while preserving critical stop admission", async () => {
  const admission = new DesktopIpcAdmission({ normalMaxItems: 4, criticalMaxItems: 2 });
  const gate = deferred<void>();
  let active = 0;
  let peak = 0;
  let rejected = 0;

  const reads = Array.from({ length: 100 }, async () => {
    let release: (() => void) | undefined;
    try {
      release = admission.admit({ type: "session.snapshot", sessionId: "session_1" });
    } catch (error) {
      expect(error).toBeInstanceOf(DesktopIpcCapacityError);
      rejected += 1;
      return;
    }
    active += 1;
    peak = Math.max(peak, active);
    try {
      await gate.promise;
    } finally {
      active -= 1;
      release();
    }
  });
  await waitUntil(() => active === 4);

  const releaseStop = admission.admit({ type: "session.stop", sessionId: "session_1" });
  const releaseAgentStop = admission.admit({ type: "agent.stop", sessionId: "session_1", agentId: "agent_1" });
  expect(peak).toBe(4);
  expect(rejected).toBe(96);
  releaseStop();
  releaseAgentStop();
  gate.resolve();
  await Promise.all(reads);
});

test("bounds aggregate request bytes independently of item capacity", () => {
  const admission = new DesktopIpcAdmission({ normalMaxItems: 10, normalMaxBytes: 180 });
  const release = admission.admit({ type: "session.send", sessionId: "session_1", text: "x".repeat(40), mode: "queue" });
  expect(() => admission.admit({
    type: "session.send",
    sessionId: "session_1",
    text: "x".repeat(40),
    mode: "queue",
  })).toThrow(DesktopIpcCapacityError);
  release();
});

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value as T) };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for IPC admission");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
