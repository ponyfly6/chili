import type { ProviderDefinition, ProviderEnvironmentSpec } from "../../provider-types.js";

export const ALIBABA_DEFINITION = {
  displayName: "Alibaba Qwen",
  aliases: ["qwen", "dashscope", "aliyun"],
  modelPrefixes: ["qwen"],
  auth: "api_key",
  defaultRequestMaxTokens: 131072,
  unknownModelRequestMaxTokens: 4096,
  reasoning: "responses",
  serviceTier: false,
} satisfies ProviderDefinition;

export const ALIBABA_ENVIRONMENT = {
  apiKey: ["DASHSCOPE_API_KEY", "ALIBABA_API_KEY"],
  baseUrl: ["DASHSCOPE_BASE_URL", "ALIBABA_BASE_URL"],
  model: ["DASHSCOPE_MODEL", "ALIBABA_MODEL"],
} satisfies Required<ProviderEnvironmentSpec>;
