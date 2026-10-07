import { expect, test } from "bun:test";
import type { Message, MessageId, MessagePart, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import { compactionGroups, compactedMessageView, ContextWindowBuilder } from "./window.js";

test("compaction groups keep parallel calls and all their results in one contiguous group", () => {
  const goal = textMessage("goal");
  const calls = message("calls", [call("a"), call("b")]);
  const resultB = message("result-b", [result("b")]);
  const resultA = message("result-a", [result("a")]);
  const next = textMessage("next");

  const groups = compactionGroups([goal, calls, resultB, resultA, next]);

  expect(groups.map((group) => group.map((entry) => entry.id))).toEqual([
    [goal.id],
    [calls.id, resultB.id, resultA.id],
    [next.id],
  ]);
  expect(groups.flat()).toEqual([goal, calls, resultB, resultA, next]);
});

test("a persisted result completes a call whose stored status remains pending", () => {
  const calls = message("calls", [call("a", "pending")]);
  const results = message("results", [result("a")]);

  expect(compactionGroups([calls, results])).toEqual([[calls, results]]);
});

test("compaction never treats terminal call status alone as result coverage", () => {
  for (const status of ["pending", "running", "completed", "failed", "cancelled"] as const) {
    expect(() => compactionGroups([message(`call-${status}`, [call("a", status)])]))
      .toThrow("without results");
  }
});

test("compaction rejects orphan, duplicate, and reordered tool results", () => {
  const invalidSources = [
    [message("orphan", [result("a")])],
    [message("reversed", [result("a"), call("a")])],
    [message("duplicate-result", [call("a"), result("a"), result("a")])],
  ];

  for (const source of invalidSources) {
    expect(() => compactionGroups(source)).toThrow("without a preceding unmatched call");
  }
});

test("compaction rejects reused internal call identifiers even after a completed group", () => {
  expect(() => compactionGroups([
    message("first", [call("a"), result("a")]),
    message("second", [call("a"), result("a")]),
  ])).toThrow("Duplicate tool call");
});

test("manual boundaries retain unfinished tool activity and malformed results", () => {
  const goal = textMessage("goal");
  const builder = new ContextWindowBuilder();

  expect(builder.compactionBoundary([goal, message("pending", [call("a")])], "manual")?.boundaryMessageId)
    .toBe(goal.id);
  expect(builder.compactionBoundary([goal, message("orphan", [result("a")])], "manual")?.boundaryMessageId)
    .toBe(goal.id);
  expect(builder.compactionBoundary([message("orphan", [result("a")]), goal], "manual"))
    .toBeUndefined();
});

test("automatic boundaries use original calls even if model projection omits their oversized names", () => {
  const goal = textMessage("goal");
  const pendingCall = call("a");
  pendingCall.toolName = "oversized-tool-name".repeat(10);
  const pending = message("pending", [pendingCall]);
  const latest = textMessage("latest");
  const builder = new ContextWindowBuilder({
    maxInputChars: 1_000,
    maxMessagePartChars: 40,
    compactionThresholdRatio: 0,
    preserveRecentMessages: 0,
  });

  const built = builder.build([goal, pending, latest]);

  expect(built.messages.map((entry) => entry.id)).toEqual([goal.id, latest.id]);
  expect(built.compactionBoundary?.boundaryMessageId).toBe(goal.id);
  expect(builder.compactionBoundary([goal, pending, latest], "manual")?.boundaryMessageId).toBe(goal.id);
});

test("automatic boundaries never split calls from results across the retained tail", () => {
  const goal = textMessage("goal");
  const calls = message("calls", [call("a")]);
  const results = message("results", [result("a")]);
  const latest = textMessage("latest");
  const built = new ContextWindowBuilder({
    compactionThresholdRatio: 0,
    preserveRecentMessages: 2,
  }).build([goal, calls, results, latest]);

  expect(built.compactionBoundary?.boundaryMessageId).toBe(goal.id);
});

test("repeated compaction removes old summaries stored after the new raw boundary", () => {
  const first = textMessage("first");
  const second = textMessage("second");
  const third = textMessage("third");
  const firstSummary = summaryMessage("summary-one", first.id);
  const secondSummary = summaryMessage("summary-two", second.id);
  const thirdSummary = summaryMessage("summary-three", third.id);
  const history = [first, second, firstSummary, third, secondSummary];

  const view = compactedMessageView(history);
  expect(view.map((entry) => entry.id)).toEqual([secondSummary.id, third.id]);
  expect(compactedMessageView(view)).toEqual(view);
  expect(compactedMessageView([...history, thirdSummary]).map((entry) => entry.id))
    .toEqual([thirdSummary.id]);
});

test("a missing compaction boundary cannot erase earlier uncovered history", () => {
  const first = textMessage("first");
  const second = textMessage("second");
  const invalidSummary = summaryMessage("invalid-summary", "missing" as MessageId);
  const history = [first, second, invalidSummary];

  expect(compactedMessageView(history)).toEqual(history);
  expect(new ContextWindowBuilder().build(history).messages.map((entry) => entry.id))
    .toEqual(history.map((entry) => entry.id));
});

test("a compaction marker cannot cover itself or future history", () => {
  const before = textMessage("before");
  const after = textMessage("after");
  for (const boundary of ["summary", after.id]) {
    const invalidSummary = summaryMessage("summary", boundary as MessageId);
    const history = [before, invalidSummary, after];
    expect(compactedMessageView(history)).toEqual(history);
  }
});

function textMessage(id: string): Message {
  return message(id, [{ type: "text", text: `content of ${id}` }]);
}

function summaryMessage(id: string, boundaryMessageId: MessageId): Message {
  return message(id, [{
    type: "compaction",
    boundaryMessageId,
    summary: `summary of ${boundaryMessageId}`,
    reason: "token_budget",
  }]);
}

type PartContent = MessagePart extends infer Part
  ? Part extends MessagePart ? Omit<Part, "id" | "messageId" | "sessionId"> : never
  : never;

function message(id: string, parts: PartContent[]): Message {
  const messageId = id as MessageId;
  const sessionId = "session" as SessionId;
  return {
    id: messageId,
    sessionId,
    role: parts.some((part) => part.type === "tool_call") ? "assistant" : "user",
    createdAt: 1 as TimestampMs,
    parts: parts.map((part, index) => ({
      ...part,
      id: `${id}-${index}` as PartId,
      messageId,
      sessionId,
    })),
  };
}

function call(callId: string, status: Extract<MessagePart, { type: "tool_call" }>["status"] = "pending") {
  return { type: "tool_call" as const, callId: callId as ToolCallId, toolName: "inspect", input: {}, status };
}

function result(callId: string) {
  return { type: "tool_result" as const, callId: callId as ToolCallId, output: `result for ${callId}` };
}
