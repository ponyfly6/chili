import type { ResponsesCompatibility } from "../../protocols/compat.js";
import type { ModelDescriptor } from "../../types.js";

export const DOUBAO_PROVIDER_ID = "doubao";
export const DOUBAO_OPENAI_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DOUBAO_SEED_21_PRO_MODEL = "doubao-seed-2-1-pro-260915";
export const DOUBAO_SEED_21_LITE_MODEL = "doubao-seed-2-1-lite-260915";
export const DOUBAO_SEED_21_TURBO_MODEL = "doubao-seed-2-1-turbo-260628";
export const DOUBAO_SEED_EVOLVING_MODEL = "doubao-seed-evolving";

export const DOUBAO_SEED_COMPATIBILITY = {
  sendSessionIdHeader: false,
  reasoningEffortMap: {
    off: "off", minimal: "low", low: "low", medium: "medium", high: "high",
    xhigh: "high", max: "high", ultra: "high",
  },
} satisfies ResponsesCompatibility;

/** Verified against Ark's official model/API pages on 2026-10-07; see README. */
export const DOUBAO_MODELS = [
  ...([
    [DOUBAO_SEED_21_PRO_MODEL, "Doubao Seed 2.1 Pro", 1_048_576, 6, 30, 1.2],
    [DOUBAO_SEED_21_LITE_MODEL, "Doubao Seed 2.1 Lite", 1_048_576, 0.8, 2.7, 0.16],
    [DOUBAO_SEED_21_TURBO_MODEL, "Doubao Seed 2.1 Turbo", 262144, 3, 15, 0.6],
    [DOUBAO_SEED_EVOLVING_MODEL, "Doubao Seed Evolving", 1_048_576, 6, 30, 1.2],
  ] as const).map(([model, displayName, contextWindowTokens, input, output, cacheRead]): ModelDescriptor => ({
    provider: DOUBAO_PROVIDER_ID,
    model,
    displayName,
    apiFamily: "openai-responses",
    baseUrl: DOUBAO_OPENAI_BASE_URL,
    ...(model === DOUBAO_SEED_21_PRO_MODEL ? { default: true } : {}),
    inputCapabilities: ["text", "image"],
    contextWindowTokens,
    maxOutputTokens: 262144,
    reasoningLevels: ["off", "low", "medium", "high"],
    capabilities: {
      streaming: true, reasoning: true, toolCalls: true, toolCallDeltas: true,
      usage: true, responseId: true,
    },
    compatibility: { responses: DOUBAO_SEED_COMPATIBILITY },
    cost: { currency: "CNY", input, output, cacheRead, cacheWrite: 0,
      notes: "Standard online non-audio rates; flex/batch rates differ. Cache storage is charged separately at CNY 0.017/M tokens/hour; cacheWrite does not include storage." },
  })),
] satisfies readonly ModelDescriptor[];
