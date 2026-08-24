import { expect, test } from "bun:test";
import type {
  Message,
  MessageId,
  MessagePart,
  PartId,
  SessionId,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import {
  buildFailureCheckpoint,
  FAILURE_CHECKPOINT_MAX_CHARS,
} from "./failure-checkpoint.js";

const sessionId = "session_checkpoint" as SessionId;
const completedTurnId = "turn_completed" as TurnId;
const failedTurnId = "turn_failed" as TurnId;

test("builds a bounded checkpoint from prior assistant progress and tool metadata only", () => {
  const messages: Message[] = [
    message("msg_user", "user", completedTurnId, [
      textPart("part_user", "USER PROMPT SECRET", false),
    ], 1),
    message("msg_completed", "assistant", completedTurnId, [
      textPart("part_progress", "Confirmed that runtime cwd is explicit and shared by tool execution.", false, "commentary"),
      reasoningPart("part_reasoning", "PRIVATE REASONING SECRET"),
      toolCallPart("part_call", "call_read", "read", { filePath: "packages/core/src/runner.ts" }),
      toolResultPart("part_result", "call_read", {
        output: "TOOL OUTPUT SECRET",
        error: "",
      }),
    ], 2),
    message("msg_failed", "assistant", failedTurnId, [
      textPart(
        "part_provider_failure",
        "Model request failed: <!DOCTYPE html><html><title>502 Bad Gateway</title><body>RAW PROVIDER BODY</body></html>",
        true,
      ),
    ], 3),
  ];

  const checkpoint = buildFailureCheckpoint({
    messages,
    completedTurnIds: [completedTurnId],
    failedTurnId,
  });

  expect(checkpoint).toBeDefined();
  expect(checkpoint).toContain("Incomplete partial result");
  expect(checkpoint).toContain("Confirmed that runtime cwd is explicit");
  expect(checkpoint).toContain("read: completed (packages/core/src/runner.ts)");
  expect(checkpoint).not.toContain("USER PROMPT SECRET");
  expect(checkpoint).not.toContain("PRIVATE REASONING SECRET");
  expect(checkpoint).not.toContain("TOOL OUTPUT SECRET");
  expect(checkpoint).not.toContain("RAW PROVIDER BODY");
  expect(checkpoint).not.toContain("<!DOCTYPE html>");
  expect(checkpoint?.length).toBeLessThanOrEqual(FAILURE_CHECKPOINT_MAX_CHARS);
});

test("returns undefined when the failed turn already has non-synthetic assistant text", () => {
  const checkpoint = buildFailureCheckpoint({
    messages: [
      message("msg_completed", "assistant", completedTurnId, [
        textPart("part_progress", "Earlier progress.", false),
      ], 1),
      message("msg_failed", "assistant", failedTurnId, [
        textPart("part_partial_answer", "A partial answer was already streamed.", false, "final_answer"),
      ], 2),
    ],
    completedTurnIds: [completedTurnId],
    failedTurnId,
  });

  expect(checkpoint).toBeUndefined();
});

test("does not create a checkpoint from failed-turn or unfinished tool activity alone", () => {
  expect(buildFailureCheckpoint({
    messages: [
      message("msg_failed", "assistant", failedTurnId, [
        toolCallPart("part_failed_call", "call_failed", "read", { filePath: "private.txt" }),
        toolResultPart("part_failed_result", "call_failed", { output: "failed turn output" }),
      ], 1),
    ],
    completedTurnIds: [],
    failedTurnId,
  })).toBeUndefined();

  expect(buildFailureCheckpoint({
    messages: [
      message("msg_unfinished", "assistant", completedTurnId, [
        toolCallPart("part_unfinished_call", "call_unfinished", "read", { filePath: "private.txt" }),
      ], 1),
    ],
    completedTurnIds: [completedTurnId],
    failedTurnId,
  })).toBeUndefined();
});

test("falls back to bounded tool activity and derives failed process status without copying result bodies", () => {
  const parts: MessagePart[] = [];
  for (let index = 0; index < 20; index++) {
    const callId = `call_${index}` as ToolCallId;
    parts.push(toolCallPart(
      `part_call_${index}`,
      callId,
      index === 0 ? "bash" : "read",
      index === 0
        ? { command: "printenv SUPER_SECRET" }
        : { filePath: `packages/core/src/${"very-long-target-".repeat(20)}${index}.ts` },
    ));
    parts.push(toolResultPart(`part_result_${index}`, callId, {
      output: `RESULT BODY SECRET ${index} ${"x".repeat(10_000)}`,
      ...(index === 1 ? { error: "RESULT ERROR SECRET" } : {}),
      exitCode: index === 0 ? 7 : 0,
    }));
  }

  const checkpoint = buildFailureCheckpoint({
    messages: [message("msg_tools", "assistant", completedTurnId, parts, 1)],
    completedTurnIds: [completedTurnId],
    failedTurnId,
  });

  expect(checkpoint).toBeDefined();
  expect(checkpoint).toContain("bash: failed");
  expect(checkpoint).toContain("read: failed");
  expect(checkpoint).toContain("8 additional tool activities omitted");
  expect(checkpoint).not.toContain("printenv SUPER_SECRET");
  expect(checkpoint).not.toContain("RESULT BODY SECRET");
  expect(checkpoint).not.toContain("RESULT ERROR SECRET");
  expect(checkpoint?.length).toBeLessThanOrEqual(FAILURE_CHECKPOINT_MAX_CHARS);
});

test("bounds progress and rejects reasoning or provider failure bodies as progress", () => {
  const checkpoint = buildFailureCheckpoint({
    messages: [
      message("msg_large", "assistant", completedTurnId, [
        textPart("part_large", "confirmed finding ".repeat(2_000), false),
      ], 1),
    ],
    completedTurnIds: [completedTurnId],
    failedTurnId,
  });

  expect(checkpoint).toBeDefined();
  expect(checkpoint?.length).toBeLessThanOrEqual(FAILURE_CHECKPOINT_MAX_CHARS);
  expect(checkpoint).toContain("The task remains incomplete");

  expect(buildFailureCheckpoint({
    messages: [
      message("msg_user_only", "user", completedTurnId, [
        textPart("part_user_only", "do not copy this prompt", false),
      ], 1),
      message("msg_reasoning_only", "assistant", completedTurnId, [
        reasoningPart("part_reasoning_only", "do not expose this reasoning"),
      ], 2),
      message("msg_provider_only", "assistant", completedTurnId, [
        textPart("part_provider_only", "Provider request failed\nRAW PROVIDER BODY SECRET", false),
      ], 3),
    ],
    completedTurnIds: [completedTurnId],
    failedTurnId,
  })).toBeUndefined();
});

function message(
  id: string,
  role: Message["role"],
  turnId: TurnId,
  parts: MessagePart[],
  createdAt: number,
): Message {
  return {
    id: id as MessageId,
    sessionId,
    role,
    parts,
    turnId,
    createdAt: createdAt as Message["createdAt"],
  };
}

function textPart(
  id: string,
  text: string,
  synthetic: boolean,
  phase?: "commentary" | "final_answer",
): Extract<MessagePart, { type: "text" }> {
  return {
    id: id as PartId,
    messageId: `message_for_${id}` as MessageId,
    sessionId,
    type: "text",
    text,
    ...(synthetic ? { synthetic: true } : {}),
    ...(phase ? { phase } : {}),
  };
}

function reasoningPart(id: string, text: string): Extract<MessagePart, { type: "reasoning" }> {
  return {
    id: id as PartId,
    messageId: `message_for_${id}` as MessageId,
    sessionId,
    type: "reasoning",
    text,
  };
}

function toolCallPart(
  id: string,
  callId: string | ToolCallId,
  toolName: string,
  input: unknown,
): Extract<MessagePart, { type: "tool_call" }> {
  return {
    id: id as PartId,
    messageId: `message_for_${id}` as MessageId,
    sessionId,
    type: "tool_call",
    callId: callId as ToolCallId,
    toolName,
    input,
    status: "pending",
  };
}

function toolResultPart(
  id: string,
  callId: string | ToolCallId,
  input: { output: string; error?: string; exitCode?: number },
): Extract<MessagePart, { type: "tool_result" }> {
  return {
    id: id as PartId,
    messageId: `message_for_${id}` as MessageId,
    sessionId,
    type: "tool_result",
    callId: callId as ToolCallId,
    output: input.output,
    ...(input.error ? { error: input.error } : {}),
    ...(input.exitCode === undefined ? {} : { executionContext: { exitCode: input.exitCode } }),
  };
}
