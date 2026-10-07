import type { ProviderDefinition, ProviderEnvironmentSpec } from "../../provider-types.js";

export const DOUBAO_DEFINITION = {
  displayName: "Doubao",
  aliases: ["volcengine", "ark", "bytedance"],
  modelPrefixes: ["doubao-"],
  auth: "api_key",
  defaultRequestMaxTokens: 65536,
  unknownModelRequestMaxTokens: 4096,
  reasoning: "responses",
  serviceTier: false,
} satisfies ProviderDefinition;

export const DOUBAO_ENVIRONMENT = {
  apiKey: ["ARK_API_KEY", "DOUBAO_API_KEY"],
  baseUrl: ["ARK_BASE_URL", "DOUBAO_BASE_URL"],
  model: ["ARK_MODEL", "DOUBAO_MODEL"],
} satisfies Required<ProviderEnvironmentSpec>;
