import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import { ProviderBackpressureCoordinator } from "../../runtime/backpressure.js";
import type { ModelStreamEvent } from "../../types.js";
import {
  buildOpenAIResponsesRequestBody,
  createOpenAIModel,
  createOpenAIProvider,
  OpenAIResponsesModel,
  resolveOpenAIResponsesUrl,
  resolveOpenAIStreamRequestOptions,
} from "./provider.js";

const modelId = "gpt-6.1-sol";

test("official OpenAI uses its own environment and defaults independently of Codex modes", () => {
  expect(() => createOpenAIModel({
    env: { CODEX_API_KEY: "other-key", OPENAI_CODEX_ACCESS_TOKEN: "oauth-token" },
  })).toThrow("OPENAI_API_KEY");
  const model = createOpenAIModel({
    env: {
      OPENAI_API_KEY: "official-key",
      OPENAI_MODEL: "gpt-5.6-luna",
      CODEX_API_KEY: "other-key",
      CODEX_API_MODEL: "gpt-6-astra",
      CODEX_API_BASE_URL: "https://other.test/v1",
      OPENAI_CODEX_MODEL: "gpt-6-sol",
    },
  });
  expect(model.provider).toBe("openai");
  expect(model.model).toBe("gpt-5.6-luna");
  expect(createOpenAIModel({ env: {}, apiKey: "test-key" }).model).toBe(modelId);
  expect(createOpenAIProvider({ env: {}, model: "gpt-5.6" }).models().find((model) => model.default)?.model)
    .toBe("gpt-5.6-sol");
});

test("official OpenAI resolves endpoint variants and per-request selection", () => {
  expect(resolveOpenAIResponsesUrl()).toBe("https://api.openai.com/v1/responses");
  expect(resolveOpenAIResponsesUrl("https://proxy.test/v1/")).toBe("https://proxy.test/v1/responses");
  expect(resolveOpenAIResponsesUrl("https://proxy.test/v1/responses")).toBe("https://proxy.test/v1/responses");
  expect(resolveOpenAIStreamRequestOptions({
    messages: [],
    model: "openai/gpt-5.6-luna:high",
    reasoning: "low",
    metadata: { sessionId: "official-session" },
  }, { model: modelId, maxTokens: 432 })).toMatchObject({
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    maxTokens: 432,
    sessionId: "official-session",
  });
});

test("official OpenAI sends bearer auth and output limits without ChatGPT headers", async () => {
  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const events = await collect(new OpenAIResponsesModel({
    env: {},
    apiKey: "test-key",
    maxTokens: 432,
    backpressureCoordinator: new ProviderBackpressureCoordinator(),
    fetch: (async (input, init) => {
      url = String(input);
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return eventResponse([completed()]);
    }) as typeof fetch,
  }).stream({ messages: [], metadata: { sessionId: "official-session" } }));
  expect(url).toBe("https://api.openai.com/v1/responses");
  expect(headers.get("authorization")).toBe("Bearer test-key");
  for (const name of ["chatgpt-account-id", "originator", "openai-beta", "session_id"]) {
    expect(headers.get(name)).toBeNull();
  }
  expect(body).toMatchObject({ model: modelId, store: false, stream: true, max_output_tokens: 432 });
  expect(body.include).toContain("reasoning.encrypted_content");
  expect(events).toContainEqual(expect.objectContaining({ type: "finish", reason: "stop" }));
});

test("official OpenAI explicit options override only its own environment", async () => {
  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const model = createOpenAIModel({
    env: {
      OPENAI_API_KEY: "env-key",
      OPENAI_BASE_URL: "https://env.test/v1",
      OPENAI_MODEL: "gpt-6-astra",
    },
    apiKey: "explicit-key",
    baseUrl: "https://explicit.test/v1",
    model: "gpt-5.6-luna",
    fetch: (async (input, init) => {
      url = String(input);
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return eventResponse([completed()]);
    }) as typeof fetch,
  });
  await collect(model.stream({ messages: [] }));
  expect(url).toBe("https://explicit.test/v1/responses");
  expect(headers.get("authorization")).toBe("Bearer explicit-key");
  expect(body.model).toBe("gpt-5.6-luna");
});

test("official OpenAI tolerates missing assistant phase and preserves supplied phase", async () => {
  const body = buildOpenAIResponsesRequestBody({ messages: [
    message("assistant", [{ type: "text", text: "Earlier response." }]),
    message("assistant", [{ type: "text", text: "Checking.", phase: "commentary" }]),
    message("assistant", [{ type: "text", text: "Done.", phase: "final_answer" }]),
  ] }, { model: modelId });
  expect(body.input).toEqual([
    { role: "assistant", content: [{ type: "output_text", text: "Earlier response." }] },
    { role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking." }] },
    { role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] },
  ]);
  const events = await collect(streamModel([
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_plain", phase: null } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Plain." },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_plain" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_final", phase: "final_answer" } },
    { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "Final." },
    { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_final" } },
    completed(),
  ]).stream({ messages: [] }));
  const deltas = events.filter((event) => event.type === "text_delta");
  expect(deltas).toEqual([
    { type: "text_delta", index: 0, text: "Plain." },
    { type: "text_delta", index: 1, text: "Final.", phase: "final_answer" },
  ]);
});

test("official OpenAI replays final encrypted reasoning before its tool call and matching result", async () => {
  const completedItem = {
    id: "reasoning_test", type: "reasoning", status: "completed",
    encrypted_content: "complete-ciphertext", summary: [], provider_extension: { retained: true },
  };
  const events = await collect(streamModel([
    { type: "response.output_item.added", output_index: 0, item: {
      id: "reasoning_test", type: "reasoning", encrypted_content: "partial-ciphertext", summary: [],
    } },
    { type: "response.output_item.done", output_index: 0, item: completedItem },
    { type: "response.output_item.added", output_index: 1, item: {
      id: "fc_test", type: "function_call", call_id: "call_provider", name: "lookup", arguments: "",
    } },
    { type: "response.function_call_arguments.delta", item_id: "fc_test", delta: "{\"query\":\"test\"}" },
    { type: "response.output_item.done", output_index: 1, item: {
      id: "fc_test", type: "function_call", call_id: "call_provider", name: "lookup", arguments: "{\"query\":\"test\"}",
    } },
    completed(),
  ]).stream({ messages: [] }));
  const reasoning = events.filter((event) => event.type === "reasoning_item");
  expect(reasoning).toEqual([{
    type: "reasoning_item", output: { apiFamily: "openai-responses", source: { provider: "openai", connection: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }, outputIndex: 0, item: completedItem },
  }]);
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_end", toolCallId: "call_provider", name: "lookup" }));
  const callId = "call_internal" as ToolCallId;
  const body = buildOpenAIResponsesRequestBody({ messages: [
    message("assistant", [
      { type: "reasoning", text: "", modelOutput: reasoning[0]?.output },
      { type: "tool_call", callId, providerCallId: "call_provider", toolName: "lookup", input: { query: "test" }, status: "completed" },
    ]),
    message("user", [{ type: "tool_result", callId, output: "found" }]),
  ] }, { model: modelId });
  expect(body.input).toEqual([
    completedItem,
    { type: "function_call", call_id: "call_provider", name: "lookup", arguments: "{\"query\":\"test\"}" },
    { type: "function_call_output", call_id: "call_provider", output: "found" },
  ]);
});

test("official OpenAI does not dispatch a pre-cancelled request", async () => {
  let calls = 0;
  const model = new OpenAIResponsesModel({
    env: {}, apiKey: "test-key",
    fetch: (async () => { calls++; return eventResponse([completed()]); }) as unknown as typeof fetch,
  });
  await expect(collect(model.stream({ messages: [], signal: AbortSignal.abort() })))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(0);
});

test("official OpenAI rejects a truncated response after partial text", async () => {
  const events: ModelStreamEvent[] = [];
  const model = streamModel([
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_truncated" } },
    { type: "response.output_text.delta", output_index: 0, delta: "partial" },
  ]);
  await expect((async () => {
    for await (const event of model.stream({ messages: [] })) events.push(event);
  })()).rejects.toMatchObject({ code: "incomplete_stream" });
  expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", text: "partial" }));
  expect(events.some((event) => event.type === "finish")).toBe(false);
});

function streamModel(events: unknown[]): OpenAIResponsesModel {
  return new OpenAIResponsesModel({
    env: {}, apiKey: "test-key", model: modelId,
    backpressureCoordinator: new ProviderBackpressureCoordinator(),
    fetch: (async () => eventResponse(events)) as unknown as typeof fetch,
  });
}

function completed(): unknown {
  return { type: "response.completed", response: { id: "resp_test", model: modelId, status: "completed" } };
}

function eventResponse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function message(role: Message["role"], parts: Array<Record<string, unknown>>): Message {
  const id = `msg_${role}` as MessageId;
  const sessionId = "session_openai" as SessionId;
  return {
    id, sessionId, role, createdAt: 1 as TimestampMs,
    parts: parts.map((part, index) => ({ id: `part_${index}` as PartId, messageId: id, sessionId, ...part })) as Message["parts"],
  };
}
