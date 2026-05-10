import type { AuthStatus, FileAuthStorage } from "./auth.js";
import { findConfiguredEnvironmentNames, readProviderEnvironment, type EnvironmentSource } from "./env.js";
import {
  DEEPSEEK_PROVIDER_ID,
  KIMI_PROVIDER_ID,
  listKnownModels,
  MINIMAX_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
} from "./models.js";
import type { ModelDescriptor } from "./types.js";

export type ProviderAuthSource = "none" | "environment" | "api_key" | "oauth";

export interface ProviderCatalogStatus {
  provider: string;
  displayName: string;
  configured: boolean;
  available: boolean;
  authSource: ProviderAuthSource;
  configuredEnvironmentNames: readonly string[];
  authPath?: string;
  accountId?: string;
  expires?: number;
  expired?: boolean;
}

export type ModelCatalogEntry = ModelDescriptor & {
  providerDisplayName: string;
  available: boolean;
  authStatus: ProviderCatalogStatus;
};

export interface ProviderCatalogOptions {
  env?: EnvironmentSource;
  authStatus?: AuthStatus;
  displayName?: string;
}

export const BUILTIN_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  [DEEPSEEK_PROVIDER_ID]: "DeepSeek",
  [KIMI_PROVIDER_ID]: "Kimi",
  [MINIMAX_PROVIDER_ID]: "MiniMax",
  [OPENAI_CODEX_PROVIDER_ID]: "ChatGPT Codex",
};

export function getProviderDisplayName(provider: string, overrides: Record<string, string> = {}): string {
  return overrides[provider] ?? BUILTIN_PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

export function getProviderCatalogStatus(
  provider: string,
  options: ProviderCatalogOptions = {},
): ProviderCatalogStatus {
  const env = options.env;
  const environment = readProviderEnvironment(provider, env);
  const configuredEnvironmentNames = findConfiguredEnvironmentNames(provider, env);
  const environmentConfigured = environment.apiKey !== undefined;
  const authStatus = options.authStatus;
  const configured = environmentConfigured || authStatus?.configured === true;
  const status: ProviderCatalogStatus = {
    provider,
    displayName: options.displayName ?? getProviderDisplayName(provider),
    configured,
    available: configured,
    authSource: environmentConfigured ? "environment" : authStatus?.type ?? "none",
    configuredEnvironmentNames,
  };
  if (authStatus?.authPath) status.authPath = authStatus.authPath;
  if (authStatus?.accountId) status.accountId = authStatus.accountId;
  if (authStatus?.expires !== undefined) status.expires = authStatus.expires;
  if (authStatus?.expired !== undefined) status.expired = authStatus.expired;
  return status;
}

export async function getProviderCatalogStatusFromStorage(
  provider: string,
  storage: FileAuthStorage,
  options: Omit<ProviderCatalogOptions, "authStatus"> = {},
): Promise<ProviderCatalogStatus> {
  return getProviderCatalogStatus(provider, {
    ...options,
    authStatus: await storage.status(provider),
  });
}

export function listModelCatalog(provider?: string, options: ProviderCatalogOptions = {}): readonly ModelCatalogEntry[] {
  const statusByProvider = new Map<string, ProviderCatalogStatus>();
  return listKnownModels(provider).map((model) => {
    const authStatus =
      statusByProvider.get(model.provider) ??
      getProviderCatalogStatus(model.provider, {
        ...options,
        displayName: options.displayName ?? getProviderDisplayName(model.provider),
      });
    statusByProvider.set(model.provider, authStatus);
    return {
      ...model,
      providerDisplayName: authStatus.displayName,
      available: authStatus.available,
      authStatus,
    };
  });
}

export async function listModelCatalogFromStorage(
  provider: string | undefined,
  storage: FileAuthStorage,
  options: Omit<ProviderCatalogOptions, "authStatus"> = {},
): Promise<readonly ModelCatalogEntry[]> {
  const statuses = new Map<string, ProviderCatalogStatus>();
  const models = listKnownModels(provider);
  for (const model of models) {
    if (!statuses.has(model.provider)) {
      statuses.set(model.provider, await getProviderCatalogStatusFromStorage(model.provider, storage, options));
    }
  }
  return models.map((model) => {
    const authStatus = statuses.get(model.provider) ?? getProviderCatalogStatus(model.provider, options);
    return {
      ...model,
      providerDisplayName: authStatus.displayName,
      available: authStatus.available,
      authStatus,
    };
  });
}
