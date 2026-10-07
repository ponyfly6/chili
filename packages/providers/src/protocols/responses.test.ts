import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, PersistedModelOutput, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import { ProviderBackpressureCoordinator } from "../runtime/backpressure.js";
import { credentialVersionFingerprint } from "../runtime/request-lifecycle.js";
import type { ModelStreamEvent } from "../types.js";
import { createApiKeyResponsesModel, type ApiKeyResponsesModelOptions } from "./api-key-responses.js";
import { preserveResponsesId, toResponsesInput, toResponsesTools } from "./responses.js";
import { transformModelMessages } from "./transform-messages.js";

const defaultEndpoint = "https://responses.test/v1/responses";
const defaultKey = "fixture-secret-key";

test("Responses emits raw reasoning once across deltas, done and finalized content array", async () => {
  const item = {
    id: "rs_content", type: "reasoning", status: "completed",
    content: [{ type: "reasoning_text", text: "Check the files." }],
    provider_extension: { version: 3, preserved: true },
  };
  const events = await collect(modelFor([
    added(0, { id: item.id, type: "reasoning" }),
    { type: "response.reasoning_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Check " },
    { type: "response.reasoning_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "the files." },
    { type: "response.reasoning_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "Check the files." },
    done(0, item),
    completed([item]),
  ]).stream({ messages: [] }));
  expect(reasoningText(events)).toBe("Check the files.");
  expect(events.filter((event) => event.type === "reasoning_end")).toHaveLength(1);
  expect(reasoningItems(events)).toHaveLength(1);
  expect(reasoningItems(events)[0]?.output).toMatchObject({ apiFamily: "openai-responses", outputIndex: 0, item });
});

test("Responses accepts GLM singleton reasoning and output-text content objects", async () => {
  const item = { id: "rs_single", type: "reasoning", content: { type: "reasoning_text", text: "Check the repository." } };
  const messageItem = { id: "msg_single", type: "message", role: "assistant", content: { type: "output_text", text: "Found it." } };
  const events = await collect(modelFor([
    added(0, { id: item.id, type: "reasoning" }),
    { type: "response.reasoning_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Check " },
    done(0, item),
    added(1, { id: messageItem.id, type: "message", role: "assistant" }),
    { type: "response.output_text.delta", item_id: messageItem.id, output_index: 1, content_index: 0, delta: "Found " },
    done(1, messageItem),
    completed(),
  ]).stream({ messages: [] }));
  expect(reasoningText(events)).toBe("Check the repository.");
  expect(text(events)).toBe("Found it.");
  expect(events.filter((event) => event.type === "reasoning_end")).toHaveLength(1);
  expect(events.filter((event) => event.type === "text_end")).toHaveLength(1);
  expect(reasoningItems(events)[0]?.output.item).toEqual(item);
});

test("Responses maps Qwen raw-reasoning events to final summary without duplicating text", async () => {
  const item = {
    id: "rs_summary", type: "reasoning",
    summary: [{ type: "summary_text", text: "Compare the options." }],
  };
  const events = await collect(modelFor([
    added(0, { id: item.id, type: "reasoning" }),
    { type: "response.reasoning_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Compare " },
    { type: "response.reasoning_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "Compare the options." },
    done(0, item),
    completed(),
  ], { reasoningTextField: "summary" }).stream({ messages: [] }));
  expect(reasoningText(events)).toBe("Compare the options.");
  expect(events.filter((event) => event.type === "reasoning_end")).toHaveLength(1);
  expect(reasoningItems(events)[0]?.output.item).toEqual(item);
});

test("Responses tracks raw content and reasoning summary as independent sections", async () => {
  const item = {
    id: "rs_both", type: "reasoning",
    content: [{ type: "reasoning_text", text: "Detailed calculation." }],
    summary: [{ type: "summary_text", text: "Compared approaches." }],
  };
  const events = await collect(modelFor([
    added(0, { id: item.id, type: "reasoning" }),
    { type: "response.reasoning_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Detailed " },
    { type: "response.reasoning_summary_text.delta", item_id: item.id, output_index: 0, summary_index: 0, delta: "Compared " },
    done(0, item),
    completed(),
  ]).stream({ messages: [] }));
  const sections = new Map<number | undefined, string>();
  for (const event of events) {
    if (event.type === "reasoning_delta") sections.set(event.index, (sections.get(event.index) ?? "") + event.text);
  }
  expect([...sections.values()]).toEqual(["Detailed calculation.", "Compared approaches."]);
  expect(events.filter((event) => event.type === "reasoning_end")).toHaveLength(2);
  expect(reasoningItems(events)[0]?.output.item).toEqual(item);
});

test("Responses persists a reasoning item supplied only in final response output", async () => {
  const item = {
    id: "rs_terminal", type: "reasoning", status: "completed",
    content: [{ type: "reasoning_text", text: "Only final content." }], vendor_trace: { sequence: 4 },
  };
  const events = await collect(modelFor([completed([item])]).stream({ messages: [] }));
  expect(reasoningText(events)).toBe("Only final content.");
  expect(reasoningItems(events)).toHaveLength(1);
  expect(reasoningItems(events)[0]?.output).toMatchObject({ outputIndex: 0, item });
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
});

test("Responses scopes full plain-reasoning replay to its connection without retaining credentials", async () => {
  const item = {
    id: "rs_replay", type: "reasoning", status: "completed",
    content: [{ type: "reasoning_text", text: "A complete thought." }],
    provider_extension: { checksum: "checked" },
  };
  const originalEvents = await collect(modelFor([done(0, item), completed()]).stream({ messages: [] }));
  const output = reasoningItems(originalEvents)[0]?.output;
  expect(output).toBeDefined();
  expect(output?.source).toEqual({ provider: "fixture-provider", connection: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
  expect(JSON.stringify(output)).not.toContain(defaultKey);
  expect(JSON.stringify(output)).not.toContain(defaultEndpoint);
  const messages = [message("assistant", [
    { type: "reasoning", text: "A complete thought.", modelOutput: output },
    { type: "text", text: "Visible answer.", phase: "final_answer" },
  ])];
  const originalHistory = JSON.stringify(messages);
  for (const change of [
    {},
    { apiKey: "replacement-key" },
    { provider: "other-provider" },
    { endpoint: "https://other.test/v1/responses" },
  ]) {
    let request: Record<string, unknown> = {};
    await collect(modelFor([completed()], {
      ...change,
      onRequestBody: (body) => { request = body; },
    }).stream({ messages }));
    const expected = [{ role: "assistant", content: [{ type: "output_text", text: "Visible answer." }] }];
    expect(request.input).toEqual(Object.keys(change).length === 0 ? [item, ...expected] : expected);
  }
  expect(JSON.stringify(messages)).toBe(originalHistory);
});

test("Responses optionally scopes continuation to the resolved model while preserving default fingerprints", async () => {
  const item = { id: "rs_model", type: "reasoning", encrypted_content: "model-specific-state", summary: [] };
  for (const scopeReasoningToModel of [false, true]) {
    const model = modelFor([done(0, item), completed()], { model: "constructor-default", scopeReasoningToModel });
    const output = reasoningItems(await collect(model.stream({ messages: [], model: "actual-model" })))[0]?.output;
    expect(output).toBeDefined();
    const connection = ["fixture-provider", defaultEndpoint, ["api-authorization", `Bearer ${defaultKey}`]];
    if (scopeReasoningToModel) connection.push(["model", "actual-model"]);
    expect(output?.source?.connection).toBe(credentialVersionFingerprint(JSON.stringify(connection)));
    const messages = [message("assistant", [
      { type: "reasoning", text: "Visible reasoning from the original model.", modelOutput: output },
      { type: "text", text: "Keep the answer." },
    ])];
    for (const requestModel of ["actual-model", "different-model"]) {
      let request: Record<string, unknown> = {};
      await collect(modelFor([completed()], {
        model: "another-constructor-default",
        scopeReasoningToModel,
        onRequestBody: (body) => { request = body; },
      }).stream({ messages, model: requestModel }));
      const answer = { role: "assistant", content: [{ type: "output_text", text: "Keep the answer." }] };
      expect(request.model).toBe(requestModel);
      expect(request.input).toEqual(scopeReasoningToModel && requestModel !== "actual-model" ? [answer] : [item, answer]);
    }
  }
});

test("Responses removes rejected continuation text before vendor legacy reasoning conversion", async () => {
  const item = { id: "rs_scoped_text", type: "reasoning", content: [{ type: "reasoning_text", text: "Connection-private continuation." }] };
  const events = await collect(modelFor([done(0, item), completed()]).stream({ messages: [] }));
  const scopedOutput = reasoningItems(events)[0]?.output;
  expect(scopedOutput).toBeDefined();
  const callId = "call_survives" as ToolCallId;
  for (const output of [scopedOutput, { ...scopedOutput, source: undefined }] as PersistedModelOutput[]) {
    const messages = [message("assistant", [
      { type: "reasoning", text: "Connection-private continuation.", modelOutput: output },
      { type: "reasoning", text: "Ordinary visible reasoning." },
      { type: "text", text: "Visible answer." },
      { type: "tool_call", callId, toolName: "lookup", input: {}, status: "completed" },
    ])];
    const before = JSON.stringify(messages);
    let receivedParts: Message["parts"] = [];
    let legacyReasoning: string[] = [];
    const model = createApiKeyResponsesModel({
      provider: "fixture-provider", model: "fixture-model", apiKey: "different-connection-key", endpoint: defaultEndpoint,
      backpressureCoordinator: new ProviderBackpressureCoordinator(),
      resolveRequestOptions: () => ({ model: "fixture-model" }),
      buildRequestBody: (input) => {
        receivedParts = input.messages[0]?.parts ?? [];
        // Vendor adapters may convert unstructured historical reasoning to wire items.
        legacyReasoning = receivedParts.filter((part) => part.type === "reasoning" && !part.modelOutput)
          .map((part) => part.type === "reasoning" ? part.text : "");
        return { model: "fixture-model", input: [], legacyReasoning };
      },
      fetch: (async () => new Response(`data: ${JSON.stringify(completed())}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch,
    });
    await collect(model.stream({ messages }));
    expect(receivedParts).toEqual(messages[0]!.parts.slice(1));
    expect(legacyReasoning).toEqual(["Ordinary visible reasoning."]);
    expect(JSON.stringify(receivedParts)).not.toContain("Connection-private continuation.");
    expect(JSON.stringify(messages)).toBe(before);
  }
});

test("Responses does not replay unscoped plain reasoning for API-key vendors", async () => {
  let request: Record<string, unknown> = {};
  const modelOutput: PersistedModelOutput = {
    apiFamily: "openai-responses",
    item: { type: "reasoning", content: [{ type: "reasoning_text", text: "Old unscoped state." }] },
  };
  await collect(modelFor([completed()], { onRequestBody: (body) => { request = body; } }).stream({
    messages: [message("assistant", [
      { type: "reasoning", text: "Old unscoped state.", modelOutput },
      { type: "text", text: "Keep this answer." },
    ])],
  }));
  expect(request.input).toEqual([{ role: "assistant", content: [{ type: "output_text", text: "Keep this answer." }] }]);
});

test("Responses streams tool arguments and serializes matching tool result IDs", async () => {
  let request: Record<string, unknown> = {};
  const callId = "call_internal" as ToolCallId;
  const events = await collect(modelFor([
    added(0, { type: "function_call", id: "fc_lookup", call_id: "call_lookup", name: "lookup", arguments: "" }),
    { type: "response.function_call_arguments.delta", item_id: "fc_lookup", output_index: 0, delta: "{\"path\":" },
    { type: "response.function_call_arguments.done", item_id: "fc_lookup", output_index: 0, arguments: "{\"path\":\"README.md\"}" },
    done(0, { type: "function_call", id: "fc_lookup", call_id: "call_lookup", name: "lookup", arguments: "{\"path\":\"README.md\"}" }),
    completed([{ type: "function_call", id: "fc_lookup", call_id: "call_lookup", name: "lookup", arguments: "{\"path\":\"README.md\"}" }]),
  ], { onRequestBody: (body) => { request = body; } }).stream({
    messages: [
      message("assistant", [{ type: "tool_call", callId, providerCallId: "call_previous", toolName: "lookup", input: {}, status: "completed" }]),
      message("user", [{ type: "tool_result", callId, providerCallId: "call_previous", output: "previous result" }]),
    ],
    tools: [{ name: "lookup", description: "Read a file.", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
  }));
  expect(events.filter((event) => event.type === "tool_call_start")).toHaveLength(1);
  expect(events.filter((event) => event.type === "tool_call_delta").map((event) => event.delta).join(""))
    .toBe("{\"path\":\"README.md\"}");
  expect(events.filter((event) => event.type === "tool_call_end")).toEqual([
    { type: "tool_call_end", toolCallId: "call_lookup", name: "lookup", input: { path: "README.md" }, index: 0 },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool_use" });
  expect(request.input).toEqual([
    { type: "function_call", call_id: "call_previous", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_previous", output: "previous result" },
  ]);
  expect(request.tools).toEqual([
    { type: "function", name: "lookup", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } }, strict: null },
  ]);
});

test("Responses preserves long provider tool IDs through streaming and history replay", async () => {
  const providerCallId = `call/vendor:${"opaque.segment/".repeat(7)}:tail`;
  const item = { type: "function_call", id: "fc_long_id", call_id: providerCallId, name: "lookup", arguments: "{\"path\":\"source.ts\"}" };
  const events = await collect(modelFor([
    added(0, { ...item, arguments: "" }),
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
    done(0, item),
    completed([item]),
  ]).stream({ messages: [] }));
  const toolEvents = events.filter((event) => event.type === "tool_call_start" || event.type === "tool_call_delta" || event.type === "tool_call_end");
  expect(providerCallId.length).toBeGreaterThan(64);
  expect(toolEvents.map((event) => event.toolCallId)).toEqual([providerCallId, providerCallId, providerCallId]);
  const callId = "chili_internal_call" as ToolCallId;
  let request: Record<string, unknown> = {};
  await collect(modelFor([completed()], { onRequestBody: (body) => { request = body; } }).stream({
    messages: [
      message("assistant", [{ type: "tool_call", callId, providerCallId, toolName: "lookup", input: { path: "source.ts" }, status: "completed" }]),
      message("user", [{ type: "tool_result", callId, output: "file contents" }]),
    ],
  }));
  expect(request.input).toEqual([
    { type: "function_call", call_id: providerCallId, name: "lookup", arguments: item.arguments },
    { type: "function_call_output", call_id: providerCallId, output: "file contents" },
  ]);
});

test("Responses final output alone completes two distinct tool calls once each", async () => {
  const first = { type: "function_call", id: "fc_first", call_id: "call_first", name: "read", arguments: "{\"path\":\"first.ts\"}" };
  const second = { type: "function_call", id: "fc_second", call_id: "call_second", name: "write", arguments: "{\"path\":\"second.ts\"}" };
  const events = await collect(modelFor([completed([first, second])]).stream({ messages: [] }));
  expect(events.filter((event) => event.type === "tool_call_start" || event.type === "tool_call_end")).toEqual([
    { type: "tool_call_start", toolCallId: "call_first", name: "read", index: 0 },
    { type: "tool_call_end", toolCallId: "call_first", name: "read", input: { path: "first.ts" }, index: 0 },
    { type: "tool_call_start", toolCallId: "call_second", name: "write", index: 1 },
    { type: "tool_call_end", toolCallId: "call_second", name: "write", input: { path: "second.ts" }, index: 1 },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool_use" });
});

test("Responses incomplete reasoning retains partial text without a completed section", async () => {
  const item = { id: "rs_partial", type: "reasoning", status: "incomplete", content: [{ type: "reasoning_text", text: "Partial thought." }] };
  const events = await collect(modelFor([
    added(0, { id: item.id, type: "reasoning" }),
    { type: "response.reasoning_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Partial " },
    done(0, item),
    { type: "response.incomplete", response: { id: "resp_test", status: "incomplete" } },
  ]).stream({ messages: [] }));
  expect(reasoningText(events)).toBe("Partial thought.");
  expect(events.filter((event) => event.type === "reasoning_end")).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "length" });
});

test("Responses failed terminal rejects after preserving streamed partial reasoning", async () => {
  const events: ModelStreamEvent[] = [];
  const model = modelFor([
    { type: "response.reasoning_text.delta", output_index: 0, content_index: 0, delta: "Partial thought." },
    { type: "response.failed", response: { status: "failed", error: { type: "server_error", message: "provider failed" } } },
  ]);
  await expect((async () => { for await (const event of model.stream({ messages: [] })) events.push(event); })())
    .rejects.toMatchObject({ name: "ProviderError", provider: "fixture-provider" });
  expect(reasoningText(events)).toBe("Partial thought.");
  expect(events.some((event) => event.type === "finish" || event.type === "reasoning_end")).toBe(false);
});

test("Responses EOF and DONE markers do not replace the protocol terminal event", async () => {
  for (const suffix of ["", "data: [DONE]\n\n"]) {
    const events: ModelStreamEvent[] = [];
    const model = modelFor([
      { type: "response.reasoning_text.delta", output_index: 0, content_index: 0, delta: "Partial thought." },
    ], { suffix });
    await expect((async () => { for await (const event of model.stream({ messages: [] })) events.push(event); })())
      .rejects.toMatchObject({ code: "incomplete_stream" });
    expect(reasoningText(events)).toBe("Partial thought.");
    expect(events.some((event) => event.type === "finish" || event.type === "reasoning_end")).toBe(false);
  }
});

test("Responses does not dispatch a request already cancelled by its caller", async () => {
  let requests = 0;
  const model = modelFor([completed()], { onRequestBody: () => { requests++; } });
  await expect(collect(model.stream({ messages: [], signal: AbortSignal.abort() })))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toBe(0);
});

type FixtureOptions = Partial<Pick<ApiKeyResponsesModelOptions, "provider" | "model" | "apiKey" | "endpoint" | "reasoningTextField" | "scopeReasoningToModel">> & {
  onRequestBody?: (body: Record<string, unknown>) => void;
  suffix?: string;
};

function modelFor(events: unknown[], options: FixtureOptions = {}) {
  const model = options.model ?? "fixture-model";
  return createApiKeyResponsesModel({
    provider: options.provider ?? "fixture-provider",
    model,
    apiKey: options.apiKey ?? defaultKey,
    endpoint: options.endpoint ?? defaultEndpoint,
    backpressureCoordinator: new ProviderBackpressureCoordinator(),
    ...(options.reasoningTextField === undefined ? {} : { reasoningTextField: options.reasoningTextField }),
    ...(options.scopeReasoningToModel === undefined ? {} : { scopeReasoningToModel: options.scopeReasoningToModel }),
    resolveRequestOptions: (input) => ({ model: input.model ?? model }),
    buildRequestBody: (input, requestOptions) => ({
      model: requestOptions.model,
      store: false,
      stream: true,
      input: toResponsesInput(transformModelMessages(input.messages, { normalizeToolCallId: preserveResponsesId }), true, "omit", preserveResponsesId),
      tools: toResponsesTools(input.tools ?? []),
    }),
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      options.onRequestBody?.(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + (options.suffix ?? ""), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch,
  });
}

function added(index: number, item: unknown): unknown {
  return { type: "response.output_item.added", output_index: index, item };
}

function done(index: number, item: unknown): unknown {
  return { type: "response.output_item.done", output_index: index, item };
}

function completed(output?: unknown[]): unknown {
  return { type: "response.completed", response: { id: "resp_test", model: "fixture-model", status: "completed", ...(output === undefined ? {} : { output }) } };
}

function reasoningItems(events: ModelStreamEvent[]) {
  return events.filter((event) => event.type === "reasoning_item");
}

function reasoningText(events: ModelStreamEvent[]): string {
  return events.filter((event) => event.type === "reasoning_delta").map((event) => event.text).join("");
}

function text(events: ModelStreamEvent[]): string {
  return events.filter((event) => event.type === "text_delta").map((event) => event.text).join("");
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function message(role: Message["role"], parts: Array<Record<string, unknown>>): Message {
  const id = `msg_${role}` as MessageId;
  const sessionId = "session_responses" as SessionId;
  return {
    id, sessionId, role, createdAt: 1 as TimestampMs,
    parts: parts.map((part, index) => ({ id: `part_${index}` as PartId, messageId: id, sessionId, ...part })) as Message["parts"],
  };
}
