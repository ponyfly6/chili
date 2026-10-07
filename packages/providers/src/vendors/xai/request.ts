import { isAbsoluteHttpUrl } from "../../env.js";
import { findKnownModel } from "../../models.js";
import { parseModelSelectionPattern } from "../../model-selection.js";
import { instructionText, preserveResponsesId, toResponsesInput, toResponsesTools, type ResponsesRequestBuildOptions } from "../../protocols/responses.js";
import { prependContextualUserMessage, transformModelMessages } from "../../protocols/transform-messages.js";
import type { ModelStreamInput, ReasoningLevel } from "../../types.js";
import { XAI_DEFINITION } from "./config.js";
import { XAI_PROVIDER_ID, XAI_REASONING_EFFORT_MAP } from "./models.js";
import type { XaiModelOptions } from "./provider.js";

export function resolveXaiResponsesUrl(baseUrl: string): string {
  if (!isAbsoluteHttpUrl(baseUrl)) throw new Error("xAI provider requires an absolute HTTP(S) base URL");
  const url = new URL(baseUrl.trim());
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/responses") ? path
    : path.endsWith("/chat/completions") ? path.replace(/\/chat\/completions$/, "/responses")
    : `${path || "/v1"}/responses`;
  return url.toString();
}

export function resolveXaiStreamRequestOptions(
  input: ModelStreamInput,
  options: XaiModelOptions & { model: string },
): ResponsesRequestBuildOptions {
  const selected = input.selection?.model ?? input.model ?? options.model;
  const parsed = parseModelSelectionPattern(selected);
  if (!parsed) throw new Error("xAI model selection requires a non-empty model ID");
  const provider = input.selection?.provider ?? input.provider ?? parsed.provider;
  if (provider && ![XAI_PROVIDER_ID, ...XAI_DEFINITION.aliases].includes(provider.toLowerCase())) {
    throw new Error(`xAI model cannot stream provider "${provider}"`);
  }
  const model = parsed.model;
  const descriptor = findKnownModel(XAI_PROVIDER_ID, model);
  const requestedEffort = input.reasoningLevel ?? input.reasoning ?? input.thinking
    ?? input.selection?.reasoning ?? input.selection?.thinking ?? parsed.reasoning
    ?? (options.reasoning === false ? "off" : options.reasoningEffort);
  return {
    model,
    maxTokens: input.maxTokens ?? options.maxTokens ?? (descriptor ? XAI_DEFINITION.defaultRequestMaxTokens : XAI_DEFINITION.unknownModelRequestMaxTokens),
    inputCapabilities: descriptor?.inputCapabilities ?? ["text"],
    ...(descriptor?.capabilities?.reasoning ? { reasoningEffort: xaiReasoningEffort(requestedEffort ?? "high") } : {}),
    ...(input.temperature !== undefined || options.temperature !== undefined ? { temperature: input.temperature ?? options.temperature! } : {}),
  };
}

export function buildXaiResponsesRequestBody(input: ModelStreamInput, options: ResponsesRequestBuildOptions): Record<string, unknown> {
  const messages = prependContextualUserMessage(
    transformModelMessages(input.messages, { normalizeToolCallId: preserveResponsesId }),
    input.contextualUser,
  );
  const responseInput = toResponsesInput(messages, options.inputCapabilities?.includes("image") ?? false, "omit", preserveResponsesId);
  const body: Record<string, unknown> = {
    model: options.model,
    input: responseInput,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  const instructions = instructionText(messages, input.system ?? [], input.developer ?? []);
  if (instructions) body.instructions = instructions;
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.reasoningEffort !== undefined) body.reasoning = { effort: xaiReasoningEffort(options.reasoningEffort) };
  const tools = toResponsesTools(input.tools ?? []).map(({ strict: _strict, ...tool }) => tool);
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  return body;
}

function xaiReasoningEffort(level: ReasoningLevel): "low" | "medium" | "high" | "xhigh" {
  return XAI_REASONING_EFFORT_MAP[level];
}
