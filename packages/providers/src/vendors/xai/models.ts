import type { ModelDescriptor } from "../../types.js";

export const XAI_PROVIDER_ID = "xai";
export const XAI_GROK_46_MODEL = "grok-4.6";
export const XAI_GROK_47_MODEL = "grok-4.7";
export const XAI_OPENAI_BASE_URL = "https://api.x.ai/v1";

export const XAI_REASONING_EFFORT_MAP = {
  off: "low", minimal: "low", low: "low", medium: "medium", high: "high",
  xhigh: "xhigh", max: "xhigh", ultra: "xhigh",
} as const;

export const XAI_MODELS = [
  ...[XAI_GROK_47_MODEL, XAI_GROK_46_MODEL].map((model): ModelDescriptor => ({
    provider: XAI_PROVIDER_ID,
    model,
    displayName: model === XAI_GROK_47_MODEL ? "Grok 4.7" : "Grok 4.6",
    apiFamily: "openai-responses",
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
    compatibility: { responses: { reasoningEffortMap: XAI_REASONING_EFFORT_MAP } },
  })),
] satisfies readonly ModelDescriptor[];
