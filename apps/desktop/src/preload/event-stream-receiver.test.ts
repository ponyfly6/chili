import { describe, expect, test } from "bun:test";
import type { DesktopEventAck, DesktopEventEnvelope } from "../shared/contracts.js";
import { DesktopEventReadyLifecycle, DesktopEventStreamReceiver } from "./event-stream-receiver.js";

describe("preload desktop event receiver", () => {
  test("ACKs only contiguous frames delivered to a listener", () => {
    const fixture = receiverFixture();
    fixture.receiver.setStream("stream_1");
    fixture.receiver.accept(frame(1));
    fixture.receiver.accept(frame(2));
    expect(fixture.delivered.map((item) => item.sequence)).toEqual([1, 2]);
    expect(fixture.acks.map((ack) => ack.sequence)).toEqual([1, 2]);
  });

  test("does not ACK malformed, gapped, or listener-failed frames", () => {
    const fixture = receiverFixture();
    fixture.receiver.setStream("stream_1");
    fixture.receiver.accept({ nope: true });
    fixture.receiver.accept(frame(2));
    fixture.failDelivery = true;
    fixture.receiver.accept(frame(1));
    expect(fixture.acks).toEqual([]);
    expect(fixture.errors).toHaveLength(3);
  });

  test("re-ACKs duplicates without delivering twice and lets a barrier cross a gap", () => {
    const fixture = receiverFixture();
    fixture.receiver.setStream("stream_1");
    fixture.receiver.accept(frame(1));
    fixture.receiver.accept(frame(1));
    fixture.receiver.accept(frame(4, {
      type: "runtime.resync",
      barrierId: "barrier_1",
      reason: "sequence_gap",
    }));
    expect(fixture.delivered.map((item) => item.sequence)).toEqual([1, 4]);
    expect(fixture.acks.map((ack) => ack.sequence)).toEqual([1, 1, 4]);
  });

  test("holds at most the initial barrier until the private READY response identifies its stream", () => {
    const fixture = receiverFixture();
    fixture.receiver.accept(frame(1, {
      type: "runtime.resync",
      barrierId: "stale_barrier",
      reason: "renderer_ready",
    }, "stale_stream"));
    fixture.receiver.accept(frame(1, {
      type: "runtime.resync",
      barrierId: "current_barrier",
      reason: "renderer_ready",
    }));
    expect(fixture.delivered).toEqual([]);
    fixture.receiver.setStream("stream_1");
    expect(fixture.delivered).toHaveLength(1);
    expect(fixture.delivered[0]?.event).toMatchObject({ barrierId: "current_barrier" });
    expect(fixture.acks.map((ack) => ack.sequence)).toEqual([1]);
  });

  test("unsubscribe reset followed by resubscribe accepts and ACKs a fresh READY barrier", () => {
    const fixture = receiverFixture();
    fixture.receiver.setStream("stream_old");
    fixture.hasListener = false;
    fixture.receiver.accept(frame(1, {
      type: "runtime.resync",
      barrierId: "barrier_unobserved",
      reason: "renderer_ready",
    }, "stream_old"));
    expect(fixture.acks).toEqual([]);

    fixture.receiver.reset();
    fixture.receiver.accept(frame(1, {
      type: "runtime.resync",
      barrierId: "barrier_fresh",
      reason: "renderer_ready",
    }, "stream_fresh"));
    fixture.hasListener = true;
    fixture.receiver.setStream("stream_fresh");
    expect(fixture.delivered.at(-1)?.event).toMatchObject({ barrierId: "barrier_fresh" });
    expect(fixture.acks.at(-1)).toEqual({ version: 1, streamId: "stream_fresh", sequence: 1 });
  });

  test("issues one READY per listener epoch and ignores a late READY from the prior epoch", async () => {
    const fixture = receiverFixture();
    const readyCalls: Array<Deferred<{ version: 1; streamId: string }>> = [];
    const lifecycle = new DesktopEventReadyLifecycle({
      invokeReady: () => {
        const deferred = createDeferred<{ version: 1; streamId: string }>();
        readyCalls.push(deferred);
        return deferred.promise;
      },
      setStream: (streamId) => fixture.receiver.setStream(streamId),
      resetStream: () => fixture.receiver.reset(),
      onError: (error) => fixture.errors.push(error),
    });

    lifecycle.activate();
    lifecycle.activate();
    expect(readyCalls).toHaveLength(1);
    fixture.receiver.accept(frame(1, {
      type: "runtime.resync",
      barrierId: "barrier_old",
      reason: "renderer_ready",
    }, "stream_old"));
    lifecycle.deactivate();

    lifecycle.activate();
    lifecycle.activate();
    expect(readyCalls).toHaveLength(2);
    fixture.receiver.accept(frame(1, {
      type: "runtime.resync",
      barrierId: "barrier_fresh",
      reason: "renderer_ready",
    }, "stream_fresh"));

    readyCalls[0]?.resolve({ version: 1, streamId: "stream_old" });
    await Promise.resolve();
    expect(fixture.delivered).toEqual([]);
    expect(fixture.acks).toEqual([]);

    readyCalls[1]?.resolve({ version: 1, streamId: "stream_fresh" });
    await Promise.resolve();
    expect(fixture.delivered.at(-1)?.event).toMatchObject({ barrierId: "barrier_fresh" });
    expect(fixture.acks).toEqual([{ version: 1, streamId: "stream_fresh", sequence: 1 }]);
  });

  test("backs off after one transient READY failure then activates the recovered barrier stream", async () => {
    const fixture = receiverFixture();
    const clock = new RetryClock();
    let invocations = 0;
    const lifecycle = new DesktopEventReadyLifecycle({
      invokeReady: () => {
        invocations += 1;
        return invocations === 1
          ? Promise.reject(new Error("transient READY failure"))
          : Promise.resolve({ version: 1, streamId: "stream_recovered" });
      },
      setStream: (streamId) => fixture.receiver.setStream(streamId),
      resetStream: () => fixture.receiver.reset(),
      onError: (error) => fixture.errors.push(error),
      retryBaseDelayMs: 10,
      scheduleRetry: (callback, delayMs) => clock.schedule(callback, delayMs),
      clearScheduledRetry: (handle) => clock.clear(handle),
    });

    lifecycle.activate();
    await flushPromises();
    expect(invocations).toBe(1);
    expect(fixture.errors.map((error) => error.message)).toEqual(["transient READY failure"]);
    fixture.receiver.accept(frame(1, {
      type: "runtime.resync",
      barrierId: "barrier_recovered",
      reason: "renderer_ready",
    }, "stream_recovered"));

    clock.advance(9);
    expect(invocations).toBe(1);
    clock.advance(1);
    expect(invocations).toBe(2);
    await flushPromises();
    expect(fixture.delivered.at(-1)?.event).toMatchObject({ barrierId: "barrier_recovered" });
    expect(fixture.acks).toEqual([{ version: 1, streamId: "stream_recovered", sequence: 1 }]);
  });

  test("bounds permanent READY failures with exponential delays", async () => {
    const clock = new RetryClock();
    const errors: Error[] = [];
    let invocations = 0;
    const lifecycle = new DesktopEventReadyLifecycle({
      invokeReady: () => {
        invocations += 1;
        return Promise.reject(new Error(`failure ${invocations}`));
      },
      setStream: () => undefined,
      resetStream: () => undefined,
      onError: (error) => errors.push(error),
      maxAttempts: 3,
      retryBaseDelayMs: 10,
      scheduleRetry: (callback, delayMs) => clock.schedule(callback, delayMs),
      clearScheduledRetry: (handle) => clock.clear(handle),
    });

    lifecycle.activate();
    await flushPromises();
    clock.advance(10);
    await flushPromises();
    clock.advance(19);
    expect(invocations).toBe(2);
    clock.advance(1);
    await flushPromises();
    expect(invocations).toBe(3);
    expect(errors).toHaveLength(3);
    clock.advance(10_000);
    await flushPromises();
    expect(invocations).toBe(3);
  });

  test("cancels a scheduled READY retry when the listener epoch deactivates", async () => {
    const clock = new RetryClock();
    let invocations = 0;
    let resets = 0;
    const lifecycle = new DesktopEventReadyLifecycle({
      invokeReady: () => {
        invocations += 1;
        return Promise.reject(new Error("offline"));
      },
      setStream: () => undefined,
      resetStream: () => {
        resets += 1;
      },
      onError: () => undefined,
      retryBaseDelayMs: 10,
      scheduleRetry: (callback, delayMs) => clock.schedule(callback, delayMs),
      clearScheduledRetry: (handle) => clock.clear(handle),
    });

    lifecycle.activate();
    await flushPromises();
    lifecycle.deactivate();
    clock.advance(10_000);
    await flushPromises();
    expect(invocations).toBe(1);
    expect(resets).toBe(1);
  });
});

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function receiverFixture() {
  const delivered: DesktopEventEnvelope[] = [];
  const acks: DesktopEventAck[] = [];
  const errors: Error[] = [];
  const fixture = {
    delivered,
    acks,
    errors,
    failDelivery: false,
    hasListener: true,
    receiver: undefined as unknown as DesktopEventStreamReceiver,
  };
  fixture.receiver = new DesktopEventStreamReceiver({
    deliver: (envelope) => {
      if (!fixture.hasListener) return false;
      if (fixture.failDelivery) throw new Error("listener failed");
      delivered.push(envelope);
      return true;
    },
    acknowledge: (ack) => acks.push(ack),
    onError: (error) => errors.push(error),
  });
  return fixture;
}

function frame(
  sequence: number,
  event: DesktopEventEnvelope["event"] = { type: "queue.changed", sessionId: "session_1", count: sequence },
  streamId = "stream_1",
): DesktopEventEnvelope {
  return { version: 1, streamId, sequence, event };
}

class RetryClock {
  private now = 0;
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
