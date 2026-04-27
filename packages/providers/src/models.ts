import type { ModelDescriptor } from "./types.js";

export const MINIMAX_PROVIDER_ID = "minimax";
export const MINIMAX_M27_MODEL = "MiniMax-M2.7";
export const MINIMAX_M27_HIGHSPEED_MODEL = "MiniMax-M2.7-highspeed";
export const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DEEPSEEK_V4_PRO_MODEL = "deepseek-v4-pro";
export const DEEPSEEK_V4_FLASH_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_OPENAI_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";

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
  return clone;
}
