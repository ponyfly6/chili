import type { ProviderDefinition, ProviderEnvironmentSpec } from "../../provider-types.js";

export const MINIMAX_DEFINITION = {
  displayName: "MiniMax", aliases: [], modelPrefixes: ["minimax-"], auth: "api_key",
  defaultRequestMaxTokens: 128 * 1024, unknownModelRequestMaxTokens: 4096, reasoning: "toggle-effort", serviceTier: true,
} satisfies ProviderDefinition;

export const MINIMAX_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["MINIMAX_API_KEY"],
  baseUrl: ["MINIMAX_BASE_URL"],
  model: ["MINIMAX_MODEL"],
};
