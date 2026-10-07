import type { ProviderDefinition, ProviderEnvironmentSpec } from "../../provider-types.js";
import { canonicalizeCodexApiModel, canonicalizeOpenAICodexModel, canonicalizeOpenAIModel } from "./models.js";

export const OPENAI_CODEX_DEFINITION = {
  displayName: "ChatGPT", aliases: ["codex"], modelPrefixes: ["gpt-"], auth: "oauth",
  defaultRequestMaxTokens: 128_000, reasoning: "responses", serviceTier: true,
  connectionLabel: "ChatGPT OAuth", canonicalizeModel: canonicalizeOpenAICodexModel,
} satisfies ProviderDefinition;

export const CODEX_API_DEFINITION = {
  displayName: "Api", aliases: [], modelPrefixes: [], auth: "api_key",
  defaultRequestMaxTokens: 128_000, reasoning: "responses", serviceTier: true,
  connectionLabel: "Third-party API", canonicalizeModel: canonicalizeCodexApiModel,
} satisfies ProviderDefinition;

export const OPENAI_DEFINITION = {
  displayName: "OpenAI", aliases: [], modelPrefixes: [], auth: "api_key",
  defaultRequestMaxTokens: 128_000, reasoning: "responses", serviceTier: true,
  connectionLabel: "OpenAI API", canonicalizeModel: canonicalizeOpenAIModel,
} satisfies ProviderDefinition;

export const OPENAI_CODEX_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: [], baseUrl: [], model: [],
};

export const CODEX_API_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["CODEX_API_KEY"], baseUrl: ["CODEX_API_BASE_URL"], model: ["CODEX_API_MODEL"],
};

export const LEGACY_CODEX_API_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["OPENAI_CODEX_ACCESS_TOKEN"], baseUrl: ["OPENAI_CODEX_BASE_URL"], model: ["OPENAI_CODEX_MODEL"],
};

export const OPENAI_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["OPENAI_API_KEY"], baseUrl: ["OPENAI_BASE_URL"], model: ["OPENAI_MODEL"],
};
