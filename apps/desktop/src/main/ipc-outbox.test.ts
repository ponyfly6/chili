import { describe, expect, test } from "bun:test";
import type { ChiliEvent } from "@chili/protocol";
import { desktopJsonUtf8Bytes, type DesktopEvent, type DesktopEventEnvelope } from "../shared/contracts.js";
import { DesktopEventOutbox, type DesktopEventOutboxOptions } from "./ipc-outbox.js";

describe("desktop main-to-renderer outbox", () => {
  test("commits send state before synchronous bootstrap and normal ACK callbacks", () => {
    const sent: DesktopEventEnvelope[] = [];
    let id = 0;
    let outbox!: DesktopEventOutbox;
    let publishReentrantly = true;
    let callbackOutstanding = 0;
    let maximumCallbackOutstanding = 0;
    outbox = new DesktopEventOutbox({
      createId: (prefix) => `${prefix}_${++id}`,
      maxInFlightItems: 1,
      send: (envelope) => {
        sent.push(envelope);
        if (envelope.event.type === "runtime.resync") {
          outbox.acknowledge({ version: 1, streamId: envelope.streamId, sequence: envelope.sequence });
          return;
        }
        callbackOutstanding += 1;
        maximumCallbackOutstanding = Math.max(maximumCallbackOutstanding, callbackOutstanding);
        if (publishReentrantly) {
          publishReentrantly = false;
          outbox.publish(runtimeEvent("event_reentrant", "message.part_delta", {
            messageId: "message_1",
            partId: "part_1",
            field: "text",
            delta: "second",
          }));
        }
        outbox.acknowledge({ version: 1, streamId: envelope.streamId, sequence: envelope.sequence });
        callbackOutstanding -= 1;
      },
    });

    const ready = outbox.rendererReady();
    const bootstrap = sent.at(-1);
    if (!bootstrap || bootstrap.event.type !== "runtime.resync") throw new Error("Bootstrap barrier was not sent");
    expect(outbox.diagnostics()).toMatchObject({
      streamId: ready.streamId,
      sentSlots: 0,
      barrierSequence: 1,
      barrierAcknowledged: true,
    });
    expect(outbox.completeResync(bootstrap.event.barrierId)).toEqual({ status: "completed" });
    sent.length = 0;

    outbox.publish(runtimeEvent("event_first", "message.part_delta", {
      messageId: "message_1",
      partId: "part_1",
      field: "text",
      delta: "first",
    }));
    expect(sent.map((envelope) => envelope.event.type === "runtime.event" ? envelope.event.event.id : "barrier"))
      .toEqual(["event_first", "event_reentrant"]);
    expect(sent.map((envelope) => envelope.sequence)).toEqual([2, 3]);
    expect(maximumCallbackOutstanding).toBe(1);
    expect(outbox.diagnostics()).toMatchObject({ sentSlots: 0, pendingItems: 0, regularItems: 0 });
  });

  test("lets a retransmitted barrier receive its cumulative ACK synchronously", () => {
    const clock = new FakeClock();
    const sent: DesktopEventEnvelope[] = [];
    let id = 0;
    let acknowledgeSynchronously = true;
    let outbox!: DesktopEventOutbox;
    outbox = new DesktopEventOutbox({
      createId: (prefix) => `${prefix}_${++id}`,
      ackTimeoutMs: 50,
      now: () => clock.now,
      scheduleTimeout: (callback, delayMs) => clock.schedule(callback, delayMs),
      clearScheduledTimeout: (handle) => clock.clear(handle),
      send: (envelope) => {
        sent.push(envelope);
        if (acknowledgeSynchronously) {
          outbox.acknowledge({ version: 1, streamId: envelope.streamId, sequence: envelope.sequence });
        }
      },
    });

    outbox.rendererReady();
    const bootstrap = sent.at(-1);
    if (!bootstrap || bootstrap.event.type !== "runtime.resync") throw new Error("Bootstrap barrier was not sent");
    expect(outbox.completeResync(bootstrap.event.barrierId)).toEqual({ status: "completed" });
    sent.length = 0;

    acknowledgeSynchronously = false;
    outbox.requestResync("source_cursor");
    const firstAttempt = sent.at(-1);
    if (!firstAttempt || firstAttempt.event.type !== "runtime.resync") throw new Error("Recovery barrier was not sent");
    acknowledgeSynchronously = true;
    clock.advance(50);
    expect(sent).toEqual([firstAttempt, firstAttempt]);
    expect(outbox.diagnostics()).toMatchObject({
      sentSlots: 0,
      barrierId: firstAttempt.event.barrierId,
      barrierAcknowledged: true,
    });
    expect(outbox.completeResync(firstAttempt.event.barrierId)).toEqual({ status: "completed" });
  });

  test("keeps a synchronously acknowledged slot committed when the send callback then throws", () => {
    const errors: Error[] = [];
    let outbox!: DesktopEventOutbox;
    outbox = new DesktopEventOutbox({
      createId: (prefix) => `${prefix}_ack_then_throw`,
      onError: (error) => errors.push(error),
      send: (envelope) => {
        outbox.acknowledge({ version: 1, streamId: envelope.streamId, sequence: envelope.sequence });
        throw new Error("post-delivery callback failure");
      },
    });

    outbox.rendererReady();
    expect(outbox.diagnostics()).toMatchObject({
      sentSlots: 0,
      barrierSequence: 1,
      barrierAcknowledged: true,
      barrierSendAttempts: 1,
    });
    expect(errors.map((error) => error.message)).toEqual(["post-delivery callback failure"]);
    expect(outbox.completeResync("barrier_ack_then_throw")).toEqual({ status: "completed" });
  });

  test("keeps no-ACK recovery memory bounded while retransmitting the same barrier on cadence", () => {
    const clock = new FakeClock();
    const fixture = createFixture({
      clock,
      maxItems: 4,
      maxBytes: 2_000,
      maxInFlightItems: 4,
      maxInFlightBytes: 2_000,
      ackTimeoutMs: 50,
    });
    fixture.finishBootstrap();

    fixture.outbox.publish(runtimeEvent("event_unacked", "message.created", {
      messageId: "message_1",
      role: "assistant",
    }));
    expect(fixture.sent.filter(isBarrier)).toHaveLength(0);
    clock.advance(50);
    expect(fixture.sent.filter(isBarrier)).toHaveLength(1);

    for (let index = 0; index < 100; index += 1) {
      fixture.outbox.publish(runtimeEvent(`event_held_${index}`, "message.part_delta", {
        messageId: "message_1",
        partId: "part_1",
        field: "text",
        delta: "x".repeat(40),
      }));
    }
    clock.advance(1_000);
    const barrierAttempts = fixture.sent.filter(isBarrier);
    expect(barrierAttempts).toHaveLength(3);
    expect(new Set(barrierAttempts.map((frame) => `${frame.streamId}:${frame.sequence}:${frame.event.type === "runtime.resync" ? frame.event.barrierId : ""}`)).size).toBe(1);
    clock.advance(100_000);
    expect(fixture.sent.filter(isBarrier)).toHaveLength(3);
    expect(fixture.outbox.diagnostics()).toMatchObject({
      sentSlots: 2,
      barrierSendAttempts: 3,
      regularItems: 1,
      recoveryLost: true,
    });
    expect(fixture.outbox.diagnostics().regularBytes).toBeLessThanOrEqual(2_000);
  });

  test("recovers an active listener's lost barrier ACK with the same envelope and completes", () => {
    const clock = new FakeClock();
    const fixture = createFixture({ clock, ackTimeoutMs: 50 });
    fixture.finishBootstrap();

    fixture.outbox.requestResync("source_cursor");
    const firstAttempt = fixture.sent.at(-1);
    if (!firstAttempt || firstAttempt.event.type !== "runtime.resync") throw new Error("Recovery barrier was not sent");
    expect(fixture.outbox.diagnostics().sentSlots).toBe(1);

    clock.advance(50);
    const retry = fixture.sent.at(-1);
    expect(retry).toEqual(firstAttempt);
    expect(fixture.outbox.diagnostics()).toMatchObject({
      sentSlots: 1,
      barrierId: firstAttempt.event.barrierId,
      barrierSequence: firstAttempt.sequence,
    });

    fixture.outbox.acknowledge({ version: 1, streamId: retry!.streamId, sequence: retry!.sequence });
    expect(fixture.outbox.completeResync(firstAttempt.event.barrierId)).toEqual({ status: "completed" });
    expect(fixture.outbox.diagnostics()).toMatchObject({ sentSlots: 0, regularItems: 0 });
  });

  test("retries a transient initial barrier send failure with the same reserved barrier", () => {
    const clock = new FakeClock();
    const errors: Error[] = [];
    let failBarrier = false;
    const fixture = createFixture({
      clock,
      ackTimeoutMs: 50,
      onError: (error) => errors.push(error),
      send: (envelope) => {
        if (failBarrier && envelope.event.type === "runtime.resync") throw new Error("transient barrier send failure");
        fixture.sent.push(envelope);
      },
    });
    fixture.finishBootstrap();

    failBarrier = true;
    fixture.outbox.requestResync("source_cursor");
    const reservedBarrierId = fixture.outbox.diagnostics().barrierId;
    expect(reservedBarrierId).toBeDefined();
    expect(fixture.outbox.diagnostics()).toMatchObject({ sentSlots: 0, barrierAcknowledged: false });
    expect(fixture.outbox.diagnostics().barrierSequence).toBeUndefined();

    failBarrier = false;
    clock.advance(50);
    const retry = fixture.sent.at(-1);
    expect(retry).toMatchObject({
      streamId: fixture.outbox.diagnostics().streamId,
      sequence: 3,
      event: { type: "runtime.resync", barrierId: reservedBarrierId, reason: "source_cursor" },
    });
    expect(fixture.outbox.diagnostics()).toMatchObject({
      sentSlots: 1,
      barrierId: reservedBarrierId,
      barrierSequence: 3,
    });
    expect(errors.map((error) => error.message)).toContain("transient barrier send failure");

    fixture.outbox.acknowledge({ version: 1, streamId: retry!.streamId, sequence: retry!.sequence });
    expect(fixture.outbox.completeResync(reservedBarrierId!)).toEqual({ status: "completed" });
  });

  test("recovers a sent-unacked barrier with one fresh stream on a later READY", () => {
    const clock = new FakeClock();
    const fixture = createFixture({ clock, ackTimeoutMs: 50 });
    fixture.finishBootstrap();

    fixture.outbox.requestResync("source_cursor");
    const abandoned = fixture.sent.at(-1);
    if (!abandoned || abandoned.event.type !== "runtime.resync") throw new Error("Recovery barrier was not sent");

    clock.advance(500);
    const abandonedAttempts = fixture.sent.filter(isBarrier);
    expect(abandonedAttempts).toHaveLength(3);
    expect(new Set(abandonedAttempts.map((frame) => JSON.stringify(frame))).size).toBe(1);
    expect(fixture.outbox.diagnostics()).toMatchObject({
      streamId: abandoned.streamId,
      sentSlots: 1,
      barrierSendAttempts: 3,
      barrierId: abandoned.event.barrierId,
      barrierAcknowledged: false,
    });

    const ready = fixture.outbox.rendererReady();
    const replacement = fixture.sent.at(-1);
    if (!replacement || replacement.event.type !== "runtime.resync") throw new Error("Replacement barrier was not sent");
    expect(ready.streamId).not.toBe(abandoned.streamId);
    expect(replacement).toMatchObject({
      streamId: ready.streamId,
      sequence: 1,
      event: { type: "runtime.resync", reason: "renderer_ready" },
    });
    expect(replacement.event.barrierId).not.toBe(abandoned.event.barrierId);

    fixture.outbox.acknowledge({ version: 1, streamId: replacement.streamId, sequence: replacement.sequence });
    expect(fixture.outbox.completeResync(replacement.event.barrierId)).toEqual({ status: "completed" });
    expect(fixture.outbox.diagnostics()).toMatchObject({
      streamId: ready.streamId,
      barrierAcknowledged: false,
      regularItems: 0,
    });
    expect(fixture.outbox.diagnostics().barrierId).toBeUndefined();
  });

  test("tracks exact JSON UTF-8 bytes and coalesces a 100-state snapshot burst", () => {
    const fixture = createFixture({ maxItems: 4, maxBytes: 20_000, maxInFlightItems: 1, maxInFlightBytes: 20_000 });
    fixture.finishBootstrap();
    const blocker = runtimeEvent("event_blocker", "message.created", { messageId: "message_1", role: "user" });
    fixture.outbox.publish(blocker);

    for (let index = 0; index < 100; index += 1) {
      fixture.outbox.publish({
        type: "state.changed",
        state: {
          workspace: `/tmp/😀-${index}\n\\\"`,
          sidecar: { phase: "healthy", attempt: index },
          queuedBySession: {},
        },
      });
    }
    const latest: DesktopEvent = {
      type: "state.changed",
      state: {
        workspace: "/tmp/😀-99\n\\\"",
        sidecar: { phase: "healthy", attempt: 99 },
        queuedBySession: {},
      },
    };
    expect(fixture.outbox.diagnostics()).toMatchObject({ pendingItems: 1, inFlightItems: 1, regularItems: 2 });
    const streamId = fixture.outbox.diagnostics().streamId;
    expect(fixture.outbox.diagnostics().regularBytes).toBe(
      retainedEnvelopeBytes(streamId, blocker) + retainedEnvelopeBytes(streamId, latest),
    );

    fixture.ackLatest();
    expect(fixture.sent.at(-1)?.event).toEqual(latest);
    expect(fixture.sent.map((frame) => frame.sequence)).toEqual([2, 3]);
    for (const envelope of fixture.sent) {
      expect(desktopJsonUtf8Bytes(envelope)).toBeLessThanOrEqual(retainedEnvelopeBytes(streamId, envelope.event));
    }
  });

  test("publishes numeric userId fields inside opaque tool input without entering resync", () => {
    const fixture = createFixture();
    fixture.finishBootstrap();
    fixture.outbox.publish(runtimeEvent("event_opaque", "tool.call_started", {
      turnId: "turn_1",
      callId: "call_1",
      toolName: "provider_tool",
      input: { userId: 42, provider: { responseId: 7 } },
    }));

    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]?.event).toMatchObject({
      type: "runtime.event",
      event: { payload: { input: { userId: 42, provider: { responseId: 7 } } } },
    });
    expect(fixture.outbox.diagnostics().barrierId).toBeUndefined();
  });

  test("never admits even one frame beyond the in-flight byte cap", () => {
    const fixture = createFixture({ maxItems: 4, maxBytes: 20_000, maxInFlightItems: 4, maxInFlightBytes: 350 });
    fixture.finishBootstrap();
    fixture.outbox.publish(runtimeEvent("event_too_large", "message.part_delta", {
      messageId: "message_1",
      partId: "part_1",
      field: "text",
      delta: "😀\\\"\n".repeat(80),
    }));

    expect(fixture.sent.filter((frame) => frame.event.type === "runtime.event")).toHaveLength(0);
    expect(fixture.sent.filter(isBarrier)).toHaveLength(1);
    expect(fixture.outbox.diagnostics()).toMatchObject({ inFlightItems: 0, recoveryLost: true });
  });

  test("drops only unsent transient output before durable overflow requires resync", () => {
    const fixture = createFixture({ maxItems: 3, maxBytes: 20_000, maxInFlightItems: 1, maxInFlightBytes: 20_000 });
    fixture.finishBootstrap();
    fixture.outbox.publish(runtimeEvent("event_1", "message.created", { messageId: "message_1", role: "assistant" }));
    fixture.outbox.publish(runtimeEvent("event_transient", "tool.output_delta", {
      callId: "call_1",
      stream: "stdout",
      delta: "progress",
    }));
    fixture.outbox.publish(runtimeEvent("event_2", "message.part_delta", {
      messageId: "message_1",
      partId: "part_1",
      field: "text",
      delta: "a",
    }));
    fixture.outbox.publish(runtimeEvent("event_3", "message.part_delta", {
      messageId: "message_1",
      partId: "part_1",
      field: "text",
      delta: "b",
    }));
    expect(fixture.outbox.diagnostics().droppedTransient).toBe(1);
    expect(fixture.outbox.diagnostics().barrierId).toBeUndefined();

    fixture.outbox.publish(runtimeEvent("event_4", "message.part_delta", {
      messageId: "message_1",
      partId: "part_1",
      field: "text",
      delta: "c",
    }));
    expect(fixture.sent.filter(isBarrier)).toHaveLength(1);
    expect(fixture.outbox.diagnostics().barrierId).toBeDefined();
  });

  test("suppresses recovery increments and retries the same barrier after held overflow", () => {
    const fixture = createFixture({ maxItems: 2, maxBytes: 20_000, maxInFlightItems: 1, maxInFlightBytes: 20_000 });
    fixture.finishBootstrap();
    fixture.outbox.publish(runtimeEvent("event_1", "message.created", { messageId: "message_1", role: "assistant" }));
    fixture.outbox.publish(runtimeEvent("event_2", "message.part_delta", {
      messageId: "message_1",
      partId: "part_1",
      field: "text",
      delta: "a",
    }));
    fixture.outbox.publish(runtimeEvent("event_3", "message.part_delta", {
      messageId: "message_1",
      partId: "part_1",
      field: "text",
      delta: "b",
    }));
    const barrier = fixture.sent.find(isBarrier);
    expect(barrier).toBeDefined();
    fixture.outbox.publish(runtimeEvent("event_4", "message.part_delta", {
      messageId: "message_1",
      partId: "part_1",
      field: "text",
      delta: "c",
    }));
    expect(fixture.sent.map((frame) => frame.event.type)).toEqual(["runtime.event", "runtime.resync"]);
    expect(fixture.outbox.diagnostics().recoveryLost).toBe(true);

    fixture.ackLatest();
    const barrierId = barrier?.event.type === "runtime.resync" ? barrier.event.barrierId : "missing";
    expect(fixture.outbox.completeResync(barrierId)).toEqual({ status: "retry" });
    expect(fixture.outbox.diagnostics()).toMatchObject({ barrierId, recoveryLost: false, heldItems: 0 });

    fixture.outbox.publish(runtimeEvent("event_after_retry", "message.part_delta", {
      messageId: "message_1",
      partId: "part_1",
      field: "text",
      delta: "fresh",
    }));
    expect(fixture.sent).toHaveLength(2);
    expect(fixture.outbox.completeResync(barrierId)).toEqual({ status: "completed" });
    expect(fixture.sent.at(-1)?.event).toMatchObject({
      type: "runtime.event",
      event: { id: "event_after_retry" },
    });
    expect(fixture.sent.filter(isBarrier)).toHaveLength(1);
  });

  test("documents that clean completion can synchronously flush held frames before its response", () => {
    let completing = false;
    let observedDuringCompletion = false;
    const fixture = createFixture({
      send: (envelope) => {
        fixture.sent.push(envelope);
        if (completing && envelope.event.type === "runtime.event") observedDuringCompletion = true;
      },
    });
    fixture.finishBootstrap();
    fixture.outbox.requestResync("source_cursor");
    const barrier = fixture.sent.at(-1);
    if (!barrier || barrier.event.type !== "runtime.resync") throw new Error("Recovery barrier was not sent");
    fixture.outbox.publish(runtimeEvent("event_held", "message.part_delta", {
      messageId: "message_1",
      partId: "part_1",
      field: "text",
      delta: "held",
    }));
    fixture.outbox.acknowledge({ version: 1, streamId: barrier.streamId, sequence: barrier.sequence });

    completing = true;
    expect(fixture.outbox.completeResync(barrier.event.barrierId)).toEqual({ status: "completed" });
    completing = false;
    expect(observedDuringCompletion).toBe(true);
  });

  test("ignores stale ACKs and never throws producer-facing send or validation errors", () => {
    const errors: Error[] = [];
    let failNormalSend = false;
    const fixture = createFixture({
      onError: (error) => errors.push(error),
      send: (envelope) => {
        if (failNormalSend && envelope.event.type !== "runtime.resync") throw new Error("simulated send failure");
        fixture.sent.push(envelope);
      },
    });
    fixture.finishBootstrap();
    fixture.outbox.acknowledge({ version: 1, streamId: "stale_stream", sequence: 99 });
    failNormalSend = true;
    expect(() => fixture.outbox.publish(runtimeEvent("event_failure", "message.created", {
      messageId: "message_1",
      role: "assistant",
    }))).not.toThrow();
    expect(() => fixture.outbox.publish({ type: "runtime.event", event: { payload: null } as never })).not.toThrow();
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(fixture.outbox.diagnostics().barrierId).toBeDefined();
  });
});

interface FixtureOptions extends Partial<Omit<DesktopEventOutboxOptions, "send">> {
  clock?: FakeClock;
  send?(envelope: DesktopEventEnvelope): void;
}

function createFixture(options: FixtureOptions = {}) {
  const sent: DesktopEventEnvelope[] = [];
  let id = 0;
  const clock = options.clock;
  const fixture = {
    sent,
    outbox: undefined as unknown as DesktopEventOutbox,
    finishBootstrap(): void {
      const ready = fixture.outbox.rendererReady();
      const barrier = sent.at(-1);
      if (!barrier || barrier.event.type !== "runtime.resync") throw new Error("Bootstrap barrier was not sent");
      fixture.outbox.acknowledge({ version: 1, streamId: ready.streamId, sequence: barrier.sequence });
      expect(fixture.outbox.completeResync(barrier.event.barrierId)).toEqual({ status: "completed" });
      sent.length = 0;
    },
    ackLatest(): void {
      const latest = sent.at(-1);
      if (!latest) throw new Error("No event to acknowledge");
      fixture.outbox.acknowledge({ version: 1, streamId: latest.streamId, sequence: latest.sequence });
    },
  };
  fixture.outbox = new DesktopEventOutbox({
    send: options.send ?? ((envelope) => sent.push(envelope)),
    createId: () => `id_${++id}`,
    ...(clock ? {
      now: () => clock.now,
      scheduleTimeout: (callback, delayMs) => clock.schedule(callback, delayMs),
      clearScheduledTimeout: (handle) => clock.clear(handle),
    } : {}),
    ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxInFlightItems === undefined ? {} : { maxInFlightItems: options.maxInFlightItems }),
    ...(options.maxInFlightBytes === undefined ? {} : { maxInFlightBytes: options.maxInFlightBytes }),
    ...(options.maxBarrierSendAttempts === undefined ? {} : { maxBarrierSendAttempts: options.maxBarrierSendAttempts }),
    ...(options.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: options.ackTimeoutMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  return fixture;
}

function runtimeEvent(id: string, type: string, payload: Record<string, unknown>): DesktopEvent {
  return {
    type: "runtime.event",
    event: { id, type, time: 1, sessionId: "session_1", payload } as ChiliEvent,
  };
}

function isBarrier(envelope: DesktopEventEnvelope): boolean {
  return envelope.event.type === "runtime.resync";
}

function retainedEnvelopeBytes(streamId: string, event: DesktopEvent): number {
  return desktopJsonUtf8Bytes({ version: 1, streamId, sequence: Number.MAX_SAFE_INTEGER, event });
}

class FakeClock {
  now = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  schedule(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  advance(durationMs: number): void {
    const target = this.now + durationMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
    }
    this.now = target;
  }
}
