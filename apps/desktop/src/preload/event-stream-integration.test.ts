import { describe, expect, test } from "bun:test";
import type { ChiliEvent } from "@chili/protocol";
import { DesktopEventOutbox } from "../main/ipc-outbox.js";
import type { DesktopEvent, DesktopEventEnvelope } from "../shared/contracts.js";
import {
  ResyncCoordinator,
  type CoordinatedProjection,
  type ResyncOutcome,
  type SequencedProjectionFrame,
} from "../renderer/resync-coordinator.js";
import { DesktopEventStreamReceiver } from "./event-stream-receiver.js";

interface State {
  workspace: string;
  queue: Record<string, number>;
}

interface Session {
  id: string;
  status: "active" | "archived";
}

interface Snapshot {
  sessionId: string;
  revision: number;
  eventIds: string[];
}

type Projection = CoordinatedProjection<State, Session, Snapshot>;
type Frame = Exclude<DesktopEvent, { type: "runtime.resync" }>;

describe("composed desktop event recovery", () => {
  test("recovers lost ACK plus bounded overflow and publishes the authoritative sidecar projection", async () => {
    const clock = new FakeClock();
    const authoritative = {
      state: { workspace: "/authoritative", queue: { session_1: 17 } },
      sessions: [{ id: "session_1", status: "active" as const }],
      snapshot: { sessionId: "session_1", revision: 9, eventIds: ["event_authoritative_final"] },
    };
    const authorityReady = deferred<void>();
    const attempts: DesktopEventEnvelope[] = [];
    const publications: Projection[] = [];
    const completionStatuses: string[] = [];
    const receiverErrors: Error[] = [];
    let dropAck = true;
    let loadStateCalls = 0;
    let recovery: Promise<ResyncOutcome> | undefined;
    let outbox!: DesktopEventOutbox;

    const coordinator = new ResyncCoordinator<State, Session, Snapshot, Frame>({
      loadState: async () => {
        loadStateCalls += 1;
        await authorityReady.promise;
        return structuredClone(authoritative.state);
      },
      listSessions: async () => structuredClone(authoritative.sessions),
      loadSnapshot: async () => structuredClone(authoritative.snapshot),
      authorityKey: (state) => state.workspace,
      sessionId: (session) => session.id,
      isSessionActive: (session) => session.status === "active",
      snapshotSessionId: (snapshot) => snapshot.sessionId,
      snapshotEventIds: (snapshot) => snapshot.eventIds,
      frameEventId: (frame) => frame.type === "runtime.event" ? frame.event.id : undefined,
      frameRelatedToSnapshot: (frame, _snapshot, sessionId) => (
        frame.type === "runtime.event" && frame.event.sessionId === sessionId
      ),
      applyFrameToSnapshot: (snapshot, frame) => frame.type === "runtime.event"
        ? { ...snapshot, eventIds: [...snapshot.eventIds, frame.event.id] }
        : snapshot,
      applyFrames: (projection, frames) => frames.reduce(applyFrame, projection),
      publish: (projection) => publications.push(projection),
      complete: ({ barrierId }) => {
        if (!barrierId) throw new Error("Expected a main-process barrier ID");
        const result = outbox.completeResync(barrierId);
        completionStatuses.push(result.status);
        return result;
      },
    });

    const receiver = new DesktopEventStreamReceiver({
      deliver: (envelope) => {
        if (envelope.event.type === "runtime.resync") {
          recovery = coordinator.barrier({
            sequence: envelope.sequence,
            barrierId: envelope.event.barrierId,
            preferredSessionId: "session_1",
          });
        } else {
          coordinator.recordFrame({ sequence: envelope.sequence, frame: envelope.event });
        }
        return true;
      },
      acknowledge: (ack) => {
        if (!dropAck) outbox.acknowledge(ack);
      },
      onError: (error) => receiverErrors.push(error),
    });

    outbox = new DesktopEventOutbox({
      send: (envelope) => {
        attempts.push(envelope);
        receiver.accept(envelope);
      },
      createId: (prefix) => `${prefix}_integration`,
      maxItems: 2,
      maxBytes: 4_000,
      maxInFlightItems: 2,
      maxInFlightBytes: 4_000,
      ackTimeoutMs: 50,
      now: () => clock.now,
      scheduleTimeout: (callback, delayMs) => clock.schedule(callback, delayMs),
      clearScheduledTimeout: (handle) => clock.clear(handle),
    });

    const ready = outbox.rendererReady();
    receiver.setStream(ready.streamId);
    await Promise.resolve();
    expect(loadStateCalls).toBe(1);
    expect(attempts).toHaveLength(1);
    const originalBarrier = attempts[0];
    expect(originalBarrier?.event.type).toBe("runtime.resync");
    expect(outbox.diagnostics()).toMatchObject({ sentSlots: 1, barrierAcknowledged: false });

    for (let index = 0; index < 10; index += 1) {
      outbox.publish(runtimeEvent(`event_lost_${index}`, {
        messageId: "message_1",
        partId: "part_1",
        field: "text",
        delta: `lost-${index}`,
      }));
    }
    expect(outbox.diagnostics()).toMatchObject({
      sentSlots: 1,
      heldItems: 0,
      regularItems: 0,
      recoveryLost: true,
    });

    dropAck = false;
    clock.advance(50);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(originalBarrier);
    expect(outbox.diagnostics()).toMatchObject({ sentSlots: 0, barrierAcknowledged: true });

    authorityReady.resolve();
    expect(await recovery).toBe("completed");
    expect(completionStatuses).toEqual(["retry", "completed"]);
    expect(loadStateCalls).toBe(2);
    expect(publications.at(-1)).toMatchObject({
      state: authoritative.state,
      sessions: authoritative.sessions,
      selectedId: "session_1",
      snapshot: authoritative.snapshot,
    });
    expect(outbox.diagnostics()).toMatchObject({
      sentSlots: 0,
      regularItems: 0,
      recoveryLost: false,
    });
    expect(outbox.diagnostics().barrierId).toBeUndefined();
    expect(receiverErrors).toEqual([]);
  });
});

function applyFrame(projection: Projection, input: SequencedProjectionFrame<Frame>): Projection {
  const frame = input.frame;
  if (frame.type === "state.changed") return { ...projection, state: frame.state as unknown as State };
  if (frame.type === "queue.changed") {
    return {
      ...projection,
      state: { ...projection.state, queue: { ...projection.state.queue, [frame.sessionId]: frame.count } },
    };
  }
  if (!projection.snapshot || frame.event.sessionId !== projection.selectedId) return projection;
  return {
    ...projection,
    snapshot: { ...projection.snapshot, eventIds: [...projection.snapshot.eventIds, frame.event.id] },
  };
}

function runtimeEvent(id: string, payload: Record<string, unknown>): DesktopEvent {
  return {
    type: "runtime.event",
    event: {
      id,
      type: "message.part_delta",
      time: 1,
      sessionId: "session_1",
      payload,
    } as ChiliEvent,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
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
