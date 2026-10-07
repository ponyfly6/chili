import { expect, test } from "bun:test";
import {
  createKimiModel,
  createKimiProvider,
  KIMI_K3_MODEL,
  KIMI_OPENAI_BASE_URL,
  KIMI_PROVIDER_ID,
} from "./provider.js";
import type { ModelStreamEvent } from "../../types.js";

test("Kimi model factory resolves latest model, baseUrl, and API key from env", async () => {
  let url = "";
  let headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    headers = init?.headers as Record<string, string>;
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_kimi",
        model: KIMI_K3_MODEL,
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const model = createKimiModel({
    env: {
      MOONSHOT_API_KEY: "env-key",
      MOONSHOT_BASE_URL: KIMI_OPENAI_BASE_URL,
      MOONSHOT_MODEL: KIMI_K3_MODEL,
    },
    fetch: fetchImpl,
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(url).toBe("https://api.moonshot.cn/v1/chat/completions");
  expect(headers.authorization).toBe("Bearer env-key");
  expect(body).toMatchObject({
    model: KIMI_K3_MODEL,
    max_completion_tokens: 131072,
  });
  expect(body).not.toHaveProperty("max_tokens");
  expect(body).not.toHaveProperty("thinking");
  expect(body).not.toHaveProperty("reasoning_effort");
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop", responseId: "chatcmpl_kimi" });
});

test("Kimi model factory explains missing API key env", () => {
  expect(() => createKimiModel({ env: {} })).toThrow("Kimi provider requires MOONSHOT_API_KEY or KIMI_API_KEY");
});

test("Kimi K3 reasoning off selects low effort without a thinking switch", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_kimi",
        model: KIMI_K3_MODEL,
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const model = createKimiModel({
    apiKey: "key",
    baseUrl: KIMI_OPENAI_BASE_URL,
    reasoning: false,
    fetch: fetchImpl,
  });

  await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(body).toMatchObject({
    model: KIMI_K3_MODEL,
    reasoning_effort: "low",
  });
  expect(body).not.toHaveProperty("thinking");
});

test("Kimi K3 sends supported reasoning effort without a thinking switch", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_kimi",
        model: KIMI_K3_MODEL,
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const model = createKimiModel({
    apiKey: "key",
    baseUrl: KIMI_OPENAI_BASE_URL,
    reasoning: true,
    reasoningEffort: "high",
    fetch: fetchImpl,
  });

  await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(body).toMatchObject({
    model: KIMI_K3_MODEL,
    reasoning_effort: "high",
  });
  expect(body).not.toHaveProperty("thinking");
});

test("Kimi provider marks the configured catalog model as default", () => {
  const provider = createKimiProvider({
    env: {
      MOONSHOT_MODEL: KIMI_K3_MODEL,
      MOONSHOT_BASE_URL: "https://moonshot.test/v1",
    },
  });

  const models = provider.models();

  expect(models.find((model) => model.model === KIMI_K3_MODEL)).toMatchObject({
    provider: KIMI_PROVIDER_ID,
    model: KIMI_K3_MODEL,
    apiFamily: "openai-completions",
    baseUrl: "https://moonshot.test/v1",
    default: true,
  });
  expect(models.filter((model) => model.default)).toHaveLength(1);
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const streamEvent of stream) events.push(streamEvent);
  return events;
}
