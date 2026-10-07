import { ZAI_DEFINITION, ZAI_ENVIRONMENT } from "./config.js";
import type { ChiliModel, ChiliModelProvider, ModelDescriptor, ReasoningLevel } from "../../types.js";
import { AnthropicCompatibleModel, type AnthropicCompatibleModelOptions } from "../../protocols/messages.js";
import { type EnvironmentSource, readEnvironmentSpec } from "../../env.js";
import { findDefaultKnownModel, findKnownModel, listKnownModels } from "../../models.js";
import {
  ZAI_GLM_53_MODEL,
  ZAI_OPENAI_BASE_URL,
  ZAI_PROVIDER_ID,
} from "./models.js";
import { OpenAICompletionsModel, type OpenAICompletionsModelOptions } from "../../protocols/chat-completions.js";

export { ZAI_GLM_53_MODEL, ZAI_GLM_53_FLASH_MODEL, ZAI_GLM_53_FLASHX_MODEL, ZAI_OPENAI_BASE_URL, ZAI_PROVIDER_ID } from "./models.js";

export interface ZaiModelOptions {
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
}


export class ZaiOpenAIProvider implements ChiliModelProvider {
  readonly id = ZAI_PROVIDER_ID;
  readonly name = "Z.ai";

  constructor(private readonly options: ZaiModelOptions = {}) {}

  models(): readonly ModelDescriptor[] {
    const models = listKnownModels(this.id);
    const defaultModel = this.defaultModel();
    if (models.some((model) => model.model === defaultModel)) {
      return models.map((model) => {
        const descriptor: ModelDescriptor = { ...model };
        if (model.model === defaultModel) {
          descriptor.baseUrl = this.defaultBaseUrl();
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
      apiFamily: fallback?.apiFamily ?? "openai-completions",
      baseUrl: this.defaultBaseUrl(),
      default: true,
    };
    if (fallback?.capabilities) descriptor.capabilities = fallback.capabilities;
    if (fallback?.compatibility) descriptor.compatibility = fallback.compatibility;
    if (fallback?.inputCapabilities) descriptor.inputCapabilities = fallback.inputCapabilities;
    if (fallback?.contextWindowTokens !== undefined) descriptor.contextWindowTokens = fallback.contextWindowTokens;
    if (fallback?.maxOutputTokens !== undefined) descriptor.maxOutputTokens = fallback.maxOutputTokens;
    return [descriptor, ...models.map(withoutDefaultFlag)];
  }

  getModel(model?: string): ChiliModel {
    return createZaiModel({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const env = readEnvironmentSpec(ZAI_ENVIRONMENT, this.options.env);
    return this.options.model ?? env.model ?? ZAI_GLM_53_MODEL;
  }

  private defaultBaseUrl(): string {
    const env = readEnvironmentSpec(ZAI_ENVIRONMENT, this.options.env);
    const descriptor = findKnownModel(this.id, this.defaultModel()) ?? findDefaultKnownModel(this.id);
    return this.options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? ZAI_OPENAI_BASE_URL;
  }
}

function withoutDefaultFlag(model: ModelDescriptor): ModelDescriptor {
  const descriptor: ModelDescriptor = { ...model };
  delete descriptor.default;
  return descriptor;
}

export function createZaiProvider(options: ZaiModelOptions = {}): ZaiOpenAIProvider {
  return new ZaiOpenAIProvider(options);
}

export function createZaiRouter(options: ZaiModelOptions = {}): ChiliModel {
  return createZaiModel(options);
}

export function createZaiModel(options: ZaiModelOptions = {}): ChiliModel {
  const env = readEnvironmentSpec(ZAI_ENVIRONMENT, options.env);
  const model = options.model ?? env.model ?? ZAI_GLM_53_MODEL;
  const apiKey = options.apiKey ?? env.apiKey ?? "";
  if (!apiKey) throw new Error("Z.ai provider requires ZAI_API_KEY");
  const descriptor = findKnownModel(ZAI_PROVIDER_ID, model) ?? findDefaultKnownModel(ZAI_PROVIDER_ID);
  const baseUrl = options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? ZAI_OPENAI_BASE_URL;
  const maxTokens = options.maxTokens ?? ZAI_DEFINITION.defaultRequestMaxTokens;
  if (isAnthropicEndpoint(baseUrl)) {
    const modelOptions: AnthropicCompatibleModelOptions = {
      provider: ZAI_PROVIDER_ID,
      model,
      baseUrl,
      apiKey,
      authScheme: "bearer",
      maxTokens,
    };
    if (descriptor?.inputCapabilities) modelOptions.inputCapabilities = descriptor.inputCapabilities;
    if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
    if (options.fetch !== undefined) modelOptions.fetch = options.fetch;
    if (options.headers !== undefined) modelOptions.headers = options.headers;
    return new AnthropicCompatibleModel(modelOptions);
  }
  const modelOptions: OpenAICompletionsModelOptions = {
    provider: ZAI_PROVIDER_ID,
    model,
    baseUrl,
    apiKey,
    maxTokens,
  };
  if (descriptor?.inputCapabilities) modelOptions.inputCapabilities = descriptor.inputCapabilities;
  if (descriptor?.compatibility?.chatCompletions) modelOptions.compatibility = descriptor.compatibility.chatCompletions;
  modelOptions.reasoning = true;
  const reasoningEffort = options.reasoning === false ? "off" : options.reasoningEffort;
  if (reasoningEffort !== undefined) modelOptions.reasoningEffort = reasoningEffort;
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.fetch !== undefined) modelOptions.fetch = options.fetch;
  if (options.headers !== undefined) modelOptions.headers = options.headers;
  return new OpenAICompletionsModel(modelOptions);
}

function isAnthropicEndpoint(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, "").endsWith("/anthropic") || baseUrl.replace(/\/+$/, "").endsWith("/v1/messages");
}
