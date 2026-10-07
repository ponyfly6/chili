import type { ServiceTier } from "@chili/protocol";
import { findKnownModel } from "../../models.js";
import { clampModelReasoningLevel, normalizeReasoningLevel, parseModelSelectionPattern } from "../../model-selection.js";
import { prependContextualUserMessage, transformModelMessages } from "../../protocols/transform-messages.js";
import { instructionText, normalizeResponsesId, toResponsesInput, toResponsesTools } from "../../protocols/responses.js";
import type { ModelInputCapability, ModelStreamInput, ReasoningLevel } from "../../types.js";
import { assertCodexApiModel, assertOpenAICodexModel, canonicalizeCodexApiModel, canonicalizeOpenAICodexModel, CODEX_API_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID, OPENAI_PROVIDER_ID, canonicalizeOpenAIModel } from "./models.js";
import type { CodexApiModelOptions, CodexApiRequestBuildOptions, OpenAICodexReasoningEffort, OpenAICodexRequestBuildOptions } from "./types.js";

export type OpenAIProviderId = typeof OPENAI_CODEX_PROVIDER_ID | typeof CODEX_API_PROVIDER_ID | typeof OPENAI_PROVIDER_ID;

export function resolveCodexStreamRequestOptions(
  input: ModelStreamInput,
  provider: OpenAIProviderId,
  options: CodexApiModelOptions & { model: string },
): OpenAICodexRequestBuildOptions {
  const selection = readOpenAICodexInputSelection(input);
  if (selection.provider && selection.provider.toLowerCase() !== provider) {
    throw new Error(`${getProviderDisplayLabel(provider)} model cannot stream provider "${selection.provider}"`);
  }

  const selectedModel = selection.model ?? options.model;
  const model = provider === OPENAI_PROVIDER_ID
    ? canonicalizeOpenAIModel(selectedModel)
    : provider === OPENAI_CODEX_PROVIDER_ID
      ? canonicalizeOpenAICodexModel(selectedModel)
      : canonicalizeCodexApiModel(selectedModel);
  if (provider === OPENAI_CODEX_PROVIDER_ID) assertOpenAICodexModel(model);
  else if (provider === CODEX_API_PROVIDER_ID) assertCodexApiModel(model);
  const descriptor = findKnownModel(provider, model);
  const maxTokens = input.maxTokens ?? options.maxTokens;
  const temperature = input.temperature ?? options.temperature;
  const requestOptions: OpenAICodexRequestBuildOptions = { model };
  if (descriptor?.inputCapabilities) requestOptions.inputCapabilities = descriptor.inputCapabilities;
  const sessionId = metadataString(input.metadata, "sessionId");
  const reasoningEffort = selection.reasoning ?? options.reasoningEffort;
  const serviceTier = input.serviceTier ?? options.serviceTier ?? metadataServiceTier(input.metadata);
  if (sessionId) requestOptions.sessionId = sessionId;
  if (options.textVerbosity !== undefined) requestOptions.textVerbosity = options.textVerbosity;
  if (reasoningEffort !== undefined) requestOptions.reasoningEffort = reasoningEffort;
  if (options.reasoningMode !== undefined) requestOptions.reasoningMode = options.reasoningMode;
  if (options.reasoningContext !== undefined) requestOptions.reasoningContext = options.reasoningContext;
  if (options.reasoningSummary !== undefined) requestOptions.reasoningSummary = options.reasoningSummary;
  if (serviceTier !== undefined) requestOptions.serviceTier = serviceTier;
  if (maxTokens !== undefined) requestOptions.maxTokens = maxTokens;
  if (temperature !== undefined) requestOptions.temperature = temperature;
  return requestOptions;
}

export function buildOpenAICodexResponsesRequestBody(
  input: ModelStreamInput,
  options: OpenAICodexRequestBuildOptions,
): Record<string, unknown> {
  return buildCodexResponsesRequestBody(input, options, false);
}

export function buildCodexApiResponsesRequestBody(
  input: ModelStreamInput,
  options: CodexApiRequestBuildOptions,
): Record<string, unknown> {
  return buildCodexResponsesRequestBody(input, options, true);
}

export function buildCodexResponsesRequestBody(
  input: ModelStreamInput,
  options: OpenAICodexRequestBuildOptions,
  includeMaxOutputTokens: boolean,
  requireAssistantPhase = true,
): Record<string, unknown> {
  const model = options.model === "gpt-5.6"
    ? canonicalizeOpenAICodexModel(options.model)
    : options.model;
  const messages = prependContextualUserMessage(
    transformModelMessages(input.messages, { normalizeToolCallId: normalizeResponsesId }),
    input.contextualUser,
  );
  const body: Record<string, unknown> = {
    model,
    store: false,
    stream: true,
    input: toResponsesInput(messages, supportsImageInput(options.inputCapabilities), requireAssistantPhase),
    text: { verbosity: options.textVerbosity ?? "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  const instructions = instructionText(messages, input.system ?? [], input.developer ?? []);
  if (instructions) body.instructions = instructions;
  if (includeMaxOutputTokens && options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.sessionId) body.prompt_cache_key = options.sessionId;
  const serviceTier = openAICodexWireServiceTier(options.serviceTier);
  if (serviceTier) body.service_tier = serviceTier;
  const effort = resolveOpenAICodexReasoningEffort(model, options.reasoningEffort);
  // GPT-6 sampling controls are only accepted with reasoning explicitly disabled.
  if (options.temperature !== undefined && (!model.startsWith("gpt-6") || effort === "none")) {
    body.temperature = options.temperature;
  }
  if (
    effort !== undefined
    || options.reasoningMode !== undefined
    || options.reasoningContext !== undefined
    || options.reasoningSummary !== undefined
  ) {
    const reasoning: Record<string, string> = {};
    if (effort !== undefined) reasoning.effort = effort;
    if (options.reasoningMode !== undefined) reasoning.mode = options.reasoningMode;
    if (options.reasoningContext !== undefined) reasoning.context = options.reasoningContext;
    if (options.reasoningSummary !== null) reasoning.summary = options.reasoningSummary ?? "auto";
    if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;
  }

  const tools = toResponsesTools(input.tools ?? []);
  if (tools.length > 0) body.tools = tools;
  return body;
}

export function resolveOpenAICodexReasoningEffort(
  model: string,
  effort: ReasoningLevel | undefined,
): OpenAICodexReasoningEffort | undefined {
  if (effort === undefined) return undefined;
  return clampOpenAICodexReasoningEffort(model, effort);
}

export function clampOpenAICodexReasoningEffort(
  model: string,
  effort: ReasoningLevel,
): OpenAICodexReasoningEffort {
  const canonicalModel = model === "gpt-5.6" ? canonicalizeOpenAICodexModel(model) : model;
  const clamped = clampModelReasoningLevel(canonicalModel, effort === "minimal" ? "low" : effort);
  if (clamped === "off") return "none";
  if (clamped === "minimal") return "low";
  if (clamped === "ultra") return "max";
  return clamped;
}

function readOpenAICodexInputSelection(input: ModelStreamInput): {
  provider?: string;
  model?: string;
  reasoning?: ReasoningLevel;
} {
  const pattern = input.selection?.model ?? input.model ?? metadataString(input.metadata, "model");
  const parsed = pattern ? parseModelSelectionPattern(pattern) : undefined;
  const provider = input.selection?.provider ?? input.provider ?? parsed?.provider;
  const reasoning =
    input.reasoning ??
    input.thinking ??
    input.selection?.reasoning ??
    input.selection?.thinking ??
    parsed?.reasoning ??
    normalizeReasoningLevel(metadataString(input.metadata, "reasoning")) ??
    normalizeReasoningLevel(metadataString(input.metadata, "thinking"));
  const result: { provider?: string; model?: string; reasoning?: ReasoningLevel } = {};
  if (provider) result.provider = provider;
  const model = parsed?.model ?? pattern;
  if (model) result.model = model;
  if (reasoning) result.reasoning = reasoning;
  return result;
}

function supportsImageInput(inputCapabilities: readonly ModelInputCapability[] | undefined): boolean {
  return inputCapabilities === undefined || inputCapabilities.includes("image");
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function metadataServiceTier(metadata: Record<string, unknown> | undefined): ServiceTier | undefined {
  const value = metadataString(metadata, "serviceTier") ?? metadataString(metadata, "service_tier");
  if (value === "fast" || value === "standard") return value;
  return undefined;
}

function openAICodexWireServiceTier(serviceTier: ServiceTier | undefined): string | undefined {
  if (serviceTier === "fast") return "priority";
  return undefined;
}

export function getProviderDisplayLabel(provider: OpenAIProviderId): string {
  return provider === OPENAI_PROVIDER_ID ? "OpenAI" : provider === OPENAI_CODEX_PROVIDER_ID ? "OpenAI Codex" : "Codex API";
}
