import type { ChatCompletionsCompatibility } from "../../protocols/compat.js";
import type { ModelDescriptor } from "../../types.js";

export const ALIBABA_PROVIDER_ID = "alibaba";
export const ALIBABA_OPENAI_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const QWEN_38_MAX_MODEL = "qwen3.8-max";
export const QWEN_38_MAX_0902_MODEL = "qwen3.8-max-0902";
export const QWEN_38_FLASH_MODEL = "qwen3.8-flash";

export const ALIBABA_QWEN_COMPATIBILITY = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  reasoningEffortMap: {
    minimal: "low", low: "low", medium: "medium", high: "xhigh",
    xhigh: "xhigh", max: "xhigh", ultra: "xhigh",
  },
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  requiresReasoningContentOnAssistantMessages: true,
  reasoningParameterStyle: "qwen",
  toolCallDeltaMode: "standard",
} satisfies ChatCompletionsCompatibility;

/** Verified against Alibaba's official model/API pages on 2026-10-07; see README. */
export const ALIBABA_MODELS = [
  ...([
    [QWEN_38_MAX_MODEL, "Qwen 3.8 Max"],
    [QWEN_38_MAX_0902_MODEL, "Qwen 3.8 Max (0902)"],
    [QWEN_38_FLASH_MODEL, "Qwen 3.8 Flash"],
  ] as const).map(([model, displayName]): ModelDescriptor => ({
    provider: ALIBABA_PROVIDER_ID,
    model,
    displayName,
    apiFamily: "openai-completions",
    baseUrl: ALIBABA_OPENAI_BASE_URL,
    ...(model === QWEN_38_MAX_MODEL ? { default: true } : {}),
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 131072,
    reasoningLevels: ["off", "low", "medium", "xhigh"],
    capabilities: {
      streaming: true, reasoning: true, toolCalls: true, toolCallDeltas: true,
      usage: true, responseId: true,
    },
    compatibility: { chatCompletions: ALIBABA_QWEN_COMPATIBILITY },
    cost: model === QWEN_38_FLASH_MODEL
      ? { currency: "CNY", input: 0.8, output: 2.7, cacheRead: 0.1, cacheWrite: 1.25,
          notes: "Beijing standard online rates; cacheRead is implicit caching, cacheWrite is explicit cache creation. Regional, batch and plan pricing differ." }
      : { currency: "CNY", input: 12, output: 36, cacheRead: 1.5, cacheWrite: 15,
          notes: "Beijing standard online rates; cacheRead is implicit caching, explicit cache reads cost CNY 1/M tokens. cacheWrite is explicit cache creation. Regional, batch and plan pricing differ." },
  })),
] satisfies readonly ModelDescriptor[];
