import type { ModelDescriptor } from "../../types.js";

export const ZAI_PROVIDER_ID = "zai";
export const ZAI_GLM_53_MODEL = "glm-5.3";
export const ZAI_GLM_53_FLASH_MODEL = "glm-5.3-flash";
export const ZAI_GLM_53_FLASHX_MODEL = "glm-5.3-flashx";
export const ZAI_GLM_53_1M_MODEL = "glm-5.3[1m]";
export const ZAI_OPENAI_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";

export const ZAI_MODELS = [
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
] satisfies readonly ModelDescriptor[];
