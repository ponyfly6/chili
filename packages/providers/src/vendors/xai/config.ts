import type { ProviderDefinition, ProviderEnvironmentSpec } from "../../provider-types.js";

export const XAI_DEFINITION = {
  displayName: "xAI", aliases: ["x.ai", "grok"], modelPrefixes: ["grok-"], auth: "api_key",
  defaultRequestMaxTokens: 128_000, unknownModelRequestMaxTokens: 4096, reasoning: "effort", serviceTier: false,
} satisfies ProviderDefinition;

export const XAI_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["XAI_API_KEY"],
  baseUrl: ["XAI_BASE_URL"],
  model: ["XAI_MODEL"],
};
