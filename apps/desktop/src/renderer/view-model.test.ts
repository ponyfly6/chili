import { expect, test } from "bun:test";
import type { ChiliEvent } from "@chili/protocol";
import type { RuntimeSnapshot, UserInputRequest } from "../shared/contracts.js";
import type { ChatSessionView, ChiliRuntimeView, RuntimePendingApprovalRequest } from "@chili/sdk";
import {
  appendRuntimeEvent,
  boundedToolLiveOutput,
  compactDesktopTranscript,
  desktopTimelineItems,
  presentSession,
  runtimeEventRelated,
  runtimeEventRetentionDiagnostics,
  runtimeEventSerializedBytes,
  visibleToolLiveOutput,
} from "./view-model.js";

test("keeps user and final answers prominent while folding intermediate work into one row", () => {
  const timeline = desktopTimelineItems(chatWithItems([
    {
      id: "message_user" as never,
      kind: "message",
      role: "user",
      createdAt: 100,
      parts: [{ type: "text", id: "part_user" as never, text: "Inspect this." }],
    },
    {
      id: "message_commentary" as never,
      kind: "message",
      role: "assistant",
      createdAt: 110,
      parts: [{
        type: "text",
        id: "part_commentary" as never,
        text: "Checking the relevant files.",
        phase: "commentary",
      }],
    },
    {
      id: "call_read" as never,
      kind: "tool",
      toolName: "read",
      status: "completed",
      displayStatus: "succeeded",
      waitingForApproval: false,
      updatedAt: 140,
      inputSummary: { title: "read", detail: "README.md" },
      output: "contents",
    },
    {
      id: "message_answer" as never,
      kind: "message",
      role: "assistant",
      createdAt: 160,
      parts: [{
        type: "text",
        id: "part_answer" as never,
        text: "Here is the result.",
        phase: "final_answer",
      }],
    },
  ]));

  expect(timeline.map((item) => item.kind)).toEqual(["message", "work", "message"]);
  expect(timeline[1]).toMatchObject({
    kind: "work",
    active: false,
    toolCount: 1,
    failureCount: 0,
    startedAt: 100,
    updatedAt: 160,
  });
  expect(timeline[2]).toMatchObject({
    kind: "message",
    parts: [{ type: "text", text: "Here is the result.", phase: "final_answer" }],
  });
});

test("places turn work before a final answer even when its tool row was projected later", () => {
  const chat = chatWithItems([
    {
      id: "message_turn_user" as never,
      kind: "message",
      role: "user",
      createdAt: 1,
      parts: [{ type: "text", id: "part_turn_user" as never, text: "Inspect this." }],
    },
    {
      id: "message_turn_assistant" as never,
      kind: "message",
      role: "assistant",
      createdAt: 3,
      completedAt: 50,
      parts: [
        { type: "text", id: "part_turn_commentary" as never, text: "Reading it.", phase: "commentary" },
        { type: "reasoning", id: "part_turn_reasoning" as never, text: "Need the relevant section." },
        {
          type: "tool_call",
          id: "part_turn_call" as never,
          callId: "call_turn_read" as never,
          toolName: "read",
          status: "completed",
          displayStatus: "succeeded",
        },
        {
          type: "tool_result",
          id: "part_turn_result" as never,
          callId: "call_turn_read" as never,
          output: "large contents",
        },
        { type: "text", id: "part_turn_final" as never, text: "The answer.", phase: "final_answer" },
      ],
    },
    {
      id: "call_turn_read" as never,
      kind: "tool",
      toolName: "read",
      status: "completed",
      displayStatus: "succeeded",
      waitingForApproval: false,
      updatedAt: 40,
      inputSummary: { title: "read", detail: "README.md" },
      output: "large contents",
    },
  ]);
  const runtime = {
    messages: {
      message_turn_user: { turnId: "turn_1" },
      message_turn_assistant: { turnId: "turn_1", completedAt: 50 },
    },
    toolCalls: { call_turn_read: { turnId: "turn_1" } },
    turnStatuses: { turn_1: "completed" },
    turnStartedAt: { turn_1: 2 },
  } as unknown as Pick<ChiliRuntimeView, "messages" | "toolCalls" | "turnStatuses" | "turnStartedAt">;

  const timeline = desktopTimelineItems(chat, runtime);

  expect(timeline.map((item) => item.kind)).toEqual(["message", "work", "message"]);
  expect(timeline[1]).toMatchObject({
    id: "work:turn_1",
    kind: "work",
    active: false,
    startedAt: 2,
    updatedAt: 50,
    items: [
      { kind: "message", parts: [{ type: "text", phase: "commentary" }, { type: "reasoning" }] },
      { kind: "tool", id: "call_turn_read", output: "large contents" },
    ],
  });
  expect(timeline[2]).toMatchObject({
    kind: "message",
    parts: [{ type: "text", phase: "final_answer", text: "The answer." }],
  });
});

test("keeps the work row identity stable as a turn changes from working to worked", () => {
  const runningChat = chatWithItems([{
    id: "call_stable" as never,
    kind: "tool",
    toolName: "bash",
    status: "running",
    displayStatus: "running",
    waitingForApproval: false,
    updatedAt: 10,
    inputSummary: { title: "bash", detail: "bun test" },
  }], "running");
  const runningRuntime = {
    messages: {},
    toolCalls: { call_stable: { turnId: "turn_stable" } },
    turnStatuses: { turn_stable: "running" },
    turnStartedAt: { turn_stable: 5 },
  } as unknown as Pick<ChiliRuntimeView, "messages" | "toolCalls" | "turnStatuses" | "turnStartedAt">;
  const completedChat = chatWithItems([{
    ...(runningChat.items[0] as Extract<ChatSessionView["items"][number], { kind: "tool" }>),
    status: "completed",
    displayStatus: "succeeded",
    updatedAt: 20,
  }]);
  const completedRuntime = {
    ...runningRuntime,
    turnStatuses: { turn_stable: "completed" },
  } as unknown as Pick<ChiliRuntimeView, "messages" | "toolCalls" | "turnStatuses" | "turnStartedAt">;

  expect(desktopTimelineItems(runningChat, runningRuntime)[0]).toMatchObject({ id: "work:turn_stable", active: true });
  expect(desktopTimelineItems(completedChat, completedRuntime)[0]).toMatchObject({ id: "work:turn_stable", active: false });
});

test("keeps unphased legacy assistant text as a direct answer", () => {
  const timeline = desktopTimelineItems(chatWithItems([{
    id: "message_legacy_answer" as never,
    kind: "message",
    role: "assistant",
    createdAt: 1,
    parts: [{ type: "text", id: "part_legacy_answer" as never, text: "Legacy answer." }],
  }]));

  expect(timeline).toEqual([expect.objectContaining({
    kind: "message",
    parts: [expect.objectContaining({ text: "Legacy answer." })],
  })]);
});

test("splits commentary and final answer parts from the same assistant message", () => {
  const timeline = desktopTimelineItems(chatWithItems([{
    id: "message_mixed_phases" as never,
    kind: "message",
    role: "assistant",
    createdAt: 200,
    parts: [
      {
        type: "text",
        id: "part_commentary" as never,
        text: "I found the issue.",
        phase: "commentary",
      },
      {
        type: "text",
        id: "part_final" as never,
        text: "The fix is ready.",
        phase: "final_answer",
      },
    ],
  }]));

  expect(timeline).toHaveLength(2);
  expect(timeline[0]).toMatchObject({
    kind: "work",
    items: [{ parts: [{ text: "I found the issue.", phase: "commentary" }] }],
  });
  expect(timeline[1]).toMatchObject({
    kind: "message",
    parts: [{ text: "The fix is ready.", phase: "final_answer" }],
  });
});

test("marks the trailing work disclosure active while the session is running", () => {
  const timeline = desktopTimelineItems(chatWithItems([{
    id: "call_running" as never,
    kind: "tool",
    toolName: "bash",
    status: "running",
    displayStatus: "running",
    waitingForApproval: false,
    updatedAt: 300,
    inputSummary: { title: "bash", detail: "bun test" },
  }], "running"));

  expect(timeline).toHaveLength(1);
  expect(timeline[0]).toMatchObject({
    kind: "work",
    active: true,
    toolCount: 1,
    failureCount: 0,
  });
});

test("counts failed tools inside the collapsed work disclosure", () => {
  const timeline = desktopTimelineItems(chatWithItems([{
    id: "call_failed" as never,
    kind: "tool",
    toolName: "bash",
    status: "failed",
    displayStatus: "failed",
    waitingForApproval: false,
    updatedAt: 400,
    inputSummary: { title: "bash", detail: "bun test" },
    error: "tests failed",
  }]));

  expect(timeline).toHaveLength(1);
  expect(timeline[0]).toMatchObject({
    kind: "work",
    active: false,
    toolCount: 1,
    failureCount: 1,
  });
});

test("shows linked tool calls once and keeps raw results behind the compact tool row", () => {
  const chat = chatWithItems([
    {
      id: "message_tools" as never,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      parts: [
        {
          type: "tool_call",
          id: "part_call" as never,
          callId: "call_read" as never,
          toolName: "read",
          status: "completed",
          displayStatus: "succeeded",
        },
        {
          type: "tool_result",
          id: "part_result" as never,
          callId: "call_read" as never,
          output: "<large raw file contents>",
        },
      ],
    },
    {
      id: "call_read" as never,
      kind: "tool",
      toolName: "read",
      status: "completed",
      displayStatus: "succeeded",
      waitingForApproval: false,
      updatedAt: 2,
      inputSummary: { title: "read", detail: "README.md" },
      output: "<large raw file contents>",
    },
  ]);

  const compact = compactDesktopTranscript(chat);
  expect(compact.items).toHaveLength(1);
  expect(compact.items[0]).toMatchObject({ kind: "tool", id: "call_read" });
  expect(chat.items).toHaveLength(2);
});

test("keeps assistant text and orphaned tool results as fallback content", () => {
  const compact = compactDesktopTranscript(chatWithItems([{
    id: "message_mixed" as never,
    kind: "message",
    role: "assistant",
    createdAt: 1,
    parts: [
      { type: "text", id: "part_text" as never, text: "Done." },
      {
        type: "tool_result",
        id: "part_orphan" as never,
        callId: "call_missing" as never,
        output: "fallback result",
      },
    ],
  }]));

  expect(compact.items[0]).toMatchObject({
    kind: "message",
    parts: [
      { type: "text", text: "Done." },
      { type: "tool_result", output: "fallback result" },
    ],
  });
});

test("uses authoritative restored approvals even when their event anchors are unavailable", () => {
  const snapshot = baseSnapshot([
    event("session.created", "root", { sessionId: "root", cwd: "/repo" }, 1),
  ], [], [
    approval("approval_root", "root", "call_root", 6),
    approval("approval_child", "child", "call_child", 10),
  ]);

  expect(presentSession(snapshot).pendingApprovals.map((approval) => String(approval.id))).toEqual([
    "approval_root",
    "approval_child",
  ]);
});

test("an empty authoritative approval set replaces stale approval event projection", () => {
  const activeEvents = [
    event("session.created", "root", { sessionId: "root", cwd: "/repo" }, 1),
    event("session.status_changed", "root", { sessionId: "root", status: "running" }, 2),
    event("tool.call_started", "root", {
      turnId: "turn_root",
      callId: "call_root",
      toolName: "bash",
      input: {},
    }, 3),
    event("tool.call_updated", "root", { callId: "call_root", status: "waiting_for_approval" }, 4),
    event("approval.requested", "root", {
      approvalId: "approval_root",
      callId: "call_root",
      permission: "tool.bash",
      patterns: ["bun test"],
    }, 5),
  ];
  expect(presentSession(baseSnapshot(activeEvents)).pendingApprovals).toEqual([]);
});

test("live approval request and resolution update the authoritative set immediately", () => {
  const requested = event("approval.requested", "root", {
    approvalId: "approval_live",
    callId: "call_live",
    permission: "tool.edit",
    patterns: ["README.md"],
  }, 5);
  const waiting = appendRuntimeEvent(baseSnapshot([]), requested);
  expect(presentSession(waiting).pendingApprovals.map((row) => String(row.id))).toEqual(["approval_live"]);
  const resolved = appendRuntimeEvent(waiting, event("approval.resolved", "root", {
    approvalId: "approval_live",
    decision: "allow_once",
  }, 6));
  expect(presentSession(resolved).pendingApprovals).toEqual([]);
});

test("replaces duplicate streamed events instead of duplicating timeline state", () => {
  const first = event("session.status_changed", "root", { status: "running" }, 1);
  const replacement = { ...first, payload: { status: "idle" } } as ChiliEvent;
  const snapshot = appendRuntimeEvent(appendRuntimeEvent(baseSnapshot([]), first), replacement);
  expect(snapshot.events).toHaveLength(1);
  expect(snapshot.events[0]?.payload as unknown).toEqual({ status: "idle" });
});

test("uses the pending-input query as truth and removes it on cancellation", () => {
  const requested = event("user_input.requested", "root", {
    inputId: "userinput_live",
    callId: "toolcall_live",
    questions: userInput("userinput_live").questions,
  }, 1);
  const cancelled = event("user_input.cancelled", "root", {
    inputId: "userinput_live",
    reason: "session interrupted",
  }, 2);

  const replayed = appendRuntimeEvent(baseSnapshot([]), requested);
  expect(replayed.pendingInputs).toEqual([]);
  expect(presentSession(replayed).pendingInputs).toEqual([]);

  const waiting = appendRuntimeEvent(baseSnapshot([], [userInput("userinput_live")]), requested);
  expect(presentSession(waiting).pendingInputs).toEqual([userInput("userinput_live")]);

  const stopped = appendRuntimeEvent(waiting, cancelled);
  expect(stopped.pendingInputs).toEqual([]);
  expect(presentSession(stopped).pendingInputs).toEqual([]);
});

test("terminal user input events remove stale pending rows after snapshot reload", () => {
  const stale = userInput("userinput_stale");
  const snapshot = baseSnapshot([
    event("user_input.requested", "root", {
      inputId: stale.id,
      callId: stale.callId,
      questions: stale.questions,
    }, 1),
    event("user_input.resolved", "root", { inputId: stale.id, answers: { editor: ["Zed"] } }, 2),
  ], [stale]);

  expect(presentSession(snapshot).pendingInputs).toEqual([]);
});

test("recognizes root and descendant runtime events for snapshot replay", () => {
  const snapshot = baseSnapshot([]);
  snapshot.agentTree.agents = [{ sessionId: "agent_session", childSessionId: "child_session" } as never];
  snapshot.agentTree.tasks = [{ childSessionId: "tree_task_session" } as never];
  snapshot.tasks = [{ childSessionId: "listed_task_session" } as never];

  for (const sessionId of ["root", "agent_session", "child_session", "tree_task_session", "listed_task_session"]) {
    expect(runtimeEventRelated(snapshot, event("session.status_changed", sessionId, { status: "running" }, 20))).toBe(true);
  }
  expect(runtimeEventRelated(snapshot, event("session.status_changed", "unrelated", { status: "running" }, 21))).toBe(false);
});

test("bounds live event bytes exactly and marks a visible truncation warning", () => {
  const escaped = event("event_escaped", "root", {
    status: `quote_\"_slash_\\_emoji_😀_${"界".repeat(30)}`,
  }, 30);
  expect(runtimeEventSerializedBytes(escaped)).toBe(new TextEncoder().encode(JSON.stringify(escaped)).byteLength);
  const second = { ...escaped, id: "event_escaped_2" };
  const third = { ...escaped, id: "event_escaped_3" };
  const byteBudget = new TextEncoder().encode(JSON.stringify([second, third])).byteLength;
  const limits = { maxEvents: 100, maxBytes: byteBudget };
  let snapshot = baseSnapshot([]);
  snapshot = appendRuntimeEvent(snapshot, escaped, limits);
  snapshot = appendRuntimeEvent(snapshot, second, limits);
  snapshot = appendRuntimeEvent(snapshot, third, limits);

  expect(snapshot.events.map((row) => row.id)).toEqual(["event_escaped_3"]);
  expect(new TextEncoder().encode(JSON.stringify(snapshot.events)).byteLength).toBeLessThanOrEqual(byteBudget);
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.warning).toContain("renderer budget");
});

test("a single oversized live event is dropped rather than retained without a warning", () => {
  const oversized = event("event_oversized", "root", { status: "😀".repeat(100) }, 31);
  const snapshot = appendRuntimeEvent(baseSnapshot([]), oversized, { maxEvents: 10, maxBytes: 100 });
  expect(snapshot.events).toEqual([]);
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.warning).toContain("100-byte");
  expect(snapshot.warning).not.toContain("causal anchor");
});

test("streams complete tool input previews before call_started without a truncation warning", () => {
  const rows = [
    event("session.created", "root", { sessionId: "root", cwd: "/fixture" }, 1),
    event("turn.started", "root", { turnId: "turn_preview" }, 2),
    event("message.created", "root", { messageId: "message_preview", role: "assistant", turnId: "turn_preview" }, 3),
    event("tool.call_updated", "root", { callId: "call_preview", status: "running", toolName: "bash", input: {} }, 4),
    event("tool.call_updated", "root", { callId: "call_preview", status: "running", toolName: "bash", input: { command: "pwd" } }, 5),
    event("message.part_added", "root", { messageId: "message_preview", part: {
      id: "part_preview", messageId: "message_preview", sessionId: "root", type: "tool_call", callId: "call_preview", toolName: "bash", input: { command: "pwd" }, status: "pending",
    } }, 6),
    event("tool.call_started", "root", { callId: "call_preview", turnId: "turn_preview", toolName: "bash", input: { command: "pwd" } }, 7),
    event("tool.call_updated", "root", { callId: "call_preview", status: "validating" }, 8),
    event("tool.call_updated", "root", { callId: "call_preview", status: "running" }, 9),
  ];
  let snapshot = baseSnapshot([]);
  for (const [index, row] of rows.entries()) {
    snapshot = appendRuntimeEvent(snapshot, row);
    expect(snapshot.events).toHaveLength(index + 1);
    expect(snapshot.truncated).not.toBe(true);
    expect(snapshot.warning).toBeUndefined();
    if (index === 4) expect(presentSession(snapshot).runtime.toolCalls.call_preview).toMatchObject({ input: { command: "pwd" }, toolName: "bash" });
  }
  expect(presentSession(snapshot).runtime.toolCalls.call_preview).toMatchObject({ turnId: "turn_preview", status: "running" });
});

test("unfinished preview cancellation survives bounded retention and snapshot reconnect", () => {
  const limits = { maxEvents: 6, maxBytes: 1_800 };
  let snapshot = baseSnapshot([]);
  for (let index = 1; index <= 250; index += 1) {
    snapshot = appendRuntimeEvent(snapshot, event("tool.call_updated", "root", {
      callId: "call_preview", status: "running", toolName: "bash", input: { command: `preview-${index}` },
    }, index), limits);
    expect(snapshot.events.length).toBeLessThanOrEqual(limits.maxEvents);
    expect(new TextEncoder().encode(JSON.stringify(snapshot.events)).byteLength).toBeLessThanOrEqual(limits.maxBytes);
    expect(presentSession(snapshot).runtime.toolCalls.call_preview?.input).toEqual({ command: `preview-${index}` });
  }
  expect(snapshot.warning).toContain("renderer budget");
  expect(snapshot.warning).not.toContain("causal anchor");
  // A new authoritative snapshot has no WeakMap state from the live window.
  snapshot = baseSnapshot(structuredClone(snapshot.events));
  const cancelled = event("tool.call_finished", "root", { callId: "call_preview", status: "cancelled", error: "provider_cancelled", synthetic: true }, 251);
  snapshot = appendRuntimeEvent(snapshot, cancelled, limits);
  snapshot = appendRuntimeEvent(snapshot, cancelled, limits);
  expect(snapshot.events.filter((row) => row.id === cancelled.id)).toHaveLength(1);
  expect(snapshot.warning).toBeUndefined();
  expect(presentSession(snapshot).runtime.toolCalls.call_preview).toMatchObject({ input: { command: "preview-250" }, status: "cancelled" });
});

test("orphaned tool events stay rejected without falsely reporting a capacity overflow", () => {
  const orphan = event("tool.call_updated", "root", { callId: "call_orphan", status: "running" }, 1);
  for (const base of [baseSnapshot([]), baseSnapshot([orphan])]) {
    const snapshot = appendRuntimeEvent(base, event("tool.output_delta", "root", { callId: "call_orphan", stream: "stdout", delta: "orphan" }, 2));
    expect(snapshot.events).toEqual([]);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.warning).toContain("causal anchor");
    expect(snapshot.warning).not.toContain("exceeded");
  }
  const started = event("tool.call_started", "root", { callId: "call_orphan", turnId: "turn_late", toolName: "bash", input: {} }, 3);
  let late = appendRuntimeEvent(baseSnapshot([]), orphan);
  late = appendRuntimeEvent(late, started);
  expect(late.events).toEqual([started]);
  expect(presentSession(late).runtime.toolCalls.call_orphan?.status).toBe("running");
});

test("a different session's preview does not admit a same-id live tool update", () => {
  const preview = event("tool.call_updated", "other", { callId: "shared_call", status: "running", toolName: "bash", input: {} }, 1);
  const orphan = event("tool.call_updated", "root", { callId: "shared_call", status: "waiting_for_approval" }, 2);
  const snapshot = appendRuntimeEvent(baseSnapshot([preview]), orphan);
  expect(snapshot.events).toEqual([preview]);
  expect(snapshot.warning).toContain("causal anchor");
  expect(snapshot.warning).not.toContain("exceeded");
});

test("a complete oversized tool preview is rejected by capacity, not by a missing anchor", () => {
  const preview = event("tool.call_updated", "root", { callId: "call_large", status: "running", toolName: "bash", input: { command: "😀".repeat(2_000) } }, 1);
  const snapshot = appendRuntimeEvent(baseSnapshot([]), preview, { maxEvents: 20, maxBytes: 1_000 });
  expect(snapshot.events).toEqual([]);
  expect(snapshot.warning).toContain("1000-byte");
  expect(snapshot.warning).not.toContain("causal anchor");
});

test("tiny live budgets retain message anchors with the newest visible delta", () => {
  const created = event("message.created", "root", { messageId: "message_live", role: "assistant" }, 41);
  const part = event("message.part_added", "root", {
    messageId: "message_live",
    part: { id: "part_live", messageId: "message_live", sessionId: "root", type: "text", text: "" },
  }, 42);
  const delta = event("message.part_delta", "root", {
    messageId: "message_live",
    partId: "part_live",
    field: "text",
    delta: "visible tail",
  }, 43);
  const maxBytes = new TextEncoder().encode(JSON.stringify([created, part, delta])).byteLength;
  let snapshot = baseSnapshot([]);
  for (const row of [created, part, delta]) {
    snapshot = appendRuntimeEvent(snapshot, row, { maxEvents: 3, maxBytes });
  }
  expect(snapshot.events.map((row) => row.type)).toEqual([
    "message.created",
    "message.part_added",
    "message.part_delta",
  ]);
  expect(presentSession(snapshot).runtime.messages.message_live?.parts[0]).toMatchObject({ text: "visible tail" });
});

test("10k live deltas use bounded retained state and amortized closure passes", () => {
  const limits = { maxEvents: 200, maxBytes: 500_000 };
  const started = event("tool.call_started", "root", {
    turnId: "turn_live",
    callId: "call_live",
    toolName: "bash",
    input: {},
  }, 50);
  let snapshot = appendRuntimeEvent(baseSnapshot([]), started, limits);
  for (let index = 0; index < 10_000; index += 1) {
    snapshot = appendRuntimeEvent(snapshot, {
      ...event("tool.output_delta", "root", {
        callId: "call_live",
        stream: "stdout",
        delta: `${index}\n`,
        sequence: index,
      }, 51 + index),
      id: `event_delta_${index}`,
    }, limits);
  }
  const diagnostics = runtimeEventRetentionDiagnostics(snapshot);
  expect(diagnostics.retainedEvents).toBeLessThanOrEqual(limits.maxEvents);
  expect(diagnostics.bytes).toBeLessThanOrEqual(limits.maxBytes);
  expect(diagnostics.fullRetentionPasses).toBeLessThan(300);
  expect(snapshot.events.some((row) => row.type === "tool.call_started")).toBe(true);
  expect(snapshot.events.at(-1)?.id).toBe("event_delta_9999");
});

test("long streamed messages project incrementally and show one per-part omission marker through completion", () => {
  const turnStarted = event("turn.started", "root", { turnId: "turn_stream" }, 1);
  const created = event("message.created", "root", {
    turnId: "turn_stream",
    messageId: "message_stream",
    role: "assistant",
  }, 2);
  const streamedPart = event("message.part_added", "root", {
    messageId: "message_stream",
    part: {
      id: "part_stream",
      messageId: "message_stream",
      sessionId: "root",
      type: "text",
      text: "START|",
    },
  }, 3);
  const untouchedPart = event("message.part_added", "root", {
    messageId: "message_stream",
    part: {
      id: "part_untouched",
      messageId: "message_stream",
      sessionId: "root",
      type: "text",
      text: "UNCHANGED",
    },
  }, 4);
  let snapshot = baseSnapshot([]);
  for (const row of [turnStarted, created, streamedPart]) {
    snapshot = appendRuntimeEvent(snapshot, row);
  }
  for (let index = 0; index < 3_000; index += 1) {
    snapshot = appendRuntimeEvent(snapshot, {
      ...event("message.part_delta", "root", {
        messageId: "message_stream",
        partId: "part_stream",
        field: "text",
        delta: `${index}|`,
      }, 5 + index),
      id: `event_message_delta_${index}`,
    });
    presentSession(snapshot);
  }
  snapshot = appendRuntimeEvent(snapshot, {
    ...untouchedPart,
    id: "event_untouched_part_recent",
    time: 3_499,
  } as ChiliEvent);
  snapshot = appendRuntimeEvent(snapshot, {
    ...event("message.part_delta", "root", {
      messageId: "message_stream",
      partId: "part_untouched",
      field: "text",
      delta: "|TAIL",
    }, 3_500),
    id: "event_untouched_tail",
  });
  snapshot = appendRuntimeEvent(snapshot, {
    ...event("turn.completed", "root", { turnId: "turn_stream", status: "completed" }, 4_000),
    id: "event_turn_stream_completed",
  });

  const presentation = presentSession(snapshot);
  const message = presentation.runtime.messages.message_stream;
  const streamed = message?.parts.find((part) => part.id === "part_stream");
  const untouched = message?.parts.find((part) => part.id === "part_untouched");
  const streamedText = streamed?.type === "text" ? streamed.text : "";
  const untouchedText = untouched?.type === "text" ? untouched.text : "";
  const diagnostics = runtimeEventRetentionDiagnostics(snapshot);
  expect(streamedText).toStartWith("START|\n[Earlier message content omitted]\n");
  expect(streamedText).toEndWith("2999|");
  expect(streamedText.match(/Earlier message content omitted/g)).toHaveLength(1);
  expect(untouchedText).toBe("UNCHANGED|TAIL");
  expect(snapshot.omittedMessageParts).toEqual([{
    messageId: "message_stream",
    partId: "part_stream",
    field: "text",
  }]);
  expect(diagnostics.fullProjectionReplays).toBeLessThan(16);
  expect(diagnostics.incrementalProjectionUpdates).toBeGreaterThan(2_900);

  const authoritative = baseSnapshot([
    turnStarted,
    created,
    event("message.part_added", "root", {
      messageId: "message_stream",
      part: {
        id: "part_stream",
        messageId: "message_stream",
        sessionId: "root",
        type: "text",
        text: "START|complete authoritative content|2999|",
      },
    }, 3),
  ]);
  expect(presentSession(authoritative).runtime.messages.message_stream?.parts[0]).toMatchObject({
    text: "START|complete authoritative content|2999|",
  });
  expect(authoritative.omittedMessageParts).toBeUndefined();
});

test("incremental message projection does not mutate sibling snapshot branches", () => {
  const anchors = [
    event("message.created", "root", { messageId: "message_branch", role: "assistant" }, 1),
    event("message.part_added", "root", {
      messageId: "message_branch",
      part: {
        id: "part_branch",
        messageId: "message_branch",
        sessionId: "root",
        type: "text",
        text: "seed|",
      },
    }, 2),
  ];
  let base = baseSnapshot([]);
  for (const anchor of anchors) base = appendRuntimeEvent(base, anchor);
  const left = appendRuntimeEvent(base, {
    ...event("message.part_delta", "root", {
      messageId: "message_branch",
      partId: "part_branch",
      field: "text",
      delta: "left",
    }, 3),
    id: "event_branch_left",
  });
  const right = appendRuntimeEvent(base, {
    ...event("message.part_delta", "root", {
      messageId: "message_branch",
      partId: "part_branch",
      field: "text",
      delta: "right",
    }, 3),
    id: "event_branch_right",
  });
  expect(presentSession(left).runtime.messages.message_branch?.parts[0]).toMatchObject({ text: "seed|left" });
  expect(presentSession(right).runtime.messages.message_branch?.parts[0]).toMatchObject({ text: "seed|right" });
  expect(presentSession(base).runtime.messages.message_branch?.parts[0]).toMatchObject({ text: "seed|" });
});

test("shows an inline omission marker after the SDK drops the oldest of 81 tool deltas", () => {
  const started = event("tool.call_started", "root", {
    turnId: "turn_tool_81",
    callId: "call_tool_81",
    toolName: "bash",
    input: {},
  }, 1);
  let snapshot = appendRuntimeEvent(baseSnapshot([]), started);
  for (let index = 0; index < 81; index += 1) {
    snapshot = appendRuntimeEvent(snapshot, {
      ...event("tool.output_delta", "root", {
        callId: "call_tool_81",
        stream: "stdout",
        delta: `${index}|`,
        sequence: index,
      }, 2 + index),
      id: `event_tool_81_${index}`,
    });
  }
  const liveOutput = presentSession(snapshot).runtime.toolCalls.call_tool_81?.liveOutput;
  const visible = boundedToolLiveOutput(liveOutput);
  expect(liveOutput).toHaveLength(80);
  expect(liveOutput?.[0]).toMatchObject({ delta: "1|", truncated: true });
  expect(visible).toStartWith("[Earlier tool output omitted]\n");
  expect(visible).toEndWith("80|");
});

test("bounds active tool output by UTF-8 bytes and preserves its newest tail", () => {
  const output = boundedToolLiveOutput([
    { stream: "stdout", delta: `old-${"界".repeat(100)}` },
    { stream: "stderr", delta: "newest-😀" },
  ], 96);
  expect(output).toContain("Earlier tool output omitted");
  expect(output).toEndWith("newest-😀");
  expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(96);
  expect(boundedToolLiveOutput([{ delta: "complete", truncated: true }])).toContain("Earlier tool output omitted");
  expect(boundedToolLiveOutput([
    { stream: "stdout", delta: "building\n" },
    { stream: "stderr", delta: "warning\n" },
  ])).toBe("[stdout]\nbuilding\n[stderr]\nwarning\n");
  expect(visibleToolLiveOutput("final result", [{ stream: "stdout", delta: "duplicate" }])).toBeUndefined();
});

function baseSnapshot(
  events: ChiliEvent[],
  pendingInputs: UserInputRequest[] = [],
  pendingApprovals: RuntimePendingApprovalRequest[] = [],
): RuntimeSnapshot {
  return {
    sessionId: "root",
    events,
    agentTree: { nodes: [], agents: [], tasks: [], mailbox: [] },
    tasks: [],
    pendingApprovals,
    pendingInputs,
  };
}

function chatWithItems(
  items: ChatSessionView["items"],
  status: ChatSessionView["status"] = "idle",
): ChatSessionView {
  return {
    status,
    items,
    pendingApprovals: [],
    activeTools: [],
    generatedAt: new Date(0).toISOString(),
  };
}

function approval(id: string, sessionId: string, callId: string, createdAt: number): RuntimePendingApprovalRequest {
  return {
    id,
    sessionId: sessionId as never,
    callId,
    permission: "tool.bash",
    patterns: ["bun test"],
    createdAt,
  };
}

function event(type: string, sessionId: string, payload: unknown, time: number): ChiliEvent {
  return { id: `event_${time}`, type, sessionId, time, payload } as ChiliEvent;
}

function userInput(id: string): UserInputRequest {
  return {
    id,
    sessionId: "root",
    callId: "toolcall_live",
    createdAt: 1,
    questions: [{
      id: "editor",
      header: "Editor",
      question: "Which editor should Chili use?",
      options: [
        { label: "VS Code", description: "Use Visual Studio Code." },
        { label: "Zed", description: "Use Zed." },
      ],
    }],
  };
}
