import { randomUUID } from "node:crypto";
import {
  desktopJsonUtf8Bytes,
  parseDesktopEvent,
  type DesktopEvent,
  type DesktopEventAck,
  type DesktopEventEnvelope,
  type DesktopEventReady,
  type DesktopResyncReason,
} from "../shared/contracts.js";

interface StoredEvent {
  event: DesktopEvent;
  bytes: number;
  coalesceKey?: string;
  transient: boolean;
}

interface SentFrame {
  sequence: number;
  bytes: number;
  sentAt: number;
  barrierId?: string;
}

interface ActiveBarrier {
  id: string;
  reason: DesktopResyncReason;
  sequence?: number;
  acknowledged: boolean;
  sendAttempts: number;
}

export interface DesktopEventOutboxOptions {
  send(envelope: DesktopEventEnvelope): void;
  maxItems?: number;
  maxBytes?: number;
  maxInFlightItems?: number;
  maxInFlightBytes?: number;
  maxBarrierSendAttempts?: number;
  ackTimeoutMs?: number;
  now?(): number;
  createId?(prefix: "stream" | "barrier"): string;
  scheduleTimeout?(callback: () => void, delayMs: number): unknown;
  clearScheduledTimeout?(handle: unknown): void;
  onError?(error: Error): void;
}

export interface DesktopEventOutboxDiagnostics {
  streamId: string;
  ready: boolean;
  sentSlots: number;
  pendingItems: number;
  inFlightItems: number;
  heldItems: number;
  regularItems: number;
  regularBytes: number;
  droppedTransient: number;
  barrierId?: string;
  barrierSequence?: number;
  barrierSendAttempts?: number;
  barrierAcknowledged: boolean;
  recoveryLost: boolean;
}

const DEFAULT_MAX_ITEMS = 2_048;
const DEFAULT_MAX_BYTES = 8_000_000;
const DEFAULT_MAX_IN_FLIGHT_ITEMS = 128;
const DEFAULT_MAX_IN_FLIGHT_BYTES = 2_000_000;
const DEFAULT_MAX_BARRIER_SEND_ATTEMPTS = 3;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;

/**
 * Bounds every retained main-to-renderer event by both count and exact JSON
 * UTF-8 bytes. The single resync barrier has a separate reserved slot so an
 * overflowing normal lane can always announce recovery.
 */
export class DesktopEventOutbox {
  private readonly pending: StoredEvent[] = [];
  private readonly held: StoredEvent[] = [];
  private readonly sent: SentFrame[] = [];
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly maxInFlightItems: number;
  private readonly maxInFlightBytes: number;
  private readonly maxBarrierSendAttempts: number;
  private readonly ackTimeoutMs: number;
  private readonly now: () => number;
  private readonly createId: (prefix: "stream" | "barrier") => string;
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
  private readonly clearScheduledTimeout: (handle: unknown) => void;
  private streamId: string;
  private nextSequence = 1;
  private lastAcknowledged = 0;
  private regularItems = 0;
  private regularBytes = 0;
  private activeBarrier: ActiveBarrier | undefined;
  private recoveryLost = false;
  private ready = false;
  private disposed = false;
  private droppedTransient = 0;
  private ackTimer: unknown;
  private pumpingNormal = false;

  constructor(private readonly options: DesktopEventOutboxOptions) {
    this.maxItems = positiveLimit(options.maxItems, DEFAULT_MAX_ITEMS);
    this.maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxInFlightItems = positiveLimit(options.maxInFlightItems, DEFAULT_MAX_IN_FLIGHT_ITEMS);
    this.maxInFlightBytes = positiveLimit(options.maxInFlightBytes, DEFAULT_MAX_IN_FLIGHT_BYTES);
    this.maxBarrierSendAttempts = positiveLimit(options.maxBarrierSendAttempts, DEFAULT_MAX_BARRIER_SEND_ATTEMPTS);
    this.ackTimeoutMs = positiveLimit(options.ackTimeoutMs, DEFAULT_ACK_TIMEOUT_MS);
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.clearScheduledTimeout = options.clearScheduledTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.streamId = this.createId("stream");
    this.beginResync("renderer_ready");
  }

  rendererReady(): DesktopEventReady {
    if (this.disposed) throw new Error("Desktop event outbox is disposed");
    this.clearAckTimer();
    this.clearRegularEvents();
    this.sent.length = 0;
    this.activeBarrier = undefined;
    this.recoveryLost = false;
    this.streamId = this.createId("stream");
    this.nextSequence = 1;
    this.lastAcknowledged = 0;
    this.ready = true;
    this.beginResync("renderer_ready");
    return { version: 1, streamId: this.streamId };
  }

  publish(value: DesktopEvent): void {
    if (this.disposed) return;
    try {
      const stored = storeEvent(value, this.streamId);
      if (this.activeBarrier) {
        this.retainDuringRecovery(stored);
        return;
      }
      this.enqueueNormal(stored);
    } catch (error) {
      this.report(error);
      try {
        this.beginResync("delivery_error");
      } catch (recoveryError) {
        this.report(recoveryError);
      }
    }
  }

  requestResync(reason: DesktopResyncReason): void {
    if (this.disposed) return;
    try {
      this.beginResync(reason);
    } catch (error) {
      this.report(error);
    }
  }

  acknowledge(ack: DesktopEventAck): void {
    if (this.disposed || ack.streamId !== this.streamId || ack.sequence <= this.lastAcknowledged) return;
    const highestSent = this.nextSequence - 1;
    if (ack.sequence > highestSent) {
      this.beginResync("sequence_gap");
      return;
    }

    this.lastAcknowledged = ack.sequence;
    while (this.sent[0] && this.sent[0].sequence <= ack.sequence) {
      const frame = this.sent.shift();
      if (!frame) break;
      if (frame.bytes > 0) {
        this.regularItems -= 1;
        this.regularBytes -= frame.bytes;
      }
      if (frame.barrierId && this.activeBarrier?.id === frame.barrierId) {
        this.activeBarrier.acknowledged = true;
      }
    }
    this.armAckTimer();
    if (!this.activeBarrier) this.pumpNormal();
  }

  completeResync(barrierId: string): { status: "completed" | "retry" } {
    const barrier = this.activeBarrier;
    if (this.disposed || !barrier || barrier.id !== barrierId || !barrier.acknowledged) {
      return { status: "retry" };
    }
    if (this.recoveryLost) {
      this.clearHeld();
      this.recoveryLost = false;
      return { status: "retry" };
    }

    this.pending.push(...this.held.splice(0));
    this.activeBarrier = undefined;
    // Electron may deliver these frames before the invoke response reaches the
    // renderer. The renderer transport must keep its recovery buffer active
    // until this request resolves, then replay the buffered frames by sequence.
    this.pumpNormal();
    return { status: "completed" };
  }

  diagnostics(): DesktopEventOutboxDiagnostics {
    const regularInFlight = this.sent.filter((frame) => frame.bytes > 0).length;
    const diagnostics: DesktopEventOutboxDiagnostics = {
      streamId: this.streamId,
      ready: this.ready,
      sentSlots: this.sent.length,
      pendingItems: this.pending.length,
      inFlightItems: regularInFlight,
      heldItems: this.held.length,
      regularItems: this.regularItems,
      regularBytes: this.regularBytes,
      droppedTransient: this.droppedTransient,
      barrierAcknowledged: this.activeBarrier?.acknowledged ?? false,
      recoveryLost: this.recoveryLost,
    };
    if (this.activeBarrier) diagnostics.barrierId = this.activeBarrier.id;
    if (this.activeBarrier?.sequence !== undefined) diagnostics.barrierSequence = this.activeBarrier.sequence;
    if (this.activeBarrier) diagnostics.barrierSendAttempts = this.activeBarrier.sendAttempts;
    return diagnostics;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.clearAckTimer();
    this.clearRegularEvents();
    this.sent.length = 0;
    this.activeBarrier = undefined;
  }

  private enqueueNormal(stored: StoredEvent): void {
    if (stored.bytes > this.maxInFlightBytes) {
      if (stored.transient) {
        this.droppedTransient += 1;
        return;
      }
      this.beginResync("outbox_overflow");
      this.recoveryLost = true;
      return;
    }
    const existingIndex = stored.coalesceKey
      ? this.pending.findIndex((candidate) => candidate.coalesceKey === stored.coalesceKey)
      : -1;
    if (existingIndex >= 0) {
      const existing = this.pending[existingIndex];
      if (existing && this.regularBytes - existing.bytes + stored.bytes <= this.maxBytes) {
        this.pending[existingIndex] = stored;
        this.regularBytes += stored.bytes - existing.bytes;
        this.pumpNormal();
        return;
      }
      if (existing) this.removePending(existingIndex);
    }

    this.evictPendingTransientUntilFits(stored);
    if (!this.canRetain(stored.bytes)) {
      if (stored.transient) {
        this.droppedTransient += 1;
        return;
      }
      this.beginResync("outbox_overflow");
      this.retainDuringRecovery(stored);
      return;
    }
    this.pending.push(stored);
    this.regularItems += 1;
    this.regularBytes += stored.bytes;
    this.pumpNormal();
  }

  private retainDuringRecovery(stored: StoredEvent): void {
    if (this.recoveryLost) {
      if (stored.transient) this.droppedTransient += 1;
      return;
    }
    if (stored.transient) {
      this.droppedTransient += 1;
      return;
    }
    if (stored.bytes > this.maxInFlightBytes) {
      this.clearHeld();
      this.recoveryLost = true;
      return;
    }
    const existingIndex = stored.coalesceKey
      ? this.held.findIndex((candidate) => candidate.coalesceKey === stored.coalesceKey)
      : -1;
    if (existingIndex >= 0) {
      const existing = this.held[existingIndex];
      if (existing && this.regularBytes - existing.bytes + stored.bytes <= this.maxBytes) {
        this.held[existingIndex] = stored;
        this.regularBytes += stored.bytes - existing.bytes;
        return;
      }
      if (existing) this.removeHeld(existingIndex);
    }
    if (!this.canRetain(stored.bytes)) {
      this.clearHeld();
      this.recoveryLost = true;
      return;
    }
    this.held.push(stored);
    this.regularItems += 1;
    this.regularBytes += stored.bytes;
  }

  private beginResync(reason: DesktopResyncReason): void {
    if (this.activeBarrier) {
      this.pumpBarrier();
      return;
    }
    this.clearPending();
    this.activeBarrier = {
      id: this.createId("barrier"),
      reason,
      acknowledged: false,
      sendAttempts: 0,
    };
    this.pumpBarrier();
  }

  private pumpBarrier(): void {
    const barrier = this.activeBarrier;
    if (!this.ready || !barrier || barrier.sequence !== undefined || barrier.sendAttempts >= this.maxBarrierSendAttempts) return;
    barrier.sendAttempts += 1;
    const event: DesktopEvent = { type: "runtime.resync", barrierId: barrier.id, reason: barrier.reason };
    const sequence = this.sendFrame(event, 0, barrier.id);
    if (sequence === undefined) {
      this.armUnsentBarrierRetry();
      return;
    }
    barrier.sequence = sequence;
    if (barrier.sendAttempts >= this.maxBarrierSendAttempts) this.clearAckTimer();
  }

  private pumpNormal(): void {
    if (!this.ready || this.activeBarrier || this.pumpingNormal) return;
    this.pumpingNormal = true;
    try {
      while (this.pending.length > 0) {
        const inFlightItems = this.sent.filter((frame) => frame.bytes > 0).length;
        if (inFlightItems >= this.maxInFlightItems) return;
        const inFlightBytes = this.sent.reduce((total, frame) => total + frame.bytes, 0);
        const next = this.pending[0];
        if (!next) return;
        if (inFlightBytes + next.bytes > this.maxInFlightBytes) {
          this.pending.shift();
          this.regularItems -= 1;
          this.regularBytes -= next.bytes;
          this.beginResync("outbox_overflow");
          this.recoveryLost = true;
          return;
        }
        this.pending.shift();
        const sequence = this.sendFrame(next.event, next.bytes);
        if (sequence === undefined) {
          this.regularItems -= 1;
          this.regularBytes -= next.bytes;
          this.beginResync("delivery_error");
          this.retainDuringRecovery(next);
          return;
        }
      }
    } finally {
      this.pumpingNormal = false;
    }
  }

  private sendFrame(event: DesktopEvent, bytes: number, barrierId?: string): number | undefined {
    if (this.nextSequence > Number.MAX_SAFE_INTEGER) {
      this.report(new Error("Desktop event sequence exhausted"));
      return undefined;
    }
    const sequence = this.nextSequence;
    const envelope: DesktopEventEnvelope = {
      version: 1,
      streamId: this.streamId,
      sequence,
      event,
    };
    const sentAt = this.now();
    const frame: SentFrame = {
      sequence,
      bytes,
      sentAt,
      ...(barrierId ? { barrierId } : {}),
    };
    // Commit the monotonic sequence and retained slot before entering the
    // Electron callback. Tests and adapters may synchronously ACK or publish.
    this.nextSequence += 1;
    this.sent.push(frame);
    if (barrierId) {
      for (const retained of this.sent) retained.sentAt = sentAt;
    }
    try {
      this.options.send(envelope);
    } catch (error) {
      this.report(error);
      // A callback can ACK and then throw. In that case delivery already
      // committed and the cumulative ACK removed the slot, so preserve it as
      // success. Otherwise remove only this failed slot; never reuse sequence.
      if (this.lastAcknowledged >= sequence) {
        this.armAckTimer();
        return sequence;
      }
      const frameIndex = this.sent.indexOf(frame);
      if (frameIndex >= 0) this.sent.splice(frameIndex, 1);
      this.armAckTimer();
      return undefined;
    }
    this.armAckTimer();
    return sequence;
  }

  private armAckTimer(): void {
    this.clearAckTimer();
    const oldest = this.sent[0];
    if (!oldest) return;
    const delayMs = Math.max(0, oldest.sentAt + this.ackTimeoutMs - this.now());
    const expectedSequence = oldest.sequence;
    this.ackTimer = this.scheduleTimeout(() => {
      this.ackTimer = undefined;
      const current = this.sent[0];
      if (!current || current.sequence !== expectedSequence) {
        this.armAckTimer();
        return;
      }
      if (this.now() < current.sentAt + this.ackTimeoutMs) {
        this.armAckTimer();
        return;
      }
      if (this.activeBarrier?.sequence !== undefined) {
        this.retransmitActiveBarrier();
        return;
      }
      this.beginResync("ack_timeout");
    }, delayMs);
  }

  private retransmitActiveBarrier(): void {
    const barrier = this.activeBarrier;
    if (!this.ready || !barrier || barrier.sequence === undefined || barrier.acknowledged
      || barrier.sendAttempts >= this.maxBarrierSendAttempts) return;
    const barrierFrame = this.sent.find((frame) => frame.barrierId === barrier.id && frame.sequence === barrier.sequence);
    if (!barrierFrame) {
      this.report(new Error("Active desktop resync barrier has no retained sent slot"));
      return;
    }
    const envelope: DesktopEventEnvelope = {
      version: 1,
      streamId: this.streamId,
      sequence: barrier.sequence,
      event: { type: "runtime.resync", barrierId: barrier.id, reason: barrier.reason },
    };
    barrier.sendAttempts += 1;
    try {
      this.options.send(envelope);
    } catch (error) {
      this.report(error);
    }
    // The barrier ACK is cumulative, so its retransmission covers every older
    // retained frame too. Refresh timestamps in place and keep exactly the
    // same sent slots, stream, sequence, and barrier identity.
    const retriedAt = this.now();
    for (const frame of this.sent) frame.sentAt = retriedAt;
    if (barrier.sendAttempts < this.maxBarrierSendAttempts) this.armAckTimer();
  }

  private armUnsentBarrierRetry(): void {
    this.clearAckTimer();
    if (!this.activeBarrier || this.activeBarrier.sendAttempts >= this.maxBarrierSendAttempts) return;
    this.ackTimer = this.scheduleTimeout(() => {
      this.ackTimer = undefined;
      if (this.disposed || !this.ready || !this.activeBarrier || this.activeBarrier.sequence !== undefined) {
        this.armAckTimer();
        return;
      }
      this.pumpBarrier();
    }, this.ackTimeoutMs);
  }

  private clearAckTimer(): void {
    if (this.ackTimer !== undefined) this.clearScheduledTimeout(this.ackTimer);
    this.ackTimer = undefined;
  }

  private evictPendingTransientUntilFits(stored: StoredEvent): void {
    while (!this.canRetain(stored.bytes)) {
      const transientIndex = this.pending.findIndex((candidate) => candidate.transient);
      if (transientIndex < 0) return;
      this.removePending(transientIndex);
      this.droppedTransient += 1;
    }
  }

  private canRetain(bytes: number): boolean {
    return this.regularItems < this.maxItems && this.regularBytes + bytes <= this.maxBytes;
  }

  private removePending(index: number): void {
    const [removed] = this.pending.splice(index, 1);
    if (!removed) return;
    this.regularItems -= 1;
    this.regularBytes -= removed.bytes;
  }

  private removeHeld(index: number): void {
    const [removed] = this.held.splice(index, 1);
    if (!removed) return;
    this.regularItems -= 1;
    this.regularBytes -= removed.bytes;
  }

  private clearPending(): void {
    for (const event of this.pending) {
      this.regularItems -= 1;
      this.regularBytes -= event.bytes;
    }
    this.pending.length = 0;
  }

  private clearHeld(): void {
    for (const event of this.held) {
      this.regularItems -= 1;
      this.regularBytes -= event.bytes;
    }
    this.held.length = 0;
  }

  private clearRegularEvents(): void {
    this.pending.length = 0;
    this.held.length = 0;
    this.regularItems = 0;
    this.regularBytes = 0;
  }

  private report(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      this.options.onError?.(normalized);
    } catch {
      // An observer must never break the producer or outbox state machine.
    }
  }
}

function storeEvent(value: DesktopEvent, streamId: string): StoredEvent {
  const parsed = parseDesktopEvent(value);
  const serialized = JSON.stringify(parsed);
  if (serialized === undefined) throw new TypeError("Desktop event is not JSON serializable");
  const event = parseDesktopEvent(JSON.parse(serialized) as unknown);
  const stored: StoredEvent = {
    event,
    // Sequence is assigned only when sent. Reserving the longest legal decimal
    // sequence makes every retained byte count a conservative exact envelope
    // serialization for this stream; the real wire frame can only be smaller.
    bytes: desktopJsonUtf8Bytes({
      version: 1,
      streamId,
      sequence: Number.MAX_SAFE_INTEGER,
      event,
    } satisfies DesktopEventEnvelope),
    transient: event.type === "runtime.event" && event.event.type === "tool.output_delta",
  };
  const coalesceKey = eventCoalesceKey(event);
  if (coalesceKey) stored.coalesceKey = coalesceKey;
  return stored;
}

function eventCoalesceKey(event: DesktopEvent): string | undefined {
  if (event.type === "state.changed") return "state";
  if (event.type === "queue.changed") return `queue:${event.projectId ?? ""}:${event.sessionId}`;
  return undefined;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Desktop outbox limits must be positive integers");
  return value;
}
