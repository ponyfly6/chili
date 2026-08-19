import {
  CODEX_API_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  KIMI_PROVIDER_ID,
  MINIMAX_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
  ZAI_PROVIDER_ID,
} from "./models.js";

export type EnvironmentSource = Record<string, string | undefined>;

export interface ProviderEnvironmentSpec {
  apiKey?: readonly string[];
  baseUrl?: readonly string[];
  model?: readonly string[];
}

export interface ProviderEnvironment {
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  baseUrlEnv?: string;
  model?: string;
  modelEnv?: string;
}

export const MINIMAX_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["MINIMAX_API_KEY", "ANTHROPIC_API_KEY"],
  baseUrl: ["MINIMAX_ANTHROPIC_BASE_URL", "ANTHROPIC_BASE_URL", "MINIMAX_BASE_URL"],
  model: ["MINIMAX_MODEL", "ANTHROPIC_MODEL"],
};

export const DEEPSEEK_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["DEEPSEEK_API_KEY"],
  baseUrl: ["DEEPSEEK_BASE_URL"],
  model: ["DEEPSEEK_MODEL"],
};

export const KIMI_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
  baseUrl: ["MOONSHOT_BASE_URL", "KIMI_BASE_URL"],
  model: ["MOONSHOT_MODEL", "KIMI_MODEL"],
};

export const ZAI_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["ZAI_API_KEY"],
  baseUrl: ["ZAI_BASE_URL"],
  model: ["ZAI_MODEL"],
};

export const OPENAI_CODEX_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: [],
  baseUrl: [],
  model: [],
};

export const CODEX_API_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["CODEX_API_KEY"],
  baseUrl: ["CODEX_API_BASE_URL"],
  model: ["CODEX_API_MODEL"],
};

const LEGACY_CODEX_API_ENVIRONMENT: Required<ProviderEnvironmentSpec> = {
  apiKey: ["OPENAI_CODEX_ACCESS_TOKEN"],
  baseUrl: ["OPENAI_CODEX_BASE_URL"],
  model: ["OPENAI_CODEX_MODEL"],
};

const PROVIDER_ENVIRONMENT: Record<string, ProviderEnvironmentSpec> = {
  [DEEPSEEK_PROVIDER_ID]: DEEPSEEK_ENVIRONMENT,
  [KIMI_PROVIDER_ID]: KIMI_ENVIRONMENT,
  [MINIMAX_PROVIDER_ID]: MINIMAX_ENVIRONMENT,
  [OPENAI_CODEX_PROVIDER_ID]: OPENAI_CODEX_ENVIRONMENT,
  [CODEX_API_PROVIDER_ID]: CODEX_API_ENVIRONMENT,
  [ZAI_PROVIDER_ID]: ZAI_ENVIRONMENT,
};

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

function readEnvironmentSpec(spec: ProviderEnvironmentSpec, env: EnvironmentSource): ProviderEnvironment {
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
