import { defaultAuthPath, FileAuthStorage, sameOAuthCredential } from "../../auth/storage.js";
import { resolveOAuthCredentials } from "../../auth/refresh.js";
import { credentialVersionFingerprint } from "../../runtime/request-lifecycle.js";
import { findDefaultKnownModel, listKnownModels } from "../../models.js";
import { ResponsesModel } from "../../protocols/responses.js";
import type { ChiliModelProvider, ModelDescriptor, ModelStreamInput } from "../../types.js";
import { extractOpenAICodexAccountId, refreshOpenAICodexToken } from "./oauth.js";
import { assertOpenAICodexModel, canonicalizeOpenAICodexModel, OPENAI_CODEX_BASE_URL, OPENAI_CODEX_DEFAULT_MODEL, OPENAI_CODEX_PROVIDER_ID } from "./models.js";
import { codexRuntimeOptions, resolveCodexResponsesUrl } from "./runtime.js";
import { resolveCodexStreamRequestOptions } from "./request.js";
import type { OpenAICodexModelOptions, OpenAICodexRequestBuildOptions } from "./types.js";
export type { OpenAICodexModelOptions, OpenAICodexRequestBuildOptions, OpenAICodexReasoningEffort, OpenAICodexReasoningMode, OpenAICodexReasoningContext } from "./types.js";
export { OPENAI_CODEX_BASE_URL, OPENAI_CODEX_DEFAULT_MODEL, OPENAI_CODEX_PROVIDER_ID } from "./models.js";
export { buildOpenAICodexResponsesRequestBody, clampOpenAICodexReasoningEffort, resolveOpenAICodexReasoningEffort } from "./request.js";

export class OpenAICodexProvider implements ChiliModelProvider {
  readonly id = OPENAI_CODEX_PROVIDER_ID;
  readonly name = "ChatGPT Codex";

  constructor(private readonly options: OpenAICodexModelOptions = {}) {
    assertOpenAICodexOAuthOptions(options);
    this.defaultModel();
  }

  models(): readonly ModelDescriptor[] {
    const models = listKnownModels(this.id);
    const defaultModel = this.defaultModel();
    if (models.some((model) => model.model === defaultModel)) {
      return models.map((model) => {
        const descriptor: ModelDescriptor = { ...model };
        descriptor.baseUrl = this.defaultBaseUrl();
        if (model.model === defaultModel) {
          descriptor.default = true;
        } else {
          delete descriptor.default;
        }
        return descriptor;
      });
    }

    const fallback = findDefaultKnownModel(this.id);
    const descriptor: ModelDescriptor = {
      provider: this.id,
      model: defaultModel,
      displayName: defaultModel,
      apiFamily: fallback?.apiFamily ?? "openai-responses",
      baseUrl: this.defaultBaseUrl(),
      default: true,
    };
    if (fallback?.capabilities) descriptor.capabilities = fallback.capabilities;
    if (fallback?.inputCapabilities) descriptor.inputCapabilities = fallback.inputCapabilities;
    if (fallback?.contextWindowTokens !== undefined) descriptor.contextWindowTokens = fallback.contextWindowTokens;
    if (fallback?.maxOutputTokens !== undefined) descriptor.maxOutputTokens = fallback.maxOutputTokens;
    if (fallback?.cost) descriptor.cost = fallback.cost;
    return [descriptor, ...models.map(withoutDefaultFlag)];
  }

  getModel(model?: string): OpenAICodexResponsesModel {
    return createOpenAICodexModel({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const model = canonicalizeOpenAICodexModel(this.options.model ?? OPENAI_CODEX_DEFAULT_MODEL);
    assertOpenAICodexModel(model);
    return model;
  }

  private defaultBaseUrl(): string {
    return OPENAI_CODEX_BASE_URL;
  }
}

export class OpenAICodexResponsesModel extends ResponsesModel {
  constructor(options: OpenAICodexModelOptions = {}) {
    assertOpenAICodexOAuthOptions(options);
    const model = canonicalizeOpenAICodexModel(options.model ?? OPENAI_CODEX_DEFAULT_MODEL);
    assertOpenAICodexModel(model);
    const fetchImpl = options.fetch ?? fetch;
    const authStorage = options.authStorage ?? new FileAuthStorage(options.authPath ?? defaultAuthPath(options.chiliHome));
    super(codexRuntimeOptions(
      OPENAI_CODEX_PROVIDER_ID,
      model,
      OPENAI_CODEX_BASE_URL,
      options,
      fetchImpl,
      true,
      async (signal) => {
        const stored = await resolveOAuthCredentials({
          storage: authStorage,
          provider: OPENAI_CODEX_PROVIDER_ID,
          ...(signal ? { signal } : {}),
          ...(options.authRefreshTimeoutMs === undefined ? {} : { timeoutMs: options.authRefreshTimeoutMs }),
          refresh: (stored, refreshSignal) => refreshOpenAICodexToken(stored.refresh, {
            fetch: fetchImpl, previous: stored, signal: refreshSignal,
            ...(options.authRefreshTimeoutMs === undefined ? {} : { timeoutMs: options.authRefreshTimeoutMs }),
          }),
        });
        return {
          access: stored.access,
          accountId: stored.accountId,
          credentialVersion: stored.revision ?? credentialVersionFingerprint(JSON.stringify(stored)),
          assertCurrent: async () => {
            if (!sameOAuthCredential(await authStorage.getOAuthCredentials(OPENAI_CODEX_PROVIDER_ID), stored)) {
              throw new Error("OAuth credentials changed before model dispatch; the stale request was cancelled");
            }
          },
        };
      },
    ));
  }
}

export function createOpenAICodexProvider(options: OpenAICodexModelOptions = {}): OpenAICodexProvider {
  return new OpenAICodexProvider(options);
}

export function createOpenAICodexRouter(options: OpenAICodexModelOptions = {}): OpenAICodexResponsesModel {
  return createOpenAICodexModel(options);
}

export function createOpenAICodexModel(options: OpenAICodexModelOptions = {}): OpenAICodexResponsesModel {
  return new OpenAICodexResponsesModel(options);
}

export function resolveOpenAICodexStreamRequestOptions(
  input: ModelStreamInput,
  options: OpenAICodexModelOptions = {},
): OpenAICodexRequestBuildOptions {
  assertOpenAICodexOAuthOptions(options);
  return resolveCodexStreamRequestOptions(input, OPENAI_CODEX_PROVIDER_ID, {
    ...options,
    model: options.model ?? OPENAI_CODEX_DEFAULT_MODEL,
  });
}

export function resolveOpenAICodexResponsesUrl(baseUrl?: string): string {
  if (baseUrl && normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(OPENAI_CODEX_BASE_URL)) {
    throw new Error("ChatGPT Codex uses a fixed endpoint; use the codex-api provider for custom base URLs");
  }
  return resolveCodexResponsesUrl(OPENAI_CODEX_BASE_URL);
}

function assertOpenAICodexOAuthOptions(options: OpenAICodexModelOptions): void {
  if (options.apiKey !== undefined || options.accountId !== undefined) {
    throw new Error("ChatGPT Codex is OAuth-only; use the codex-api provider for API keys");
  }
  if (options.baseUrl !== undefined && normalizeBaseUrl(options.baseUrl) !== normalizeBaseUrl(OPENAI_CODEX_BASE_URL)) {
    throw new Error("ChatGPT Codex uses a fixed endpoint; use the codex-api provider for custom base URLs");
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function withoutDefaultFlag(model: ModelDescriptor): ModelDescriptor {
  const descriptor: ModelDescriptor = { ...model };
  delete descriptor.default;
  return descriptor;
}
