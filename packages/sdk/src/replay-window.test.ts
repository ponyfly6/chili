import { expect, test } from "bun:test";
import type { ChiliEvent } from "@chili/protocol";
import { reduceRuntimeEvents } from "./projection.js";
import {
  jsonEventArrayUtf8Bytes,
  ReplayableRuntimeEventWindowAccumulator,
  retainReplayableRuntimeEvents,
} from "./replay-window.js";

test("keeps message anchors and a visible newest delta inside an exact JSON-array budget", () => {
  const created = event("message.created", { messageId: "message_1", role: "assistant", turnId: "turn_1" }, 2);
  const part = event("message.part_added", {
    messageId: "message_1",
    part: {
      id: "part_1",
      messageId: "message_1",
      sessionId: "session_1",
      type: "text",
      text: "seed-",
    },
  }, 3);
  const deltas = Array.from({ length: 8 }, (_, index) => event("message.part_delta", {
    messageId: "message_1",
    partId: "part_1",
    field: "text",
    delta: `delta-${index}`,
  }, index + 4));
  const budgetEvents = [created, part, deltas.at(-1)!];
  const budget = jsonEventArrayUtf8Bytes(budgetEvents);
  const result = retainReplayableRuntimeEvents([
    event("turn.started", { turnId: "turn_1" }, 1),
    created,
    part,
    ...deltas,
  ], { maxEvents: 3, maxBytes: budget });

  expect(result.events.map((item) => item.id)).toEqual(budgetEvents.map((item) => item.id));
  expect(result.bytes).toBe(budget);
  expect(result.bytes).toBe(new TextEncoder().encode(JSON.stringify(result.events)).byteLength);
  expect(result.truncated).toBe(true);
  expect(reduceRuntimeEvents(result.events).messages.message_1?.parts[0]).toMatchObject({
    id: "part_1",
    text: "seed-delta-7",
  });
});

test("prioritizes an unresolved approval and its active tool anchors over unrelated flood", () => {
  const started = event("tool.call_started", {
    turnId: "turn_1",
    callId: "call_1",
    toolName: "bash",
    input: { command: "bun test" },
  }, 1);
  const waiting = event("tool.call_updated", {
    callId: "call_1",
    status: "waiting_for_approval",
  }, 2);
  const requested = event("approval.requested", {
    approvalId: "approval_1",
    callId: "call_1",
    permission: "tool.bash",
    patterns: ["bun test"],
  }, 3);
  const flood = Array.from({ length: 100 }, (_, index) => event(
    "session.status_changed",
    { sessionId: "session_1", status: index % 2 === 0 ? "running" : "idle" },
    index + 10,
  ));
  const result = retainReplayableRuntimeEvents([started, waiting, requested, ...flood], {
    maxEvents: 6,
    maxBytes: 10_000,
  });

  expect(result.events.map((item) => item.id)).toContain(started.id);
  expect(result.events.map((item) => item.id)).toContain(waiting.id);
  expect(result.events.map((item) => item.id)).toContain(requested.id);
  const runtime = reduceRuntimeEvents(result.events);
  expect(runtime.approvals.approval_1?.status).toBe("pending");
  expect(runtime.toolCalls.call_1?.status).toBe("waiting_for_approval");
  expect(result.events).toHaveLength(6);
});

test("evicts a resolved approval as a whole instead of resurrecting its request", () => {
  const lifecycle = [
    event("tool.call_started", {
      turnId: "turn_1",
      callId: "call_1",
      toolName: "bash",
      input: {},
    }, 1),
    event("tool.call_updated", { callId: "call_1", status: "waiting_for_approval" }, 2),
    event("approval.requested", {
      approvalId: "approval_1",
      callId: "call_1",
      permission: "tool.bash",
      patterns: ["bun test"],
    }, 3),
    event("approval.resolved", { approvalId: "approval_1", decision: "allow_once" }, 4),
    event("tool.call_finished", { callId: "call_1", status: "completed", output: "ok" }, 5),
  ];
  const flood = Array.from({ length: 20 }, (_, index) => event(
    "session.status_changed",
    { sessionId: "session_1", status: "idle" },
    index + 10,
  ));
  const result = retainReplayableRuntimeEvents([...lifecycle, ...flood], {
    maxEvents: 4,
    maxBytes: 10_000,
  });

  expect(result.events.every((item) => !item.type.startsWith("approval."))).toBe(true);
  expect(reduceRuntimeEvents(result.events).approvals.approval_1).toBeUndefined();
});

test("drops an orphan delta and reports the exact missing anchor keys", () => {
  const result = retainReplayableRuntimeEvents([
    event("message.part_delta", {
      messageId: "message_missing",
      partId: "part_missing",
      field: "text",
      delta: "orphan",
    }, 1),
  ], { maxEvents: 10, maxBytes: 10_000 });

  expect(result.events).toEqual([]);
  expect(result.truncated).toBe(true);
  expect(result.missingDependencies).toEqual([
    "message:message_missing",
    "part:part_missing",
  ]);
});

test("incrementally merges 512 by 5000 logical events without exceeding resident count or bytes", () => {
  const accumulator = new ReplayableRuntimeEventWindowAccumulator({
    maxEvents: 20,
    maxBytes: 4_000,
    maxSources: 512,
  });
  for (let sourceOrder = 0; sourceOrder < 512; sourceOrder += 1) {
    const sourceTime = sourceOrder === 0 ? 100_000 : sourceOrder;
    const source = function* (): Iterable<ChiliEvent> {
      for (let index = 0; index < 5_000; index += 1) {
        yield event(
          "session.status_changed",
          { sessionId: `session_${sourceOrder}`, status: index % 2 === 0 ? "running" : "idle" },
          sourceTime + index,
          `source_${sourceOrder}_${index}`,
          `session_${sourceOrder}`,
        );
      }
    };
    const result = accumulator.addSource(source(), { sourceOrder });
    expect(result.events.length).toBeLessThanOrEqual(20);
    expect(result.bytes).toBeLessThanOrEqual(4_000);
    expect(result.bytes).toBe(new TextEncoder().encode(JSON.stringify(result.events)).byteLength);
  }

  const result = accumulator.result();
  expect(result.events.some((item) => item.sessionId === "session_0")).toBe(true);
  expect(result.truncated).toBe(true);
});

test("preserves durable source order when timestamps move backwards", () => {
  const accumulator = new ReplayableRuntimeEventWindowAccumulator({ maxEvents: 10, maxBytes: 10_000 });
  accumulator.addSource([
    event("session.status_changed", { sessionId: "a", status: "running" }, 100, "a_1", "a"),
    event("session.status_changed", { sessionId: "a", status: "idle" }, 1, "a_2", "a"),
  ], { sourceOrder: 0 });
  const result = accumulator.addSource([
    event("session.status_changed", { sessionId: "b", status: "running" }, 50, "b_1", "b"),
  ], { sourceOrder: 1 });

  expect(result.events.map((item) => item.id)).toEqual(["b_1", "a_1", "a_2"]);
});

test("continues durable ordinals and prefix time across repeated batches from one source", () => {
  const accumulator = new ReplayableRuntimeEventWindowAccumulator({ maxEvents: 10, maxBytes: 10_000 });
  accumulator.addSource([
    event("session.status_changed", { sessionId: "a", status: "running" }, 100, "a_1", "a"),
    event("session.status_changed", { sessionId: "a", status: "idle" }, 1, "a_2", "a"),
  ], { sourceOrder: 0 });
  accumulator.addSource([
    event("session.status_changed", { sessionId: "a", status: "running" }, 2, "a_3", "a"),
  ], { sourceOrder: 0 });
  const result = accumulator.addSource([
    event("session.status_changed", { sessionId: "b", status: "running" }, 50, "b_1", "b"),
  ], { sourceOrder: 1 });

  expect(result.events.map((item) => item.id)).toEqual(["b_1", "a_1", "a_2", "a_3"]);
});

test("separates the latest missing dependencies from historical dependency truncation", () => {
  const accumulator = new ReplayableRuntimeEventWindowAccumulator({ maxEvents: 10, maxBytes: 10_000 });
  const missing = accumulator.addSource([
    event("message.part_delta", {
      messageId: "message_late",
      partId: "part_late",
      field: "text",
      delta: "orphan",
    }, 1),
  ], { sourceOrder: 0 });
  expect(missing.missingDependencies).toEqual(["message:message_late", "part:part_late"]);
  expect(missing.dependencyTruncated).toBe(true);

  const later = accumulator.addSource([
    event("message.created", { messageId: "message_late", role: "assistant" }, 2),
    event("message.part_added", {
      messageId: "message_late",
      part: {
        id: "part_late",
        messageId: "message_late",
        sessionId: "session_1",
        type: "text",
        text: "seed",
      },
    }, 3),
  ], { sourceOrder: 0 });
  expect(later.missingDependencies).toEqual([]);
  expect(later.dependencyTruncated).toBe(true);
});

function event(
  type: string,
  payload: unknown,
  time: number,
  id = `event_${time}`,
  sessionId = "session_1",
): ChiliEvent {
  return { id, type, time, sessionId, payload } as ChiliEvent;
}
