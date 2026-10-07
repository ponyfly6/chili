import type { ProviderDefinition, ProviderEnvironmentSpec } from "../../provider-types.js";

export const DEEPSEEK_DEFINITION = {
  displayName: "DeepSeek", aliases: [], modelPrefixes: ["deepseek-"], auth: "api_key",
  defaultRequestMaxTokens: 128 * 1024, reasoning: "toggle-effort", serviceTier: false,
} satisfies ProviderDefinition;

export const DEEPSEEK_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["DEEPSEEK_API_KEY"],
  baseUrl: ["DEEPSEEK_BASE_URL"],
  model: ["DEEPSEEK_MODEL"],
};
