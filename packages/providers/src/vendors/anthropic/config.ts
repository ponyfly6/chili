import type { ProviderDefinition, ProviderEnvironmentSpec } from "../../provider-types.js";

export const ANTHROPIC_DEFINITION = {
  displayName: "Anthropic", aliases: ["claude"], modelPrefixes: ["claude-"], auth: "api_key",
  defaultRequestMaxTokens: 128_000, reasoning: "toggle-effort", serviceTier: false,
} satisfies ProviderDefinition;

export const ANTHROPIC_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["ANTHROPIC_API_KEY"],
  baseUrl: ["ANTHROPIC_BASE_URL"],
  model: ["ANTHROPIC_MODEL"],
};
