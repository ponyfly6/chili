import { readEnvironmentSpec } from "../../env.js";
import { listKnownModels } from "../../models.js";
import { ResponsesModel } from "../../protocols/responses.js";
import type { ChiliModelProvider, ModelDescriptor, ModelStreamInput } from "../../types.js";
import { OPENAI_ENVIRONMENT } from "./config.js";
import { canonicalizeOpenAIModel, OPENAI_BASE_URL, OPENAI_DEFAULT_MODEL, OPENAI_PROVIDER_ID } from "./models.js";
import { buildCodexResponsesRequestBody, resolveCodexStreamRequestOptions } from "./request.js";
import { codexRuntimeOptions, resolveOpenAIResponsesUrl } from "./runtime.js";
import type { OpenAIModelOptions, OpenAIRequestBuildOptions } from "./types.js";

export type { OpenAIModelOptions, OpenAIRequestBuildOptions } from "./types.js";
export { OPENAI_BASE_URL, OPENAI_DEFAULT_MODEL, OPENAI_PROVIDER_ID } from "./models.js";
export { resolveOpenAIResponsesUrl } from "./runtime.js";

/** Official API credentials are independent from ChatGPT login and gateway keys. */
export class OpenAIProvider implements ChiliModelProvider {
  readonly id = OPENAI_PROVIDER_ID;
  readonly name = "OpenAI";

  constructor(private readonly options: OpenAIModelOptions = {}) {
    this.defaultModel();
  }

  models(): readonly ModelDescriptor[] {
    const defaultModel = this.defaultModel();
    const env = readEnvironmentSpec(OPENAI_ENVIRONMENT, this.options.env);
    return listKnownModels(this.id).map((model) => {
      const descriptor: ModelDescriptor = { ...model, baseUrl: this.options.baseUrl ?? env.baseUrl ?? OPENAI_BASE_URL };
      if (model.model === defaultModel) descriptor.default = true;
      else delete descriptor.default;
      return descriptor;
    });
  }

  getModel(model?: string): OpenAIResponsesModel {
    return createOpenAIModel({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const env = readEnvironmentSpec(OPENAI_ENVIRONMENT, this.options.env);
    return canonicalizeOpenAIModel(this.options.model ?? env.model ?? OPENAI_DEFAULT_MODEL);
  }
}

export class OpenAIResponsesModel extends ResponsesModel {
  constructor(options: OpenAIModelOptions = {}) {
    const env = readEnvironmentSpec(OPENAI_ENVIRONMENT, options.env);
    const apiKey = (options.apiKey ?? env.apiKey)?.trim();
    if (!apiKey) throw new Error("OpenAI provider requires OPENAI_API_KEY");
    const baseUrl = options.baseUrl ?? env.baseUrl ?? OPENAI_BASE_URL;
    resolveOpenAIResponsesUrl(baseUrl);
    const model = canonicalizeOpenAIModel(options.model ?? env.model ?? OPENAI_DEFAULT_MODEL);
    super(codexRuntimeOptions(OPENAI_PROVIDER_ID, model, baseUrl, options, options.fetch ?? fetch, false, async () => ({ access: apiKey })));
  }
}

export function createOpenAIProvider(options: OpenAIModelOptions = {}): OpenAIProvider {
  return new OpenAIProvider(options);
}

export function createOpenAIModel(options: OpenAIModelOptions = {}): OpenAIResponsesModel {
  return new OpenAIResponsesModel(options);
}

export function resolveOpenAIStreamRequestOptions(input: ModelStreamInput, options: OpenAIModelOptions = {}): OpenAIRequestBuildOptions {
  const env = readEnvironmentSpec(OPENAI_ENVIRONMENT, options.env);
  return resolveCodexStreamRequestOptions(input, OPENAI_PROVIDER_ID, {
    ...options,
    model: options.model ?? env.model ?? OPENAI_DEFAULT_MODEL,
  });
}

export function buildOpenAIResponsesRequestBody(input: ModelStreamInput, options: OpenAIRequestBuildOptions): Record<string, unknown> {
  return buildCodexResponsesRequestBody(input, options, true, false);
}
