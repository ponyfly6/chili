export interface ToolDispatchRequest {
  toolName: string;
  input: unknown;
}

export interface ToolDispatchScopeOptions {
  maxConcurrentCalls?: number;
  beforeCall?: (request: ToolDispatchRequest) => void | Promise<void>;
}

interface Waiter {
  safe: boolean;
  grant: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

/** One turn's fair execution gate. Orchestrators never acquire a child permit. */
export class ToolDispatchScope {
  readonly maxConcurrentCalls: number;
  private active = 0;
  private exclusive = false;
  private readonly queue: Waiter[] = [];
  private budgetFailure: unknown;
  private fatalFailure: Error | undefined;
  private readonly controller = new AbortController();
  get signal(): AbortSignal { return this.controller.signal; }

  fail(error: Error): void {
    this.fatalFailure ??= error;
    this.controller.abort(this.fatalFailure);
  }

  throwIfFailed(): void {
    if (this.fatalFailure) throw this.fatalFailure;
  }

  constructor(private readonly options: ToolDispatchScopeOptions = {}) {
    this.maxConcurrentCalls = options.maxConcurrentCalls ?? 10;
    if (!Number.isInteger(this.maxConcurrentCalls) || this.maxConcurrentCalls < 1) {
      throw new Error("maxConcurrentCalls must be a positive integer");
    }
  }

  async checkNestedCall(request: ToolDispatchRequest): Promise<void> {
    this.throwIfFailed();
    if (this.budgetFailure !== undefined) throw this.budgetFailure;
    try {
      await this.options.beforeCall?.(request);
    } catch (error) {
      this.budgetFailure = error ?? new Error("Tool call budget exhausted");
      throw this.budgetFailure;
    }
    if (this.budgetFailure !== undefined) throw this.budgetFailure;
  }

  acquire(safe: boolean, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((grant, reject) => {
      const waiter: Waiter = {
        safe, grant, reject,
        ...(signal ? { signal } : {}),
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal?.removeEventListener("abort", waiter.onAbort);
          reject(signal?.reason ?? new DOMException("Tool call aborted", "AbortError"));
          this.drain();
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.drain();
    });
  }

  private drain(): void {
    while (!this.exclusive && this.active < this.maxConcurrentCalls) {
      const waiter = this.queue[0];
      if (!waiter || (!waiter.safe && this.active > 0)) return;
      this.queue.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      this.active++;
      this.exclusive = !waiter.safe;
      let released = false;
      waiter.grant(() => {
        if (released) return;
        released = true;
        this.active--;
        if (!waiter.safe) this.exclusive = false;
        this.drain();
      });
    }
  }
}
