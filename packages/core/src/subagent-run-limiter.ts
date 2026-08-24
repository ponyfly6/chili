export const DEFAULT_LOCAL_SUBAGENT_MAX_ACTIVE_RUNS = 3;

export interface LocalSubagentRunLimiterSnapshot {
  maxActiveRuns: number;
  activeRuns: number;
  queuedRuns: number;
}

/**
 * A process-local permit pool shared by every child-model turn.
 *
 * A permit represents the complete lifetime of one child turn, rather than
 * just the short task-spawn call. Callers must release it only after the
 * child runtime has reached a terminal result.
 */
export interface LocalSubagentRunLimiter {
  acquire(signal?: AbortSignal): Promise<() => void>;
  snapshot?(): LocalSubagentRunLimiterSnapshot;
}

export class LocalSubagentConcurrencyLimiter implements LocalSubagentRunLimiter {
  private activeRuns = 0;
  private readonly waiters: LocalSubagentRunWaiter[] = [];

  constructor(readonly maxActiveRuns: number) {
    assertPositiveInteger(maxActiveRuns, "maxActiveRuns");
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.activeRuns < this.maxActiveRuns) {
      this.activeRuns++;
      return Promise.resolve(this.releasePermit());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: LocalSubagentRunWaiter = { resolve, reject };
      if (signal) {
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          this.cleanupWaiter(waiter);
          reject(abortError());
        };
        waiter.signal = signal;
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  snapshot(): LocalSubagentRunLimiterSnapshot {
    return {
      maxActiveRuns: this.maxActiveRuns,
      activeRuns: this.activeRuns,
      queuedRuns: this.waiters.length,
    };
  }

  private releasePermit(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRuns = Math.max(0, this.activeRuns - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.activeRuns < this.maxActiveRuns) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      this.cleanupWaiter(waiter);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      this.activeRuns++;
      waiter.resolve(this.releasePermit());
    }
  }

  private cleanupWaiter(waiter: LocalSubagentRunWaiter): void {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
}

interface LocalSubagentRunWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function abortError(): Error {
  const error = new Error("Local subagent run was aborted while waiting for a concurrency permit");
  error.name = "AbortError";
  return error;
}
