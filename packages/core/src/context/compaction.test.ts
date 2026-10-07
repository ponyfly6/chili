import { expect, test } from "bun:test";
import { formatToolResultForModel } from "@chili/protocol";
import type {
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  MessagePart,
  SessionId,
  TimestampMs,
  ToolDefinition,
  ToolResultExecutionContext,
  TurnId,
} from "@chili/protocol";
import type { ApprovalRow, EventQuery, EventStore, SessionRow } from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import { ContextWindowBuilder, compactedMessageView } from "./window.js";
import { ContextCompactionService } from "./compaction.js";
import { formatCompactionSourceMessages, formatConversationMessages } from "./format.js";
import { takeModelUsage } from "../model-usage.js";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "../runtime.js";
import { SingleAgentRuntime } from "../single-agent-runtime.js";

test("context builder uses the latest compaction message as replacement history", () => {
  const sessionId = "session_compacted_view" as SessionId;
  const oldUser = textMessage("msg_old_user", sessionId, "user", "old request");
  const oldAssistant = textMessage("msg_old_assistant", sessionId, "assistant", "old answer");
  const summary = compactionMessage("msg_summary", sessionId, oldAssistant.id, "summary of old work");
  const newUser = textMessage("msg_new_user", sessionId, "user", "new request");

  const built = new ContextWindowBuilder({ maxInputChars: 10_000 }).build([
    oldUser,
    oldAssistant,
    summary,
    newUser,
  ]);

  expect(built.messages.map((message) => message.id)).toEqual([summary.id, newUser.id]);
  expect(built.usage.omittedMessages).toBe(2);
});

test("context builder snapshots assistant text phases", () => {
  const sessionId = "session_phase_snapshot" as SessionId;
  const messageId = "msg_phase_snapshot" as MessageId;
  const message: Message = {
    id: messageId,
    sessionId,
    role: "assistant",
    createdAt: 1 as TimestampMs,
    parts: [
      {
        id: "part_phase_snapshot_commentary" as MessagePart["id"],
        messageId,
        sessionId,
        type: "text",
        text: "Checking.",
        phase: "commentary",
      },
      {
        id: "part_phase_snapshot_final" as MessagePart["id"],
        messageId,
        sessionId,
        type: "text",
        text: "Done.",
        phase: "final_answer",
      },
    ],
  };

  const built = new ContextWindowBuilder({ maxInputChars: 10_000 }).build([message]);

  expect(built.messages[0]?.parts).toEqual(message.parts);
});

test("context builder preserves an encrypted reasoning output with no display text", () => {
  const sessionId = "session_reasoning_output_snapshot" as SessionId;
  const messageId = "msg_reasoning_output_snapshot" as MessageId;
  const message: Message = {
    id: messageId,
    sessionId,
    role: "assistant",
    createdAt: 1 as TimestampMs,
    parts: [{
      id: "part_reasoning_output_snapshot" as MessagePart["id"],
      messageId,
      sessionId,
      type: "reasoning",
      text: "",
      modelOutput: {
        apiFamily: "openai-responses",
        outputIndex: 0,
        item: {
          id: "reasoning_snapshot",
          type: "reasoning",
          encrypted_content: "ciphertext",
          provider_extension: { retained: true },
        },
      },
    }],
  };

  const built = new ContextWindowBuilder({ maxInputChars: 10_000, maxMessagePartChars: 8 }).build([message]);

  expect(built.messages).toEqual([message]);
  expect(built.usage.contextChars).toBeGreaterThan(0);
});

test("compacted message view reorders appended summary before retained messages", () => {
  const sessionId = "session_compacted_order" as SessionId;
  const oldUser = textMessage("msg_order_old_user", sessionId, "user", "old request");
  const oldAssistant = textMessage("msg_order_old_assistant", sessionId, "assistant", "old answer");
  const newUser = textMessage("msg_order_new_user", sessionId, "user", "new request");
  const summary = compactionMessage("msg_order_summary", sessionId, oldAssistant.id, "summary of old work");

  expect(compactedMessageView([oldUser, oldAssistant, newUser, summary]).map((message) => message.id)).toEqual([
    summary.id,
    newUser.id,
  ]);
});

test("context builder does not repeatedly compact only an existing summary", () => {
  const sessionId = "session_compacted_repeat" as SessionId;
  const summary = compactionMessage("msg_repeat_summary", sessionId, "msg_old_boundary" as MessageId, "s".repeat(500));
  const newUser = textMessage("msg_repeat_user", sessionId, "user", "new request");

  const built = new ContextWindowBuilder({
    maxInputChars: 100,
    compactionThresholdRatio: 0.5,
    preserveRecentMessages: 8,
  }).build([summary, newUser]);

  expect(built.compactionBoundary).toBeUndefined();
});

test("manual compaction boundary includes the latest visible message", () => {
  const sessionId = "session_manual_boundary" as SessionId;
  const summary = compactionMessage("msg_manual_summary", sessionId, "msg_old_boundary" as MessageId, "summary");
  const newUser = textMessage("msg_manual_user", sessionId, "user", "new request");

  const boundary = new ContextWindowBuilder({
    maxInputChars: 10_000,
    preserveRecentMessages: 8,
  }).compactionBoundary([summary, newUser], "manual");

  expect(boundary?.boundaryMessageId).toBe(newUser.id);
});

test("context builder microcompacts old tool results by total tool-output budget", () => {
  const sessionId = "session_tool_microcompact" as SessionId;
  const oldTool = toolResultMessage("msg_tool_old", sessionId, "old", `old-${"x".repeat(300)}`);
  const middleTool = toolResultMessage("msg_tool_middle", sessionId, "middle", `middle-${"y".repeat(300)}`);
  const recentTool = toolResultMessage("msg_tool_recent", sessionId, "recent", `recent-${"z".repeat(300)}`);

  const built = new ContextWindowBuilder({
    maxInputChars: 10_000,
    maxTotalToolResultChars: 200,
    compactedToolResultChars: 120,
    preserveRecentToolResults: 1,
  }).build([oldTool, middleTool, recentTool]);

  const outputs = built.messages
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<MessagePart, { type: "tool_result" }> => part.type === "tool_result")
    .map((part) => part.output);

  expect(built.usage.compactedToolResults).toBe(2);
  expect(outputs[0]).toContain("tool result compacted from context");
  expect(outputs[1]).toContain("tool result compacted from context");
  expect(outputs[2]).toContain("recent-");
  expect(outputs[2]).not.toContain("tool result compacted from context");
});

test("microcompaction cannot exceed the per-result hard limit", () => {
  const sessionId = "session_tool_microcompact_limit" as SessionId;
  const oldTool = toolResultMessage(
    "msg_tool_microcompact_limit_old",
    sessionId,
    "old_limit",
    `old-${"🙂".repeat(100)}`,
  );
  const recentTool = toolResultMessage(
    "msg_tool_microcompact_limit_recent",
    sessionId,
    "recent_limit",
    "recent",
  );

  const built = new ContextWindowBuilder({
    maxInputChars: 10_000,
    maxToolResultChars: 10,
    maxTotalToolResultChars: 1,
    compactedToolResultChars: 1,
    preserveRecentToolResults: 1,
  }).build([oldTool, recentTool]);

  const compactedResult = built.messages.flatMap((message) => message.parts).find(
    (part) => part.type === "tool_result" && part.callId === "old_limit",
  );
  expect(compactedResult?.type).toBe("tool_result");
  if (compactedResult?.type === "tool_result") {
    expect(compactedResult.output.length).toBeLessThanOrEqual(1);
    expect(Buffer.from(compactedResult.output, "utf8").toString("utf8")).toBe(compactedResult.output);
  }
});

test("context builder preserves tool result head and tail", () => {
  const sessionId = "session_tool_head_tail" as SessionId;
  const output = `HEAD_MARKER\n${"x".repeat(300)}DROP_MIDDLE_MARKER${"y".repeat(300)}\nartifact path: .chili/tool-results/call.txt`;
  const message = toolResultMessage("msg_tool_head_tail", sessionId, "head_tail", output);

  const built = new ContextWindowBuilder({
    maxInputChars: 10_000,
    maxToolResultChars: 120,
    maxTotalToolResultChars: 10_000,
  }).build([message]);

  const part = built.messages.flatMap((candidate) => candidate.parts).find(
    (candidate) => candidate.type === "tool_result",
  );
  if (part?.type !== "tool_result") throw new Error("expected tool result");
  expect(part.output).toContain("HEAD_MARKER");
  expect(part.output).toContain("artifact path: .chili/tool-results/call.txt");
  expect(part.output).not.toContain("DROP_MIDDLE_MARKER");
  expect(part.output.length).toBeLessThanOrEqual(120);
  expect(built.usage.truncatedToolResults).toBe(1);
});

test("context builder does not split surrogate pairs while truncating tool results", () => {
  const sessionId = "session_tool_surrogate" as SessionId;
  const output = `1234567890🙂${"x".repeat(100)}🙂${"z".repeat(32)}`;
  const message = toolResultMessage("msg_tool_surrogate", sessionId, "surrogate", output);

  const built = new ContextWindowBuilder({
    maxInputChars: 10_000,
    maxToolResultChars: 80,
    maxTotalToolResultChars: 10_000,
  }).build([message]);

  const part = built.messages.flatMap((candidate) => candidate.parts).find(
    (candidate) => candidate.type === "tool_result",
  );
  if (part?.type !== "tool_result") throw new Error("expected tool result");
  expect(Buffer.from(part.output, "utf8").toString("utf8")).toBe(part.output);
  expect(part.output.length).toBeLessThanOrEqual(80);
});

test("context builder reserves the tool execution footer inside the result limit", () => {
  const sessionId = "session_tool_execution_footer_limit" as SessionId;
  const message = toolResultMessage(
    "msg_tool_execution_footer_limit",
    sessionId,
    "execution_footer_limit",
    `HEAD_${"x".repeat(500)}_TAIL`,
  );
  const source = message.parts.find((part) => part.type === "tool_result");
  if (source?.type !== "tool_result") throw new Error("expected tool result");
  source.error = "command failed";
  source.executionContext = toolExecutionContext();
  const maxResultChars = 220;

  const built = new ContextWindowBuilder({
    maxInputChars: 10_000,
    maxToolResultChars: maxResultChars,
    maxTotalToolResultChars: 10_000,
    maxMessagePartChars: 400,
  }).build([message]);

  const result = built.messages.flatMap((candidate) => candidate.parts).find(
    (part) => part.type === "tool_result",
  );
  if (result?.type !== "tool_result") throw new Error("expected tool result");
  const formatted = formatToolResultForModel(result);
  expect(formatted.length).toBeLessThanOrEqual(maxResultChars);
  expect(formatted).toEndWith(toolExecutionContextFooter());
  expect(result.output).not.toContain("[tool execution context]");
  expect(result.output).not.toBe(source.output);
});

test("tool result microcompaction preserves and budgets the execution footer", () => {
  const sessionId = "session_tool_execution_footer_compact" as SessionId;
  const message = toolResultMessage(
    "msg_tool_execution_footer_compact",
    sessionId,
    "execution_footer_compact",
    `HEAD_${"x".repeat(500)}_TAIL`,
  );
  const source = message.parts.find((part) => part.type === "tool_result");
  if (source?.type !== "tool_result") throw new Error("expected tool result");
  source.executionContext = toolExecutionContext();
  const compactedResultChars = 180;

  const built = new ContextWindowBuilder({
    maxInputChars: 10_000,
    maxToolResultChars: 1_000,
    maxTotalToolResultChars: 0,
    compactedToolResultChars: compactedResultChars,
  }).build([message]);

  const result = built.messages.flatMap((candidate) => candidate.parts).find(
    (part) => part.type === "tool_result",
  );
  if (result?.type !== "tool_result") throw new Error("expected tool result");
  const formatted = formatToolResultForModel(result);
  expect(built.usage.compactedToolResults).toBe(1);
  expect(formatted.length).toBeLessThanOrEqual(compactedResultChars);
  expect(formatted).toEndWith(toolExecutionContextFooter());
});

test("context builder hard-limits every model-visible message item", () => {
  const sessionId = "session_complete_envelope" as SessionId;
  const userMessageId = "msg_complete_user" as MessageId;
  const assistantMessageId = "msg_complete_assistant" as MessageId;
  const toolMessageId = "msg_complete_tool" as MessageId;
  const hugeImage = "a".repeat(3_500_000);
  const messages: Message[] = [
    {
      id: userMessageId,
      sessionId,
      role: "user",
      createdAt: 1 as TimestampMs,
      parts: [
        {
          id: "part_complete_text" as never,
          messageId: userMessageId,
          sessionId,
          type: "text",
          text: `TEXT_HEAD_${"x".repeat(400)}_TEXT_TAIL`,
        },
        {
          id: "part_complete_reasoning" as never,
          messageId: userMessageId,
          sessionId,
          type: "reasoning",
          text: `REASONING_HEAD_${"r".repeat(400)}_REASONING_TAIL`,
        },
        {
          id: "part_complete_image" as never,
          messageId: userMessageId,
          sessionId,
          type: "image",
          data: hugeImage,
          mimeType: "image/png",
          filename: "huge.png",
        },
      ],
    },
    {
      id: assistantMessageId,
      sessionId,
      role: "assistant",
      createdAt: 2 as TimestampMs,
      parts: [
        {
          id: "part_complete_call" as never,
          messageId: assistantMessageId,
          sessionId,
          type: "tool_call",
          callId: "toolcall_complete" as never,
          toolName: "lookup",
          input: { query: "q".repeat(400) },
          status: "completed",
        },
      ],
    },
    {
      id: toolMessageId,
      sessionId,
      role: "tool",
      createdAt: 3 as TimestampMs,
      parts: [
        {
          id: "part_complete_result" as never,
          messageId: toolMessageId,
          sessionId,
          type: "tool_result",
          callId: "toolcall_complete" as never,
          output: `OUTPUT_HEAD_${"o".repeat(400)}_OUTPUT_TAIL`,
          error: `ERROR_HEAD_${"e".repeat(400)}_ERROR_TAIL`,
          content: [
            { type: "text", text: `CONTENT_HEAD_${"c".repeat(400)}_CONTENT_TAIL` },
            { type: "image", data: hugeImage, mimeType: "image/png" },
          ],
        },
      ],
    },
  ];

  const built = new ContextWindowBuilder({
    maxInputChars: 50_000,
    maxToolResultChars: 96,
    maxTotalToolResultChars: 50_000,
    maxMessagePartChars: 80,
    maxImageDataChars: 100,
  }).build(messages);

  const parts = built.messages.flatMap((message) => message.parts);
  const text = parts.find((part) => part.id === "part_complete_text");
  const reasoning = parts.find((part) => part.id === "part_complete_reasoning");
  const image = parts.find((part) => part.id === "part_complete_image");
  const call = parts.find((part) => part.id === "part_complete_call");
  const result = parts.find((part) => part.id === "part_complete_result");

  expect(text?.type).toBe("text");
  if (text?.type === "text") expect(text.text.length).toBeLessThanOrEqual(80);
  expect(reasoning?.type).toBe("reasoning");
  if (reasoning?.type === "reasoning") expect(reasoning.text.length).toBeLessThanOrEqual(80);
  expect(image?.type).toBe("text");
  if (image?.type === "text") expect(image.text.length).toBeLessThanOrEqual(80);
  expect(call?.type).toBe("tool_call");
  if (call?.type === "tool_call") {
    expect(typeof call.input).toBe("object");
    expect(JSON.stringify(call.input).length).toBeLessThanOrEqual(80);
  }
  expect(result?.type).toBe("tool_result");
  if (result?.type === "tool_result") {
    expect(result.output.length).toBeLessThanOrEqual(96);
    expect(result.error?.length).toBeLessThanOrEqual(80);
    expect(result.content?.some((item) => item.type === "image")).toBe(false);
    expect(result.content?.every((item) => item.type !== "text" || item.text.length <= 80)).toBe(true);
  }
  expect(messages[0]?.parts[0]?.type === "text" && messages[0].parts[0].text.length).toBeGreaterThan(400);
  expect(messages[0]?.parts[2]?.type === "image" && messages[0].parts[2].data.length).toBe(3_500_000);
  const joinedUserText = built.messages[0]?.parts
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => part.text)
    .join("\n") ?? "";
  expect(joinedUserText.length).toBeLessThanOrEqual(80);
});

test("context builder drops an oversized tool call and its matching result when no object can fit", () => {
  const sessionId = "session_tool_pair_limit" as SessionId;
  const assistant = textMessage("msg_tool_pair_call", sessionId, "assistant", "");
  assistant.parts = [{
    id: "part_tool_pair_call" as never,
    messageId: assistant.id,
    sessionId,
    type: "tool_call",
    callId: "toolcall_pair_limit" as never,
    toolName: "lookup",
    input: { query: "x".repeat(100) },
    status: "completed",
  }];
  const result = toolResultMessage(
    "msg_tool_pair_result",
    sessionId,
    "toolcall_pair_limit",
    "result",
    false,
  );

  const built = new ContextWindowBuilder({
    maxInputChars: 10_000,
    maxMessagePartChars: 1,
  }).build([assistant, result]);

  expect(built.messages.flatMap((message) => message.parts).some(
    (part) => part.type === "tool_call" || part.type === "tool_result",
  )).toBe(false);
  expect(built.messages.every((message) => message.parts.length > 0)).toBe(true);
});

test("context builder replaces unserializable tool input and keeps its result paired", () => {
  const sessionId = "session_tool_input_cycle" as SessionId;
  const assistant = textMessage("msg_tool_input_cycle_call", sessionId, "assistant", "");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assistant.parts = [{
    id: "part_tool_input_cycle_call" as never,
    messageId: assistant.id,
    sessionId,
    type: "tool_call",
    callId: "toolcall_input_cycle" as never,
    toolName: "lookup",
    input: cyclic,
    status: "completed",
  }];
  const result = toolResultMessage(
    "msg_tool_input_cycle_result",
    sessionId,
    "toolcall_input_cycle",
    "result",
    false,
  );

  const built = new ContextWindowBuilder({ maxInputChars: 10_000 }).build([assistant, result]);
  const call = built.messages.flatMap((message) => message.parts).find((part) => part.type === "tool_call");

  expect(call?.type).toBe("tool_call");
  if (call?.type === "tool_call") {
    expect(call.input).toEqual({});
    expect(() => JSON.stringify(call.input)).not.toThrow();
  }
  expect(built.messages.flatMap((message) => message.parts).some(
    (part) => part.type === "tool_result" && part.callId === "toolcall_input_cycle",
  )).toBe(true);
});

test("context builder detaches tool input and image content from dynamic serializers", () => {
  const sessionId = "session_dynamic_context_values" as SessionId;
  let inputSerializations = 0;
  const dynamicInput = {
    toJSON() {
      inputSerializations++;
      return inputSerializations === 1 ? { query: "safe" } : { query: "x".repeat(200_000) };
    },
  };
  const assistant = textMessage("msg_dynamic_context_call", sessionId, "assistant", "");
  assistant.parts = [{
    id: "part_dynamic_context_call" as never,
    messageId: assistant.id,
    sessionId,
    type: "tool_call",
    callId: "toolcall_dynamic_context" as never,
    toolName: "lookup",
    input: dynamicInput,
    status: "completed",
  }];
  let imageReads = 0;
  const dynamicImage = {
    type: "image" as const,
    mimeType: "image/png",
    get data() {
      imageReads++;
      return imageReads === 1 ? "a" : "x".repeat(200_000);
    },
  };
  const result = toolResultMessage(
    "msg_dynamic_context_result",
    sessionId,
    "toolcall_dynamic_context",
    "result",
    false,
  );
  const toolResult = result.parts[0];
  if (toolResult?.type !== "tool_result") throw new Error("expected tool result");
  toolResult.content = [dynamicImage];
  toolResult.executionContext = {
    sandbox: "macos-seatbelt",
    executionMode: "sandboxed",
    exitCode: 1,
  };

  const built = new ContextWindowBuilder({
    maxInputChars: 10_000,
    maxMessagePartChars: 80,
    maxImageDataChars: 100,
  }).build([assistant, result]);
  const builtCall = built.messages.flatMap((message) => message.parts).find((part) => part.type === "tool_call");
  const builtResult = built.messages.flatMap((message) => message.parts).find((part) => part.type === "tool_result");

  expect(inputSerializations).toBe(1);
  expect(builtCall?.type === "tool_call" ? JSON.stringify(builtCall.input).length : Infinity).toBeLessThanOrEqual(80);
  expect(imageReads).toBe(1);
  expect(builtResult?.type === "tool_result" && builtResult.content?.[0]?.type === "image"
    ? builtResult.content[0].data
    : "").toBe("a");
  expect(builtResult?.type === "tool_result" ? builtResult.executionContext : undefined).toEqual({
    sandbox: "macos-seatbelt",
    executionMode: "sandboxed",
    exitCode: 1,
  });
});

test("context builder never emits an orphan tool result after history eviction", () => {
  const sessionId = "session_tool_pair_eviction" as SessionId;
  const assistant = textMessage("msg_tool_pair_eviction_call", sessionId, "assistant", "");
  assistant.parts = [{
    id: "part_tool_pair_eviction_call" as never,
    messageId: assistant.id,
    sessionId,
    type: "tool_call",
    callId: "toolcall_pair_eviction" as never,
    toolName: "lookup",
    input: { query: "q".repeat(80) },
    status: "completed",
  }];
  const result = toolResultMessage(
    "msg_tool_pair_eviction_result",
    sessionId,
    "toolcall_pair_eviction",
    "r".repeat(80),
    false,
  );

  const built = new ContextWindowBuilder({
    maxInputChars: 120,
    preserveRecentMessages: 1,
  }).build([assistant, result]);

  expect(built.usage.contextChars).toBeLessThanOrEqual(120);
  expect(built.messages.flatMap((message) => message.parts).some(
    (part) => part.type === "tool_call" || part.type === "tool_result",
  )).toBe(false);
});

test("context builder removes a tool result without any preceding call", () => {
  const sessionId = "session_orphan_tool_result" as SessionId;
  const orphan = toolResultMessage(
    "msg_orphan_tool_result",
    sessionId,
    "toolcall_missing",
    "orphan result",
    false,
  );

  const built = new ContextWindowBuilder({ maxInputChars: 10_000 }).build([orphan]);

  expect(built.messages).toEqual([]);
});

test("context builder terminally bounds the latest text without model token limits", () => {
  const sessionId = "session_latest_text_char_limit" as SessionId;
  const latest = textMessage(
    "msg_latest_text_char_limit",
    sessionId,
    "user",
    "current request ".repeat(100),
  );

  const built = new ContextWindowBuilder({
    maxInputChars: 120,
    maxMessagePartChars: 10_000,
    compactionThresholdRatio: 1,
  }).build([latest]);

  expect(built.messages).toHaveLength(1);
  expect(built.usage.contextChars).toBeLessThanOrEqual(120);
  expect(built.messages[0]?.parts[0]?.type).toBe("text");
});

test("context builder reserves model output and fixed prompt surface", () => {
  const sessionId = "session_surface_budget" as SessionId;
  const message = textMessage("msg_surface_budget", sessionId, "user", "m".repeat(200));
  const tool: ToolDefinition = {
    name: "lookup",
    description: "d".repeat(80),
    risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    async execute() {
      return { title: "lookup", output: "done" };
    },
  };
  const builder = new ContextWindowBuilder({
    maxInputChars: 10_000,
    framingSafetyTokens: 0,
    preserveRecentMessages: 4,
  });

  const withoutFixedSurface = builder.build([message], {
    contextWindowTokens: 100,
    requestMaxOutputTokens: 20,
  });
  const withFixedSurface = builder.build([message], {
    contextWindowTokens: 100,
    requestMaxOutputTokens: 20,
    system: ["s".repeat(160)],
    tools: [tool],
  });

  expect(withoutFixedSurface.overflow).toBeUndefined();
  expect(withFixedSurface.overflow).toMatchObject({ reason: "fixed_input_exceeds_window" });
  expect(withFixedSurface.usage.fixedInputTokens).toBeGreaterThan(40);
  expect(withFixedSurface.usage.outputReserveTokens).toBe(20);
  expect(withFixedSurface.usage.budgetTokens).toBeLessThan(40);
});

test("context builder rejects an oversized fixed prompt without message history", () => {
  const built = new ContextWindowBuilder({
    maxInputChars: 10_000,
    framingSafetyTokens: 0,
  }).build([], {
    contextWindowTokens: 16,
    requestMaxOutputTokens: 4,
    system: ["s".repeat(80)],
  });

  expect(built.messages).toEqual([]);
  expect(built.overflow).toMatchObject({
    reason: "fixed_input_exceeds_window",
    budgetTokens: 16,
  });
  expect(built.overflow?.estimatedTokens).toBeGreaterThan(16);
});

test("context builder hard-limits fixed request surface items", () => {
  let dynamicSchemaSerializations = 0;
  let dynamicDescriptionReads = 0;
  const safeTool: ToolDefinition = {
    name: "safe_lookup",
    description: "d".repeat(400),
    risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    async execute() {
      return { title: "safe", output: "done" };
    },
  };
  const oversizedSchemaTool: ToolDefinition = {
    name: "oversized_schema",
    description: "large schema",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: {
        payload: { type: "string", description: "s".repeat(2_000) },
      },
    },
    async execute() {
      return { title: "oversized", output: "done" };
    },
  };
  const dynamicSchemaTool: ToolDefinition = {
    name: "dynamic_schema",
    get description() {
      dynamicDescriptionReads++;
      return dynamicDescriptionReads === 1 ? "dynamic schema" : "x".repeat(200_000);
    },
    risk: "read",
    inputSchema: {
      toJSON() {
        dynamicSchemaSerializations++;
        return dynamicSchemaSerializations === 1
          ? { type: "object" }
          : { type: "object", description: "x".repeat(200_000) };
      },
    },
    async execute() {
      return { title: "dynamic", output: "done" };
    },
  };

  const built = new ContextWindowBuilder({
    maxInputChars: 10_000,
    maxPromptItemChars: 64,
    maxToolDefinitionChars: 160,
  }).build([], {
    system: ["s".repeat(40), "s".repeat(40)],
    developer: ["d".repeat(40), "d".repeat(40)],
    contextualUser: ["u".repeat(40), "u".repeat(40)],
    tools: [safeTool, oversizedSchemaTool, dynamicSchemaTool],
  });

  expect(built.surface.system.every((item) => item.length <= 64)).toBe(true);
  expect(built.surface.developer.every((item) => item.length <= 64)).toBe(true);
  expect(built.surface.contextualUser.every((item) => item.length <= 64)).toBe(true);
  expect([...built.surface.system, ...built.surface.developer].join("\n\n").length).toBeLessThanOrEqual(64);
  expect(built.surface.contextualUser.join("\n\n").length).toBeLessThanOrEqual(64);
  expect(built.surface.tools.map((tool) => tool.name)).toEqual(["safe_lookup", "dynamic_schema"]);
  expect(JSON.stringify({
    name: built.surface.tools[0]?.name,
    description: built.surface.tools[0]?.description,
    inputSchema: built.surface.tools[0]?.inputSchema,
  }).length).toBeLessThanOrEqual(160);
  expect(dynamicSchemaSerializations).toBe(1);
  expect(dynamicDescriptionReads).toBe(1);
  expect(JSON.stringify({
    name: built.surface.tools[1]?.name,
    description: built.surface.tools[1]?.description,
    inputSchema: built.surface.tools[1]?.inputSchema,
  }).length).toBeLessThanOrEqual(160);
  expect(safeTool.description.length).toBe(400);
});

test("context builder shares the instruction limit with stored system messages", () => {
  const sessionId = "session_system_instruction_limit" as SessionId;
  const storedSystem = textMessage(
    "msg_stored_system_limit",
    sessionId,
    "system",
    "h".repeat(70),
  );

  const built = new ContextWindowBuilder({
    maxInputChars: 10_000,
    maxPromptItemChars: 80,
  }).build([storedSystem], {
    system: ["s".repeat(70)],
  });
  const serializedInstructions = [
    ...built.surface.system,
    ...built.surface.developer,
    ...built.messages
      .filter((message) => message.role === "system")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text" || part.type === "reasoning")
      .map((part) => part.text),
  ].join("\n\n");

  expect(serializedInstructions.length).toBeLessThanOrEqual(80);
});

test("runtime sends the bounded request surface to the model", async () => {
  const store = new ProjectingEventStore();
  const registry = new InMemoryToolRegistry();
  let hiddenExecutions = 0;
  registry.register({
    name: "bounded_lookup",
    description: "d".repeat(400),
    risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    resources: () => false,
    execute: async () => ({ title: "lookup", output: "done" }),
  });
  registry.register({
    name: "hidden_oversized_schema",
    description: "oversized",
    risk: "read",
    inputSchema: { type: "object", description: "s".repeat(2_000) },
    resources: () => false,
    execute: async () => {
      hiddenExecutions++;
      return { title: "oversized", output: "done" };
    },
  });
  const modelInputs: ModelStreamInput[] = [];
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelInputs.push(input);
      yield { type: "tool_call", name: "hidden_oversized_schema", input: {} };
      yield { type: "finish", reason: "tool_use" };
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      gate: { review: async () => ({ decision: "allow" }) },
    }),
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    contextBudget: {
      maxInputChars: 10_000,
      maxPromptItemChars: 64,
      maxToolDefinitionChars: 160,
    },
  });

  const sessionId = await runtime.createSession({ cwd: "/repo" });
  await runtime.appendUserMessage({
    sessionId,
    text: "hello",
  });
  const result = await runtime.runTurn({
    sessionId,
    cwd: "/repo",
    system: ["s".repeat(400)],
    developer: ["d".repeat(400)],
    contextualUser: ["u".repeat(400)],
  });

  expect(result.status).toBe("completed");
  expect(modelInputs).toHaveLength(1);
  expect(modelInputs[0]?.system.every((item) => item.length <= 64)).toBe(true);
  expect((modelInputs[0]?.developer ?? []).every((item) => item.length <= 64)).toBe(true);
  expect(modelInputs[0]?.contextualUser?.every((item) => item.length <= 64)).toBe(true);
  expect(modelInputs[0]?.tools.map((tool) => tool.name)).toEqual(["bounded_lookup"]);
  expect(hiddenExecutions).toBe(0);
});

test("runtime fails before model streaming when fixed input exhausts the model window", async () => {
  const store = new ProjectingEventStore();
  const registry = new InMemoryToolRegistry();
  let modelCalls = 0;
  const model: ModelRouter = {
    resolveRequestLimits() {
      return { contextWindowTokens: 64, requestMaxOutputTokens: 16 };
    },
    async *stream(): AsyncIterable<ModelStreamEvent> {
      modelCalls++;
      yield { type: "finish", reason: "stop" };
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      gate: { review: async () => ({ decision: "allow" }) },
    }),
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    contextBudget: {
      maxInputChars: 10_000,
      framingSafetyTokens: 0,
    },
  });

  const sessionId = await runtime.createSession({ cwd: "/repo" });
  await runtime.appendUserMessage({
    sessionId,
    text: "u".repeat(100),
  });
  const result = await runtime.runTurn({
    sessionId,
    cwd: "/repo",
    system: ["s".repeat(200)],
  });

  expect(result.status).toBe("failed");
  if (result.status === "completed") throw new Error("expected context overflow failure");
  expect(result.error?.name).toBe("ContextWindowExceededError");
  expect(modelCalls).toBe(0);
});

test("conversation and compaction formatting preserve controlled tool execution context", async () => {
  const sessionId = "session_compaction_execution_context" as SessionId;
  const turnId = "turn_compaction_execution_context" as TurnId;
  const source = toolResultMessage(
    "msg_compaction_execution_context",
    sessionId,
    "compaction_execution_context",
    "command output",
  );
  const result = source.parts.find((part) => part.type === "tool_result");
  if (result?.type !== "tool_result") throw new Error("expected tool result");
  result.executionContext = toolExecutionContext();
  const footer = toolExecutionContextFooter();
  const ordinary = toolResultMessage(
    "msg_compaction_ordinary_result",
    sessionId,
    "compaction_ordinary_result",
    "plain output",
  );

  expect(formatConversationMessages([source])).toContain(footer);
  expect(formatCompactionSourceMessages([source])).toContain(footer);
  expect(formatConversationMessages([ordinary])).toBe([
    "[assistant msg_compaction_ordinary_result]",
    "[tool_call test_tool compaction_ordinary_result completed]",
    "{}",
    "[tool_result compaction_ordinary_result]",
    "plain output",
  ].join("\n"));

  let compactionPrompt = "";
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      const prompt = input.messages[0]?.parts.find((part) => part.type === "text");
      compactionPrompt = prompt?.type === "text" ? prompt.text : "";
      yield { type: "text_delta", text: "<context_summary>command context retained</context_summary>" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const compactor = new ContextCompactionService({
    model,
    verifySummary: false,
    now: () => 1 as TimestampMs,
  });

  await compactor.compact({
    sessionId,
    turnId,
    messages: [source],
    boundary: {
      boundaryMessageId: source.id,
      reason: "manual",
      estimatedChars: 1_000,
      budgetChars: 10_000,
    },
  });

  expect(compactionPrompt).toContain(footer);
});

test("compaction fits draft and verification requests to the selected model limits", async () => {
  const sessionId = "session_compaction_limits" as SessionId;
  const turnId = "turn_compaction_limits" as TurnId;
  const source = textMessage("msg_compaction_limits", sessionId, "user", `old context ${"x".repeat(80_000)}`);
  const modelInputs: ModelStreamInput[] = [];
  let limitSelection: unknown;
  const model: ModelRouter = {
    resolveRequestLimits(input) {
      limitSelection = input.modelSelection;
      return { contextWindowTokens: 8_192, requestMaxOutputTokens: 1_024 };
    },
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelInputs.push(input);
      const fitted = new ContextWindowBuilder({
        maxInputChars: Number.MAX_SAFE_INTEGER,
        compactionThresholdRatio: 1,
        preserveRecentMessages: 1,
      }).build(input.messages, {
        contextWindowTokens: 8_192,
        ...(input.maxTokens !== undefined ? { requestMaxOutputTokens: input.maxTokens } : {}),
        system: input.system,
      });
      expect(fitted.overflow).toBeUndefined();
      expect(fitted.messages).toHaveLength(1);
      const verification = input.messages[0]?.parts.some(
        (part) => part.type === "text" && part.text.includes("<draft_summary>"),
      ) ?? false;
      yield {
        type: "text_delta",
        text: verification
          ? "<context_summary>verified compact handoff</context_summary>"
          : "<context_summary>draft compact handoff</context_summary>",
      };
      yield {
        type: "finish",
        reason: "stop",
        usage: verification
          ? { inputTokens: 90, outputTokens: 30, totalTokens: 120 }
          : { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 10, totalTokens: 130 },
      };
    },
  };
  const compactor = new ContextCompactionService({
    model,
    maxSummaryChars: 2_000,
    now: () => 1 as TimestampMs,
  });

  const result = await compactor.compact({
    sessionId,
    turnId,
    messages: [source],
    boundary: {
      boundaryMessageId: source.id,
      reason: "manual",
      estimatedChars: 80_000,
      budgetChars: 160_000,
    },
    modelSelection: { provider: "openai-codex", model: "gpt-selected" },
  });

  expect(limitSelection).toEqual({ provider: "openai-codex", model: "gpt-selected" });
  expect(modelInputs).toHaveLength(2);
  expect(modelInputs.every((input) => input.maxTokens === 1_024)).toBe(true);
  expect(modelInputs.every((input) => {
    const text = input.messages[0]?.parts.find((part) => part.type === "text");
    return text?.type === "text" && text.text.length < 80_000;
  })).toBe(true);
  expect(result.usage).toEqual({
    inputTokens: 190,
    outputTokens: 50,
    cacheReadInputTokens: 10,
    totalTokens: 250,
  });
});

test("compaction hard-limits every synthesized model prompt", async () => {
  const sessionId = "session_compaction_prompt_limit" as SessionId;
  const source = textMessage(
    "msg_compaction_prompt_limit",
    sessionId,
    "user",
    "context to summarize",
  );
  const modelInputs: ModelStreamInput[] = [];
  const compactor = new ContextCompactionService({
    model: {
      async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
        modelInputs.push(input);
        if (modelInputs.length === 1) {
          yield { type: "text_delta", text: `<context_summary>${"d".repeat(2_000)}</context_summary>` };
        } else {
          yield { type: "text_delta", text: "<context_summary>bounded summary</context_summary>" };
        }
        yield { type: "finish", reason: "stop" };
      },
    },
    maxPromptChars: 400,
    maxSummaryChars: 100,
  });

  await compactor.compact({
    sessionId,
    turnId: "turn_compaction_prompt_limit" as TurnId,
    messages: [source],
    boundary: {
      boundaryMessageId: source.id,
      reason: "manual",
      estimatedChars: 100,
      budgetChars: 1_000,
    },
    instructions: "focus".repeat(1_000),
  });

  expect(modelInputs).toHaveLength(2);
  for (const input of modelInputs) {
    const part = input.messages[0]?.parts[0];
    expect(part?.type).toBe("text");
    if (part?.type === "text") expect(part.text.length).toBeLessThanOrEqual(400);
  }
});

test("compaction budgets the exact prompt that it sends", async () => {
  const sessionId = "session_compaction_exact_prompt" as SessionId;
  const source = textMessage(
    "msg_compaction_exact_prompt",
    sessionId,
    "user",
    "x".repeat(119_000),
  );
  const modelInputs: ModelStreamInput[] = [];
  const compactor = new ContextCompactionService({
    model: {
      resolveRequestLimits() {
        return { contextWindowTokens: 25_000, requestMaxOutputTokens: 1_000 };
      },
      async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
        modelInputs.push(input);
        yield { type: "text_delta", text: "<context_summary>bounded</context_summary>" };
        yield { type: "finish", reason: "stop" };
      },
    },
    verifySummary: false,
    maxPromptChars: 160_000,
  });

  await compactor.compact({
    sessionId,
    turnId: "turn_compaction_exact_prompt" as TurnId,
    messages: [source],
    boundary: {
      boundaryMessageId: source.id,
      reason: "manual",
      estimatedChars: 119_000,
      budgetChars: 160_000,
    },
  });

  const sent = modelInputs[0]?.messages[0]?.parts[0];
  expect(sent?.type).toBe("text");
  if (sent?.type === "text") expect(sent.text.length).toBeLessThan(100_000);
});

test("compaction preserves usage when an empty model summary fails validation", async () => {
  const sessionId = "session_compaction_empty" as SessionId;
  const source = textMessage("msg_compaction_empty", sessionId, "user", "context to summarize");
  const compactor = new ContextCompactionService({
    model: {
      async *stream(): AsyncIterable<ModelStreamEvent> {
        yield { type: "finish", reason: "stop", usage: { inputTokens: 8, outputTokens: 1, totalTokens: 9 } };
      },
    },
    verifySummary: false,
  });

  try {
    await compactor.compact({
      sessionId,
      turnId: "turn_compaction_empty" as TurnId,
      messages: [source],
      boundary: {
        boundaryMessageId: source.id,
        reason: "manual",
        estimatedChars: 100,
        budgetChars: 1_000,
      },
    });
    throw new Error("expected empty compaction to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("empty summary");
    expect(takeModelUsage(error as Error)).toEqual({ inputTokens: 8, outputTokens: 1, totalTokens: 9 });
  }
});

test("compaction preserves draft and verifier usage when verification fails", async () => {
  const sessionId = "session_compaction_verify_error" as SessionId;
  const source = textMessage("msg_compaction_verify_error", sessionId, "user", "context to summarize");
  let calls = 0;
  const compactor = new ContextCompactionService({
    model: {
      async *stream(): AsyncIterable<ModelStreamEvent> {
        calls++;
        if (calls === 1) {
          yield { type: "text_delta", text: "<context_summary>draft</context_summary>" };
          yield { type: "finish", reason: "stop", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
          return;
        }
        yield {
          type: "error",
          error: new Error("verification failed"),
          usage: { inputTokens: 7, outputTokens: 1, cacheReadInputTokens: 2, totalTokens: 10 },
        };
      },
    },
  });

  try {
    await compactor.compact({
      sessionId,
      turnId: "turn_compaction_verify_error" as TurnId,
      messages: [source],
      boundary: {
        boundaryMessageId: source.id,
        reason: "manual",
        estimatedChars: 100,
        budgetChars: 1_000,
      },
    });
    throw new Error("expected verification to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("verification failed");
    expect(takeModelUsage(error as Error)).toEqual({
      inputTokens: 17,
      outputTokens: 3,
      cacheReadInputTokens: 2,
      totalTokens: 22,
    });
  }
});

test("runtime auto-compacts before the main model request and sends the summary forward", async () => {
  const store = new ProjectingEventStore();
  const registry = new InMemoryToolRegistry();
  const modelInputs: ModelStreamInput[] = [];
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelInputs.push(input);
      if (input.system.some((item) => item.includes("context compression engine"))) {
        const promptText = input.messages.flatMap((message) => message.parts).map(modelVisiblePartText).join("\n");
        const isVerification = promptText.includes("<draft_summary>");
        yield {
          type: "text_delta",
          text: isVerification
            ? [
                "<context_summary>",
                "Current goal: keep the important old request after verification.",
                "Next steps: answer using the revised summary.",
                "</context_summary>",
              ].join("\n")
            : [
                "<context_summary>",
                "Current goal: draft only.",
                "Next steps: ask verifier to revise.",
                "</context_summary>",
              ].join("\n"),
        };
        yield {
          type: "finish",
          reason: "stop",
          usage: isVerification
            ? { inputTokens: 12, outputTokens: 3, totalTokens: 15 }
            : { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        };
        return;
      }

      yield { type: "text_delta", text: "done" };
      yield { type: "finish", reason: "stop", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } };
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      gate: { review: async () => ({ decision: "allow" }) },
    }),
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    contextBudget: {
      maxInputChars: 220,
      compactionThresholdRatio: 0.5,
      preserveRecentMessages: 1,
    },
  });

  const sessionId = await runtime.createSession({ cwd: "/repo" });
  await runtime.appendUserMessage({
    sessionId,
    text: `old context ${"x".repeat(500)}`,
  });
  const result = await runtime.runTurn({
    sessionId,
    cwd: "/repo",
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
  });

  expect(result.status).toBe("completed");
  expect(result.usage).toEqual({ inputTokens: 27, outputTokens: 6, totalTokens: 33 });
  expect(modelInputs).toHaveLength(3);
  expect(modelInputs.slice(0, 2).every((modelInput) => modelInput.system.join("\n").includes("context compression engine"))).toBe(true);
  expect(modelInputs.every((modelInput) => (
    modelInput.modelSelection?.provider === "openai-codex"
    && modelInput.modelSelection.model === "gpt-5.5"
  ))).toBe(true);
  const mainInputText = modelInputs.at(-1)?.messages.flatMap((message) => message.parts).map(modelVisiblePartText).join("\n") ?? "";
  expect(mainInputText).toContain("<context_summary");
  expect(mainInputText).toContain("Current goal: keep the important old request after verification.");
  expect(mainInputText.match(/<context_summary/g)?.length).toBe(1);
  expect(mainInputText).not.toContain("old context xxx");
  expect(store.items.some((event) => event.type === "turn.compaction_completed")).toBe(true);
  expect(store.items.some((event) => event.type === "message.part_added" && event.payload.part.type === "compaction")).toBe(true);
  const compactionMessageIds = new Set<string>();
  for (const event of store.items) {
    if (event.type === "message.part_added" && event.payload.part.type === "compaction") {
      compactionMessageIds.add(event.payload.messageId);
    }
  }
  expect(
    store.items.some(
      (event) =>
        event.type === "message.created" &&
        event.payload.role === "user" &&
        compactionMessageIds.has(event.payload.messageId),
    ),
  ).toBe(true);
});

test("runtime reactively compacts and retries context limit failures before output starts", async () => {
  await expectReactiveCompactionRecovery(() => new Error("context window exceeded"));
});

test("runtime recovers from structured context-limit codes, types, and statuses with generic messages", async () => {
  await expectReactiveCompactionRecovery(() => {
    const error = new Error("Model request failed with HTTP 400 Bad Request") as Error & {
      name: string;
      code: string;
      type: string;
      status: number;
    };
    error.name = "ProviderError";
    error.code = "context_length_exceeded";
    error.type = "invalid_request_error";
    error.status = 400;
    return error;
  });
  await expectReactiveCompactionRecovery(() => Object.assign(
    new Error("Model response rejected"),
    { name: "ProviderError", type: "context_window_exceeded", status: 400 },
  ));
  await expectReactiveCompactionRecovery(() => Object.assign(
    new Error("Model response rejected"),
    { name: "ProviderError", status: 413 },
  ));
});

async function expectReactiveCompactionRecovery(firstError: () => Error): Promise<void> {
  const store = new ProjectingEventStore();
  const registry = new InMemoryToolRegistry();
  let mainCalls = 0;
  let compactionCalls = 0;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      if (input.system.some((item) => item.includes("context compression engine"))) {
        compactionCalls++;
        yield {
          type: "text_delta",
          text: [
            "<context_summary>",
            "Current goal: recover from a context limit error.",
            "Next steps: retry the original model request.",
            "</context_summary>",
          ].join("\n"),
        };
        yield { type: "finish", reason: "stop" };
        return;
      }

      mainCalls++;
      if (mainCalls === 1) {
        yield { type: "metadata", provider: "test", model: "large-context", responseId: "resp_before_recovery" };
        throw firstError();
      }
      const modelText = input.messages.flatMap((message) => message.parts).map(modelVisiblePartText).join("\n");
      expect(modelText).toContain("recover from a context limit error");
      yield { type: "text_delta", text: "recovered" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      gate: { review: async () => ({ decision: "allow" }) },
    }),
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    contextBudget: {
      maxInputChars: 10_000,
      compactionThresholdRatio: 0.95,
      preserveRecentMessages: 0,
    },
  });

  const sessionId = await runtime.createSession({ cwd: "/repo" });
  await runtime.appendUserMessage({
    sessionId,
    text: "please continue after recovery",
  });
  const result = await runtime.runTurn({
    sessionId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  expect(mainCalls).toBe(2);
  expect(compactionCalls).toBe(2);
  expect(
    store.items.some(
      (event) => event.type === "turn.compaction_requested" && event.payload.reason === "recovery",
    ),
  ).toBe(true);
}

class ProjectingEventStore implements EventStore {
  readonly items: ChiliEvent[] = [];
  private readonly messagesById = new Map<string, Message>();
  private readonly messageOrder: string[] = [];

  async append(event: ChiliEvent): Promise<void> {
    this.items.push(event);
    this.project(event);
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    const afterIndex = query.afterEventId
      ? this.items.findIndex((event) => event.id === query.afterEventId)
      : -1;
    return this.items
      .slice(afterIndex + 1)
      .filter((event) => {
        if (query.sessionId && event.sessionId !== query.sessionId) return false;
        if (query.type && event.type !== query.type) return false;
        return true;
      })
      .slice(0, query.limit ?? 500);
  }

  async sessions(): Promise<SessionRow[]> {
    return [];
  }

  async messages(sessionId: SessionId): Promise<Message[]> {
    return this.messageOrder
      .map((id) => this.messagesById.get(id))
      .filter((message): message is Message => message !== undefined && message.sessionId === sessionId)
      .map((message) => ({ ...message, parts: message.parts.map((part) => ({ ...part }) as MessagePart) }));
  }

  async pendingApprovals(): Promise<ApprovalRow[]> {
    return [];
  }

  private project(event: ChiliEvent): void {
    if (event.type === "message.created") {
      if (!event.sessionId) throw new Error("message.created requires sessionId");
      this.messageOrder.push(event.payload.messageId);
      this.messagesById.set(event.payload.messageId, {
        id: event.payload.messageId,
        sessionId: event.sessionId,
        role: event.payload.role,
        parts: [],
        createdAt: event.time,
      });
      return;
    }

    if (event.type === "message.part_added") {
      const message = this.messagesById.get(event.payload.messageId);
      if (message) message.parts.push(event.payload.part);
      return;
    }

    if (event.type === "message.part_delta") {
      const message = [...this.messagesById.values()].find((candidate) =>
        candidate.parts.some((part) => part.id === event.payload.partId),
      );
      const part = message?.parts.find((candidate) => candidate.id === event.payload.partId);
      if (part && event.payload.field === "text" && (part.type === "text" || part.type === "reasoning")) {
        part.text += event.payload.delta;
      }
    }
  }
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

function textMessage(
  id: string,
  sessionId: SessionId,
  role: Message["role"],
  text: string,
): Message {
  return {
    id: id as MessageId,
    sessionId,
    role,
    createdAt: 1 as TimestampMs,
    parts: [
      {
        id: `part_${id}` as never,
        messageId: id as MessageId,
        sessionId,
        type: "text",
        text,
      },
    ],
  };
}

function compactionMessage(id: string, sessionId: SessionId, boundaryMessageId: MessageId, summary: string): Message {
  return {
    id: id as MessageId,
    sessionId,
    role: "user",
    createdAt: 1 as TimestampMs,
    parts: [
      {
        id: `part_${id}_text` as never,
        messageId: id as MessageId,
        sessionId,
        type: "text",
        text: `<context_summary>\n${summary}\n</context_summary>`,
        synthetic: true,
      },
      {
        id: `part_${id}_compaction` as never,
        messageId: id as MessageId,
        sessionId,
        type: "compaction",
        boundaryMessageId,
        reason: "token_budget",
        summary,
      },
    ],
  };
}

function toolResultMessage(
  id: string,
  sessionId: SessionId,
  callId: string,
  output: string,
  includeCall = true,
): Message {
  return {
    id: id as MessageId,
    sessionId,
    role: "assistant",
    createdAt: 1 as TimestampMs,
    parts: [
      ...(includeCall ? [{
        id: `part_${id}_tool_call` as never,
        messageId: id as MessageId,
        sessionId,
        type: "tool_call" as const,
        callId: callId as never,
        toolName: "test_tool",
        input: {},
        status: "completed" as const,
      }] : []),
      {
        id: `part_${id}_tool_result` as never,
        messageId: id as MessageId,
        sessionId,
        type: "tool_result",
        callId: callId as never,
        output,
      },
    ],
  };
}

function toolExecutionContext(): ToolResultExecutionContext {
  return {
    sandbox: "macos-seatbelt",
    executionMode: "sandboxed",
    exitCode: 17,
    timedOut: false,
    signal: null,
  };
}

function toolExecutionContextFooter(): string {
  return [
    "[tool execution context]",
    "sandbox: macos-seatbelt",
    "execution_mode: sandboxed",
    "exit_code: 17",
    "timed_out: false",
    "signal: null",
  ].join("\n");
}

function modelVisiblePartText(part: MessagePart): string {
  if (part.type === "text" || part.type === "reasoning") return part.text;
  if (part.type === "tool_result") return part.output;
  return "";
}
