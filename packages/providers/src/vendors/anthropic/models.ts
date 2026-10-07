import type { ModelDescriptor } from "../../types.js";

export const ANTHROPIC_PROVIDER_ID = "anthropic";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_OPUS_55_MODEL = "claude-opus-5-5";
export const ANTHROPIC_SONNET_55_MODEL = "claude-sonnet-5-5";
export const ANTHROPIC_FABLE_51_MODEL = "claude-fable-5-1";
export const ANTHROPIC_HAIKU_45_MODEL = "claude-haiku-4-5-20251001";

const shared = {
  provider: ANTHROPIC_PROVIDER_ID,
  apiFamily: "anthropic-messages",
  baseUrl: ANTHROPIC_BASE_URL,
  capabilities: { streaming: true, reasoning: true, toolCalls: true, toolCallDeltas: true, usage: true, responseId: true },
  inputCapabilities: ["text", "image"],
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 128_000,
  reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
  compatibility: {
    messages: {
      supportsAdaptiveReasoningEffort: true,
      supportsThinkingReplay: true,
      supportsThinkingPrefixBinding: true,
      requiresDefaultTemperature: true,
    },
  },
} satisfies Partial<ModelDescriptor>;

/** Official Claude API catalog, verified 2026-10-07; sources and wire constraints are in README.md. */
export const ANTHROPIC_MODELS: readonly ModelDescriptor[] = [
  {
    ...shared, model: ANTHROPIC_OPUS_55_MODEL, displayName: "Claude Opus 5.5", default: true,
    cost: { currency: "USD", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5,
      notes: "Standard Claude API; cacheWrite is 5-minute TTL (1-hour: $8/MTok). Fast mode priced separately." },
  },
  {
    ...shared, model: ANTHROPIC_SONNET_55_MODEL, displayName: "Claude Sonnet 5.5",
    cost: { currency: "USD", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5,
      notes: "Standard Claude API; cacheWrite is 5-minute TTL (1-hour: $4/MTok)." },
  },
  {
    ...shared, model: ANTHROPIC_FABLE_51_MODEL, displayName: "Claude Fable 5.1",
    cost: { currency: "USD", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5,
      notes: "Standard Claude API; cacheWrite is 5-minute TTL (1-hour: $20/MTok)." },
  },
  {
    ...shared, model: ANTHROPIC_HAIKU_45_MODEL, displayName: "Claude Haiku 4.5",
    contextWindowTokens: 200_000, maxOutputTokens: 64_000,
    reasoningLevels: ["off", "low", "medium", "high"],
    compatibility: { messages: { supportsBudgetThinking: true, supportsThinkingReplay: true } },
    cost: { currency: "USD", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25,
      notes: "Standard Claude API; cacheWrite is 5-minute TTL (1-hour: $2/MTok)." },
  },
];
