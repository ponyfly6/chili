import type { BuiltinProviderId } from "./provider-definition.js";
import type { ProviderEnvironmentSpec } from "./provider-types.js";
import {
  CODEX_API_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  KIMI_PROVIDER_ID,
  MINIMAX_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
  XAI_PROVIDER_ID,
  ZAI_PROVIDER_ID,
} from "./models.js";
import { ALIBABA_ENVIRONMENT } from "./vendors/alibaba/config.js";
import { ANTHROPIC_ENVIRONMENT } from "./vendors/anthropic/config.js";
import { DEEPSEEK_ENVIRONMENT } from "./vendors/deepseek/config.js";
import { DOUBAO_ENVIRONMENT } from "./vendors/doubao/config.js";
import { KIMI_ENVIRONMENT } from "./vendors/kimi/config.js";
import { MINIMAX_ENVIRONMENT } from "./vendors/minimax/config.js";
import { OPENAI_CODEX_ENVIRONMENT, CODEX_API_ENVIRONMENT, LEGACY_CODEX_API_ENVIRONMENT, OPENAI_ENVIRONMENT } from "./vendors/openai/config.js";
import { XAI_ENVIRONMENT } from "./vendors/xai/config.js";
import { ZAI_ENVIRONMENT } from "./vendors/zhipu/config.js";
import { ZHIPU_ENVIRONMENT } from "./vendors/zhipu/domestic-config.js";

export { ZHIPU_ENVIRONMENT } from "./vendors/zhipu/domestic-config.js";
export { ANTHROPIC_ENVIRONMENT } from "./vendors/anthropic/config.js";
export { DOUBAO_ENVIRONMENT } from "./vendors/doubao/config.js";
export { ALIBABA_ENVIRONMENT } from "./vendors/alibaba/config.js";
export type { ProviderEnvironmentSpec } from "./provider-types.js";
export { MINIMAX_ENVIRONMENT } from "./vendors/minimax/config.js";
export { DEEPSEEK_ENVIRONMENT } from "./vendors/deepseek/config.js";
export { KIMI_ENVIRONMENT } from "./vendors/kimi/config.js";
export { ZAI_ENVIRONMENT } from "./vendors/zhipu/config.js";
export { XAI_ENVIRONMENT } from "./vendors/xai/config.js";
export { OPENAI_CODEX_ENVIRONMENT, CODEX_API_ENVIRONMENT, OPENAI_ENVIRONMENT } from "./vendors/openai/config.js";

export type EnvironmentSource = Record<string, string | undefined>;

export interface ProviderEnvironment {
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  baseUrlEnv?: string;
  model?: string;
  modelEnv?: string;
}

const PROVIDER_ENVIRONMENT: Record<string, ProviderEnvironmentSpec> = {
  [DEEPSEEK_PROVIDER_ID]: DEEPSEEK_ENVIRONMENT,
  [KIMI_PROVIDER_ID]: KIMI_ENVIRONMENT,
  [MINIMAX_PROVIDER_ID]: MINIMAX_ENVIRONMENT,
  [OPENAI_CODEX_PROVIDER_ID]: OPENAI_CODEX_ENVIRONMENT,
  [CODEX_API_PROVIDER_ID]: CODEX_API_ENVIRONMENT,
  [XAI_PROVIDER_ID]: XAI_ENVIRONMENT,
  [ZAI_PROVIDER_ID]: ZAI_ENVIRONMENT,
  alibaba: ALIBABA_ENVIRONMENT,
  doubao: DOUBAO_ENVIRONMENT,
  anthropic: ANTHROPIC_ENVIRONMENT,
  zhipu: ZHIPU_ENVIRONMENT,
  openai: OPENAI_ENVIRONMENT,
} satisfies Record<BuiltinProviderId, ProviderEnvironmentSpec>;

/** Capture only this provider's inputs, preserving legacy-vs-explicit credential provenance. */
export function snapshotProviderEnvironment(provider: string, env: EnvironmentSource = currentEnvironment()): EnvironmentSource {
  const spec = PROVIDER_ENVIRONMENT[provider];
  if (!spec) return {};
  const specs = provider === CODEX_API_PROVIDER_ID ? [spec, LEGACY_CODEX_API_ENVIRONMENT] : [spec];
  const snapshot: EnvironmentSource = {};
  for (const entry of specs) {
    for (const name of [...(entry.apiKey ?? []), ...(entry.baseUrl ?? []), ...(entry.model ?? [])]) {
      if (env[name] !== undefined) snapshot[name] = env[name];
    }
  }
  return snapshot;
}

export function readProviderEnvironment(
  provider: string,
  env: EnvironmentSource = currentEnvironment(),
): ProviderEnvironment {
  const spec = PROVIDER_ENVIRONMENT[provider];
  if (!spec) return {};
  if (provider === CODEX_API_PROVIDER_ID) return readCodexApiEnvironment(env);
  return readEnvironmentSpec(spec, env);
}

export function readMiniMaxEnvironment(env: EnvironmentSource = currentEnvironment()): ProviderEnvironment {
  return readEnvironmentSpec(MINIMAX_ENVIRONMENT, env);
}

export function readDeepSeekEnvironment(env: EnvironmentSource = currentEnvironment()): ProviderEnvironment {
  return readEnvironmentSpec(DEEPSEEK_ENVIRONMENT, env);
}

export function readKimiEnvironment(env: EnvironmentSource = currentEnvironment()): ProviderEnvironment {
  return readEnvironmentSpec(KIMI_ENVIRONMENT, env);
}

export function readZaiEnvironment(env: EnvironmentSource = currentEnvironment()): ProviderEnvironment {
  return readEnvironmentSpec(ZAI_ENVIRONMENT, env);
}

export function readXaiEnvironment(env: EnvironmentSource = currentEnvironment()): ProviderEnvironment {
  return readEnvironmentSpec(XAI_ENVIRONMENT, env);
}

export function readOpenAICodexEnvironment(env: EnvironmentSource = currentEnvironment()): ProviderEnvironment {
  return readEnvironmentSpec(OPENAI_CODEX_ENVIRONMENT, env);
}

export function readCodexApiEnvironment(env: EnvironmentSource = currentEnvironment()): ProviderEnvironment {
  const spec = hasConfiguredEnvironment(CODEX_API_ENVIRONMENT, env)
    ? CODEX_API_ENVIRONMENT
    : LEGACY_CODEX_API_ENVIRONMENT;
  return readEnvironmentSpec(spec, env);
}

export function isAbsoluteHttpUrl(value: string | undefined): boolean {
  const normalized = value?.trim();
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function findConfiguredEnvironmentNames(
  provider: string,
  env: EnvironmentSource = currentEnvironment(),
): readonly string[] {
  const spec = PROVIDER_ENVIRONMENT[provider];
  if (!spec) return [];
  if (provider === CODEX_API_PROVIDER_ID) {
    const activeSpec = hasConfiguredEnvironment(CODEX_API_ENVIRONMENT, env)
      ? CODEX_API_ENVIRONMENT
      : LEGACY_CODEX_API_ENVIRONMENT;
    return configuredEnvironmentNames(activeSpec, env);
  }
  return configuredEnvironmentNames(spec, env);
}

function hasConfiguredEnvironment(spec: ProviderEnvironmentSpec, env: EnvironmentSource): boolean {
  return configuredEnvironmentNames(spec, env).length > 0;
}

function configuredEnvironmentNames(spec: ProviderEnvironmentSpec, env: EnvironmentSource): string[] {
  return [...configuredNames(spec.apiKey, env), ...configuredNames(spec.baseUrl, env), ...configuredNames(spec.model, env)];
}

export function readEnvironmentSpec(spec: ProviderEnvironmentSpec, env: EnvironmentSource = currentEnvironment()): ProviderEnvironment {
  const apiKey = firstEnvironmentValue(spec.apiKey, env);
  const baseUrl = firstEnvironmentValue(spec.baseUrl, env);
  const model = firstEnvironmentValue(spec.model, env);
  const result: ProviderEnvironment = {};
  if (apiKey) {
    result.apiKey = apiKey.value;
    result.apiKeyEnv = apiKey.name;
  }
  if (baseUrl) {
    result.baseUrl = baseUrl.value;
    result.baseUrlEnv = baseUrl.name;
  }
  if (model) {
    result.model = model.value;
    result.modelEnv = model.name;
  }
  return result;
}

function firstEnvironmentValue(
  names: readonly string[] | undefined,
  env: EnvironmentSource,
): { name: string; value: string } | undefined {
  for (const name of names ?? []) {
    const value = env[name];
    if (value) return { name, value };
  }
  return undefined;
}

function configuredNames(names: readonly string[] | undefined, env: EnvironmentSource): string[] {
  return (names ?? []).filter((name) => !!env[name]);
}

function currentEnvironment(): EnvironmentSource {
  return typeof process === "undefined" ? {} : process.env;
}
