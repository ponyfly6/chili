import { XAI_ENVIRONMENT } from "./config.js";
import type { ChiliModelProvider, ModelDescriptor, ReasoningLevel } from "../../types.js";
import { type EnvironmentSource, readEnvironmentSpec } from "../../env.js";
import { findKnownModel, listKnownModels } from "../../models.js";
import {
  XAI_GROK_47_MODEL,
  XAI_OPENAI_BASE_URL,
  XAI_PROVIDER_ID,
} from "./models.js";
import { createApiKeyResponsesModel } from "../../protocols/api-key-responses.js";
import type { ResponsesModel } from "../../protocols/responses.js";
import type { ProviderBackpressureCoordinator } from "../../runtime/backpressure.js";
import { buildXaiResponsesRequestBody, resolveXaiResponsesUrl, resolveXaiStreamRequestOptions } from "./request.js";

export { XAI_GROK_46_MODEL, XAI_GROK_47_MODEL, XAI_OPENAI_BASE_URL, XAI_PROVIDER_ID } from "./models.js";

export interface XaiModelOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  reasoning?: boolean;
  reasoningEffort?: ReasoningLevel;
  env?: EnvironmentSource;
  backpressureCoordinator?: ProviderBackpressureCoordinator;
}

export class XaiOpenAIProvider implements ChiliModelProvider {
  readonly id = XAI_PROVIDER_ID;
  readonly name = "xAI";

  constructor(private readonly options: XaiModelOptions = {}) {}

  models(): readonly ModelDescriptor[] {
    const models = listKnownModels(this.id);
    const defaultModel = this.defaultModel();
    if (models.some((model) => model.model === defaultModel)) {
      return models.map((model) => {
        const descriptor: ModelDescriptor = { ...model, baseUrl: this.defaultBaseUrl() };
        if (model.model === defaultModel) {
          descriptor.default = true;
        } else {
          delete descriptor.default;
        }
        return descriptor;
      });
    }

    const descriptor: ModelDescriptor = {
      provider: this.id,
      model: defaultModel,
      displayName: defaultModel,
      apiFamily: "openai-responses",
      baseUrl: this.defaultBaseUrl(),
      default: true,
    };
    return [descriptor, ...models.map(withoutDefaultFlag)];
  }

  getModel(model?: string): ResponsesModel {
    return createXaiModel({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const env = readEnvironmentSpec(XAI_ENVIRONMENT, this.options.env);
    return this.options.model ?? env.model ?? XAI_GROK_47_MODEL;
  }

  private defaultBaseUrl(): string {
    const env = readEnvironmentSpec(XAI_ENVIRONMENT, this.options.env);
    const descriptor = findKnownModel(this.id, this.defaultModel());
    return this.options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? XAI_OPENAI_BASE_URL;
  }
}

export function createXaiProvider(options: XaiModelOptions = {}): XaiOpenAIProvider {
  return new XaiOpenAIProvider(options);
}

export function createXaiRouter(options: XaiModelOptions = {}): ResponsesModel {
  return createXaiModel(options);
}

export function createXaiModel(options: XaiModelOptions = {}): ResponsesModel {
  const env = readEnvironmentSpec(XAI_ENVIRONMENT, options.env);
  const model = options.model ?? env.model ?? XAI_GROK_47_MODEL;
  const apiKey = options.apiKey ?? env.apiKey ?? "";
  if (!apiKey) throw new Error("xAI provider requires XAI_API_KEY");

  const descriptor = findKnownModel(XAI_PROVIDER_ID, model);
  return createApiKeyResponsesModel({
    provider: XAI_PROVIDER_ID,
    model,
    endpoint: resolveXaiResponsesUrl(options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? XAI_OPENAI_BASE_URL),
    apiKey,
    providerLabel: "xAI",
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.backpressureCoordinator ? { backpressureCoordinator: options.backpressureCoordinator } : {}),
    resolveRequestOptions: (input) => resolveXaiStreamRequestOptions(input, { ...options, model }),
    buildRequestBody: buildXaiResponsesRequestBody,
  });
}

function withoutDefaultFlag(model: ModelDescriptor): ModelDescriptor {
  const descriptor: ModelDescriptor = { ...model };
  delete descriptor.default;
  return descriptor;
}
