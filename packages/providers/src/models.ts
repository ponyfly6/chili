import type { ModelCost, ModelDescriptor } from "./types.js";

export const MINIMAX_PROVIDER_ID = "minimax";
export const MINIMAX_M3_MODEL = "MiniMax-M3[1m]";
export const MINIMAX_M27_MODEL = "MiniMax-M2.7";
export const MINIMAX_M27_HIGHSPEED_MODEL = "MiniMax-M2.7-highspeed";
export const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DEEPSEEK_V4_PRO_MODEL = "deepseek-v4-pro";
export const DEEPSEEK_V4_FLASH_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_OPENAI_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
export const KIMI_PROVIDER_ID = "kimi";
export const KIMI_K26_MODEL = "kimi-k2.6";
export const KIMI_OPENAI_BASE_URL = "https://api.moonshot.cn/v1";
export const ZAI_PROVIDER_ID = "zai";
export const ZAI_GLM_52_MODEL = "glm-5.2";
export const ZAI_GLM_52_1M_MODEL = "glm-5.2[1m]";
export const ZAI_OPENAI_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const OPENAI_CODEX_DEFAULT_MODEL = "gpt-5.6-sol";
export const OPENAI_CODEX_MODELS = [
  "gpt-5.5",
  OPENAI_CODEX_DEFAULT_MODEL,
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
export type OpenAICodexModel = (typeof OPENAI_CODEX_MODELS)[number];
export const CODEX_API_PROVIDER_ID = "codex-api";
export const CODEX_API_DEFAULT_MODEL = OPENAI_CODEX_DEFAULT_MODEL;
export const CODEX_API_MODELS = [...OPENAI_CODEX_MODELS] as const;
export type CodexApiModel = (typeof CODEX_API_MODELS)[number];

export function isOpenAICodexModel(model: string): model is OpenAICodexModel {
  return (OPENAI_CODEX_MODELS as readonly string[]).includes(model);
}

export function assertOpenAICodexModel(model: string): asserts model is OpenAICodexModel {
  if (isOpenAICodexModel(model)) return;
  throw new Error(
    `Unsupported OpenAI Codex model "${model}". Supported models: ${OPENAI_CODEX_MODELS.join(", ")}`,
  );
}

export function isCodexApiModel(model: string): model is CodexApiModel {
  return (CODEX_API_MODELS as readonly string[]).includes(model);
}

export function assertCodexApiModel(model: string): asserts model is CodexApiModel {
  if (isCodexApiModel(model)) return;
  throw new Error(
    `Unsupported Codex API model "${model}". Supported models: ${CODEX_API_MODELS.join(", ")}`,
  );
}

const OPENAI_CODEX_MODEL_COSTS = {
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
  "gpt-5.6-luna": { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
} satisfies Record<(typeof OPENAI_CODEX_MODELS)[number], ModelCost>;

const BUILTIN_MODELS = [
  {
    provider: DEEPSEEK_PROVIDER_ID,
    model: DEEPSEEK_V4_PRO_MODEL,
    displayName: "DeepSeek V4 Pro",
    apiFamily: "openai-completions",
    baseUrl: DEEPSEEK_OPENAI_BASE_URL,
    default: true,
    inputCapabilities: ["text"],
    contextWindowTokens: 1048576,
    maxOutputTokens: 393216,
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
          minimal: "high",
          low: "high",
          medium: "high",
          high: "high",
          xhigh: "max",
        },
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        reasoningParameterStyle: "deepseek",
        toolCallDeltaMode: "standard",
      },
    },
  },
  {
    provider: DEEPSEEK_PROVIDER_ID,
    model: DEEPSEEK_V4_FLASH_MODEL,
    displayName: "DeepSeek V4 Flash",
    apiFamily: "openai-completions",
    baseUrl: DEEPSEEK_OPENAI_BASE_URL,
    inputCapabilities: ["text"],
    contextWindowTokens: 1048576,
    maxOutputTokens: 393216,
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
          minimal: "high",
          low: "high",
          medium: "high",
          high: "high",
          xhigh: "max",
        },
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        reasoningParameterStyle: "deepseek",
        toolCallDeltaMode: "standard",
      },
    },
  },
  {
    provider: KIMI_PROVIDER_ID,
    model: KIMI_K26_MODEL,
    displayName: "Kimi K2.6",
    apiFamily: "openai-completions",
    baseUrl: KIMI_OPENAI_BASE_URL,
    default: true,
    inputCapabilities: ["text"],
    contextWindowTokens: 256000,
    maxOutputTokens: 32768,
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
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        reasoningParameterStyle: "moonshot",
        toolCallDeltaMode: "standard",
      },
    },
  },
  {
    provider: ZAI_PROVIDER_ID,
    model: ZAI_GLM_52_MODEL,
    displayName: "GLM-5.2",
    apiFamily: "openai-completions",
    baseUrl: ZAI_OPENAI_BASE_URL,
    default: true,
    inputCapabilities: ["text"],
    contextWindowTokens: 1000000,
    maxOutputTokens: 131072,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
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
          minimal: "high",
          low: "high",
          medium: "high",
          high: "high",
          xhigh: "max",
        },
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        reasoningParameterStyle: "zai",
        toolCallDeltaMode: "zai-tool-stream",
      },
    },
  },
  {
    provider: ZAI_PROVIDER_ID,
    model: ZAI_GLM_52_1M_MODEL,
    displayName: "GLM-5.2 1M",
    apiFamily: "anthropic-messages",
    baseUrl: ZAI_ANTHROPIC_BASE_URL,
    inputCapabilities: ["text"],
    contextWindowTokens: 1000000,
    maxOutputTokens: 131072,
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
    displayName: "MiniMax M3 1M",
    apiFamily: "anthropic-messages",
    baseUrl: MINIMAX_ANTHROPIC_BASE_URL,
    default: true,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1000000,
    maxOutputTokens: 32768,
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
    model: MINIMAX_M27_HIGHSPEED_MODEL,
    displayName: MINIMAX_M27_HIGHSPEED_MODEL,
    apiFamily: "anthropic-messages",
    baseUrl: MINIMAX_ANTHROPIC_BASE_URL,
    inputCapabilities: ["text"],
    contextWindowTokens: 204800,
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
    model: MINIMAX_M27_MODEL,
    displayName: MINIMAX_M27_MODEL,
    apiFamily: "anthropic-messages",
    baseUrl: MINIMAX_ANTHROPIC_BASE_URL,
    inputCapabilities: ["text"],
    contextWindowTokens: 204800,
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
        ? { chatCompletions: { ...model.compatibility.chatCompletions } }
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
  const isGpt56 = model.startsWith("gpt-5.6-");
  return {
    provider,
    model,
    displayName: openAICodexDisplayName(model),
    apiFamily: "openai-responses",
    ...(baseUrl ? { baseUrl } : {}),
    default: model === OPENAI_CODEX_DEFAULT_MODEL,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: isGpt56 ? 1050000 : 272000,
    maxOutputTokens: 128000,
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
