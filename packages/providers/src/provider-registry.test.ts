import { expect, test } from "bun:test";
import { FileAuthStorage, type OAuthCredential } from "./auth/storage.js";
import { getProviderDisplayName } from "./catalog.js";
import { findDefaultKnownModel, listKnownModels } from "./models.js";
import { BUILTIN_PROVIDERS, isBuiltinProviderId, resolveBuiltinProviderId, type BuiltinProviderId } from "./provider-definition.js";
import { createRegisteredProviderModel, resolveProviderModelOptions } from "./provider-registry.js";

const DEFAULT_PROTOCOLS = {
  minimax: "openai-responses",
  deepseek: "openai-responses",
  kimi: "openai-responses",
  zai: "openai-completions",
  xai: "openai-responses",
  "openai-codex": "openai-responses",
  "codex-api": "openai-responses",
  alibaba: "openai-responses",
  doubao: "openai-responses",
  anthropic: "anthropic-messages",
  zhipu: "openai-completions",
  openai: "openai-responses",
} satisfies Record<BuiltinProviderId, string>;

class TestAuth extends FileAuthStorage {
  private readonly credential: OAuthCredential = { type: "oauth", access: "fake-oauth-access", refresh: "fake-refresh", accountId: "registry-account", expires: Date.now() + 3_600_000 };
  constructor() { super("/unused-registry-test-auth.json"); }
  override async getOAuthCredentials(): Promise<OAuthCredential> {
    return this.credential;
  }
}

for (const provider of Object.keys(BUILTIN_PROVIDERS) as BuiltinProviderId[]) {
  test(`registered ${provider} sends its default model through the expected protocol`, async () => {
    let sent: Record<string, unknown> | undefined;
    let url = "";
    let authorization: string | null = null;
    let apiKeyHeader: string | null = null;
    const definition = BUILTIN_PROVIDERS[provider];
    const descriptor = findDefaultKnownModel(provider);
    expect(descriptor?.apiFamily).toBe(DEFAULT_PROTOCOLS[provider]);
    const options = resolveProviderModelOptions(provider, {
      env: {}, authStorage: new TestAuth(),
      ...(definition.auth === "api_key" ? { apiKey: "fake-registry-key", baseUrl: "https://registry.invalid/v1" } : {}),
      fetch: (async (target, init) => {
        url = String(target);
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        authorization = new Headers(init?.headers).get("authorization");
        apiKeyHeader = new Headers(init?.headers).get("x-api-key");
        if (descriptor?.apiFamily === "openai-responses") {
          return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "response_registry", status: "completed", model: options.model } })}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (descriptor?.apiFamily === "anthropic-messages") return Response.json({ id: "message_registry", type: "message", role: "assistant", model: options.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
        return Response.json({ id: "completion_registry", model: options.model, choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }] });
      }) as typeof fetch,
    });
    const model = createRegisteredProviderModel(provider, options);
    const events = [];
    for await (const event of model.stream({ messages: [] })) events.push(event);
    expect(sent?.model).toBe(findDefaultKnownModel(provider)?.model);
    expect(model.provider).toBe(provider);
    expect(events.at(-1)?.type).toBe("finish");
    expect(sent?.stream).toBe(true);
    if (DEFAULT_PROTOCOLS[provider] === "openai-responses") {
      expect(url).toBe(definition.auth === "oauth"
        ? "https://chatgpt.com/backend-api/codex/responses"
        : "https://registry.invalid/v1/responses");
      expect(sent?.input).toEqual([]);
      expect(sent).not.toHaveProperty("messages");
      expect(sent).not.toHaveProperty("max_tokens");
      expect(sent).not.toHaveProperty("max_completion_tokens");
      if (definition.auth === "api_key") expect(sent?.max_output_tokens).toBe(options.maxTokens);
      else expect(sent).not.toHaveProperty("max_output_tokens");
    } else {
      expect(url).toBe(DEFAULT_PROTOCOLS[provider] === "anthropic-messages"
        ? "https://registry.invalid/v1/messages"
        : "https://registry.invalid/v1/chat/completions");
      expect(sent?.messages).toEqual([]);
      expect(sent?.max_tokens).toBe(options.maxTokens);
      expect(sent).not.toHaveProperty("input");
      expect(sent).not.toHaveProperty("max_output_tokens");
    }
    if (provider === "anthropic") {
      expect<string | null>(apiKeyHeader).toBe("fake-registry-key");
      expect<string | null>(authorization).toBeNull();
    } else {
      expect<string | null>(authorization).toBe(definition.auth === "oauth" ? "Bearer fake-oauth-access" : "Bearer fake-registry-key");
    }
    expect(getProviderDisplayName(provider)).toBe(definition.displayName);
    for (const alias of [provider, ...definition.aliases]) expect(resolveBuiltinProviderId(` ${alias.toUpperCase()} `)).toBe(provider);
  });
}

test("registered model defaults fit verified output limits", () => {
  for (const descriptor of listKnownModels()) {
    const provider = descriptor.provider;
    if (!isBuiltinProviderId(provider)) continue;
    const options = resolveProviderModelOptions(provider, { model: descriptor.model, env: {} });
    if (descriptor.maxOutputTokens !== undefined) {
      expect(options.maxTokens).toBeLessThanOrEqual(descriptor.maxOutputTokens);
    }
  }
});

test("unknown deployments use a conservative request allowance without inheriting metadata", () => {
  for (const provider of ["alibaba", "doubao"] as const) {
    const options = resolveProviderModelOptions(provider, { model: "ep-custom-deployment", env: {} });
    expect(options.maxTokens).toBe(4096);
    expect(resolveProviderModelOptions(provider, { model: "ep-custom-deployment", maxTokens: 8192, env: {} }).maxTokens).toBe(8192);
  }
});

test("resolved attempts use an isolated provider environment snapshot and explicit options win", async () => {
  const env = { DEEPSEEK_MODEL: "deepseek-v4-flash", DEEPSEEK_API_KEY: "snapshot-key", DEEPSEEK_BASE_URL: "https://snapshot.invalid/responses", KIMI_API_KEY: "unrelated-secret" };
  const headers = { "x-request-owner": "original" };
  let url = "";
  let sentHeaders = new Headers();
  let body: Record<string, unknown> = {};
  const options = resolveProviderModelOptions("deepseek", {
    env, headers, model: "deepseek-v4-pro", maxTokens: 4096,
    fetch: (async (target, init) => {
      url = String(target); sentHeaders = new Headers(init?.headers); body = JSON.parse(String(init?.body));
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "response_snapshot", status: "completed", model: "deepseek-v4-pro" } })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch,
  }, { reasoningLevel: "off" });
  env.DEEPSEEK_API_KEY = "later-key";
  env.DEEPSEEK_BASE_URL = "https://later.invalid";
  headers["x-request-owner"] = "later";
  for await (const _ of createRegisteredProviderModel("deepseek", options).stream({ messages: [] })) { /* consume */ }
  expect(options.env).not.toHaveProperty("KIMI_API_KEY");
  expect(url).toBe("https://snapshot.invalid/responses");
  expect(sentHeaders.get("authorization")).toBe("Bearer snapshot-key");
  expect(sentHeaders.get("x-request-owner")).toBe("original");
  expect(body).toMatchObject({ model: "deepseek-v4-pro", max_output_tokens: 4096, reasoning: { effort: "none" } });
  expect(body).not.toHaveProperty("max_tokens");
  expect(body).not.toHaveProperty("thinking");
});

test("registry keeps environment credential provenance so API mode rejects legacy OAuth tokens", () => {
  const token = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } })).toString("base64url")}.signature`;
  const options = resolveProviderModelOptions("codex-api", { env: {
    OPENAI_CODEX_ACCESS_TOKEN: token, OPENAI_CODEX_BASE_URL: "https://legacy.invalid/v1",
  } });
  expect(() => createRegisteredProviderModel("codex-api", options)).toThrow("looks like a ChatGPT OAuth token");
});

test("OAuth registration rejects API connection overrides and ignores API environment settings", () => {
  expect(() => resolveProviderModelOptions("openai-codex", { apiKey: "api-key", env: {} })).toThrow("OAuth-only");
  expect(() => resolveProviderModelOptions("openai-codex", { baseUrl: "https://wrong.invalid", env: {} })).toThrow("OAuth-only");
  const resolved = resolveProviderModelOptions("openai-codex", { env: { OPENAI_CODEX_MODEL: "not-a-model", OPENAI_CODEX_ACCESS_TOKEN: "not-oauth", CODEX_API_KEY: "api-key" } });
  expect(resolved.env).toEqual({});
  expect<string | undefined>(resolved.model).toBe(findDefaultKnownModel("openai-codex")?.model);
  expect(resolveBuiltinProviderId("constructor")).toBeUndefined();
  expect(resolveBuiltinProviderId("__proto__")).toBeUndefined();
});
