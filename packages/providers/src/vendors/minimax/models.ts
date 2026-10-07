import type { ModelDescriptor } from "../../types.js";

export const MINIMAX_PROVIDER_ID = "minimax";
export const MINIMAX_M3_MODEL = "MiniMax-M3";
export const MINIMAX_M31_FLASH_PREVIEW_MODEL = "MiniMax-M3.1-Flash-Preview";
export const MINIMAX_BASE_URL = "https://api.minimax.cn/v1";

export const MINIMAX_MODELS = [
  {
    provider: MINIMAX_PROVIDER_ID,
    model: MINIMAX_M3_MODEL,
    displayName: "MiniMax M3",
    apiFamily: "openai-responses",
    baseUrl: MINIMAX_BASE_URL,
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
      responses: { sendSessionIdHeader: false },
    },
  },
  {
    provider: MINIMAX_PROVIDER_ID,
    model: MINIMAX_M31_FLASH_PREVIEW_MODEL,
    displayName: "MiniMax M3.1 Flash Preview (M Plan)",
    apiFamily: "openai-responses",
    baseUrl: MINIMAX_BASE_URL,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1000000,
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    capabilities: { streaming: true, reasoning: true, toolCalls: true, toolCallDeltas: true, usage: true, responseId: true },
    compatibility: {
      responses: { sendSessionIdHeader: false },
    },
  },
] satisfies readonly ModelDescriptor[];
