import type { ResponsesCompatibility } from "../../protocols/compat.js";
import { readEnvironmentSpec, type EnvironmentSource } from "../../env.js";
import { findKnownModel, listKnownModels } from "../../models.js";
import { createApiKeyResponsesModel } from "../../protocols/api-key-responses.js";
import { instructionText, preserveResponsesId, ResponsesModel, toResponsesInput, toResponsesTools, type ResponsesRequestBuildOptions } from "../../protocols/responses.js";
import { prependContextualUserMessage, transformModelMessages } from "../../protocols/transform-messages.js";
import type { ChiliModelProvider, ModelDescriptor, ModelInputCapability, ModelStreamInput, ReasoningLevel } from "../../types.js";
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
  compatibility?: Partial<ResponsesCompatibility>;
}

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
        apiFamily: "openai-responses", baseUrl, default: true });
    }
    return models;
  }

  getModel(model?: string): ResponsesModel {
    return createDoubaoModel({ ...this.options, ...(model ? { model } : {}) });
  }
}

export function createDoubaoProvider(options: DoubaoModelOptions = {}): DoubaoOpenAIProvider {
  return new DoubaoOpenAIProvider(options);
}

export function createDoubaoRouter(options: DoubaoModelOptions = {}): ResponsesModel {
  return createDoubaoModel(options);
}

export function createDoubaoModel(options: DoubaoModelOptions = {}): ResponsesModel {
  const env = readEnvironmentSpec(DOUBAO_ENVIRONMENT, options.env);
  const model = options.model ?? env.model ?? DOUBAO_SEED_21_PRO_MODEL;
  const apiKey = (options.apiKey ?? env.apiKey)?.trim();
  if (!apiKey) throw new Error("Doubao provider requires ARK_API_KEY or DOUBAO_API_KEY");
  const descriptor = findKnownModel(DOUBAO_PROVIDER_ID, model);
  const compatibility = { ...descriptor?.compatibility?.responses, ...options.compatibility };
  const supportsReasoning = descriptor?.capabilities?.reasoning === true
    || compatibility.reasoningEffortMap !== undefined
    || options.reasoning !== undefined
    || options.reasoningEffort !== undefined;
  const defaultMaxTokens = descriptor
    ? Math.min(DOUBAO_DEFINITION.defaultRequestMaxTokens, descriptor.maxOutputTokens ?? Infinity)
    : DOUBAO_DEFINITION.unknownModelRequestMaxTokens;
  return createApiKeyResponsesModel({
    provider: DOUBAO_PROVIDER_ID,
    providerLabel: "Doubao",
    model,
    apiKey,
    scopeReasoningToModel: true,
    endpoint: resolveDoubaoResponsesUrl(options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? DOUBAO_OPENAI_BASE_URL),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    resolveRequestOptions(input) {
      const resolved: ResponsesRequestBuildOptions = {
        model,
        maxTokens: input.maxTokens ?? options.maxTokens ?? defaultMaxTokens,
        inputCapabilities: options.inputCapabilities ?? descriptor?.inputCapabilities ?? ["text"],
      };
      const temperature = input.temperature ?? options.temperature;
      if (temperature !== undefined) resolved.temperature = temperature;
      const effort = input.reasoningLevel ?? input.reasoning ?? input.thinking
        ?? input.selection?.reasoning ?? input.selection?.thinking
        ?? (options.reasoning === false ? "off" : options.reasoningEffort)
        ?? (descriptor?.capabilities?.reasoning || options.reasoning === true ? "high" : undefined);
      if (supportsReasoning && effort !== undefined) {
        resolved.reasoningEffort = normalizeDoubaoReasoningEffort(compatibility.reasoningEffortMap?.[effort] ?? effort);
      }
      return resolved;
    },
    buildRequestBody: buildDoubaoResponsesRequestBody,
  });
}

export function resolveDoubaoResponsesUrl(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl.trim()); } catch { throw new Error("Doubao requires an absolute HTTP(S) Responses URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Doubao requires an absolute HTTP(S) Responses URL");
  const path = url.pathname.replace(/\/+$/, "");
  // Existing Ark overrides may name the old resource explicitly. Keep their base.
  url.pathname = path.endsWith("/responses") ? path : path.endsWith("/chat/completions")
    ? `${path.slice(0, -"/chat/completions".length)}/responses`
    : `${path}/responses`;
  url.hash = "";
  return url.toString();
}

export function buildDoubaoResponsesRequestBody(input: ModelStreamInput, options: ResponsesRequestBuildOptions): Record<string, unknown> {
  const messages = prependContextualUserMessage(
    transformModelMessages(input.messages, { normalizeToolCallId: preserveResponsesId }), input.contextualUser,
  );
  const body: Record<string, unknown> = {
    model: options.model,
    stream: true,
    store: false,
    input: toResponsesInput(messages, options.inputCapabilities?.includes("image") ?? false, "omit", preserveResponsesId),
  };
  const instructions = instructionText(messages, input.system ?? [], input.developer ?? []);
  if (instructions) body.instructions = instructions;
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.reasoningEffort !== undefined) {
    const effort = normalizeDoubaoReasoningEffort(options.reasoningEffort);
    const enabled = effort !== "off";
    body.thinking = { type: enabled ? "enabled" : "disabled" };
    if (enabled) body.reasoning = { effort };
  }
  const tools = toResponsesTools(input.tools ?? []).map(({ strict: _strict, ...tool }) => tool);
  if (tools.length > 0) body.tools = tools;
  // Ark returns encrypted reasoning on the item itself. Do not send OpenAI-only
  // include / reasoning.summary / prompt_cache_key / text.verbosity controls.
  return body;
}

function normalizeDoubaoReasoningEffort(effort: string): ReasoningLevel {
  if (effort === "none" || effort === "off") return "off";
  if (effort === "ultra") return "max";
  if (effort === "minimal" || effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") return effort;
  throw new Error(`Unsupported Doubao reasoning effort: ${effort}`);
}
