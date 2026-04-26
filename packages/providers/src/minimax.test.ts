import { expect, test } from "bun:test";
import { createMiniMaxM27HighspeedModel, createMiniMaxProvider, MINIMAX_PROVIDER_ID } from "./index.js";
import type { ModelStreamEvent } from "./types.js";

test("MiniMax model factory resolves model, baseUrl, and API key from env", async () => {
  let url = "";
  let headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    headers = init?.headers as Record<string, string>;
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "msg_env", content: [], stop_reason: "end_turn" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const model = createMiniMaxM27HighspeedModel({
    env: {
      MINIMAX_API_KEY: "env-key",
      MINIMAX_ANTHROPIC_BASE_URL: "https://env.minimax.test/anthropic",
      MINIMAX_MODEL: "MiniMax-M2.7",
    },
    fetch: fetchImpl,
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(url).toBe("https://env.minimax.test/anthropic/v1/messages");
  expect(headers.authorization).toBe("Bearer env-key");
  expect(body.model).toBe("MiniMax-M2.7");
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "end_turn", responseId: "msg_env" });
});

test("MiniMax provider lists a configured custom default model without dropping catalog models", () => {
  const provider = createMiniMaxProvider({
    env: {
      MINIMAX_MODEL: "custom-minimax-model",
      MINIMAX_BASE_URL: "https://custom.minimax.test/anthropic",
    },
  });

  const models = provider.models();

  expect(models[0]).toMatchObject({
    provider: MINIMAX_PROVIDER_ID,
    model: "custom-minimax-model",
    apiFamily: "anthropic-messages",
    baseUrl: "https://custom.minimax.test/anthropic",
    default: true,
  });
  expect(models.some((model) => model.model === "MiniMax-M2.7-highspeed")).toBe(true);
  expect(models.filter((model) => model.default)).toHaveLength(1);
});

test("MiniMax provider marks an env-selected catalog model as default", () => {
  const provider = createMiniMaxProvider({
    env: {
      MINIMAX_MODEL: "MiniMax-M2.7",
      MINIMAX_BASE_URL: "https://catalog.minimax.test/anthropic",
    },
  });

  const models = provider.models();

  expect(models.find((model) => model.model === "MiniMax-M2.7")).toMatchObject({
    model: "MiniMax-M2.7",
    baseUrl: "https://catalog.minimax.test/anthropic",
    default: true,
  });
  expect(models.find((model) => model.model === "MiniMax-M2.7-highspeed")?.default).toBeUndefined();
  expect(models.filter((model) => model.default)).toHaveLength(1);
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const streamEvent of stream) events.push(streamEvent);
  return events;
}
