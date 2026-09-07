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

test("retains the producer's input previews before the tool execution starts", () => {
  const events = [
    event("tool.call_updated", { callId: "call_preview", status: "running", toolName: "bash", input: {} }, 10),
    event("tool.call_updated", { callId: "call_preview", status: "running", toolName: "bash", input: { command: "pwd" } }, 11),
  ];
  const preview = retainReplayableRuntimeEvents(events, { maxEvents: 20, maxBytes: 10_000 });
  expect(preview.events).toEqual(events);
  expect(preview.truncated).toBe(false);
  expect(preview.missingDependencies).toEqual([]);
  expect(reduceRuntimeEvents(preview.events).toolCalls.call_preview).toMatchObject({
    toolName: "bash", input: { command: "pwd" }, sessionId: "session_1", status: "running",
  });
  const started = event("tool.call_started", { callId: "call_preview", turnId: "turn_preview", toolName: "bash", input: { command: "pwd" } }, 12);
  const running = event("tool.call_updated", { callId: "call_preview", status: "running" }, 13);
  const result = retainReplayableRuntimeEvents([...events, started, running], { maxEvents: 20, maxBytes: 10_000 });
  expect(result.events).toEqual([...events, started, running]);
  expect(result.truncated).toBe(false);
  expect(String(reduceRuntimeEvents(result.events).toolCalls.call_preview?.turnId)).toBe("turn_preview");
});

test("uses the latest preview to retain cancellation before any call_started", () => {
  const previews = Array.from({ length: 40 }, (_, index) => event("tool.call_updated", {
    callId: "call_preview", status: "running", toolName: "bash", input: { command: `preview-${index}` },
  }, index + 1));
  const cancelled = event("tool.call_finished", { callId: "call_preview", status: "cancelled", error: "provider_cancelled", synthetic: true }, 41);
  const expected = [previews.at(-1)!, cancelled];
  const result = retainReplayableRuntimeEvents([...previews, cancelled], {
    maxEvents: 2, maxBytes: jsonEventArrayUtf8Bytes(expected),
  });
  expect(result.events).toEqual(expected);
  expect(result.bytes).toBe(jsonEventArrayUtf8Bytes(expected));
  expect(result.dependencyTruncated).toBe(false);
  expect(reduceRuntimeEvents(result.events).toolCalls.call_preview).toMatchObject({
    input: { command: "preview-39" }, status: "cancelled", error: "provider_cancelled",
  });
});

test("retention prefers the execution anchor over previews after a real tool start", () => {
  const preview = event("tool.call_updated", { callId: "call_preview", status: "running", toolName: "bash", input: {} }, 1);
  const started = event("tool.call_started", { callId: "call_preview", turnId: "turn_preview", toolName: "bash", input: { command: "pwd" } }, 2);
  const finished = event("tool.call_finished", { callId: "call_preview", status: "completed", output: "ok" }, 3);
  const result = retainReplayableRuntimeEvents([preview, started, finished], { maxEvents: 2, maxBytes: 10_000 });
  expect(result.events).toEqual([started, finished]);
  expect(reduceRuntimeEvents(result.events).toolCalls.call_preview).toMatchObject({ turnId: "turn_preview", status: "completed" });
});

test("partial metadata, status and output events cannot create a preview anchor", () => {
  const invalidPreviews = [
    { status: "running" },
    { status: "running", toolName: "bash" },
    { status: "running", input: {} },
    { status: "running", toolName: "", input: {} },
    { status: "running", toolName: "bash", input: undefined },
    { status: "waiting_for_approval", toolName: "bash", input: {} },
  ];
  for (const payload of invalidPreviews) {
    const rows = [event("tool.call_updated", { callId: "call_orphan", ...payload }, 1),
      event("tool.output_delta", { callId: "call_orphan", stream: "stdout", delta: "unanchored" }, 2),
      event("tool.call_finished", { callId: "call_orphan", status: "completed" }, 3)];
    const result = retainReplayableRuntimeEvents(rows, { maxEvents: 20, maxBytes: 10_000 });
    expect(result.events).toEqual([]);
    expect(result.dependencyTruncated).toBe(true);
  }
});

test("an oversized input preview still cannot exceed the exact byte budget", () => {
  const preview = event("tool.call_updated", { callId: "call_large", status: "running", toolName: "bash", input: { command: "😀".repeat(2_000) } }, 1);
  const cancelled = event("tool.call_finished", { callId: "call_large", status: "cancelled" }, 2);
  const result = retainReplayableRuntimeEvents([preview, cancelled], { maxEvents: 20, maxBytes: 1_000 });
  expect(result.events).toEqual([]);
  expect(result.bytes).toBe(2);
  expect(result.truncated).toBe(true);
});

test("a preview or execution in another session cannot anchor an orphan with the same call id", () => {
  for (const root of [
    event("tool.call_updated", { callId: "shared_call", status: "running", toolName: "bash", input: {} }, 1),
    event("tool.call_started", { callId: "shared_call", turnId: "turn_a", toolName: "bash", input: {} }, 1),
  ]) {
    const orphan = event("tool.call_finished", { callId: "shared_call", status: "completed", output: "foreign" }, 2, "event_foreign", "session_2");
    const result = retainReplayableRuntimeEvents([root, orphan], { maxEvents: 20, maxBytes: 10_000 });
    expect(result.events).toEqual([root]);
    expect(result.dependencyTruncated).toBe(true);
  }
});

test("replayed preview snapshots remain deduplicated and preserve durable order after clock rollback", () => {
  const accumulator = new ReplayableRuntimeEventWindowAccumulator({ maxEvents: 10, maxBytes: 10_000 });
  const first = event("tool.call_updated", { callId: "call_preview", status: "running", toolName: "bash", input: {} }, 30);
  const second = event("tool.call_updated", { callId: "call_preview", status: "running", toolName: "bash", input: { command: "pwd" } }, 20);
  const started = event("tool.call_started", { callId: "call_preview", turnId: "turn_preview", toolName: "bash", input: { command: "pwd" } }, 10);
  accumulator.addSource([first, second], { sourceOrder: 0 });
  const result = accumulator.addSource([first, second, started], { sourceOrder: 0 });
  expect(result.events).toEqual([first, second, started]);
  expect(result.truncated).toBe(false);
  expect(result.dependencyTruncated).toBe(false);
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
