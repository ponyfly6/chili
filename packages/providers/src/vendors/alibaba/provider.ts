import type { ChatCompletionsCompatibility } from "../../protocols/compat.js";
import { readEnvironmentSpec, type EnvironmentSource } from "../../env.js";
import { findKnownModel, listKnownModels } from "../../models.js";
import { OpenAICompletionsModel, type OpenAICompletionsModelOptions } from "../../protocols/chat-completions.js";
import type { ChiliModelProvider, ModelDescriptor, ModelInputCapability, ReasoningLevel } from "../../types.js";
import { ALIBABA_DEFINITION, ALIBABA_ENVIRONMENT } from "./config.js";
import { ALIBABA_PROVIDER_ID, ALIBABA_OPENAI_BASE_URL, QWEN_38_MAX_MODEL } from "./models.js";

export interface AlibabaModelOptions {
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

export class AlibabaOpenAIProvider implements ChiliModelProvider {
  readonly id = ALIBABA_PROVIDER_ID;
  readonly name = ALIBABA_DEFINITION.displayName;

  constructor(private readonly options: AlibabaModelOptions = {}) {}

  models(): readonly ModelDescriptor[] {
    const env = readEnvironmentSpec(ALIBABA_ENVIRONMENT, this.options.env);
    const selected = this.options.model ?? env.model ?? QWEN_38_MAX_MODEL;
    const baseUrl = this.options.baseUrl ?? env.baseUrl ?? ALIBABA_OPENAI_BASE_URL;
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
    return createAlibabaModel({ ...this.options, ...(model ? { model } : {}) });
  }
}

export function createAlibabaProvider(options: AlibabaModelOptions = {}): AlibabaOpenAIProvider {
  return new AlibabaOpenAIProvider(options);
}

export function createAlibabaRouter(options: AlibabaModelOptions = {}): OpenAICompletionsModel {
  return createAlibabaModel(options);
}

export function createAlibabaModel(options: AlibabaModelOptions = {}): OpenAICompletionsModel {
  const env = readEnvironmentSpec(ALIBABA_ENVIRONMENT, options.env);
  const model = options.model ?? env.model ?? QWEN_38_MAX_MODEL;
  const apiKey = options.apiKey ?? env.apiKey ?? "";
  if (!apiKey) throw new Error("Alibaba provider requires DASHSCOPE_API_KEY or ALIBABA_API_KEY");
  const descriptor = findKnownModel(ALIBABA_PROVIDER_ID, model);
  const compatibility = {
    ...CUSTOM_MODEL_COMPATIBILITY,
    ...descriptor?.compatibility?.chatCompletions,
    ...options.compatibility,
  };
  const modelOptions: OpenAICompletionsModelOptions = {
    provider: ALIBABA_PROVIDER_ID,
    model,
    apiKey,
    baseUrl: options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? ALIBABA_OPENAI_BASE_URL,
    maxTokens: options.maxTokens ?? (descriptor
      ? Math.min(ALIBABA_DEFINITION.defaultRequestMaxTokens, descriptor.maxOutputTokens ?? Infinity)
      : ALIBABA_DEFINITION.unknownModelRequestMaxTokens),
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
