import {
  parseDesktopEventEnvelope,
  type DesktopEventAck,
  type DesktopEventEnvelope,
  type DesktopEventReady,
} from "../shared/contracts.js";

export interface DesktopEventStreamReceiverOptions {
  deliver(envelope: DesktopEventEnvelope): boolean;
  acknowledge(ack: DesktopEventAck): void;
  onError(error: Error): void;
}

/** Sequence/validation fence kept inside preload; ACK is never page-exposed. */
export class DesktopEventStreamReceiver {
  private streamId: string | undefined;
  private lastDelivered = 0;
  private pendingInitialBarrier: DesktopEventEnvelope | undefined;

  constructor(private readonly options: DesktopEventStreamReceiverOptions) {}

  reset(): void {
    this.streamId = undefined;
    this.lastDelivered = 0;
    this.pendingInitialBarrier = undefined;
  }

  setStream(streamId: string): void {
    this.streamId = streamId;
    this.lastDelivered = 0;
    const pending = this.pendingInitialBarrier;
    this.pendingInitialBarrier = undefined;
    if (pending?.streamId === streamId) this.deliverParsed(pending);
  }

  accept(value: unknown): void {
    let envelope: DesktopEventEnvelope;
    try {
      envelope = parseDesktopEventEnvelope(value);
    } catch (error) {
      this.report(error);
      return;
    }
    if (!this.streamId) {
      if (envelope.event.type === "runtime.resync") this.pendingInitialBarrier = envelope;
      return;
    }
    if (envelope.streamId !== this.streamId) return;
    this.deliverParsed(envelope);
  }

  private deliverParsed(envelope: DesktopEventEnvelope): void {
    if (envelope.sequence <= this.lastDelivered) {
      this.acknowledge(this.lastDelivered);
      return;
    }
    const expected = this.lastDelivered + 1;
    if (envelope.sequence !== expected && envelope.event.type !== "runtime.resync") {
      this.report(new Error(`Desktop event sequence gap: expected ${expected}, received ${envelope.sequence}`));
      return;
    }
    try {
      if (!this.options.deliver(envelope)) return;
    } catch (error) {
      this.report(error);
      return;
    }
    this.lastDelivered = envelope.sequence;
    this.acknowledge(this.lastDelivered);
  }

  private acknowledge(sequence: number): void {
    const streamId = this.streamId;
    if (!streamId) return;
    try {
      this.options.acknowledge({ version: 1, streamId, sequence });
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    try {
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Diagnostics must not affect delivery or ACK state.
    }
  }
}

export interface DesktopEventReadyLifecycleOptions {
  invokeReady(): Promise<DesktopEventReady>;
  setStream(streamId: string): void;
  resetStream(): void;
  onError(error: Error): void;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  scheduleRetry?(callback: () => void, delayMs: number): unknown;
  clearScheduledRetry?(handle: unknown): void;
}

const DEFAULT_READY_MAX_ATTEMPTS = 3;
const DEFAULT_READY_RETRY_BASE_DELAY_MS = 250;

/**
 * Gives each non-empty listener epoch exactly one private READY handshake.
 * Results from an earlier epoch are ignored, so an unsubscribe/resubscribe
 * race cannot reactivate the abandoned stream or suppress the fresh READY.
 */
export class DesktopEventReadyLifecycle {
  private active = false;
  private generation = 0;
  private attempts = 0;
  private readyPromise: Promise<void> | undefined;
  private retryTimer: unknown;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly scheduleRetry: (callback: () => void, delayMs: number) => unknown;
  private readonly clearScheduledRetry: (handle: unknown) => void;

  constructor(private readonly options: DesktopEventReadyLifecycleOptions) {
    this.maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_READY_MAX_ATTEMPTS, "READY max attempts");
    this.retryBaseDelayMs = positiveInteger(
      options.retryBaseDelayMs,
      DEFAULT_READY_RETRY_BASE_DELAY_MS,
      "READY retry base delay",
    );
    this.scheduleRetry = options.scheduleRetry ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.clearScheduledRetry = options.clearScheduledRetry
      ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.attempts = 0;
    this.attemptReady();
  }

  private attemptReady(): void {
    if (!this.active || this.readyPromise || this.attempts >= this.maxAttempts) return;
    const generation = this.generation;
    this.attempts += 1;
    let invocation: Promise<DesktopEventReady>;
    try {
      invocation = this.options.invokeReady();
    } catch (error) {
      invocation = Promise.reject(error);
    }
    this.readyPromise = invocation
      .then((ready) => {
        if (this.active && generation === this.generation) this.options.setStream(ready.streamId);
      })
      .catch((error) => {
        if (!this.active || generation !== this.generation) return;
        this.readyPromise = undefined;
        this.report(error);
        this.armRetry(generation);
      });
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.attempts = 0;
    this.readyPromise = undefined;
    this.clearRetryTimer();
    this.options.resetStream();
  }

  private armRetry(generation: number): void {
    this.clearRetryTimer();
    if (!this.active || generation !== this.generation || this.attempts >= this.maxAttempts) return;
    const delayMs = Math.min(
      2_147_483_647,
      this.retryBaseDelayMs * (2 ** Math.max(0, this.attempts - 1)),
    );
    this.retryTimer = this.scheduleRetry(() => {
      this.retryTimer = undefined;
      if (!this.active || generation !== this.generation) return;
      this.attemptReady();
    }, delayMs);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) this.clearScheduledRetry(this.retryTimer);
    this.retryTimer = undefined;
  }

  private report(error: unknown): void {
    try {
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Diagnostics must not affect READY lifecycle state.
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${field} must be a positive safe integer`);
  return value;
}
