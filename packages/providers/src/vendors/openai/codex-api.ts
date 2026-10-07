import { isAbsoluteHttpUrl, readCodexApiEnvironment } from "../../env.js";
import { listKnownModels } from "../../models.js";
import { ResponsesModel } from "../../protocols/responses.js";
import type { ChiliModelProvider, ModelDescriptor, ModelStreamInput } from "../../types.js";
import { extractOpenAICodexAccountId } from "./oauth.js";
import { assertCodexApiModel, canonicalizeCodexApiModel, CODEX_API_DEFAULT_MODEL, CODEX_API_PROVIDER_ID } from "./models.js";
import { codexRuntimeOptions, resolveCodexResponsesUrl } from "./runtime.js";
import { resolveCodexStreamRequestOptions } from "./request.js";
import type { CodexApiModelOptions, CodexApiRequestBuildOptions } from "./types.js";
export type { CodexApiModelOptions, CodexApiRequestBuildOptions } from "./types.js";
export { CODEX_API_DEFAULT_MODEL, CODEX_API_PROVIDER_ID } from "./models.js";

export class CodexApiProvider implements ChiliModelProvider {
  readonly id = CODEX_API_PROVIDER_ID;
  readonly name = "Codex API";

  constructor(private readonly options: CodexApiModelOptions = {}) {
    this.defaultModel();
  }

  models(): readonly ModelDescriptor[] {
    const models = listKnownModels(this.id);
    const defaultModel = this.defaultModel();
    return models.map((model) => {
      const descriptor: ModelDescriptor = { ...model };
      if (model.model === defaultModel) {
        descriptor.default = true;
      } else {
        delete descriptor.default;
      }
      return descriptor;
    });
  }

  getModel(model?: string): CodexApiResponsesModel {
    return createCodexApiModel({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const env = readCodexApiEnvironment(this.options.env);
    const model = canonicalizeCodexApiModel(this.options.model ?? env.model ?? CODEX_API_DEFAULT_MODEL);
    assertCodexApiModel(model);
    return model;
  }
}

export class CodexApiResponsesModel extends ResponsesModel {
  constructor(options: CodexApiModelOptions = {}) {
    const env = readCodexApiEnvironment(options.env);
    const apiKey = nonEmptyString(options.apiKey ?? env.apiKey);
    if (!apiKey) {
      throw new Error(
        "Codex API provider requires CODEX_API_KEY (legacy OPENAI_CODEX_ACCESS_TOKEN is also supported)",
      );
    }
    const baseUrl = nonEmptyString(options.baseUrl ?? env.baseUrl);
    if (!baseUrl) {
      throw new Error(
        "Codex API provider requires CODEX_API_BASE_URL (legacy OPENAI_CODEX_BASE_URL is also supported)",
      );
    }
    if (!isAbsoluteHttpUrl(baseUrl)) {
      throw new Error("Codex API provider requires CODEX_API_BASE_URL to be an absolute HTTP(S) URL");
    }
    if (
      options.apiKey === undefined
      && env.apiKeyEnv === "OPENAI_CODEX_ACCESS_TOKEN"
      && isChatGptOAuthAccessToken(apiKey)
    ) {
      throw new Error(
        "OPENAI_CODEX_ACCESS_TOKEN looks like a ChatGPT OAuth token and cannot be used by codex-api; "
        + "use /auth login for ChatGPT OAuth or set CODEX_API_KEY explicitly for the third-party API",
      );
    }
    const model = canonicalizeCodexApiModel(options.model ?? env.model ?? CODEX_API_DEFAULT_MODEL);
    assertCodexApiModel(model);
    const fetchImpl = options.fetch ?? fetch;
    super(codexRuntimeOptions(
      CODEX_API_PROVIDER_ID,
      model,
      baseUrl,
      options,
      fetchImpl,
      false,
      async () => ({ access: apiKey }),
    ));
  }
}

export function createCodexApiProvider(options: CodexApiModelOptions = {}): CodexApiProvider {
  return new CodexApiProvider(options);
}

export function createCodexApiRouter(options: CodexApiModelOptions = {}): CodexApiResponsesModel {
  return createCodexApiModel(options);
}

export function createCodexApiModel(options: CodexApiModelOptions = {}): CodexApiResponsesModel {
  return new CodexApiResponsesModel(options);
}

export function resolveCodexApiStreamRequestOptions(
  input: ModelStreamInput,
  options: CodexApiModelOptions = {},
): CodexApiRequestBuildOptions {
  const env = readCodexApiEnvironment(options.env);
  return resolveCodexStreamRequestOptions(input, CODEX_API_PROVIDER_ID, {
    ...options,
    model: options.model ?? env.model ?? CODEX_API_DEFAULT_MODEL,
  });
}

export function resolveCodexApiResponsesUrl(baseUrl: string): string {
  const normalizedBaseUrl = nonEmptyString(baseUrl);
  if (!normalizedBaseUrl) throw new Error("Codex API provider requires a non-empty base URL");
  if (!isAbsoluteHttpUrl(normalizedBaseUrl)) {
    throw new Error("Codex API provider requires an absolute HTTP(S) base URL");
  }
  return resolveCodexResponsesUrl(normalizedBaseUrl);
}

function isChatGptOAuthAccessToken(token: string): boolean {
  try {
    extractOpenAICodexAccountId(token);
    return true;
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}
