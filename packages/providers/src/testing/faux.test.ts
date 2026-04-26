import { expect, test } from "bun:test";
import type { ModelStreamEvent, ModelStreamInput } from "../types.js";
import {
  FAUX_CHILI_PROVIDER_ID,
  FauxChiliModel,
  createFauxChiliModel,
  createFauxChiliProvider,
  type FauxChiliScriptEvent,
} from "./faux.js";

test("FauxChiliModel replays scripted Chili stream events", async () => {
  const script: FauxChiliScriptEvent[] = [
    { type: "text_delta", text: "hello ", index: 0 },
    { type: "reasoning_delta", text: "thinking", index: 1 },
    { type: "tool_call_start", toolCallId: "tool_1", name: "lookup", index: 2 },
    { type: "tool_call_delta", toolCallId: "tool_1", name: "lookup", delta: "{\"query\"", index: 2 },
    {
      type: "tool_call_delta",
      toolCallId: "tool_1",
      name: "lookup",
      delta: ":\"chili\"}",
      partialInput: { query: "chili" },
      index: 2,
    },
    { type: "tool_call_end", toolCallId: "tool_1", name: "lookup", input: { query: "chili" }, index: 2 },
    { type: "finish", reason: "tool_use", responseId: "response_faux" },
  ];
  const model = createFauxChiliModel({
    provider: "faux-test",
    model: "scripted",
    script,
  });
  const input: ModelStreamInput = {
    messages: [],
    system: ["runtime system"],
    maxTokens: 64,
    metadata: { test: "faux" },
  };

  const events = await collect(model.stream(input));

  expect(model.provider).toBe("faux-test");
  expect(model.model).toBe("scripted");
  expect(events).toEqual(script);
  expect(model.calls).toEqual([input]);
});

test("FauxChiliModel replays scripted error events", async () => {
  const script: FauxChiliScriptEvent[] = [
    { type: "error", error: { message: "scripted error" }, responseId: "response_faux" },
  ];
  const model = createFauxChiliModel({ script });

  expect(await collect(model.stream({ messages: [] }))).toEqual(script);
});

test("FauxChiliProvider describes and creates scripted models", async () => {
  const provider = createFauxChiliProvider({
    id: "faux-local",
    name: "Faux Local",
    model: "faux-scripted",
    script: [{ type: "finish", reason: "stop" }],
  });

  expect(provider.id).toBe("faux-local");
  expect(provider.name).toBe("Faux Local");
  expect(provider.models()[0]).toMatchObject({
    provider: "faux-local",
    model: "faux-scripted",
    apiFamily: "faux",
    default: true,
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
    },
    inputCapabilities: ["text"],
  });

  const model = provider.getModel("custom-faux-model");
  const events = await collect(model.stream({ messages: [] }));

  expect(model.provider).toBe("faux-local");
  expect(model.model).toBe("custom-faux-model");
  expect(events).toEqual([{ type: "finish", reason: "stop" }]);
});

test("FauxChiliModel rejects immediately when stream input is already aborted", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before stream");
  controller.abort(reason);
  const model = new FauxChiliModel({
    script: [{ type: "text_delta", text: "never" }],
  });

  const error = await captureError(model.stream({ messages: [], signal: controller.signal }));

  expect(error).toBe(reason);
});

test("FauxChiliModel observes AbortSignal while waiting between scripted events", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled during delay");
  const model = new FauxChiliModel({
    script: [
      { type: "delay", ms: 50 },
      { type: "text_delta", text: "never" },
    ],
  });

  const errorPromise = captureError(model.stream({ messages: [], signal: controller.signal }));
  setTimeout(() => controller.abort(reason), 1);

  expect(await errorPromise).toBe(reason);
});

test("FauxChiliProvider uses stable Chili defaults", () => {
  const provider = createFauxChiliProvider();

  expect(provider.id).toBe(FAUX_CHILI_PROVIDER_ID);
  expect(provider.getModel().provider).toBe(FAUX_CHILI_PROVIDER_ID);
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const streamEvent of stream) events.push(streamEvent);
  return events;
}

async function captureError(stream: AsyncIterable<ModelStreamEvent>): Promise<unknown> {
  try {
    await collect(stream);
  } catch (error) {
    return error;
  }
  throw new Error("Expected stream to fail");
}
