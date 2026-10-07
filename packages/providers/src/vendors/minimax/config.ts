import type { ProviderDefinition, ProviderEnvironmentSpec } from "../../provider-types.js";

export const MINIMAX_DEFINITION = {
  displayName: "MiniMax", aliases: [], modelPrefixes: ["minimax-"], auth: "api_key",
  defaultRequestMaxTokens: 128 * 1024, reasoning: "toggle-effort", serviceTier: true,
} satisfies ProviderDefinition;

export const MINIMAX_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["MINIMAX_API_KEY"],
  baseUrl: ["MINIMAX_ANTHROPIC_BASE_URL", "MINIMAX_BASE_URL"],
  model: ["MINIMAX_MODEL"],
};
