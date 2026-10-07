import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ModelStreamInput } from "@chili/core";
import type { PreparedModelIdentity, SessionId, TurnId } from "@chili/protocol";
import { FileAuthStorage } from "@chili/providers";
import { createHostModel } from "./model.js";

const input: ModelStreamInput = {
  sessionId: "session_identity" as SessionId,
  turnId: "turn_identity" as TurnId,
  messages: [],
  tools: [],
  system: [],
};

test("Host records resolved provider credentials and profile before allowing network dispatch", async () => {
  let identity: PreparedModelIdentity | undefined;
  let fetchCalls = 0;
  let recorded = false;
  const apiKey = "host-audit-fake-credential";
  const model = await createHostModel({ provider: "deepseek", model: "deepseek-v4-flash" }, {
    apiKey, profileId: "profile-test", baseUrl: "https://provider.invalid",
    fetch: (async () => {
      fetchCalls++;
      expect(recorded).toBe(true);
      return responsesResponse("deepseek-v4-flash");
    }) as unknown as typeof fetch,
  });
  for await (const _ of model.stream({
    ...input,
    onRequestIdentity: async (resolved) => {
      expect(fetchCalls).toBe(0);
      await Promise.resolve();
      identity = resolved;
      recorded = true;
    },
  })) { /* consume */ }
  expect(identity).toEqual({
    provider: "deepseek", model: "deepseek-v4-flash", profileId: "profile-test",
    credentialVersion: `sha256:${createHash("sha256").update(`Bearer ${apiKey}`).digest("hex")}`,
  });
  expect(JSON.stringify(identity)).not.toContain(apiKey);
  expect(fetchCalls).toBe(1);
});

test("Host forwards the total request deadline even when a transport ignores abort", async () => {
  const model = await createHostModel({ provider: "deepseek", model: "deepseek-v4-flash" }, {
    apiKey: "timeout-fake-key", baseUrl: "https://provider.invalid",
    fetch: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
  });
  const consume = async () => { for await (const _ of model.stream({ ...input, requestTimeoutMs: 20 })) { /* consume */ } };
  await expect(consume()).rejects.toMatchObject({ name: "TimeoutError" });
});

test("a failed identity audit prevents Host model network side effects", async () => {
  let calls = 0;
  const model = await createHostModel({ provider: "deepseek", model: "deepseek-v4-flash" }, {
    apiKey: "blocked-fake-key", baseUrl: "https://provider.invalid",
    fetch: (async () => { calls++; throw new Error("unexpected fetch"); }) as unknown as typeof fetch,
  });
  const consume = async () => {
    for await (const _ of model.stream({ ...input, onRequestIdentity: async () => { throw new Error("audit failed"); } })) { /* consume */ }
  };
  await expect(consume()).rejects.toThrow("audit failed");
  expect(calls).toBe(0);
});

test("Host forwards completed reasoning and text boundaries from a provider", async () => {
  const model = await createHostModel({ provider: "deepseek", model: "deepseek-v4-flash" }, {
    apiKey: "completion-fake-key", baseUrl: "https://provider.invalid",
    fetch: (async () => responsesResponse("deepseek-v4-flash", "The answer", "Consider this")) as unknown as typeof fetch,
  });
  const events = [];
  for await (const event of model.stream(input)) events.push(event);
  expect(events.filter((event) => event.type === "reasoning_end" || event.type === "text_end")).toEqual([
    { type: "reasoning_end", index: 0 },
    { type: "text_end", index: 0 },
  ]);
});

test("switching providers isolates connection options while preserving request controls", async () => {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const router = await createHostModel("deepseek", {
    env: { MOONSHOT_API_KEY: "kimi-test-key", MOONSHOT_BASE_URL: "https://kimi.invalid/v1" },
    apiKey: "deepseek-test-key", baseUrl: "https://deepseek.invalid/responses",
    headers: { "x-private-connection": "deepseek-only" }, maxTokens: 2048,
    fetch: (async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), headers: new Headers(init?.headers), body });
      return responsesResponse(String(body.model));
    }) as typeof fetch,
  });
  for (const modelSelection of [undefined, { provider: "kimi", model: "kimi-k3" }, undefined]) {
    for await (const _ of router.stream({ ...input, ...(modelSelection ? { modelSelection } : {}) })) { /* consume */ }
  }
  expect(requests.map((request) => request.headers.get("authorization"))).toEqual(["Bearer deepseek-test-key", "Bearer kimi-test-key", "Bearer deepseek-test-key"]);
  expect(requests.map((request) => request.headers.get("x-private-connection"))).toEqual(["deepseek-only", null, "deepseek-only"]);
  expect(requests.map((request) => request.url)).toEqual(["https://deepseek.invalid/responses", "https://kimi.invalid/v1/responses", "https://deepseek.invalid/responses"]);
  expect(requests.map((request) => request.body.max_output_tokens)).toEqual([2048, 2048, 2048]);
  expect(requests.map((request) => request.body.input)).toEqual([[], [], []]);
  expect(requests.every((request) => request.body.messages === undefined)).toBe(true);
});

test("custom model limits stay unknown and explicit model/provider conflicts fail", async () => {
  const router = await createHostModel({ provider: "deepseek", model: "custom-model" }, { env: {}, maxTokens: 1024 });
  expect(await router.resolveRequestLimits?.({})).toEqual({ requestMaxOutputTokens: 1024 });
  await expect(createHostModel({ provider: "deepseek", model: "kimi/kimi-k3" })).rejects.toThrow("conflicts");
});

test("Host model availability uses the same explicit environment as request resolution", async () => {
  class EmptyAuth extends FileAuthStorage {
    override async get(): Promise<undefined> { return undefined; }
  }
  const router = await createHostModel("deepseek", {
    env: { DEEPSEEK_API_KEY: "catalog-test-key", DEEPSEEK_BASE_URL: "https://catalog.invalid/v1" },
    authStorage: new EmptyAuth("/unused-host-catalog-test.json"),
  });
  const models = await router.listModels?.();
  const deepseek = models?.filter((model) => model.provider === "deepseek");
  expect(deepseek?.length).toBeGreaterThan(0);
  expect(deepseek?.every((model) => model.available && model.endpoint === "https://catalog.invalid")).toBe(true);
  expect(models?.filter((model) => model.provider !== "deepseek").every((model) => !model.available)).toBe(true);
});

function responsesResponse(model: string, text = "ok", reasoning?: string): Response {
  const output: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [{ type: "response.created", response: { id: "resp_host", model } }];
  if (reasoning !== undefined) {
    const item = { id: "rs_host", type: "reasoning", status: "completed", content: [{ type: "reasoning_text", text: reasoning }] };
    output.push(item);
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.reasoning_text.delta", output_index: 0, content_index: 0, delta: reasoning },
      { type: "response.reasoning_text.done", output_index: 0, content_index: 0, text: reasoning },
      { type: "response.output_item.done", output_index: 0, item },
    );
  }
  const outputIndex = output.length;
  const item = { id: "msg_host", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] };
  output.push(item);
  events.push(
    { type: "response.output_item.added", output_index: outputIndex, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: outputIndex, content_index: 0, delta: text },
    { type: "response.output_text.done", output_index: outputIndex, content_index: 0, text },
    { type: "response.output_item.done", output_index: outputIndex, item },
    { type: "response.completed", response: { id: "resp_host", model, status: "completed", output } },
  );
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
