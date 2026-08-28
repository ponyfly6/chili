import { describe, expect, test } from "bun:test";
import {
  armShutdownDeadlines,
  retryShutdownContainment,
  type ShutdownDeadlineTimer,
} from "./shutdown-containment.js";

describe("desktop shutdown containment retries", () => {
  test("serializes a transient failure and reports recovery on the second attempt", async () => {
    const firstAttempt = deferred<void>();
    const releaseRetry = deferred<void>();
    let attempts = 0;
    let active = 0;
    let peakActive = 0;
    const resultPromise = retryShutdownContainment({
      deadlineMs: 12_000,
      retryDelayMs: 250,
      stop: async () => {
        attempts += 1;
        active += 1;
        peakActive = Math.max(peakActive, active);
        try {
          if (attempts === 1) await firstAttempt.promise;
        } finally {
          active -= 1;
        }
      },
      wait: async (delayMs) => {
        expect(delayMs).toBe(250);
        await releaseRetry.promise;
      },
    });

    expect(attempts).toBe(1);
    firstAttempt.reject(new Error("transient containment failure"));
    await waitUntil(() => active === 0);
    expect(attempts).toBe(1);
    releaseRetry.resolve();

    await expect(resultPromise).resolves.toEqual({ status: "contained", attempts: 2 });
    expect(peakActive).toBe(1);
  });

  test("reports the last permanent failure exactly at the retry deadline", async () => {
    const failure = new Error("permanent containment failure");
    let now = 1_000;
    let attempts = 0;
    const delays: number[] = [];

    const result = await retryShutdownContainment({
      deadlineMs: 1_000,
      retryDelayMs: 250,
      now: () => now,
      wait: async (delayMs) => {
        delays.push(delayMs);
        now += delayMs;
      },
      stop: async () => {
        attempts += 1;
        throw failure;
      },
    });

    expect(result).toEqual({ status: "deadline", attempts: 4, error: failure });
    expect(attempts).toBe(4);
    expect(delays).toEqual([250, 250, 250, 250]);
  });

  test("continues final containment after 9 seconds and reserves hard exit for 12 seconds", async () => {
    interface FakeTimer extends ShutdownDeadlineTimer {
      at: number;
      callback(): void;
      cancelled: boolean;
    }
    let now = 0;
    let attempts = 0;
    let attemptsAtContainmentDeadline: number | undefined;
    let forcedAt: number | undefined;
    const timers: FakeTimer[] = [];
    const deadlines = armShutdownDeadlines({
      containmentDeadlineMs: 9_000,
      quitWatchdogMs: 12_000,
      onContainmentDeadline: () => {
        attemptsAtContainmentDeadline = attempts;
      },
      onQuitWatchdog: () => {
        forcedAt = now;
      },
      schedule: (callback, delayMs) => {
        const timer: FakeTimer = { at: now + delayMs, callback, cancelled: false };
        timers.push(timer);
        return timer;
      },
      cancelTimer: (timer) => {
        (timer as FakeTimer).cancelled = true;
      },
    });

    const failure = new Error("permanent containment failure");
    const result = await retryShutdownContainment({
      deadlineMs: 12_000,
      retryDelayMs: 1_000,
      now: () => now,
      wait: async (delayMs) => {
        const target = now + delayMs;
        for (const timer of timers
          .filter((candidate) => !candidate.cancelled && candidate.at > now && candidate.at <= target)
          .sort((left, right) => left.at - right.at)) {
          now = timer.at;
          timer.callback();
        }
        now = target;
      },
      stop: async () => {
        attempts += 1;
        throw failure;
      },
    });

    expect(attemptsAtContainmentDeadline).toBe(9);
    expect(attempts).toBe(12);
    expect(forcedAt).toBe(12_000);
    expect(result).toEqual({ status: "deadline", attempts: 12, error: failure });
    deadlines.cancel();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value as T),
    reject: (error) => rejectPromise?.(error),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for shutdown containment state");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
}
