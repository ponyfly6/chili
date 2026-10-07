import type { ChatCompletionsCompatibility } from "../../protocols/compat.js";
import { readEnvironmentSpec, type EnvironmentSource } from "../../env.js";
import { findKnownModel, listKnownModels } from "../../models.js";
import { OpenAICompletionsModel, type OpenAICompletionsModelOptions } from "../../protocols/chat-completions.js";
import type { ChiliModelProvider, ModelDescriptor, ModelInputCapability, ReasoningLevel } from "../../types.js";
import { DOUBAO_DEFINITION, DOUBAO_ENVIRONMENT } from "./config.js";
import { DOUBAO_PROVIDER_ID, DOUBAO_OPENAI_BASE_URL, DOUBAO_SEED_21_PRO_MODEL } from "./models.js";

export interface DoubaoModelOptions {
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
  /** Explicit capabilities for custom deployments; never inferred from the default model. */
  inputCapabilities?: readonly ModelInputCapability[];
  compatibility?: Partial<ChatCompletionsCompatibility>;
}

const CUSTOM_MODEL_COMPATIBILITY: ChatCompletionsCompatibility = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  reasoningEffortMap: {},
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
  requiresReasoningContentOnAssistantMessages: false,
  reasoningParameterStyle: "native",
  toolCallDeltaMode: "standard",
};

export class DoubaoOpenAIProvider implements ChiliModelProvider {
  readonly id = DOUBAO_PROVIDER_ID;
  readonly name = DOUBAO_DEFINITION.displayName;

  constructor(private readonly options: DoubaoModelOptions = {}) {}

  models(): readonly ModelDescriptor[] {
    const env = readEnvironmentSpec(DOUBAO_ENVIRONMENT, this.options.env);
    const selected = this.options.model ?? env.model ?? DOUBAO_SEED_21_PRO_MODEL;
    const baseUrl = this.options.baseUrl ?? env.baseUrl ?? DOUBAO_OPENAI_BASE_URL;
    const models = listKnownModels(this.id).map((model) => {
      const descriptor = { ...model, baseUrl };
      delete descriptor.default;
      if (model.model === selected) descriptor.default = true;
      return descriptor;
    });
    if (!models.some((model) => model.model === selected)) {
      models.unshift({ provider: this.id, model: selected, displayName: selected,
        apiFamily: "openai-completions", baseUrl, default: true });
    }
    return models;
  }

  getModel(model?: string): OpenAICompletionsModel {
    return createDoubaoModel({ ...this.options, ...(model ? { model } : {}) });
  }
}

export function createDoubaoProvider(options: DoubaoModelOptions = {}): DoubaoOpenAIProvider {
  return new DoubaoOpenAIProvider(options);
}

export function createDoubaoRouter(options: DoubaoModelOptions = {}): OpenAICompletionsModel {
  return createDoubaoModel(options);
}

export function createDoubaoModel(options: DoubaoModelOptions = {}): OpenAICompletionsModel {
  const env = readEnvironmentSpec(DOUBAO_ENVIRONMENT, options.env);
  const model = options.model ?? env.model ?? DOUBAO_SEED_21_PRO_MODEL;
  const apiKey = options.apiKey ?? env.apiKey ?? "";
  if (!apiKey) throw new Error("Doubao provider requires ARK_API_KEY or DOUBAO_API_KEY");
  const descriptor = findKnownModel(DOUBAO_PROVIDER_ID, model);
  const compatibility = {
    ...CUSTOM_MODEL_COMPATIBILITY,
    ...descriptor?.compatibility?.chatCompletions,
    ...options.compatibility,
  };
  const modelOptions: OpenAICompletionsModelOptions = {
    provider: DOUBAO_PROVIDER_ID,
    model,
    apiKey,
    baseUrl: options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? DOUBAO_OPENAI_BASE_URL,
    maxTokens: options.maxTokens ?? (descriptor
      ? Math.min(DOUBAO_DEFINITION.defaultRequestMaxTokens, descriptor.maxOutputTokens ?? Infinity)
      : DOUBAO_DEFINITION.unknownModelRequestMaxTokens),
    inputCapabilities: options.inputCapabilities ?? descriptor?.inputCapabilities ?? ["text"],
    compatibility,
  };
  if (descriptor?.capabilities?.reasoning || options.reasoning !== undefined || options.reasoningEffort !== undefined) {
    modelOptions.reasoning = options.reasoning ?? true;
  }
  if (options.reasoningEffort !== undefined) modelOptions.reasoningEffort = options.reasoningEffort;
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.fetch !== undefined) modelOptions.fetch = options.fetch;
  if (options.headers !== undefined) modelOptions.headers = options.headers;
  return new OpenAICompletionsModel(modelOptions);
}
