import { BUILTIN_PROVIDERS } from "./provider-definition.js";
import type { AuthStatus, FileAuthStorage } from "./auth/storage.js";
import {
  findConfiguredEnvironmentNames,
  isAbsoluteHttpUrl,
  readProviderEnvironment,
  type EnvironmentSource,
} from "./env.js";
import {
  CODEX_API_PROVIDER_ID,
  listKnownModels,
  OPENAI_CODEX_BASE_URL,
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
  endpoint?: string;
}

export type ModelCatalogEntry = ModelDescriptor & {
  providerDisplayName: string;
  available: boolean;
  authSource: ProviderAuthSource;
  endpoint?: string;
  authStatus: ProviderCatalogStatus;
};

export interface ProviderCatalogOptions {
  env?: EnvironmentSource;
  authStatus?: AuthStatus;
  displayName?: string;
  endpoint?: string;
}

export const BUILTIN_PROVIDER_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(BUILTIN_PROVIDERS).map(([id, definition]) => [id, definition.displayName]),
);

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
  const environmentConfigured = provider === CODEX_API_PROVIDER_ID
    ? Boolean(environment.apiKey?.trim()) && isAbsoluteHttpUrl(environment.baseUrl)
    : Boolean(environment.apiKey?.trim());
  const authStatus = options.authStatus;
  const storedAuthConfigured = provider === OPENAI_CODEX_PROVIDER_ID
    ? authStatus?.configured === true && authStatus.type === "oauth"
    : provider === CODEX_API_PROVIDER_ID
      ? false
      : authStatus?.configured === true;
  const configured = environmentConfigured || storedAuthConfigured;
  const status: ProviderCatalogStatus = {
    provider,
    displayName: options.displayName ?? getProviderDisplayName(provider),
    configured,
    available: configured,
    authSource: environmentConfigured ? "environment" : storedAuthConfigured ? authStatus?.type ?? "none" : "none",
    configuredEnvironmentNames,
  };
  if (authStatus?.authPath) status.authPath = authStatus.authPath;
  if (authStatus?.accountId) status.accountId = authStatus.accountId;
  if (authStatus?.expires !== undefined) status.expires = authStatus.expires;
  if (authStatus?.expired !== undefined) status.expired = authStatus.expired;
  const endpoint = safeEndpointOrigin(
    environment.baseUrl
    ?? options.endpoint
    ?? (provider === OPENAI_CODEX_PROVIDER_ID ? OPENAI_CODEX_BASE_URL : undefined),
  );
  if (endpoint) status.endpoint = endpoint;
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
        ...(model.baseUrl ? { endpoint: model.baseUrl } : {}),
      });
    statusByProvider.set(model.provider, authStatus);
    return {
      ...model,
      providerDisplayName: authStatus.displayName,
      available: authStatus.available,
      authSource: authStatus.authSource,
      ...(authStatus.endpoint ? { endpoint: authStatus.endpoint } : {}),
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
      statuses.set(model.provider, await getProviderCatalogStatusFromStorage(model.provider, storage, {
        ...options,
        ...(model.baseUrl ? { endpoint: model.baseUrl } : {}),
      }));
    }
  }
  return models.map((model) => {
    const authStatus = statuses.get(model.provider) ?? getProviderCatalogStatus(model.provider, options);
    return {
      ...model,
      providerDisplayName: authStatus.displayName,
      available: authStatus.available,
      authSource: authStatus.authSource,
      ...(authStatus.endpoint ? { endpoint: authStatus.endpoint } : {}),
      authStatus,
    };
  });
}

function safeEndpointOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
