import type { ModelDescriptor } from "../../types.js";

export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DEEPSEEK_V4_PRO_MODEL = "deepseek-v4-pro";
export const DEEPSEEK_FLASH_MODEL = "deepseek-flash";
/** Legacy API name; the provider now serves V4.1 Flash for this selection. */
export const DEEPSEEK_V4_FLASH_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_OPENAI_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";

export const DEEPSEEK_MODELS = [
  {
    provider: DEEPSEEK_PROVIDER_ID,
    model: DEEPSEEK_V4_PRO_MODEL,
    displayName: "DeepSeek V4 Pro (0813)",
    apiFamily: "openai-responses",
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
      responses: {
        sendSessionIdHeader: false,
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
      },
    },
  },
  ...[DEEPSEEK_FLASH_MODEL, DEEPSEEK_V4_FLASH_MODEL].map((model): ModelDescriptor => ({
    provider: DEEPSEEK_PROVIDER_ID,
    model,
    displayName: model === DEEPSEEK_FLASH_MODEL ? "DeepSeek V4.1 Flash" : "DeepSeek V4.1 Flash (legacy alias)",
    apiFamily: "openai-responses",
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
      responses: {
        sendSessionIdHeader: false,
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
      },
    },
  })),
] satisfies readonly ModelDescriptor[];
