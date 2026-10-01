import { expect, test } from "bun:test";
import {
  createDeepSeekProvider,
  createDeepSeekV4Model,
  DEEPSEEK_OPENAI_BASE_URL,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_V4_FLASH_MODEL,
  DEEPSEEK_V4_PRO_MODEL,
  resolveDeepSeekCompletionsUrl,
} from "./index.js";
import type { ModelStreamEvent, ReasoningLevel } from "./types.js";

test("DeepSeek model factory resolves model, baseUrl, and API key from env", async () => {
  let url = "";
  let headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    headers = init?.headers as Record<string, string>;
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_env",
        model: DEEPSEEK_V4_FLASH_MODEL,
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const model = createDeepSeekV4Model({
    env: {
      DEEPSEEK_API_KEY: "env-key",
      DEEPSEEK_BASE_URL: DEEPSEEK_OPENAI_BASE_URL,
      DEEPSEEK_MODEL: DEEPSEEK_V4_FLASH_MODEL,
    },
    fetch: fetchImpl,
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(url).toBe("https://api.deepseek.com/chat/completions");
  expect(headers.authorization).toBe("Bearer env-key");
  expect(body).toMatchObject({
    model: DEEPSEEK_V4_FLASH_MODEL,
    max_tokens: 131072,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop", responseId: "chatcmpl_env" });
});

test("DeepSeek provider marks a configured catalog model as default", () => {
  const provider = createDeepSeekProvider({
    env: {
      DEEPSEEK_MODEL: DEEPSEEK_V4_FLASH_MODEL,
      DEEPSEEK_BASE_URL: "https://deepseek.test",
    },
  });

  const models = provider.models();

  expect(models.find((model) => model.model === DEEPSEEK_V4_FLASH_MODEL)).toMatchObject({
    provider: DEEPSEEK_PROVIDER_ID,
    model: DEEPSEEK_V4_FLASH_MODEL,
    apiFamily: "openai-completions",
    baseUrl: "https://deepseek.test",
    default: true,
  });
  expect(models.find((model) => model.model === DEEPSEEK_V4_PRO_MODEL)?.default).toBeUndefined();
  expect(models.filter((model) => model.default)).toHaveLength(1);
});

test("DeepSeek maps Chili reasoning efforts to the documented low, high, and max values", async () => {
  const cases: readonly [ReasoningLevel, "low" | "high" | "max"][] = [
    ["low", "low"],
    ["medium", "high"],
    ["xhigh", "high"],
    ["max", "max"],
  ];

  for (const [reasoningEffort, expectedEffort] of cases) {
    let body: Record<string, unknown> = {};
    const model = createDeepSeekV4Model({
      apiKey: "key",
      reasoningEffort,
      fetch: (async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonCompletion();
      }) as typeof fetch,
    });

    await collect(model.stream({ messages: [], tools: [], system: [] }));

    expect(body).toMatchObject({
      max_tokens: 131072,
      thinking: { type: "enabled" },
      reasoning_effort: expectedEffort,
    });
  }
});

test("DeepSeek reasoning off disables thinking and omits reasoning effort", async () => {
  let body: Record<string, unknown> = {};
  const model = createDeepSeekV4Model({
    apiKey: "key",
    reasoning: false,
    reasoningEffort: "xhigh",
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonCompletion();
    }) as typeof fetch,
  });

  await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(body).toMatchObject({
    max_tokens: 131072,
    thinking: { type: "disabled" },
  });
  expect(body).not.toHaveProperty("reasoning_effort");
});

test("DeepSeek request URL follows the documented root chat completions endpoint", () => {
  expect(resolveDeepSeekCompletionsUrl("https://api.deepseek.com")).toBe(
    "https://api.deepseek.com/chat/completions",
  );
  expect(resolveDeepSeekCompletionsUrl("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/v1");
  expect(resolveDeepSeekCompletionsUrl("https://deepseek.test/chat/completions")).toBe(
    "https://deepseek.test/chat/completions",
  );
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const streamEvent of stream) events.push(streamEvent);
  return events;
}

function jsonCompletion(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_reasoning",
      model: DEEPSEEK_V4_PRO_MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
