import { expect, test } from "bun:test";
import type {
  AgentPath,
  ApprovalId,
  ChiliEvent,
  MessageId,
  PartId,
  RuntimeInputQueue,
  SessionId,
  TimestampMs,
  ToolCallId,
  ToolResultExecutionContext,
  TurnId,
} from "@chili/protocol";
import { HttpRuntimeClient } from "./client.js";
import {
  applyRuntimeEvent,
  chatSessionView,
  createRuntimeView,
  markRuntimeOutputGap,
  MAX_TOOL_OUTPUT_PREVIEW_BYTES,
  pendingApprovals,
  reduceRuntimeEvents,
  runtimeSessionAgents,
  sessionMessages,
  type ChatTranscriptItem,
} from "./projection.js";

test("projects one stable Agent identity from its session and input queue", () => {
  const parentSessionId = "session_parent" as SessionId;
  const agentId = "session_child" as SessionId;
  const metadata = {
    parentSessionId,
    name: "reviewer",
    path: "/root/reviewer" as AgentPath,
    policy: { allowedTools: ["read", "code"] },
  };
  const queue: RuntimeInputQueue = {
    sessionId: agentId, paused: true, revision: 2, pendingCount: 1, interruptedCount: 0,
    items: [{
      inputId: "input_2", submissionId: "submission_2", sessionId: agentId,
      mode: "queue", state: "pending", revision: 1, sequence: 2, text: "Check the patch",
      acceptedAt: 3, updatedAt: 3,
    }],
  };
  const view = reduceRuntimeEvents([
    { id: "parent", type: "session.created", time: 1 as TimestampMs, sessionId: parentSessionId, payload: { sessionId: parentSessionId, cwd: "/repo" } },
    { id: "child", type: "session.created", time: 2 as TimestampMs, sessionId: agentId, payload: { sessionId: agentId, cwd: "/repo", agent: metadata } },
    { id: "running", type: "session.status_changed", time: 3 as TimestampMs, sessionId: agentId, payload: { sessionId: agentId, status: "running" } },
    { id: "paused", type: "session.input_queue_changed", time: 4 as TimestampMs, sessionId: agentId, payload: queue },
    { id: "stale_queue", type: "session.input_queue_changed", time: 5 as TimestampMs, sessionId: agentId, payload: { ...queue, paused: false, revision: 1 } },
  ]);
  metadata.policy.allowedTools.push("bash");
  queue.items[0]!.text = "mutated";
  expect(runtimeSessionAgents(view, parentSessionId)).toEqual([{
    ...metadata, policy: { allowedTools: ["read", "code"] },
    agentId, sessionId: agentId, state: "paused", status: "running", lifecycle: "active",
    inputQueue: { ...queue, items: [{ ...queue.items[0]!, text: "Check the patch" }] }, updatedAt: 4,
  }]);
  expect(runtimeSessionAgents(view, agentId)).toEqual([]);
  expect(runtimeSessionAgents(view)).toHaveLength(1);
  const result = runtimeSessionAgents(view)[0]!;
  result.inputQueue!.items[0]!.text = "mutated selector";
  expect(view.sessions[agentId]?.inputQueue?.items[0]?.text).toBe("Check the patch");
  applyRuntimeEvent(view, { id: "resumed", type: "session.input_queue_changed", time: 6 as TimestampMs, sessionId: agentId, payload: { ...queue, paused: false, revision: 3 } });
  expect(runtimeSessionAgents(view)[0]?.state).toBe("running");
  applyRuntimeEvent(view, { id: "idle", type: "session.status_changed", time: 7 as TimestampMs, sessionId: agentId, payload: { sessionId: agentId, status: "idle" } });
  expect(runtimeSessionAgents(view)[0]).toMatchObject({ agentId, state: "idle", status: "idle" });
});

test("rejects mismatched Agent identity and input queue session envelopes", () => {
  const sessionId = "session_good" as SessionId;
  const foreignId = "session_foreign" as SessionId;
  const view = reduceRuntimeEvents([
    { id: "foreign_creation", type: "session.created", time: 1 as TimestampMs, sessionId, payload: { sessionId: foreignId, cwd: "/repo", agent: { parentSessionId: sessionId, name: "foreign", path: "/root/foreign" as AgentPath, policy: {} } } },
    { id: "foreign_queue", type: "session.input_queue_changed", time: 2 as TimestampMs, sessionId, payload: { sessionId: foreignId, paused: true, revision: 1, pendingCount: 0, interruptedCount: 0, items: [] } },
  ]);
  expect(view.sessionIds).toEqual([]);
  expect(runtimeSessionAgents(view)).toEqual([]);
});

test("stores external identifiers in null-prototype indexes", () => {
  const view = createRuntimeView();
  const indexes = [
    view.sessions,
    view.turnStatuses,
    view.turnStartedAt,
    view.messages,
    view.toolCalls,
    view.approvals,
    view.modelMetadataByTurn,
    view.partIndex,
    view.transcriptOrder,
  ];
  for (const index of indexes) expect(Object.getPrototypeOf(index)).toBeNull();

  const safeSessionId = "session_prototype_index_test" as SessionId;
  applyRuntimeEvent(view, {
    id: "event_prototype_index_safe_session",
    type: "session.created",
    time: 1 as TimestampMs,
    sessionId: safeSessionId,
    payload: { sessionId: safeSessionId, cwd: "/safe" },
  });

  for (const [offset, identifier] of ["__proto__", "constructor", "prototype"].entries()) {
    const time = (offset * 10 + 2) as TimestampMs;
    const sessionId = identifier as SessionId;
    const messageId = identifier as MessageId;
    const callId = identifier as ToolCallId;
    const approvalId = identifier as ApprovalId;

    applyRuntimeEvent(view, {
      id: `event_prototype_index_session_${offset}`,
      type: "session.created",
      time,
      sessionId,
      payload: { sessionId, cwd: `/session-${offset}` },
    });
    applyRuntimeEvent(view, {
      id: `event_prototype_index_message_${offset}`,
      type: "message.created",
      time,
      sessionId: safeSessionId,
      payload: { messageId, role: "assistant" },
    });
    applyRuntimeEvent(view, {
      id: `event_prototype_index_tool_${offset}`,
      type: "tool.call_started",
      time,
      sessionId: safeSessionId,
      payload: { turnId: `turn_prototype_index_${offset}` as TurnId, callId, toolName: "read", input: {} },
    });
    applyRuntimeEvent(view, {
      id: `event_prototype_index_approval_${offset}`,
      type: "approval.requested",
      time,
      sessionId: safeSessionId,
      payload: { approvalId, callId, permission: "read", patterns: [] },
    });

    expect(Object.hasOwn(view.sessions, identifier)).toBe(true);
    expect(Object.hasOwn(view.messages, identifier)).toBe(true);
    expect(Object.hasOwn(view.toolCalls, identifier)).toBe(true);
    expect(Object.hasOwn(view.approvals, identifier)).toBe(true);
    expect(view.sessions[identifier]?.id).toBe(sessionId);
    expect(view.messages[identifier]?.id).toBe(messageId);
    expect(view.toolCalls[identifier]?.id).toBe(callId);
    expect(view.approvals[identifier]?.id).toBe(approvalId);
  }

  expect((Object.prototype as { cwd?: unknown }).cwd).toBeUndefined();
  expect((Object as unknown as { cwd?: unknown }).cwd).toBeUndefined();
});

test("repairs JSON-roundtripped indexes before applying unsafe identifiers", () => {
  const roundtripped = JSON.parse(JSON.stringify(createRuntimeView())) as ReturnType<typeof createRuntimeView>;
  expect(Object.getPrototypeOf(roundtripped.sessions)).toBe(Object.prototype);

  const sessionId = "__proto__" as SessionId;
  applyRuntimeEvent(roundtripped, {
    id: "event_roundtrip_prototype_session",
    type: "session.created",
    time: 1 as TimestampMs,
    sessionId,
    payload: { sessionId, cwd: "/roundtrip-safe" },
  });

  for (const index of [
    roundtripped.sessions,
    roundtripped.turnStatuses,
    roundtripped.turnStartedAt,
    roundtripped.messages,
    roundtripped.toolCalls,
    roundtripped.approvals,
    roundtripped.modelMetadataByTurn,
    roundtripped.partIndex,
  ]) {
    expect(Object.getPrototypeOf(index)).toBeNull();
  }
  expect(Object.hasOwn(roundtripped.sessions, "__proto__")).toBe(true);
  expect(roundtripped.sessions["__proto__"]?.cwd).toBe("/roundtrip-safe");
  expect((Object.prototype as { cwd?: unknown }).cwd).toBeUndefined();
});

test("projects the selected failed session status reason", () => {
  const sessionId = "session_status_reason" as SessionId;
  const otherSessionId = "session_status_reason_other" as SessionId;
  const view = reduceRuntimeEvents([
    {
      id: "event_status_reason_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_status_reason_failed",
      type: "session.status_changed",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId, status: "failed", reason: "provider stream disconnected" },
    },
    {
      id: "event_status_reason_other_session",
      type: "session.created",
      time: 3 as TimestampMs,
      sessionId: otherSessionId,
      payload: { sessionId: otherSessionId, cwd: "/other" },
    },
    {
      id: "event_status_reason_other_failed",
      type: "session.status_changed",
      time: 4 as TimestampMs,
      sessionId: otherSessionId,
      payload: { sessionId: otherSessionId, status: "failed", reason: "unrelated failure" },
    },
  ], createRuntimeView());

  const chat = chatSessionView(view, { sessionId });

  expect(chat.status).toBe("failed");
  expect(chat.statusReason).toBe("provider stream disconnected");
  expect(chat.statusEventId).toBe("event_status_reason_failed");
});

test("keeps explicit session status canonical and applies only matching terminal turn fallback", () => {
  const sessionId = "session_status_reason_transitions" as SessionId;
  const firstTurnId = "turn_status_reason_transitions_first" as TurnId;
  const secondTurnId = "turn_status_reason_transitions_second" as TurnId;
  const view = reduceRuntimeEvents([
    {
      id: "event_status_reason_transition_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_status_reason_transition_failed",
      type: "session.status_changed",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId, status: "failed", reason: "old failure" },
    },
  ], createRuntimeView());

  expect(chatSessionView(view, { sessionId }).statusReason).toBe("old failure");

  reduceRuntimeEvents([{
    id: "event_status_reason_transition_running",
    type: "session.status_changed",
    time: 3 as TimestampMs,
    sessionId,
    payload: { sessionId, status: "running" },
  }], view);
  expect(chatSessionView(view, { sessionId })).toMatchObject({
    status: "running",
    statusEventId: "event_status_reason_transition_running",
  });
  expect(chatSessionView(view, { sessionId }).statusReason).toBeUndefined();

  reduceRuntimeEvents([
    {
      id: "event_status_reason_transition_prompt",
      type: "session.status_changed",
      time: 4 as TimestampMs,
      sessionId,
      payload: { sessionId, status: "running", reason: "prompt_submitted" },
    },
    {
      id: "event_status_reason_transition_turn_started",
      type: "turn.started",
      time: 5 as TimestampMs,
      sessionId,
      payload: { turnId: firstTurnId },
    },
  ], view);
  expect(chatSessionView(view, { sessionId })).toMatchObject({
    status: "running",
    statusReason: "prompt_submitted",
  });

  reduceRuntimeEvents([
    {
      id: "event_status_reason_transition_first_completed",
      type: "turn.completed",
      time: 6 as TimestampMs,
      sessionId,
      payload: { turnId: firstTurnId, status: "completed" },
    },
    {
      id: "event_status_reason_transition_second_started",
      type: "turn.started",
      time: 7 as TimestampMs,
      sessionId,
      payload: { turnId: secondTurnId },
    },
  ], view);
  expect(chatSessionView(view, { sessionId })).toMatchObject({
    status: "running",
    statusReason: "prompt_submitted",
  });

  reduceRuntimeEvents([
    {
      id: "event_status_reason_transition_streaming",
      type: "session.status_changed",
      time: 8 as TimestampMs,
      sessionId,
      payload: { sessionId, status: "running", turnId: secondTurnId, reason: "streaming" },
    },
    {
      id: "event_status_reason_transition_stale_turn_failed",
      type: "turn.completed",
      time: 9 as TimestampMs,
      sessionId,
      payload: { turnId: firstTurnId, status: "failed" },
    },
  ], view);
  expect(chatSessionView(view, { sessionId })).toMatchObject({
    status: "running",
    statusReason: "streaming",
  });

  reduceRuntimeEvents([{
    id: "event_status_reason_transition_current_turn_failed",
    type: "turn.completed",
    time: 10 as TimestampMs,
    sessionId,
    payload: { turnId: secondTurnId, status: "failed" },
  }], view);
  const failedBeforeReason = chatSessionView(view, { sessionId });
  expect(failedBeforeReason.status).toBe("failed");
  expect(failedBeforeReason.statusReason).toBeUndefined();
  expect(failedBeforeReason.statusEventId).toBe("event_status_reason_transition_current_turn_failed");

  reduceRuntimeEvents([{
    id: "event_status_reason_transition_failed_reason",
    type: "session.status_changed",
    time: 11 as TimestampMs,
    sessionId,
    payload: { sessionId, status: "failed", turnId: secondTurnId, reason: "fresh failure" },
  }], view);
  expect(chatSessionView(view, { sessionId }).statusReason).toBe("fresh failure");
});

test("falls back to turn lifecycle until an explicit session status is seen", () => {
  const sessionId = "session_legacy_lifecycle" as SessionId;
  const turnId = "turn_legacy_lifecycle" as TurnId;
  const view = reduceRuntimeEvents([{
    id: "event_legacy_session",
    type: "session.created",
    time: 1 as TimestampMs,
    sessionId,
    payload: { sessionId, cwd: "/repo" },
  }], createRuntimeView());

  reduceRuntimeEvents([{
    id: "event_legacy_turn_started",
    type: "turn.started",
    time: 2 as TimestampMs,
    sessionId,
    payload: { turnId },
  }], view);
  expect(chatSessionView(view, { sessionId }).status).toBe("running");

  reduceRuntimeEvents([{
    id: "event_legacy_turn_completed",
    type: "turn.completed",
    time: 3 as TimestampMs,
    sessionId,
    payload: { turnId, status: "completed" },
  }], view);
  expect(chatSessionView(view, { sessionId }).status).toBe("idle");
});

test("projects authoritative session cwd and transient retry details", () => {
  const sessionId = "session_retry_projection" as SessionId;
  const turnId = "turn_retry_projection" as TurnId;
  const view = reduceRuntimeEvents([
    {
      id: "event_retry_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/stored/workspace" },
    },
    {
      id: "event_retry_running",
      type: "session.status_changed",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId, status: "running", turnId },
    },
    {
      id: "event_retry_scheduled",
      type: "turn.retry_scheduled",
      time: 3 as TimestampMs,
      sessionId,
      payload: { turnId, attempt: 2, delayMs: 500, reason: "socket closed" },
    },
  ], createRuntimeView());

  expect(chatSessionView(view, { sessionId })).toMatchObject({
    cwd: "/stored/workspace",
    status: "running",
    retry: { turnId, attempt: 2, delayMs: 500, reason: "socket closed", scheduledAt: 3 },
  });

  reduceRuntimeEvents([{
    id: "event_retry_resumed",
    type: "turn.model_metadata",
    time: 4 as TimestampMs,
    sessionId,
    payload: { turnId, provider: "test", model: "retry-ok" },
  }], view);
  expect(chatSessionView(view, { sessionId }).retry).toBeUndefined();
});

test("does not clear retry state for activity from a different turn", () => {
  const sessionId = "session_retry_turn_scope" as SessionId;
  const retryTurnId = "turn_retry_turn_scope" as TurnId;
  const otherTurnId = "turn_retry_turn_scope_other" as TurnId;
  const otherMessageId = "message_retry_turn_scope_other" as MessageId;
  const otherPartId = "part_retry_turn_scope_other" as PartId;
  const retryMessageId = "message_retry_turn_scope_current" as MessageId;
  const view = reduceRuntimeEvents([
    {
      id: "event_retry_turn_scope_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_retry_turn_scope_running",
      type: "session.status_changed",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId, status: "running", turnId: retryTurnId },
    },
    {
      id: "event_retry_turn_scope_scheduled",
      type: "turn.retry_scheduled",
      time: 3 as TimestampMs,
      sessionId,
      payload: { turnId: retryTurnId, attempt: 3, delayMs: 750, reason: "retry current turn" },
    },
    {
      id: "event_retry_turn_scope_other_message",
      type: "message.created",
      time: 4 as TimestampMs,
      sessionId,
      payload: { messageId: otherMessageId, role: "assistant", turnId: otherTurnId },
    },
    {
      id: "event_retry_turn_scope_other_part",
      type: "message.part_added",
      time: 5 as TimestampMs,
      sessionId,
      payload: {
        messageId: otherMessageId,
        part: { id: otherPartId, messageId: otherMessageId, sessionId, type: "text", text: "other turn" },
      },
    },
    {
      id: "event_retry_turn_scope_other_delta",
      type: "message.part_delta",
      time: 6 as TimestampMs,
      sessionId,
      payload: { messageId: otherMessageId, partId: otherPartId, field: "text", delta: " output" },
    },
    {
      id: "event_retry_turn_scope_other_metadata",
      type: "turn.model_metadata",
      time: 7 as TimestampMs,
      sessionId,
      payload: { turnId: otherTurnId, provider: "test", model: "other-turn" },
    },
    {
      id: "event_retry_turn_scope_other_tool",
      type: "tool.call_started",
      time: 8 as TimestampMs,
      sessionId,
      payload: {
        turnId: otherTurnId,
        callId: "toolcall_retry_turn_scope_other" as ToolCallId,
        toolName: "read",
        input: { path: "README.md" },
      },
    },
  ], createRuntimeView());

  expect(chatSessionView(view, { sessionId }).retry).toMatchObject({ turnId: retryTurnId });

  reduceRuntimeEvents([
    {
      id: "event_retry_turn_scope_current_message",
      type: "message.created",
      time: 9 as TimestampMs,
      sessionId,
      payload: { messageId: retryMessageId, role: "assistant", turnId: retryTurnId },
    },
    {
      id: "event_retry_turn_scope_current_part",
      type: "message.part_added",
      time: 10 as TimestampMs,
      sessionId,
      payload: {
        messageId: retryMessageId,
        part: {
          id: "part_retry_turn_scope_current" as PartId,
          messageId: retryMessageId,
          sessionId,
          type: "text",
          text: "retry succeeded",
        },
      },
    },
  ], view);
  expect(chatSessionView(view, { sessionId }).retry).toBeUndefined();
});

test("projects exact assistant text phases without classifying missing metadata", () => {
  const sessionId = "session_project_phases" as SessionId;
  const messageId = "message_project_phases" as MessageId;
  const commentaryPartId = "part_project_commentary" as PartId;
  const finalPartId = "part_project_final" as PartId;
  const unclassifiedPartId = "part_project_unclassified" as PartId;
  const view = reduceRuntimeEvents([
    {
      id: "event_project_phase_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_project_phase_message",
      type: "message.created",
      time: 2 as TimestampMs,
      sessionId,
      payload: { messageId, role: "assistant" },
    },
    {
      id: "event_project_phase_commentary",
      type: "message.part_added",
      time: 3 as TimestampMs,
      sessionId,
      payload: {
        messageId,
        part: {
          id: commentaryPartId,
          messageId,
          sessionId,
          type: "text",
          text: "Checking.",
          phase: "commentary",
        },
      },
    },
    {
      id: "event_project_phase_final",
      type: "message.part_added",
      time: 4 as TimestampMs,
      sessionId,
      payload: {
        messageId,
        part: {
          id: finalPartId,
          messageId,
          sessionId,
          type: "text",
          text: "Done.",
          phase: "final_answer",
        },
      },
    },
    {
      id: "event_project_phase_unclassified",
      type: "message.part_added",
      time: 5 as TimestampMs,
      sessionId,
      payload: {
        messageId,
        part: {
          id: unclassifiedPartId,
          messageId,
          sessionId,
          type: "text",
          text: "Legacy provider text.",
        },
      },
    },
  ], createRuntimeView());

  const assistant = chatSessionView(view, { sessionId }).items.find(
    (item) => item.kind === "message" && item.role === "assistant",
  );

  expect(assistant?.kind === "message" ? assistant.parts : []).toEqual([
    { type: "text", id: commentaryPartId, text: "Checking.", phase: "commentary" },
    { type: "text", id: finalPartId, text: "Done.", phase: "final_answer" },
    { type: "text", id: unclassifiedPartId, text: "Legacy provider text." },
  ]);
});

test("projects only controlled tool execution context into message and tool rows", () => {
  const sessionId = "session_execution_context" as SessionId;
  const turnId = "turn_execution_context" as TurnId;
  const messageId = "message_execution_context" as MessageId;
  const partId = "part_execution_context" as PartId;
  const callId = "toolcall_execution_context" as ToolCallId;
  const executionContext = {
    sandbox: "none",
    executionMode: "unsandboxed",
    exitCode: 0,
    timedOut: false,
    aborted: false,
    signal: null,
    internalMetadata: "must not leak",
  } satisfies ToolResultExecutionContext & { internalMetadata: string };
  const view = reduceRuntimeEvents([
    {
      id: "event_execution_context_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_execution_context_message",
      type: "message.created",
      time: 2 as TimestampMs,
      sessionId,
      payload: { messageId, role: "assistant", turnId },
    },
    {
      id: "event_execution_context_tool",
      type: "tool.call_started",
      time: 3 as TimestampMs,
      sessionId,
      payload: { turnId, callId, toolName: "bash", input: { command: "echo ok" } },
    },
    {
      id: "event_execution_context_result",
      type: "message.part_added",
      time: 4 as TimestampMs,
      sessionId,
      payload: {
        messageId,
        part: {
          id: partId,
          messageId,
          sessionId,
          type: "tool_result",
          callId,
          output: "ok",
          executionContext,
        },
      },
    },
    {
      id: "event_execution_context_finished",
      type: "tool.call_finished",
      time: 5 as TimestampMs,
      sessionId,
      payload: { callId, status: "completed", output: "ok" },
    },
  ], createRuntimeView());

  const chat = chatSessionView(view, { sessionId, generatedAt: "now" });
  const message = chat.items.find((item) => item.kind === "message");
  const result = message?.kind === "message"
    ? message.parts.find((part) => part.type === "tool_result")
    : undefined;
  const tool = chat.items.find((item) => item.kind === "tool");
  const expected = {
    sandbox: "none",
    executionMode: "unsandboxed",
    exitCode: 0,
    timedOut: false,
    aborted: false,
    signal: null,
  } satisfies ToolResultExecutionContext;

  expect(result?.type === "tool_result" ? result.executionContext : undefined).toEqual(expected);
  expect(tool?.kind === "tool" ? tool.executionContext : undefined).toEqual(expected);
  expect(tool).toMatchObject({ kind: "tool", status: "completed", displayStatus: "succeeded" });
  expect(result?.type === "tool_result" ? result.executionContext : undefined).not.toHaveProperty("internalMetadata");
  expect(tool?.kind === "tool" ? tool.executionContext : undefined).not.toHaveProperty("internalMetadata");
});

test("marks completed tools failed when process execution context reports failure", () => {
  const failures: Array<[string, ToolResultExecutionContext]> = [
    ["exit", { exitCode: 2, timedOut: false, aborted: false, signal: null }],
    ["timeout", { exitCode: null, timedOut: true, aborted: false, signal: null }],
    ["abort", { exitCode: null, timedOut: false, aborted: true, signal: null }],
    ["signal", { exitCode: null, timedOut: false, aborted: false, signal: "SIGTERM" }],
  ];

  for (const [suffix, executionContext] of failures) {
    const sessionId = `session_execution_failed_${suffix}` as SessionId;
    const turnId = `turn_execution_failed_${suffix}` as TurnId;
    const messageId = `message_execution_failed_${suffix}` as MessageId;
    const callId = `toolcall_execution_failed_${suffix}` as ToolCallId;
    const events: ChiliEvent[] = [
      {
        id: `event_execution_failed_session_${suffix}`,
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: `event_execution_failed_message_${suffix}`,
        type: "message.created",
        time: 2 as TimestampMs,
        sessionId,
        payload: { messageId, role: "assistant", turnId },
      },
      {
        id: `event_execution_failed_tool_${suffix}`,
        type: "tool.call_started",
        time: 3 as TimestampMs,
        sessionId,
        payload: { turnId, callId, toolName: "bash", input: { command: "false" } },
      },
      {
        id: `event_execution_failed_result_${suffix}`,
        type: "message.part_added",
        time: 4 as TimestampMs,
        sessionId,
        payload: {
          messageId,
          part: {
            id: `part_execution_failed_${suffix}` as PartId,
            messageId,
            sessionId,
            type: "tool_result",
            callId,
            output: "process failed",
            executionContext,
          },
        },
      },
      {
        id: `event_execution_failed_finished_${suffix}`,
        type: "tool.call_finished",
        time: 5 as TimestampMs,
        sessionId,
        payload: { callId, status: "completed", output: "process failed" },
      },
    ];
    const tool = chatSessionView(reduceRuntimeEvents(events, createRuntimeView()), { sessionId })
      .items.find((item) => item.kind === "tool");

    expect(tool).toMatchObject({ kind: "tool", status: "completed", displayStatus: "failed" });
  }
});

test("replays session, message, tool, and approval events into a runtime view", () => {
  const sessionId = "session_test" as SessionId;
  const turnId = "turn_test" as TurnId;
  const messageId = "msg_test" as MessageId;
  const partId = "part_test" as PartId;
  const callId = "toolcall_test" as ToolCallId;

  const events: ChiliEvent[] = [
    {
      id: "event_1",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_2",
      type: "message.created",
      time: 2 as TimestampMs,
      sessionId,
      payload: { messageId, role: "assistant" },
    },
    {
      id: "event_3",
      type: "message.part_added",
      time: 3 as TimestampMs,
      sessionId,
      payload: {
        messageId,
        part: { id: partId, messageId, sessionId, type: "text", text: "hello" },
      },
    },
    {
      id: "event_4",
      type: "message.part_delta",
      time: 4 as TimestampMs,
      sessionId,
      payload: { messageId, partId, field: "text", delta: " world" },
    },
    {
      id: "event_5",
      type: "tool.call_started",
      time: 5 as TimestampMs,
      sessionId,
      payload: { turnId, callId, toolName: "read", input: { filePath: "README.md" } },
    },
    {
      id: "event_6",
      type: "tool.call_updated",
      time: 6 as TimestampMs,
      sessionId,
      payload: { callId, status: "waiting_for_approval" },
    },
    {
      id: "event_7",
      type: "approval.requested",
      time: 7 as TimestampMs,
      sessionId,
      payload: {
        approvalId: "approval_test" as never,
        callId,
        permission: "tool.read",
        patterns: ["README.md"],
        maxApprovalScope: "once",
        metadata: { reason: "Policy asks for README reads", source: "project .chili/config.toml" },
      },
    },
    {
      id: "event_8",
      type: "approval.resolved",
      time: 8 as TimestampMs,
      sessionId,
      payload: { approvalId: "approval_test" as never, decision: "allow_once" },
    },
    {
      id: "event_9",
      type: "tool.call_finished",
      time: 9 as TimestampMs,
      sessionId,
      payload: { callId, status: "completed", output: "ok" },
    },
    {
      id: "event_10",
      type: "turn.completed",
      time: 10 as TimestampMs,
      sessionId,
      payload: { turnId, status: "completed" },
    },
  ];

  const view = reduceRuntimeEvents(events, createRuntimeView());
  const [message] = sessionMessages(view, sessionId);

  expect(view.sessions[sessionId]?.cwd).toBe("/repo");
  expect(view.sessions[sessionId]?.status).toBe("idle");
  expect(message?.parts[0]?.type).toBe("text");
  expect(message?.parts[0]?.type === "text" ? message.parts[0].text : "").toBe("hello world");
  expect(view.toolCalls[callId]?.status).toBe("completed");
  expect(view.approvals.approval_test?.metadata).toEqual({
    reason: "Policy asks for README reads",
    source: "project .chili/config.toml",
  });
  expect(view.approvals.approval_test?.maxApprovalScope).toBe("once");
  expect(pendingApprovals(view, sessionId)).toHaveLength(0);
});

test("restores a waiting session to running only after all approvals clear and a tool resumes", () => {
  const sessionId = "session_resume_after_approval" as SessionId;
  const turnId = "turn_resume_after_approval" as TurnId;
  const firstCallId = "toolcall_resume_first" as ToolCallId;
  const secondCallId = "toolcall_resume_second" as ToolCallId;
  const firstApprovalId = "approval_resume_first" as ApprovalId;
  const secondApprovalId = "approval_resume_second" as ApprovalId;
  const waitingView = reduceRuntimeEvents([
    {
      id: "event_resume_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_resume_session_running",
      type: "session.status_changed",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId, status: "running" },
    },
    {
      id: "event_resume_first_started",
      type: "tool.call_started",
      time: 3 as TimestampMs,
      sessionId,
      payload: { turnId, callId: firstCallId, toolName: "read", input: { path: "first.ts" } },
    },
    {
      id: "event_resume_first_waiting",
      type: "tool.call_updated",
      time: 4 as TimestampMs,
      sessionId,
      payload: { callId: firstCallId, status: "waiting_for_approval" },
    },
    {
      id: "event_resume_first_approval",
      type: "approval.requested",
      time: 5 as TimestampMs,
      sessionId,
      payload: { approvalId: firstApprovalId, callId: firstCallId, permission: "tool.read", patterns: ["first.ts"] },
    },
    {
      id: "event_resume_second_started",
      type: "tool.call_started",
      time: 6 as TimestampMs,
      sessionId,
      payload: { turnId, callId: secondCallId, toolName: "read", input: { path: "second.ts" } },
    },
    {
      id: "event_resume_second_waiting",
      type: "tool.call_updated",
      time: 7 as TimestampMs,
      sessionId,
      payload: { callId: secondCallId, status: "waiting_for_approval" },
    },
    {
      id: "event_resume_second_approval",
      type: "approval.requested",
      time: 8 as TimestampMs,
      sessionId,
      payload: { approvalId: secondApprovalId, callId: secondCallId, permission: "tool.read", patterns: ["second.ts"] },
    },
  ], createRuntimeView());

  reduceRuntimeEvents([
    {
      id: "event_resume_first_resolved",
      type: "approval.resolved",
      time: 9 as TimestampMs,
      sessionId,
      payload: { approvalId: firstApprovalId, decision: "allow_once" },
    },
    {
      id: "event_resume_first_running",
      type: "tool.call_updated",
      time: 10 as TimestampMs,
      sessionId,
      payload: { callId: firstCallId, status: "running" },
    },
  ], waitingView);

  expect(waitingView.sessions[sessionId]?.status).toBe("running");
  expect(chatSessionView(waitingView, { sessionId }).status).toBe("waiting_for_approval");
  expect(pendingApprovals(waitingView, sessionId).map((approval) => approval.id)).toEqual([secondApprovalId]);

  reduceRuntimeEvents([
    {
      id: "event_resume_second_resolved",
      type: "approval.resolved",
      time: 11 as TimestampMs,
      sessionId,
      payload: { approvalId: secondApprovalId, decision: "allow_once" },
    },
    {
      id: "event_resume_second_running",
      type: "tool.call_updated",
      time: 12 as TimestampMs,
      sessionId,
      payload: { callId: secondCallId, status: "running" },
    },
  ], waitingView);

  expect(waitingView.sessions[sessionId]?.status).toBe("running");
  expect(chatSessionView(waitingView, { sessionId }).status).toBe("running");
  expect(pendingApprovals(waitingView, sessionId)).toEqual([]);
});

test("chat view hides output-free cancelled turns but keeps interrupted visible output", () => {
  const sessionId = "session_cancelled_chat" as SessionId;
  const emptyTurnId = "turn_cancelled_empty" as TurnId;
  const visibleTurnId = "turn_cancelled_visible" as TurnId;
  const emptyUserId = "msg_cancelled_empty_user" as MessageId;
  const emptyAssistantId = "msg_cancelled_empty_assistant" as MessageId;
  const visibleUserId = "msg_cancelled_visible_user" as MessageId;
  const visibleAssistantId = "msg_cancelled_visible_assistant" as MessageId;
  const events: ChiliEvent[] = [
    {
      id: "event_cancelled_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_cancelled_empty_started",
      type: "turn.started",
      time: 2 as TimestampMs,
      sessionId,
      payload: { turnId: emptyTurnId },
    },
    {
      id: "event_cancelled_empty_user",
      type: "message.created",
      time: 3 as TimestampMs,
      sessionId,
      payload: { messageId: emptyUserId, role: "user", turnId: emptyTurnId },
    },
    {
      id: "event_cancelled_empty_user_part",
      type: "message.part_added",
      time: 4 as TimestampMs,
      sessionId,
      payload: {
        messageId: emptyUserId,
        part: { id: "part_cancelled_empty_user" as PartId, messageId: emptyUserId, sessionId, type: "text", text: "hi" },
      },
    },
    {
      id: "event_cancelled_empty_assistant",
      type: "message.created",
      time: 5 as TimestampMs,
      sessionId,
      payload: { messageId: emptyAssistantId, role: "assistant", turnId: emptyTurnId },
    },
    {
      id: "event_cancelled_empty_reasoning",
      type: "message.part_added",
      time: 6 as TimestampMs,
      sessionId,
      payload: {
        messageId: emptyAssistantId,
        part: { id: "part_cancelled_empty_reasoning" as PartId, messageId: emptyAssistantId, sessionId, type: "reasoning", text: "Thinking" },
      },
    },
    {
      id: "event_cancelled_empty_completed",
      type: "turn.completed",
      time: 7 as TimestampMs,
      sessionId,
      payload: { turnId: emptyTurnId, status: "cancelled" },
    },
    {
      id: "event_cancelled_visible_started",
      type: "turn.started",
      time: 8 as TimestampMs,
      sessionId,
      payload: { turnId: visibleTurnId },
    },
    {
      id: "event_cancelled_visible_user",
      type: "message.created",
      time: 9 as TimestampMs,
      sessionId,
      payload: { messageId: visibleUserId, role: "user", turnId: visibleTurnId },
    },
    {
      id: "event_cancelled_visible_user_part",
      type: "message.part_added",
      time: 10 as TimestampMs,
      sessionId,
      payload: {
        messageId: visibleUserId,
        part: { id: "part_cancelled_visible_user" as PartId, messageId: visibleUserId, sessionId, type: "text", text: "explain" },
      },
    },
    {
      id: "event_cancelled_visible_assistant",
      type: "message.created",
      time: 11 as TimestampMs,
      sessionId,
      payload: { messageId: visibleAssistantId, role: "assistant", turnId: visibleTurnId },
    },
    {
      id: "event_cancelled_visible_assistant_part",
      type: "message.part_added",
      time: 12 as TimestampMs,
      sessionId,
      payload: {
        messageId: visibleAssistantId,
        part: { id: "part_cancelled_visible_assistant" as PartId, messageId: visibleAssistantId, sessionId, type: "text", text: "partial answer" },
      },
    },
    {
      id: "event_cancelled_visible_completed",
      type: "turn.completed",
      time: 13 as TimestampMs,
      sessionId,
      payload: { turnId: visibleTurnId, status: "cancelled" },
    },
  ];

  const view = reduceRuntimeEvents(events, createRuntimeView());
  const chat = chatSessionView(view, { sessionId });

  expect(view.turnStatuses).toMatchObject({
    [emptyTurnId]: "cancelled",
    [visibleTurnId]: "cancelled",
  });
  expect(sessionMessages(view, sessionId)).toHaveLength(4);
  expect(chat.items.map((item) => item.id)).toEqual([visibleUserId, visibleAssistantId]);
});

test("ignores session events with conflicting envelope and payload identities", () => {
  const sessionId = "session_identity_authority" as SessionId;
  const conflictingSessionId = "session_identity_conflict" as SessionId;
  const view = reduceRuntimeEvents([
    {
      id: "event_identity_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/trusted" },
    },
    {
      id: "event_identity_conflicting_session",
      type: "session.created",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId: conflictingSessionId, cwd: "/untrusted" },
    },
  ], createRuntimeView());

  applyRuntimeEvent(view, {
    id: "event_identity_missing_envelope",
    type: "session.created",
    time: 7 as TimestampMs,
    payload: { sessionId: conflictingSessionId, cwd: "/untrusted" },
  } as unknown as ChiliEvent);

  expect(view.sessions[sessionId]).toMatchObject({ cwd: "/trusted" });
  expect(view.sessions[conflictingSessionId]).toBeUndefined();
});

test("projects live tool input updates before the final assistant tool part", () => {
  const sessionId = "session_live_tool" as SessionId;
  const turnId = "turn_live_tool" as TurnId;
  const messageId = "msg_live_tool" as MessageId;
  const partId = "part_live_tool_call" as PartId;
  const callId = "toolcall_live" as ToolCallId;

  const view = reduceRuntimeEvents(
    [
      {
        id: "event_live_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: "event_live_assistant",
        type: "message.created",
        time: 2 as TimestampMs,
        sessionId,
        payload: { messageId, role: "assistant" },
      },
      {
        id: "event_live_tool_start",
        type: "tool.call_updated",
        time: 3 as TimestampMs,
        sessionId,
        payload: { callId, status: "running", toolName: "bash", input: {} },
      },
      {
        id: "event_live_tool_partial",
        type: "tool.call_updated",
        time: 4 as TimestampMs,
        sessionId,
        payload: { callId, status: "running", toolName: "bash", input: { command: "bun test" } },
      },
    ],
    createRuntimeView(),
  );

  const live = chatSessionView(view, { sessionId, generatedAt: "now" });
  const liveTools = live.items.filter((item): item is Extract<ChatTranscriptItem, { kind: "tool" }> => item.kind === "tool");
  const liveAssistant = live.items.find((item) => item.kind === "message");
  expect(liveTools).toHaveLength(1);
  expect(liveTools[0]).toMatchObject({
    id: callId,
    toolName: "bash",
    status: "running",
    displayStatus: "running",
    input: { command: "bun test" },
    inputSummary: { command: "bun test" },
  });
  expect(live.activeTools).toHaveLength(1);
  expect(liveAssistant?.kind === "message" ? liveAssistant.parts : []).toEqual([]);

  const completedView = reduceRuntimeEvents(
    [
      {
        id: "event_live_tool_final",
        type: "tool.call_updated",
        time: 5 as TimestampMs,
        sessionId,
        payload: { callId, status: "running", toolName: "bash", input: { command: "bun test --run" } },
      },
      {
        id: "event_live_tool_part",
        type: "message.part_added",
        time: 6 as TimestampMs,
        sessionId,
        payload: {
          messageId,
          part: {
            id: partId,
            messageId,
            sessionId,
            type: "tool_call",
            callId,
            toolName: "bash",
            input: { command: "bun test --run" },
            status: "pending",
          },
        },
      },
      {
        id: "event_live_tool_started",
        type: "tool.call_started",
        time: 7 as TimestampMs,
        sessionId,
        payload: { turnId, callId, toolName: "bash", input: { command: "bun test --run" } },
      },
      {
        id: "event_live_tool_finished",
        type: "tool.call_finished",
        time: 8 as TimestampMs,
        sessionId,
        payload: { callId, status: "completed", output: "ok" },
      },
    ],
    view,
  );
  const completed = chatSessionView(completedView, { sessionId, generatedAt: "now" });
  const completedTools = completed.items.filter((item): item is Extract<ChatTranscriptItem, { kind: "tool" }> => item.kind === "tool");
  const completedAssistant = completed.items.find((item) => item.kind === "message");

  expect(completedTools).toHaveLength(1);
  expect(completedTools[0]).toMatchObject({
    id: callId,
    status: "completed",
    displayStatus: "succeeded",
    input: { command: "bun test --run" },
    inputSummary: { command: "bun test --run" },
    output: "ok",
  });
  expect(completed.activeTools).toEqual([]);
  expect(completedAssistant?.kind === "message" ? completedAssistant.parts : []).toContainEqual(expect.objectContaining({ type: "tool_call", callId }));
});

test("projects live tool output deltas without duplicating final output", () => {
  const sessionId = "session_live_tool_output" as SessionId;
  const turnId = "turn_live_tool_output" as TurnId;
  const callId = "toolcall_live_output" as ToolCallId;

  const runningView = reduceRuntimeEvents(
    [
      {
        id: "event_live_output_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: "event_live_output_started",
        type: "tool.call_started",
        time: 2 as TimestampMs,
        sessionId,
        payload: { turnId, callId, toolName: "bash", input: { command: "bun test" } },
      },
      {
        id: "event_live_output_stdout",
        type: "tool.output_delta",
        time: 3 as TimestampMs,
        sessionId,
        payload: { callId, stream: "stdout", delta: "pass 1\n", bytes: 7, sequence: 1 },
      },
      {
        id: "event_live_output_stderr",
        type: "tool.output_delta",
        time: 4 as TimestampMs,
        sessionId,
        payload: { callId, stream: "stderr", delta: "warn\n", bytes: 5, sequence: 2 },
      },
    ],
    createRuntimeView(),
  );

  const running = chatSessionView(runningView, { sessionId, generatedAt: "now" });
  const runningTool = running.items.find((item): item is Extract<ChatTranscriptItem, { kind: "tool" }> => item.kind === "tool");
  expect(runningTool).toMatchObject({ id: callId, status: "running" });
  expect(runningTool?.output).toBeUndefined();
  expect(runningTool?.liveOutput).toEqual([
    expect.objectContaining({ stream: "stdout", delta: "pass 1\n", sequence: 1 }),
    expect.objectContaining({ stream: "stderr", delta: "warn\n", sequence: 2 }),
  ]);
  expect(running.activeTools).toHaveLength(1);
  expect(runningView.lastEventId).toBe("event_live_output_started");

  const finalOutput = "pass 1\n\n[stderr]\nwarn\n";
  const completedView = reduceRuntimeEvents(
    [
      {
        id: "event_live_output_finished",
        type: "tool.call_finished",
        time: 5 as TimestampMs,
        sessionId,
        payload: { callId, status: "completed", output: finalOutput },
      },
    ],
    runningView,
  );
  const completed = chatSessionView(completedView, { sessionId, generatedAt: "now" });
  const completedTool = completed.items.find((item): item is Extract<ChatTranscriptItem, { kind: "tool" }> => item.kind === "tool");
  expect(completedTool?.output).toBe(finalOutput);
  expect(completedTool?.liveOutput?.map((delta) => delta.delta).join("")).toBe("pass 1\nwarn\n");
  expect(completed.activeTools).toEqual([]);
});

test("projects chat session transcript rows from message, tool, and approval events", () => {
  const sessionId = "session_chat_view" as SessionId;
  const turnId = "turn_chat_view" as TurnId;
  const userMessageId = "msg_chat_user" as MessageId;
  const assistantMessageId = "msg_chat_assistant" as MessageId;
  const userPartId = "part_chat_user" as PartId;
  const reasoningPartId = "part_chat_reasoning" as PartId;
  const textPartId = "part_chat_text" as PartId;
  const callPartId = "part_chat_tool_call" as PartId;
  const callId = "toolcall_chat_view" as ToolCallId;
  const approvalId = "approval_chat_view" as ApprovalId;

  const pendingView = reduceRuntimeEvents(
    [
      {
        id: "event_chat_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: "event_chat_turn",
        type: "turn.started",
        time: 2 as TimestampMs,
        sessionId,
        payload: { turnId },
      },
      {
        id: "event_chat_user",
        type: "message.created",
        time: 3 as TimestampMs,
        sessionId,
        payload: { messageId: userMessageId, role: "user" },
      },
      {
        id: "event_chat_user_text",
        type: "message.part_added",
        time: 4 as TimestampMs,
        sessionId,
        payload: {
          messageId: userMessageId,
          part: { id: userPartId, messageId: userMessageId, sessionId, type: "text", text: "please test" },
        },
      },
      {
        id: "event_chat_assistant",
        type: "message.created",
        time: 5 as TimestampMs,
        sessionId,
        payload: { messageId: assistantMessageId, role: "assistant" },
      },
      {
        id: "event_chat_reasoning",
        type: "message.part_added",
        time: 6 as TimestampMs,
        sessionId,
        payload: {
          messageId: assistantMessageId,
          part: { id: reasoningPartId, messageId: assistantMessageId, sessionId, type: "reasoning", text: "thinking" },
        },
      },
      {
        id: "event_chat_reasoning_delta",
        type: "message.part_delta",
        time: 7 as TimestampMs,
        sessionId,
        payload: { messageId: assistantMessageId, partId: reasoningPartId, field: "text", delta: " through" },
      },
      {
        id: "event_chat_text",
        type: "message.part_added",
        time: 8 as TimestampMs,
        sessionId,
        payload: {
          messageId: assistantMessageId,
          part: { id: textPartId, messageId: assistantMessageId, sessionId, type: "text", text: "hello" },
        },
      },
      {
        id: "event_chat_text_delta",
        type: "message.part_delta",
        time: 9 as TimestampMs,
        sessionId,
        payload: { messageId: assistantMessageId, partId: textPartId, field: "text", delta: " world" },
      },
      {
        id: "event_chat_tool_part",
        type: "message.part_added",
        time: 10 as TimestampMs,
        sessionId,
        payload: {
          messageId: assistantMessageId,
          part: {
            id: callPartId,
            messageId: assistantMessageId,
            sessionId,
            type: "tool_call",
            callId,
            toolName: "bash",
            input: { command: "bun test" },
            status: "pending",
          },
        },
      },
      {
        id: "event_chat_tool_started",
        type: "tool.call_started",
        time: 11 as TimestampMs,
        sessionId,
        payload: { turnId, callId, toolName: "bash", input: { command: "bun test" } },
      },
      {
        id: "event_chat_tool_waiting",
        type: "tool.call_updated",
        time: 12 as TimestampMs,
        sessionId,
        payload: { callId, status: "waiting_for_approval" },
      },
      {
        id: "event_chat_approval",
        type: "approval.requested",
        time: 13 as TimestampMs,
        sessionId,
        payload: { approvalId, callId, permission: "tool.bash", patterns: ["bun test"] },
      },
    ],
    createRuntimeView(),
  );

  const pending = chatSessionView(pendingView, { sessionId, generatedAt: "now" });
  const blank = chatSessionView(pendingView, { requireSession: true, generatedAt: "now" });
  const assistant = pending.items.find((item) => item.kind === "message" && item.role === "assistant");
  const tool = pending.items.find((item) => item.kind === "tool");

  expect(blank.sessionId).toBeUndefined();
  expect(blank.items).toEqual([]);
  expect(pending.sessionId).toBe(sessionId);
  expect(pending.status).toBe("waiting_for_approval");
  expect(assistant?.kind === "message" ? assistant.parts : []).toContainEqual({ type: "reasoning", id: reasoningPartId, text: "thinking through" });
  expect(assistant?.kind === "message" ? assistant.parts : []).toContainEqual({ type: "text", id: textPartId, text: "hello world" });
  expect(tool).toMatchObject({
    kind: "tool",
    id: callId,
    toolName: "bash",
    status: "waiting_for_approval",
    displayStatus: "waiting_permission",
    waitingForApproval: true,
    approvalId,
    inputSummary: { command: "bun test" },
  });
  expect(pending.pendingApprovals).toEqual([
    expect.objectContaining({
      id: approvalId,
      status: "pending",
      permission: "tool.bash",
      toolName: "bash",
      toolInput: { command: "bun test" },
      inputSummary: expect.objectContaining({ command: "bun test" }),
    }),
  ]);

  const resolvedView = reduceRuntimeEvents(
    [
      {
        id: "event_chat_approval_done",
        type: "approval.resolved",
        time: 14 as TimestampMs,
        sessionId,
        payload: { approvalId, decision: "allow_once" },
      },
      {
        id: "event_chat_tool_finished",
        type: "tool.call_finished",
        time: 15 as TimestampMs,
        sessionId,
        payload: { callId, status: "completed", output: "ok" },
      },
      {
        id: "event_chat_done",
        type: "turn.completed",
        time: 16 as TimestampMs,
        sessionId,
        payload: { turnId, status: "completed" },
      },
    ],
    pendingView,
  );
  const resolved = chatSessionView(resolvedView, { sessionId });
  const resolvedApproval = resolved.items.find((item) => item.kind === "approval");
  const completedTool = resolved.items.find((item) => item.kind === "tool");

  expect(resolved.status).toBe("idle");
  expect(resolved.pendingApprovals).toHaveLength(0);
  expect(resolvedApproval).toMatchObject({ kind: "approval", id: approvalId, status: "resolved", decision: "allow_once" });
  expect(completedTool).toMatchObject({ kind: "tool", id: callId, status: "completed", displayStatus: "succeeded", output: "ok" });
});

test("preserves durable transcript order when event timestamps roll backwards", () => {
  const sessionId = "session_chat_rollback" as SessionId;
  const userMessageId = "message_chat_rollback_user" as MessageId;
  const assistantMessageId = "message_chat_rollback_assistant" as MessageId;
  const view = reduceRuntimeEvents([
    {
      id: "event_chat_rollback_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_chat_rollback_user",
      type: "message.created",
      time: 100 as TimestampMs,
      sessionId,
      payload: { messageId: userMessageId, role: "user" },
    },
    {
      id: "event_chat_rollback_user_part",
      type: "message.part_added",
      time: 101 as TimestampMs,
      sessionId,
      payload: {
        messageId: userMessageId,
        part: {
          id: "part_chat_rollback_user" as PartId,
          messageId: userMessageId,
          sessionId,
          type: "text",
          text: "first",
        },
      },
    },
    {
      id: "event_chat_rollback_assistant",
      type: "message.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { messageId: assistantMessageId, role: "assistant" },
    },
    {
      id: "event_chat_rollback_assistant_part",
      type: "message.part_added",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        messageId: assistantMessageId,
        part: {
          id: "part_chat_rollback_assistant" as PartId,
          messageId: assistantMessageId,
          sessionId,
          type: "text",
          text: "second",
        },
      },
    },
  ] as ChiliEvent[]);

  expect(chatSessionView(view, { sessionId }).items
    .filter((item) => item.kind === "message")
    .map((item) => String(item.id))).toEqual([
    String(userMessageId),
    String(assistantMessageId),
  ]);
});

test("marks the retained tool-output head when the 80-delta projection drops older output", () => {
  const sessionId = "session_tool_output_limit" as SessionId;
  const callId = "toolcall_output_limit" as ToolCallId;
  const view = createRuntimeView();
  applyRuntimeEvent(view, {
    id: "event_tool_output_limit_started",
    type: "tool.call_started",
    time: 1 as TimestampMs,
    sessionId,
    payload: {
      turnId: "turn_tool_output_limit" as TurnId,
      callId,
      toolName: "bash",
      input: {},
    },
  });
  for (let index = 0; index < 81; index += 1) {
    applyRuntimeEvent(view, {
      id: `event_tool_output_limit_${index}`,
      type: "tool.output_delta",
      time: (2 + index) as TimestampMs,
      sessionId,
      payload: { callId, stream: "stdout", delta: `${index}|`, sequence: index },
    });
  }

  expect(view.toolCalls[callId]?.liveOutput).toHaveLength(80);
  expect(view.toolCalls[callId]?.liveOutput?.[0]).toMatchObject({ delta: "1|", truncated: true });
  expect(view.toolCalls[callId]?.liveOutput?.at(-1)).toMatchObject({ delta: "80|" });
});

test("durable tool starts preserve earlier transient output and cannot revive finished calls", () => {
  const sessionId = "session_output_handoff" as SessionId;
  const callId = "call_output_handoff" as ToolCallId;
  const view = createRuntimeView();
  applyRuntimeEvent(view, {
    id: "early_output", type: "tool.output_delta", time: 3 as TimestampMs, sessionId,
    payload: { callId, stream: "stdout", delta: "early\n", sequence: 1 },
  });
  const start: ChiliEvent = {
    id: "durable_start", type: "tool.call_started", time: 2 as TimestampMs, sessionId,
    payload: { callId, turnId: "turn_output_handoff" as TurnId, toolName: "bash", input: { command: "echo early" } },
  };
  applyRuntimeEvent(view, start);
  expect(view.toolCalls[callId]).toMatchObject({
    status: "running", toolName: "bash", startedAt: 2, updatedAt: 3,
    liveOutput: [{ delta: "early\n", sequence: 1 }],
  });
  applyRuntimeEvent(view, {
    id: "durable_finish", type: "tool.call_finished", time: 4 as TimestampMs, sessionId,
    payload: { callId, status: "completed", output: "durable full output" },
  });
  applyRuntimeEvent(view, start);
  expect(view.toolCalls[callId]).toMatchObject({ status: "completed", updatedAt: 4, output: "durable full output" });
  expect(view.sessions[sessionId]?.toolCallIds).toEqual([callId]);
});

test("tool previews obey a UTF-8 byte budget even when reported bytes are inaccurate", () => {
  const callId = "call_output_bytes" as ToolCallId;
  const view = createRuntimeView();
  for (const [index, text] of ["old".repeat(10_000), "🌶".repeat(30_000)].entries()) {
    applyRuntimeEvent(view, {
      id: `large_output_${index}`, type: "tool.output_delta", time: index as TimestampMs,
      payload: { callId, stream: "stdout", delta: text, bytes: 1, sequence: index + 1 },
    });
  }
  const preview = view.toolCalls[callId]!.liveOutput!;
  const retainedText = preview.map((delta) => delta.delta).join("");
  expect(new TextEncoder().encode(retainedText).byteLength).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_PREVIEW_BYTES);
  expect(retainedText).toBe("🌶".repeat(MAX_TOOL_OUTPUT_PREVIEW_BYTES / 4));
  expect(preview[0]?.truncated).toBe(true);
  const finalOutput = "final ".repeat(30_000);
  applyRuntimeEvent(view, {
    id: "large_output_finished", type: "tool.call_finished", time: 3 as TimestampMs,
    payload: { callId, status: "completed", output: finalOutput },
  });
  expect(view.toolCalls[callId]?.output).toBe(finalOutput);
});

test("tool previews bound the sum of many individually small UTF-8 chunks", () => {
  const callId = "call_output_sum" as ToolCallId;
  const view = createRuntimeView();
  for (let index = 0; index < 40; index += 1) {
    applyRuntimeEvent(view, {
      id: `sum_output_${index}`, type: "tool.output_delta", time: index as TimestampMs,
      payload: { callId, stream: "stdout", delta: "界".repeat(1_000), sequence: index },
    });
  }
  const preview = view.toolCalls[callId]!.liveOutput!;
  expect(preview).toHaveLength(Math.floor(MAX_TOOL_OUTPUT_PREVIEW_BYTES / 3_000));
  expect(preview[0]?.truncated).toBe(true);
  expect(preview.at(-1)?.sequence).toBe(39);
});

test("disconnect marks active previews, including empty ones, without changing final results or durable cursors", () => {
  const view = createRuntimeView();
  const runningId = "call_output_gap" as ToolCallId;
  const completedId = "call_output_gap_completed" as ToolCallId;
  for (const callId of [runningId, completedId]) {
    applyRuntimeEvent(view, {
      id: `start_${callId}`, type: "tool.call_started", time: 1 as TimestampMs,
      payload: { callId, turnId: "turn_output_gap" as TurnId, toolName: "bash", input: {} },
    });
  }
  applyRuntimeEvent(view, {
    id: "gap_completed", type: "tool.call_finished", time: 2 as TimestampMs,
    payload: { callId: completedId, status: "completed", output: "durable result" },
  });
  markRuntimeOutputGap(view);
  markRuntimeOutputGap(view);
  expect(view.toolCalls[runningId]?.liveOutput).toEqual([
    { stream: "stdout", delta: "", time: 1, truncated: true, gapBefore: true },
  ]);
  expect(view.toolCalls[completedId]?.liveOutput).toBeUndefined();
  expect(view.lastEventId).toBe("gap_completed");
  applyRuntimeEvent(view, {
    id: "gap_resumed", type: "tool.output_delta", time: 3 as TimestampMs,
    payload: { callId: runningId, stream: "stderr", delta: "after gap\n", sequence: 5 },
  });
  expect(view.toolCalls[runningId]?.liveOutput?.some((entry) => entry.gapBefore)).toBe(true);
  expect(view.toolCalls[runningId]?.liveOutput?.at(-1)?.delta).toBe("after gap\n");
});

test("temporary output sequence gaps remain visible and late duplicate chunks are ignored", () => {
  const callId = "call_output_sequence_gap" as ToolCallId;
  const view = createRuntimeView();
  for (const sequence of [1, 3, 2, 3]) {
    applyRuntimeEvent(view, {
      id: `sequence_output_${sequence}`, type: "tool.output_delta", time: sequence as TimestampMs,
      payload: { callId, stream: "stdout", delta: `chunk ${sequence}\n`, sequence },
    });
  }
  expect(view.toolCalls[callId]?.liveOutput).toEqual([
    { stream: "stdout", delta: "chunk 1\n", time: 1, sequence: 1 },
    { stream: "stdout", delta: "chunk 3\n", time: 3, sequence: 3, truncated: true, gapBefore: true },
  ]);
});

test("projects latest model metadata and stable usage summaries for chat sessions", () => {
  const sessionId = "session_model_metadata" as SessionId;
  const firstTurnId = "turn_model_metadata_first" as TurnId;
  const secondTurnId = "turn_model_metadata_second" as TurnId;

  const view = reduceRuntimeEvents(
    [
      {
        id: "event_metadata_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: "event_metadata_first_initial",
        type: "turn.model_metadata",
        time: 2 as TimestampMs,
        sessionId,
        payload: {
          turnId: firstTurnId,
          provider: "minimax",
          model: "MiniMax-M2.7",
          contextWindowTokens: 204800,
          maxOutputTokens: 131072,
        },
      },
      {
        id: "event_metadata_first_update",
        type: "turn.model_metadata",
        time: 3 as TimestampMs,
        sessionId,
        payload: {
          turnId: firstTurnId,
          responseId: "response_first",
          usage: { inputTokens: 70, outputTokens: 50, totalTokens: 120 },
        },
      },
      {
        id: "event_metadata_first_final",
        type: "turn.model_metadata",
        time: 4 as TimestampMs,
        sessionId,
        payload: {
          turnId: firstTurnId,
          usage: { inputTokens: 75, outputTokens: 55, totalTokens: 130 },
        },
      },
      {
        id: "event_metadata_second_initial",
        type: "turn.model_metadata",
        time: 5 as TimestampMs,
        sessionId,
        payload: {
          turnId: secondTurnId,
          provider: "deepseek",
          model: "deepseek-v4-pro",
          contextWindowTokens: 1048576,
          maxOutputTokens: 393216,
        },
      },
      {
        id: "event_metadata_second_update",
        type: "turn.model_metadata",
        time: 6 as TimestampMs,
        sessionId,
        payload: {
          turnId: secondTurnId,
          responseId: "response_second",
          usage: { inputTokens: 10, outputTokens: 15, cacheReadInputTokens: 2 },
        },
      },
    ],
    createRuntimeView(),
  );

  const chat = chatSessionView(view, { sessionId });

  expect(chat.latestModelMetadata).toMatchObject({
    turnId: secondTurnId,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    responseId: "response_second",
    contextWindowTokens: 1048576,
    maxOutputTokens: 393216,
  });
  expect(view.modelMetadataByTurn[firstTurnId]).toMatchObject({
    provider: "minimax",
    model: "MiniMax-M2.7",
    responseId: "response_first",
    contextWindowTokens: 204800,
    maxOutputTokens: 131072,
    usage: { inputTokens: 75, outputTokens: 55, totalTokens: 130 },
  });
  expect(chat.usageSummary).toMatchObject({
    inputTokens: 85,
    outputTokens: 70,
    cacheReadInputTokens: 2,
    totalTokens: 157,
  });
});

test("projects model metadata without optional model limits", () => {
  const sessionId = "session_model_metadata_limits" as SessionId;
  const turnId = "turn_model_metadata_limits" as TurnId;

  const view = reduceRuntimeEvents(
    [
      {
        id: "event_metadata_limits_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: "event_metadata_limits",
        type: "turn.model_metadata",
        time: 2 as TimestampMs,
        sessionId,
        payload: {
          turnId,
          provider: "custom",
          model: "unknown",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      },
    ],
    createRuntimeView(),
  );

  const chat = chatSessionView(view, { sessionId });

  expect(chat.latestModelMetadata).toMatchObject({
    turnId,
    provider: "custom",
    model: "unknown",
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  expect(chat.latestModelMetadata?.contextWindowTokens).toBeUndefined();
  expect(chat.latestModelMetadata?.maxOutputTokens).toBeUndefined();
});

test("projects tool-specific approval summaries for chat TUI", () => {
  const sessionId = "session_approval_summaries" as SessionId;
  const turnId = "turn_approval_summaries" as TurnId;
  const bashCallId = "toolcall_summary_bash" as ToolCallId;
  const editCallId = "toolcall_summary_edit" as ToolCallId;
  const grepCallId = "toolcall_summary_grep" as ToolCallId;
  const patchCallId = "toolcall_summary_patch" as ToolCallId;
  const bashApprovalId = "approval_summary_bash" as ApprovalId;
  const editApprovalId = "approval_summary_edit" as ApprovalId;
  const grepApprovalId = "approval_summary_grep" as ApprovalId;
  const patchApprovalId = "approval_summary_patch" as ApprovalId;

  const view = reduceRuntimeEvents(
    [
      {
        id: "event_summary_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: "/repo" },
      },
      ...toolApprovalEvents({
        time: 2,
        sessionId,
        turnId,
        callId: bashCallId,
        approvalId: bashApprovalId,
        toolName: "bash",
        input: { command: "rm -rf build && bun test" },
        permission: "tool.bash",
        patterns: ["rm -rf build && bun test"],
      }),
      ...toolApprovalEvents({
        time: 5,
        sessionId,
        turnId,
        callId: editCallId,
        approvalId: editApprovalId,
        toolName: "edit",
        input: { filePath: "apps/tui/src/ChatShellApp.tsx", oldString: "old", newString: "new" },
        permission: "edit",
        patterns: ["apps/tui/src/ChatShellApp.tsx"],
      }),
      ...toolApprovalEvents({
        time: 8,
        sessionId,
        turnId,
        callId: grepCallId,
        approvalId: grepApprovalId,
        toolName: "grep",
        input: { pattern: "waiting_for_approval", path: "packages/sdk/src" },
        permission: "grep",
        patterns: ["packages/sdk/src"],
      }),
      ...toolApprovalEvents({
        time: 11,
        sessionId,
        turnId,
        callId: patchCallId,
        approvalId: patchApprovalId,
        toolName: "apply_patch",
        input: { operations: [{ type: "replace", path: "apps/tui/src/chat/MessageList.tsx", oldText: "a", newText: "b" }] },
        permission: "edit",
        patterns: ["apps/tui/src/chat/MessageList.tsx"],
      }),
    ],
    createRuntimeView(),
  );

  const chat = chatSessionView(view, { sessionId });
  const approval = (id: ApprovalId) => chat.pendingApprovals.find((row) => row.id === id);
  const tool = (id: ToolCallId) => chat.activeTools.find((row) => row.id === id);

  expect(tool(bashCallId)).toMatchObject({ displayStatus: "waiting_permission", waitingForApproval: true, inputSummary: { command: "rm -rf build && bun test" } });
  expect(approval(bashApprovalId)).toMatchObject({ toolName: "bash", toolInput: { command: "rm -rf build && bun test" }, inputSummary: { command: "rm -rf build && bun test" } });
  expect(approval(editApprovalId)).toMatchObject({
    toolName: "edit",
    inputSummary: expect.objectContaining({
      path: "apps/tui/src/ChatShellApp.tsx",
      diffSummary: expect.stringContaining("replace"),
    }),
  });
  expect(approval(grepApprovalId)).toMatchObject({ toolName: "grep", inputSummary: { pattern: "waiting_for_approval", scope: "packages/sdk/src" } });
  expect(approval(patchApprovalId)).toMatchObject({
    toolName: "apply_patch",
    inputSummary: expect.objectContaining({
      path: "apps/tui/src/chat/MessageList.tsx",
      diffSummary: expect.stringContaining("replace apps/tui/src/chat/MessageList.tsx"),
    }),
  });
});

test("client can cancel chat commands without serializing AbortSignal", async () => {
  const sessionId = "session_sdk_abort" as SessionId;
  const controller = new AbortController();
  const records: { url: string; body: unknown; signalled: boolean }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    records.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signalled: init?.signal === controller.signal,
    });
    const body = url.endsWith("/sessions")
      ? ({ sessionId })
      : url.endsWith("/prompt_async")
        ? ({ status: "accepted", sessionId })
        : url.endsWith("/interrupt")
          ? ({ interrupted: true })
          : ({ resolved: true });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new HttpRuntimeClient({ baseUrl: "http://runtime.test/api", fetch: fetchImpl });

  await client.createSession({ cwd: "/repo", signal: controller.signal });
  await client.submitPromptAsync({
    sessionId,
    text: "hello",
    cwd: "/repo",
    skillMentions: [{ name: "reviewer", path: "/repo/.chili/skills/reviewer/SKILL.md" }],
    signal: controller.signal,
  });
  await client.interruptSession({ sessionId, reason: "stop", signal: controller.signal });
  await client.approveApproval({ approvalId: "approval_sdk_abort" as ApprovalId, signal: controller.signal });
  await client.rejectApproval({ approvalId: "approval_sdk_abort" as ApprovalId, feedback: "no", signal: controller.signal });

  expect(records).toEqual([
    {
      url: "http://runtime.test/api/sessions",
      body: { cwd: "/repo" },
      signalled: true,
    },
    {
      url: "http://runtime.test/api/sessions/session_sdk_abort/prompt_async",
      body: {
        text: "hello",
        cwd: "/repo",
        skillMentions: [{ name: "reviewer", path: "/repo/.chili/skills/reviewer/SKILL.md" }],
      },
      signalled: true,
    },
    {
      url: "http://runtime.test/api/sessions/session_sdk_abort/interrupt",
      body: { reason: "stop" },
      signalled: true,
    },
    {
      url: "http://runtime.test/api/approvals/approval_sdk_abort/resolve",
      body: { decision: "allow_once" },
      signalled: true,
    },
    {
      url: "http://runtime.test/api/approvals/approval_sdk_abort/resolve",
      body: { decision: "deny", feedback: "no" },
      signalled: true,
    },
  ]);
});

test("client sends model control requests and prompt overrides", async () => {
  const sessionId = "session_sdk_model" as SessionId;
  const records: { url: string; method: string | undefined; body: unknown }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    records.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const body = url.endsWith("/models")
      ? [{
          provider: "codex-api",
          model: "gpt-5.5",
          connectionLabel: "Third-party API",
          authSource: "environment",
          endpoint: "https://gateway.example",
        }]
      : url.endsWith("/commands") || url.endsWith("/commands/reload")
        ? ({
            roots: [{
              id: "session",
              name: "session",
              path: "/session",
              title: "Session",
              description: "Session controls",
              group: "session",
              source: "builtin",
              argumentMode: "none",
              argumentHint: "",
              selectionMode: "drilldown",
              concurrency: "allow",
              hidden: false,
              enabled: true,
              executionTarget: "client",
              children: [{
                id: "session.rename",
                name: "rename",
                path: "/session rename",
                title: "Rename session",
                description: "Rename the active session",
                group: "session",
                source: "builtin",
                argumentMode: "required",
                argumentHint: "<title>",
                selectionMode: "execute",
                concurrency: "allow",
                hidden: false,
                enabled: true,
                executionTarget: "client",
                children: [],
              }],
            }],
            diagnostics: [],
          })
        : url.endsWith("/command")
          ? ({ status: "completed", turns: [], finishReason: "stop" })
        : url.endsWith("/command_async")
          ? ({ status: "accepted", sessionId })
      : url.endsWith("/prompt_async")
        ? ({ status: "accepted", sessionId })
        : ({ sessionId, models: [], availableReasoningLevels: ["off", "high"] });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new HttpRuntimeClient({ baseUrl: "http://runtime.test/api", fetch: fetchImpl });

  expect(() => client.listCommands({ sessionId: "" as SessionId })).toThrow(
    "sessionId must be a non-empty string when provided",
  );
  expect(() => client.reloadCommands({ sessionId: "   " as SessionId })).toThrow(
    "sessionId must be a non-empty string when provided",
  );
  expect(() => client.listCommands({ sessionId: "session\ninvalid" as SessionId })).toThrow(
    "sessionId must be valid text",
  );
  expect(() => client.reloadCommands({ sessionId: "x".repeat(513) as SessionId })).toThrow(
    "sessionId must not exceed 512 characters",
  );

  const models = await client.listModels();
  await client.getModelConfig({ sessionId });
  await client.setModel({ sessionId, modelSelection: { provider: "openai-codex", model: "gpt-5.5" } });
  await client.setReasoning({ sessionId, reasoningLevel: "high" });
  const commands = await client.listCommands({ sessionId });
  const reloadedCommands = await client.reloadCommands({ sessionId });
  await client.submitPromptAsync({
    sessionId,
    text: "hello",
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
    reasoningLevel: "xhigh",
  });
  await client.submitCommand({
    sessionId,
    commandId: "prompt.project.joke",
    args: "synchronous",
  });
  await client.submitCommandAsync({
    sessionId,
    commandId: "prompt.project.joke",
    args: "typescript",
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
    reasoningLevel: "high",
  });

  expect(models).toEqual([{
    provider: "codex-api",
    model: "gpt-5.5",
    connectionLabel: "Third-party API",
    authSource: "environment",
    endpoint: "https://gateway.example/",
  }]);
  expect(commands.roots[0]?.children[0]?.id).toBe("session.rename");
  expect(reloadedCommands).toEqual(commands);

  expect(records).toEqual([
    {
      url: "http://runtime.test/api/models",
      method: "GET",
      body: undefined,
    },
    {
      url: "http://runtime.test/api/sessions/session_sdk_model/model",
      method: "GET",
      body: undefined,
    },
    {
      url: "http://runtime.test/api/sessions/session_sdk_model/model",
      method: "POST",
      body: { modelSelection: { provider: "openai-codex", model: "gpt-5.5" } },
    },
    {
      url: "http://runtime.test/api/sessions/session_sdk_model/reasoning",
      method: "POST",
      body: { reasoningLevel: "high" },
    },
    {
      url: "http://runtime.test/api/sessions/session_sdk_model/commands",
      method: "GET",
      body: undefined,
    },
    {
      url: "http://runtime.test/api/sessions/session_sdk_model/commands/reload",
      method: "POST",
      body: {},
    },
    {
      url: "http://runtime.test/api/sessions/session_sdk_model/prompt_async",
      method: "POST",
      body: {
        text: "hello",
        modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
        reasoningLevel: "xhigh",
      },
    },
    {
      url: "http://runtime.test/api/sessions/session_sdk_model/command",
      method: "POST",
      body: {
        commandId: "prompt.project.joke",
        args: "synchronous",
      },
    },
    {
      url: "http://runtime.test/api/sessions/session_sdk_model/command_async",
      method: "POST",
      body: {
        commandId: "prompt.project.joke",
        args: "typescript",
        modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
        reasoningLevel: "high",
      },
    },
  ]);
});

test("client approval command wrappers map product actions onto resolve calls", async () => {
  const approvalId = "approval_sdk_wrapper" as ApprovalId;
  const records: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    records.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify({ resolved: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new HttpRuntimeClient({ baseUrl: "http://runtime.test/api", fetch: fetchImpl });

  await client.approveApproval({ approvalId });
  await client.approveApproval({ approvalId, scope: "session" });
  await client.approveApproval({ approvalId, scope: "persistent", feedback: "trusted" });
  await client.rejectApproval({ approvalId, feedback: "needs review" });
  expect(() => client.approveApproval({ approvalId, scope: "forever" as never })).toThrow("approval scope must be one of once, session, persistent");

  expect(records).toEqual([
    {
      url: "http://runtime.test/api/approvals/approval_sdk_wrapper/resolve",
      body: { decision: "allow_once" },
    },
    {
      url: "http://runtime.test/api/approvals/approval_sdk_wrapper/resolve",
      body: { decision: "allow_session" },
    },
    {
      url: "http://runtime.test/api/approvals/approval_sdk_wrapper/resolve",
      body: { decision: "allow_always", feedback: "trusted" },
    },
    {
      url: "http://runtime.test/api/approvals/approval_sdk_wrapper/resolve",
      body: { decision: "deny", feedback: "needs review" },
    },
  ]);
});

function toolApprovalEvents(input: {
  time: number;
  sessionId: SessionId;
  turnId: TurnId;
  callId: ToolCallId;
  approvalId: ApprovalId;
  toolName: string;
  input: unknown;
  permission: string;
  patterns: string[];
}): ChiliEvent[] {
  return [
    {
      id: `event_${input.callId}_started`,
      type: "tool.call_started",
      time: input.time as TimestampMs,
      sessionId: input.sessionId,
      payload: { turnId: input.turnId, callId: input.callId, toolName: input.toolName, input: input.input },
    },
    {
      id: `event_${input.callId}_waiting`,
      type: "tool.call_updated",
      time: (input.time + 1) as TimestampMs,
      sessionId: input.sessionId,
      payload: { callId: input.callId, status: "waiting_for_approval" },
    },
    {
      id: `event_${input.callId}_approval`,
      type: "approval.requested",
      time: (input.time + 2) as TimestampMs,
      sessionId: input.sessionId,
      payload: { approvalId: input.approvalId, callId: input.callId, permission: input.permission, patterns: input.patterns },
    },
  ];
}
