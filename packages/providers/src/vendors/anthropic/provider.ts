import { AnthropicCompatibleModel, type AnthropicCompatibleModelOptions } from "../../protocols/messages.js";
import { type EnvironmentSource, readEnvironmentSpec } from "../../env.js";
import { findKnownModel, listKnownModels } from "../../models.js";
import type { ChiliModelProvider, ModelDescriptor, ReasoningLevel } from "../../types.js";
import type { ProviderBackpressureCoordinator } from "../../runtime/backpressure.js";
import { ANTHROPIC_DEFINITION, ANTHROPIC_ENVIRONMENT } from "./config.js";
import { ANTHROPIC_BASE_URL, ANTHROPIC_MODELS, ANTHROPIC_OPUS_55_MODEL, ANTHROPIC_PROVIDER_ID } from "./models.js";

export interface AnthropicModelOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: boolean;
  reasoningEffort?: ReasoningLevel;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  backpressureCoordinator?: ProviderBackpressureCoordinator;
  env?: EnvironmentSource;
}

export class AnthropicProvider implements ChiliModelProvider {
  readonly id = ANTHROPIC_PROVIDER_ID;
  readonly name = "Anthropic";

  constructor(private readonly options: AnthropicModelOptions = {}) {}

  models(): readonly ModelDescriptor[] {
    const env = readEnvironmentSpec(ANTHROPIC_ENVIRONMENT, this.options.env);
    const selected = this.options.model ?? env.model ?? ANTHROPIC_OPUS_55_MODEL;
    const registered = listKnownModels(this.id);
    const catalog = registered.length ? registered : structuredClone(ANTHROPIC_MODELS);
    const models = catalog.map((model) => {
      const descriptor = { ...model };
      delete descriptor.default;
      if (model.model === selected) {
        descriptor.default = true;
        descriptor.baseUrl = this.options.baseUrl ?? env.baseUrl ?? model.baseUrl ?? ANTHROPIC_BASE_URL;
      }
      return descriptor;
    });
    if (!models.some((model) => model.model === selected)) {
      models.unshift({
        provider: this.id, model: selected, displayName: selected, apiFamily: "anthropic-messages",
        baseUrl: this.options.baseUrl ?? env.baseUrl ?? ANTHROPIC_BASE_URL, default: true,
      });
    }
    return models;
  }

  getModel(model?: string): AnthropicCompatibleModel {
    return createAnthropicRouter({ ...this.options, ...(model ? { model } : {}) });
  }
}

export function createAnthropicProvider(options: AnthropicModelOptions = {}): AnthropicProvider {
  return new AnthropicProvider(options);
}

export function createAnthropicRouter(options: AnthropicModelOptions = {}): AnthropicCompatibleModel {
  const env = readEnvironmentSpec(ANTHROPIC_ENVIRONMENT, options.env);
  const model = options.model ?? env.model ?? ANTHROPIC_OPUS_55_MODEL;
  const descriptor = findKnownModel(ANTHROPIC_PROVIDER_ID, model) ?? ANTHROPIC_MODELS.find((entry) => entry.model === model);
  const maxTokens = Math.min(options.maxTokens ?? ANTHROPIC_DEFINITION.defaultRequestMaxTokens, descriptor?.maxOutputTokens ?? Infinity);
  const modelOptions: AnthropicCompatibleModelOptions = {
    provider: ANTHROPIC_PROVIDER_ID,
    model,
    apiKey: options.apiKey ?? env.apiKey ?? "",
    baseUrl: options.baseUrl ?? env.baseUrl ?? ANTHROPIC_BASE_URL,
    authScheme: "x-api-key",
    maxTokens,
    // Unknown model IDs get no guessed thinking mode. Explicit catalog registration
    // can add their exact capabilities without silently borrowing Opus settings.
    compatibility: descriptor?.compatibility?.messages ?? { supportsThinkingReplay: true },
  };
  if (descriptor?.maxOutputTokens !== undefined) modelOptions.maxOutputTokens = descriptor.maxOutputTokens;
  if (descriptor?.inputCapabilities) modelOptions.inputCapabilities = descriptor.inputCapabilities;
  if (descriptor?.compatibility?.messages?.supportsBudgetThinking || descriptor?.compatibility?.messages?.supportsAdaptiveReasoningEffort) {
    modelOptions.reasoning = options.reasoning ?? true;
  }
  if (options.reasoningEffort !== undefined) modelOptions.reasoningEffort = options.reasoningEffort;
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.fetch !== undefined) modelOptions.fetch = options.fetch;
  if (options.headers !== undefined) modelOptions.headers = options.headers;
  if (options.backpressureCoordinator !== undefined) modelOptions.backpressureCoordinator = options.backpressureCoordinator;
  return new AnthropicCompatibleModel(modelOptions);
}
