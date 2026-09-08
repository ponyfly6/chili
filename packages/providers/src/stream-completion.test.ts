import { expect, test } from "bun:test";
import { AnthropicCompatibleModel } from "./anthropic-compatible.js";
import { CodexApiResponsesModel } from "./openai-codex.js";
import { OpenAICompletionsModel } from "./openai-completions.js";
import { ProviderBackpressureCoordinator } from "./provider-backpressure.js";
import { ProviderError } from "./provider-error.js";
import type { ChiliModel, ModelStreamEvent } from "./types.js";

interface StreamProtocol {
  name: string;
  createModel: (fetchImpl: typeof fetch) => ChiliModel;
  metadataOnly: string;
  text: string[];
  tool: string[];
  toolEnd: string[];
  terminal: string[];
  expectedReason: string;
  malformedTerminal: string;
}

const protocols: StreamProtocol[] = [
  {
    name: "Chat Completions",
    createModel: (fetchImpl) => new OpenAICompletionsModel({
      provider: "openai",
      model: "test-model",
      apiKey: "test-key",
      baseUrl: "https://model.test",
      fetch: fetchImpl,
    }),
    metadataOnly: data({ id: "response_test", choices: [], usage: { prompt_tokens: 3 } }),
    text: [data({ id: "response_test", choices: [{ index: 0, delta: { content: "你好🌶️" } }] })],
    tool: [data({
      id: "response_test",
      choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: "call_test", function: { name: "lookup", arguments: "{}" } }],
      } }],
    })],
    toolEnd: [],
    terminal: [
      data({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      data({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 } }),
    ],
    expectedReason: "stop",
    malformedTerminal: "data: {\"choices\":[{\"finish_reason\":\"stop\"}\n\n",
  },
  {
    name: "Anthropic Messages",
    createModel: (fetchImpl) => new AnthropicCompatibleModel({
      provider: "anthropic-compatible",
      model: "test-model",
      apiKey: "test-key",
      baseUrl: "https://model.test",
      fetch: fetchImpl,
      backpressureCoordinator: new ProviderBackpressureCoordinator(),
    }),
    metadataOnly: data({ type: "message_start", message: { id: "response_test", usage: { input_tokens: 3 } } }),
    text: [
      data({ type: "message_start", message: { id: "response_test", usage: { input_tokens: 3 } } }),
      data({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好🌶️" } }),
      data({ type: "content_block_stop", index: 0 }),
    ],
    tool: [
      data({ type: "message_start", message: { id: "response_test" } }),
      data({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_test", name: "lookup", input: {} } }),
      data({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
    ],
    toolEnd: [data({ type: "content_block_stop", index: 0 })],
    terminal: [
      data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
      data({ type: "message_stop" }),
    ],
    expectedReason: "end_turn",
    malformedTerminal: "event: message_stop\ndata: {\"type\":\"message_stop\"\n\n",
  },
  {
    name: "Responses",
    createModel: (fetchImpl) => new CodexApiResponsesModel({
      model: "gpt-5.6-sol",
      apiKey: "test-key",
      baseUrl: "https://model.test/v1",
      fetch: fetchImpl,
      env: {},
    }),
    metadataOnly: data({ type: "response.created", response: { id: "response_test" } }),
    text: [
      data({ type: "response.created", response: { id: "response_test" } }),
      data({ type: "response.output_item.added", output_index: 0, item: { type: "message", phase: "final_answer" } }),
      data({ type: "response.output_text.delta", output_index: 0, delta: "你好🌶️" }),
    ],
    tool: [
      data({ type: "response.created", response: { id: "response_test" } }),
      data({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_test", call_id: "call_test", name: "lookup", arguments: "" } }),
      data({ type: "response.function_call_arguments.delta", item_id: "fc_test", delta: "{}" }),
    ],
    toolEnd: [data({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_test", call_id: "call_test", name: "lookup", arguments: "{}" } })],
    terminal: [data({ type: "response.completed", response: {
      id: "response_test", status: "completed", usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
    } })],
    expectedReason: "stop",
    malformedTerminal: "data: {\"type\":\"response.completed\"\n\n",
  },
];

for (const protocol of protocols) {
  test(`${protocol.name}: rejects text EOF and DONE without protocol completion`, async () => {
    for (const ending of ["", "data: [DONE]\n\n"]) {
      const result = await capture(protocol.createModel(chunkedFetch([...protocol.text, ending])));
      expectIncomplete(result);
      expect(result.events.find((event) => event.type === "text_delta")).toMatchObject({ text: "你好🌶️" });
    }
  });

  test(`${protocol.name}: valid tool JSON does not turn truncated generation into success`, async () => {
    for (const closingFrames of [[], protocol.toolEnd]) {
      const result = await capture(protocol.createModel(chunkedFetch([...protocol.tool, ...closingFrames])));
      expectIncomplete(result);
      expect(result.events.find((event) => event.type === "tool_call_delta")).toMatchObject({ partialInput: {} });
      if (closingFrames.length === 0) {
        expect(result.events.some((event) => event.type === "tool_call_end")).toBe(false);
      }
    }
  });

  test(`${protocol.name}: parses byte-fragmented CRLF completion with usage and no DONE`, async () => {
    const result = await capture(protocol.createModel(chunkedFetch([...protocol.text, ...protocol.terminal], { byteChunks: true })));
    expect(result.error).toBeUndefined();
    expect(result.events.filter((event) => event.type === "finish")).toEqual([
      expect.objectContaining({
        reason: protocol.expectedReason,
        responseId: "response_test",
        usage: expect.objectContaining({ inputTokens: 3, outputTokens: 7, totalTokens: 10 }),
      }),
    ]);
    expect(result.events.find((event) => event.type === "text_delta")).toMatchObject({ text: "你好🌶️" });
  });

  test(`${protocol.name}: rejects a malformed frame even when a valid terminal follows`, async () => {
    const result = await capture(protocol.createModel(chunkedFetch([...protocol.text, protocol.malformedTerminal, ...protocol.terminal])));
    expect(result.error).toBeInstanceOf(ProviderError);
    expect(result.error).toMatchObject({ code: "invalid_stream", type: "stream_protocol_error" });
    expectNoFinish(result);
  });

  test(`${protocol.name}: explicit stream errors never become finish events`, async () => {
    const result = await capture(protocol.createModel(chunkedFetch([
      ...protocol.tool,
      "event: error\n" + data({ type: "error", error: { type: "server_error", message: "Provider failed" } }),
      ...protocol.terminal,
    ])));
    expect(result.error).toBeInstanceOf(ProviderError);
    expectNoFinish(result);
  });

  test(`${protocol.name}: cancellation preserves AbortError and never finishes tools`, async () => {
    const controller = new AbortController();
    const model = protocol.createModel(chunkedFetch(protocol.tool, { hanging: true }));
    const result = await capture(model, controller, (event) => {
      if (event.type === "tool_call_delta") controller.abort();
    });
    expect(result.error).toMatchObject({ name: "AbortError" });
    expectNoFinish(result);
    expect(result.events.some((event) => event.type === "tool_call_end")).toBe(false);
  });

  test(`${protocol.name}: cancellation between events in the same chunk prevents completion`, async () => {
    const controller = new AbortController();
    const frames = [...protocol.tool, ...protocol.toolEnd, ...protocol.terminal];
    const result = await capture(protocol.createModel(chunkedFetch([frames.join("")])), controller, (event) => {
      if (event.type === "tool_call_delta") controller.abort();
    });
    expect(result.error).toMatchObject({ name: "AbortError" });
    expectNoFinish(result);
    expect(result.events.some((event) => event.type === "tool_call_end")).toBe(false);
  });

  test(`${protocol.name}: empty and metadata-only streams do not finish`, async () => {
    for (const frames of [[], [": keep-alive\n\n"], [protocol.metadataOnly]]) {
      expectIncomplete(await capture(protocol.createModel(chunkedFetch(frames))));
    }
  });
}

test("Chat Completions: DONE retains usage only after all observed choices finish", async () => {
  const protocol = protocols[0]!;
  const complete = await capture(protocol.createModel(chunkedFetch([...protocol.text, ...protocol.terminal, "data: [DONE]\n\n"])));
  expect(complete.error).toBeUndefined();
  expect(complete.events.at(-1)).toMatchObject({ type: "finish", usage: { totalTokens: 10 } });

  const incomplete = await capture(protocol.createModel(chunkedFetch([
    data({ choices: [{ index: 1, delta: { content: "unfinished" } }] }),
    ...protocol.text,
    ...protocol.terminal,
    "data: [DONE]\n\n",
  ])));
  expectIncomplete(incomplete);
});

test("Anthropic Messages: message_stop cannot complete an open tool block", async () => {
  const protocol = protocols[1]!;
  expectIncomplete(await capture(protocol.createModel(chunkedFetch([...protocol.tool, ...protocol.terminal]))));
});

test("Responses: incomplete is a length result; done requires a valid terminal status", async () => {
  const protocol = protocols[2]!;
  for (const [type, status, reason] of [
    ["response.incomplete", undefined, "length"],
    ["response.done", "completed", "stop"],
    ["response.done", "incomplete", "length"],
  ]) {
    const result = await capture(protocol.createModel(chunkedFetch([
      ...protocol.text,
      data({ type, response: { id: "response_test", status } }),
    ])));
    expect(result.error).toBeUndefined();
    expect(result.events.at(-1)).toMatchObject({ type: "finish", reason });
  }

  for (const [type, status] of [
    ["response.done", undefined],
    ["response.done", "in_progress"],
    ["response.completed", "incomplete"],
    ["response.incomplete", "completed"],
    ["response.done", "failed"],
    ["response.done", "cancelled"],
    ["response.completed", "failed"],
  ]) {
    const result = await capture(protocol.createModel(chunkedFetch([
      ...protocol.tool,
      data({ type, response: { id: "response_test", status } }),
    ])));
    expect(result.error).toBeInstanceOf(ProviderError);
    expectNoFinish(result);
    expect(result.events.some((event) => event.type === "tool_call_end")).toBe(false);
  }
});

test("Responses: cancellation after terminal usage metadata prevents pending tools and finish", async () => {
  const protocol = protocols[2]!;
  const controller = new AbortController();
  const result = await capture(protocol.createModel(chunkedFetch([...protocol.tool, ...protocol.terminal])), controller, (event) => {
    if (event.type === "metadata" && event.usage?.totalTokens === 10) controller.abort();
  });
  expect(result.error).toMatchObject({ name: "AbortError" });
  expectNoFinish(result);
  expect(result.events.some((event) => event.type === "tool_call_end")).toBe(false);
});

test("Chat Completions and Responses: cancellation after the final tool event prevents finish", async () => {
  for (const protocol of [protocols[0]!, protocols[2]!]) {
    const controller = new AbortController();
    const result = await capture(protocol.createModel(chunkedFetch([...protocol.tool, ...protocol.terminal])), controller, (event) => {
      if (event.type === "tool_call_end") controller.abort();
    });
    expect(result.error).toMatchObject({ name: "AbortError" });
    expectNoFinish(result);
  }
});

interface CapturedStream {
  events: ModelStreamEvent[];
  error?: unknown;
}

async function capture(
  model: ChiliModel,
  controller?: AbortController,
  onEvent?: (event: ModelStreamEvent) => void,
): Promise<CapturedStream> {
  const result: CapturedStream = { events: [] };
  try {
    for await (const event of model.stream({ messages: [], ...(controller ? { signal: controller.signal } : {}) })) {
      result.events.push(event);
      if (event.type === "error") result.error = event.error;
      onEvent?.(event);
    }
  } catch (error) {
    result.error = error;
  }
  return result;
}

function expectNoFinish(result: CapturedStream): void {
  expect(result.events.some((event) => event.type === "finish")).toBe(false);
}

function expectIncomplete(result: CapturedStream): void {
  expect(result.error).toBeInstanceOf(ProviderError);
  expect(result.error).toMatchObject({ code: "incomplete_stream", type: "stream_protocol_error", retryable: true, opensCircuit: false });
  expectNoFinish(result);
}

function data(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunkedFetch(frames: string[], options: { byteChunks?: boolean; hanging?: boolean } = {}): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const chunks = options.byteChunks
      ? Array.from(encoder.encode(frames.join("").replace(/\n/g, "\r\n")), (byte) => Uint8Array.of(byte))
      : frames.map((frame) => encoder.encode(frame));
    let index = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]!);
        else if (!options.hanging) controller.close();
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-request-id": "request_test" },
    });
  }) as unknown as typeof fetch;
}
