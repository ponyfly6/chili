export interface RefreshScheduleOptions<Handle> {
  schedule(callback: () => void, delayMs: number): Handle;
  cancel(handle: Handle): void;
  delayMs?: number;
}

export class IndependentRefreshScheduler<Handle = ReturnType<typeof setTimeout>> {
  private readonly delayMs: number;
  private sessionHandle: Handle | undefined;
  private snapshotHandle: Handle | undefined;

  constructor(private readonly options: RefreshScheduleOptions<Handle> = {
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } as RefreshScheduleOptions<Handle>) {
    this.delayMs = options.delayMs ?? 150;
  }

  sessions(callback: () => void): void {
    if (this.sessionHandle !== undefined) this.options.cancel(this.sessionHandle);
    this.sessionHandle = this.options.schedule(() => {
      this.sessionHandle = undefined;
      callback();
    }, this.delayMs);
  }

  snapshot(callback: () => void): void {
    if (this.snapshotHandle !== undefined) this.options.cancel(this.snapshotHandle);
    this.snapshotHandle = this.options.schedule(() => {
      this.snapshotHandle = undefined;
      callback();
    }, this.delayMs);
  }

  cancel(): void {
    if (this.sessionHandle !== undefined) this.options.cancel(this.sessionHandle);
    if (this.snapshotHandle !== undefined) this.options.cancel(this.snapshotHandle);
    this.sessionHandle = undefined;
    this.snapshotHandle = undefined;
  }
}
