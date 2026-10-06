import { expect, test } from "bun:test";
import { createMiniMaxM3Model, createMiniMaxProvider, MINIMAX_M3_MODEL, MINIMAX_PROVIDER_ID } from "./index.js";
import type { ModelStreamEvent } from "./types.js";

test("MiniMax M3 model factory resolves model, baseUrl, and API key from env", async () => {
  let url = "";
  let headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "msg_env", content: [], stop_reason: "end_turn" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const model = createMiniMaxM3Model({
    env: {
      MINIMAX_API_KEY: "env-key",
      MINIMAX_ANTHROPIC_BASE_URL: "https://env.minimax.test/anthropic",
      MINIMAX_MODEL: MINIMAX_M3_MODEL,
    },
    fetch: fetchImpl,
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(url).toBe("https://env.minimax.test/anthropic/v1/messages");
  expect(headers.authorization).toBe("Bearer env-key");
  expect(body.model).toBe(MINIMAX_M3_MODEL);
  expect(body.max_tokens).toBe(131072);
  expect(body.thinking).toEqual({ type: "adaptive" });
  expect(body).not.toHaveProperty("service_tier");
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "end_turn", responseId: "msg_env" });
});

test("MiniMax Anthropic base URL env wins over generic MiniMax base URL", async () => {
  let url = "";
  const fetchImpl = (async (input) => {
    url = String(input);
    return new Response(JSON.stringify({ id: "msg_url", content: [], stop_reason: "end_turn" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const model = createMiniMaxM3Model({
    env: {
      MINIMAX_API_KEY: "env-key",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
      MINIMAX_ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
    },
    fetch: fetchImpl,
  });

  await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(url).toBe("https://api.minimaxi.com/anthropic/v1/messages");
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
  expect(models.some((model) => model.model === MINIMAX_M3_MODEL)).toBe(true);
  expect(models.filter((model) => model.default)).toHaveLength(1);
});

test("MiniMax provider marks an env-selected catalog model as default", () => {
  const provider = createMiniMaxProvider({
    env: {
      MINIMAX_MODEL: MINIMAX_M3_MODEL,
      MINIMAX_BASE_URL: "https://catalog.minimax.test/anthropic",
    },
  });

  const models = provider.models();

  expect(models.find((model) => model.model === MINIMAX_M3_MODEL)).toMatchObject({
    model: MINIMAX_M3_MODEL,
    baseUrl: "https://catalog.minimax.test/anthropic",
    default: true,
  });
  expect(models.filter((model) => model.default)).toHaveLength(1);
});

test("MiniMax maps explicit reasoning and fast service tier options", async () => {
  let body: Record<string, unknown> = {};
  const model = createMiniMaxM3Model({
    apiKey: "test-key",
    env: {},
    reasoning: false,
    serviceTier: "fast",
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "msg_options", content: [], stop_reason: "end_turn" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(body.model).toBe(MINIMAX_M3_MODEL);
  expect(body.max_tokens).toBe(131072);
  expect(body.thinking).toEqual({ type: "disabled" });
  expect(body.service_tier).toBe("priority");
});

test("MiniMax per-request reasoning and service tier override model options", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ id: "msg_override", content: [], stop_reason: "end_turn" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const adaptiveFast = createMiniMaxM3Model({
    apiKey: "test-key",
    env: {},
    reasoning: true,
    serviceTier: "fast",
    fetch: fetchImpl,
  });
  const disabledStandard = createMiniMaxM3Model({
    apiKey: "test-key",
    env: {},
    reasoning: false,
    serviceTier: "standard",
    fetch: fetchImpl,
  });

  await collect(adaptiveFast.stream({
    messages: [],
    tools: [],
    system: [],
    reasoning: "off",
    serviceTier: "standard",
  }));
  await collect(disabledStandard.stream({
    messages: [],
    tools: [],
    system: [],
    reasoning: "high",
    serviceTier: "fast",
  }));

  expect(bodies[0]?.thinking).toEqual({ type: "disabled" });
  expect(bodies[0]).not.toHaveProperty("service_tier");
  expect(bodies[1]?.thinking).toEqual({ type: "adaptive" });
  expect(bodies[1]?.service_tier).toBe("priority");
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const streamEvent of stream) events.push(streamEvent);
  return events;
}
