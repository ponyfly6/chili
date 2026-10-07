import type { ModelDescriptor } from "../../types.js";

export const KIMI_PROVIDER_ID = "kimi";
export const KIMI_K3_MODEL = "kimi-k3";
export const KIMI_K27_CODE_MODEL = "kimi-k2.7-code";
export const KIMI_K27_CODE_HIGHSPEED_MODEL = "kimi-k2.7-code-highspeed";
export const KIMI_OPENAI_BASE_URL = "https://api.moonshot.cn/v1";

export const KIMI_MODELS = [
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
] satisfies readonly ModelDescriptor[];
