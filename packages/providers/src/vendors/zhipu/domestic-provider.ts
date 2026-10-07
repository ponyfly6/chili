import { readEnvironmentSpec, type EnvironmentSource } from "../../env.js";
import { findKnownModel, listKnownModels } from "../../models.js";
import { OpenAICompletionsModel, type OpenAICompletionsModelOptions } from "../../protocols/chat-completions.js";
import type { ChiliModel, ChiliModelProvider, ModelDescriptor, ReasoningLevel } from "../../types.js";
import { ZHIPU_DEFINITION, ZHIPU_ENVIRONMENT } from "./domestic-config.js";
import { ZHIPU_GLM_53_MODEL, ZHIPU_OPENAI_BASE_URL, ZHIPU_PROVIDER_ID } from "./domestic-models.js";
import { createGlmResponsesModel, isGlmResponsesEndpoint } from "./responses.js";

export interface ZhipuModelOptions {
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

export class ZhipuProvider implements ChiliModelProvider {
  readonly id = ZHIPU_PROVIDER_ID;
  readonly name = ZHIPU_DEFINITION.displayName;

  constructor(private readonly options: ZhipuModelOptions = {}) {}

  models(): readonly ModelDescriptor[] {
    const environment = readEnvironmentSpec(ZHIPU_ENVIRONMENT, this.options.env);
    const selectedModel = this.options.model ?? environment.model ?? ZHIPU_GLM_53_MODEL;
    const baseUrl = this.options.baseUrl ?? environment.baseUrl;
    const models = listKnownModels(this.id).map((model): ModelDescriptor => {
      const descriptor = { ...model };
      delete descriptor.default;
      if (baseUrl !== undefined && isGlmResponsesEndpoint(baseUrl)) {
        descriptor.baseUrl = baseUrl;
        descriptor.apiFamily = "openai-responses";
      }
      if (model.model === selectedModel) {
        descriptor.default = true;
        if (baseUrl !== undefined) descriptor.baseUrl = baseUrl;
      }
      return descriptor;
    });
    if (!models.some((model) => model.model === selectedModel)) {
      models.unshift({
        provider: this.id,
        model: selectedModel,
        displayName: selectedModel,
        apiFamily: isGlmResponsesEndpoint(baseUrl ?? ZHIPU_OPENAI_BASE_URL) ? "openai-responses" : "openai-completions",
        baseUrl: baseUrl ?? ZHIPU_OPENAI_BASE_URL,
        default: true,
      });
    }
    return models;
  }

  getModel(model?: string): ChiliModel {
    return createZhipuModel({ ...this.options, ...(model ? { model } : {}) });
  }
}

export function createZhipuProvider(options: ZhipuModelOptions = {}): ZhipuProvider {
  return new ZhipuProvider(options);
}

export function createZhipuRouter(options: ZhipuModelOptions = {}): ChiliModel {
  return createZhipuModel(options);
}

export function createZhipuModel(options: ZhipuModelOptions = {}): ChiliModel {
  const environment = readEnvironmentSpec(ZHIPU_ENVIRONMENT, options.env);
  const apiKey = options.apiKey ?? environment.apiKey ?? "";
  if (!apiKey) throw new Error("智谱 BigModel provider requires ZHIPU_API_KEY or BIGMODEL_API_KEY");
  const model = options.model ?? environment.model ?? ZHIPU_GLM_53_MODEL;
  const descriptor = findKnownModel(ZHIPU_PROVIDER_ID, model);
  const baseUrl = options.baseUrl ?? environment.baseUrl ?? descriptor?.baseUrl ?? ZHIPU_OPENAI_BASE_URL;
  const maxTokens = options.maxTokens ?? (descriptor
    ? Math.min(ZHIPU_DEFINITION.defaultRequestMaxTokens, descriptor.maxOutputTokens ?? Infinity)
    : ZHIPU_DEFINITION.unknownModelRequestMaxTokens);
  if (isGlmResponsesEndpoint(baseUrl)) {
    return createGlmResponsesModel({
      ...options, provider: ZHIPU_PROVIDER_ID, model, apiKey, baseUrl, maxTokens,
      ...(descriptor === undefined ? {} : { descriptor }),
    });
  }
  const modelOptions: OpenAICompletionsModelOptions = {
    provider: ZHIPU_PROVIDER_ID,
    model,
    apiKey,
    baseUrl,
    maxTokens,
    inputCapabilities: descriptor?.inputCapabilities ?? ["text"],
    compatibility: descriptor?.compatibility?.chatCompletions ?? {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      requiresReasoningContentOnAssistantMessages: false,
      maxTokensField: "max_tokens",
      reasoningParameterStyle: "native",
      toolCallDeltaMode: "standard",
    },
  };
  if (descriptor?.capabilities?.reasoning) modelOptions.reasoning = true;
  const effort = options.reasoning === false ? "off" : options.reasoningEffort;
  if (effort !== undefined) modelOptions.reasoningEffort = effort;
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.fetch !== undefined) modelOptions.fetch = options.fetch;
  if (options.headers !== undefined) modelOptions.headers = options.headers;
  return new OpenAICompletionsModel(modelOptions);
}
