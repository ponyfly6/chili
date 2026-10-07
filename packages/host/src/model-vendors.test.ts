import { expect, test } from "bun:test";
import type { ModelStreamInput } from "@chili/core";
import type { SessionId, TurnId } from "@chili/protocol";
import { FileAuthStorage } from "@chili/providers";
import { createHostModel, resolveHostRuntimeModelSelection } from "./model.js";

const input: ModelStreamInput = {
  sessionId: "session_vendor_routing" as SessionId,
  turnId: "turn_vendor_routing" as TurnId,
  messages: [],
  tools: [],
  system: [],
};

class EmptyAuthStorage extends FileAuthStorage {
  override async get(): Promise<undefined> { return undefined; }
}

test("Host catalog isolates credentials for vendors sharing a protocol or model name", async () => {
  const cases = [
    ["ANTHROPIC_API_KEY", "anthropic"],
    ["MINIMAX_API_KEY", "minimax"],
    ["OPENAI_API_KEY", "openai"],
    ["ZAI_API_KEY", "zai"],
    ["ZHIPU_API_KEY", "zhipu"],
  ] as const;
  for (const [variable, provider] of cases) {
    const router = await createHostModel(provider, {
      env: { [variable]: "isolated-catalog-fake-key" },
      authStorage: new EmptyAuthStorage("/unused-vendor-catalog-test.json"),
    });
    const models = await router.listModels?.();
    expect(models?.filter((model) => model.provider === provider).length).toBeGreaterThan(0);
    expect([...new Set(models?.filter((model) => model.available).map((model) => model.provider))]).toEqual([provider]);
  }
});

test("bare GPT references keep their ChatGPT routing while explicit OpenAI selects the official API", () => {
  expect(resolveHostRuntimeModelSelection({ model: "gpt-6.1-sol" })).toEqual({ provider: "openai-codex", model: "gpt-6.1-sol" });
  expect(resolveHostRuntimeModelSelection({ model: "openai/gpt-6.1-sol" })).toEqual({ provider: "openai", model: "gpt-6.1-sol" });
  expect(resolveHostRuntimeModelSelection({ provider: "openai", model: "gpt-5.6-sol" })).toEqual({ provider: "openai", model: "gpt-5.6-sol" });
});

test("switching to official APIs uses their own endpoint and credentials and keeps the original connection intact", async () => {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const router = await createHostModel({ provider: "minimax", model: "MiniMax-M3" }, {
    env: {
      ANTHROPIC_API_KEY: "anthropic-fake-key",
      ANTHROPIC_BASE_URL: "https://anthropic.invalid",
      OPENAI_API_KEY: "openai-fake-key",
      OPENAI_BASE_URL: "https://openai.invalid/v1",
    },
    apiKey: "minimax-fake-key",
    baseUrl: "https://minimax.invalid/anthropic",
    headers: { "x-private-connection": "minimax-only" },
    maxTokens: 2048,
    fetch: (async (url, init) => {
      const request = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      requests.push(request);
      if (request.url.endsWith("/responses")) {
        return new Response(`event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed", response: { id: "resp_vendor", status: "completed", model: request.body.model, output: [] },
        })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "msg_vendor", model: request.body.model, type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
    }) as typeof fetch,
  });
  const selections = [
    undefined,
    { provider: "anthropic", model: "claude-opus-5-5" },
    { provider: "openai", model: "gpt-6.1-sol" },
    undefined,
  ];
  for (const modelSelection of selections) {
    for await (const _ of router.stream({ ...input, ...(modelSelection ? { modelSelection } : {}) })) { /* consume */ }
  }
  expect(requests.map((request) => request.url)).toEqual([
    "https://minimax.invalid/anthropic/v1/messages", "https://anthropic.invalid/v1/messages",
    "https://openai.invalid/v1/responses", "https://minimax.invalid/anthropic/v1/messages",
  ]);
  expect(requests.map((request) => request.headers.get("x-api-key"))).toEqual([null, "anthropic-fake-key", null, null]);
  expect(requests.map((request) => request.headers.get("authorization"))).toEqual(["Bearer minimax-fake-key", null, "Bearer openai-fake-key", "Bearer minimax-fake-key"]);
  expect(requests.map((request) => request.headers.get("x-private-connection"))).toEqual(["minimax-only", null, null, "minimax-only"]);
  expect(requests.map((request) => request.body.max_tokens ?? request.body.max_output_tokens)).toEqual([2048, 2048, 2048, 2048]);
});

test("domestic vendor aliases route to independent connections, including custom Doubao deployment IDs", async () => {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const router = await createHostModel("deepseek", {
    env: {
      DASHSCOPE_API_KEY: "alibaba-fake-key", DASHSCOPE_BASE_URL: "https://alibaba.invalid/compatible-mode/v1",
      ARK_API_KEY: "doubao-fake-key", ARK_BASE_URL: "https://doubao.invalid/api/v3",
      ZHIPU_API_KEY: "zhipu-fake-key", ZHIPU_BASE_URL: "https://zhipu.invalid/api/paas/v4",
    },
    apiKey: "deepseek-fake-key", baseUrl: "https://deepseek.invalid",
    headers: { "x-private-connection": "deepseek-only" }, maxTokens: 2048,
    fetch: (async (url, init) => {
      const request = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      requests.push(request);
      return Response.json({ id: "chatcmpl_vendors", model: request.body.model, choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }] });
    }) as typeof fetch,
  });
  const selections = [
    { provider: "qwen", model: "qwen3.8-max" },
    { provider: "ark", model: "ep-host-routing" },
    { provider: "bigmodel", model: "glm-5.3" },
  ];
  const identities: string[] = [];
  for (const modelSelection of selections) {
    for await (const event of router.stream({ ...input, modelSelection })) {
      if (event.type === "metadata" && event.provider && event.model) identities.push(`${event.provider}/${event.model}`);
    }
  }
  expect(requests.map((request) => request.url)).toEqual([
    "https://alibaba.invalid/compatible-mode/v1/chat/completions",
    "https://doubao.invalid/api/v3/chat/completions",
    "https://zhipu.invalid/api/paas/v4/chat/completions",
  ]);
  expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
    "Bearer alibaba-fake-key", "Bearer doubao-fake-key", "Bearer zhipu-fake-key",
  ]);
  expect(requests.every((request) => !request.headers.has("x-private-connection"))).toBe(true);
  expect(requests.map((request) => request.body.max_tokens ?? request.body.max_completion_tokens)).toEqual([2048, 2048, 2048]);
  expect(identities).toEqual(["alibaba/qwen3.8-max", "doubao/ep-host-routing", "zhipu/glm-5.3"]);
});
