export type ShutdownContainmentResult =
  | { status: "contained"; attempts: number }
  | { status: "deadline"; attempts: number; error: unknown };

export interface ShutdownContainmentOptions {
  stop(): Promise<void>;
  deadlineMs: number;
  retryDelayMs: number;
  now?(): number;
  wait?(delayMs: number): Promise<void>;
}

export interface ShutdownDeadlineTimer {
  unref?(): void;
}

export interface ShutdownDeadlineOptions {
  containmentDeadlineMs: number;
  quitWatchdogMs: number;
  onContainmentDeadline(): void;
  onQuitWatchdog(): void;
  schedule?(callback: () => void, delayMs: number): ShutdownDeadlineTimer;
  cancelTimer?(timer: ShutdownDeadlineTimer): void;
}

export function armShutdownDeadlines(options: ShutdownDeadlineOptions): { cancel(): void } {
  if (!Number.isFinite(options.containmentDeadlineMs) || options.containmentDeadlineMs <= 0) {
    throw new RangeError("Shutdown containment deadline must be positive");
  }
  if (!Number.isFinite(options.quitWatchdogMs) || options.quitWatchdogMs <= options.containmentDeadlineMs) {
    throw new RangeError("Shutdown quit watchdog must follow the containment deadline");
  }
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelTimer = options.cancelTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const containmentTimer = schedule(options.onContainmentDeadline, options.containmentDeadlineMs);
  const quitWatchdog = schedule(options.onQuitWatchdog, options.quitWatchdogMs);
  containmentTimer.unref?.();
  quitWatchdog.unref?.();
  let cancelled = false;
  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      cancelTimer(containmentTimer);
      cancelTimer(quitWatchdog);
    },
  };
}

/**
 * Retries one containment owner serially until it succeeds or the deadline is
 * reached. A hard process-exit timer remains the authority for an individual
 * stop attempt that never settles.
 */
export async function retryShutdownContainment(
  options: ShutdownContainmentOptions,
): Promise<ShutdownContainmentResult> {
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs < 0) {
    throw new RangeError("Shutdown containment deadline must be non-negative");
  }
  if (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs <= 0) {
    throw new RangeError("Shutdown containment retry delay must be positive");
  }
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitForDelay;
  const deadline = now() + options.deadlineMs;
  let attempts = 0;
  let lastError: unknown = new Error("Shutdown containment deadline elapsed before an attempt completed");

  while (true) {
    attempts += 1;
    try {
      await options.stop();
      return { status: "contained", attempts };
    } catch (error) {
      lastError = error;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return { status: "deadline", attempts, error: lastError };
    }
    await wait(Math.min(options.retryDelayMs, remainingMs));
    if (now() >= deadline) {
      return { status: "deadline", attempts, error: lastError };
    }
  }
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}
