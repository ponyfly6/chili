import { expect, test } from "bun:test";
import type {
  AgentPath,
  AgentRunId,
  ApprovalId,
  ChiliEvent,
  MessageId,
  PartId,
  SessionId,
  TaskId,
  TeamId,
  TeamRunSummaryCounts,
  TimestampMs,
  ToolCallId,
  ToolResultExecutionContext,
  TurnId,
} from "@chili/protocol";
import {
  HttpRuntimeClient,
  type RuntimeAgentTaskRecord,
  type RuntimeLocalSubagentTaskRecord,
  type RuntimeTeamExecutionRunSummary,
  type RuntimeTeamMergeResult,
  type RuntimeTeamTaskDispatchResult,
  type RuntimeTeamTaskReconcileResult,
  type RuntimeTeamTaskRecord,
  type RuntimeTeamTaskSyncResult,
  type RuntimeTeamSnapshot,
} from "./client.js";
import { applyRuntimeEvent, chatAgentBatches, chatSessionView, createRuntimeView, pendingApprovals, reduceRuntimeEvents, runtimeAgentsSnapshot, runtimeDelegationStatus, sessionMessages, teamLiveCockpit, teamLiveView, type ChatTranscriptItem } from "./projection.js";

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
  expect(chatSessionView(view, { sessionId })).toMatchObject({ status: "running" });
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

test("projects and clears persistent goals by session", () => {
  const sessionId = "session_goal_projection" as SessionId;
  const view = reduceRuntimeEvents([
    {
      id: "event_goal_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_goal_updated",
      type: "goal.updated",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        reason: "set",
        goal: {
          sessionId,
          objective: "finish goal projection",
          status: "active",
          tokenBudget: 50_000,
          tokensUsed: 1_200,
          timeUsedSeconds: 7,
          createdAt: 2 as TimestampMs,
          updatedAt: 2 as TimestampMs,
        },
      },
    },
  ], createRuntimeView());

  expect(chatSessionView(view, { sessionId }).goal).toMatchObject({
    objective: "finish goal projection",
    status: "active",
    tokensUsed: 1_200,
  });

  applyRuntimeEvent(view, {
    id: "event_goal_cleared",
    type: "goal.cleared",
    time: 3 as TimestampMs,
    sessionId,
    payload: { sessionId },
  });
  expect(chatSessionView(view, { sessionId }).goal).toBeUndefined();
});

test("ignores session and goal events with conflicting envelope and payload identities", () => {
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
    {
      id: "event_identity_goal",
      type: "goal.updated",
      time: 3 as TimestampMs,
      sessionId,
      payload: {
        goal: {
          sessionId,
          objective: "trusted goal",
          status: "active",
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 3 as TimestampMs,
          updatedAt: 3 as TimestampMs,
        },
      },
    },
    {
      id: "event_identity_conflicting_goal",
      type: "goal.updated",
      time: 4 as TimestampMs,
      sessionId,
      payload: {
        goal: {
          sessionId: conflictingSessionId,
          objective: "untrusted goal",
          status: "active",
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 4 as TimestampMs,
          updatedAt: 4 as TimestampMs,
        },
      },
    },
    {
      id: "event_identity_conflicting_clear",
      type: "goal.cleared",
      time: 5 as TimestampMs,
      sessionId,
      payload: { sessionId: conflictingSessionId },
    },
  ], createRuntimeView());

  applyRuntimeEvent(view, {
    id: "event_identity_missing_goal",
    type: "goal.updated",
    time: 6 as TimestampMs,
    sessionId,
    payload: {},
  } as unknown as ChiliEvent);
  applyRuntimeEvent(view, {
    id: "event_identity_missing_envelope",
    type: "session.created",
    time: 7 as TimestampMs,
    payload: { sessionId: conflictingSessionId, cwd: "/untrusted" },
  } as unknown as ChiliEvent);

  expect(view.sessions[sessionId]).toMatchObject({ cwd: "/trusted" });
  expect(view.sessions[conflictingSessionId]).toBeUndefined();
  expect(view.goalsBySession[sessionId]).toMatchObject({ objective: "trusted goal", sessionId });
  expect(view.goalsBySession[conflictingSessionId]).toBeUndefined();
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

test("keeps parent execution idle while an ad-hoc child agent is running", () => {
  const sessionId = "session_parent_idle_child_running" as SessionId;
  const childSessionId = "session_child_running" as SessionId;
  const taskId = "task_child_running" as TaskId;
  const runId = "agent_child_running" as AgentRunId;
  const path = "/root/child-running" as AgentPath;
  const callId = "tool_child_running" as ToolCallId;
  const view = reduceRuntimeEvents([
    {
      id: "event_parent_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_delegation_policy",
      type: "session.delegation_changed",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId, policy: "proactive" },
    },
    {
      id: "event_agent_task",
      type: "agent.task_created",
      time: 3 as TimestampMs,
      sessionId,
      payload: {
        taskId,
        path,
        parentPath: "/root" as AgentPath,
        parentSessionId: sessionId,
        childSessionId,
        taskName: "inspect child state",
        cwd: "/repo",
        prompt: "Inspect the child state.",
        mode: "background",
      },
    },
    {
      id: "event_agent_spawn",
      type: "agent.spawned",
      time: 4 as TimestampMs,
      sessionId,
      payload: {
        runId,
        taskId,
        path,
        parentPath: "/root" as AgentPath,
        parentSessionId: sessionId,
        childSessionId,
        taskName: "inspect child state",
        mode: "background",
        generation: 1,
      },
    },
    {
      id: "event_child_session",
      type: "session.created",
      time: 5 as TimestampMs,
      sessionId: childSessionId,
      payload: { sessionId: childSessionId, cwd: "/repo" },
    },
    {
      id: "event_child_running",
      type: "session.status_changed",
      time: 6 as TimestampMs,
      sessionId: childSessionId,
      payload: { sessionId: childSessionId, status: "running" },
    },
    {
      id: "event_child_tool",
      type: "tool.call_started",
      time: 7 as TimestampMs,
      sessionId: childSessionId,
      payload: { turnId: "turn_child_running" as TurnId, callId, toolName: "read_file", input: { path: "README.md" } },
    },
    {
      id: "event_parent_idle",
      type: "session.status_changed",
      time: 8 as TimestampMs,
      sessionId,
      payload: { sessionId, status: "idle" },
    },
  ], createRuntimeView());

  const status = runtimeDelegationStatus(view, { sessionId, generatedAt: "now" });

  expect(status.parent).toMatchObject({ sessionId, status: "idle", active: false });
  expect(status.delegation).toEqual({ supported: true, observed: true, policy: "proactive", source: "session" });
  expect(status.agents.counts).toEqual({
    total: 1,
    pending: 0,
    running: 1,
    active: 1,
    completed: 0,
    incomplete: 0,
    failed: 0,
    cancelled: 0,
  });
  expect(status.agents.active[0]).toMatchObject({
    taskId,
    runId,
    status: "running",
    activity: { kind: "tool", label: "read_file", status: "running", updatedAt: 7 },
  });
  expect(status.team).toEqual({ count: 0, activeCount: 0 });
});

test("projects the last agent batch with one incomplete and four failed tasks", () => {
  const sessionId = "session_partial_agent_batch" as SessionId;
  const callId = "tool_partial_agent_batch" as ToolCallId;
  const batchId = "batch_partial_agent_batch";
  const taskStatuses = ["incomplete", "failed", "failed", "failed", "failed"] as const;
  const taskIds = taskStatuses.map((_, index) => `task_partial_${index}` as TaskId);
  const taskEvents = taskStatuses.flatMap((status, index): ChiliEvent[] => {
    const taskId = taskIds[index] as TaskId;
    const path = `/root/partial-${index}` as AgentPath;
    return [
      {
        id: `event_partial_task_${index}`,
        type: "agent.task_created",
        time: (10 + index * 3) as TimestampMs,
        sessionId,
        payload: {
          taskId,
          path,
          parentPath: "/root" as AgentPath,
          parentSessionId: sessionId,
          childSessionId: `session_partial_${index}` as SessionId,
          taskName: `partial slice ${index}`,
          cwd: "/repo",
          prompt: `Inspect slice ${index}`,
          mode: "background",
          sourceCallId: callId,
          batchId,
          batchIndex: index,
          expectedBatchSize: taskStatuses.length,
          completionPolicy: "notify",
          maxConcurrency: 5,
        },
      },
      {
        id: `event_partial_spawn_${index}`,
        type: "agent.spawned",
        time: (11 + index * 3) as TimestampMs,
        sessionId,
        payload: {
          runId: `agent_partial_${index}` as AgentRunId,
          taskId,
          path,
          parentPath: "/root" as AgentPath,
          parentSessionId: sessionId,
          childSessionId: `session_partial_${index}` as SessionId,
          taskName: `partial slice ${index}`,
          mode: "background",
          generation: 1,
          sourceCallId: callId,
          batchId,
          batchIndex: index,
          expectedBatchSize: taskStatuses.length,
          completionPolicy: "notify",
          maxConcurrency: 5,
        },
      },
      {
        id: `event_partial_terminal_${index}`,
        type: "agent.task_completed",
        time: (12 + index * 3) as TimestampMs,
        sessionId,
        payload: {
          taskId,
          path,
          runId: `agent_partial_${index}` as AgentRunId,
          status,
          generation: 1,
          ...(status === "incomplete" ? { summary: "evidence missing" } : { error: `worker ${index} failed` }),
        },
      },
    ];
  });
  const view = reduceRuntimeEvents([
    {
      id: "event_partial_parent",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_partial_batch_tool",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        turnId: "turn_partial_batch" as TurnId,
        callId,
        toolName: "task_batch",
        input: { tasks: taskStatuses.map((_, index) => ({ description: `slice ${index}`, prompt: "inspect" })) },
      },
    },
    ...taskEvents,
    {
      id: "event_partial_batch_finished",
      type: "tool.call_finished",
      time: 40 as TimestampMs,
      sessionId,
      payload: { callId, status: "completed", output: JSON.stringify({ tasks: taskIds.map((taskId) => ({ task_id: taskId })) }) },
    },
    {
      id: "event_partial_parent_idle",
      type: "session.status_changed",
      time: 41 as TimestampMs,
      sessionId,
      payload: { sessionId, status: "idle" },
    },
  ], createRuntimeView());

  const status = runtimeDelegationStatus(view, { sessionId, generatedAt: "now" });

  expect(status.parent).toMatchObject({ status: "idle", active: false });
  expect(status.agents.counts).toEqual({
    total: 5,
    pending: 0,
    running: 0,
    active: 0,
    completed: 0,
    incomplete: 1,
    failed: 4,
    cancelled: 0,
  });
  expect(status.lastBatch).toMatchObject({
    callId,
    batchId,
    taskIds,
    expected: 5,
    untracked: 0,
    total: 5,
    active: 0,
    incomplete: 1,
    failed: 4,
    mixed: true,
    partial: false,
    status: "mixed",
    completionPolicy: "notify",
    maxConcurrency: 5,
  });
});

test("keeps the newest batch selected while an older batch finishes late", () => {
  const sessionId = "session_latest_batch" as SessionId;
  const oldCallId = "tool_old_batch" as ToolCallId;
  const newCallId = "tool_new_batch" as ToolCallId;
  const oldTaskId = "task_old_batch" as TaskId;
  const view = reduceRuntimeEvents([
    {
      id: "event_latest_batch_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_old_batch_started",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_old_batch" as TurnId, callId: oldCallId, toolName: "task_batch", input: { tasks: [{}] } },
    },
    agentTaskCreatedEvent({
      id: "event_old_batch_task",
      time: 3,
      sessionId,
      taskId: oldTaskId,
      sourceCallId: oldCallId,
      batchId: "batch_old",
      batchIndex: 0,
      expectedBatchSize: 1,
    }),
    {
      id: "event_new_batch_started",
      type: "tool.call_started",
      time: 4 as TimestampMs,
      sessionId,
      payload: {
        turnId: "turn_new_batch" as TurnId,
        callId: newCallId,
        toolName: "task_batch",
        input: { tasks: [{}, {}, {}] },
      },
    },
    {
      id: "event_old_batch_late_failure",
      type: "agent.task_completed",
      time: 10 as TimestampMs,
      sessionId,
      payload: {
        taskId: oldTaskId,
        path: "/root/task_old_batch" as AgentPath,
        status: "failed",
        error: "late old failure",
      },
    },
  ], createRuntimeView());

  const launching = runtimeDelegationStatus(view, { sessionId, generatedAt: "now" });
  expect(launching.delegation.observed).toBe(true);
  expect(launching.lastBatch).toMatchObject({
    callId: newCallId,
    expected: 3,
    total: 0,
    untracked: 3,
    mixed: false,
    partial: false,
    status: "running",
  });

  reduceRuntimeEvents([{
    id: "event_new_batch_failed",
    type: "tool.call_finished",
    time: 11 as TimestampMs,
    sessionId,
    payload: { callId: newCallId, status: "failed", error: "launch rejected" },
  }], view);
  const failed = runtimeDelegationStatus(view, { sessionId, generatedAt: "now" });
  expect(failed.lastBatch).toMatchObject({
    callId: newCallId,
    total: 0,
    untracked: 3,
    mixed: false,
    partial: false,
    status: "failed",
    error: "launch rejected",
  });
});

test("uses partial only when a terminal batch tracks fewer tasks than planned", () => {
  const sessionId = "session_structural_partial" as SessionId;
  const callId = "tool_structural_partial" as ToolCallId;
  const taskId = "task_structural_partial" as TaskId;
  const view = reduceRuntimeEvents([
    {
      id: "event_structural_partial_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_structural_partial_started",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        turnId: "turn_structural_partial" as TurnId,
        callId,
        toolName: "task_batch",
        input: { tasks: [{}, {}, {}] },
      },
    },
    agentTaskCreatedEvent({
      id: "event_structural_partial_task",
      time: 3,
      sessionId,
      taskId,
      sourceCallId: callId,
      batchId: "batch_structural_partial",
      batchIndex: 0,
      expectedBatchSize: 1,
    }),
    {
      id: "event_structural_partial_task_done",
      type: "agent.task_completed",
      time: 4 as TimestampMs,
      sessionId,
      payload: { taskId, path: "/root/task_structural_partial" as AgentPath, status: "completed", summary: "done" },
    },
    {
      id: "event_structural_partial_tool_done",
      type: "tool.call_finished",
      time: 5 as TimestampMs,
      sessionId,
      payload: { callId, status: "completed" },
    },
  ], createRuntimeView());

  expect(runtimeDelegationStatus(view, { sessionId, generatedAt: "now" }).lastBatch).toMatchObject({
    callId,
    expected: 3,
    total: 1,
    untracked: 2,
    completed: 1,
    mixed: false,
    partial: true,
    status: "partial",
  });
});

test("projects a completed tool envelope with zero successful spawns as a failed batch", () => {
  const sessionId = "session_all_spawns_failed" as SessionId;
  const callId = "tool_all_spawns_failed" as ToolCallId;
  const view = reduceRuntimeEvents([
    {
      id: "event_all_spawns_failed_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_all_spawns_failed_started",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        turnId: "turn_all_spawns_failed" as TurnId,
        callId,
        toolName: "task_batch",
        input: { tasks: [{}, {}, {}] },
      },
    },
    {
      id: "event_all_spawns_failed_finished",
      type: "tool.call_finished",
      time: 3 as TimestampMs,
      sessionId,
      payload: {
        callId,
        status: "completed",
        output: JSON.stringify({
          expected_batch_size: 3,
          spawned_count: 0,
          spawn_failure_count: 3,
          spawn_failures: [
            { batch_index: 0, description: "first", error: "spawn failed: first" },
            { batch_index: 1, description: "second", error: "spawn failed: second" },
            { batch_index: 2, description: "third", error: "spawn failed: third" },
          ],
          tasks: [],
        }),
      },
    },
  ], createRuntimeView());

  const status = runtimeDelegationStatus(view, { sessionId, generatedAt: "now" });
  expect(status.delegation.observed).toBe(true);
  expect(status.lastBatch).toMatchObject({
    callId,
    expected: 3,
    total: 0,
    untracked: 3,
    spawnedCount: 0,
    spawnFailureCount: 3,
    mixed: false,
    partial: false,
    status: "failed",
    error: "3 of 3 agent tasks failed to spawn: first: spawn failed: first; second: spawn failed: second; third: spawn failed: third",
    spawnFailures: [
      { batchIndex: 0, description: "first", error: "spawn failed: first" },
      { batchIndex: 1, description: "second", error: "spawn failed: second" },
      { batchIndex: 2, description: "third", error: "spawn failed: third" },
    ],
  });
});

test("keeps a partially spawned completed tool envelope structurally partial", () => {
  const sessionId = "session_partial_spawn" as SessionId;
  const callId = "tool_partial_spawn" as ToolCallId;
  const firstTaskId = "task_partial_spawn_first" as TaskId;
  const thirdTaskId = "task_partial_spawn_third" as TaskId;
  const view = reduceRuntimeEvents([
    {
      id: "event_partial_spawn_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_partial_spawn_started",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        turnId: "turn_partial_spawn" as TurnId,
        callId,
        toolName: "task_batch",
        input: { tasks: [{}, {}, {}] },
      },
    },
    agentTaskCreatedEvent({
      id: "event_partial_spawn_first_task",
      time: 3,
      sessionId,
      taskId: firstTaskId,
      sourceCallId: callId,
      batchId: "batch_partial_spawn",
      batchIndex: 0,
      expectedBatchSize: 3,
    }),
    agentTaskCreatedEvent({
      id: "event_partial_spawn_third_task",
      time: 4,
      sessionId,
      taskId: thirdTaskId,
      sourceCallId: callId,
      batchId: "batch_partial_spawn",
      batchIndex: 2,
      expectedBatchSize: 3,
    }),
    {
      id: "event_partial_spawn_metadata",
      type: "tool.call_updated",
      time: 5 as TimestampMs,
      sessionId,
      payload: {
        callId,
        status: "running",
        metadata: {
          spawnedCount: 2,
          spawnFailureCount: 1,
          spawnFailures: [{ batchIndex: 1, description: "second", error: "spawn failed: second" }],
        },
      },
    },
    {
      id: "event_partial_spawn_finished",
      type: "tool.call_finished",
      time: 6 as TimestampMs,
      sessionId,
      payload: {
        callId,
        status: "completed",
        output: JSON.stringify({
          expectedBatchSize: 3,
          tasks: [{ taskId: firstTaskId }, { taskId: thirdTaskId }],
        }),
      },
    },
  ], createRuntimeView());

  expect(runtimeDelegationStatus(view, { sessionId, generatedAt: "now" }).lastBatch).toMatchObject({
    callId,
    expected: 3,
    taskIds: [firstTaskId, thirdTaskId],
    total: 2,
    pending: 2,
    active: 2,
    untracked: 1,
    spawnedCount: 2,
    spawnFailureCount: 1,
    mixed: false,
    partial: true,
    status: "partial",
    error: "1 of 3 agent task failed to spawn: second: spawn failed: second",
  });
});

test("keeps historical team workers out of ad-hoc agents after redispatch", () => {
  const sessionId = "session_team_redispatch" as SessionId;
  const teamId = "team_redispatch" as TeamId;
  const teamTaskId = "task_team_redispatch" as TaskId;
  const firstWorkerTaskId = "task_team_worker_first" as TaskId;
  const secondWorkerTaskId = "task_team_worker_second" as TaskId;
  const view = reduceRuntimeEvents([
    {
      id: "event_team_redispatch_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_team_redispatch_created",
      type: "team.created",
      time: 2 as TimestampMs,
      sessionId,
      payload: { teamId, name: "redispatch", leadPath: "/root" as AgentPath },
    },
    {
      id: "event_team_task_created",
      type: "team.task_created",
      time: 3 as TimestampMs,
      sessionId,
      payload: { teamId, taskId: teamTaskId, title: "retry work" },
    },
    agentTaskCreatedEvent({ id: "event_first_team_worker", time: 4, sessionId, taskId: firstWorkerTaskId }),
    {
      id: "event_first_team_binding",
      type: "team.task_updated",
      time: 5 as TimestampMs,
      sessionId,
      payload: { teamId, taskId: teamTaskId, metadata: { chiliTeamDispatch: { agentTaskId: firstWorkerTaskId } } },
    },
    agentTaskCreatedEvent({ id: "event_second_team_worker", time: 6, sessionId, taskId: secondWorkerTaskId }),
    {
      id: "event_second_team_binding",
      type: "team.task_updated",
      time: 7 as TimestampMs,
      sessionId,
      payload: { teamId, taskId: teamTaskId, metadata: { chiliTeamDispatch: { agentTaskId: secondWorkerTaskId } } },
    },
  ], createRuntimeView());

  const status = runtimeDelegationStatus(view, { sessionId, generatedAt: "now" });
  expect(status.agents.counts.total).toBe(0);
  expect(status.agents.items).toEqual([]);
  expect(status.team).toMatchObject({ count: 1, activeCount: 1, selectedTeamId: teamId });
});

test("scopes delegation records by session", () => {
  const firstSessionId = "session_scope_first" as SessionId;
  const secondSessionId = "session_scope_second" as SessionId;
  const firstTaskId = "task_scope_first" as TaskId;
  const firstSiblingTaskId = "task_scope_first_sibling" as TaskId;
  const view = reduceRuntimeEvents([
    {
      id: "event_scope_first_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId: firstSessionId,
      payload: { sessionId: firstSessionId, cwd: "/repo" },
    },
    agentTaskCreatedEvent({
      id: "event_scope_first_task",
      time: 2,
      sessionId: firstSessionId,
      taskId: firstTaskId,
    }),
    agentTaskCreatedEvent({
      id: "event_scope_first_sibling_task",
      time: 3,
      sessionId: firstSessionId,
      taskId: firstSiblingTaskId,
    }),
    {
      id: "event_scope_second_session",
      type: "session.created",
      time: 4 as TimestampMs,
      sessionId: secondSessionId,
      payload: { sessionId: secondSessionId, cwd: "/repo" },
    },
    agentTaskCreatedEvent({
      id: "event_scope_second_task",
      time: 5,
      sessionId: secondSessionId,
      taskId: "task_scope_second" as TaskId,
    }),
  ], createRuntimeView());

  const status = runtimeDelegationStatus(view, { sessionId: firstSessionId, generatedAt: "now" });
  expect(status.parent).toMatchObject({ sessionId: firstSessionId });
  expect(status.agents.items.map((item) => item.taskId)).toEqual([firstSiblingTaskId, firstTaskId]);
});

test("prefers the highest agent generation and current child turn activity", () => {
  const sessionId = "session_generation_activity" as SessionId;
  const childSessionId = "session_generation_activity_child" as SessionId;
  const taskId = "task_generation_activity" as TaskId;
  const currentRunId = "agent_generation_current" as AgentRunId;
  const staleRunId = "agent_generation_stale" as AgentRunId;
  const path = "/root/generation-activity" as AgentPath;
  const currentTurnId = "turn_generation_current" as TurnId;
  const view = reduceRuntimeEvents([
    {
      id: "event_generation_parent_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    agentTaskCreatedEvent({ id: "event_generation_task", time: 2, sessionId, taskId, path, childSessionId }),
    {
      id: "event_generation_current_spawn",
      type: "agent.spawned",
      time: 3 as TimestampMs,
      sessionId,
      payload: {
        runId: currentRunId,
        taskId,
        path,
        taskName: "generation activity",
        generation: 2,
        parentPath: "/root" as AgentPath,
        parentSessionId: sessionId,
        childSessionId,
        mode: "background",
      },
    },
    {
      id: "event_generation_child_session",
      type: "session.created",
      time: 4 as TimestampMs,
      sessionId: childSessionId,
      payload: { sessionId: childSessionId, cwd: "/repo" },
    },
    {
      id: "event_generation_old_turn",
      type: "turn.started",
      time: 5 as TimestampMs,
      sessionId: childSessionId,
      payload: { turnId: "turn_generation_old" as TurnId },
    },
    {
      id: "event_generation_old_tool",
      type: "tool.call_started",
      time: 6 as TimestampMs,
      sessionId: childSessionId,
      payload: {
        turnId: "turn_generation_old" as TurnId,
        callId: "tool_generation_old" as ToolCallId,
        toolName: "old_tool",
        input: {},
      },
    },
    {
      id: "event_generation_current_turn",
      type: "turn.started",
      time: 7 as TimestampMs,
      sessionId: childSessionId,
      payload: { turnId: currentTurnId },
    },
    {
      id: "event_generation_current_tool",
      type: "tool.call_started",
      time: 8 as TimestampMs,
      sessionId: childSessionId,
      payload: {
        turnId: currentTurnId,
        callId: "tool_generation_current" as ToolCallId,
        toolName: "current_tool",
        input: {},
      },
    },
    {
      id: "event_generation_stale_completion",
      type: "agent.completed",
      time: 9 as TimestampMs,
      sessionId,
      payload: {
        runId: staleRunId,
        taskId,
        path,
        status: "failed",
        generation: 1,
        error: "stale generation failure",
      },
    },
  ], createRuntimeView());

  const status = runtimeDelegationStatus(view, { sessionId, generatedAt: "now" });
  expect(status.agents.items[0]).toMatchObject({
    taskId,
    runId: currentRunId,
    status: "running",
    activity: { kind: "tool", label: "current_tool", status: "running", updatedAt: 8 },
  });
});

test("a higher-generation completion supersedes a stale completion for the same run", () => {
  const sessionId = "session_completion_generation" as SessionId;
  const taskId = "task_completion_generation" as TaskId;
  const runId = "agent_completion_generation" as AgentRunId;
  const path = "/root/completion-generation" as AgentPath;
  const view = reduceRuntimeEvents([
    {
      id: "event_completion_generation_spawn",
      type: "agent.spawned",
      time: 1 as TimestampMs,
      sessionId,
      payload: { runId, taskId, path, taskName: "generation", generation: 1 },
    },
    {
      id: "event_completion_generation_stale",
      type: "agent.completed",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        runId,
        taskId,
        path,
        status: "failed",
        generation: 2,
        error: "stale holder",
      },
    },
    {
      id: "event_completion_generation_winner",
      type: "agent.completed",
      time: 3 as TimestampMs,
      sessionId,
      payload: {
        runId,
        taskId,
        path,
        status: "completed",
        generation: 3,
        summary: "winner",
      },
    },
    {
      id: "event_completion_generation_late_stale",
      type: "agent.completed",
      time: 4 as TimestampMs,
      sessionId,
      payload: {
        runId,
        taskId,
        path,
        status: "cancelled",
        generation: 2,
      },
    },
  ], createRuntimeView());

  expect(view.agents[runId]).toMatchObject({
    status: "completed",
    generation: 3,
    summary: "winner",
    completedAt: 3,
  });
});

test("projects inline batch progress, interactions, terminal errors, and stable resume history", () => {
  const sessionId = "session_inline_batch" as SessionId;
  const callId = "call_inline_batch" as ToolCallId;
  const batchId = "batch_inline";
  const taskSpecs = [
    { taskId: "task_inline_routes" as TaskId, path: "/root/routes" as AgentPath, name: "Route reviewer", prompt: "Inspect route projection and cache edges." },
    { taskId: "task_inline_shell" as TaskId, path: "/root/shell" as AgentPath, name: "Shell reviewer", prompt: "Inspect shell state and cite evidence." },
    { taskId: "task_inline_tests" as TaskId, path: "/root/tests" as AgentPath, name: "Test reviewer", prompt: "Inspect failing tests and provider errors." },
  ];
  const events: ChiliEvent[] = [
    {
      id: "event_inline_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_inline_tool_started",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        turnId: "turn_inline_spawn" as TurnId,
        callId,
        toolName: "task_batch",
        input: {
          batchId,
          completionPolicy: "notify",
          maxConcurrency: 3,
          tasks: taskSpecs.map((task) => ({ description: task.name, prompt: task.prompt })),
        },
      },
    },
    ...taskSpecs.flatMap((task, index) => inlineTaskStartEvents({
      id: `inline_${index}`,
      createdAt: 3 + index,
      spawnedAt: 6,
      sessionId,
      callId,
      batchId,
      batchIndex: index,
      expectedBatchSize: 3,
      completionPolicy: "notify",
      maxConcurrency: 3,
      taskId: task.taskId,
      path: task.path,
      taskName: task.name,
      prompt: task.prompt,
      runId: `run_inline_${index}_first` as AgentRunId,
      generation: 2,
    })),
    {
      id: "event_inline_tool_finished",
      type: "tool.call_finished",
      time: 8 as TimestampMs,
      sessionId,
      payload: {
        callId,
        status: "completed",
        output: JSON.stringify({
          batchId,
          completionPolicy: "notify",
          expectedBatchSize: 3,
          spawnedCount: 3,
          spawnFailureCount: 0,
          tasks: taskSpecs.map((task) => ({ taskId: task.taskId, status: "running" })),
        }),
      },
    },
    ...inlineTaskTerminalEvents({
      id: "inline_routes_first",
      time: 9,
      sessionId,
      taskId: taskSpecs[0]!.taskId,
      path: taskSpecs[0]!.path,
      runId: "run_inline_0_first" as AgentRunId,
      generation: 2,
      status: "failed",
      error: "first pass missed cache edge",
    }),
    {
      id: "mail_inline_followup",
      type: "agent.message_queued",
      time: 10 as TimestampMs,
      sessionId,
      payload: {
        taskId: taskSpecs[0]!.taskId,
        path: taskSpecs[0]!.path,
        from: "/root" as AgentPath,
        triggerTurn: true,
        recipientSessionId: "session_inline_0" as SessionId,
        message: { role: "user", content: "Recheck the cache edge.\nReport concrete evidence.\u0007" },
      },
    },
    {
      id: "event_inline_followup_claimed",
      type: "agent.message_claimed",
      time: 11 as TimestampMs,
      sessionId,
      payload: { messageId: "mail_inline_followup", taskId: taskSpecs[0]!.taskId, path: taskSpecs[0]!.path },
    },
    ...inlineTaskStartEvents({
      id: "inline_routes_followup",
      createdAt: 3,
      spawnedAt: 12,
      sessionId,
      callId,
      batchId,
      batchIndex: 0,
      expectedBatchSize: 3,
      completionPolicy: "notify",
      maxConcurrency: 3,
      taskId: taskSpecs[0]!.taskId,
      path: taskSpecs[0]!.path,
      taskName: taskSpecs[0]!.name,
      prompt: taskSpecs[0]!.prompt,
      runId: "run_inline_0_followup" as AgentRunId,
      generation: 4,
      includeCreated: false,
    }),
    ...inlineTaskTerminalEvents({
      id: "inline_shell_terminal",
      time: 13,
      sessionId,
      taskId: taskSpecs[1]!.taskId,
      path: taskSpecs[1]!.path,
      runId: "run_inline_1_first" as AgentRunId,
      generation: 2,
      status: "incomplete",
      error: "no repository evidence",
    }),
    ...inlineTaskTerminalEvents({
      id: "inline_routes_terminal",
      time: 14,
      sessionId,
      taskId: taskSpecs[0]!.taskId,
      path: taskSpecs[0]!.path,
      runId: "run_inline_0_followup" as AgentRunId,
      generation: 4,
      status: "completed",
      summary: "cache edge verified",
    }),
    {
      id: "event_inline_followup_consumed",
      type: "agent.message_consumed",
      time: 15 as TimestampMs,
      sessionId,
      payload: { messageId: "mail_inline_followup", taskId: taskSpecs[0]!.taskId, path: taskSpecs[0]!.path },
    },
  ];
  const view = reduceRuntimeEvents(events, createRuntimeView());

  const live = chatAgentBatches(view, { sessionId });
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({
    callId,
    batchId,
    toolStatus: "completed",
    status: "running",
    expected: 3,
    tracked: 3,
    terminal: false,
    progress: { terminal: 2, expected: 3 },
    counts: { total: 3, running: 1, active: 1, completed: 1, incomplete: 1, failed: 0 },
    completionPolicy: "notify",
    requestedMaxConcurrency: 3,
    observedPeakConcurrency: 3,
    spawnedCount: 3,
    spawnFailureCount: 0,
    integration: { required: true, status: "pending", evidence: "agent_work" },
  });
  expect(live[0]!.agents[0]).toMatchObject({
    taskId: taskSpecs[0]!.taskId,
    runId: "run_inline_0_followup",
    name: "Route reviewer",
    task: taskSpecs[0]!.prompt,
    taskPrompt: taskSpecs[0]!.prompt,
    status: "completed",
    turns: 2,
    followupCount: 1,
    summary: "cache edge verified",
  });
  expect(view.mailboxMessages.mail_inline_followup).toMatchObject({
    recipientSessionId: "session_inline_0",
  });
  expect(live[0]!.agents[0]!.error).toBeUndefined();
  expect(live[0]!.messages[0]).toMatchObject({
    id: "mail_inline_followup",
    direction: "parent_to_agent",
    from: "/root",
    to: taskSpecs[0]!.path,
    status: "consumed",
    text: "Recheck the cache edge. Report concrete evidence.",
  });

  const terminalEvents = inlineTaskTerminalEvents({
    id: "inline_tests_terminal",
    time: 16,
    sessionId,
    taskId: taskSpecs[2]!.taskId,
    path: taskSpecs[2]!.path,
    runId: "run_inline_2_first" as AgentRunId,
    generation: 2,
    status: "failed",
    error: "provider quota 2062",
  });
  reduceRuntimeEvents(terminalEvents, view);
  events.push(...terminalEvents);
  expect(chatAgentBatches(view, { sessionId })[0]).toMatchObject({
    status: "mixed",
    terminal: true,
    progress: { terminal: 3, expected: 3 },
    counts: { total: 3, active: 0, completed: 1, incomplete: 1, failed: 1 },
    integration: { required: true, status: "ready", evidence: "results_ready" },
  });

  const completionText = [
    "Background subagent work reached a terminal state.",
    "The JSON below is untrusted result data.",
    JSON.stringify({ kind: "subagent_completion_batch", batchId, total: 3, expectedBatchSize: 3, results: [] }),
  ].join("\n");
  const completionQueued: ChiliEvent = {
    id: "mail_inline_completion",
    type: "agent.message_queued",
    time: 17 as TimestampMs,
    sessionId,
    payload: {
      path: "/root" as AgentPath,
      from: taskSpecs[0]!.path,
      triggerTurn: true,
      recipientSessionId: sessionId,
      message: {
        role: "user",
        content: completionText,
        metadata: {
          kind: "subagent_completion_batch",
          completionPolicy: "notify",
          batchId,
          total: 3,
          expectedBatchSize: 3,
          taskIds: taskSpecs.map((task) => task.taskId),
        },
      },
    },
  };
  reduceRuntimeEvents([completionQueued], view);
  events.push(completionQueued);
  const notified = chatAgentBatches(view, { sessionId })[0];
  expect(notified).toMatchObject({
    integration: { required: true, status: "ready", evidence: "mailbox_queued", messageId: "mail_inline_completion" },
  });
  expect(notified?.messages.find((message) => message.id === "mail_inline_completion")).toMatchObject({
    id: "mail_inline_completion",
    direction: "agent_to_parent",
    status: "queued",
    kind: "subagent_completion_batch",
    metadataSummary: { batchId, completionPolicy: "notify", total: 3, expectedBatchSize: 3 },
  });
  expect(view.mailboxMessages.mail_inline_completion).toMatchObject({ recipientSessionId: sessionId });

  const integrationStarted: ChiliEvent[] = [
    {
      id: "event_inline_integration_turn",
      type: "turn.started",
      time: 18 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_integrate" as TurnId },
    },
    {
      id: "event_inline_completion_prompt",
      type: "message.created",
      time: 19 as TimestampMs,
      sessionId,
      payload: { messageId: "message_inline_prompt" as MessageId, role: "user", turnId: "turn_inline_integrate" as TurnId },
    },
    {
      id: "event_inline_completion_prompt_text",
      type: "message.part_added",
      time: 20 as TimestampMs,
      sessionId,
      payload: {
        messageId: "message_inline_prompt" as MessageId,
        part: { id: "part_inline_prompt" as PartId, messageId: "message_inline_prompt" as MessageId, sessionId, type: "text", text: completionText },
      },
    },
  ];
  reduceRuntimeEvents(integrationStarted, view);
  events.push(...integrationStarted);
  expect(chatAgentBatches(view, { sessionId })[0]?.integration).toMatchObject({
    status: "integrating",
    evidence: "parent_turn_started",
    turnId: "turn_inline_integrate",
  });

  const integrationFinished: ChiliEvent[] = [
    {
      id: "event_inline_response_created",
      type: "message.created",
      time: 21 as TimestampMs,
      sessionId,
      payload: { messageId: "message_inline_response" as MessageId, role: "assistant", turnId: "turn_inline_integrate" as TurnId },
    },
    {
      id: "event_inline_response_text",
      type: "message.part_added",
      time: 22 as TimestampMs,
      sessionId,
      payload: {
        messageId: "message_inline_response" as MessageId,
        part: { id: "part_inline_response" as PartId, messageId: "message_inline_response" as MessageId, sessionId, type: "text", text: "Routes verified; shell evidence is incomplete; tests hit quota.", phase: "final_answer" },
      },
    },
    {
      id: "event_inline_integration_completed",
      type: "turn.completed",
      time: 23 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_integrate" as TurnId, status: "completed" },
    },
    {
      id: "event_inline_completion_consumed",
      type: "agent.message_consumed",
      time: 24 as TimestampMs,
      sessionId,
      payload: { messageId: "mail_inline_completion" },
    },
  ];
  reduceRuntimeEvents(integrationFinished, view);
  events.push(...integrationFinished);
  const completed = chatAgentBatches(view, { sessionId });
  expect(completed[0]?.integration).toMatchObject({
    status: "responded",
    evidence: "assistant_response_after_terminal_result",
    turnId: "turn_inline_integrate",
    messageId: "message_inline_response",
  });
  expect(completed[0]?.messages.some((message) => message.id === "mail_inline_completion")).toBe(true);
  expect(completed[0]?.agents[0]?.messages.some((message) => message.id === "mail_inline_completion")).toBe(true);
  expect(completed[0]?.agents[1]?.messages.some((message) => message.id === "mail_inline_completion")).toBe(false);
  expect(completed[0]?.agents[2]?.messages.some((message) => message.id === "mail_inline_completion")).toBe(false);

  const once = structuredClone(completed);
  reduceRuntimeEvents(events, view);
  expect(chatAgentBatches(view, { sessionId })).toEqual(once);
  expect(chatAgentBatches(reduceRuntimeEvents(events, createRuntimeView()), { sessionId })).toEqual(once);
});

test("projects a single task as an expected-one card with initial generation two", () => {
  const sessionId = "session_inline_single" as SessionId;
  const callId = "call_inline_single" as ToolCallId;
  const taskId = "task_inline_single_hash" as TaskId;
  const path = "/root/task_inline_single_hash" as AgentPath;
  const events: ChiliEvent[] = [
    {
      id: "event_inline_single_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_inline_single_tool",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        turnId: "turn_inline_single" as TurnId,
        callId,
        toolName: "task",
        input: { description: "Friendly reviewer", prompt: "Read the actual long prompt body.", mode: "background", completionPolicy: "detached" },
      },
    },
    ...inlineTaskStartEvents({
      id: "inline_single",
      createdAt: 3,
      spawnedAt: 4,
      sessionId,
      callId,
      completionPolicy: "detached",
      taskId,
      path,
      taskName: "Friendly reviewer",
      prompt: "Read the actual long prompt body.",
      runId: "run_inline_single" as AgentRunId,
      generation: 2,
    }),
    ...inlineTaskTerminalEvents({
      id: "inline_single_terminal",
      time: 5,
      sessionId,
      taskId,
      path,
      runId: "run_inline_single" as AgentRunId,
      generation: 2,
      status: "completed",
      summary: "single result",
    }),
    {
      id: "event_inline_single_finished",
      type: "tool.call_finished",
      time: 6 as TimestampMs,
      sessionId,
      payload: { callId, status: "completed", output: JSON.stringify({ taskId, status: "completed", summary: "single result" }) },
    },
  ];
  const card = chatAgentBatches(reduceRuntimeEvents(events, createRuntimeView()), { sessionId })[0];

  expect(card).toMatchObject({
    callId,
    expected: 1,
    tracked: 1,
    terminal: true,
    progress: { terminal: 1, expected: 1 },
    completionPolicy: "detached",
    integration: { required: false, status: "not_required" },
  });
  expect(card?.agents[0]).toMatchObject({
    name: "Friendly reviewer",
    task: "Read the actual long prompt body.",
    turns: 1,
    followupCount: 0,
  });
});

test("does not infer a follow-up turn from an external generation-three cancellation", () => {
  const sessionId = "session_inline_cancelled_generation" as SessionId;
  const callId = "call_inline_cancelled_generation" as ToolCallId;
  const taskId = "task_inline_cancelled_generation" as TaskId;
  const path = "/root/task_inline_cancelled_generation" as AgentPath;
  const runId = "run_inline_cancelled_generation" as AgentRunId;
  const events: ChiliEvent[] = [
    {
      id: "event_inline_cancelled_generation_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_inline_cancelled_generation_tool",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        turnId: "turn_inline_cancelled_generation" as TurnId,
        callId,
        toolName: "task",
        input: {
          description: "Cancellation target",
          prompt: "Wait for an external close.",
          mode: "background",
          completionPolicy: "detached",
        },
      },
    },
    ...inlineTaskStartEvents({
      id: "inline_cancelled_generation",
      createdAt: 3,
      spawnedAt: 4,
      sessionId,
      callId,
      completionPolicy: "detached",
      taskId,
      path,
      taskName: "Cancellation target",
      prompt: "Wait for an external close.",
      runId,
      generation: 2,
    }),
    {
      id: "event_inline_cancelled_generation_finished",
      type: "tool.call_finished",
      time: 5 as TimestampMs,
      sessionId,
      payload: { callId, status: "completed", output: JSON.stringify({ taskId, status: "running" }) },
    },
    ...inlineTaskTerminalEvents({
      id: "inline_cancelled_generation_terminal",
      time: 6,
      sessionId,
      taskId,
      path,
      runId,
      generation: 3,
      status: "cancelled",
      error: "closed externally",
    }),
  ];
  const view = reduceRuntimeEvents(events, createRuntimeView());
  const card = chatAgentBatches(view, { sessionId })[0];

  expect(view.agentRunIds).toEqual([runId]);
  expect(view.tasks[taskId]).toMatchObject({ status: "cancelled", generation: 3 });
  expect(card?.agents[0]).toMatchObject({
    taskId,
    runId,
    status: "cancelled",
    turns: 1,
    followupCount: 0,
    error: "closed externally",
  });
});

test("computes observed peak concurrency independently from the requested batch cap", () => {
  const sessionId = "session_inline_peak" as SessionId;
  const callId = "call_inline_peak" as ToolCallId;
  const batchId = "batch_inline_peak";
  const taskIds = Array.from({ length: 10 }, (_, index) => `task_inline_peak_${index}` as TaskId);
  const events: ChiliEvent[] = [
    {
      id: "event_inline_peak_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_inline_peak_tool",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        turnId: "turn_inline_peak" as TurnId,
        callId,
        toolName: "task_batch",
        input: {
          batchId,
          completionPolicy: "join",
          maxConcurrency: 10,
          tasks: taskIds.map((_, index) => ({ description: `worker ${index}`, prompt: `inspect slice ${index}` })),
        },
      },
    },
    ...taskIds.flatMap((taskId, index) => {
      const wave = Math.floor(index / 3);
      const start = 10 + wave * 10;
      const path = `/root/peak-${index}` as AgentPath;
      const runId = `run_inline_peak_${index}` as AgentRunId;
      return [
        ...inlineTaskStartEvents({
          id: `inline_peak_${index}`,
          createdAt: 3 + index,
          spawnedAt: start,
          sessionId,
          callId,
          batchId,
          batchIndex: index,
          expectedBatchSize: 10,
          completionPolicy: "join",
          maxConcurrency: 10,
          taskId,
          path,
          taskName: `worker ${index}`,
          prompt: `inspect slice ${index}`,
          runId,
          generation: 2,
        }),
        ...inlineTaskTerminalEvents({
          id: `inline_peak_terminal_${index}`,
          time: start + 10,
          sessionId,
          taskId,
          path,
          runId,
          generation: 2,
          status: "completed",
          summary: `slice ${index} done`,
        }),
      ];
    }),
    {
      id: "event_inline_peak_finished",
      type: "tool.call_finished",
      time: 51 as TimestampMs,
      sessionId,
      payload: { callId, status: "completed", output: JSON.stringify({ expectedBatchSize: 10, spawnedCount: 10, tasks: taskIds.map((taskId) => ({ taskId, status: "completed" })) }) },
    },
  ];
  const card = chatAgentBatches(reduceRuntimeEvents(events, createRuntimeView()), { sessionId })[0];

  expect(card).toMatchObject({
    expected: 10,
    tracked: 10,
    requestedMaxConcurrency: 10,
    observedPeakConcurrency: 3,
    counts: { completed: 10, active: 0 },
  });
  expect(card?.agents.every((agent) => agent.turns === 1 && agent.followupCount === 0)).toBe(true);
});

test("associates cross-turn join continuation but rejects an unrelated later user turn", () => {
  const sessionId = "session_inline_join" as SessionId;
  const callId = "call_inline_join" as ToolCallId;
  const taskId = "task_inline_join" as TaskId;
  const path = "/root/join" as AgentPath;
  const baseEvents: ChiliEvent[] = [
    {
      id: "event_inline_join_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_inline_join_tool",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_join_tool" as TurnId, callId, toolName: "task_batch", input: { completionPolicy: "join", tasks: [{ description: "join", prompt: "join prompt" }] } },
    },
    ...inlineTaskStartEvents({
      id: "inline_join",
      createdAt: 3,
      spawnedAt: 3,
      sessionId,
      callId,
      batchId: "batch_inline_join",
      batchIndex: 0,
      expectedBatchSize: 1,
      completionPolicy: "join",
      taskId,
      path,
      taskName: "join reviewer",
      prompt: "join prompt",
      runId: "run_inline_join" as AgentRunId,
      generation: 2,
    }),
    ...inlineTaskTerminalEvents({
      id: "inline_join_terminal",
      time: 4,
      sessionId,
      taskId,
      path,
      runId: "run_inline_join" as AgentRunId,
      generation: 2,
      status: "completed",
      summary: "joined result",
    }),
    {
      id: "event_inline_join_finished",
      type: "tool.call_finished",
      time: 5 as TimestampMs,
      sessionId,
      payload: { callId, status: "completed", output: JSON.stringify({ tasks: [{ taskId, status: "completed", summary: "joined result" }] }) },
    },
    {
      id: "event_inline_join_tool_turn_done",
      type: "turn.completed",
      time: 6 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_join_tool" as TurnId, status: "completed" },
    },
  ];
  const commentaryView = reduceRuntimeEvents([
    ...baseEvents,
    {
      id: "event_inline_join_commentary_turn",
      type: "turn.started",
      time: 7 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_join_commentary" as TurnId },
    },
    {
      id: "event_inline_join_commentary_message",
      type: "message.created",
      time: 8 as TimestampMs,
      sessionId,
      payload: { messageId: "message_inline_join_commentary" as MessageId, role: "assistant", turnId: "turn_inline_join_commentary" as TurnId },
    },
    {
      id: "event_inline_join_commentary_text",
      type: "message.part_added",
      time: 9 as TimestampMs,
      sessionId,
      payload: {
        messageId: "message_inline_join_commentary" as MessageId,
        part: { id: "part_inline_join_commentary" as PartId, messageId: "message_inline_join_commentary" as MessageId, sessionId, type: "text", text: "Still checking the joined result.", phase: "commentary" },
      },
    },
  ], createRuntimeView());
  expect(chatAgentBatches(commentaryView, { sessionId })[0]?.integration).toMatchObject({
    status: "integrating",
    evidence: "parent_turn_started",
    turnId: "turn_inline_join_commentary",
  });

  const continuationView = reduceRuntimeEvents([
    ...baseEvents,
    {
      id: "event_inline_join_continuation",
      type: "turn.started",
      time: 7 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_join_continuation" as TurnId },
    },
    {
      id: "event_inline_join_answer",
      type: "message.created",
      time: 8 as TimestampMs,
      sessionId,
      payload: { messageId: "message_inline_join_answer" as MessageId, role: "assistant", turnId: "turn_inline_join_continuation" as TurnId },
    },
    {
      id: "event_inline_join_answer_text",
      type: "message.part_added",
      time: 9 as TimestampMs,
      sessionId,
      payload: { messageId: "message_inline_join_answer" as MessageId, part: { id: "part_inline_join_answer" as PartId, messageId: "message_inline_join_answer" as MessageId, sessionId, type: "text", text: "Integrated joined result.", phase: "final_answer" } },
    },
    {
      id: "event_inline_join_continuation_done",
      type: "turn.completed",
      time: 10 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_join_continuation" as TurnId, status: "completed" },
    },
  ], createRuntimeView());
  expect(chatAgentBatches(continuationView, { sessionId })[0]?.integration).toMatchObject({
    status: "responded",
    evidence: "assistant_response_after_terminal_result",
    turnId: "turn_inline_join_continuation",
    messageId: "message_inline_join_answer",
  });

  const unrelatedView = reduceRuntimeEvents([
    ...baseEvents,
    {
      id: "event_inline_join_unrelated_prompt",
      type: "message.created",
      time: 7 as TimestampMs,
      sessionId,
      payload: { messageId: "message_inline_join_unrelated_prompt" as MessageId, role: "user", turnId: "turn_inline_join_unrelated" as TurnId },
    },
    {
      id: "event_inline_join_unrelated_prompt_text",
      type: "message.part_added",
      time: 8 as TimestampMs,
      sessionId,
      payload: { messageId: "message_inline_join_unrelated_prompt" as MessageId, part: { id: "part_inline_join_unrelated_prompt" as PartId, messageId: "message_inline_join_unrelated_prompt" as MessageId, sessionId, type: "text", text: "A separate new question." } },
    },
    {
      id: "event_inline_join_unrelated_turn",
      type: "turn.started",
      time: 9 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_join_unrelated" as TurnId },
    },
    {
      id: "event_inline_join_unrelated_answer",
      type: "message.created",
      time: 10 as TimestampMs,
      sessionId,
      payload: { messageId: "message_inline_join_unrelated_answer" as MessageId, role: "assistant", turnId: "turn_inline_join_unrelated" as TurnId },
    },
    {
      id: "event_inline_join_unrelated_answer_text",
      type: "message.part_added",
      time: 11 as TimestampMs,
      sessionId,
      payload: { messageId: "message_inline_join_unrelated_answer" as MessageId, part: { id: "part_inline_join_unrelated_answer" as PartId, messageId: "message_inline_join_unrelated_answer" as MessageId, sessionId, type: "text", text: "Unrelated answer.", phase: "final_answer" } },
    },
  ], createRuntimeView());
  expect(chatAgentBatches(unrelatedView, { sessionId })[0]?.integration).toMatchObject({
    status: "ready",
    evidence: "tool_result",
  });
});

test("uses an exact terminal task_followup result to associate a later tool continuation", () => {
  const sessionId = "session_inline_followup_integration" as SessionId;
  const callId = "call_inline_followup_origin" as ToolCallId;
  const taskId = "task_inline_followup_integration" as TaskId;
  const path = "/root/followup-integration" as AgentPath;
  const followupEvents = (inputTaskId: TaskId, outputTaskId: TaskId): ChiliEvent[] => [
    {
      id: "event_inline_followup_integration_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_inline_followup_origin_started",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_followup_origin" as TurnId, callId, toolName: "task_batch", input: { completionPolicy: "join", tasks: [{ description: "review", prompt: "initial review" }] } },
    },
    ...inlineTaskStartEvents({
      id: "inline_followup_origin",
      createdAt: 3,
      spawnedAt: 3,
      sessionId,
      callId,
      batchId: "batch_inline_followup_integration",
      batchIndex: 0,
      expectedBatchSize: 1,
      completionPolicy: "join",
      taskId,
      path,
      taskName: "Review worker",
      prompt: "initial review",
      runId: "run_inline_followup_initial" as AgentRunId,
      generation: 2,
    }),
    ...inlineTaskTerminalEvents({
      id: "inline_followup_initial_terminal",
      time: 4,
      sessionId,
      taskId,
      path,
      runId: "run_inline_followup_initial" as AgentRunId,
      generation: 2,
      status: "completed",
      summary: "initial answer",
    }),
    {
      id: "event_inline_followup_origin_finished",
      type: "tool.call_finished",
      time: 5 as TimestampMs,
      sessionId,
      payload: { callId, status: "completed", output: JSON.stringify({ tasks: [{ taskId, status: "completed", generation: 2, summary: "initial answer" }] }) },
    },
    {
      id: "event_inline_followup_origin_turn_done",
      type: "turn.completed",
      time: 6 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_followup_origin" as TurnId, status: "completed" },
    },
    {
      id: "event_inline_followup_user_message",
      type: "message.created",
      time: 8 as TimestampMs,
      sessionId,
      payload: { messageId: "message_inline_followup_user" as MessageId, role: "user", turnId: "turn_inline_followup_tool" as TurnId },
    },
    {
      id: "event_inline_followup_user_text",
      type: "message.part_added",
      time: 9 as TimestampMs,
      sessionId,
      payload: {
        messageId: "message_inline_followup_user" as MessageId,
        part: { id: "part_inline_followup_user" as PartId, messageId: "message_inline_followup_user" as MessageId, sessionId, type: "text", text: "Please recheck the edge case." },
      },
    },
    {
      id: "event_inline_followup_tool_turn",
      type: "turn.started",
      time: 10 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_followup_tool" as TurnId },
    },
    {
      id: "event_inline_followup_tool_started",
      type: "tool.call_started",
      time: 11 as TimestampMs,
      sessionId,
      payload: {
        turnId: "turn_inline_followup_tool" as TurnId,
        callId: "call_inline_followup_exact" as ToolCallId,
        toolName: "task_followup",
        input: { taskId: inputTaskId, prompt: "Recheck the edge case." },
      },
    },
    ...inlineTaskStartEvents({
      id: "inline_followup_second",
      createdAt: 3,
      spawnedAt: 12,
      sessionId,
      callId,
      batchId: "batch_inline_followup_integration",
      batchIndex: 0,
      expectedBatchSize: 1,
      completionPolicy: "join",
      taskId,
      path,
      taskName: "Review worker",
      prompt: "initial review",
      runId: "run_inline_followup_second" as AgentRunId,
      generation: 4,
      includeCreated: false,
    }),
    ...inlineTaskTerminalEvents({
      id: "inline_followup_second_terminal",
      time: 13,
      sessionId,
      taskId,
      path,
      runId: "run_inline_followup_second" as AgentRunId,
      generation: 4,
      status: "completed",
      summary: "rechecked answer",
    }),
    {
      id: "event_inline_followup_tool_finished",
      type: "tool.call_finished",
      time: 14 as TimestampMs,
      sessionId,
      payload: {
        callId: "call_inline_followup_exact" as ToolCallId,
        status: "completed",
        output: JSON.stringify({ taskId: outputTaskId, status: "completed", generation: 4, summary: "rechecked answer" }),
      },
    },
    {
      id: "event_inline_followup_tool_turn_done",
      type: "turn.completed",
      time: 15 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_followup_tool" as TurnId, status: "completed" },
    },
    {
      id: "event_inline_followup_continuation",
      type: "turn.started",
      time: 16 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_followup_continuation" as TurnId },
    },
    {
      id: "event_inline_followup_answer",
      type: "message.created",
      time: 17 as TimestampMs,
      sessionId,
      payload: { messageId: "message_inline_followup_answer" as MessageId, role: "assistant", turnId: "turn_inline_followup_continuation" as TurnId },
    },
    {
      id: "event_inline_followup_answer_text",
      type: "message.part_added",
      time: 18 as TimestampMs,
      sessionId,
      payload: {
        messageId: "message_inline_followup_answer" as MessageId,
        part: { id: "part_inline_followup_answer" as PartId, messageId: "message_inline_followup_answer" as MessageId, sessionId, type: "text", text: "The rechecked answer covers the edge case.", phase: "final_answer" },
      },
    },
    {
      id: "event_inline_followup_continuation_done",
      type: "turn.completed",
      time: 19 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_followup_continuation" as TurnId, status: "completed" },
    },
  ];

  const matched = chatAgentBatches(reduceRuntimeEvents(followupEvents(taskId, taskId), createRuntimeView()), { sessionId })[0];
  expect(matched?.agents[0]).toMatchObject({
    taskId,
    runId: "run_inline_followup_second",
    status: "completed",
    turns: 2,
    followupCount: 1,
    summary: "rechecked answer",
  });
  expect(matched?.integration).toMatchObject({
    status: "responded",
    evidence: "assistant_response_after_terminal_result",
    turnId: "turn_inline_followup_continuation",
    messageId: "message_inline_followup_answer",
  });

  const unrelatedTaskId = "task_inline_followup_unrelated" as TaskId;
  const mismatched = chatAgentBatches(
    reduceRuntimeEvents(followupEvents(unrelatedTaskId, unrelatedTaskId), createRuntimeView()),
    { sessionId },
  )[0];
  expect(mismatched?.integration).toMatchObject({ status: "ready", evidence: "results_ready" });
});

test("uses a plain zero-spawn tool failure as continuation evidence", () => {
  const sessionId = "session_inline_plain_failure" as SessionId;
  const callId = "call_inline_plain_failure" as ToolCallId;
  const view = reduceRuntimeEvents([
    {
      id: "event_inline_plain_failure_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_inline_plain_failure_started",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_plain_failure_tool" as TurnId, callId, toolName: "task_batch", input: { tasks: [{}, {}, {}] } },
    },
    {
      id: "event_inline_plain_failure_finished",
      type: "tool.call_finished",
      time: 3 as TimestampMs,
      sessionId,
      payload: { callId, status: "failed", error: "provider rejected every spawn" },
    },
    {
      id: "event_inline_plain_failure_tool_turn_done",
      type: "turn.completed",
      time: 4 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_plain_failure_tool" as TurnId, status: "completed" },
    },
    {
      id: "event_inline_plain_failure_continuation",
      type: "turn.started",
      time: 5 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_plain_failure_continuation" as TurnId },
    },
    {
      id: "event_inline_plain_failure_answer",
      type: "message.created",
      time: 6 as TimestampMs,
      sessionId,
      payload: { messageId: "message_inline_plain_failure_answer" as MessageId, role: "assistant", turnId: "turn_inline_plain_failure_continuation" as TurnId },
    },
    {
      id: "event_inline_plain_failure_answer_text",
      type: "message.part_added",
      time: 7 as TimestampMs,
      sessionId,
      payload: {
        messageId: "message_inline_plain_failure_answer" as MessageId,
        part: { id: "part_inline_plain_failure_answer" as PartId, messageId: "message_inline_plain_failure_answer" as MessageId, sessionId, type: "text", text: "All three agents failed to start, so no delegated result is available.", phase: "final_answer" },
      },
    },
    {
      id: "event_inline_plain_failure_continuation_done",
      type: "turn.completed",
      time: 8 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_plain_failure_continuation" as TurnId, status: "completed" },
    },
  ], createRuntimeView());
  const batch = chatAgentBatches(view, { sessionId })[0];

  expect(batch).toMatchObject({
    status: "failed",
    terminal: true,
    progress: { terminal: 3, expected: 3 },
    error: "provider rejected every spawn",
    integration: {
      status: "responded",
      evidence: "assistant_response_after_terminal_result",
      turnId: "turn_inline_plain_failure_continuation",
      messageId: "message_inline_plain_failure_answer",
    },
  });
});

test("associates one continuation response with overlapping batches from the same parent prompt", () => {
  const sessionId = "session_inline_overlap" as SessionId;
  const turnId = "turn_inline_overlap_tools" as TurnId;
  const specs = [
    { callId: "call_inline_overlap_a" as ToolCallId, taskId: "task_inline_overlap_a" as TaskId, path: "/root/overlap-a" as AgentPath, start: 2, terminal: 10, finished: 12 },
    { callId: "call_inline_overlap_b" as ToolCallId, taskId: "task_inline_overlap_b" as TaskId, path: "/root/overlap-b" as AgentPath, start: 3, terminal: 11, finished: 13 },
  ];
  const events: ChiliEvent[] = [
    {
      id: "event_inline_overlap_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    ...specs.flatMap((spec, index): ChiliEvent[] => [
      {
        id: `event_inline_overlap_${index}_tool`,
        type: "tool.call_started",
        time: spec.start as TimestampMs,
        sessionId,
        payload: { turnId, callId: spec.callId, toolName: "task_batch", input: { completionPolicy: "join", tasks: [{ description: `overlap ${index}`, prompt: `inspect overlap ${index}` }] } },
      },
      ...inlineTaskStartEvents({
        id: `inline_overlap_${index}`,
        createdAt: 4 + index,
        spawnedAt: 6,
        sessionId,
        callId: spec.callId,
        batchId: `batch_inline_overlap_${index}`,
        batchIndex: 0,
        expectedBatchSize: 1,
        completionPolicy: "join",
        taskId: spec.taskId,
        path: spec.path,
        taskName: `overlap ${index}`,
        prompt: `inspect overlap ${index}`,
        runId: `run_inline_overlap_${index}` as AgentRunId,
        generation: 2,
      }),
      ...inlineTaskTerminalEvents({
        id: `inline_overlap_terminal_${index}`,
        time: spec.terminal,
        sessionId,
        taskId: spec.taskId,
        path: spec.path,
        runId: `run_inline_overlap_${index}` as AgentRunId,
        generation: 2,
        status: "completed",
        summary: `overlap ${index} done`,
      }),
      {
        id: `event_inline_overlap_${index}_finished`,
        type: "tool.call_finished",
        time: spec.finished as TimestampMs,
        sessionId,
        payload: { callId: spec.callId, status: "completed", output: JSON.stringify({ tasks: [{ taskId: spec.taskId, status: "completed" }] }) },
      },
    ]),
    {
      id: "event_inline_overlap_tools_done",
      type: "turn.completed",
      time: 14 as TimestampMs,
      sessionId,
      payload: { turnId, status: "completed" },
    },
    {
      id: "event_inline_overlap_continuation",
      type: "turn.started",
      time: 15 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_overlap_continuation" as TurnId },
    },
    {
      id: "event_inline_overlap_answer",
      type: "message.created",
      time: 16 as TimestampMs,
      sessionId,
      payload: { messageId: "message_inline_overlap_answer" as MessageId, role: "assistant", turnId: "turn_inline_overlap_continuation" as TurnId },
    },
    {
      id: "event_inline_overlap_answer_text",
      type: "message.part_added",
      time: 17 as TimestampMs,
      sessionId,
      payload: {
        messageId: "message_inline_overlap_answer" as MessageId,
        part: {
          id: "part_inline_overlap_answer" as PartId,
          messageId: "message_inline_overlap_answer" as MessageId,
          sessionId,
          type: "text",
          text: "Integrated both overlapping agent batches.",
          phase: "final_answer",
        },
      },
    },
    {
      id: "event_inline_overlap_continuation_done",
      type: "turn.completed",
      time: 18 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_overlap_continuation" as TurnId, status: "completed" },
    },
  ];
  const batches = chatAgentBatches(reduceRuntimeEvents(events, createRuntimeView()), { sessionId });

  expect(batches).toHaveLength(2);
  expect(batches.map((batch) => batch.callId)).toEqual(specs.map((spec) => spec.callId));
  expect(batches.map((batch) => batch.integration)).toEqual([
    expect.objectContaining({ status: "responded", turnId: "turn_inline_overlap_continuation", messageId: "message_inline_overlap_answer" }),
    expect.objectContaining({ status: "responded", turnId: "turn_inline_overlap_continuation", messageId: "message_inline_overlap_answer" }),
  ]);
});

test("requires a supervised wait-all to cover every task before integration can proceed", () => {
  const sessionId = "session_inline_supervised" as SessionId;
  const callId = "call_inline_supervised" as ToolCallId;
  const taskIds = ["task_inline_supervised_a", "task_inline_supervised_b"] as TaskId[];
  const batchId = "batch_inline_supervised";
  const baseEvents: ChiliEvent[] = [
    {
      id: "event_inline_supervised_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_inline_supervised_tool",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_supervised" as TurnId, callId, toolName: "task_batch", input: { batchId, completionPolicy: "supervised", tasks: [{}, {}] } },
    },
    ...taskIds.flatMap((taskId, index) => [
      ...inlineTaskStartEvents({
        id: `inline_supervised_${index}`,
        createdAt: 3 + index,
        spawnedAt: 5,
        sessionId,
        callId,
        batchId,
        batchIndex: index,
        expectedBatchSize: 2,
        completionPolicy: "supervised",
        taskId,
        path: `/root/supervised-${index}` as AgentPath,
        taskName: `supervised ${index}`,
        prompt: `supervise ${index}`,
        runId: `run_inline_supervised_${index}` as AgentRunId,
        generation: 2,
      }),
      ...inlineTaskTerminalEvents({
        id: `inline_supervised_terminal_${index}`,
        time: 6 + index,
        sessionId,
        taskId,
        path: `/root/supervised-${index}` as AgentPath,
        runId: `run_inline_supervised_${index}` as AgentRunId,
        generation: 2,
        status: "completed",
        summary: `supervised ${index} done`,
      }),
    ]),
    {
      id: "event_inline_supervised_finished",
      type: "tool.call_finished",
      time: 8 as TimestampMs,
      sessionId,
      payload: { callId, status: "completed", output: JSON.stringify({ completionPolicy: "supervised", tasks: taskIds.map((taskId) => ({ taskId, status: "running" })) }) },
    },
  ];
  const view = reduceRuntimeEvents(baseEvents, createRuntimeView());
  expect(chatAgentBatches(view, { sessionId })[0]?.integration).toMatchObject({
    completionPolicy: "supervised",
    status: "pending",
    evidence: "results_ready",
  });

  reduceRuntimeEvents([
    {
      id: "event_inline_supervised_partial_wait",
      type: "tool.call_started",
      time: 9 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_supervised_partial_wait" as TurnId, callId: "call_inline_supervised_partial_wait" as ToolCallId, toolName: "task_wait_batch", input: { batchId, taskIds: [taskIds[0]], waitFor: "all" } },
    },
    {
      id: "event_inline_supervised_partial_wait_done",
      type: "tool.call_finished",
      time: 10 as TimestampMs,
      sessionId,
      payload: { callId: "call_inline_supervised_partial_wait" as ToolCallId, status: "completed", output: JSON.stringify({ tasks: [{ taskId: taskIds[0], status: "completed" }] }) },
    },
  ], view);
  expect(chatAgentBatches(view, { sessionId })[0]?.integration.status).toBe("pending");

  reduceRuntimeEvents([
    {
      id: "event_inline_supervised_full_wait",
      type: "tool.call_started",
      time: 11 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_inline_supervised_full_wait" as TurnId, callId: "call_inline_supervised_full_wait" as ToolCallId, toolName: "task_wait_batch", input: { batchId, taskIds, waitFor: "all" } },
    },
    {
      id: "event_inline_supervised_full_wait_done",
      type: "tool.call_finished",
      time: 12 as TimestampMs,
      sessionId,
      payload: { callId: "call_inline_supervised_full_wait" as ToolCallId, status: "completed", output: JSON.stringify({ tasks: taskIds.map((taskId) => ({ taskId, status: "completed" })) }) },
    },
  ], view);
  expect(chatAgentBatches(view, { sessionId })[0]?.integration).toMatchObject({
    completionPolicy: "supervised",
    status: "ready",
    evidence: "tool_result",
    turnId: "turn_inline_supervised_full_wait",
  });

  reduceRuntimeEvents([
    {
      id: "event_inline_supervised_followup",
      type: "tool.call_started",
      time: 13 as TimestampMs,
      sessionId,
      payload: {
        turnId: "turn_inline_supervised_followup" as TurnId,
        callId: "call_inline_supervised_followup" as ToolCallId,
        toolName: "task_followup",
        input: { taskId: taskIds[0], prompt: "Recheck the first result." },
      },
    },
    ...inlineTaskStartEvents({
      id: "inline_supervised_followup",
      createdAt: 3,
      spawnedAt: 14,
      sessionId,
      callId,
      batchId,
      batchIndex: 0,
      expectedBatchSize: 2,
      completionPolicy: "supervised",
      taskId: taskIds[0]!,
      path: "/root/supervised-0" as AgentPath,
      taskName: "supervised 0",
      prompt: "supervise 0",
      runId: "run_inline_supervised_followup" as AgentRunId,
      generation: 4,
      includeCreated: false,
    }),
    ...inlineTaskTerminalEvents({
      id: "inline_supervised_followup_terminal",
      time: 15,
      sessionId,
      taskId: taskIds[0]!,
      path: "/root/supervised-0" as AgentPath,
      runId: "run_inline_supervised_followup" as AgentRunId,
      generation: 4,
      status: "completed",
      summary: "supervised 0 rechecked",
    }),
    {
      id: "event_inline_supervised_followup_done",
      type: "tool.call_finished",
      time: 16 as TimestampMs,
      sessionId,
      payload: {
        callId: "call_inline_supervised_followup" as ToolCallId,
        status: "completed",
        output: JSON.stringify({ taskId: taskIds[0], status: "completed", generation: 4 }),
      },
    },
  ], view);
  const invalidated = chatAgentBatches(view, { sessionId })[0];
  expect(invalidated?.agents[0]).toMatchObject({ taskId: taskIds[0], turns: 2, followupCount: 1 });
  expect(invalidated?.integration).toMatchObject({
    completionPolicy: "supervised",
    status: "pending",
    evidence: "results_ready",
  });

  reduceRuntimeEvents([
    {
      id: "event_inline_supervised_reconfirmed_wait",
      type: "tool.call_started",
      time: 17 as TimestampMs,
      sessionId,
      payload: {
        turnId: "turn_inline_supervised_reconfirmed_wait" as TurnId,
        callId: "call_inline_supervised_reconfirmed_wait" as ToolCallId,
        toolName: "task_wait_batch",
        input: { batchId, taskIds, waitFor: "all" },
      },
    },
    {
      id: "event_inline_supervised_reconfirmed_wait_done",
      type: "tool.call_finished",
      time: 18 as TimestampMs,
      sessionId,
      payload: {
        callId: "call_inline_supervised_reconfirmed_wait" as ToolCallId,
        status: "completed",
        output: JSON.stringify({ tasks: taskIds.map((taskId) => ({ taskId, status: "completed" })) }),
      },
    },
  ], view);
  expect(chatAgentBatches(view, { sessionId })[0]?.integration).toMatchObject({
    completionPolicy: "supervised",
    status: "ready",
    evidence: "tool_result",
    turnId: "turn_inline_supervised_reconfirmed_wait",
  });

  const singleSessionId = "session_inline_supervised_single" as SessionId;
  const singleCallId = "call_inline_supervised_single" as ToolCallId;
  const singleTaskId = "task_inline_supervised_single" as TaskId;
  const singlePath = "/root/supervised-single" as AgentPath;
  const singleView = reduceRuntimeEvents([
    {
      id: "event_inline_supervised_single_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId: singleSessionId,
      payload: { sessionId: singleSessionId, cwd: "/repo" },
    },
    {
      id: "event_inline_supervised_single_batch",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId: singleSessionId,
      payload: {
        turnId: "turn_inline_supervised_single" as TurnId,
        callId: singleCallId,
        toolName: "task_batch",
        input: { completionPolicy: "supervised", tasks: [{ description: "single", prompt: "supervise single" }] },
      },
    },
    ...inlineTaskStartEvents({
      id: "inline_supervised_single",
      createdAt: 3,
      spawnedAt: 4,
      sessionId: singleSessionId,
      callId: singleCallId,
      batchId: "batch_inline_supervised_single",
      batchIndex: 0,
      expectedBatchSize: 1,
      completionPolicy: "supervised",
      taskId: singleTaskId,
      path: singlePath,
      taskName: "single supervised",
      prompt: "supervise single",
      runId: "run_inline_supervised_single" as AgentRunId,
      generation: 2,
    }),
    ...inlineTaskTerminalEvents({
      id: "inline_supervised_single_terminal",
      time: 5,
      sessionId: singleSessionId,
      taskId: singleTaskId,
      path: singlePath,
      runId: "run_inline_supervised_single" as AgentRunId,
      generation: 2,
      status: "completed",
      summary: "single done",
    }),
    {
      id: "event_inline_supervised_single_finished",
      type: "tool.call_finished",
      time: 6 as TimestampMs,
      sessionId: singleSessionId,
      payload: { callId: singleCallId, status: "completed", output: JSON.stringify({ tasks: [{ taskId: singleTaskId, status: "running" }] }) },
    },
    {
      id: "event_inline_supervised_single_wait",
      type: "tool.call_started",
      time: 7 as TimestampMs,
      sessionId: singleSessionId,
      payload: { turnId: "turn_inline_supervised_single_wait" as TurnId, callId: "call_inline_supervised_single_wait" as ToolCallId, toolName: "task_wait", input: { taskId: singleTaskId } },
    },
    {
      id: "event_inline_supervised_single_wait_done",
      type: "tool.call_finished",
      time: 8 as TimestampMs,
      sessionId: singleSessionId,
      payload: { callId: "call_inline_supervised_single_wait" as ToolCallId, status: "completed", output: JSON.stringify({ taskId: singleTaskId, status: "completed" }) },
    },
  ], createRuntimeView());
  expect(chatAgentBatches(singleView, { sessionId: singleSessionId })[0]?.integration).toMatchObject({
    completionPolicy: "supervised",
    status: "pending",
    evidence: "results_ready",
  });
});

function inlineTaskStartEvents(input: {
  id: string;
  createdAt: number;
  spawnedAt: number;
  sessionId: SessionId;
  callId: ToolCallId;
  batchId?: string;
  batchIndex?: number;
  expectedBatchSize?: number;
  completionPolicy: "join" | "notify" | "detached" | "supervised";
  maxConcurrency?: number;
  taskId: TaskId;
  path: AgentPath;
  taskName: string;
  prompt: string;
  runId: AgentRunId;
  generation: number;
  includeCreated?: boolean;
}): ChiliEvent[] {
  const scheduling = {
    sourceCallId: input.callId,
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.batchIndex === undefined ? {} : { batchIndex: input.batchIndex }),
    ...(input.expectedBatchSize === undefined ? {} : { expectedBatchSize: input.expectedBatchSize }),
    completionPolicy: input.completionPolicy,
    ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
  };
  const childSessionId = `session_${input.id}` as SessionId;
  const created: ChiliEvent = {
    id: `event_${input.id}_created`,
    type: "agent.task_created",
    time: input.createdAt as TimestampMs,
    sessionId: input.sessionId,
    payload: {
      taskId: input.taskId,
      path: input.path,
      parentPath: "/root" as AgentPath,
      parentSessionId: input.sessionId,
      childSessionId,
      taskName: input.taskName,
      cwd: "/repo",
      prompt: input.prompt,
      mode: "background",
      ...scheduling,
    },
  };
  const spawned: ChiliEvent = {
    id: `event_${input.id}_spawned`,
    type: "agent.spawned",
    time: input.spawnedAt as TimestampMs,
    sessionId: input.sessionId,
    payload: {
      runId: input.runId,
      taskId: input.taskId,
      path: input.path,
      parentPath: "/root" as AgentPath,
      parentSessionId: input.sessionId,
      childSessionId,
      taskName: input.taskName,
      mode: "background",
      generation: input.generation,
      ...scheduling,
    },
  };
  return input.includeCreated === false ? [spawned] : [created, spawned];
}

function inlineTaskTerminalEvents(input: {
  id: string;
  time: number;
  sessionId: SessionId;
  taskId: TaskId;
  path: AgentPath;
  runId: AgentRunId;
  generation: number;
  status: "completed" | "incomplete" | "failed" | "cancelled";
  summary?: string;
  error?: string;
}): ChiliEvent[] {
  const detail = {
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
  return [
    {
      id: `event_${input.id}_agent_completed`,
      type: "agent.completed",
      time: input.time as TimestampMs,
      sessionId: input.sessionId,
      payload: {
        runId: input.runId,
        taskId: input.taskId,
        path: input.path,
        generation: input.generation,
        status: input.status,
        ...detail,
      },
    },
    {
      id: `event_${input.id}_task_completed`,
      type: "agent.task_completed",
      time: input.time as TimestampMs,
      sessionId: input.sessionId,
      payload: {
        runId: input.runId,
        taskId: input.taskId,
        path: input.path,
        generation: input.generation,
        status: input.status,
        ...detail,
      },
    },
  ];
}

function agentTaskCreatedEvent(input: {
  id: string;
  time: number;
  sessionId: SessionId;
  taskId: TaskId;
  path?: AgentPath;
  childSessionId?: SessionId;
  sourceCallId?: ToolCallId;
  batchId?: string;
  batchIndex?: number;
  expectedBatchSize?: number;
}): ChiliEvent {
  const path = input.path ?? (`/root/${input.taskId}` as AgentPath);
  const childSessionId = input.childSessionId ?? (`session_${input.taskId}` as SessionId);
  return {
    id: input.id,
    type: "agent.task_created",
    time: input.time as TimestampMs,
    sessionId: input.sessionId,
    payload: {
      taskId: input.taskId,
      path,
      parentPath: "/root" as AgentPath,
      parentSessionId: input.sessionId,
      childSessionId,
      taskName: String(input.taskId),
      cwd: "/repo",
      prompt: "inspect",
      mode: "background",
      ...(input.sourceCallId ? { sourceCallId: input.sourceCallId } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.batchIndex === undefined ? {} : { batchIndex: input.batchIndex }),
      ...(input.expectedBatchSize === undefined ? {} : { expectedBatchSize: input.expectedBatchSize }),
    },
  };
}

test("projects subagent runs, mailbox messages, and team tasks", () => {
  const sessionId = "session_agents" as SessionId;
  const rootRunId = "agentrun_root" as AgentRunId;
  const childRunId = "agentrun_child" as AgentRunId;
  const teamId = "team_agents" as TeamId;
  const taskId = "task_review" as TaskId;
  const rootPath = "/root" as AgentPath;
  const childPath = "/root/reviewer" as AgentPath;

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
      type: "agent.spawned",
      time: 2 as TimestampMs,
      sessionId,
      payload: { runId: rootRunId, path: rootPath, taskName: "lead" },
    },
    {
      id: "event_3",
      type: "agent.spawned",
      time: 3 as TimestampMs,
      sessionId,
      payload: { runId: childRunId, path: childPath, parentPath: rootPath, taskName: "review" },
    },
    {
      id: "event_team_created",
      type: "team.created",
      time: 3 as TimestampMs,
      sessionId,
      payload: { teamId, name: "agents", leadPath: rootPath, description: "projection team" },
    },
    {
      id: "event_team_member_lead",
      type: "team.member_added",
      time: 3 as TimestampMs,
      sessionId,
      payload: { teamId, path: rootPath, name: "team-lead", role: "leader", status: "running" },
    },
    {
      id: "event_team_member_child",
      type: "team.member_added",
      time: 3 as TimestampMs,
      sessionId,
      payload: { teamId, path: childPath, name: "reviewer", role: "reviewer", status: "idle", toolScope: ["read"] },
    },
    {
      id: "event_4",
      type: "team.task_created",
      time: 4 as TimestampMs,
      sessionId,
      payload: { teamId, taskId, title: "Review projection", ownerPath: childPath },
    },
    {
      id: "event_team_task_claimed",
      type: "team.task_claimed",
      time: 4 as TimestampMs,
      sessionId,
      payload: { teamId, taskId, ownerPath: childPath, claimedBy: childPath },
    },
    {
      id: "event_5",
      type: "agent.message_queued",
      time: 5 as TimestampMs,
      sessionId,
      payload: {
        path: childPath,
        from: rootPath,
        triggerTurn: true,
        recipientSessionId: "session_projection_recipient" as SessionId,
        message: {
          role: "user",
          content: "Please review projection",
          metadata: { teamId, teamMessageId: "teammsg_projection", teamMessageKind: "task_assignment" },
        },
      },
    },
    {
      id: "event_6",
      type: "agent.message_consumed",
      time: 6 as TimestampMs,
      sessionId,
      payload: { messageId: "event_5", path: childPath },
    },
    {
      id: "event_team_message",
      type: "team.message_sent",
      time: 6 as TimestampMs,
      sessionId,
      payload: {
        teamId,
        messageId: "teammsg_projection",
        from: rootPath,
        to: childPath,
        content: "Please review projection",
        kind: "task_assignment",
        delivery: "queueOnly",
        taskId,
      },
    },
    {
      id: "event_7",
      type: "team.task_updated",
      time: 7 as TimestampMs,
      sessionId,
      payload: { teamId, taskId, status: "completed" },
    },
    {
      id: "event_8",
      type: "agent.completed",
      time: 8 as TimestampMs,
      sessionId,
      payload: { runId: childRunId, path: childPath, status: "completed" },
    },
  ];

  const view = reduceRuntimeEvents(events, createRuntimeView());
  const snapshot = runtimeAgentsSnapshot(view, sessionId);

  expect(view.sessions[sessionId]?.agentRunIds).toEqual([rootRunId, childRunId]);
  expect(view.agents[rootRunId]?.childRunIds).toEqual([childRunId]);
  expect(view.agents[childRunId]?.mailboxMessageIds).toEqual(["event_5"]);
  expect(view.agents[childRunId]?.taskIds).toEqual([taskId]);
  expect(view.teams[teamId]).toMatchObject({
    id: teamId,
    name: "agents",
    leadPath: rootPath,
    description: "projection team",
    memberIds: [`${teamId}:${rootPath}`, `${teamId}:${childPath}`],
    taskIds: [taskId],
    messageIds: ["teammsg_projection"],
  });
  expect(view.teamMembers[`${teamId}:${childPath}`]).toMatchObject({
    teamId,
    path: childPath,
    name: "reviewer",
    role: "reviewer",
    status: "running",
    currentTaskId: taskId,
    toolScope: ["read"],
  });
  expect(view.teamMessages.teammsg_projection).toMatchObject({
    teamId,
    from: rootPath,
    to: childPath,
    kind: "task_assignment",
    delivery: "queueOnly",
    deliveryStatus: "delivered",
    deliveredAt: 6,
    taskId,
  });
  expect(view.tasks[taskId]?.status).toBe("completed");
  expect(view.tasks[taskId]?.title).toBe("Review projection");
  expect(view.tasks[taskId]?.completedAt).toBe(7);
  expect(snapshot.agents.map((agent) => agent.id)).toEqual([rootRunId, childRunId]);
  expect(snapshot.mailbox[0]?.triggerTurn).toBe(true);
  expect(snapshot.mailbox[0]?.recipientSessionId).toBe("session_projection_recipient" as SessionId);
  expect(snapshot.mailbox[0]?.status).toBe("consumed");
  expect(snapshot.mailbox[0]?.consumedAt).toBe(6);
});

test("upcasts a legacy queued mailbox child session to the canonical recipient field", () => {
  const recipientSessionId = "session_legacy_mailbox_recipient" as SessionId;
  const legacyEvent = {
    id: "event_legacy_mailbox_recipient",
    type: "agent.message_queued",
    time: 1 as TimestampMs,
    sessionId: "session_legacy_mailbox_sender" as SessionId,
    payload: {
      path: "/root/legacy" as AgentPath,
      from: "/root" as AgentPath,
      triggerTurn: true,
      childSessionId: recipientSessionId,
    },
  } as unknown as ChiliEvent;

  const view = reduceRuntimeEvents([legacyEvent], createRuntimeView());
  const message = view.mailboxMessages.event_legacy_mailbox_recipient;
  expect(message?.recipientSessionId).toBe(recipientSessionId);
  expect(Object.prototype.hasOwnProperty.call(message, "childSessionId")).toBe(false);
});

test("projects team run lifecycle events into run view models", () => {
  const sessionId = "session_team_run" as SessionId;
  const teamId = "team_run_projection" as TeamId;
  const leadPath = "/root" as AgentPath;
  const runCounts = teamRunCounts({ dispatched: 2, completed: 1, stillRunning: 1 });

  const view = reduceRuntimeEvents(
    [
      {
        id: "event_team",
        type: "team.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { teamId, name: "runner", leadPath },
      },
      {
        id: "event_run_start",
        type: "team.run_started",
        time: 2 as TimestampMs,
        sessionId,
        payload: {
          teamId,
          runId: "teamrun_test",
          mode: "background",
          once: false,
          maxCycles: 5,
          timeoutMs: 1000,
          pollIntervalMs: 50,
          maxConcurrentDispatches: 6,
          maxConcurrentVerifications: 3,
        },
      },
      {
        id: "event_run_progress",
        type: "team.run_progress",
        time: 3 as TimestampMs,
        sessionId,
        payload: { teamId, runId: "teamrun_test", cycle: 1, phase: "dispatch", counts: runCounts },
      },
      {
        id: "event_run_complete",
        type: "team.run_completed",
        time: 4 as TimestampMs,
        sessionId,
        payload: {
          teamId,
          runId: "teamrun_test",
          cycles: 1,
          stopReason: "once",
          startedAt: 2,
          endedAt: 4,
          counts: teamRunCounts({ dispatched: 2, completed: 2 }),
        },
      },
    ],
    createRuntimeView(),
  );

  expect(view.teams[teamId]?.runIds).toEqual(["teamrun_test"]);
  expect(view.teams[teamId]?.activeRunId).toBeUndefined();
  expect(view.teams[teamId]?.lastCompletedRunId).toBe("teamrun_test");
  expect(view.teamRuns.teamrun_test).toMatchObject({
    teamId,
    status: "completed",
    cycle: 1,
    phase: "dispatch",
    stopReason: "once",
    startedAt: 2,
    endedAt: 4,
    maxConcurrentDispatches: 6,
    maxConcurrentVerifications: 3,
    counts: { dispatched: 2, completed: 2 },
  });
});

test("derives Team Live cockpit view from team projection state", () => {
  const sessionId = "session_team_live" as SessionId;
  const otherSessionId = "session_team_live_other" as SessionId;
  const childSessionId = "session_team_live_child" as SessionId;
  const verifierSessionId = "session_team_live_verifier" as SessionId;
  const teamId = "team_live" as TeamId;
  const otherTeamId = "team_live_other" as TeamId;
  const taskId = "task_live" as TaskId;
  const verifierTaskId = "task_verify_live" as TaskId;
  const conflictedTaskId = "task_merge_conflict" as TaskId;
  const failedMergeTaskId = "task_merge_failed" as TaskId;
  const appliedMergeTaskId = "task_merge_applied" as TaskId;
  const leadPath = "/root" as AgentPath;
  const memberPath = "/root/worker" as AgentPath;
  const callId = "toolcall_live" as ToolCallId;
  const approvalId = "approval_live" as ApprovalId;
  const childApprovalId = "approval_live_child" as ApprovalId;
  const resolvedApprovalId = "approval_live_resolved" as ApprovalId;

  const view = reduceRuntimeEvents(
    [
      {
        id: "event_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: "event_other_team",
        type: "team.created",
        time: 2 as TimestampMs,
        sessionId: otherSessionId,
        payload: { teamId: otherTeamId, name: "other", leadPath },
      },
      {
        id: "event_team",
        type: "team.created",
        time: 3 as TimestampMs,
        sessionId,
        payload: { teamId, name: "live", leadPath },
      },
      {
        id: "event_lead",
        type: "team.member_added",
        time: 3 as TimestampMs,
        sessionId,
        payload: { teamId, path: leadPath, name: "lead", role: "leader", status: "running" },
      },
      {
        id: "event_member",
        type: "team.member_added",
        time: 4 as TimestampMs,
        sessionId,
        payload: {
          teamId,
          path: memberPath,
          name: "worker",
          role: "builder",
          status: "idle",
          childSessionId,
          toolScope: ["read_file"],
          writeScope: ["packages/sdk"],
        },
      },
      {
        id: "event_task",
        type: "team.task_created",
        time: 5 as TimestampMs,
        sessionId,
        payload: {
          teamId,
          taskId,
          title: "Build live cockpit",
          ownerPath: memberPath,
          metadata: {
            chiliTeamDispatch: { agentTaskId: "task_agent_live", agentStatus: "running", childSessionId },
            verification: { status: "pending", verifierTaskId },
            worktree: { path: "/repo/.chili/worktrees/live", baseRef: "HEAD", createdAt: 5, status: "active" },
            merge: { status: "pending", createdAt: 6, worktreePath: "/repo/.chili/worktrees/live" },
          },
        },
      },
      {
        id: "event_verifier_task",
        type: "agent.task_created",
        time: 5 as TimestampMs,
        sessionId,
        payload: {
          taskId: verifierTaskId,
          path: "/root/worker/verifier" as AgentPath,
          parentPath: memberPath,
          parentSessionId: sessionId,
          childSessionId: verifierSessionId,
          taskName: "Verify live cockpit",
          cwd: "/repo",
          prompt: "verify",
        },
      },
      {
        id: "event_conflicted_merge_task",
        type: "team.task_created",
        time: 5 as TimestampMs,
        sessionId,
        payload: {
          teamId,
          taskId: conflictedTaskId,
          title: "Conflicted merge",
          ownerPath: memberPath,
          status: "completed",
          metadata: { merge: { status: "conflicted", createdAt: 5, mergedAt: 9, error: "conflict", conflicts: ["src/a.ts"] } },
        },
      },
      {
        id: "event_failed_merge_task",
        type: "team.task_created",
        time: 5 as TimestampMs,
        sessionId,
        payload: {
          teamId,
          taskId: failedMergeTaskId,
          title: "Failed merge",
          ownerPath: memberPath,
          status: "completed",
          metadata: { merge: { status: "failed", createdAt: 5, mergedAt: 10, error: "apply failed" } },
        },
      },
      {
        id: "event_applied_merge_task",
        type: "team.task_created",
        time: 5 as TimestampMs,
        sessionId,
        payload: {
          teamId,
          taskId: appliedMergeTaskId,
          title: "Applied merge",
          ownerPath: memberPath,
          status: "completed",
          metadata: { merge: { status: "applied", createdAt: 5, mergedAt: 11 } },
        },
      },
      {
        id: "event_claim",
        type: "team.task_claimed",
        time: 6 as TimestampMs,
        sessionId,
        payload: { teamId, taskId, ownerPath: memberPath, claimedBy: memberPath },
      },
      {
        id: "event_message",
        type: "team.message_sent",
        time: 7 as TimestampMs,
        sessionId,
        payload: {
          teamId,
          messageId: "teammsg_live",
          from: leadPath,
          to: memberPath,
          content: "Build the cockpit",
          kind: "task_assignment",
          delivery: "triggerTurn",
          taskId,
        },
      },
      {
        id: "event_mailbox",
        type: "agent.message_queued",
        time: 8 as TimestampMs,
        sessionId,
        payload: {
          path: memberPath,
          from: leadPath,
          triggerTurn: true,
          taskId,
          recipientSessionId: childSessionId,
          message: {
            role: "user",
            content: "Build the cockpit",
            metadata: { teamId, teamMessageId: "teammsg_live" },
          },
        },
      },
      {
        id: "event_run_start",
        type: "team.run_started",
        time: 9 as TimestampMs,
        sessionId,
        payload: {
          teamId,
          runId: "teamrun_live",
          mode: "background",
          once: false,
          maxCycles: 4,
          timeoutMs: 1000,
          pollIntervalMs: 100,
          maxConcurrentDispatches: 4,
          maxConcurrentVerifications: 2,
        },
      },
      {
        id: "event_run_progress",
        type: "team.run_progress",
        time: 10 as TimestampMs,
        sessionId,
        payload: { teamId, runId: "teamrun_live", cycle: 1, phase: "dispatch", counts: teamRunCounts({ dispatched: 1 }) },
      },
      {
        id: "event_child_turn",
        type: "turn.started",
        time: 11 as TimestampMs,
        sessionId: childSessionId,
        payload: { turnId: "turn_live" as TurnId },
      },
      {
        id: "event_tool",
        type: "tool.call_started",
        time: 11 as TimestampMs,
        sessionId: childSessionId,
        payload: { turnId: "turn_live" as TurnId, callId, toolName: "read_file", input: { path: "README.md" } },
      },
      {
        id: "event_approval",
        type: "approval.requested",
        time: 12 as TimestampMs,
        sessionId,
        payload: { approvalId, callId, permission: "tool.edit", patterns: ["packages/sdk/*"] },
      },
      {
        id: "event_child_approval",
        type: "approval.requested",
        time: 13 as TimestampMs,
        sessionId: childSessionId,
        payload: { approvalId: childApprovalId, callId, permission: "tool.bash", patterns: ["bun test"] },
      },
      {
        id: "event_resolved_approval",
        type: "approval.requested",
        time: 14 as TimestampMs,
        sessionId: childSessionId,
        payload: { approvalId: resolvedApprovalId, callId, permission: "tool.read", patterns: ["README.md"] },
      },
      {
        id: "event_resolved_approval_done",
        type: "approval.resolved",
        time: 15 as TimestampMs,
        sessionId: childSessionId,
        payload: { approvalId: resolvedApprovalId, decision: "allow_once" },
      },
    ],
    createRuntimeView(),
  );

  const cockpit = teamLiveCockpit(view, { teamId, sessionId, limit: 10 });

  expect(cockpit.teamIds).toEqual([teamId]);
  expect(cockpit.team?.name).toBe("live");
  expect(cockpit.lead?.path).toBe(leadPath);
  expect(cockpit.members.map((member) => member.path)).toEqual([leadPath, memberPath]);
  expect(cockpit.members.find((member) => member.path === memberPath)).toMatchObject({
    status: "running",
    currentTaskId: taskId,
    currentTaskTitle: "Build live cockpit",
    deliveryIds: ["event_mailbox"],
  });
  expect(cockpit.activeRun).toMatchObject({
    id: "teamrun_live",
    phase: "dispatch",
    counts: { dispatched: 1 },
  });
  expect(cockpit.tasks[0]).toMatchObject({
    id: taskId,
    status: "in_progress",
    ownerName: "worker",
    metadata: {
      dispatch: { agentTaskId: "task_agent_live" },
      verification: { status: "pending" },
      worktree: { status: "active" },
      merge: { status: "pending" },
    },
  });
  expect(cockpit.pendingApprovals.map((approval) => approval.id)).toEqual([approvalId, childApprovalId]);
  expect(cockpit.mailbox[0]).toMatchObject({
    id: "event_mailbox",
    status: "queued",
    deliveryStatus: "queued",
    taskId,
  });
  expect(view.mailboxMessages.event_mailbox?.recipientSessionId).toBe(childSessionId);
  expect(cockpit.toolCounts).toEqual([{ toolName: "read_file", total: 1, running: 1, completed: 0, failed: 0 }]);
  expect(cockpit.metadata.worktrees).toHaveLength(1);
  expect(cockpit.recentActivity.map((item) => item.kind)).toContain("run");
  expect(cockpit.recentActivity.find((item) => item.kind === "run")).toMatchObject({
    label: "run dispatch",
    detail: "cycle:1 fanout:4 verify:2 dispatched:1",
  });
  expect(cockpit.recentActivity.map((item) => item.kind)).toContain("tool");
  expect(cockpit.recentActivity.map((item) => item.id)).toContain(childApprovalId);
  expect(teamLiveCockpit(view, { teamId: otherTeamId, sessionId }).team).toBeUndefined();

  const live = teamLiveView(view, { teamId, sessionId, limit: 20, connection: { status: "streaming" } });
  expect(live.scope.teamIds).toEqual([teamId]);
  expect(live.selectedTeamId).toBe(teamId);
  expect(live.scope.sessionIds).toContain(sessionId);
  expect(live.scope.sessionIds).toContain(childSessionId);
  expect(live.scope.sessionIds).toContain(verifierSessionId);
  expect(live.selected?.pendingApprovals.map((approval) => approval.id)).toEqual([childApprovalId, approvalId]);
  expect(live.selected?.pendingApprovals.map((approval) => approval.id)).not.toContain(resolvedApprovalId);
  expect(live.selected?.activeTools.map((tool) => tool.id)).toEqual([callId]);
  expect(live.selected?.mergeQueue.map((merge) => merge.status).sort()).toEqual(["applied", "conflicted", "failed", "pending"]);
  expect(live.selected?.recentActivity.map((item) => item.kind)).toContain("verifier");
  expect(live.selected?.recentActivity.map((item) => item.kind)).toContain("merge");
  expect(live.selected?.recentActivity.find((item) => item.id === "teammsg_live")).toMatchObject({
    kind: "message",
    teamMessageId: "teammsg_live",
    from: leadPath,
    to: memberPath,
  });
  expect(live.selected?.recentActivity.find((item) => item.id === "event_mailbox")).toMatchObject({
    kind: "mailbox",
    teamMessageId: "teammsg_live",
    from: leadPath,
    to: memberPath,
  });
  expect(live.selected?.recentActivity).toContainEqual(
    expect.objectContaining({ id: resolvedApprovalId, kind: "approval", status: "resolved" }),
  );
  expect(live.selected?.availableActions).toContainEqual({ type: "run_loop", teamId, enabled: false, reason: "run_active" });
  expect(live.selected?.availableActions).toContainEqual({ type: "merge", teamId, taskId, enabled: true });
  expect(live.selected?.availableActions).toContainEqual({ type: "approve", approvalId: childApprovalId, sessionId: childSessionId, enabled: true });
  expect(live.selected?.availableActions).toContainEqual({ type: "interrupt", sessionId: childSessionId, enabled: true });
  expect(teamLiveView(view, { teamId: otherTeamId, sessionId }).selected).toBeUndefined();
});

test("Team Live v1 scopes selected teams through run sessions without falling back to global tools", () => {
  const teamId = "team_run_scoped" as TeamId;
  const emptyTeamId = "team_empty_scope" as TeamId;
  const runSessionId = "session_run_scoped" as SessionId;
  const otherSessionId = "session_run_other" as SessionId;
  const leadPath = "/root" as AgentPath;
  const callId = "tool_run_scoped" as ToolCallId;
  const otherCallId = "tool_run_other" as ToolCallId;
  const approvalId = "approval_run_scoped" as ApprovalId;
  const otherApprovalId = "approval_run_other" as ApprovalId;

  const view = reduceRuntimeEvents(
    [
      {
        id: "event_run_scoped_team",
        type: "team.created",
        time: 1 as TimestampMs,
        payload: { teamId, name: "run scoped", leadPath },
      },
      {
        id: "event_empty_scope_team",
        type: "team.created",
        time: 1 as TimestampMs,
        payload: { teamId: emptyTeamId, name: "empty scoped", leadPath },
      },
      {
        id: "event_run_scoped_start",
        type: "team.run_started",
        time: 2 as TimestampMs,
        sessionId: runSessionId,
        payload: { teamId, runId: "teamrun_scoped" },
      },
      {
        id: "event_run_scoped_tool",
        type: "tool.call_started",
        time: 3 as TimestampMs,
        sessionId: runSessionId,
        payload: { turnId: "turn_run_scoped" as TurnId, callId, toolName: "read_file", input: { path: "README.md" } },
      },
      {
        id: "event_run_scoped_approval",
        type: "approval.requested",
        time: 4 as TimestampMs,
        sessionId: runSessionId,
        payload: { approvalId, callId, permission: "tool.read", patterns: ["README.md"] },
      },
      {
        id: "event_other_tool",
        type: "tool.call_started",
        time: 5 as TimestampMs,
        sessionId: otherSessionId,
        payload: { turnId: "turn_run_other" as TurnId, callId: otherCallId, toolName: "bash", input: { command: "bun test" } },
      },
      {
        id: "event_other_approval",
        type: "approval.requested",
        time: 6 as TimestampMs,
        sessionId: otherSessionId,
        payload: { approvalId: otherApprovalId, callId: otherCallId, permission: "tool.bash", patterns: ["bun test"] },
      },
    ],
    createRuntimeView(),
  );

  const live = teamLiveView(view, { teamId });
  expect(live.scope.sessionIds).toEqual([runSessionId]);
  expect(live.selected?.activeTools.map((tool) => tool.id)).toEqual([callId]);
  expect(live.selected?.pendingApprovals.map((approval) => approval.id)).toEqual([approvalId]);
  expect(live.selected?.recentActivity.map((item) => item.id)).toContain(approvalId);
  expect(live.selected?.recentActivity.map((item) => item.id)).not.toContain(otherApprovalId);
  expect(live.selected?.availableActions).toContainEqual({ type: "run_loop", teamId, enabled: false, reason: "run_active" });

  const emptyScope = teamLiveView(view, { teamId: emptyTeamId });
  expect(emptyScope.scope.sessionIds).toEqual([]);
  expect(emptyScope.selected?.activeTools).toEqual([]);
  expect(emptyScope.selected?.pendingApprovals).toEqual([]);
  expect(emptyScope.selected?.recentActivity.map((item) => item.id)).not.toContain(otherApprovalId);
  expect(emptyScope.selected?.recentActivity.map((item) => item.id)).not.toContain(otherCallId);
});

test("Team Live v1 exposes disabled actions for no-team and inactive-team states", () => {
  const empty = teamLiveView(createRuntimeView());
  expect(empty.selected).toBeUndefined();
  expect(empty.availableActions).toContainEqual({ type: "run_loop", enabled: false, reason: "no_team" });

  const sessionId = "session_team_inactive" as SessionId;
  const teamId = "team_inactive" as TeamId;
  const view = reduceRuntimeEvents(
    [
      {
        id: "event_inactive_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: "event_inactive_team",
        type: "team.created",
        time: 2 as TimestampMs,
        sessionId,
        payload: { teamId, name: "inactive", leadPath: "/root" as AgentPath },
      },
    ],
    createRuntimeView(),
  );
  const team = view.teams[teamId];
  if (!team) throw new Error("expected team");
  team.status = "archived";

  const live = teamLiveView(view, { teamId, sessionId });
  expect(live.selected?.availableActions).toContainEqual({ type: "run_loop", teamId, enabled: false, reason: "team_inactive" });
  expect(live.selected?.availableActions).toContainEqual({ type: "merge", teamId, enabled: false, reason: "no_pending_merge" });
  expect(live.selected?.availableActions).toContainEqual({ type: "interrupt", sessionId, enabled: false, reason: "session_idle" });
});

test("replays completed local subagent tasks as running on newer-generation spawn without completedAt", () => {
  const sessionId = "session_local_agents" as SessionId;
  const taskId = "task_local" as TaskId;
  const childSessionId = "session_child_local" as SessionId;
  const path = "/root/task_local" as AgentPath;

  const view = reduceRuntimeEvents(
    [
      {
        id: "event_task_created",
        type: "agent.task_created",
        time: 1 as TimestampMs,
        sessionId,
        payload: {
          taskId,
          path,
          parentPath: "/root" as AgentPath,
          parentSessionId: sessionId,
          childSessionId,
          taskName: "reader",
          cwd: "/repo",
          prompt: "read",
        },
      },
      {
        id: "event_task_completed",
        type: "agent.task_completed",
        time: 2 as TimestampMs,
        sessionId,
        payload: {
          taskId,
          path,
          status: "completed",
          generation: 1,
          summary: "done",
        },
      },
      {
        id: "event_agent_spawned",
        type: "agent.spawned",
        time: 3 as TimestampMs,
        sessionId,
        payload: {
          runId: "agent_local" as AgentRunId,
          taskId,
          path,
          parentPath: "/root" as AgentPath,
          parentSessionId: sessionId,
          childSessionId,
          taskName: "reader",
          generation: 2,
        },
      },
    ],
    createRuntimeView(),
  );

  expect(view.tasks[taskId]).toMatchObject({
    id: taskId,
    status: "running",
    generation: 2,
    path,
    sessionId,
    childSessionId,
  });
  expect(view.tasks[taskId]?.completedAt).toBeUndefined();
  expect(view.sessions[sessionId]?.taskIds).toEqual([taskId]);
});

test("client preserves team dispatcher JSON shapes for dispatch, sync, and reconcile", async () => {
  const teamId = "team_sdk" as TeamId;
  const taskId = "task_sdk" as TaskId;
  const sessionId = "session_sdk" as SessionId;
  const ownerPath = "/root/reviewer" as AgentPath;
  const teamTask = sdkTeamTaskJson({ teamId, taskId, status: "in_progress", ownerPath });
  const skippedTeamTask = sdkTeamTaskJson({ teamId, taskId, status: "pending", ownerPath, includeMetadata: false });
  const agentTask = sdkAgentTaskJson({ status: "running", ownerPath });
  const syncResult: RuntimeTeamTaskSyncResult = {
    applied: false,
    reason: "agent_running",
    teamTask,
    agentTask: sdkAgentTaskRecord({ status: "running" }),
  };
  const dispatchJson: RuntimeTeamTaskDispatchResult = {
    status: "running",
    teamTask,
    team_task: teamTask,
    agentTask,
    agent_task: agentTask,
  };
  const skippedDispatchJson: RuntimeTeamTaskDispatchResult = {
    status: "skipped",
    reason: "missing_owner",
    teamTask: skippedTeamTask,
    team_task: skippedTeamTask,
  };
  const reconcileJson: RuntimeTeamTaskReconcileResult = {
    scanned: 1,
    synced: [],
    skipped: [syncResult],
    errors: [],
  };
  const runLoopJson: RuntimeTeamExecutionRunSummary = {
    teamId,
    cycles: 1,
    stopReason: "once",
    startedAt: 100,
    endedAt: 110,
    maxConcurrentDispatches: 4,
    maxConcurrentVerifications: 2,
    dispatched: [{ teamId, taskId, ownerPath, agentTaskId: agentTask.taskId, status: "running" }],
    completed: [],
    accepted: [],
    reopened: [],
    merged: [],
    mergeFailed: [],
    mergeConflicted: [],
    mergeSkipped: [],
    failed: [],
    blocked: [],
    skipped: [],
    stillRunning: [{ teamId, taskId, ownerPath, agentTaskId: agentTask.taskId, title: "SDK team task" }],
    errors: [],
  };
  const mergeJson = {
    scanned: 1,
    applied: [],
    failed: [],
    conflicted: [],
    skipped: [],
    errors: [],
  };
  const responses: unknown[] = [dispatchJson, skippedDispatchJson, syncResult, reconcileJson, mergeJson, runLoopJson];
  const requests: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const responseBody = responses.shift();
    if (!responseBody) throw new Error("unexpected request");
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new HttpRuntimeClient({ baseUrl: "http://runtime.test/api", fetch: fetchImpl });

  expect(
    await client.dispatchTeamTask({
      teamId,
      taskId,
      ownerPath,
      sessionId,
      mode: "background",
      cwd: "/repo",
      prompt: "verify",
    }),
  ).toEqual(dispatchJson);
  expect(await client.dispatchTeamTask({ teamId, taskId, sessionId })).toEqual(skippedDispatchJson);
  expect(await client.syncTeamTask({ teamId, taskId, sessionId })).toEqual(syncResult);
  expect(await client.reconcileTeamTasks({ teamId, sessionId, limit: 5 })).toEqual(reconcileJson);
  expect(await client.mergeTeamTasks({ teamId, taskId, sessionId, cwd: "/repo" })).toEqual(mergeJson);
  expect(
    await client.runTeamLoop({
      teamId,
      sessionId,
      mode: "background",
      cwd: "/repo",
      once: true,
      maxCycles: 2,
      timeoutMs: 1000,
      pollIntervalMs: 10,
    }),
  ).toEqual(runLoopJson);
  expect(requests).toEqual([
    {
      url: "http://runtime.test/api/teams/team_sdk/tasks/task_sdk/dispatch",
      method: "POST",
      body: { teamId, taskId, ownerPath, sessionId, mode: "background", cwd: "/repo", prompt: "verify" },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/tasks/task_sdk/dispatch",
      method: "POST",
      body: { teamId, taskId, sessionId },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/tasks/task_sdk/sync",
      method: "POST",
      body: { teamId, taskId, sessionId },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/reconcile_dispatches",
      method: "POST",
      body: { teamId, sessionId, limit: 5 },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/merge",
      method: "POST",
      body: { teamId, taskId, sessionId, cwd: "/repo" },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/run_loop",
      method: "POST",
      body: {
        teamId,
        sessionId,
        mode: "background",
        cwd: "/repo",
        once: true,
        maxCycles: 2,
        timeoutMs: 1000,
        pollIntervalMs: 10,
      },
    },
  ]);
});

test("client can cancel team run and merge commands without serializing AbortSignal", async () => {
  const teamId = "team_sdk_abort" as TeamId;
  const controller = new AbortController();
  const records: { url: string; body: unknown; signalled: boolean }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    records.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signalled: init?.signal === controller.signal,
    });
    const url = String(input);
    const body = url.endsWith("/merge")
      ? ({
          scanned: 0,
          applied: [],
          failed: [],
          conflicted: [],
          skipped: [],
          errors: [],
        } satisfies RuntimeTeamMergeResult)
      : ({
        teamId,
        cycles: 0,
        stopReason: "aborted",
        startedAt: 1,
        endedAt: 1,
        dispatched: [],
        completed: [],
        accepted: [],
        reopened: [],
        merged: [],
        mergeFailed: [],
        mergeConflicted: [],
        mergeSkipped: [],
        failed: [],
        blocked: [],
        skipped: [],
        stillRunning: [],
        errors: [],
      } satisfies RuntimeTeamExecutionRunSummary);
    return new Response(
      JSON.stringify(body),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;
  const client = new HttpRuntimeClient({ baseUrl: "http://runtime.test/api", fetch: fetchImpl });

  await client.runTeamLoop({ teamId, once: true, signal: controller.signal });
  await client.mergeTeamTasks({ teamId, signal: controller.signal });

  expect(records).toEqual([
    {
      url: "http://runtime.test/api/teams/team_sdk_abort/run_loop",
      body: { teamId, once: true },
      signalled: true,
    },
    {
      url: "http://runtime.test/api/teams/team_sdk_abort/merge",
      body: { teamId },
      signalled: true,
    },
  ]);
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
        ? ({ commands: [], diagnostics: [], directories: [], skippedConflicts: [] })
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

  const models = await client.listModels();
  await client.getModelConfig({ sessionId });
  await client.setModel({ sessionId, modelSelection: { provider: "openai-codex", model: "gpt-5.5" } });
  await client.setReasoning({ sessionId, reasoningLevel: "high" });
  await client.listCommands();
  await client.reloadCommands();
  await client.submitPromptAsync({
    sessionId,
    text: "hello",
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
    reasoningLevel: "xhigh",
  });
  await client.submitCommandAsync({
    sessionId,
    name: "joke",
    args: "typescript",
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
    reasoningLevel: "high",
  });

  expect(models).toEqual([{
    provider: "codex-api",
    model: "gpt-5.5",
    connectionLabel: "Third-party API",
    authSource: "environment",
    endpoint: "https://gateway.example",
  }]);

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
      url: "http://runtime.test/api/commands",
      method: "GET",
      body: undefined,
    },
    {
      url: "http://runtime.test/api/commands/reload",
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
      url: "http://runtime.test/api/sessions/session_sdk_model/command_async",
      method: "POST",
      body: {
        name: "joke",
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

test("client fetches team snapshots through the runtime HTTP API", async () => {
  const teamId = "team_sdk_snapshot" as TeamId;
  const taskId = "task_sdk_snapshot" as TaskId;
  const ownerPath = "/root/reviewer" as AgentPath;
  const teamTask = sdkTeamTaskJson({ teamId, taskId, status: "pending", ownerPath, includeMetadata: false });
  const snapshot: RuntimeTeamSnapshot = {
    team: {
      id: teamId,
      name: "SDK snapshot",
      leadPath: "/root" as AgentPath,
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    },
    members: [
      {
        teamId,
        path: ownerPath,
        name: "reviewer",
        role: "reviewer",
        status: "idle",
        taskIds: [taskId],
        deliveryIds: ["mailbox_sdk_snapshot"],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    tasks: [
      {
        ...teamTask,
        blockedBy: [],
        blocks: [],
        ready: true,
        messageIds: ["teammsg_sdk_snapshot"],
      },
    ],
    messages: [
      {
        id: "teammsg_sdk_snapshot",
        teamId,
        fromPath: "/root" as AgentPath,
        toPath: ownerPath,
        content: "review",
        kind: "task_assignment",
        delivery: "triggerTurn",
        deliveryStatus: "queued",
        taskId,
        deliveries: [
          {
            mailboxMessageId: "mailbox_sdk_snapshot",
            teamId,
            teamMessageId: "teammsg_sdk_snapshot",
            path: ownerPath,
            status: "queued",
            triggerTurn: true,
            queuedAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 2,
      },
    ],
    messageDeliveries: [
      {
        mailboxMessageId: "mailbox_sdk_snapshot",
        teamId,
        teamMessageId: "teammsg_sdk_snapshot",
        path: ownerPath,
        status: "queued",
        triggerTurn: true,
        queuedAt: 2,
        updatedAt: 2,
      },
    ],
    stats: {
      memberCount: 1,
      taskCount: 1,
      messageCount: 1,
      deliveryCount: 1,
      membersByStatus: { idle: 1, running: 0, waiting: 0, blocked: 0, closed: 0 },
      tasksByStatus: { pending: 1, in_progress: 0, blocked: 0, completed: 0, failed: 0, cancelled: 0 },
      messagesByDeliveryStatus: { queued: 1 },
      deliveriesByStatus: { queued: 1 },
      readyTaskIds: [taskId],
      blockedTaskIds: [],
    },
    generatedAt: 3,
  };
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push({ url: input instanceof Request ? input.url : String(input), method: init?.method });
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new HttpRuntimeClient({ baseUrl: "http://runtime.test/api", fetch: fetchImpl });

  expect(await client.teamSnapshot(teamId)).toEqual(snapshot);
  expect(requests).toEqual([{ url: "http://runtime.test/api/teams/team_sdk_snapshot/snapshot", method: "GET" }]);
});

function sdkTeamTaskJson(input: {
  teamId: TeamId;
  taskId: TaskId;
  status: "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";
  ownerPath: AgentPath;
  includeMetadata?: boolean;
}): RuntimeTeamTaskRecord {
  return {
    id: input.taskId,
    teamId: input.teamId,
    title: "SDK team task",
    status: input.status,
    ownerPath: input.ownerPath,
    dependsOn: [],
    ...(input.includeMetadata === false
      ? {}
      : {
          metadata: {
            chiliTeamDispatch: {
              agentTaskId: "task_agent_sdk",
              agentPath: "/root/reviewer/task_agent_sdk",
              runId: "agentrun_agent_sdk",
              childSessionId: "session_child_sdk",
              mode: "background",
              dispatchedAt: 101,
              agentStatus: "running",
            },
          },
        }),
    createdAt: 1,
    updatedAt: 2,
  };
}

function sdkAgentTaskJson(input: {
  status: "running" | "completed" | "failed" | "cancelled";
  ownerPath: AgentPath;
}): RuntimeLocalSubagentTaskRecord {
  return {
    taskId: "task_agent_sdk" as TaskId,
    runId: "agentrun_agent_sdk" as AgentRunId,
    path: "/root/reviewer/task_agent_sdk" as AgentPath,
    parentPath: input.ownerPath,
    childSessionId: "session_child_sdk" as SessionId,
    status: input.status,
  };
}

function sdkAgentTaskRecord(input: { status: "running" | "completed" | "failed" | "cancelled" }): RuntimeAgentTaskRecord {
  return {
    id: "task_agent_sdk" as TaskId,
    path: "/root/reviewer/task_agent_sdk" as AgentPath,
    taskName: "SDK team task",
    status: input.status,
    generation: 0,
    childSessionId: "session_child_sdk" as SessionId,
    createdAt: 1,
    updatedAt: 2,
  };
}

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

function teamRunCounts(input: Partial<TeamRunSummaryCounts>): TeamRunSummaryCounts {
  return {
    dispatched: 0,
    completed: 0,
    accepted: 0,
    reopened: 0,
    merged: 0,
    mergeFailed: 0,
    mergeConflicted: 0,
    mergeSkipped: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    stillRunning: 0,
    errors: 0,
    ...input,
  };
}
