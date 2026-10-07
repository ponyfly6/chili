import { KIMI_DEFINITION, KIMI_ENVIRONMENT } from "./config.js";
import type { ChiliModel, ChiliModelProvider, ModelDescriptor, ModelInputCapability, ReasoningLevel } from "../../types.js";
import { type EnvironmentSource, readEnvironmentSpec } from "../../env.js";
import { findKnownModel, listKnownModels } from "../../models.js";
import {
  KIMI_K3_MODEL,
  KIMI_OPENAI_BASE_URL,
  KIMI_PROVIDER_ID,
} from "./models.js";
import { createApiKeyResponsesModel } from "../../protocols/api-key-responses.js";
import type { ChatCompletionsCompatibility } from "../../protocols/compat.js";
import type { ProviderBackpressureCoordinator } from "../../runtime/backpressure.js";
import { buildKimiResponsesRequestBody, resolveKimiResponsesRequestOptions, resolveKimiResponsesUrl } from "./request.js";
import { OpenAICompletionsModel, type OpenAICompletionsModelOptions } from "../../protocols/chat-completions.js";

export { KIMI_K3_MODEL, KIMI_K27_CODE_MODEL, KIMI_K27_CODE_HIGHSPEED_MODEL, KIMI_OPENAI_BASE_URL, KIMI_PROVIDER_ID } from "./models.js";

export interface KimiModelOptions {
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
  backpressureCoordinator?: ProviderBackpressureCoordinator;
  inputCapabilities?: readonly ModelInputCapability[];
  compatibility?: Partial<ChatCompletionsCompatibility>;
}

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

    const descriptor: ModelDescriptor = {
      provider: this.id,
      model: defaultModel,
      displayName: defaultModel,
      apiFamily: "openai-completions",
      baseUrl: this.defaultBaseUrl(),
      default: true,
    };
    return [descriptor, ...models.map(withoutDefaultFlag)];
  }

  getModel(model?: string): ChiliModel {
    return createKimiModel({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const env = readEnvironmentSpec(KIMI_ENVIRONMENT, this.options.env);
    return this.options.model ?? env.model ?? KIMI_K3_MODEL;
  }

  private defaultBaseUrl(): string {
    const env = readEnvironmentSpec(KIMI_ENVIRONMENT, this.options.env);
    const descriptor = findKnownModel(this.id, this.defaultModel());
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

export function createKimiRouter(options: KimiModelOptions = {}): ChiliModel {
  return createKimiModel(options);
}

export function createMoonshotProvider(options: KimiModelOptions = {}): KimiOpenAIProvider {
  return createKimiProvider(options);
}

export function createMoonshotRouter(options: KimiModelOptions = {}): ChiliModel {
  return createKimiModel(options);
}

export function createKimiModel(options: KimiModelOptions = {}): ChiliModel {
  const env = readEnvironmentSpec(KIMI_ENVIRONMENT, options.env);
  const model = options.model ?? env.model ?? KIMI_K3_MODEL;
  const apiKey = (options.apiKey ?? env.apiKey ?? "").trim();
  if (!apiKey) {
    throw new Error("Kimi provider requires MOONSHOT_API_KEY or KIMI_API_KEY");
  }
  const descriptor = findKnownModel(KIMI_PROVIDER_ID, model);
  const baseUrl = options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? KIMI_OPENAI_BASE_URL;
  if (model === KIMI_K3_MODEL) {
    return createApiKeyResponsesModel({
      provider: KIMI_PROVIDER_ID,
      providerLabel: "Kimi",
      model,
      apiKey,
      endpoint: resolveKimiResponsesUrl(baseUrl),
      reasoningTextField: "summary",
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.backpressureCoordinator === undefined ? {} : { backpressureCoordinator: options.backpressureCoordinator }),
      resolveRequestOptions: (input) => resolveKimiResponsesRequestOptions(input, { ...options, model }),
      buildRequestBody: buildKimiResponsesRequestBody,
    });
  }
  if (new URL(baseUrl).pathname.replace(/\/+$/, "").endsWith("/responses")) {
    throw new Error("Kimi Responses currently supports only kimi-k3; use a base URL or Chat Completions endpoint for this model");
  }
  const modelOptions: OpenAICompletionsModelOptions = {
    provider: KIMI_PROVIDER_ID,
    model,
    baseUrl,
    apiKey,
    maxTokens: options.maxTokens ?? (descriptor
      ? KIMI_DEFINITION.defaultRequestMaxTokens
      : KIMI_DEFINITION.unknownModelRequestMaxTokens),
    inputCapabilities: options.inputCapabilities ?? descriptor?.inputCapabilities ?? ["text"],
    compatibility: {
      ...CUSTOM_MODEL_COMPATIBILITY,
      ...descriptor?.compatibility?.chatCompletions,
      ...options.compatibility,
    },
  };
  if (options.reasoning !== undefined) modelOptions.reasoning = options.reasoning;
  if (options.reasoningEffort !== undefined) modelOptions.reasoningEffort = options.reasoningEffort;
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.fetch !== undefined) modelOptions.fetch = options.fetch;
  if (options.headers !== undefined) modelOptions.headers = options.headers;
  if (options.backpressureCoordinator !== undefined) modelOptions.backpressureCoordinator = options.backpressureCoordinator;
  return new OpenAICompletionsModel(modelOptions);
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
