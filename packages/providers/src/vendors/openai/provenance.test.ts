import { expect, test } from "bun:test";
import type { Message, PersistedModelOutput } from "@chili/protocol";
import { FileAuthStorage, type OAuthCredential, type OAuthCredentials } from "../../auth/storage.js";
import { ProviderBackpressureCoordinator } from "../../runtime/backpressure.js";
import type { ChiliModel, ModelStreamEvent } from "../../types.js";
import { createOpenAIModel } from "./provider.js";
import { createCodexApiModel } from "./codex-api.js";
import { createOpenAICodexModel } from "./chatgpt.js";
import { OPENAI_CODEX_TOKEN_URL } from "./oauth.js";

const item = { id: "reasoning_scope", type: "reasoning", encrypted_content: "opaque-ciphertext", summary: [] };
const completed = { type: "response.completed", response: { status: "completed" } };
const emitted = [{ type: "response.output_item.done", output_index: 0, item }, completed];

test("Responses continuation resumes on the same connection without persisting secrets or altering its raw item", async () => {
  const first = capture(emitted);
  const source = await outputOf(createOpenAIModel({ apiKey: "raw-private-key", env: {}, ...first }));
  expect(source.source).toEqual({ provider: "openai", connection: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
  expect(JSON.stringify(source.source)).not.toContain("raw-private-key");
  expect(JSON.stringify(source.source)).not.toContain("api.openai.com");
  expect(source.item).toEqual(item);
  expect(source.item).not.toHaveProperty("source");

  const history = conversation(source);
  const before = structuredClone(history);
  const second = capture();
  await collect(createOpenAIModel({ apiKey: "raw-private-key", env: {}, ...second }).stream({ messages: history }));
  expect(replayed(second)).toEqual([item]);
  expectOrdinaryHistory(second);
  expect(history).toEqual(before);
});

test("Responses continuation excludes another provider even at the same endpoint and with the same key", async () => {
  const first = capture(emitted);
  const source = await outputOf(createOpenAIModel({ apiKey: "shared-key", baseUrl: "https://gateway.test/v1", env: {}, ...first }));
  const second = capture();
  await collect(createCodexApiModel({ apiKey: "shared-key", baseUrl: "https://gateway.test/v1", env: {}, ...second }).stream({ messages: conversation(source) }));
  expect(replayed(second)).toEqual([]);
  expectOrdinaryHistory(second);
});

test("gateway continuation excludes changed endpoint or API key while preserving text and tools", async () => {
  const first = capture(emitted);
  const source = await outputOf(createCodexApiModel({ apiKey: "gateway-key", baseUrl: "https://one.test/v1", env: {}, ...first }));
  for (const connection of [
    { apiKey: "gateway-key", baseUrl: "https://two.test/v1" },
    { apiKey: "different-key", baseUrl: "https://one.test/v1" },
  ]) {
    const next = capture();
    const history = conversation(source);
    await collect(createCodexApiModel({ ...connection, env: {}, ...next }).stream({ messages: history }));
    expect(replayed(next)).toEqual([]);
    expectOrdinaryHistory(next);
    expect(history[0]?.parts[0]).toMatchObject({ modelOutput: source });
  }
});

test("Responses scope follows the effective authorization header instead of an overridden API key", async () => {
  const first = capture(emitted);
  const source = await outputOf(createOpenAIModel({ apiKey: "configured-one", headers: { Authorization: "Bearer actual-key" }, env: {}, ...first }));
  for (const [authorization, expected] of [["Bearer actual-key", [item]], ["Bearer replaced-key", []]] as const) {
    const next = capture();
    await collect(createOpenAIModel({ apiKey: "configured-two", headers: { Authorization: authorization }, env: {}, ...next }).stream({ messages: conversation(source) }));
    expect(replayed(next)).toEqual([...expected]);
  }
});

test("ChatGPT OAuth refresh keeps continuation scoped to its stable account, and switching accounts drops it", async () => {
  const storage = new MemoryOAuthStorage(credentials("account-one", "initial", Date.now() + 3600_000));
  const initial = capture(emitted);
  const source = await outputOf(createOpenAICodexModel({ authStorage: storage, ...initial }));
  expect(JSON.stringify(source.source)).not.toContain("account-one");

  storage.credential = credentials("account-one", "initial", Date.now() - 1);
  const next = capture();
  let refreshes = 0;
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url) === OPENAI_CODEX_TOKEN_URL) {
      refreshes++;
      return new Response(JSON.stringify({ access_token: jwt("account-one", "refreshed"), refresh_token: "rotated-refresh", expires_in: 3600 }), { headers: { "content-type": "application/json" } });
    }
    return next.fetch(url, init);
  }) as typeof fetch;
  await collect(createOpenAICodexModel({ authStorage: storage, ...next, fetch: fetchImpl }).stream({ messages: conversation(source) }));
  expect(refreshes).toBe(1);
  expect(replayed(next)).toEqual([item]);
  expect(storage.credential.access).toBe(jwt("account-one", "refreshed"));

  storage.credential = credentials("account-two", "other", Date.now() + 3600_000);
  const switched = capture();
  await collect(createOpenAICodexModel({ authStorage: storage, ...switched }).stream({ messages: conversation(source) }));
  expect(replayed(switched)).toEqual([]);
  expectOrdinaryHistory(switched);
});

test("legacy unscoped ciphertext stays supported only by the two existing Codex modes", async () => {
  const unscoped: PersistedModelOutput = { apiFamily: "openai-responses", item };
  const official = capture();
  await collect(createOpenAIModel({ apiKey: "key", env: {}, ...official }).stream({ messages: conversation(unscoped) }));
  expect(replayed(official)).toEqual([]);
  expectOrdinaryHistory(official);

  const gateway = capture();
  await collect(createCodexApiModel({ apiKey: "key", baseUrl: "https://gateway.test/v1", env: {}, ...gateway }).stream({ messages: conversation(unscoped) }));
  expect(replayed(gateway)).toEqual([item]);

  const chatgpt = capture();
  const storage = new MemoryOAuthStorage(credentials("account", "current", Date.now() + 3600_000));
  await collect(createOpenAICodexModel({ authStorage: storage, ...chatgpt }).stream({ messages: conversation(unscoped) }));
  expect(replayed(chatgpt)).toEqual([item]);
});

test("Responses excludes foreign protocol opaque items even when their source matches the connection", async () => {
  const first = capture(emitted);
  const source = await outputOf(createOpenAIModel({ apiKey: "key", env: {}, ...first }));
  const foreign = { ...source, apiFamily: "anthropic-messages", item: { provider: "anthropic", block: { type: "thinking", thinking: "private", signature: "foreign-signature" } } };
  const next = capture();
  await collect(createOpenAIModel({ apiKey: "key", env: {}, ...next }).stream({ messages: conversation(foreign) }));
  expect(replayed(next)).toEqual([]);
  expect(JSON.stringify(next.requests)).not.toContain("foreign-signature");
  expectOrdinaryHistory(next);
});

function capture(events: unknown[] = [completed]) {
  const requests: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { requests, fetch: fetchImpl, backpressureCoordinator: new ProviderBackpressureCoordinator() };
}

function replayed(transport: ReturnType<typeof capture>) {
  return (transport.requests.at(-1)?.input as Array<Record<string, unknown>>).filter((entry) => entry.type === "reasoning");
}

function expectOrdinaryHistory(transport: ReturnType<typeof capture>) {
  expect(transport.requests.at(-1)?.input).toEqual(expect.arrayContaining([
    { role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Visible answer." }] },
    { type: "function_call", call_id: "provider-call", name: "read", arguments: '{"path":"file.ts"}' },
    { type: "function_call_output", call_id: "provider-call", output: "file contents" },
  ]));
}

function conversation(output: PersistedModelOutput): Message[] {
  return [
    { id: "assistant", sessionId: "session", role: "assistant", createdAt: 1, parts: [
      { id: "opaque", messageId: "assistant", sessionId: "session", type: "reasoning", text: "", modelOutput: output },
      { id: "text", messageId: "assistant", sessionId: "session", type: "text", text: "Visible answer.", phase: "final_answer" },
      { id: "call", messageId: "assistant", sessionId: "session", type: "tool_call", callId: "internal-call", providerCallId: "provider-call", toolName: "read", input: { path: "file.ts" }, status: "completed" },
    ] },
    { id: "result", sessionId: "session", role: "tool", createdAt: 2, parts: [
      { id: "result-part", messageId: "result", sessionId: "session", type: "tool_result", callId: "internal-call", providerCallId: "provider-call", output: "file contents" },
    ] },
  ] as Message[];
}

async function outputOf(model: ChiliModel): Promise<PersistedModelOutput> {
  const events = await collect(model.stream({ messages: [] }));
  const output = events.find((event) => event.type === "reasoning_item");
  if (output?.type !== "reasoning_item") throw new Error("Missing emitted reasoning item");
  return output.output;
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function jwt(accountId: string, version: string): string {
  return [Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"), Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId }, jti: version })).toString("base64url"), "signature"].join(".");
}

function credentials(accountId: string, version: string, expires: number): OAuthCredential {
  return { type: "oauth", accountId, access: jwt(accountId, version), refresh: "refresh-token", expires };
}

class MemoryOAuthStorage extends FileAuthStorage {
  constructor(public credential: OAuthCredential) { super(`/tmp/chili-provenance-test-${Math.random()}.json`); }
  override async getOAuthCredentials(): Promise<OAuthCredential | undefined> { return this.credential; }
  override async claimOAuthRefresh(): Promise<"claimed"> { return "claimed"; }
  override async releaseOAuthRefresh(): Promise<void> {}
  override async commitOAuthRefresh(_provider: string, expected: OAuthCredential, refreshed: OAuthCredentials): Promise<boolean> {
    if (this.credential !== expected) return false;
    this.credential = { type: "oauth", ...refreshed };
    return true;
  }
}
