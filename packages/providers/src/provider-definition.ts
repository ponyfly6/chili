import { canonicalizeCodexApiModel, canonicalizeOpenAICodexModel } from "./models.js";

export interface ProviderDefinition {
  displayName: string;
  aliases: readonly string[];
  modelPrefixes: readonly string[];
  auth: "api_key" | "oauth";
  defaultRequestMaxTokens: number;
  reasoning: "toggle" | "toggle-effort" | "effort" | "responses";
  serviceTier: boolean;
  connectionLabel?: string;
  canonicalizeModel?: (model: string) => string;
}

const definitions = {
  minimax: {
    displayName: "MiniMax", aliases: [], modelPrefixes: ["minimax-"], auth: "api_key",
    defaultRequestMaxTokens: 128 * 1024, reasoning: "toggle-effort", serviceTier: true,
  },
  deepseek: {
    displayName: "DeepSeek", aliases: [], modelPrefixes: ["deepseek-"], auth: "api_key",
    defaultRequestMaxTokens: 128 * 1024, reasoning: "toggle-effort", serviceTier: false,
  },
  kimi: {
    displayName: "Kimi", aliases: ["moonshot"], modelPrefixes: ["kimi-", "moonshot-"], auth: "api_key",
    defaultRequestMaxTokens: 128 * 1024, reasoning: "effort", serviceTier: false,
  },
  zai: {
    displayName: "Z.ai", aliases: ["z.ai", "glm"], modelPrefixes: ["glm-"], auth: "api_key",
    defaultRequestMaxTokens: 128 * 1024, reasoning: "effort", serviceTier: false,
  },
  xai: {
    displayName: "xAI", aliases: ["x.ai", "grok"], modelPrefixes: ["grok-"], auth: "api_key",
    defaultRequestMaxTokens: 128_000, reasoning: "effort", serviceTier: false,
  },
  "openai-codex": {
    displayName: "ChatGPT", aliases: ["codex"], modelPrefixes: ["gpt-"], auth: "oauth",
    defaultRequestMaxTokens: 128_000, reasoning: "responses", serviceTier: true,
    connectionLabel: "ChatGPT OAuth", canonicalizeModel: canonicalizeOpenAICodexModel,
  },
  "codex-api": {
    displayName: "Api", aliases: [], modelPrefixes: [], auth: "api_key",
    defaultRequestMaxTokens: 128_000, reasoning: "responses", serviceTier: true,
    connectionLabel: "Third-party API", canonicalizeModel: canonicalizeCodexApiModel,
  },
} satisfies Record<string, ProviderDefinition>;

export type BuiltinProviderId = keyof typeof definitions;
export const BUILTIN_PROVIDERS: Readonly<Record<BuiltinProviderId, ProviderDefinition>> = definitions;

export function isBuiltinProviderId(value: string): value is BuiltinProviderId {
  return Object.hasOwn(BUILTIN_PROVIDERS, value);
}

export function resolveBuiltinProviderId(value: string): BuiltinProviderId | undefined {
  const normalized = value.trim().toLowerCase();
  if (isBuiltinProviderId(normalized)) return normalized;
  return (Object.keys(BUILTIN_PROVIDERS) as BuiltinProviderId[])
    .find((id) => BUILTIN_PROVIDERS[id].aliases.includes(normalized));
}

export function inferBuiltinProviderId(model: string): BuiltinProviderId | undefined {
  const normalized = model.toLowerCase();
  return (Object.keys(BUILTIN_PROVIDERS) as BuiltinProviderId[])
    .find((id) => BUILTIN_PROVIDERS[id].modelPrefixes.some((prefix) => normalized.startsWith(prefix)));
}

export function canonicalizeProviderModel(provider: BuiltinProviderId, model: string): string {
  return BUILTIN_PROVIDERS[provider].canonicalizeModel?.(model) ?? model;
}
