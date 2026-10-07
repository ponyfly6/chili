import { expect, test } from "bun:test";
import {
  CODEX_API_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_V4_PRO_MODEL,
  getModelSelectionAvailableReasoningLevels,
  getProviderCatalogStatus,
  KIMI_K3_MODEL,
  KIMI_PROVIDER_ID,
  listKnownModels,
  listModelCatalog,
  MINIMAX_M3_MODEL,
  MINIMAX_PROVIDER_ID,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID,
  parseModelSelectionPattern,
  resolveModelSelectionPattern,
  supportsMaxReasoning,
  supportsUltraReasoning,
  supportsXHighReasoning,
  XAI_GROK_46_MODEL,
  XAI_PROVIDER_ID,
  ZAI_GLM_53_1M_MODEL,
  ZAI_GLM_53_MODEL,
  ZAI_PROVIDER_ID,
} from "./index.js";
import type { ModelDescriptor } from "./types.js";

test("parses current provider/model patterns and optional reasoning suffixes", () => {
  expect(parseModelSelectionPattern("openai-codex/gpt-6.1-sol:ultra")).toEqual({
    provider: OPENAI_CODEX_PROVIDER_ID,
    model: OPENAI_CODEX_DEFAULT_MODEL,
    reasoning: "ultra",
    thinking: "ultra",
  });
  expect(parseModelSelectionPattern("xai/grok-4.6:xhigh")).toEqual({
    provider: XAI_PROVIDER_ID,
    model: XAI_GROK_46_MODEL,
    reasoning: "xhigh",
    thinking: "xhigh",
  });
  expect(parseModelSelectionPattern("gpt-5.6:low")).toEqual({
    model: "gpt-5.6",
    reasoning: "low",
    thinking: "low",
  });
  expect(parseModelSelectionPattern("zai/glm-5.3[1m]")).toEqual({
    provider: ZAI_PROVIDER_ID,
    model: ZAI_GLM_53_1M_MODEL,
  });
  expect(parseModelSelectionPattern("amazon-bedrock/amazon.nova-lite-v1:0")).toEqual({
    provider: "amazon-bedrock",
    model: "amazon.nova-lite-v1:0",
  });
});

test("reasoning capability inference recognizes only the current advanced families", () => {
  expect(supportsXHighReasoning(OPENAI_CODEX_DEFAULT_MODEL)).toBe(true);
  expect(supportsMaxReasoning("gpt-6.1-sol")).toBe(true);
  expect(supportsUltraReasoning("gpt-6-astra")).toBe(true);
  expect(supportsUltraReasoning("gpt-6-sol")).toBe(true);
  expect(supportsUltraReasoning("gpt-6-luna")).toBe(false);
  expect(supportsXHighReasoning(XAI_GROK_46_MODEL)).toBe(true);
  expect(supportsMaxReasoning(DEEPSEEK_V4_PRO_MODEL)).toBe(true);
  expect(supportsMaxReasoning(KIMI_K3_MODEL)).toBe(true);
  expect(supportsMaxReasoning(ZAI_GLM_53_MODEL)).toBe(true);
  expect(supportsUltraReasoning("gpt-5.6-terra")).toBe(true);
  expect(supportsUltraReasoning("gpt-5.6-luna")).toBe(false);

  expect(supportsXHighReasoning("gpt-5.5")).toBe(false);
  expect(supportsMaxReasoning("deepseek-v3.2")).toBe(false);
  expect(supportsMaxReasoning("kimi-k2.6")).toBe(false);
  expect(supportsMaxReasoning("glm-5.2")).toBe(false);
});

test("catalog descriptors define the exact selectable reasoning levels", () => {
  const model = (provider: string, id: string) =>
    listKnownModels(provider).find((descriptor) => descriptor.model === id);

  expect(getModelSelectionAvailableReasoningLevels(model(DEEPSEEK_PROVIDER_ID, DEEPSEEK_V4_PRO_MODEL))).toEqual([
    "off",
    "low",
    "high",
    "max",
  ]);
  expect(getModelSelectionAvailableReasoningLevels(model(KIMI_PROVIDER_ID, KIMI_K3_MODEL))).toEqual([
    "low",
    "high",
    "max",
  ]);
  expect(getModelSelectionAvailableReasoningLevels(model(ZAI_PROVIDER_ID, ZAI_GLM_53_MODEL))).toEqual([
    "low",
    "high",
    "max",
  ]);
  expect(getModelSelectionAvailableReasoningLevels(model(ZAI_PROVIDER_ID, ZAI_GLM_53_1M_MODEL))).toEqual([]);
  expect(getModelSelectionAvailableReasoningLevels(model(MINIMAX_PROVIDER_ID, MINIMAX_M3_MODEL))).toEqual([
    "off",
    "high",
  ]);
  expect(getModelSelectionAvailableReasoningLevels(model(XAI_PROVIDER_ID, XAI_GROK_46_MODEL))).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  expect(getModelSelectionAvailableReasoningLevels(model(OPENAI_CODEX_PROVIDER_ID, OPENAI_CODEX_DEFAULT_MODEL))).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  expect(getModelSelectionAvailableReasoningLevels(model(OPENAI_CODEX_PROVIDER_ID, "gpt-5.6-luna"))).toEqual([
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("resolves current catalog models and clamps reasoning to each model contract", () => {
  const models = listKnownModels();

  expect(resolveModelSelectionPattern("deepseek/deepseek-v4-pro:ultra", models)).toMatchObject({
    selection: { provider: DEEPSEEK_PROVIDER_ID, model: DEEPSEEK_V4_PRO_MODEL, reasoning: "max", thinking: "max" },
  });
  expect(resolveModelSelectionPattern("kimi/kimi-k3:off", models)).toMatchObject({
    selection: { provider: KIMI_PROVIDER_ID, model: KIMI_K3_MODEL, reasoning: "low", thinking: "low" },
  });
  expect(resolveModelSelectionPattern("zai/glm-5.3:max", models)).toMatchObject({
    selection: { provider: ZAI_PROVIDER_ID, model: ZAI_GLM_53_MODEL, reasoning: "max", thinking: "max" },
  });
  expect(resolveModelSelectionPattern("minimax/MiniMax-M3:max", models)).toMatchObject({
    selection: { provider: MINIMAX_PROVIDER_ID, model: MINIMAX_M3_MODEL, reasoning: "high", thinking: "high" },
  });
  expect(resolveModelSelectionPattern("xai/grok-4.6:max", models)).toMatchObject({
    selection: { provider: XAI_PROVIDER_ID, model: XAI_GROK_46_MODEL, reasoning: "xhigh", thinking: "xhigh" },
  });
  expect(resolveModelSelectionPattern("openai-codex/gpt-6.1-sol:ultra", models)).toMatchObject({
    selection: {
      provider: OPENAI_CODEX_PROVIDER_ID,
      model: OPENAI_CODEX_DEFAULT_MODEL,
      reasoning: "ultra",
      thinking: "ultra",
    },
  });
});

test("GPT-6 selection clamps unsupported reasoning in both Codex providers", () => {
  const models = listKnownModels();
  for (const provider of [OPENAI_CODEX_PROVIDER_ID, CODEX_API_PROVIDER_ID]) {
    for (const model of ["gpt-6.1-sol", "gpt-6-astra"]) {
      expect(resolveModelSelectionPattern(`${provider}/${model}:off`, models)).toMatchObject({
        selection: { provider, model, reasoning: "low", thinking: "low" },
      });
      expect(getModelSelectionAvailableReasoningLevels({ provider, model })).not.toContain("off");
    }
    expect(resolveModelSelectionPattern(`${provider}/gpt-6-luna:ultra`, models)).toMatchObject({
      selection: { provider, model: "gpt-6-luna", reasoning: "max", thinking: "max" },
    });
    expect(resolveModelSelectionPattern(`${provider}/gpt-6-luna:off`, models)).toMatchObject({
      selection: { provider, model: "gpt-6-luna", reasoning: "off", thinking: "off" },
    });
  }
});

test("selection canonicalizes the gpt-5.6 alias for both Codex providers", () => {
  const models = [
    ...listKnownModels(OPENAI_CODEX_PROVIDER_ID),
    ...listKnownModels(CODEX_API_PROVIDER_ID),
  ];

  expect(resolveModelSelectionPattern("openai-codex/gpt-5.6:ultra", models)).toMatchObject({
    selection: {
      provider: OPENAI_CODEX_PROVIDER_ID,
      model: "gpt-5.6-sol",
      reasoning: "ultra",
      thinking: "ultra",
    },
  });
  expect(resolveModelSelectionPattern("codex-api/gpt-5.6:max", models)).toMatchObject({
    selection: {
      provider: CODEX_API_PROVIDER_ID,
      model: "gpt-5.6-sol",
      reasoning: "max",
      thinking: "max",
    },
  });
  expect(resolveModelSelectionPattern("gpt-5.6", models)).toEqual({});
  expect(resolveModelSelectionPattern("gpt-5.6", models, {
    defaultProvider: CODEX_API_PROVIDER_ID,
  })).toMatchObject({
    selection: { provider: CODEX_API_PROVIDER_ID, model: "gpt-5.6-sol" },
  });
});

test("official OpenAI selection canonicalizes the GPT alias independently of ChatGPT", () => {
  const models = listKnownModels("openai");
  expect(resolveModelSelectionPattern("openai/gpt-5.6:high", models)).toMatchObject({
    selection: { provider: "openai", model: "gpt-5.6-sol", reasoning: "high" },
  });
  expect(resolveModelSelectionPattern("gpt-5.6", models, { defaultProvider: "openai" })).toMatchObject({
    selection: { provider: "openai", model: "gpt-5.6-sol" },
  });
});

test("retired model IDs do not resolve from the built-in catalog", () => {
  const models = listKnownModels();
  for (const retired of [
    "openai-codex/gpt-5.5",
    "deepseek/deepseek-v3.2",
    "kimi/kimi-k2.6",
    "zai/glm-5.2",
    "minimax/MiniMax-M2.7",
    "xai/grok-4.1-fast-reasoning",
  ]) {
    expect(resolveModelSelectionPattern(retired, models, { allowFuzzy: false })).toEqual({});
  }
});

test("catalog exposes configured GLM-5.3 protocol variants", () => {
  const catalog = listModelCatalog(ZAI_PROVIDER_ID, { env: { ZAI_API_KEY: "token" } });
  expect(catalog.find((model) => model.model === ZAI_GLM_53_MODEL)).toMatchObject({
    provider: ZAI_PROVIDER_ID,
    model: ZAI_GLM_53_MODEL,
    displayName: "GLM-5.3",
    providerDisplayName: "Z.ai",
    apiFamily: "openai-completions",
    available: true,
  });
  expect(catalog.find((model) => model.model === ZAI_GLM_53_1M_MODEL)).toMatchObject({
    displayName: "GLM-5.3 1M",
    apiFamily: "anthropic-messages",
    available: true,
  });
});

test("catalog exposes configured xAI Grok with a sanitized endpoint", () => {
  const catalog = listModelCatalog(XAI_PROVIDER_ID, {
    env: {
      XAI_API_KEY: "token",
      XAI_BASE_URL: "https://user:secret@gateway.x.ai:8443/v1?token=hidden",
      XAI_MODEL: XAI_GROK_46_MODEL,
    },
  });
  expect(catalog).toHaveLength(2);
  expect(catalog.find((entry) => entry.model === XAI_GROK_46_MODEL)).toMatchObject({
    provider: XAI_PROVIDER_ID,
    model: XAI_GROK_46_MODEL,
    displayName: "Grok 4.6",
    providerDisplayName: "xAI",
    available: true,
    authSource: "environment",
    endpoint: "https://gateway.x.ai:8443",
  });
  expect(JSON.stringify(catalog)).not.toContain("secret");
  expect(JSON.stringify(catalog)).not.toContain("hidden");
});

test("catalog exposes ChatGPT auth state and current GPT-6.1 metadata", () => {
  const status = getProviderCatalogStatus(OPENAI_CODEX_PROVIDER_ID, {
    authStatus: {
      configured: true,
      authPath: "/tmp/auth.json",
      type: "oauth",
      accountId: "acct_test",
    },
  });
  expect(status).toMatchObject({
    provider: OPENAI_CODEX_PROVIDER_ID,
    displayName: "ChatGPT",
    configured: true,
    available: true,
    authSource: "oauth",
    endpoint: "https://chatgpt.com",
  });

  const catalog = listModelCatalog(OPENAI_CODEX_PROVIDER_ID, {
    authStatus: { configured: true, authPath: "/tmp/auth.json", type: "oauth" },
  });
  expect(catalog.map((model) => model.model)).toEqual([
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
  expect(catalog[0]).toMatchObject({
    providerDisplayName: "ChatGPT",
    displayName: "GPT-6.1 Sol",
    available: true,
    authSource: "oauth",
    endpoint: "https://chatgpt.com",
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  });
});

test("Codex API catalog requires a complete environment configuration", () => {
  const status = getProviderCatalogStatus(CODEX_API_PROVIDER_ID, {
    env: {
      CODEX_API_KEY: "token",
      CODEX_API_BASE_URL: "https://user:secret@gateway.test:8443/v1?token=hidden",
      CODEX_API_MODEL: OPENAI_CODEX_DEFAULT_MODEL,
    },
  });
  expect(status).toMatchObject({
    provider: CODEX_API_PROVIDER_ID,
    displayName: "Api",
    configured: true,
    available: true,
    authSource: "environment",
    endpoint: "https://gateway.test:8443",
  });
  expect(JSON.stringify(status)).not.toContain("secret");
  expect(JSON.stringify(status)).not.toContain("hidden");

  for (const env of [
    { CODEX_API_BASE_URL: "https://gateway.test/v1" },
    { CODEX_API_KEY: "key-without-base-url" },
    { CODEX_API_KEY: "key", CODEX_API_BASE_URL: "not-a-url" },
    { CODEX_API_KEY: "key", CODEX_API_BASE_URL: "ftp://gateway.test/v1" },
  ]) {
    expect(getProviderCatalogStatus(CODEX_API_PROVIDER_ID, { env })).toMatchObject({
      configured: false,
      available: false,
      authSource: "none",
    });
  }
});

test("Codex providers reject stored auth from the other authentication mode", () => {
  expect(getProviderCatalogStatus(OPENAI_CODEX_PROVIDER_ID, {
    authStatus: { configured: true, authPath: "/tmp/auth.json", type: "api_key" },
  })).toMatchObject({ configured: false, available: false, authSource: "none" });
  expect(getProviderCatalogStatus(CODEX_API_PROVIDER_ID, {
    authStatus: { configured: true, authPath: "/tmp/auth.json", type: "oauth" },
  })).toMatchObject({ configured: false, available: false, authSource: "none" });
});

test("custom model selection remains opt-in", () => {
  const models: ModelDescriptor[] = [
    {
      provider: "custom-provider",
      model: "current-model",
      capabilities: { streaming: true, reasoning: true },
    },
  ];
  expect(resolveModelSelectionPattern("custom-provider/unlisted-model", models)).toEqual({});
  expect(resolveModelSelectionPattern("custom-provider/unlisted-model:high", models, {
    allowCustomModel: true,
  })).toMatchObject({
    selection: {
      provider: "custom-provider",
      model: "unlisted-model",
      reasoning: "high",
      thinking: "high",
    },
    warning: expect.stringContaining("custom model id"),
  });
});
