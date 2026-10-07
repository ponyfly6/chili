import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { ContextCompactionService, type ContextCompactionInput, type ContextCompactionResult } from "./compaction.js";
import { compactedMessageView, ContextWindowBuilder } from "./window.js";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "../runtime.js";

const sessionId = "session_coverage" as SessionId;
const turnId = "turn_coverage" as TurnId;

test("every original message, including a 100k middle constraint, reaches both summary stages before coverage advances", async () => {
  const messages = [
    textMessage("head", `HEAD_BEGIN_${"a".repeat(100_000)}_HEAD_END`),
    textMessage("middle", `${"b".repeat(50_000)}DO_NOT_CHANGE_PUBLIC_API${"b".repeat(50_000)}`),
    textMessage("tail", `TAIL_BEGIN_${"c".repeat(100_000)}_TAIL_END`),
    textMessage("retained", "RETAINED_OUTSIDE_COVERAGE"),
  ];
  const before = structuredClone(messages);
  const recorded = recordingModel();
  const input = compactionInput(messages, messages[2]!.id);
  const result = await new ContextCompactionService({ model: recorded.model }).compact(input);

  expect(recorded.requests).toHaveLength(6);
  const drafts = recorded.requests.filter((request) => !isVerification(request));
  const reviews = recorded.requests.filter(isVerification);
  expect(drafts.every((request) => request.purpose === "compaction")).toBe(true);
  expect(reviews.every((request) => request.purpose === "validation")).toBe(true);
  for (const stage of [drafts, reviews]) {
    expect(stage).toHaveLength(3);
    for (const message of messages.slice(0, 3)) {
      const original = textOf(message);
      expect(stage.filter((request) => conversationSource(request).includes(original))).toHaveLength(1);
    }
    expect(stage.filter((request) => conversationSource(request).includes("DO_NOT_CHANGE_PUBLIC_API"))).toHaveLength(1);
    expect(stage.every((request) => !conversationSource(request).includes("RETAINED_OUTSIDE_COVERAGE"))).toBe(true);
  }
  expect(result.boundary).toEqual(input.boundary);
  expect(result.sourceMessageIds).toEqual(messages.slice(0, 3).map((message) => message.id));
  expect(result.sourceMessageCount).toBe(3);
  expect(messages).toEqual(before);
  const committed = summaryMessage("committed", result);
  expect(compactedMessageView([...messages, committed]).map((message) => message.id)).toEqual([
    committed.id, messages[3]!.id,
  ]);
});

test("tool content text is complete evidence alongside the output and image metadata", async () => {
  const messages = toolMessages("content", "short display");
  const resultPart = messages[1]!.parts[0]!;
  if (resultPart.type !== "tool_result") throw new Error("expected result");
  resultPart.content = [{ type: "text", text: "DO_NOT_CHANGE_PUBLIC_API" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }];
  const recorded = recordingModel();
  const result = await new ContextCompactionService({ model: recorded.model }).compact(compactionInput(messages));
  expect(result.sourceMessageIds).toEqual(messages.map((message) => message.id));
  expect(recorded.requests).toHaveLength(2);
  for (const request of recorded.requests) {
    expect(conversationSource(request)).toContain("DO_NOT_CHANGE_PUBLIC_API");
    expect(conversationSource(request)).toContain("short display");
    expect(conversationSource(request)).toContain("[image image/png]");
  }
});

test("oversized tool content cannot bypass admission through a short output preview", async () => {
  const messages = toolMessages("oversized-content", "short display");
  const resultPart = messages[1]!.parts[0]!;
  if (resultPart.type !== "tool_result") throw new Error("expected result");
  resultPart.content = [{ type: "text", text: "x".repeat(121_000) }];
  const recorded = recordingModel();
  await expect(new ContextCompactionService({ model: recorded.model }).compact(compactionInput(messages)))
    .rejects.toThrow("complete message/tool group");
  expect(recorded.requests).toHaveLength(0);
});

for (const [stage, failAt] of [["first draft", 1], ["first review", 2], ["later draft", 3], ["later review", 4]] as const) {
  test(`failure in the ${stage} leaves the entire original prefix available and retryable`, async () => {
    const messages = batchHistory(3, 3_000);
    const before = structuredClone(messages);
    let shouldFail = true;
    const recorded = recordingModel((_request, call) => {
      if (shouldFail && call === failAt) throw new Error(`failed ${stage}`);
      return `<context_summary>summary ${call}</context_summary>`;
    });
    const compactor = new ContextCompactionService({ model: recorded.model, maxSourceChars: 5_000 });
    const input = compactionInput(messages);

    await expect(compactor.compact(input)).rejects.toThrow(`failed ${stage}`);
    expect(messages).toEqual(before);
    expect(compactedMessageView(messages)).toEqual(before);
    expect(input.boundary.boundaryMessageId).toBe(messages[2]!.id);
    expect(recorded.closed()).toBe(failAt);

    shouldFail = false;
    const failedRequestCount = recorded.requests.length;
    const retried = await compactor.compact(input);
    expect(retried.sourceMessageIds).toEqual(messages.map((message) => message.id));
    const retryDrafts = recorded.requests.slice(failedRequestCount).filter((request) => !isVerification(request));
    for (const message of messages) {
      expect(retryDrafts.filter((request) => conversationSource(request).includes(textOf(message)))).toHaveLength(1);
    }
    expect(messages).toEqual(before);
  });
}

for (const cancelAt of [1, 3]) {
  test(`cancelling summary request ${cancelAt} closes its iterator and commits no covered history`, async () => {
    const messages = batchHistory(2, 3_000);
    const before = structuredClone(messages);
    const controller = new AbortController();
    let calls = 0;
    let closed = 0;
    const model: ModelRouter = {
      async *stream(): AsyncIterable<ModelStreamEvent> {
        calls++;
        try {
          yield { type: "text_delta", text: "<context_summary>partial" };
          if (calls === cancelAt) controller.abort(new Error("cancelled compaction"));
          yield { type: "text_delta", text: "</context_summary>" };
          yield { type: "finish", reason: "stop" };
        } finally {
          closed++;
        }
      },
    };

    await expect(new ContextCompactionService({ model, maxSourceChars: 5_000 }).compact({
      ...compactionInput(messages), signal: controller.signal,
    })).rejects.toThrow("cancelled compaction");
    expect(calls).toBe(cancelAt);
    expect(closed).toBe(cancelAt);
    expect(compactedMessageView(messages)).toEqual(before);
  });
}

test("cancellation while preparing the request prevents the model from starting", async () => {
  const controller = new AbortController();
  const recorded = recordingModel();
  let prepared = 0;
  await expect(new ContextCompactionService({ model: recorded.model }).compact({
    ...compactionInput([textMessage("prepared", "complete original evidence")]),
    signal: controller.signal,
    async onPreparedRequest() {
      prepared++;
      controller.abort(new Error("cancelled during preparation"));
    },
  })).rejects.toThrow("cancelled during preparation");
  expect(prepared).toBe(1);
  expect(recorded.requests).toHaveLength(0);
});

test("oversized single messages and complete tool groups are rejected without clipped model requests", async () => {
  for (const messages of [
    [textMessage("oversized", "DO_NOT_CLIP_".repeat(1_000))],
    toolMessages("oversized_tool", "FULL_TOOL_RESULT_".repeat(1_000)),
  ]) {
    const recorded = recordingModel();
    const before = structuredClone(messages);
    await expect(new ContextCompactionService({
      model: recorded.model, maxSourceChars: 2_000,
    }).compact(compactionInput(messages))).rejects.toThrow(/complete message\/tool group/);
    expect(recorded.requests).toHaveLength(0);
    expect(compactedMessageView(messages)).toEqual(before);
  }
});

test("cross-message tool calls and results stay together in every evidence batch", async () => {
  const pair = toolMessages("pair", `TOOL_RESULT_${"r".repeat(600)}`);
  const messages = [textMessage("before_pair", "p".repeat(900)), ...pair, textMessage("after_pair", "q".repeat(900))];
  const recorded = recordingModel();
  const result = await new ContextCompactionService({
    model: recorded.model, maxSourceChars: 1_500,
  }).compact(compactionInput(messages));

  expect(result.sourceMessageIds).toEqual(messages.map((message) => message.id));
  for (const request of recorded.requests) {
    const source = conversationSource(request);
    const call = source.indexOf("[tool_call test_tool call_pair]");
    const output = source.indexOf("[tool_result call_pair]");
    expect(call >= 0).toBe(output >= 0);
    if (call >= 0) {
      expect(output).toBeGreaterThan(call);
      expect(source).toContain("TOOL_RESULT_" + "r".repeat(600));
    }
  }
  expect(recorded.requests.filter((request) => conversationSource(request).includes("[tool_result call_pair]"))).toHaveLength(2);
});

test("an unfinished call cannot be declared covered even when a summary model would accept it", async () => {
  const [call] = toolMessages("unfinished", "not yet available");
  const recorded = recordingModel();
  await expect(new ContextCompactionService({ model: recorded.model }).compact(
    compactionInput([textMessage("before_unfinished", "history"), call!]),
  )).rejects.toThrow(/without results/);
  expect(recorded.requests).toHaveLength(0);
});

test("a small model window budgets complete evidence, focus, system prompt, review draft and output reserve", async () => {
  const messages = [0, 1, 2].map((index) => textMessage(`small_${index}`, `${index}_${"界".repeat(400)}`));
  const recorded = recordingModel();
  recorded.model.resolveRequestLimits = () => ({ contextWindowTokens: 4_096, requestMaxOutputTokens: 128 });
  const focus = "Keep the original constraints and exact file names.";
  const result = await new ContextCompactionService({ model: recorded.model }).compact({
    ...compactionInput(messages), instructions: focus,
  });

  expect(recorded.requests.length).toBeGreaterThan(2);
  expect(result.sourceMessageIds).toEqual(messages.map((message) => message.id));
  for (const request of recorded.requests) {
    expect(request.maxTokens).toBe(128);
    expect(requestText(request)).toContain(focus);
    const rebuilt = new ContextWindowBuilder({
      maxInputChars: Number.MAX_SAFE_INTEGER,
      maxMessagePartChars: Number.MAX_SAFE_INTEGER,
      maxPromptItemChars: Number.MAX_SAFE_INTEGER,
    }).build(request.messages, {
      contextWindowTokens: 4_096,
      requestMaxOutputTokens: request.maxTokens!,
      system: request.system,
      tools: request.tools,
    });
    expect(rebuilt.overflow).toBeUndefined();
    expect(rebuilt.messages).toEqual(request.messages);
    expect(rebuilt.usage.contextTokens! + rebuilt.usage.fixedInputTokens! + rebuilt.usage.outputReserveTokens! + 2_048)
      .toBeLessThanOrEqual(4_096);
  }
  for (const message of messages) {
    expect(recorded.requests.filter((request) => conversationSource(request).includes(textOf(message)))).toHaveLength(2);
  }
});

test("impossible fixed prompt and model budgets fail before sending or trimming evidence", async () => {
  const messages = [textMessage("tiny", "ORIGINAL_EVIDENCE")];
  const tiny = recordingModel();
  tiny.model.resolveRequestLimits = () => ({ contextWindowTokens: 128, requestMaxOutputTokens: 64 });
  await expect(new ContextCompactionService({ model: tiny.model }).compact(compactionInput(messages))).rejects.toThrow(/budget/);
  expect(tiny.requests).toHaveLength(0);

  const longFocus = recordingModel();
  await expect(new ContextCompactionService({ model: longFocus.model, maxPromptChars: 1_000 }).compact({
    ...compactionInput(messages), instructions: "MANDATORY_FOCUS_".repeat(1_000),
  })).rejects.toThrow(/budget/);
  expect(longFocus.requests).toHaveLength(0);
});

test("an existing large summary is either covered completely with new history or rejected intact", async () => {
  const old = textMessage("old", "raw history already represented");
  const existingSummary = `OLD_SUMMARY_BEGIN_${"s".repeat(1_400)}_OLD_SUMMARY_END`;
  const existing = summaryMessage("existing", {
    boundary: compactionInput([old]).boundary,
    summary: existingSummary,
    sourceMessageIds: [old.id], sourceMessageCount: 1, estimatedCharsBefore: 2_000, estimatedCharsAfter: 1_400,
  });
  const added = textMessage("new_after_summary", `NEW_EVIDENCE_${"n".repeat(400)}`);
  const messages = [old, existing, added];
  const recorded = recordingModel();
  const result = await new ContextCompactionService({ model: recorded.model, maxSourceChars: 2_500 }).compact(compactionInput(messages));
  expect(recorded.requests).toHaveLength(2);
  expect(recorded.requests.every((request) => conversationSource(request).includes(existingSummary))).toBe(true);
  expect(recorded.requests.every((request) => conversationSource(request).includes(textOf(added)))).toBe(true);
  expect(result.sourceMessageIds).toEqual([existing.id, added.id]);

  const tooSmall = recordingModel();
  const before = structuredClone(messages);
  await expect(new ContextCompactionService({ model: tooSmall.model, maxSourceChars: 1_700 }).compact(compactionInput(messages)))
    .rejects.toThrow(/complete message\/tool group/);
  expect(tooSmall.requests).toHaveLength(0);
  expect(messages).toEqual(before);
  expect(compactedMessageView(messages).map((message) => message.id)).toEqual([existing.id, added.id]);
});

test("three consecutive compactions consume the prior summary and each new message exactly once", async () => {
  const recorded = recordingModel((_request, call) => `<context_summary>handoff_${call}</context_summary>`);
  const compactor = new ContextCompactionService({ model: recorded.model });
  const first = textMessage("first", "FIRST_RAW_REQUIREMENT");
  const second = textMessage("second", "SECOND_RAW_REQUIREMENT");
  const retained = textMessage("retained", "RETAINED_REQUIREMENT");
  const messages = [first, second, retained];
  const result1 = await compactor.compact(compactionInput(messages, second.id));
  const summary1 = summaryMessage("summary_1", result1);
  const added = textMessage("added", "ADDED_REQUIREMENT");
  messages.push(summary1, added);
  const result2 = await compactor.compact(compactionInput(messages, retained.id));
  const summary2 = summaryMessage("summary_2", result2);
  const newest = textMessage("newest", "NEWEST_UNCOVERED_REQUIREMENT");
  messages.push(summary2, newest);
  const result3 = await compactor.compact(compactionInput(messages, added.id));
  const summary3 = summaryMessage("summary_3", result3);
  messages.push(summary3);

  expect(result1.sourceMessageIds).toEqual([first.id, second.id]);
  expect(result2.sourceMessageIds).toEqual([summary1.id, retained.id]);
  expect(result3.sourceMessageIds).toEqual([summary2.id, added.id]);
  expect(compactedMessageView(messages).map((message) => message.id)).toEqual([summary3.id, newest.id]);
  const sources = recorded.requests.filter((request) => !isVerification(request)).map(conversationSource);
  expect(sources).toHaveLength(3);
  for (const marker of ["FIRST_RAW_REQUIREMENT", "SECOND_RAW_REQUIREMENT", "RETAINED_REQUIREMENT", "ADDED_REQUIREMENT"]) {
    expect(sources.filter((source) => source.includes(marker))).toHaveLength(1);
  }
  expect(sources[1]).toContain(result1.summary);
  expect(sources[2]).toContain(result2.summary);
  expect(sources[2]).not.toContain(result1.summary);
  expect(sources.every((source) => !source.includes("NEWEST_UNCOVERED_REQUIREMENT"))).toBe(true);
});

test("batch work is bounded and exhaustion never publishes a partially covered prefix", async () => {
  const messages = batchHistory(3, 3_000);
  const before = structuredClone(messages);
  const recorded = recordingModel();
  await expect(new ContextCompactionService({ model: recorded.model, maxSourceChars: 5_000, maxBatches: 2 })
    .compact(compactionInput(messages))).rejects.toThrow(/batch limit/);
  expect(recorded.requests).toHaveLength(4);
  expect(compactedMessageView(messages)).toEqual(before);

  const capped = recordingModel();
  await expect(new ContextCompactionService({ model: capped.model, maxSourceChars: 1_000, maxBatches: 100, verifySummary: false })
    .compact(compactionInput(batchHistory(33, 800)))).rejects.toThrow(/batch limit/);
  expect(capped.requests).toHaveLength(32);
});

test("an oversized generated summary is rejected and its iterator closed instead of silently clipped", async () => {
  const messages = [textMessage("source_for_large_output", "source evidence")];
  const before = structuredClone(messages);
  const recorded = recordingModel(() => `<context_summary>${"z".repeat(200)}</context_summary>`);
  await expect(new ContextCompactionService({ model: recorded.model, maxSummaryChars: 100 }).compact(compactionInput(messages)))
    .rejects.toThrow(/summary exceeded/);
  expect(recorded.requests).toHaveLength(1);
  expect(recorded.closed()).toBe(1);
  expect(compactedMessageView(messages)).toEqual(before);
});

function recordingModel(response: (input: ModelStreamInput, call: number) => string = () => "<context_summary>verified handoff</context_summary>"): {
  model: ModelRouter;
  requests: ModelStreamInput[];
  closed: () => number;
} {
  const requests: ModelStreamInput[] = [];
  let closed = 0;
  return {
    requests,
    closed: () => closed,
    model: {
      async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
        requests.push(input);
        try {
          yield { type: "text_delta", text: response(input, requests.length) };
          yield { type: "finish", reason: "stop" };
        } finally {
          closed++;
        }
      },
    },
  };
}

function textMessage(id: string, text: string): Message {
  const messageId = `msg_${id}` as MessageId;
  return {
    id: messageId, sessionId, role: "user", createdAt: 1 as TimestampMs,
    parts: [{ id: `part_${id}` as PartId, messageId, sessionId, type: "text", text }],
  };
}

function toolMessages(id: string, output: string): Message[] {
  const callId = `call_${id}` as ToolCallId;
  const callMessageId = `msg_${id}_call` as MessageId;
  const resultMessageId = `msg_${id}_result` as MessageId;
  return [{
    id: callMessageId, sessionId, role: "assistant", createdAt: 1 as TimestampMs,
    parts: [{
      id: `part_${id}_call` as PartId, messageId: callMessageId, sessionId,
      type: "tool_call", callId, toolName: "test_tool", input: { path: "required.txt" }, status: "completed",
    }],
  }, {
    id: resultMessageId, sessionId, role: "assistant", createdAt: 1 as TimestampMs,
    parts: [{ id: `part_${id}_result` as PartId, messageId: resultMessageId, sessionId, type: "tool_result", callId, output }],
  }];
}

function summaryMessage(id: string, result: ContextCompactionResult): Message {
  const message = textMessage(id, result.summary);
  message.parts.push({
    id: `part_${id}_compaction` as PartId, messageId: message.id, sessionId, type: "compaction",
    boundaryMessageId: result.boundary.boundaryMessageId, reason: result.boundary.reason,
    summary: result.summary, sourceMessageIds: result.sourceMessageIds,
  });
  return message;
}

function compactionInput(messages: Message[], boundaryMessageId = messages.at(-1)!.id): ContextCompactionInput {
  return {
    sessionId, turnId, messages,
    boundary: { boundaryMessageId, reason: "manual", estimatedChars: 300_000, budgetChars: 160_000 },
  };
}

function batchHistory(count: number, chars: number): Message[] {
  return Array.from({ length: count }, (_unused, index) => textMessage(`batch_${index}`, `SOURCE_${index}_${"x".repeat(chars)}`));
}

function textOf(message: Message): string {
  return message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function requestText(request: ModelStreamInput): string {
  return request.messages.map(textOf).join("\n");
}

function conversationSource(request: ModelStreamInput): string {
  const prompt = requestText(request);
  const opening = "<conversation>\n";
  const start = prompt.indexOf(opening);
  const end = prompt.lastIndexOf("\n</conversation>");
  if (start < 0 || end < start) throw new Error("missing complete compaction evidence block");
  return prompt.slice(start + opening.length, end);
}

function isVerification(request: ModelStreamInput): boolean {
  return requestText(request).includes("<draft_summary>");
}
