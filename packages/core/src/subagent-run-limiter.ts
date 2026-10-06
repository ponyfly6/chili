import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_LOCAL_SUBAGENT_MAX_ACTIVE_RUNS = 3;

export interface LocalSubagentRunLimiterSnapshot {
  maxActiveRuns: number;
  activeRuns: number;
  queuedRuns: number;
}

/**
 * A process-local permit pool shared by every child-model turn.
 *
 * A permit covers a child turn, except while that child is waiting for
 * descendants. The last outstanding suspension restores capacity before the
 * runtime can start another model turn. Earlier concurrent tool results may
 * continue immediately so scripts can communicate with remaining children.
 * Aborted turns may unwind without restoring capacity.
 */
export interface LocalSubagentRunLimiter {
  acquire(signal?: AbortSignal): Promise<() => void>;
  acquireRun?(sessionId: string, signal?: AbortSignal): Promise<LocalSubagentRunPermit>;
  suspend?<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  waitForResume?(sessionId: string): Promise<void>;
  snapshot?(): LocalSubagentRunLimiterSnapshot;
}

export interface LocalSubagentRunPermit {
  run<T>(operation: () => Promise<T>): Promise<T>;
  release(): void;
}

export class LocalSubagentConcurrencyLimiter implements LocalSubagentRunLimiter {
  private activeRuns = 0;
  private readonly waiters: LocalSubagentRunWaiter[] = [];
  private readonly context = new AsyncLocalStorage<LocalSubagentRunContext>();

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

  acquireRun(sessionId: string, signal?: AbortSignal): Promise<LocalSubagentRunPermit> {
    if (signal?.aborted) return Promise.reject(abortError());
    // Match acquire's immediate-permit scheduling. An extra async hop here
    // would delay free-capacity background admission behind its dispatch
    // snapshot, unnecessarily leaving that snapshot in the prepared state.
    if (this.activeRuns < this.maxActiveRuns) {
      this.activeRuns++;
      return Promise.resolve(this.createRunPermit(sessionId, this.releasePermit(), signal));
    }
    return this.acquire(signal).then((release) => this.createRunPermit(sessionId, release, signal));
  }

  private createRunPermit(sessionId: string, release: () => void, signal?: AbortSignal): LocalSubagentRunPermit {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const owner: LocalSubagentRunOwner = {
      sessionId,
      controller,
      release,
      pendingSuspensions: 0,
      resumeWaiters: [],
      boundaryWaiters: [],
      acquiring: false,
      closed: false,
    };
    controller.signal.addEventListener("abort", () => this.rejectResumeWaiters(owner, abortError()), { once: true });
    return {
      // Every child gets a fresh owner, including children started from an
      // inherited, suspended parent async context.
      run: <T>(operation: () => Promise<T>) => {
        if (owner.closed || owner.controller.signal.aborted) return Promise.reject(abortError());
        return this.context.run({ owner, suspended: false }, operation);
      },
      release: () => {
        if (owner.closed) return;
        owner.closed = true;
        signal?.removeEventListener("abort", onAbort);
        controller.abort();
        owner.release?.();
        delete owner.release;
        this.rejectResumeWaiters(owner, abortError());
      },
    };
  }

  async suspend<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const context = this.context.getStore();
    // Root turns do not own permits. Explicit session matching also prevents
    // a background child from borrowing its creator's inherited context.
    if (!context || context.owner.sessionId !== sessionId) return operation();
    const { owner } = context;
    if (owner.closed || owner.controller.signal.aborted) throw abortError();
    if (context.suspended) return operation();
    owner.pendingSuspensions++;
    owner.release?.();
    delete owner.release;
    // A new wait takes responsibility for restoring capacity. Do not keep an
    // earlier tool result behind an in-flight reacquisition: its continuation
    // may need to send the message that allows this operation to finish.
    this.resolveResumeWaiters(owner);
    try {
      return await this.context.run({ owner, suspended: true }, operation);
    } finally {
      owner.pendingSuspensions--;
      if (owner.closed || owner.controller.signal.aborted) throw abortError();
      // Keep capacity available to remaining descendants, while allowing each
      // completed tool result to reach its script continuation independently.
      // Direct dispatch awaits all calls; VM callers additionally use the
      // waitForResume boundary after their bounded cancellation cleanup.
      if (owner.pendingSuspensions === 0) {
        await new Promise<void>((resolve, reject) => {
          owner.resumeWaiters.push({ resolve, reject });
          this.resumeOwner(owner);
        });
      }
    }
  }

  /** A VM may return before cancelled nested calls finish their bounded cleanup. */
  async waitForResume(sessionId: string): Promise<void> {
    const context = this.context.getStore();
    if (!context || context.owner.sessionId !== sessionId || context.suspended) return;
    const { owner } = context;
    if (owner.closed || owner.controller.signal.aborted) throw abortError();
    await new Promise<void>((resolve, reject) => {
      // Unlike ordinary tool results, this outer boundary cannot proceed
      // while another suspended call still owns the eventual restoration.
      owner.boundaryWaiters.push({ resolve, reject });
      this.resumeOwner(owner);
    });
  }

  private resumeOwner(owner: LocalSubagentRunOwner): void {
    if (owner.closed || owner.controller.signal.aborted) {
      this.rejectResumeWaiters(owner, abortError());
      return;
    }
    if (owner.pendingSuspensions > 0 || owner.acquiring) return;
    if (owner.release) {
      this.resolveResumeWaiters(owner);
      for (const waiter of owner.boundaryWaiters.splice(0)) waiter.resolve();
      return;
    }
    owner.acquiring = true;
    void this.acquire(owner.controller.signal).then((release) => {
      owner.acquiring = false;
      if (owner.closed || owner.controller.signal.aborted || owner.pendingSuspensions > 0) {
        release();
      } else {
        owner.release = release;
      }
      this.resumeOwner(owner);
    }, (error: unknown) => {
      owner.acquiring = false;
      this.rejectResumeWaiters(owner, error);
    });
  }

  private rejectResumeWaiters(owner: LocalSubagentRunOwner, error: unknown): void {
    for (const waiter of owner.resumeWaiters.splice(0)) waiter.reject(error);
    for (const waiter of owner.boundaryWaiters.splice(0)) waiter.reject(error);
  }

  private resolveResumeWaiters(owner: LocalSubagentRunOwner): void {
    for (const waiter of owner.resumeWaiters.splice(0)) waiter.resolve();
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

interface LocalSubagentRunContext {
  owner: LocalSubagentRunOwner;
  suspended: boolean;
}

interface LocalSubagentRunOwner {
  sessionId: string;
  controller: AbortController;
  release?: () => void;
  pendingSuspensions: number;
  resumeWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
  boundaryWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
  acquiring: boolean;
  closed: boolean;
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
