import type { ModelCost, ModelDescriptor } from "./types.js";

export const MINIMAX_PROVIDER_ID = "minimax";
export const MINIMAX_M3_MODEL = "MiniMax-M3";
export const MINIMAX_M31_FLASH_PREVIEW_MODEL = "MiniMax-M3.1-Flash-Preview";
export const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DEEPSEEK_V4_PRO_MODEL = "deepseek-v4-pro";
export const DEEPSEEK_FLASH_MODEL = "deepseek-flash";
/** Legacy API name; the provider now serves V4.1 Flash for this selection. */
export const DEEPSEEK_V4_FLASH_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_OPENAI_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
export const KIMI_PROVIDER_ID = "kimi";
export const KIMI_K3_MODEL = "kimi-k3";
export const KIMI_K27_CODE_MODEL = "kimi-k2.7-code";
export const KIMI_K27_CODE_HIGHSPEED_MODEL = "kimi-k2.7-code-highspeed";
export const KIMI_OPENAI_BASE_URL = "https://api.moonshot.cn/v1";
export const ZAI_PROVIDER_ID = "zai";
export const ZAI_GLM_53_MODEL = "glm-5.3";
export const ZAI_GLM_53_FLASH_MODEL = "glm-5.3-flash";
export const ZAI_GLM_53_FLASHX_MODEL = "glm-5.3-flashx";
export const ZAI_GLM_53_1M_MODEL = "glm-5.3[1m]";
export const ZAI_OPENAI_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
export const XAI_PROVIDER_ID = "xai";
export const XAI_GROK_46_MODEL = "grok-4.6";
export const XAI_GROK_47_MODEL = "grok-4.7";
export const XAI_OPENAI_BASE_URL = "https://api.x.ai/v1";
export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const OPENAI_CODEX_DEFAULT_MODEL = "gpt-6.1-sol";
export const OPENAI_CODEX_MODELS = [
  OPENAI_CODEX_DEFAULT_MODEL,
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
export const OPENAI_CODEX_MODEL_ALIASES = ["gpt-5.6"] as const;
export type OpenAICodexCanonicalModel = (typeof OPENAI_CODEX_MODELS)[number];
export type OpenAICodexModelAlias = (typeof OPENAI_CODEX_MODEL_ALIASES)[number];
export type OpenAICodexModel = OpenAICodexCanonicalModel | OpenAICodexModelAlias;
export const CODEX_API_PROVIDER_ID = "codex-api";
export const CODEX_API_DEFAULT_MODEL = OPENAI_CODEX_DEFAULT_MODEL;
export const CODEX_API_MODELS = [...OPENAI_CODEX_MODELS] as const;
export type CodexApiCanonicalModel = (typeof CODEX_API_MODELS)[number];
export type CodexApiModel = CodexApiCanonicalModel | OpenAICodexModelAlias;

export function isOpenAICodexModel(model: string): model is OpenAICodexModel {
  return (OPENAI_CODEX_MODELS as readonly string[]).includes(model)
    || (OPENAI_CODEX_MODEL_ALIASES as readonly string[]).includes(model);
}

export function assertOpenAICodexModel(model: string): asserts model is OpenAICodexModel {
  if (isOpenAICodexModel(model)) return;
  throw new Error(
    `Unsupported OpenAI Codex model "${model}". Supported models: ${[
      ...OPENAI_CODEX_MODELS,
      ...OPENAI_CODEX_MODEL_ALIASES,
    ].join(", ")}`,
  );
}

export function isCodexApiModel(model: string): model is CodexApiModel {
  return (CODEX_API_MODELS as readonly string[]).includes(model)
    || (OPENAI_CODEX_MODEL_ALIASES as readonly string[]).includes(model);
}

export function assertCodexApiModel(model: string): asserts model is CodexApiModel {
  if (isCodexApiModel(model)) return;
  throw new Error(
    `Unsupported Codex API model "${model}". Supported models: ${[
      ...CODEX_API_MODELS,
      ...OPENAI_CODEX_MODEL_ALIASES,
    ].join(", ")}`,
  );
}

export function canonicalizeOpenAICodexModel(model: string): OpenAICodexCanonicalModel {
  assertOpenAICodexModel(model);
  return model === "gpt-5.6" ? "gpt-5.6-sol" : model;
}

export function canonicalizeCodexApiModel(model: string): CodexApiCanonicalModel {
  assertCodexApiModel(model);
  return model === "gpt-5.6" ? "gpt-5.6-sol" : model;
}

const OPENAI_CODEX_MODEL_COSTS = {
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
} satisfies Record<(typeof OPENAI_CODEX_MODELS)[number], ModelCost>;

const BUILTIN_MODELS = [
  {
    provider: DEEPSEEK_PROVIDER_ID,
    model: DEEPSEEK_V4_PRO_MODEL,
    displayName: "DeepSeek V4 Pro (0813)",
    apiFamily: "openai-completions",
    baseUrl: DEEPSEEK_OPENAI_BASE_URL,
    default: true,
    inputCapabilities: ["text"],
    contextWindowTokens: 1048576,
    maxOutputTokens: 393216,
    reasoningLevels: ["off", "low", "high", "max"],
    cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0, notes: "USD peak rates; off-peak rates are 50%." },
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
      usage: true,
      responseId: true,
    },
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
  },
  ...[DEEPSEEK_FLASH_MODEL, DEEPSEEK_V4_FLASH_MODEL].map((model): ModelDescriptor => ({
    provider: DEEPSEEK_PROVIDER_ID,
    model,
    displayName: model === DEEPSEEK_FLASH_MODEL ? "DeepSeek V4.1 Flash" : "DeepSeek V4.1 Flash (legacy alias)",
    apiFamily: "openai-completions",
    baseUrl: DEEPSEEK_OPENAI_BASE_URL,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1048576,
    maxOutputTokens: 393216,
    reasoningLevels: ["off", "low", "high", "max"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0, notes: "USD peak rates; off-peak rates are 50%." },
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
      usage: true,
      responseId: true,
    },
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
  })),
  {
    provider: KIMI_PROVIDER_ID,
    model: KIMI_K3_MODEL,
    displayName: "Kimi K3",
    apiFamily: "openai-completions",
    baseUrl: KIMI_OPENAI_BASE_URL,
    default: true,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1048576,
    maxOutputTokens: 1048576,
    cost: { input: 20, output: 100, cacheRead: 2, cacheWrite: 20, currency: "CNY", notes: "Moonshot CN; cache write uses the default 5m TTL. 1h TTL costs CNY 40/MTok." },
    reasoningLevels: ["low", "high", "max"],
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
      usage: true,
      responseId: true,
    },
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
  },
  ...[KIMI_K27_CODE_MODEL, KIMI_K27_CODE_HIGHSPEED_MODEL].map((model): ModelDescriptor => ({
    provider: KIMI_PROVIDER_ID,
    model,
    displayName: model === KIMI_K27_CODE_MODEL ? "Kimi K2.7 Code" : "Kimi K2.7 Code Highspeed",
    apiFamily: "openai-completions",
    baseUrl: KIMI_OPENAI_BASE_URL,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 262144,
    reasoningLevels: ["high"],
    cost: model === KIMI_K27_CODE_MODEL
      ? { input: 6.5, output: 27, cacheRead: 1.3, cacheWrite: 0, currency: "CNY", notes: "Moonshot CN; no separate cache-write rate listed for K2.7." }
      : { input: 13, output: 54, cacheRead: 2.6, cacheWrite: 0, currency: "CNY", notes: "Moonshot CN; no separate cache-write rate listed for K2.7." },
    capabilities: { streaming: true, reasoning: true, toolCalls: true, toolCallDeltas: true, usage: true, responseId: true },
    compatibility: {
      chatCompletions: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        maxTokensField: "max_completion_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        reasoningParameterStyle: "moonshot-k2.7",
        toolCallDeltaMode: "standard",
      },
    },
  })),
  ...[
    { model: ZAI_GLM_53_MODEL, displayName: "GLM-5.3", input: 1.4, output: 4.4, cacheRead: 0.26 },
    { model: ZAI_GLM_53_FLASH_MODEL, displayName: "GLM-5.3 Flash", input: 0.15, output: 0.5, cacheRead: 0.03 },
    { model: ZAI_GLM_53_FLASHX_MODEL, displayName: "GLM-5.3 FlashX", input: 0.37, output: 1.25, cacheRead: 0.075 },
  ].map(({ model, displayName, input, output, cacheRead }): ModelDescriptor => ({
    provider: ZAI_PROVIDER_ID,
    model,
    displayName,
    apiFamily: "openai-completions",
    baseUrl: ZAI_OPENAI_BASE_URL,
    ...(model === ZAI_GLM_53_MODEL ? { default: true } : {}),
    inputCapabilities: model === ZAI_GLM_53_MODEL ? ["text"] : ["text", "image"],
    contextWindowTokens: 1000000,
    maxOutputTokens: 131072,
    reasoningLevels: ["low", "high", "max"],
    cost: { input, output, cacheRead, cacheWrite: 0, notes: "Z.ai USD rates; cached-input storage is temporarily free." },
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
      usage: true,
      responseId: true,
    },
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
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        reasoningParameterStyle: "zai-5.3",
        toolCallDeltaMode: "zai-tool-stream",
      },
    },
  })),
  {
    provider: ZAI_PROVIDER_ID,
    model: ZAI_GLM_53_1M_MODEL,
    displayName: "GLM-5.3 1M",
    apiFamily: "anthropic-messages",
    baseUrl: ZAI_ANTHROPIC_BASE_URL,
    inputCapabilities: ["text"],
    contextWindowTokens: 1000000,
    maxOutputTokens: 131072,
    reasoningLevels: [],
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
      usage: true,
      responseId: true,
    },
    compatibility: {
      messages: {
        supportsEagerToolInputStreaming: true,
      },
    },
  },
  {
    provider: MINIMAX_PROVIDER_ID,
    model: MINIMAX_M3_MODEL,
    displayName: "MiniMax M3",
    apiFamily: "anthropic-messages",
    baseUrl: MINIMAX_ANTHROPIC_BASE_URL,
    default: true,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1000000,
    maxOutputTokens: 524288,
    reasoningLevels: ["off", "high"],
    serviceTiers: ["standard", "fast"],
    cost: { input: 2.1, output: 8.4, cacheRead: 0.42, cacheWrite: 0, currency: "CNY", notes: "MiniMax CN standard tier, input <=512K. Longer inputs cost 2x; priority costs 1.5x." },
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
      usage: true,
      responseId: true,
    },
    compatibility: {
      messages: {
        supportsEagerToolInputStreaming: true,
      },
    },
  },
  {
    provider: MINIMAX_PROVIDER_ID,
    model: MINIMAX_M31_FLASH_PREVIEW_MODEL,
    displayName: "MiniMax M3.1 Flash Preview (M Plan)",
    apiFamily: "anthropic-messages",
    baseUrl: MINIMAX_ANTHROPIC_BASE_URL,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1000000,
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    capabilities: { streaming: true, reasoning: true, toolCalls: true, toolCallDeltas: true, usage: true, responseId: true },
    compatibility: {
      messages: { supportsEagerToolInputStreaming: true, supportsAdaptiveReasoningEffort: true },
    },
  },
  ...[XAI_GROK_47_MODEL, XAI_GROK_46_MODEL].map((model): ModelDescriptor => ({
    provider: XAI_PROVIDER_ID,
    model,
    displayName: model === XAI_GROK_47_MODEL ? "Grok 4.7" : "Grok 4.6",
    apiFamily: "openai-completions",
    baseUrl: XAI_OPENAI_BASE_URL,
    ...(model === XAI_GROK_47_MODEL ? { default: true } : {}),
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 500000,
    reasoningLevels: ["low", "medium", "high", "xhigh"],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0, notes: "USD standard tier below 200K prompt tokens; long-context rates are 2x." },
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
      usage: true,
      responseId: true,
    },
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
  })),
  ...OPENAI_CODEX_MODELS.map((model) => codexModelDescriptor(OPENAI_CODEX_PROVIDER_ID, model, OPENAI_CODEX_BASE_URL)),
  ...CODEX_API_MODELS.map((model) => codexModelDescriptor(CODEX_API_PROVIDER_ID, model)),
] satisfies readonly ModelDescriptor[];

const knownModels = new Map<string, Map<string, ModelDescriptor>>();

registerKnownModels(BUILTIN_MODELS);

export function registerKnownModels(models: readonly ModelDescriptor[]): void {
  for (const model of models) {
    const providerModels = knownModels.get(model.provider) ?? new Map<string, ModelDescriptor>();
    providerModels.set(model.model, cloneModelDescriptor(model));
    knownModels.set(model.provider, providerModels);
  }
}

export function listKnownModels(provider?: string): readonly ModelDescriptor[] {
  if (provider) {
    return Array.from(knownModels.get(provider)?.values() ?? [], cloneModelDescriptor);
  }
  return Array.from(knownModels.values()).flatMap((models) => Array.from(models.values(), cloneModelDescriptor));
}

export function findKnownModel(provider: string, model: string): ModelDescriptor | undefined {
  const descriptor = knownModels.get(provider)?.get(model);
  return descriptor ? cloneModelDescriptor(descriptor) : undefined;
}

export function findDefaultKnownModel(provider: string): ModelDescriptor | undefined {
  const providerModels = knownModels.get(provider);
  const descriptor = Array.from(providerModels?.values() ?? []).find((model) => model.default) ?? providerModels?.values().next().value;
  return descriptor ? cloneModelDescriptor(descriptor) : undefined;
}

function cloneModelDescriptor(model: ModelDescriptor): ModelDescriptor {
  const clone: ModelDescriptor = { ...model };
  if (model.capabilities) clone.capabilities = { ...model.capabilities };
  if (model.compatibility) {
    clone.compatibility = {
      ...(model.compatibility.messages
        ? { messages: { ...model.compatibility.messages } }
        : {}),
      ...(model.compatibility.chatCompletions
        ? {
            chatCompletions: {
              ...model.compatibility.chatCompletions,
              reasoningEffortMap: {
                ...model.compatibility.chatCompletions.reasoningEffortMap,
              },
            },
          }
        : {}),
      ...(model.compatibility.responses ? { responses: { ...model.compatibility.responses } } : {}),
    };
  }
  if (model.inputCapabilities) clone.inputCapabilities = [...model.inputCapabilities];
  if (model.reasoningLevels) clone.reasoningLevels = [...model.reasoningLevels];
  if (model.serviceTiers) clone.serviceTiers = [...model.serviceTiers];
  if (model.cost) clone.cost = { ...model.cost };
  return clone;
}

function openAICodexDisplayName(model: string): string {
  const match = /^gpt-(\d+(?:\.\d+)?)(?:-(.*))?$/.exec(model);
  if (!match) return model;
  const suffix = match[2]
    ?.split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return suffix ? `GPT-${match[1]} ${suffix}` : `GPT-${match[1]}`;
}

function codexModelDescriptor(
  provider: typeof OPENAI_CODEX_PROVIDER_ID | typeof CODEX_API_PROVIDER_ID,
  model: (typeof OPENAI_CODEX_MODELS)[number],
  baseUrl?: string,
): ModelDescriptor {
  const reasoningLevels = model === "gpt-6.1-sol" || model === "gpt-6-astra"
    ? ["low", "medium", "high", "xhigh", "max", "ultra"] as const
    : model.endsWith("-luna")
      ? ["off", "low", "medium", "high", "xhigh", "max"] as const
      : ["off", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
  return {
    provider,
    model,
    displayName: openAICodexDisplayName(model),
    apiFamily: "openai-responses",
    ...(baseUrl ? { baseUrl } : {}),
    default: model === OPENAI_CODEX_DEFAULT_MODEL,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
    reasoningLevels,
    serviceTiers: ["standard", "fast"],
    cost: OPENAI_CODEX_MODEL_COSTS[model],
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
      usage: true,
      responseId: true,
    },
  };
}
