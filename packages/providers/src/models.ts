import type { ModelCost, ModelDescriptor } from "./types.js";

export const MINIMAX_PROVIDER_ID = "minimax";
export const MINIMAX_M27_MODEL = "MiniMax-M2.7";
export const MINIMAX_M27_HIGHSPEED_MODEL = "MiniMax-M2.7-highspeed";
export const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DEEPSEEK_V4_PRO_MODEL = "deepseek-v4-pro";
export const DEEPSEEK_V4_FLASH_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_OPENAI_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const OPENAI_CODEX_DEFAULT_MODEL = "gpt-5.5";
export const OPENAI_CODEX_MODELS = [
  "gpt-5.1",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  OPENAI_CODEX_DEFAULT_MODEL,
] as const;

const OPENAI_CODEX_MODEL_COSTS = {
  "gpt-5.1": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex-max": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex-spark": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
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
    provider: MINIMAX_PROVIDER_ID,
    model: MINIMAX_M27_HIGHSPEED_MODEL,
    displayName: MINIMAX_M27_HIGHSPEED_MODEL,
    apiFamily: "anthropic-messages",
    baseUrl: MINIMAX_ANTHROPIC_BASE_URL,
    default: true,
    inputCapabilities: ["text"],
    contextWindowTokens: 204800,
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
    model: MINIMAX_M27_MODEL,
    displayName: MINIMAX_M27_MODEL,
    apiFamily: "anthropic-messages",
    baseUrl: MINIMAX_ANTHROPIC_BASE_URL,
    inputCapabilities: ["text"],
    contextWindowTokens: 204800,
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
  ...OPENAI_CODEX_MODELS.map(openAICodexModelDescriptor),
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

function openAICodexModelDescriptor(model: (typeof OPENAI_CODEX_MODELS)[number]): ModelDescriptor {
  return {
    provider: OPENAI_CODEX_PROVIDER_ID,
    model,
    displayName: openAICodexDisplayName(model),
    apiFamily: "openai-responses",
    baseUrl: OPENAI_CODEX_BASE_URL,
    default: model === OPENAI_CODEX_DEFAULT_MODEL,
    inputCapabilities: model === "gpt-5.3-codex-spark" ? ["text"] : ["text", "image"],
    contextWindowTokens: model === "gpt-5.3-codex-spark" ? 128000 : 272000,
    maxOutputTokens: 128000,
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
