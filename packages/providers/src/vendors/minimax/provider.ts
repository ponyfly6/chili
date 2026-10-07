import { MINIMAX_DEFINITION, MINIMAX_ENVIRONMENT } from "./config.js";
import type { ServiceTier } from "@chili/protocol";
import type { ChiliModelProvider, ModelDescriptor, ModelStreamInput, ReasoningLevel } from "../../types.js";
import {
  ResponsesModel, instructionText, preserveResponsesId, toResponsesInput, toResponsesTools,
  type ResponsesRequestBuildOptions,
} from "../../protocols/responses.js";
import { createApiKeyResponsesModel } from "../../protocols/api-key-responses.js";
import { prependContextualUserMessage, transformModelMessages } from "../../protocols/transform-messages.js";
import { clampReasoningLevel } from "../../model-selection.js";
import type { ProviderBackpressureCoordinator } from "../../runtime/backpressure.js";
import { type EnvironmentSource, readEnvironmentSpec } from "../../env.js";
import { findKnownModel, listKnownModels } from "../../models.js";
import {
  MINIMAX_BASE_URL,
  MINIMAX_M3_MODEL,
  MINIMAX_M31_FLASH_PREVIEW_MODEL,
  MINIMAX_PROVIDER_ID,
} from "./models.js";

export { MINIMAX_BASE_URL, MINIMAX_M3_MODEL, MINIMAX_M31_FLASH_PREVIEW_MODEL, MINIMAX_PROVIDER_ID } from "./models.js";

export interface MiniMaxModelOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  reasoning?: boolean;
  reasoningEffort?: ReasoningLevel;
  serviceTier?: ServiceTier;
  backpressureCoordinator?: ProviderBackpressureCoordinator;
  env?: EnvironmentSource;
}


export class MiniMaxProvider implements ChiliModelProvider {
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

    const descriptor: ModelDescriptor = {
      provider: this.id,
      model: defaultModel,
      displayName: defaultModel,
      apiFamily: "openai-responses",
      inputCapabilities: ["text"],
      baseUrl: this.defaultBaseUrl(),
      default: true,
    };
    return [descriptor, ...models.map(withoutDefaultFlag)];
  }

  getModel(model?: string): ResponsesModel {
    return createMiniMaxM3Model({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const env = readEnvironmentSpec(MINIMAX_ENVIRONMENT, this.options.env);
    return this.options.model ?? env.model ?? MINIMAX_M3_MODEL;
  }

  private defaultBaseUrl(): string {
    const env = readEnvironmentSpec(MINIMAX_ENVIRONMENT, this.options.env);
    const descriptor = findKnownModel(this.id, this.defaultModel());
    return this.options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? MINIMAX_BASE_URL;
  }
}

function withoutDefaultFlag(model: ModelDescriptor): ModelDescriptor {
  const descriptor: ModelDescriptor = { ...model };
  delete descriptor.default;
  return descriptor;
}

export function createMiniMaxProvider(options: MiniMaxModelOptions = {}): MiniMaxProvider {
  return new MiniMaxProvider(options);
}

export function createMiniMaxRouter(options: MiniMaxModelOptions = {}): ResponsesModel {
  return createMiniMaxM3Model(options);
}

export function createMiniMaxM3Model(options: MiniMaxModelOptions = {}): ResponsesModel {
  const env = readEnvironmentSpec(MINIMAX_ENVIRONMENT, options.env);
  const model = options.model ?? env.model ?? MINIMAX_M3_MODEL;
  const descriptor = findKnownModel(MINIMAX_PROVIDER_ID, model);
  const baseUrl = options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? MINIMAX_BASE_URL;
  return createApiKeyResponsesModel({
    provider: MINIMAX_PROVIDER_ID,
    providerLabel: "MiniMax",
    model,
    endpoint: resolveMiniMaxResponsesUrl(baseUrl),
    apiKey: options.apiKey ?? env.apiKey ?? "",
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.backpressureCoordinator ? { backpressureCoordinator: options.backpressureCoordinator } : {}),
    resolveRequestOptions: (input) => {
      const requested = input.reasoningLevel ?? input.reasoning ?? input.thinking
        ?? input.selection?.reasoning ?? input.selection?.thinking
        ?? (options.reasoning === false ? "off" : options.reasoningEffort);
      const resolved: ResponsesRequestBuildOptions = {
        model,
        maxTokens: Math.min(input.maxTokens ?? options.maxTokens ?? (descriptor ? MINIMAX_DEFINITION.defaultRequestMaxTokens : MINIMAX_DEFINITION.unknownModelRequestMaxTokens), descriptor?.maxOutputTokens ?? Infinity),
        inputCapabilities: descriptor?.inputCapabilities ?? ["text"],
      };
      if (requested !== undefined) resolved.reasoningEffort = requested;
      else if (model === MINIMAX_M3_MODEL) resolved.reasoningEffort = "high";
      const temperature = input.temperature ?? options.temperature;
      if (temperature !== undefined) resolved.temperature = temperature;
      const serviceTier = input.serviceTier ?? options.serviceTier;
      if (serviceTier !== undefined) resolved.serviceTier = serviceTier;
      return resolved;
    },
    buildRequestBody: buildMiniMaxResponsesRequestBody,
  });
}

export function buildMiniMaxResponsesRequestBody(input: ModelStreamInput, options: ResponsesRequestBuildOptions): Record<string, unknown> {
  const messages = prependContextualUserMessage(transformModelMessages(input.messages, {
    normalizeToolCallId: preserveResponsesId,
  }), input.contextualUser);
  const items = toResponsesInput(messages, options.inputCapabilities?.includes("image") ?? false, "omit", preserveResponsesId);
  const body: Record<string, unknown> = {
    model: options.model,
    input: items.map((item) => {
      if (!("type" in item) || item.type !== "reasoning") return item;
      // MiniMax accepts reasoning input as summary_text, whereas its output uses
      // reasoning_text content. Transfer the returned text without synthesizing it.
      const source = Array.isArray(item.content) && item.content.length ? item.content : item.summary;
      const summary = Array.isArray(source)
        ? source.flatMap((part: unknown) => isRecord(part) && typeof part.text === "string" ? [{ type: "summary_text", text: part.text }] : [])
        : [];
      return { type: "reasoning", summary };
    }),
    stream: true,
  };
  const instructions = instructionText(messages, input.system ?? [], input.developer ?? []);
  if (instructions) body.instructions = instructions;
  const tools = toResponsesTools(input.tools ?? []).map(({ strict: _strict, ...tool }) => tool);
  if (tools.length) body.tools = tools;
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.temperature !== undefined) {
    if (!Number.isFinite(options.temperature) || options.temperature <= 0 || options.temperature > 1) {
      throw new Error("MiniMax temperature must be greater than 0 and at most 1");
    }
    body.temperature = options.temperature;
  }
  if (options.reasoningEffort !== undefined) {
    const effort = options.model === MINIMAX_M31_FLASH_PREVIEW_MODEL
      ? clampReasoningLevel(options.reasoningEffort, ["low", "medium", "high", "xhigh", "max"])
      : options.reasoningEffort === "off" ? "none" : options.model === MINIMAX_M3_MODEL ? "high"
        : clampReasoningLevel(options.reasoningEffort, ["minimal", "low", "medium", "high", "xhigh", "max"]);
    body.reasoning = { effort };
  }
  if (options.serviceTier === "fast") body.service_tier = "priority";
  return body;
}

export function resolveMiniMaxResponsesUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (/(?:^|\/)anthropic(?:\/|$)/i.test(path) || /\/messages$/i.test(path)) {
    throw new Error("MiniMax now uses Responses: migrate MINIMAX_BASE_URL from the Anthropic Messages URL to your region’s API base URL (for example https://api.minimax.cn/v1)");
  }
  url.pathname = path.endsWith("/responses") ? path : path.endsWith("/v1") ? `${path}/responses` : `${path}/v1/responses`;
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @deprecated Use createMiniMaxM3Model. */
export function createMiniMaxM27HighspeedModel(options: MiniMaxModelOptions = {}): ResponsesModel {
  return createMiniMaxM3Model(options);
}
