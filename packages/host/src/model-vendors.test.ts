import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    baseUrl: "https://minimax.invalid/v1",
    headers: { "x-private-connection": "minimax-only" },
    maxTokens: 2048,
    fetch: (async (url, init) => {
      const request = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      requests.push(request);
      if (request.url.endsWith("/responses")) {
        return responsesResponse(String(request.body.model));
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
    "https://minimax.invalid/v1/responses", "https://anthropic.invalid/v1/messages",
    "https://openai.invalid/v1/responses", "https://minimax.invalid/v1/responses",
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
      if (request.url.endsWith("/responses")) return responsesResponse(String(request.body.model));
      return Response.json({ id: "chatcmpl_vendors", model: request.body.model, choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }] });
    }) as typeof fetch,
  });
  const selections = [
    { provider: "qwen", model: "qwen3.8-max" },
    { provider: "ark", model: "ep-host-routing" },
    { provider: "bigmodel", model: "glm-5.3" },
  ];
  const identities: string[][] = [];
  for (const modelSelection of selections) {
    const selectedIdentities = new Set<string>();
    for await (const event of router.stream({ ...input, modelSelection })) {
      if (event.type === "metadata" && event.provider && event.model) selectedIdentities.add(`${event.provider}/${event.model}`);
    }
    identities.push([...selectedIdentities]);
  }
  expect(requests.map((request) => request.url)).toEqual([
    "https://alibaba.invalid/compatible-mode/v1/responses",
    "https://doubao.invalid/api/v3/responses",
    "https://zhipu.invalid/api/paas/v4/chat/completions",
  ]);
  expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
    "Bearer alibaba-fake-key", "Bearer doubao-fake-key", "Bearer zhipu-fake-key",
  ]);
  expect(requests.every((request) => !request.headers.has("x-private-connection"))).toBe(true);
  expect(requests.map((request) => request.body.max_output_tokens ?? request.body.max_tokens ?? request.body.max_completion_tokens)).toEqual([2048, 2048, 2048]);
  expect(identities).toEqual([["alibaba/qwen3.8-max"], ["doubao/ep-host-routing"], ["zhipu/glm-5.3"]]);
});

test("Host resolves stored API keys per selected provider after explicit and environment credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-host-stored-key-"));
  const storage = new FileAuthStorage(join(root, "auth.json"));
  const requests: { model: string; authorization: string | null }[] = [];
  const fetchImpl = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    requests.push({ model: body.model, authorization: new Headers(init?.headers).get("authorization") });
    return responsesResponse(body.model);
  }) as typeof fetch;
  try {
    await storage.set("minimax", { type: "api_key", key: "stored-minimax-fixture" });
    await storage.set("deepseek", { type: "api_key", key: "stored-deepseek-fixture" });
    const stored = await createHostModel("minimax/MiniMax-M3", { authStorage: storage, env: {}, fetch: fetchImpl });
    for await (const _ of stored.stream(input)) { /* consume the real router */ }
    for await (const _ of stored.stream({ ...input, modelSelection: { provider: "deepseek", model: "deepseek-v4-pro" } })) { /* selected provider */ }
    const environment = await createHostModel("minimax/MiniMax-M3", {
      authStorage: storage, env: { MINIMAX_API_KEY: "environment-minimax-fixture" }, fetch: fetchImpl,
    });
    for await (const _ of environment.stream(input)) { /* environment wins over storage */ }
    const explicit = await createHostModel("minimax/MiniMax-M3", {
      authStorage: storage, apiKey: "explicit-minimax-fixture",
      env: { MINIMAX_API_KEY: "environment-minimax-fixture" }, fetch: fetchImpl,
    });
    for await (const _ of explicit.stream(input)) { /* explicit wins over environment */ }
    for await (const _ of explicit.stream({ ...input, modelSelection: { provider: "deepseek", model: "deepseek-v4-pro" } })) { /* no cross-provider explicit key */ }
    expect(requests.map((request) => request.authorization)).toEqual([
      "Bearer stored-minimax-fixture", "Bearer stored-deepseek-fixture", "Bearer environment-minimax-fixture",
      "Bearer explicit-minimax-fixture", "Bearer stored-deepseek-fixture",
    ]);
    expect(requests.map((request) => request.model)).toEqual([
      "MiniMax-M3", "deepseek-v4-pro", "MiniMax-M3", "MiniMax-M3", "deepseek-v4-pro",
    ]);
    // A missing target credential must not borrow the selected provider's key.
    const emptyTarget = new FileAuthStorage(join(root, "only-minimax.json"));
    await emptyTarget.set("minimax", { type: "api_key", key: "only-minimax-fixture" });
    const isolated = await createHostModel("minimax", { authStorage: emptyTarget, env: {}, fetch: fetchImpl });
    const consumeForeign = async () => {
      for await (const _ of isolated.stream({ ...input, modelSelection: { provider: "deepseek", model: "deepseek-v4-pro" } })) {}
    };
    await expect(consumeForeign()).rejects.toThrow("DEEPSEEK_API_KEY");
    expect(requests).toHaveLength(5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function responsesResponse(model: string): Response {
  const item = { id: "msg_vendor", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] };
  const events = [
    { type: "response.created", response: { id: "resp_vendor", model } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_vendor", status: "completed", model, output: [item] } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
