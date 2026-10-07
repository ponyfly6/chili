import { BUILTIN_PROVIDERS } from "./provider-definition.js";
import type { ChiliModelProvider, ModelDescriptor, ReasoningLevel } from "./types.js";
import { type EnvironmentSource, readXaiEnvironment } from "./env.js";
import {
  findDefaultKnownModel,
  findKnownModel,
  listKnownModels,
  XAI_GROK_46_MODEL,
  XAI_OPENAI_BASE_URL,
  XAI_PROVIDER_ID,
} from "./models.js";
import { OpenAICompletionsModel, type OpenAICompletionsModelOptions } from "./openai-completions.js";

export { XAI_GROK_46_MODEL, XAI_OPENAI_BASE_URL, XAI_PROVIDER_ID } from "./models.js";

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
}

const DEFAULT_XAI_REASONING_EFFORT: ReasoningLevel = "high";

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

    const fallback = findDefaultKnownModel(this.id);
    const descriptor: ModelDescriptor = {
      provider: this.id,
      model: defaultModel,
      displayName: defaultModel,
      apiFamily: fallback?.apiFamily ?? "openai-completions",
      baseUrl: this.defaultBaseUrl(),
      default: true,
    };
    copyFallbackDescriptorFields(descriptor, fallback);
    return [descriptor, ...models.map(withoutDefaultFlag)];
  }

  getModel(model?: string): OpenAICompletionsModel {
    return createXaiModel({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const env = readXaiEnvironment(this.options.env);
    return this.options.model ?? env.model ?? XAI_GROK_46_MODEL;
  }

  private defaultBaseUrl(): string {
    const env = readXaiEnvironment(this.options.env);
    const descriptor = findKnownModel(this.id, this.defaultModel()) ?? findDefaultKnownModel(this.id);
    return this.options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? XAI_OPENAI_BASE_URL;
  }
}

export function createXaiProvider(options: XaiModelOptions = {}): XaiOpenAIProvider {
  return new XaiOpenAIProvider(options);
}

export function createXaiRouter(options: XaiModelOptions = {}): OpenAICompletionsModel {
  return createXaiModel(options);
}

export function createXaiModel(options: XaiModelOptions = {}): OpenAICompletionsModel {
  const env = readXaiEnvironment(options.env);
  const model = options.model ?? env.model ?? XAI_GROK_46_MODEL;
  const apiKey = options.apiKey ?? env.apiKey ?? "";
  if (!apiKey) throw new Error("xAI provider requires XAI_API_KEY");

  const descriptor = findKnownModel(XAI_PROVIDER_ID, model) ?? findDefaultKnownModel(XAI_PROVIDER_ID);
  const modelOptions: OpenAICompletionsModelOptions = {
    provider: XAI_PROVIDER_ID,
    model,
    baseUrl: options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? XAI_OPENAI_BASE_URL,
    apiKey,
    maxTokens: options.maxTokens ?? BUILTIN_PROVIDERS.xai.defaultRequestMaxTokens,
    reasoning: options.reasoning ?? true,
  };
  if (descriptor?.inputCapabilities) modelOptions.inputCapabilities = descriptor.inputCapabilities;
  if (descriptor?.compatibility?.chatCompletions) modelOptions.compatibility = descriptor.compatibility.chatCompletions;
  if (modelOptions.reasoning) {
    modelOptions.reasoningEffort = options.reasoningEffort ?? DEFAULT_XAI_REASONING_EFFORT;
  }
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.fetch !== undefined) modelOptions.fetch = options.fetch;
  if (options.headers !== undefined) modelOptions.headers = options.headers;
  return new OpenAICompletionsModel(modelOptions);
}

function withoutDefaultFlag(model: ModelDescriptor): ModelDescriptor {
  const descriptor: ModelDescriptor = { ...model };
  delete descriptor.default;
  return descriptor;
}

function copyFallbackDescriptorFields(target: ModelDescriptor, fallback: ModelDescriptor | undefined): void {
  if (fallback?.capabilities) target.capabilities = fallback.capabilities;
  if (fallback?.compatibility) target.compatibility = fallback.compatibility;
  if (fallback?.inputCapabilities) target.inputCapabilities = fallback.inputCapabilities;
  if (fallback?.contextWindowTokens !== undefined) target.contextWindowTokens = fallback.contextWindowTokens;
  if (fallback?.maxOutputTokens !== undefined) target.maxOutputTokens = fallback.maxOutputTokens;
  if (fallback?.reasoningLevels) target.reasoningLevels = fallback.reasoningLevels;
  if (fallback?.serviceTiers) target.serviceTiers = fallback.serviceTiers;
  if (fallback?.cost) target.cost = fallback.cost;
}
