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
  ThreadId,
  TimestampMs,
  ToolCallId,
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
import { chatSessionView, createRuntimeView, pendingApprovals, reduceRuntimeEvents, runtimeAgentsSnapshot, sessionMessages, teamLiveCockpit, teamLiveView, type ChatTranscriptItem } from "./projection.js";

test("replays session, message, tool, and approval events into a runtime view", () => {
  const sessionId = "session_test" as SessionId;
  const threadId = "thread_test" as ThreadId;
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
      threadId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_2",
      type: "message.created",
      time: 2 as TimestampMs,
      sessionId,
      threadId,
      payload: { messageId, role: "assistant" },
    },
    {
      id: "event_3",
      type: "message.part_added",
      time: 3 as TimestampMs,
      sessionId,
      threadId,
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
      threadId,
      payload: { messageId, partId, field: "text", delta: " world" },
    },
    {
      id: "event_5",
      type: "tool.call_started",
      time: 5 as TimestampMs,
      sessionId,
      threadId,
      payload: { turnId, callId, toolName: "read", input: { filePath: "README.md" } },
    },
    {
      id: "event_6",
      type: "tool.call_updated",
      time: 6 as TimestampMs,
      sessionId,
      threadId,
      payload: { callId, status: "waiting_for_approval" },
    },
    {
      id: "event_7",
      type: "approval.requested",
      time: 7 as TimestampMs,
      sessionId,
      threadId,
      payload: {
        approvalId: "approval_test" as never,
        callId,
        permission: "tool.read",
        patterns: ["README.md"],
        metadata: { reason: "Policy asks for README reads", source: "project .chili/config.toml" },
      },
    },
    {
      id: "event_8",
      type: "approval.resolved",
      time: 8 as TimestampMs,
      sessionId,
      threadId,
      payload: { approvalId: "approval_test" as never, decision: "allow_once" },
    },
    {
      id: "event_9",
      type: "tool.call_finished",
      time: 9 as TimestampMs,
      sessionId,
      threadId,
      payload: { callId, status: "completed", output: "ok" },
    },
    {
      id: "event_10",
      type: "turn.completed",
      time: 10 as TimestampMs,
      sessionId,
      threadId,
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
  expect(pendingApprovals(view, sessionId)).toHaveLength(0);
});

test("projects persistent goals into chat session views", () => {
  const sessionId = "session_goal_projection" as SessionId;
  const threadId = "thread_goal_projection" as ThreadId;
  const view = reduceRuntimeEvents([
    {
      id: "event_goal_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      threadId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_goal_updated",
      type: "goal.updated",
      time: 2 as TimestampMs,
      sessionId,
      threadId,
      payload: {
        reason: "set",
        goal: {
          sessionId,
          threadId,
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

  expect(chatSessionView(view, { sessionId, threadId }).goal).toMatchObject({
    objective: "finish goal projection",
    status: "active",
    tokensUsed: 1_200,
  });
});

test("projects live tool input updates before the final assistant tool part", () => {
  const sessionId = "session_live_tool" as SessionId;
  const threadId = "thread_live_tool" as ThreadId;
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
        threadId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: "event_live_assistant",
        type: "message.created",
        time: 2 as TimestampMs,
        sessionId,
        threadId,
        payload: { messageId, role: "assistant" },
      },
      {
        id: "event_live_tool_start",
        type: "tool.call_updated",
        time: 3 as TimestampMs,
        sessionId,
        threadId,
        payload: { callId, status: "running", toolName: "bash", input: {} },
      },
      {
        id: "event_live_tool_partial",
        type: "tool.call_updated",
        time: 4 as TimestampMs,
        sessionId,
        threadId,
        payload: { callId, status: "running", toolName: "bash", input: { command: "bun test" } },
      },
    ],
    createRuntimeView(),
  );

  const live = chatSessionView(view, { sessionId, threadId, generatedAt: "now" });
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
        threadId,
        payload: { callId, status: "running", toolName: "bash", input: { command: "bun test --run" } },
      },
      {
        id: "event_live_tool_part",
        type: "message.part_added",
        time: 6 as TimestampMs,
        sessionId,
        threadId,
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
        threadId,
        payload: { turnId, callId, toolName: "bash", input: { command: "bun test --run" } },
      },
      {
        id: "event_live_tool_finished",
        type: "tool.call_finished",
        time: 8 as TimestampMs,
        sessionId,
        threadId,
        payload: { callId, status: "completed", output: "ok" },
      },
    ],
    view,
  );
  const completed = chatSessionView(completedView, { sessionId, threadId, generatedAt: "now" });
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
  const threadId = "thread_live_tool_output" as ThreadId;
  const turnId = "turn_live_tool_output" as TurnId;
  const callId = "toolcall_live_output" as ToolCallId;

  const runningView = reduceRuntimeEvents(
    [
      {
        id: "event_live_output_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        threadId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: "event_live_output_started",
        type: "tool.call_started",
        time: 2 as TimestampMs,
        sessionId,
        threadId,
        payload: { turnId, callId, toolName: "bash", input: { command: "bun test" } },
      },
      {
        id: "event_live_output_stdout",
        type: "tool.output_delta",
        time: 3 as TimestampMs,
        sessionId,
        threadId,
        payload: { callId, stream: "stdout", delta: "pass 1\n", bytes: 7, sequence: 1 },
      },
      {
        id: "event_live_output_stderr",
        type: "tool.output_delta",
        time: 4 as TimestampMs,
        sessionId,
        threadId,
        payload: { callId, stream: "stderr", delta: "warn\n", bytes: 5, sequence: 2 },
      },
    ],
    createRuntimeView(),
  );

  const running = chatSessionView(runningView, { sessionId, threadId, generatedAt: "now" });
  const runningTool = running.items.find((item): item is Extract<ChatTranscriptItem, { kind: "tool" }> => item.kind === "tool");
  expect(runningTool).toMatchObject({ id: callId, status: "running" });
  expect(runningTool?.output).toBeUndefined();
  expect(runningTool?.liveOutput).toEqual([
    expect.objectContaining({ stream: "stdout", delta: "pass 1\n", sequence: 1 }),
    expect.objectContaining({ stream: "stderr", delta: "warn\n", sequence: 2 }),
  ]);
  expect(running.activeTools).toHaveLength(1);

  const finalOutput = "pass 1\n\n[stderr]\nwarn\n";
  const completedView = reduceRuntimeEvents(
    [
      {
        id: "event_live_output_finished",
        type: "tool.call_finished",
        time: 5 as TimestampMs,
        sessionId,
        threadId,
        payload: { callId, status: "completed", output: finalOutput },
      },
    ],
    runningView,
  );
  const completed = chatSessionView(completedView, { sessionId, threadId, generatedAt: "now" });
  const completedTool = completed.items.find((item): item is Extract<ChatTranscriptItem, { kind: "tool" }> => item.kind === "tool");
  expect(completedTool?.output).toBe(finalOutput);
  expect(completedTool?.liveOutput?.map((delta) => delta.delta).join("")).toBe("pass 1\nwarn\n");
  expect(completed.activeTools).toEqual([]);
});

test("projects chat session transcript rows from message, tool, and approval events", () => {
  const sessionId = "session_chat_view" as SessionId;
  const threadId = "thread_chat_view" as ThreadId;
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
        threadId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: "event_chat_turn",
        type: "turn.started",
        time: 2 as TimestampMs,
        sessionId,
        threadId,
        payload: { turnId },
      },
      {
        id: "event_chat_user",
        type: "message.created",
        time: 3 as TimestampMs,
        sessionId,
        threadId,
        payload: { messageId: userMessageId, role: "user" },
      },
      {
        id: "event_chat_user_text",
        type: "message.part_added",
        time: 4 as TimestampMs,
        sessionId,
        threadId,
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
        threadId,
        payload: { messageId: assistantMessageId, role: "assistant" },
      },
      {
        id: "event_chat_reasoning",
        type: "message.part_added",
        time: 6 as TimestampMs,
        sessionId,
        threadId,
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
        threadId,
        payload: { messageId: assistantMessageId, partId: reasoningPartId, field: "text", delta: " through" },
      },
      {
        id: "event_chat_text",
        type: "message.part_added",
        time: 8 as TimestampMs,
        sessionId,
        threadId,
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
        threadId,
        payload: { messageId: assistantMessageId, partId: textPartId, field: "text", delta: " world" },
      },
      {
        id: "event_chat_tool_part",
        type: "message.part_added",
        time: 10 as TimestampMs,
        sessionId,
        threadId,
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
        threadId,
        payload: { turnId, callId, toolName: "bash", input: { command: "bun test" } },
      },
      {
        id: "event_chat_tool_waiting",
        type: "tool.call_updated",
        time: 12 as TimestampMs,
        sessionId,
        threadId,
        payload: { callId, status: "waiting_for_approval" },
      },
      {
        id: "event_chat_approval",
        type: "approval.requested",
        time: 13 as TimestampMs,
        sessionId,
        threadId,
        payload: { approvalId, callId, permission: "tool.bash", patterns: ["bun test"] },
      },
    ],
    createRuntimeView(),
  );

  const pending = chatSessionView(pendingView, { sessionId, threadId, generatedAt: "now" });
  const blank = chatSessionView(pendingView, { requireSession: true, generatedAt: "now" });
  const assistant = pending.items.find((item) => item.kind === "message" && item.role === "assistant");
  const tool = pending.items.find((item) => item.kind === "tool");

  expect(blank.sessionId).toBeUndefined();
  expect(blank.items).toEqual([]);
  expect(pending.sessionId).toBe(sessionId);
  expect(pending.threadId).toBe(threadId);
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
        threadId,
        payload: { approvalId, decision: "allow_once" },
      },
      {
        id: "event_chat_tool_finished",
        type: "tool.call_finished",
        time: 15 as TimestampMs,
        sessionId,
        threadId,
        payload: { callId, status: "completed", output: "ok" },
      },
      {
        id: "event_chat_done",
        type: "turn.completed",
        time: 16 as TimestampMs,
        sessionId,
        threadId,
        payload: { turnId, status: "completed" },
      },
    ],
    pendingView,
  );
  const resolved = chatSessionView(resolvedView, { sessionId, threadId });
  const resolvedApproval = resolved.items.find((item) => item.kind === "approval");
  const completedTool = resolved.items.find((item) => item.kind === "tool");

  expect(resolved.status).toBe("idle");
  expect(resolved.pendingApprovals).toHaveLength(0);
  expect(resolvedApproval).toMatchObject({ kind: "approval", id: approvalId, status: "resolved", decision: "allow_once" });
  expect(completedTool).toMatchObject({ kind: "tool", id: callId, status: "completed", displayStatus: "succeeded", output: "ok" });
});

test("projects latest model metadata and stable usage summaries for chat sessions", () => {
  const sessionId = "session_model_metadata" as SessionId;
  const threadId = "thread_model_metadata" as ThreadId;
  const firstTurnId = "turn_model_metadata_first" as TurnId;
  const secondTurnId = "turn_model_metadata_second" as TurnId;

  const view = reduceRuntimeEvents(
    [
      {
        id: "event_metadata_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        threadId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: "event_metadata_first_initial",
        type: "turn.model_metadata",
        time: 2 as TimestampMs,
        sessionId,
        threadId,
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
        threadId,
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
        threadId,
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
        threadId,
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
        threadId,
        payload: {
          turnId: secondTurnId,
          responseId: "response_second",
          usage: { inputTokens: 10, outputTokens: 15, cacheReadInputTokens: 2 },
        },
      },
    ],
    createRuntimeView(),
  );

  const chat = chatSessionView(view, { sessionId, threadId });

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
    totalTokens: 155,
  });
});

test("projects model metadata without optional model limits", () => {
  const sessionId = "session_model_metadata_limits" as SessionId;
  const threadId = "thread_model_metadata_limits" as ThreadId;
  const turnId = "turn_model_metadata_limits" as TurnId;

  const view = reduceRuntimeEvents(
    [
      {
        id: "event_metadata_limits_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        threadId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: "event_metadata_limits",
        type: "turn.model_metadata",
        time: 2 as TimestampMs,
        sessionId,
        threadId,
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

  const chat = chatSessionView(view, { sessionId, threadId });

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
  const threadId = "thread_approval_summaries" as ThreadId;
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
        threadId,
        payload: { sessionId, cwd: "/repo" },
      },
      ...toolApprovalEvents({
        time: 2,
        sessionId,
        threadId,
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
        threadId,
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
        threadId,
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
        threadId,
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

  const chat = chatSessionView(view, { sessionId, threadId });
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

test("projects subagent runs, mailbox messages, and team tasks", () => {
  const sessionId = "session_agents" as SessionId;
  const threadId = "thread_agents" as ThreadId;
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
      threadId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_2",
      type: "agent.spawned",
      time: 2 as TimestampMs,
      sessionId,
      threadId,
      payload: { runId: rootRunId, path: rootPath, taskName: "lead" },
    },
    {
      id: "event_3",
      type: "agent.spawned",
      time: 3 as TimestampMs,
      sessionId,
      threadId,
      payload: { runId: childRunId, path: childPath, parentPath: rootPath, taskName: "review" },
    },
    {
      id: "event_team_created",
      type: "team.created",
      time: 3 as TimestampMs,
      sessionId,
      threadId,
      payload: { teamId, name: "agents", leadPath: rootPath, description: "projection team" },
    },
    {
      id: "event_team_member_lead",
      type: "team.member_added",
      time: 3 as TimestampMs,
      sessionId,
      threadId,
      payload: { teamId, path: rootPath, name: "team-lead", role: "leader", status: "running" },
    },
    {
      id: "event_team_member_child",
      type: "team.member_added",
      time: 3 as TimestampMs,
      sessionId,
      threadId,
      payload: { teamId, path: childPath, name: "reviewer", role: "reviewer", status: "idle", toolScope: ["read"] },
    },
    {
      id: "event_4",
      type: "team.task_created",
      time: 4 as TimestampMs,
      sessionId,
      threadId,
      payload: { teamId, taskId, title: "Review projection", ownerPath: childPath },
    },
    {
      id: "event_team_task_claimed",
      type: "team.task_claimed",
      time: 4 as TimestampMs,
      sessionId,
      threadId,
      payload: { teamId, taskId, ownerPath: childPath, claimedBy: childPath },
    },
    {
      id: "event_5",
      type: "agent.message_queued",
      time: 5 as TimestampMs,
      sessionId,
      threadId,
      payload: {
        path: childPath,
        from: rootPath,
        triggerTurn: true,
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
      threadId,
      payload: { messageId: "event_5", path: childPath },
    },
    {
      id: "event_team_message",
      type: "team.message_sent",
      time: 6 as TimestampMs,
      sessionId,
      threadId,
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
      threadId,
      payload: { teamId, taskId, status: "completed" },
    },
    {
      id: "event_8",
      type: "agent.completed",
      time: 8 as TimestampMs,
      sessionId,
      threadId,
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
  expect(snapshot.mailbox[0]?.status).toBe("consumed");
  expect(snapshot.mailbox[0]?.consumedAt).toBe(6);
});

test("projects team run lifecycle events into run view models", () => {
  const sessionId = "session_team_run" as SessionId;
  const threadId = "thread_team_run" as ThreadId;
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
        threadId,
        payload: { teamId, name: "runner", leadPath },
      },
      {
        id: "event_run_start",
        type: "team.run_started",
        time: 2 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          teamId,
          runId: "teamrun_test",
          mode: "background",
          once: false,
          maxCycles: 5,
          timeoutMs: 1000,
          pollIntervalMs: 50,
          maxConcurrentDispatches: 6,
        },
      },
      {
        id: "event_run_progress",
        type: "team.run_progress",
        time: 3 as TimestampMs,
        sessionId,
        threadId,
        payload: { teamId, runId: "teamrun_test", cycle: 1, phase: "dispatch", counts: runCounts },
      },
      {
        id: "event_run_complete",
        type: "team.run_completed",
        time: 4 as TimestampMs,
        sessionId,
        threadId,
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
    counts: { dispatched: 2, completed: 2 },
  });
});

test("derives Team Live cockpit view from team projection state", () => {
  const sessionId = "session_team_live" as SessionId;
  const threadId = "thread_team_live" as ThreadId;
  const otherSessionId = "session_team_live_other" as SessionId;
  const otherThreadId = "thread_team_live_other" as ThreadId;
  const childSessionId = "session_team_live_child" as SessionId;
  const childThreadId = "thread_team_live_child" as ThreadId;
  const verifierSessionId = "session_team_live_verifier" as SessionId;
  const verifierThreadId = "thread_team_live_verifier" as ThreadId;
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
        threadId,
        payload: { sessionId, cwd: "/repo" },
      },
      {
        id: "event_other_team",
        type: "team.created",
        time: 2 as TimestampMs,
        sessionId: otherSessionId,
        threadId: otherThreadId,
        payload: { teamId: otherTeamId, name: "other", leadPath },
      },
      {
        id: "event_team",
        type: "team.created",
        time: 3 as TimestampMs,
        sessionId,
        threadId,
        payload: { teamId, name: "live", leadPath },
      },
      {
        id: "event_lead",
        type: "team.member_added",
        time: 3 as TimestampMs,
        sessionId,
        threadId,
        payload: { teamId, path: leadPath, name: "lead", role: "leader", status: "running" },
      },
      {
        id: "event_member",
        type: "team.member_added",
        time: 4 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          teamId,
          path: memberPath,
          name: "worker",
          role: "builder",
          status: "idle",
          childSessionId,
          childThreadId,
          toolScope: ["read_file"],
          writeScope: ["packages/sdk"],
        },
      },
      {
        id: "event_task",
        type: "team.task_created",
        time: 5 as TimestampMs,
        sessionId,
        threadId,
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
        threadId,
        payload: {
          taskId: verifierTaskId,
          path: "/root/worker/verifier" as AgentPath,
          parentPath: memberPath,
          parentSessionId: sessionId,
          childSessionId: verifierSessionId,
          childThreadId: verifierThreadId,
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
        threadId,
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
        threadId,
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
        threadId,
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
        threadId,
        payload: { teamId, taskId, ownerPath: memberPath, claimedBy: memberPath },
      },
      {
        id: "event_message",
        type: "team.message_sent",
        time: 7 as TimestampMs,
        sessionId,
        threadId,
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
        threadId,
        payload: {
          path: memberPath,
          from: leadPath,
          triggerTurn: true,
          taskId,
          childSessionId,
          childThreadId,
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
        threadId,
        payload: {
          teamId,
          runId: "teamrun_live",
          mode: "background",
          once: false,
          maxCycles: 4,
          timeoutMs: 1000,
          pollIntervalMs: 100,
          maxConcurrentDispatches: 4,
        },
      },
      {
        id: "event_run_progress",
        type: "team.run_progress",
        time: 10 as TimestampMs,
        sessionId,
        threadId,
        payload: { teamId, runId: "teamrun_live", cycle: 1, phase: "dispatch", counts: teamRunCounts({ dispatched: 1 }) },
      },
      {
        id: "event_child_turn",
        type: "turn.started",
        time: 11 as TimestampMs,
        sessionId: childSessionId,
        threadId: childThreadId,
        payload: { turnId: "turn_live" as TurnId },
      },
      {
        id: "event_tool",
        type: "tool.call_started",
        time: 11 as TimestampMs,
        sessionId: childSessionId,
        threadId: childThreadId,
        payload: { turnId: "turn_live" as TurnId, callId, toolName: "read_file", input: { path: "README.md" } },
      },
      {
        id: "event_approval",
        type: "approval.requested",
        time: 12 as TimestampMs,
        sessionId,
        threadId,
        payload: { approvalId, callId, permission: "tool.edit", patterns: ["packages/sdk/*"] },
      },
      {
        id: "event_child_approval",
        type: "approval.requested",
        time: 13 as TimestampMs,
        sessionId: childSessionId,
        threadId: childThreadId,
        payload: { approvalId: childApprovalId, callId, permission: "tool.bash", patterns: ["bun test"] },
      },
      {
        id: "event_resolved_approval",
        type: "approval.requested",
        time: 14 as TimestampMs,
        sessionId: childSessionId,
        threadId: childThreadId,
        payload: { approvalId: resolvedApprovalId, callId, permission: "tool.read", patterns: ["README.md"] },
      },
      {
        id: "event_resolved_approval_done",
        type: "approval.resolved",
        time: 15 as TimestampMs,
        sessionId: childSessionId,
        threadId: childThreadId,
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
  expect(cockpit.toolCounts).toEqual([{ toolName: "read_file", total: 1, running: 1, completed: 0, failed: 0 }]);
  expect(cockpit.metadata.worktrees).toHaveLength(1);
  expect(cockpit.recentActivity.map((item) => item.kind)).toContain("run");
  expect(cockpit.recentActivity.find((item) => item.kind === "run")).toMatchObject({
    label: "run dispatch",
    detail: "cycle:1 fanout:4 dispatched:1",
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
  const threadId = "thread_run_scoped" as ThreadId;
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
        threadId,
        payload: { teamId, runId: "teamrun_scoped" },
      },
      {
        id: "event_run_scoped_tool",
        type: "tool.call_started",
        time: 3 as TimestampMs,
        sessionId: runSessionId,
        threadId,
        payload: { turnId: "turn_run_scoped" as TurnId, callId, toolName: "read_file", input: { path: "README.md" } },
      },
      {
        id: "event_run_scoped_approval",
        type: "approval.requested",
        time: 4 as TimestampMs,
        sessionId: runSessionId,
        threadId,
        payload: { approvalId, callId, permission: "tool.read", patterns: ["README.md"] },
      },
      {
        id: "event_other_tool",
        type: "tool.call_started",
        time: 5 as TimestampMs,
        sessionId: otherSessionId,
        threadId,
        payload: { turnId: "turn_run_other" as TurnId, callId: otherCallId, toolName: "bash", input: { command: "bun test" } },
      },
      {
        id: "event_other_approval",
        type: "approval.requested",
        time: 6 as TimestampMs,
        sessionId: otherSessionId,
        threadId,
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
  const threadId = "thread_local_agents" as ThreadId;
  const taskId = "task_local" as TaskId;
  const childSessionId = "session_child_local" as SessionId;
  const childThreadId = "thread_child_local" as ThreadId;
  const path = "/root/task_local" as AgentPath;

  const view = reduceRuntimeEvents(
    [
      {
        id: "event_task_created",
        type: "agent.task_created",
        time: 1 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          taskId,
          path,
          parentPath: "/root" as AgentPath,
          parentSessionId: sessionId,
          parentThreadId: threadId,
          childSessionId,
          childThreadId,
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
        threadId,
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
        threadId,
        payload: {
          runId: "agent_local" as AgentRunId,
          taskId,
          path,
          parentPath: "/root" as AgentPath,
          parentSessionId: sessionId,
          parentThreadId: threadId,
          childSessionId,
          childThreadId,
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
    childThreadId,
  });
  expect(view.tasks[taskId]?.completedAt).toBeUndefined();
  expect(view.sessions[sessionId]?.taskIds).toEqual([taskId]);
});

test("client preserves team dispatcher JSON shapes for dispatch, sync, and reconcile", async () => {
  const teamId = "team_sdk" as TeamId;
  const taskId = "task_sdk" as TaskId;
  const sessionId = "session_sdk" as SessionId;
  const threadId = "thread_sdk" as ThreadId;
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
      threadId,
      mode: "background",
      cwd: "/repo",
      prompt: "verify",
    }),
  ).toEqual(dispatchJson);
  expect(await client.dispatchTeamTask({ teamId, taskId, sessionId, threadId })).toEqual(skippedDispatchJson);
  expect(await client.syncTeamTask({ teamId, taskId, sessionId, threadId })).toEqual(syncResult);
  expect(await client.reconcileTeamTasks({ teamId, sessionId, threadId, limit: 5 })).toEqual(reconcileJson);
  expect(await client.mergeTeamTasks({ teamId, taskId, sessionId, threadId, cwd: "/repo" })).toEqual(mergeJson);
  expect(
    await client.runTeamLoop({
      teamId,
      sessionId,
      threadId,
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
      body: { teamId, taskId, ownerPath, sessionId, threadId, mode: "background", cwd: "/repo", prompt: "verify" },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/tasks/task_sdk/dispatch",
      method: "POST",
      body: { teamId, taskId, sessionId, threadId },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/tasks/task_sdk/sync",
      method: "POST",
      body: { teamId, taskId, sessionId, threadId },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/reconcile_dispatches",
      method: "POST",
      body: { teamId, sessionId, threadId, limit: 5 },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/merge",
      method: "POST",
      body: { teamId, taskId, sessionId, threadId, cwd: "/repo" },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/run_loop",
      method: "POST",
      body: {
        teamId,
        sessionId,
        threadId,
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
  const threadId = "thread_sdk_abort" as ThreadId;
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
      ? ({ sessionId, threadId })
      : url.endsWith("/prompt_async")
        ? ({ status: "accepted", sessionId, threadId })
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
    threadId,
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
        sessionId,
        threadId,
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
  const threadId = "thread_sdk_model" as ThreadId;
  const records: { url: string; method: string | undefined; body: unknown }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    records.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const body = url.endsWith("/models")
      ? [{ provider: "openai-codex", model: "gpt-5.5" }]
      : url.endsWith("/commands") || url.endsWith("/commands/reload")
        ? ({ commands: [], diagnostics: [], directories: [], skippedConflicts: [] })
        : url.endsWith("/command_async")
          ? ({ status: "accepted", sessionId, threadId })
      : url.endsWith("/prompt_async")
        ? ({ status: "accepted", sessionId, threadId })
        : ({ sessionId, models: [], availableReasoningLevels: ["off", "high"] });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new HttpRuntimeClient({ baseUrl: "http://runtime.test/api", fetch: fetchImpl });

  await client.listModels();
  await client.getModelConfig({ sessionId });
  await client.setModel({ sessionId, threadId, modelSelection: { provider: "openai-codex", model: "gpt-5.5" } });
  await client.setReasoning({ sessionId, threadId, reasoningLevel: "high" });
  await client.listCommands();
  await client.reloadCommands();
  await client.submitPromptAsync({
    sessionId,
    threadId,
    text: "hello",
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
    reasoningLevel: "xhigh",
  });
  await client.submitCommandAsync({
    sessionId,
    threadId,
    name: "joke",
    args: "typescript",
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
    reasoningLevel: "high",
  });

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
      body: { threadId, modelSelection: { provider: "openai-codex", model: "gpt-5.5" } },
    },
    {
      url: "http://runtime.test/api/sessions/session_sdk_model/reasoning",
      method: "POST",
      body: { threadId, reasoningLevel: "high" },
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
        sessionId,
        threadId,
        text: "hello",
        modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
        reasoningLevel: "xhigh",
      },
    },
    {
      url: "http://runtime.test/api/sessions/session_sdk_model/command_async",
      method: "POST",
      body: {
        sessionId,
        threadId,
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
              childThreadId: "thread_child_sdk",
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
    runId: "agentrun_agent_sdk",
    path: "/root/reviewer/task_agent_sdk" as AgentPath,
    parentPath: input.ownerPath,
    childSessionId: "session_child_sdk" as SessionId,
    childThreadId: "thread_child_sdk" as ThreadId,
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
    childThreadId: "thread_child_sdk" as ThreadId,
    createdAt: 1,
    updatedAt: 2,
  };
}

function toolApprovalEvents(input: {
  time: number;
  sessionId: SessionId;
  threadId: ThreadId;
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
      threadId: input.threadId,
      payload: { turnId: input.turnId, callId: input.callId, toolName: input.toolName, input: input.input },
    },
    {
      id: `event_${input.callId}_waiting`,
      type: "tool.call_updated",
      time: (input.time + 1) as TimestampMs,
      sessionId: input.sessionId,
      threadId: input.threadId,
      payload: { callId: input.callId, status: "waiting_for_approval" },
    },
    {
      id: `event_${input.callId}_approval`,
      type: "approval.requested",
      time: (input.time + 2) as TimestampMs,
      sessionId: input.sessionId,
      threadId: input.threadId,
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
