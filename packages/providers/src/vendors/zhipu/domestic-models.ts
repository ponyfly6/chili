import type { ModelDescriptor } from "../../types.js";

export const ZHIPU_PROVIDER_ID = "zhipu";
export const ZHIPU_GLM_53_MODEL = "glm-5.3";
export const ZHIPU_GLM_53_FLASH_MODEL = "glm-5.3-flash";
export const ZHIPU_GLM_53_FLASHX_MODEL = "glm-5.3-flashx";
export const ZHIPU_OPENAI_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const ZHIPU_CODING_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";

/** Domestic BigModel API catalog. Prices and credentials are separate from Z.ai. */
export const ZHIPU_MODELS = [
  { model: ZHIPU_GLM_53_MODEL, displayName: "GLM-5.3", input: 8, output: 28, cacheRead: 2 },
  { model: ZHIPU_GLM_53_FLASH_MODEL, displayName: "GLM-5.3 Flash", input: 0.8, output: 2.8, cacheRead: 0.23 },
  { model: ZHIPU_GLM_53_FLASHX_MODEL, displayName: "GLM-5.3 FlashX", input: 2, output: 7, cacheRead: 0.57 },
].map(({ model, displayName, input, output, cacheRead }): ModelDescriptor => ({
  provider: ZHIPU_PROVIDER_ID,
  model,
  displayName,
  apiFamily: "openai-completions",
  baseUrl: ZHIPU_OPENAI_BASE_URL,
  ...(model === ZHIPU_GLM_53_MODEL ? { default: true } : {}),
  inputCapabilities: model === ZHIPU_GLM_53_MODEL ? ["text"] : ["text", "image"],
  contextWindowTokens: 1000000,
  maxOutputTokens: 131072,
  reasoningLevels: ["low", "high", "max"],
  cost: {
    currency: "CNY",
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    notes: "BigModel domestic pay-as-you-go API rates; cached-input storage is temporarily free. Coding Plan quotas are billed separately.",
  },
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
        off: "low", minimal: "low", low: "low", medium: "high",
        high: "high", xhigh: "max", max: "max", ultra: "max",
      },
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
      reasoningParameterStyle: "zai-5.3",
      toolCallDeltaMode: "zai-tool-stream",
    },
  },
}));
