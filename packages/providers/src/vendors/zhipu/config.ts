import type { ProviderDefinition, ProviderEnvironmentSpec } from "../../provider-types.js";

export const ZAI_DEFINITION = {
  displayName: "Z.ai", aliases: ["z.ai", "glm"], modelPrefixes: ["glm-"], auth: "api_key",
  defaultRequestMaxTokens: 128 * 1024, reasoning: "effort", serviceTier: false,
} satisfies ProviderDefinition;

export const ZAI_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["ZAI_API_KEY"],
  baseUrl: ["ZAI_BASE_URL"],
  model: ["ZAI_MODEL"],
};
