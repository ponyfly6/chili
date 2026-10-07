import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRuntimeStateSnapshot,
  RuntimeValidationError,
  type ApprovalId,
  type MessageId,
  type PartId,
  type RuntimeEvent,
  type SessionId,
  type TimestampMs,
  type ToolCallId,
  type TurnId,
} from "@chili/protocol";
import { RuntimeSnapshotLimitError } from "./runtime-snapshot.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

const sessionId = "session_snapshot" as SessionId;
const turnId = "turn_snapshot" as TurnId;
const messageId = "message_snapshot" as MessageId;
const partId = "part_snapshot" as PartId;
const callId = "call_snapshot" as ToolCallId;

function event<T extends RuntimeEvent["type"]>(
  id: string,
  type: T,
  payload: Extract<RuntimeEvent, { type: T }>["payload"],
  time = 1,
): Extract<RuntimeEvent, { type: T }> {
  return { id, type, sessionId, time: time as TimestampMs, payload } as Extract<RuntimeEvent, { type: T }>;
}

function sessionCreated(): RuntimeEvent {
  return event("event_session", "session.created", { sessionId, cwd: "/repo" });
}

test("runtime snapshot materializes ongoing message deltas and hands off at the captured durable cursor", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    await store.appendMany([
      sessionCreated(),
      event("event_turn", "turn.started", { turnId }),
      event("event_message", "message.created", { messageId, role: "assistant", turnId }),
      event("event_part", "message.part_added", {
        messageId,
        part: { id: partId, messageId, sessionId, type: "text", text: "hel" },
      }),
      event("event_delta", "message.part_delta", { messageId, partId, field: "text", delta: "lo" }),
    ]);
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId }));
    expect(snapshot.version).toBe(1);
    expect(snapshot.afterEventId).toBe("event_delta");
    expect(snapshot.coveredSessionIds).toContain(sessionId);
    expect(snapshot.temporaryOutput).toBe("not-replayed");
    expect(snapshot.events.filter((entry) => entry.type === "message.part_delta")).toEqual([]);
    expect(snapshot.events.find((entry) => entry.type === "message.part_added")).toMatchObject({
      payload: { messageId, part: { id: partId, text: "hello" } },
    });

    const next = event("event_after_snapshot", "message.part_delta", {
      messageId, partId, field: "text", delta: "!",
    });
    await store.append(next);
    expect(await store.events({ sessionId, afterEventId: snapshot.afterEventId! })).toEqual([next]);
    expect(snapshot.events.find((entry) => entry.type === "message.part_added")).toMatchObject({
      payload: { part: { text: "hello" } },
    });
  } finally {
    store.close();
  }
});

test("runtime snapshot omits a resume cursor when no durable event exists", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot());
    expect(snapshot.afterEventId).toBeUndefined();
    expect(snapshot.events).toEqual([]);
    expect(snapshot.coveredSessionIds).toEqual([]);
    expect(snapshot.truncated).toBe(false);
  } finally {
    store.close();
  }
});

test("runtime snapshot bounds large persisted output by UTF-8 bytes and advertises truncation", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    const largeOutput = "输出🙂".repeat(150_000);
    await store.appendMany([
      sessionCreated(),
      event("event_turn", "turn.started", { turnId }),
      event("event_tool_started", "tool.call_started", { turnId, callId, toolName: "bash", input: { command: "large-output" } }),
      event("event_tool_finished", "tool.call_finished", { callId, status: "completed", output: largeOutput }),
      event("event_tool_message", "message.created", { messageId, role: "tool", turnId }),
      event("event_tool_part", "message.part_added", {
        messageId,
        part: { id: partId, messageId, sessionId, type: "tool_result", callId, output: largeOutput },
      }),
    ]);
    const maxBytes = 64 * 1_024;
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId, maxBytes }));
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.warning).toBeTruthy();
    expect(snapshot.afterEventId).toBe("event_tool_part");
    const finished = snapshot.events.find((entry) => entry.type === "tool.call_finished");
    expect(finished).toBeDefined();
    if (finished?.type === "tool.call_finished") {
      expect(finished.payload.status).toBe("completed");
      expect(finished.payload.output).not.toBe(largeOutput);
    }
    const part = snapshot.events.find((entry) => entry.type === "message.part_added");
    expect(part).toBeDefined();
    if (part?.type === "message.part_added" && part.payload.part.type === "tool_result") {
      expect(part.payload.part.output).not.toBe(largeOutput);
    }
  } finally {
    store.close();
  }
});

test("runtime snapshot keeps unresolved approvals and their active tool anchors", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    const pendingId = "approval_pending" as ApprovalId;
    const resolvedId = "approval_resolved" as ApprovalId;
    await store.appendMany([
      sessionCreated(),
      event("event_tool_started", "tool.call_started", { turnId, callId, toolName: "bash", input: { command: "bun test" } }),
      event("event_tool_waiting", "tool.call_updated", { callId, status: "waiting_for_approval" }),
      event("event_old_approval", "approval.requested", { approvalId: resolvedId, permission: "tool.bash", patterns: ["pwd"] }),
      event("event_old_resolution", "approval.resolved", { approvalId: resolvedId, decision: "allow_once" }),
      event("event_pending_approval", "approval.requested", {
        approvalId: pendingId, callId, permission: "tool.bash", patterns: ["bun test"],
        maxApprovalScope: "once", metadata: { reason: "workspace policy" },
      }),
    ]);
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId }));
    const approvals = snapshot.events.filter((entry) => entry.type === "approval.requested");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      payload: { approvalId: pendingId, callId, maxApprovalScope: "once", metadata: { reason: "workspace policy" } },
    });
    const startIndex = snapshot.events.findIndex((entry) => entry.type === "tool.call_started" && entry.payload.callId === callId);
    const approvalIndex = snapshot.events.findIndex((entry) => entry.type === "approval.requested");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeLessThan(approvalIndex);
    expect(snapshot.events.find((entry) => entry.type === "tool.call_updated")).toMatchObject({
      payload: { callId, status: "waiting_for_approval" },
    });
  } finally {
    store.close();
  }
});

test("runtime snapshot restores the latest session lifecycle and retry state", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    await store.appendMany([
      sessionCreated(),
      event("event_old_status", "session.status_changed", { sessionId, status: "idle" }),
      event("event_started", "turn.started", { turnId }),
      event("event_running", "session.status_changed", { sessionId, status: "running", turnId }),
      event("event_retry_one", "turn.retry_scheduled", { turnId, attempt: 1, delayMs: 100, reason: "network" }),
      event("event_retry_two", "turn.retry_scheduled", { turnId, attempt: 2, delayMs: 200, reason: "network" }),
    ]);
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId }));
    expect(snapshot.events.filter((entry) => entry.type === "session.status_changed")).toMatchObject([
      { payload: { sessionId, status: "running", turnId } },
    ]);
    expect(snapshot.events.filter((entry) => entry.type === "turn.retry_scheduled")).toMatchObject([
      { payload: { turnId, attempt: 2, delayMs: 200 } },
    ]);
    const started = snapshot.events.findIndex((entry) => entry.type === "turn.started");
    const retry = snapshot.events.findIndex((entry) => entry.type === "turn.retry_scheduled");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(retry);
  } finally {
    store.close();
  }
});

test("runtime snapshot retains an active tool when old transcript history exceeds its budget", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    await store.appendMany([
      sessionCreated(),
      event("event_active_tool", "tool.call_started", { turnId, callId, toolName: "bash", input: { command: "watch-build" } }),
    ]);
    const history: RuntimeEvent[] = [];
    for (let index = 0; index < 40; index++) {
      const historyMessageId = `message_history_${index}` as MessageId;
      history.push(
        event(`event_history_message_${index}`, "message.created", { messageId: historyMessageId, role: "assistant", turnId }),
        event(`event_history_part_${index}`, "message.part_added", {
          messageId: historyMessageId,
          part: { id: `part_history_${index}` as PartId, messageId: historyMessageId, sessionId, type: "text", text: "x".repeat(1_024) },
        }),
      );
    }
    await store.appendMany(history);
    const maxBytes = 8 * 1_024;
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId, maxBytes }));
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.events.find((entry) => entry.type === "tool.call_started" && entry.payload.callId === callId)).toMatchObject({
      payload: { turnId, callId, toolName: "bash" },
    });
    expect(snapshot.afterEventId).toBe("event_history_part_39");
    expect(snapshot.events.some((entry) => entry.type === "tool.call_finished" && entry.payload.callId === callId)).toBe(false);
  } finally {
    store.close();
  }
});

test("runtime snapshot excludes temporary tool output while preserving durable completion", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    await store.appendMany([
      sessionCreated(),
      event("event_turn", "turn.started", { turnId }),
      event("event_tool_started", "tool.call_started", { turnId, callId, toolName: "bash", input: {} }),
      event("event_preview", "tool.output_delta", { callId, stream: "stdout", delta: "temporary preview" }),
      event("event_tool_finished", "tool.call_finished", { callId, status: "completed", output: "durable result" }),
    ]);
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId }));
    expect(snapshot.temporaryOutput).toBe("not-replayed");
    expect(snapshot.events.some((entry) => entry.type === "tool.output_delta")).toBe(false);
    expect(snapshot.events.find((entry) => entry.type === "tool.call_finished")).toMatchObject({
      payload: { callId, output: "durable result", status: "completed" },
    });
    expect(snapshot.afterEventId).toBe("event_tool_finished");
  } finally {
    store.close();
  }
});

test("runtime snapshot recovers beyond an oversized status event without losing lifecycle state", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    await store.appendMany([
      sessionCreated(),
      event("event_started", "turn.started", { turnId }),
      event("event_oversized_status", "session.status_changed", {
        sessionId, status: "running", turnId, reason: "large diagnostic ".repeat(250_000),
      }),
    ]);
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId }));
    expect(snapshot.afterEventId).toBe("event_oversized_status");
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.warning).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThan(64 * 1_024);
    expect(snapshot.events.find((entry) => entry.type === "session.status_changed")).toMatchObject({
      payload: { sessionId, status: "running", turnId },
    });
    const completed = event("event_completed_after_recovery", "turn.completed", { turnId, status: "completed" });
    await store.append(completed);
    expect(await store.events({ sessionId, afterEventId: snapshot.afterEventId! })).toEqual([completed]);
  } finally {
    store.close();
  }
});

test("runtime snapshot fails explicitly when required state cannot fit the byte budget", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    await store.append(sessionCreated());
    await expect(store.runtimeSnapshot({ sessionId, maxBytes: 16 }))
      .rejects.toThrow(RuntimeSnapshotLimitError);
  } finally {
    store.close();
  }
});

test("runtime snapshot reads the archived queue projection instead of its older pending event", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    await store.append(sessionCreated());
    store.mutateSessionInputs({
      kind: "accept", sessionId, submissionId: "submission_snapshot", inputId: "input_snapshot",
      mode: "queue", payload: '{"text":"queued"}', text: "queued", source: "local",
    });
    const queueEventsBeforeArchive = await store.events({ sessionId, type: "session.input_queue_changed" });
    expect(store.sessionInputQueue(sessionId).pendingCount).toBe(1);
    await store.append(event("event_archived", "session.archived", { sessionId }, Date.now()));
    expect(await store.events({ sessionId, type: "session.input_queue_changed" })).toEqual(queueEventsBeforeArchive);

    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId }));
    const queue = snapshot.events.find((entry) => entry.type === "session.input_queue_changed");
    expect(queue?.payload).toEqual(store.sessionInputQueue(sessionId));
    expect(queue?.payload).toMatchObject({ paused: true, pendingCount: 0, items: [] });
    expect(snapshot.afterEventId).toBe("event_archived");
    expect(snapshot.events.some((entry) => entry.type === "session.archived")).toBe(true);
  } finally {
    store.close();
  }
});

test("runtime snapshot covers every existing session including empty and archived history", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    const emptySessionId = "session_empty" as SessionId;
    const archivedSessionId = "session_archived" as SessionId;
    await store.appendMany([
      sessionCreated(),
      { ...event("event_empty_session", "session.created", { sessionId: emptySessionId, cwd: "/repo" }), sessionId: emptySessionId },
      { ...event("event_archive_session", "session.created", { sessionId: archivedSessionId, cwd: "/repo" }), sessionId: archivedSessionId },
      { ...event("event_archive", "session.archived", { sessionId: archivedSessionId }), sessionId: archivedSessionId },
    ]);
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot());
    expect(new Set(snapshot.coveredSessionIds)).toEqual(new Set([sessionId, emptySessionId, archivedSessionId]));
    expect(new Set(snapshot.events.filter((entry) => entry.type === "session.created").map((entry) => entry.sessionId)))
      .toEqual(new Set(snapshot.coveredSessionIds));
    expect(snapshot.afterEventId).toBe("event_archive");
    const scoped = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId: emptySessionId }));
    expect(scoped.coveredSessionIds).toEqual([emptySessionId]);
    expect(scoped.events.every((entry) => entry.sessionId === emptySessionId)).toBe(true);
  } finally {
    store.close();
  }
});

test("runtime snapshot clears stale retry state after a later durable message delta", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    await store.appendMany([
      sessionCreated(),
      event("event_turn", "turn.started", { turnId }),
      event("event_message", "message.created", { messageId, role: "assistant", turnId }),
      event("event_part", "message.part_added", {
        messageId, part: { id: partId, messageId, sessionId, type: "text", text: "hello" },
      }),
      event("event_retry", "turn.retry_scheduled", { turnId, attempt: 1, delayMs: 100, reason: "network" }),
      event("event_resumed_delta", "message.part_delta", { messageId, partId, field: "text", delta: " again" }),
    ]);
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId }));
    expect(snapshot.events.some((entry) => entry.type === "turn.retry_scheduled")).toBe(false);
    expect(snapshot.events.find((entry) => entry.type === "message.part_added")).toMatchObject({
      payload: { part: { text: "hello again" } },
    });
    expect(snapshot.afterEventId).toBe("event_resumed_delta");
  } finally {
    store.close();
  }
});

test("runtime snapshot parser rejects unsafe covered session identifiers and oversized warnings", () => {
  const valid = { version: 1, events: [], coveredSessionIds: [sessionId], truncated: false, temporaryOutput: "not-replayed" };
  expect(parseRuntimeStateSnapshot(valid).coveredSessionIds).toEqual([sessionId]);
  for (const id of ["__proto__", "constructor", "prototype", "session\nforged"]) {
    expect(() => parseRuntimeStateSnapshot({ ...valid, coveredSessionIds: [id] })).toThrow(RuntimeValidationError);
  }
  expect(() => parseRuntimeStateSnapshot({ ...valid, warning: "x".repeat(2_001) })).toThrow(RuntimeValidationError);
});

test("runtime snapshot finalizes SQLite iterators after truncating deltas and rejecting a small budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-runtime-snapshot-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  try {
    await store.appendMany([
      sessionCreated(),
      event("event_turn", "turn.started", { turnId }),
      event("event_message", "message.created", { messageId, role: "assistant", turnId }),
      event("event_part", "message.part_added", {
        messageId, part: { id: partId, messageId, sessionId, type: "text", text: "x".repeat(32_000) },
      }),
      event("event_large_delta", "message.part_delta", { messageId, partId, field: "text", delta: "y".repeat(32_000) }),
      event("event_tail_delta", "message.part_delta", { messageId, partId, field: "text", delta: "tail" }),
    ]);
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId, maxBytes: 64 * 1_024 }));
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.afterEventId).toBe("event_tail_delta");
    await expect(store.runtimeSnapshot({ sessionId, maxBytes: 1_024 }))
      .rejects.toThrow(RuntimeSnapshotLimitError);
    // A WAL checkpoint on file-backed stores detects statements left active by early loop exits.
    expect(() => store.close()).not.toThrow();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime snapshot retains completed turn state and latest metadata for historical messages once", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    const oldTurnId = "turn_history" as TurnId;
    const oldMessageId = "message_history" as MessageId;
    const oldSecondMessageId = "message_history_second" as MessageId;
    await store.appendMany([
      sessionCreated(),
      event("event_old_turn", "turn.started", { turnId: oldTurnId }),
      event("event_old_metadata", "turn.model_metadata", { turnId: oldTurnId, model: "old-model", responseId: "response_old" }),
      event("event_old_message", "message.created", { messageId: oldMessageId, role: "assistant", turnId: oldTurnId }),
      event("event_old_message_second", "message.created", { messageId: oldSecondMessageId, role: "assistant", turnId: oldTurnId }),
      event("event_old_latest_metadata", "turn.model_metadata", {
        turnId: oldTurnId, model: "old-model", responseId: "response_final", usage: { outputTokens: 23 },
      }),
      event("event_old_completed", "turn.completed", { turnId: oldTurnId, status: "failed" }),
      event("event_current_turn", "turn.started", { turnId }),
      event("event_current_metadata", "turn.model_metadata", { turnId, model: "current-model", responseId: "response_current" }),
      event("event_current_message", "message.created", { messageId, role: "assistant", turnId }),
    ]);
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId }));
    expect(snapshot.events.filter((entry) => entry.type === "message.created")).toHaveLength(3);
    expect(snapshot.events.filter((entry) => entry.type === "turn.started" && entry.payload.turnId === oldTurnId)).toHaveLength(1);
    expect(snapshot.events.filter((entry) => entry.type === "turn.completed" && entry.payload.turnId === oldTurnId))
      .toMatchObject([{ payload: { turnId: oldTurnId, status: "failed" } }]);
    expect(snapshot.events.filter((entry) => entry.type === "turn.model_metadata" && entry.payload.turnId === oldTurnId))
      .toMatchObject([{ payload: { responseId: "response_final", model: "old-model", usage: { outputTokens: 23 } } }]);
    const oldCompleted = snapshot.events.findIndex((entry) => entry.type === "turn.completed" && entry.payload.turnId === oldTurnId);
    const currentStarted = snapshot.events.findIndex((entry) => entry.type === "turn.started" && entry.payload.turnId === turnId);
    expect(oldCompleted).toBeLessThan(currentStarted);
    expect(snapshot.events.some((entry) => entry.type === "turn.completed" && entry.payload.turnId === turnId)).toBe(false);
  } finally {
    store.close();
  }
});

test("runtime snapshot resolves file-backed thinking and tool content after reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-file-snapshot-"));
  const filename = join(directory, "events.sqlite");
  let store = new SqliteEventStore(filename);
  try {
    await store.appendMany([
      sessionCreated(),
      event("event_turn", "turn.started", { turnId }),
      event("event_message", "message.created", { messageId, role: "assistant", turnId }),
      event("event_reasoning", "message.part_added", {
        messageId, part: { id: partId, messageId, sessionId, type: "reasoning", text: "Compare the two options." },
      }),
      event("event_tool", "tool.call_started", { turnId, callId, toolName: "bash", input: { command: "pwd" } }),
      event("event_result", "tool.call_finished", { callId, status: "completed", output: "/repo", error: "diagnostic" }),
    ]);
    store.close();
    store = new SqliteEventStore(filename);

    // This budget makes the display prefix smaller than a file-reference marker.
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId, maxBytes: 2_048 }));
    expect(snapshot.events.find((entry) => entry.type === "message.part_added")).toMatchObject({
      payload: { part: { type: "reasoning", text: "Compare the two options." } },
    });
    expect(snapshot.events.find((entry) => entry.type === "tool.call_started")).toMatchObject({
      payload: { callId, input: { command: "pwd" } },
    });
    expect(snapshot.events.find((entry) => entry.type === "tool.call_finished")).toMatchObject({
      payload: { callId, output: "/repo", error: "diagnostic" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("$chiliContent");
    expect(snapshot.truncated).toBe(false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime snapshot preserves valid part shapes when referenced JSON exceeds its display budget", async () => {
  const store = new SqliteEventStore(":memory:");
  try {
    await store.appendMany([
      sessionCreated(),
      event("event_message", "message.created", { messageId, role: "tool", turnId }),
      event("event_tool_result", "message.part_added", {
        messageId,
        part: {
          id: partId, messageId, sessionId, type: "tool_result", callId, output: "Saved result",
          content: [{ type: "text", text: "large result".repeat(10_000) }],
        },
      }),
      event("event_patch", "message.part_added", {
        messageId,
        part: {
          id: "part_patch" as PartId, messageId, sessionId, type: "patch",
          files: Array.from({ length: 1_000 }, (_, index) => `source/directory/file-${index}.ts`),
        },
      }),
    ]);
    const snapshot = parseRuntimeStateSnapshot(await store.runtimeSnapshot({ sessionId, maxBytes: 8_192 }));
    expect(snapshot.truncated).toBe(true);
    const parts = snapshot.events.filter((entry) => entry.type === "message.part_added");
    expect(parts).toHaveLength(2);
    expect(parts[0]?.payload.part).toMatchObject({ type: "tool_result", output: "Saved result" });
    expect(parts[0]?.payload.part).not.toHaveProperty("content");
    expect(parts[1]?.payload.part).toMatchObject({ type: "patch", files: [] });
  } finally {
    store.close();
  }
});
