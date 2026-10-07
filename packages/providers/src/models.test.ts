import { expect, test } from "bun:test";
import {
  assertCodexApiModel,
  assertOpenAICodexModel,
  canonicalizeCodexApiModel,
  canonicalizeOpenAICodexModel,
  CODEX_API_DEFAULT_MODEL,
  CODEX_API_MODELS,
  CODEX_API_PROVIDER_ID,
  DEEPSEEK_OPENAI_BASE_URL,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_V4_FLASH_MODEL,
  DEEPSEEK_V4_PRO_MODEL,
  findDefaultKnownModel,
  findKnownModel,
  isCodexApiModel,
  isOpenAICodexModel,
  KIMI_K3_MODEL,
  KIMI_K27_CODE_MODEL,
  KIMI_K27_CODE_HIGHSPEED_MODEL,
  KIMI_OPENAI_BASE_URL,
  KIMI_PROVIDER_ID,
  listKnownModels,
  MINIMAX_ANTHROPIC_BASE_URL,
  MINIMAX_M3_MODEL,
  MINIMAX_M31_FLASH_PREVIEW_MODEL,
  MINIMAX_PROVIDER_ID,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_MODELS,
  OPENAI_CODEX_PROVIDER_ID,
  XAI_GROK_46_MODEL,
  XAI_GROK_47_MODEL,
  XAI_OPENAI_BASE_URL,
  XAI_PROVIDER_ID,
  ZAI_ANTHROPIC_BASE_URL,
  ZAI_GLM_53_1M_MODEL,
  ZAI_GLM_53_MODEL,
  ZAI_GLM_53_FLASH_MODEL,
  ZAI_GLM_53_FLASHX_MODEL,
  ZAI_OPENAI_BASE_URL,
  ZAI_PROVIDER_ID,
} from "./index.js";

const FULL_CAPABILITIES = {
  streaming: true,
  reasoning: true,
  toolCalls: true,
  toolCallDeltas: true,
  usage: true,
  responseId: true,
};

test("catalog exposes current DeepSeek Pro and Flash, retaining the legacy Flash alias with their current limits", () => {
  expect(listKnownModels(DEEPSEEK_PROVIDER_ID).map((model) => model.model)).toEqual([
    DEEPSEEK_V4_PRO_MODEL,
    DEEPSEEK_FLASH_MODEL,
    DEEPSEEK_V4_FLASH_MODEL,
  ]);
  expect(findDefaultKnownModel(DEEPSEEK_PROVIDER_ID)).toMatchObject({
    provider: DEEPSEEK_PROVIDER_ID,
    model: DEEPSEEK_V4_PRO_MODEL,
    displayName: "DeepSeek V4 Pro (0813)",
    apiFamily: "openai-completions",
    baseUrl: DEEPSEEK_OPENAI_BASE_URL,
    default: true,
    inputCapabilities: ["text"],
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 393_216,
    reasoningLevels: ["off", "low", "high", "max"],
    capabilities: FULL_CAPABILITIES,
    compatibility: {
      chatCompletions: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        reasoningEffortMap: {
          off: "low",
          minimal: "low",
          low: "low",
          medium: "high",
          high: "high",
          xhigh: "high",
          max: "max",
          ultra: "max",
        },
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        reasoningParameterStyle: "deepseek",
        toolCallDeltaMode: "standard",
      },
    },
  });
  expect(findKnownModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_V4_FLASH_MODEL)).toMatchObject({
    model: DEEPSEEK_V4_FLASH_MODEL,
    displayName: "DeepSeek V4.1 Flash (legacy alias)",
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 393_216,
    reasoningLevels: ["off", "low", "high", "max"],
  });
  expect(findKnownModel(DEEPSEEK_PROVIDER_ID, "deepseek-v3.2")).toBeUndefined();
});

test("catalog exposes Kimi K3 and K2.7 Code with image input and current token limits", () => {
  expect(listKnownModels(KIMI_PROVIDER_ID).map((model) => model.model)).toEqual([KIMI_K3_MODEL, KIMI_K27_CODE_MODEL, KIMI_K27_CODE_HIGHSPEED_MODEL]);
  expect(findDefaultKnownModel(KIMI_PROVIDER_ID)).toMatchObject({
    provider: KIMI_PROVIDER_ID,
    model: KIMI_K3_MODEL,
    displayName: "Kimi K3",
    apiFamily: "openai-completions",
    baseUrl: KIMI_OPENAI_BASE_URL,
    default: true,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 1_048_576,
    reasoningLevels: ["low", "high", "max"],
    capabilities: FULL_CAPABILITIES,
    compatibility: {
      chatCompletions: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        reasoningEffortMap: {
          off: "low",
          minimal: "low",
          low: "low",
          medium: "high",
          high: "high",
          xhigh: "max",
          max: "max",
          ultra: "max",
        },
        supportsUsageInStreaming: true,
        maxTokensField: "max_completion_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        reasoningParameterStyle: "moonshot-k3",
        toolCallDeltaMode: "standard",
      },
    },
  });
  expect(findKnownModel(KIMI_PROVIDER_ID, "kimi-k2.6")).toBeUndefined();
});

test("catalog exposes GLM-5.3 and its Anthropic protocol alias", () => {
  expect(listKnownModels(ZAI_PROVIDER_ID).map((model) => model.model)).toEqual([
    ZAI_GLM_53_MODEL,
    ZAI_GLM_53_FLASH_MODEL,
    ZAI_GLM_53_FLASHX_MODEL,
    ZAI_GLM_53_1M_MODEL,
  ]);
  expect(findDefaultKnownModel(ZAI_PROVIDER_ID)).toMatchObject({
    provider: ZAI_PROVIDER_ID,
    model: ZAI_GLM_53_MODEL,
    displayName: "GLM-5.3",
    apiFamily: "openai-completions",
    baseUrl: ZAI_OPENAI_BASE_URL,
    default: true,
    inputCapabilities: ["text"],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 131_072,
    reasoningLevels: ["low", "high", "max"],
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    capabilities: FULL_CAPABILITIES,
    compatibility: {
      chatCompletions: {
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        reasoningParameterStyle: "zai-5.3",
        toolCallDeltaMode: "zai-tool-stream",
      },
    },
  });
  expect(findKnownModel(ZAI_PROVIDER_ID, ZAI_GLM_53_1M_MODEL)).toMatchObject({
    provider: ZAI_PROVIDER_ID,
    model: ZAI_GLM_53_1M_MODEL,
    displayName: "GLM-5.3 1M",
    apiFamily: "anthropic-messages",
    baseUrl: ZAI_ANTHROPIC_BASE_URL,
    inputCapabilities: ["text"],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 131_072,
    reasoningLevels: [],
    capabilities: FULL_CAPABILITIES,
    compatibility: { messages: { supportsEagerToolInputStreaming: true } },
  });
  expect(findKnownModel(ZAI_PROVIDER_ID, "glm-5.2")).toBeUndefined();
  expect(findKnownModel(ZAI_PROVIDER_ID, "glm-5.2[1m]")).toBeUndefined();
});

test("catalog keeps MiniMax M3 as the default alongside its plan-only preview with current reasoning, tier, and pricing metadata", () => {
  expect(listKnownModels(MINIMAX_PROVIDER_ID).map((model) => model.model)).toEqual([MINIMAX_M3_MODEL, MINIMAX_M31_FLASH_PREVIEW_MODEL]);
  expect(findDefaultKnownModel(MINIMAX_PROVIDER_ID)).toMatchObject({
    provider: MINIMAX_PROVIDER_ID,
    model: MINIMAX_M3_MODEL,
    displayName: "MiniMax M3",
    apiFamily: "anthropic-messages",
    baseUrl: MINIMAX_ANTHROPIC_BASE_URL,
    default: true,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 524_288,
    reasoningLevels: ["off", "high"],
    serviceTiers: ["standard", "fast"],
    cost: { input: 2.1, output: 8.4, cacheRead: 0.42, cacheWrite: 0, currency: "CNY" },
    capabilities: FULL_CAPABILITIES,
    compatibility: { messages: { supportsEagerToolInputStreaming: true } },
  });
  for (const unlisted of ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M3[1m]"]) {
    expect(findKnownModel(MINIMAX_PROVIDER_ID, unlisted)).toBeUndefined();
  }
});

test("catalog defaults to xAI Grok 4.7 and retains explicit 4.6 selections with current limits, reasoning, and pricing", () => {
  expect(listKnownModels(XAI_PROVIDER_ID).map((model) => model.model)).toEqual([XAI_GROK_47_MODEL, XAI_GROK_46_MODEL]);
  const grok = findDefaultKnownModel(XAI_PROVIDER_ID);
  expect(grok).toMatchObject({
    provider: XAI_PROVIDER_ID,
    model: XAI_GROK_47_MODEL,
    displayName: "Grok 4.7",
    apiFamily: "openai-completions",
    baseUrl: XAI_OPENAI_BASE_URL,
    default: true,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 500_000,
    reasoningLevels: ["low", "medium", "high", "xhigh"],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    capabilities: FULL_CAPABILITIES,
    compatibility: {
      chatCompletions: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        reasoningEffortMap: {
          off: "low",
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "xhigh",
          ultra: "xhigh",
        },
        supportsUsageInStreaming: true,
        maxTokensField: "max_completion_tokens",
        requiresReasoningContentOnAssistantMessages: false,
        reasoningParameterStyle: "xai",
        toolCallDeltaMode: "standard",
      },
    },
  });
  expect(grok).not.toHaveProperty("maxOutputTokens");
  expect(findKnownModel(XAI_PROVIDER_ID, "grok-4.1-fast-reasoning")).toBeUndefined();
});

test("catalog lookups deep-clone nested compatibility maps", () => {
  const first = findKnownModel(XAI_PROVIDER_ID, XAI_GROK_46_MODEL);
  const chatCompletions = first?.compatibility?.chatCompletions;
  expect(chatCompletions).toBeDefined();
  if (!chatCompletions) throw new Error("Grok descriptor is missing Chat Completions compatibility");
  const reasoningEffortMap = chatCompletions.reasoningEffortMap;
  if (!reasoningEffortMap) throw new Error("Grok descriptor is missing its reasoning effort map");
  reasoningEffortMap.high = "mutated";

  const fresh = findKnownModel(XAI_PROVIDER_ID, XAI_GROK_46_MODEL);
  expect(fresh?.compatibility?.chatCompletions?.reasoningEffortMap?.high).toBe("high");
});

test("ChatGPT and Codex API catalogs offer GPT-6 models and retain GPT-5.6 selections", () => {
  const expectedModels: Array<(typeof OPENAI_CODEX_MODELS)[number]> = [
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ];
  expect([...OPENAI_CODEX_MODELS]).toEqual(expectedModels);
  expect([...CODEX_API_MODELS]).toEqual(expectedModels);
  expect(listKnownModels(OPENAI_CODEX_PROVIDER_ID).map((model) => model.model)).toEqual(expectedModels);
  expect(listKnownModels(CODEX_API_PROVIDER_ID).map((model) => model.model)).toEqual(expectedModels);

  expect(findDefaultKnownModel(OPENAI_CODEX_PROVIDER_ID)).toMatchObject({
    provider: OPENAI_CODEX_PROVIDER_ID,
    model: OPENAI_CODEX_DEFAULT_MODEL,
    displayName: "GPT-6.1 Sol",
    apiFamily: "openai-responses",
    baseUrl: OPENAI_CODEX_BASE_URL,
    default: true,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    serviceTiers: ["standard", "fast"],
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    capabilities: FULL_CAPABILITIES,
  });
  expect(findKnownModel(OPENAI_CODEX_PROVIDER_ID, "gpt-6-astra")).toMatchObject({
    displayName: "GPT-6 Astra",
    reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  });
  expect(findKnownModel(OPENAI_CODEX_PROVIDER_ID, "gpt-6-luna")).toMatchObject({
    displayName: "GPT-6 Luna",
    reasoningLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  });
  expect(findKnownModel(OPENAI_CODEX_PROVIDER_ID, "gpt-6-sol")).toMatchObject({
    displayName: "GPT-6 Sol",
    reasoningLevels: ["off", "low", "medium", "high", "xhigh", "max", "ultra"],
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  });
  expect(findKnownModel(OPENAI_CODEX_PROVIDER_ID, "gpt-5.6-terra")).toMatchObject({
    displayName: "GPT-5.6 Terra",
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  });
  expect(findKnownModel(OPENAI_CODEX_PROVIDER_ID, "gpt-5.6-luna")).toMatchObject({
    displayName: "GPT-5.6 Luna",
    reasoningLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  });
  expect(findDefaultKnownModel(CODEX_API_PROVIDER_ID)).toMatchObject({
    provider: CODEX_API_PROVIDER_ID,
    model: CODEX_API_DEFAULT_MODEL,
    apiFamily: "openai-responses",
    default: true,
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
  });
  expect(findDefaultKnownModel(CODEX_API_PROVIDER_ID)).not.toHaveProperty("baseUrl");

  expect(findKnownModel(OPENAI_CODEX_PROVIDER_ID, "gpt-5.5")).toBeUndefined();
  expect(findKnownModel(CODEX_API_PROVIDER_ID, "gpt-5.4")).toBeUndefined();
});

test("gpt-5.6 is accepted only as an alias and canonicalizes to GPT-5.6 Sol", () => {
  expect(isOpenAICodexModel("gpt-5.6")).toBe(true);
  expect(isCodexApiModel("gpt-5.6")).toBe(true);
  expect(canonicalizeOpenAICodexModel("gpt-5.6")).toBe("gpt-5.6-sol");
  expect(canonicalizeCodexApiModel("gpt-5.6")).toBe("gpt-5.6-sol");
  expect(findKnownModel(OPENAI_CODEX_PROVIDER_ID, "gpt-5.6")).toBeUndefined();
  expect(findKnownModel(CODEX_API_PROVIDER_ID, "gpt-5.6")).toBeUndefined();

  expect(isOpenAICodexModel("gpt-5.5")).toBe(false);
  expect(isCodexApiModel("gpt-5.5")).toBe(false);
  expect(() => assertOpenAICodexModel("gpt-5.5")).toThrow(
    'Unsupported OpenAI Codex model "gpt-5.5"',
  );
  expect(() => assertCodexApiModel("gpt-5.5")).toThrow(
    'Unsupported Codex API model "gpt-5.5"',
  );
});
