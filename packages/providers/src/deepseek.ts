import type { ChiliModelProvider, ModelDescriptor } from "./types.js";
import { type EnvironmentSource, readDeepSeekEnvironment } from "./env.js";
import {
  DEEPSEEK_OPENAI_BASE_URL,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_V4_PRO_MODEL,
  findDefaultKnownModel,
  findKnownModel,
  listKnownModels,
} from "./models.js";
import { OpenAICompletionsModel, type OpenAICompletionsModelOptions } from "./openai-completions.js";

export {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_OPENAI_BASE_URL,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_V4_FLASH_MODEL,
  DEEPSEEK_V4_PRO_MODEL,
} from "./models.js";

export interface DeepSeekModelOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  reasoning?: boolean;
  env?: EnvironmentSource;
}

const DEFAULT_DEEPSEEK_MAX_TOKENS = 128 * 1024;

export class DeepSeekOpenAIProvider implements ChiliModelProvider {
  readonly id = DEEPSEEK_PROVIDER_ID;
  readonly name = "DeepSeek";

  constructor(private readonly options: DeepSeekModelOptions = {}) {}

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
    if (fallback?.capabilities) descriptor.capabilities = fallback.capabilities;
    if (fallback?.compatibility) descriptor.compatibility = fallback.compatibility;
    if (fallback?.inputCapabilities) descriptor.inputCapabilities = fallback.inputCapabilities;
    if (fallback?.contextWindowTokens !== undefined) descriptor.contextWindowTokens = fallback.contextWindowTokens;
    if (fallback?.maxOutputTokens !== undefined) descriptor.maxOutputTokens = fallback.maxOutputTokens;
    return [descriptor, ...models.map(withoutDefaultFlag)];
  }

  getModel(model?: string): OpenAICompletionsModel {
    return createDeepSeekV4Model({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const env = readDeepSeekEnvironment(this.options.env);
    return this.options.model ?? env.model ?? DEEPSEEK_V4_PRO_MODEL;
  }

  private defaultBaseUrl(): string {
    const env = readDeepSeekEnvironment(this.options.env);
    const descriptor = findKnownModel(this.id, this.defaultModel()) ?? findDefaultKnownModel(this.id);
    return this.options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? DEEPSEEK_OPENAI_BASE_URL;
  }
}

function withoutDefaultFlag(model: ModelDescriptor): ModelDescriptor {
  const descriptor: ModelDescriptor = { ...model };
  delete descriptor.default;
  return descriptor;
}

export function createDeepSeekProvider(options: DeepSeekModelOptions = {}): DeepSeekOpenAIProvider {
  return new DeepSeekOpenAIProvider(options);
}

export function createDeepSeekRouter(options: DeepSeekModelOptions = {}): OpenAICompletionsModel {
  return createDeepSeekV4Model(options);
}

export function createDeepSeekV4Model(options: DeepSeekModelOptions = {}): OpenAICompletionsModel {
  const env = readDeepSeekEnvironment(options.env);
  const model = options.model ?? env.model ?? DEEPSEEK_V4_PRO_MODEL;
  const descriptor = findKnownModel(DEEPSEEK_PROVIDER_ID, model) ?? findDefaultKnownModel(DEEPSEEK_PROVIDER_ID);
  const modelOptions: OpenAICompletionsModelOptions = {
    provider: DEEPSEEK_PROVIDER_ID,
    model,
    baseUrl: resolveDeepSeekCompletionsUrl(options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? DEEPSEEK_OPENAI_BASE_URL),
    apiKey: options.apiKey ?? env.apiKey ?? "",
    reasoning: options.reasoning ?? true,
    maxTokens: options.maxTokens ?? DEFAULT_DEEPSEEK_MAX_TOKENS,
  };
  if (descriptor?.inputCapabilities) modelOptions.inputCapabilities = descriptor.inputCapabilities;
  if (descriptor?.compatibility?.chatCompletions) modelOptions.compatibility = descriptor.compatibility.chatCompletions;
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.fetch !== undefined) modelOptions.fetch = options.fetch;
  if (options.headers !== undefined) modelOptions.headers = options.headers;
  return new OpenAICompletionsModel(modelOptions);
}

export function resolveDeepSeekCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  if (clean.endsWith("/chat/completions")) return clean;
  if (clean === DEEPSEEK_OPENAI_BASE_URL) return `${clean}/chat/completions`;
  return clean;
}
