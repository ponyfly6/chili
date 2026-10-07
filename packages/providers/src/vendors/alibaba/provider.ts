import type { ResponsesCompatibility } from "../../protocols/compat.js";
import { readEnvironmentSpec, type EnvironmentSource } from "../../env.js";
import { findKnownModel, listKnownModels } from "../../models.js";
import { createApiKeyResponsesModel } from "../../protocols/api-key-responses.js";
import type { ResponsesModel, ResponsesRequestBuildOptions } from "../../protocols/responses.js";
import type { ChiliModelProvider, ModelDescriptor, ModelInputCapability, ModelStreamInput, ReasoningLevel } from "../../types.js";
import { ALIBABA_DEFINITION, ALIBABA_ENVIRONMENT } from "./config.js";
import { ALIBABA_PROVIDER_ID, ALIBABA_OPENAI_BASE_URL, QWEN_38_MAX_MODEL } from "./models.js";
import { buildAlibabaResponsesRequestBody, resolveAlibabaResponsesUrl } from "./request.js";

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
  compatibility?: Partial<ResponsesCompatibility>;
}

export class AlibabaResponsesProvider implements ChiliModelProvider {
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
        apiFamily: "openai-responses", baseUrl, default: true });
    }
    return models;
  }

  getModel(model?: string): ResponsesModel {
    return createAlibabaModel({ ...this.options, ...(model ? { model } : {}) });
  }
}

/** Retained source-level alias; Alibaba now uses Responses by default. */
export { AlibabaResponsesProvider as AlibabaOpenAIProvider };

export function createAlibabaProvider(options: AlibabaModelOptions = {}): AlibabaResponsesProvider {
  return new AlibabaResponsesProvider(options);
}

export function createAlibabaRouter(options: AlibabaModelOptions = {}): ResponsesModel {
  return createAlibabaModel(options);
}

export function createAlibabaModel(options: AlibabaModelOptions = {}): ResponsesModel {
  const env = readEnvironmentSpec(ALIBABA_ENVIRONMENT, options.env);
  const model = options.model ?? env.model ?? QWEN_38_MAX_MODEL;
  const apiKey = options.apiKey ?? env.apiKey ?? "";
  if (!apiKey.trim()) throw new Error("Alibaba provider requires DASHSCOPE_API_KEY or ALIBABA_API_KEY");
  const descriptor = findKnownModel(ALIBABA_PROVIDER_ID, model);
  return createApiKeyResponsesModel({
    provider: ALIBABA_PROVIDER_ID,
    model,
    apiKey,
    endpoint: resolveAlibabaResponsesUrl(options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? ALIBABA_OPENAI_BASE_URL),
    providerLabel: "Alibaba",
    reasoningTextField: "summary",
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    resolveRequestOptions: (input) => resolveAlibabaRequestOptions(input, { ...options, model }),
    buildRequestBody: buildAlibabaResponsesRequestBody,
  });
}

function resolveAlibabaRequestOptions(input: ModelStreamInput, options: AlibabaModelOptions & { model: string }): ResponsesRequestBuildOptions {
  const provider = input.selection?.provider ?? input.provider;
  if (provider && provider !== ALIBABA_PROVIDER_ID && !(ALIBABA_DEFINITION.aliases as readonly string[]).includes(provider)) {
    throw new Error(`Alibaba model cannot stream provider "${provider}"`);
  }
  const model = input.selection?.model ?? input.model ?? options.model;
  const descriptor = findKnownModel(ALIBABA_PROVIDER_ID, model);
  const result: ResponsesRequestBuildOptions = {
    model,
    maxTokens: input.maxTokens ?? options.maxTokens ?? (descriptor
      ? Math.min(ALIBABA_DEFINITION.defaultRequestMaxTokens, descriptor.maxOutputTokens ?? Infinity)
      : ALIBABA_DEFINITION.unknownModelRequestMaxTokens),
    inputCapabilities: options.inputCapabilities ?? descriptor?.inputCapabilities ?? ["text"],
  };
  const temperature = input.temperature ?? options.temperature;
  if (temperature !== undefined) result.temperature = temperature;
  const effortMap = options.compatibility?.reasoningEffortMap ?? descriptor?.compatibility?.responses?.reasoningEffortMap;
  if (descriptor?.capabilities?.reasoning || effortMap) {
    const effort = input.reasoningLevel ?? input.reasoning ?? input.thinking ?? input.selection?.reasoning ?? input.selection?.thinking
      ?? (options.reasoning === false ? "off" : options.reasoningEffort ?? "xhigh");
    const mapped = effortMap?.[effort] ?? effort;
    result.reasoningEffort = mapped === "off" ? "off" : mapped === "minimal" || mapped === "low" ? "low" : mapped === "medium" ? "medium" : "xhigh";
  }
  return result;
}
