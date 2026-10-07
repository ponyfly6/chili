import type { ProviderDefinition, ProviderEnvironmentSpec } from "../../provider-types.js";

export const ZHIPU_DEFINITION = {
  displayName: "智谱 BigModel",
  aliases: ["bigmodel", "智谱"],
  // Preserve the existing GLM model inference and alias for international Z.ai.
  modelPrefixes: [],
  auth: "api_key",
  defaultRequestMaxTokens: 128 * 1024,
  unknownModelRequestMaxTokens: 4096,
  reasoning: "effort",
  serviceTier: false,
} satisfies ProviderDefinition;

export const ZHIPU_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["ZHIPU_API_KEY", "BIGMODEL_API_KEY"],
  baseUrl: ["ZHIPU_BASE_URL", "BIGMODEL_BASE_URL"],
  model: ["ZHIPU_MODEL", "BIGMODEL_MODEL"],
};
