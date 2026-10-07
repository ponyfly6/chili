import { expect, test } from "bun:test";
import {
  createXaiModel,
  createXaiProvider,
  XAI_GROK_46_MODEL,
  XAI_OPENAI_BASE_URL,
  XAI_PROVIDER_ID,
} from "./provider.js";
import type { ModelStreamEvent } from "../../types.js";

test("xAI model factory uses Grok 4.6, official endpoint, and API key from env", async () => {
  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse([
      {
        id: "chatcmpl_xai",
        model: XAI_GROK_46_MODEL,
        choices: [{ index: 0, delta: { reasoning_content: "thinking " } }],
      },
      {
        id: "chatcmpl_xai",
        model: XAI_GROK_46_MODEL,
        choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
      },
    ]);
  }) as typeof fetch;

  const model = createXaiModel({
    env: {
      XAI_API_KEY: "env-key",
      XAI_BASE_URL: XAI_OPENAI_BASE_URL,
      XAI_MODEL: XAI_GROK_46_MODEL,
    },
    fetch: fetchImpl,
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(url).toBe("https://api.x.ai/v1/chat/completions");
  expect(headers.get("authorization")).toBe("Bearer env-key");
  expect(body).toMatchObject({
    model: XAI_GROK_46_MODEL,
    max_completion_tokens: 128_000,
    reasoning_effort: "high",
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(body).not.toHaveProperty("max_tokens");
  expect(body).not.toHaveProperty("thinking");
  expect(events).toContainEqual({ type: "reasoning_delta", text: "thinking ", index: 0 });
  expect(events).toContainEqual({ type: "text_delta", text: "done", index: 0 });
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop", responseId: "chatcmpl_xai" });
});

test("xAI forwards configurable reasoning effort and temperature", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_xai",
        model: XAI_GROK_46_MODEL,
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const model = createXaiModel({
    apiKey: "key",
    reasoningEffort: "xhigh",
    temperature: 0.2,
    fetch: fetchImpl,
  });
  await collect(model.stream({
    messages: [],
    tools: [{ name: "lookup", description: "Look up a value", inputSchema: { type: "object" } }],
  }));

  expect(body).toMatchObject({
    reasoning_effort: "xhigh",
    temperature: 0.2,
    tools: [{ type: "function", function: { name: "lookup" } }],
  });
  expect(body).not.toHaveProperty("thinking");
});

test("xAI provider marks the configured catalog model as default and preserves image capability", () => {
  const provider = createXaiProvider({
    env: {
      XAI_MODEL: XAI_GROK_46_MODEL,
      XAI_BASE_URL: "https://xai.test/v1",
    },
  });

  const models = provider.models();
  expect(models.find((model) => model.model === XAI_GROK_46_MODEL)).toMatchObject({
    provider: XAI_PROVIDER_ID,
    model: XAI_GROK_46_MODEL,
    apiFamily: "openai-completions",
    baseUrl: "https://xai.test/v1",
    inputCapabilities: ["text", "image"],
    default: true,
  });
  expect(models.filter((model) => model.default)).toHaveLength(1);
});

test("xAI model factory explains missing API key env", () => {
  expect(() => createXaiModel({ env: {} })).toThrow("xAI provider requires XAI_API_KEY");
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const streamEvent of stream) events.push(streamEvent);
  return events;
}

function sseResponse(chunks: readonly Record<string, unknown>[]): Response {
  const payload = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
