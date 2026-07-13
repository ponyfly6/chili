import { expect, test } from "bun:test";
import {
  createZaiModel,
  createZaiProvider,
  ZAI_GLM_52_MODEL,
  ZAI_GLM_52_1M_MODEL,
  ZAI_OPENAI_BASE_URL,
  ZAI_PROVIDER_ID,
} from "./index.js";
import type { ModelStreamEvent } from "./types.js";

test("Z.ai model factory resolves GLM-5.2, baseUrl, and API key from env", async () => {
  let url = "";
  let headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    headers = init?.headers as Record<string, string>;
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_zai",
        model: ZAI_GLM_52_MODEL,
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const model = createZaiModel({
    env: {
      ZAI_API_KEY: "env-key",
      ZAI_BASE_URL: ZAI_OPENAI_BASE_URL,
      ZAI_MODEL: ZAI_GLM_52_MODEL,
    },
    fetch: fetchImpl,
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
  expect(headers.authorization).toBe("Bearer env-key");
  expect(body).toMatchObject({
    model: ZAI_GLM_52_MODEL,
    max_tokens: 131072,
    thinking: { type: "enabled" },
  });
  expect(body).not.toHaveProperty("reasoning_effort");
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop", responseId: "chatcmpl_zai" });
});

test("Z.ai maps Chili xhigh reasoning to GLM-5.2 max effort", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_zai",
        model: ZAI_GLM_52_MODEL,
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const model = createZaiModel({
    apiKey: "key",
    baseUrl: ZAI_OPENAI_BASE_URL,
    reasoning: true,
    reasoningEffort: "xhigh",
    fetch: fetchImpl,
  });

  await collect(model.stream({
    messages: [],
    tools: [{ name: "lookup", description: "Look up a value", inputSchema: { type: "object" } }],
  }));

  expect(body).toMatchObject({
    thinking: { type: "enabled" },
    reasoning_effort: "max",
    tool_stream: true,
  });
});

test("Z.ai routes the Coding Plan Anthropic endpoint through Messages", async () => {
  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "msg_zai",
        model: ZAI_GLM_52_1M_MODEL,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const model = createZaiModel({
    apiKey: "key",
    baseUrl: "https://api.z.ai/api/anthropic",
    model: ZAI_GLM_52_1M_MODEL,
    fetch: fetchImpl,
  });
  await collect(model.stream({ messages: [] }));

  expect(url).toBe("https://api.z.ai/api/anthropic/v1/messages");
  expect(headers.get("authorization")).toBe("Bearer key");
  expect(headers.has("x-api-key")).toBe(false);
  expect(body).toMatchObject({ model: ZAI_GLM_52_1M_MODEL, max_tokens: 131072, stream: true });
});

test("Z.ai provider marks the configured catalog model as default", () => {
  const provider = createZaiProvider({
    env: {
      ZAI_MODEL: ZAI_GLM_52_MODEL,
      ZAI_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
    },
  });

  const models = provider.models();
  expect(models.find((model) => model.model === ZAI_GLM_52_MODEL)).toMatchObject({
    provider: ZAI_PROVIDER_ID,
    model: ZAI_GLM_52_MODEL,
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    default: true,
  });
  expect(models.find((model) => model.model === ZAI_GLM_52_1M_MODEL)?.default).toBeUndefined();
  expect(models.filter((model) => model.default)).toHaveLength(1);
});

test("Z.ai model factory explains missing API key env", () => {
  expect(() => createZaiModel({ env: {} })).toThrow("Z.ai provider requires ZAI_API_KEY");
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const streamEvent of stream) events.push(streamEvent);
  return events;
}
