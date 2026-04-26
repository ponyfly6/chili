import type { ChiliModelProvider, ModelDescriptor } from "./types.js";
import {
  AnthropicCompatibleModel,
  type AnthropicAuthScheme,
  type AnthropicCompatibleModelOptions,
} from "./anthropic-compatible.js";
import { type EnvironmentSource, readMiniMaxEnvironment } from "./env.js";
import {
  findDefaultKnownModel,
  findKnownModel,
  listKnownModels,
  MINIMAX_ANTHROPIC_BASE_URL,
  MINIMAX_M27_HIGHSPEED_MODEL,
  MINIMAX_PROVIDER_ID,
} from "./models.js";

export { MINIMAX_ANTHROPIC_BASE_URL, MINIMAX_M27_HIGHSPEED_MODEL, MINIMAX_PROVIDER_ID } from "./models.js";

export interface MiniMaxModelOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  authScheme?: AnthropicAuthScheme;
  env?: EnvironmentSource;
}

export class MiniMaxAnthropicProvider implements ChiliModelProvider {
  readonly id = MINIMAX_PROVIDER_ID;
  readonly name = "MiniMax";

  constructor(private readonly options: MiniMaxModelOptions = {}) {}

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
      apiFamily: fallback?.apiFamily ?? "anthropic-messages",
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

  getModel(model?: string): AnthropicCompatibleModel {
    return createMiniMaxM27HighspeedModel({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const env = readMiniMaxEnvironment(this.options.env);
    return this.options.model ?? env.model ?? MINIMAX_M27_HIGHSPEED_MODEL;
  }

  private defaultBaseUrl(): string {
    const env = readMiniMaxEnvironment(this.options.env);
    const descriptor = findKnownModel(this.id, this.defaultModel()) ?? findDefaultKnownModel(this.id);
    return this.options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? MINIMAX_ANTHROPIC_BASE_URL;
  }
}

function withoutDefaultFlag(model: ModelDescriptor): ModelDescriptor {
  const descriptor: ModelDescriptor = { ...model };
  delete descriptor.default;
  return descriptor;
}

export function createMiniMaxProvider(options: MiniMaxModelOptions = {}): MiniMaxAnthropicProvider {
  return new MiniMaxAnthropicProvider(options);
}

export function createMiniMaxRouter(options: MiniMaxModelOptions = {}): AnthropicCompatibleModel {
  return createMiniMaxM27HighspeedModel(options);
}

export function createMiniMaxM27HighspeedModel(options: MiniMaxModelOptions = {}): AnthropicCompatibleModel {
  const env = readMiniMaxEnvironment(options.env);
  const model = options.model ?? env.model ?? MINIMAX_M27_HIGHSPEED_MODEL;
  const descriptor = findKnownModel(MINIMAX_PROVIDER_ID, model) ?? findDefaultKnownModel(MINIMAX_PROVIDER_ID);
  const modelOptions: AnthropicCompatibleModelOptions = {
    provider: MINIMAX_PROVIDER_ID,
    model,
    baseUrl: options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? MINIMAX_ANTHROPIC_BASE_URL,
    apiKey: options.apiKey ?? env.apiKey ?? "",
    authScheme: options.authScheme ?? "bearer",
  };
  if (options.maxTokens !== undefined) modelOptions.maxTokens = options.maxTokens;
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.fetch !== undefined) modelOptions.fetch = options.fetch;
  if (options.headers !== undefined) modelOptions.headers = options.headers;
  return new AnthropicCompatibleModel(modelOptions);
}
