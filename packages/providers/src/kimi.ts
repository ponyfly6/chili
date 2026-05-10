import type { ChiliModelProvider, ModelDescriptor } from "./types.js";
import { type EnvironmentSource, readKimiEnvironment } from "./env.js";
import {
  findDefaultKnownModel,
  findKnownModel,
  KIMI_K26_MODEL,
  KIMI_OPENAI_BASE_URL,
  KIMI_PROVIDER_ID,
  listKnownModels,
} from "./models.js";
import { OpenAICompletionsModel, type OpenAICompletionsModelOptions } from "./openai-completions.js";

export { KIMI_K26_MODEL, KIMI_OPENAI_BASE_URL, KIMI_PROVIDER_ID } from "./models.js";

export interface KimiModelOptions {
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

const DEFAULT_KIMI_MAX_TOKENS = 32 * 1024;

export class KimiOpenAIProvider implements ChiliModelProvider {
  readonly id = KIMI_PROVIDER_ID;
  readonly name = "Kimi";

  constructor(private readonly options: KimiModelOptions = {}) {}

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
    return createKimiModel({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const env = readKimiEnvironment(this.options.env);
    return this.options.model ?? env.model ?? KIMI_K26_MODEL;
  }

  private defaultBaseUrl(): string {
    const env = readKimiEnvironment(this.options.env);
    const descriptor = findKnownModel(this.id, this.defaultModel()) ?? findDefaultKnownModel(this.id);
    return this.options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? KIMI_OPENAI_BASE_URL;
  }
}

function withoutDefaultFlag(model: ModelDescriptor): ModelDescriptor {
  const descriptor: ModelDescriptor = { ...model };
  delete descriptor.default;
  return descriptor;
}

export function createKimiProvider(options: KimiModelOptions = {}): KimiOpenAIProvider {
  return new KimiOpenAIProvider(options);
}

export function createKimiRouter(options: KimiModelOptions = {}): OpenAICompletionsModel {
  return createKimiModel(options);
}

export function createMoonshotProvider(options: KimiModelOptions = {}): KimiOpenAIProvider {
  return createKimiProvider(options);
}

export function createMoonshotRouter(options: KimiModelOptions = {}): OpenAICompletionsModel {
  return createKimiModel(options);
}

export function createKimiModel(options: KimiModelOptions = {}): OpenAICompletionsModel {
  const env = readKimiEnvironment(options.env);
  const model = options.model ?? env.model ?? KIMI_K26_MODEL;
  const apiKey = options.apiKey ?? env.apiKey ?? "";
  if (!apiKey) {
    throw new Error("Kimi provider requires MOONSHOT_API_KEY or KIMI_API_KEY");
  }
  const descriptor = findKnownModel(KIMI_PROVIDER_ID, model) ?? findDefaultKnownModel(KIMI_PROVIDER_ID);
  const modelOptions: OpenAICompletionsModelOptions = {
    provider: KIMI_PROVIDER_ID,
    model,
    baseUrl: options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? KIMI_OPENAI_BASE_URL,
    apiKey,
    maxTokens: options.maxTokens ?? DEFAULT_KIMI_MAX_TOKENS,
  };
  if (descriptor?.inputCapabilities) modelOptions.inputCapabilities = descriptor.inputCapabilities;
  if (descriptor?.compatibility?.chatCompletions) modelOptions.compatibility = descriptor.compatibility.chatCompletions;
  if (options.reasoning !== undefined) modelOptions.reasoning = options.reasoning;
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.fetch !== undefined) modelOptions.fetch = options.fetch;
  if (options.headers !== undefined) modelOptions.headers = options.headers;
  return new OpenAICompletionsModel(modelOptions);
}
