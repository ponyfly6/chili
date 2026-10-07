import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import { AnthropicCompatibleModel, buildAnthropicRequestBody } from "../protocols/messages.js";
import { OpenAICompletionsModel, buildOpenAICompletionsRequestBody } from "../protocols/chat-completions.js";
import { CodexApiResponsesModel, OpenAICodexResponsesModel, buildOpenAICodexResponsesRequestBody } from "../vendors/openai/index.js";
import { FileAuthStorage, type OAuthCredential } from "../auth/storage.js";
import { ProviderBackpressureCoordinator } from "./backpressure.js";
import type { ChiliModel, ModelRequestIdentity, ModelStreamInput } from "../types.js";

const adapters: Array<{ name: string; create: (fetchImpl: typeof fetch, coordinator?: ProviderBackpressureCoordinator) => ChiliModel }> = [
  { name: "responses", create: (fetchImpl, coordinator = new ProviderBackpressureCoordinator()) => new CodexApiResponsesModel({ model: "gpt-6.1-sol", apiKey: "fake", baseUrl: "https://fake.invalid/v1", fetch: fetchImpl, backpressureCoordinator: coordinator }) },
  { name: "completions", create: (fetchImpl, coordinator = new ProviderBackpressureCoordinator()) => new OpenAICompletionsModel({ model: "fake", apiKey: "fake", baseUrl: "https://fake.invalid/v1", fetch: fetchImpl, backpressureCoordinator: coordinator }) },
  { name: "anthropic", create: (fetchImpl, coordinator = new ProviderBackpressureCoordinator()) => new AnthropicCompatibleModel({ model: "fake", apiKey: "fake", baseUrl: "https://fake.invalid/v1", fetch: fetchImpl, backpressureCoordinator: coordinator }) },
];
async function consume(model: ChiliModel, input: Partial<ModelStreamInput> = {}): Promise<void> {
  for await (const _ of model.stream({ messages: [], ...input })) { /* verify entire request */ }
}

for (const adapter of adapters) {
  test(`${adapter.name} records the actual credential fingerprint before dispatch and fails closed if recording fails`, async () => {
    let calls = 0;
    let identity: ModelRequestIdentity | undefined;
    const model = adapter.create((async () => { calls++; return new Response(); }) as unknown as typeof fetch);
    await expect(consume(model, { onRequestIdentity: async (value) => {
      identity = value;
      expect(calls).toBe(0);
      throw new Error("identity recorder unavailable");
    } })).rejects.toThrow("identity recorder unavailable");
    expect(identity?.provider).toBe(model.provider);
    expect(identity?.model).toBe(model.model);
    expect(identity?.credentialVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(identity?.accountId).toBeUndefined();
    expect(calls).toBe(0);
  });

  test(`${adapter.name} total deadline aborts a transport that never returns headers`, async () => {
    let transportSignal: AbortSignal | null | undefined;
    const model = adapter.create((async (_url: string | URL | Request, init?: RequestInit) => {
      transportSignal = init?.signal;
      return await new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch);
    await expect(consume(model, { requestTimeoutMs: 20 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(transportSignal?.aborted).toBe(true);
  });

  test(`${adapter.name} already cancelled requests never invoke fetch`, async () => {
    let calls = 0;
    const model = adapter.create((async () => { calls++; return new Response(); }) as unknown as typeof fetch);
    await expect(consume(model, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });

  test(`${adapter.name} live cancellation aborts the exact signal supplied to its transport`, async () => {
    const controller = new AbortController();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let transportSignal: AbortSignal | null | undefined;
    const model = adapter.create((async (_url: string | URL | Request, init?: RequestInit) => {
      transportSignal = init?.signal;
      started();
      return await new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch);
    const result = consume(model, { signal: controller.signal }).catch((error: Error) => error);
    await startedPromise;
    controller.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(transportSignal?.aborted).toBe(true);
  });

  test(`${adapter.name} coordinates rate limits across model instances and cancels waiting siblings`, async () => {
    let calls = 0;
    const coordinator = new ProviderBackpressureCoordinator();
    const fetchImpl = (async () => { calls++; return Response.json({ error: { message: "Rate limit", type: "rate_limit_error" } }, { status: 429, headers: { "retry-after": "5" } }); }) as unknown as typeof fetch;
    await expect(consume(adapter.create(fetchImpl, coordinator))).rejects.toMatchObject({ category: "rate_limit" });
    const controller = new AbortController();
    const request = consume(adapter.create(fetchImpl, coordinator), { signal: controller.signal }).catch((error: Error) => error);
    await Bun.sleep(5);
    controller.abort();
    expect(await request).toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });
}

test("ChatGPT rate limiting follows account identity through access-token rotation", async () => {
  class MemoryAuth extends FileAuthStorage {
    constructor(public value: OAuthCredential) { super("/tmp/unused-fake-lifecycle-auth.json"); }
    override async getOAuthCredentials(): Promise<OAuthCredential> { return this.value; }
  }
  const auth = new MemoryAuth({ type: "oauth", access: "fake-one", refresh: "fake", expires: Date.now() + 3600_000, accountId: "fake-account" });
  const coordinator = new ProviderBackpressureCoordinator();
  let calls = 0;
  const fetchImpl = (async () => { calls++; return Response.json({ error: { message: "Rate limit", type: "rate_limit_error" } }, { status: 429, headers: { "retry-after": "5" } }); }) as unknown as typeof fetch;
  await expect(consume(new OpenAICodexResponsesModel({ authStorage: auth, fetch: fetchImpl, backpressureCoordinator: coordinator }))).rejects.toMatchObject({ category: "rate_limit" });
  auth.value = { ...auth.value, access: "fake-two" };
  await expect(consume(new OpenAICodexResponsesModel({ authStorage: auth, fetch: fetchImpl, backpressureCoordinator: coordinator }), { requestTimeoutMs: 20 })).rejects.toMatchObject({ name: "TimeoutError" });
  expect(calls).toBe(1);
});

test("all provider replay adapters pair internal IDs but serialize provider IDs, retaining legacy histories", () => {
  const sessionId = "session_fake" as SessionId;
  const messages: Message[] = [];
  for (const [index, modern] of [true, true, false].entries()) {
    const messageId = `message_${index}` as MessageId;
    const callId = `${modern ? "internal_unique" : "legacy_call"}_${index}` as ToolCallId;
    const providerCallId = modern ? { providerCallId: "call_0" } : {};
    messages.push({ id: messageId, sessionId, role: "assistant", createdAt: 1 as TimestampMs, parts: [{ id: `part_call_${index}` as PartId, messageId, sessionId, type: "tool_call", status: "completed", toolName: "read", input: {}, callId, ...providerCallId }] });
    messages.push({ id: `${messageId}_result` as MessageId, sessionId, role: "user", createdAt: 2 as TimestampMs, parts: [{ id: `part_result_${index}` as PartId, messageId: `${messageId}_result` as MessageId, sessionId, type: "tool_result", callId, output: `result ${index}`, ...providerCallId }] });
  }
  for (const body of [
    buildAnthropicRequestBody({ messages }, { model: "fake" }),
    buildOpenAICompletionsRequestBody({ messages }, { provider: "fake", model: "fake" }),
    buildOpenAICodexResponsesRequestBody({ messages }, { model: "gpt-6.1-sol" }),
  ]) {
    const text = JSON.stringify(body);
    expect(text).not.toContain("internal_unique");
    expect(text.match(/call_0/g)).toHaveLength(4);
    expect(text.match(/"call_0"/g)).toHaveLength(2);
    expect(text.match(/legacy_call_2/g)).toHaveLength(2);
    expect(text).not.toContain("No result provided");
  }
  expect(messages[2]?.parts[0]).toMatchObject({ callId: "internal_unique_1", providerCallId: "call_0" });
});
