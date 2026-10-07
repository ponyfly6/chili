import type { ProviderDefinition } from "./provider-types.js";
import { ALIBABA_DEFINITION } from "./vendors/alibaba/config.js";
import { ANTHROPIC_DEFINITION } from "./vendors/anthropic/config.js";
import { DEEPSEEK_DEFINITION } from "./vendors/deepseek/config.js";
import { DOUBAO_DEFINITION } from "./vendors/doubao/config.js";
import { KIMI_DEFINITION } from "./vendors/kimi/config.js";
import { MINIMAX_DEFINITION } from "./vendors/minimax/config.js";
import { OPENAI_CODEX_DEFINITION, CODEX_API_DEFINITION, OPENAI_DEFINITION } from "./vendors/openai/config.js";
import { XAI_DEFINITION } from "./vendors/xai/config.js";
import { ZAI_DEFINITION } from "./vendors/zhipu/config.js";
import { ZHIPU_DEFINITION } from "./vendors/zhipu/domestic-config.js";

export type { ProviderDefinition } from "./provider-types.js";

const definitions = {
  minimax: MINIMAX_DEFINITION,
  deepseek: DEEPSEEK_DEFINITION,
  kimi: KIMI_DEFINITION,
  zai: ZAI_DEFINITION,
  xai: XAI_DEFINITION,
  "openai-codex": OPENAI_CODEX_DEFINITION,
  "codex-api": CODEX_API_DEFINITION,
  alibaba: ALIBABA_DEFINITION,
  doubao: DOUBAO_DEFINITION,
  anthropic: ANTHROPIC_DEFINITION,
  zhipu: ZHIPU_DEFINITION,
  openai: OPENAI_DEFINITION,
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
