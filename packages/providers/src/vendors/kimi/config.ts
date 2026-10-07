import type { ProviderDefinition, ProviderEnvironmentSpec } from "../../provider-types.js";

export const KIMI_DEFINITION = {
  displayName: "Kimi", aliases: ["moonshot"], modelPrefixes: ["kimi-", "moonshot-"], auth: "api_key",
  defaultRequestMaxTokens: 128 * 1024, unknownModelRequestMaxTokens: 8192, reasoning: "effort", serviceTier: false,
} satisfies ProviderDefinition;

export const KIMI_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
  baseUrl: ["MOONSHOT_BASE_URL", "KIMI_BASE_URL"],
  model: ["MOONSHOT_MODEL", "KIMI_MODEL"],
};
