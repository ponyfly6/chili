import { DEEPSEEK_DEFINITION, DEEPSEEK_ENVIRONMENT } from "./config.js";
import type { ChiliModel, ChiliModelProvider, ModelDescriptor, ReasoningLevel } from "../../types.js";
import { type EnvironmentSource, readEnvironmentSpec } from "../../env.js";
import { findDefaultKnownModel, findKnownModel, listKnownModels } from "../../models.js";
import {
  DEEPSEEK_OPENAI_BASE_URL,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_V4_PRO_MODEL,
} from "./models.js";
import { OpenAICompletionsModel, type OpenAICompletionsModelOptions } from "../../protocols/chat-completions.js";
import { createApiKeyResponsesModel } from "../../protocols/api-key-responses.js";
import { buildDeepSeekResponsesRequestBody, resolveDeepSeekResponsesRequestOptions } from "./request.js";

export {
  DEEPSEEK_FLASH_MODEL,
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
  reasoningEffort?: ReasoningLevel;
  env?: EnvironmentSource;
}

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
    return createDeepSeekV4Model({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const env = readEnvironmentSpec(DEEPSEEK_ENVIRONMENT, this.options.env);
    return this.options.model ?? env.model ?? DEEPSEEK_V4_PRO_MODEL;
  }

  private defaultBaseUrl(): string {
    const env = readEnvironmentSpec(DEEPSEEK_ENVIRONMENT, this.options.env);
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

export function createDeepSeekRouter(options: DeepSeekModelOptions = {}): ChiliModel {
  return createDeepSeekV4Model(options);
}

export function createDeepSeekV4Model(options: DeepSeekModelOptions = {}): ChiliModel {
  const env = readEnvironmentSpec(DEEPSEEK_ENVIRONMENT, options.env);
  const model = options.model ?? env.model ?? DEEPSEEK_V4_PRO_MODEL;
  const descriptor = findKnownModel(DEEPSEEK_PROVIDER_ID, model);
  const apiKey = options.apiKey ?? env.apiKey ?? "";
  if (!apiKey.trim()) throw new Error("DeepSeek provider requires DEEPSEEK_API_KEY");
  const baseUrl = options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? DEEPSEEK_OPENAI_BASE_URL;
  if (descriptor?.apiFamily === "openai-responses") {
    return createApiKeyResponsesModel({
      provider: DEEPSEEK_PROVIDER_ID,
      providerLabel: "DeepSeek",
      model,
      apiKey,
      endpoint: resolveDeepSeekResponsesUrl(baseUrl),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      resolveRequestOptions: (input) => resolveDeepSeekResponsesRequestOptions(input, { ...options, model }),
      buildRequestBody: buildDeepSeekResponsesRequestBody,
    });
  }
  if (new URL(baseUrl).pathname.replace(/\/+$/, "").endsWith("/responses")) {
    throw new Error(`DeepSeek Responses is not verified for model "${model}"; use a base URL or Chat Completions endpoint for this custom model`);
  }
  const modelOptions: OpenAICompletionsModelOptions = {
    provider: DEEPSEEK_PROVIDER_ID,
    model,
    baseUrl: resolveDeepSeekCompletionsUrl(baseUrl),
    apiKey,
    maxTokens: options.maxTokens ?? DEEPSEEK_DEFINITION.unknownModelRequestMaxTokens,
    inputCapabilities: descriptor?.inputCapabilities ?? ["text"],
    compatibility: descriptor?.compatibility?.chatCompletions ?? {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      reasoningEffortMap: {},
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: false,
      reasoningParameterStyle: "native",
      toolCallDeltaMode: "standard",
    },
  };
  if (descriptor?.capabilities?.reasoning) {
    modelOptions.reasoning = options.reasoning ?? true;
    if (modelOptions.reasoning) modelOptions.reasoningEffort = options.reasoningEffort ?? "high";
  }
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.fetch !== undefined) modelOptions.fetch = options.fetch;
  if (options.headers !== undefined) modelOptions.headers = options.headers;
  return new OpenAICompletionsModel(modelOptions);
}

export function resolveDeepSeekResponsesUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("DeepSeek requires an absolute HTTP(S) Responses endpoint");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions") || path.endsWith("/messages")) {
    throw new Error("DeepSeek models use Responses; replace the Chat Completions or Messages endpoint with a Responses base URL");
  }
  url.pathname = path.endsWith("/responses") ? path : `${path}/responses`;
  return url.toString();
}

export function resolveDeepSeekCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  if (clean.endsWith("/chat/completions")) return clean;
  if (clean === DEEPSEEK_OPENAI_BASE_URL) return `${clean}/chat/completions`;
  return clean;
}
