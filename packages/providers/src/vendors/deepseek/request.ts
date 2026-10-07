import type { Message } from "@chili/protocol";
import { findKnownModel } from "../../models.js";
import { normalizeReasoningLevel, parseModelSelectionPattern } from "../../model-selection.js";
import { instructionText, preserveResponsesId, toResponsesInput, type ResponsesRequestBuildOptions } from "../../protocols/responses.js";
import { prependContextualUserMessage, transformModelMessages } from "../../protocols/transform-messages.js";
import type { ModelStreamInput, ReasoningLevel } from "../../types.js";
import { DEEPSEEK_DEFINITION } from "./config.js";
import { DEEPSEEK_PROVIDER_ID } from "./models.js";
import type { DeepSeekModelOptions } from "./provider.js";

/** Official DeepSeek Responses is stateless and accepts plain reasoning content. */
export function buildDeepSeekResponsesRequestBody(
  input: ModelStreamInput,
  options: ResponsesRequestBuildOptions,
): Record<string, unknown> {
  const messages = prependContextualUserMessage(
    transformModelMessages(input.messages, { normalizeToolCallId: preserveResponsesId }),
    input.contextualUser,
  );
  const body: Record<string, unknown> = {
    model: options.model,
    stream: true,
    input: messages.flatMap((message) => deepSeekInputItems(message, options.inputCapabilities?.includes("image") ?? false)),
    reasoning: { effort: deepSeekReasoningEffort(options.reasoningEffort ?? "high") },
  };
  const instructions = instructionText(messages, input.system ?? [], input.developer ?? []);
  if (instructions) body.instructions = instructions;
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (input.tools?.length) {
    body.tools = input.tools.map((tool) => ({
      type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema,
    }));
  }
  return body;
}

export function resolveDeepSeekResponsesRequestOptions(
  input: ModelStreamInput,
  options: DeepSeekModelOptions & { model: string },
): ResponsesRequestBuildOptions {
  const pattern = input.selection?.model ?? input.model;
  const selection = pattern ? parseModelSelectionPattern(pattern) : undefined;
  const provider = input.selection?.provider ?? input.provider ?? selection?.provider;
  if (provider && provider.toLowerCase() !== DEEPSEEK_PROVIDER_ID) {
    throw new Error(`DeepSeek model cannot stream provider "${provider}"`);
  }
  const model = selection?.model ?? options.model;
  const descriptor = findKnownModel(DEEPSEEK_PROVIDER_ID, model);
  if (descriptor?.apiFamily !== "openai-responses") {
    throw new Error(`DeepSeek Responses is not verified for model "${model}"; create a separate model connection`);
  }
  const effort = input.reasoningLevel ?? input.reasoning ?? input.thinking ?? input.selection?.reasoning ?? input.selection?.thinking
    ?? selection?.reasoning ?? normalizeReasoningLevel(input.metadata?.reasoning) ?? normalizeReasoningLevel(input.metadata?.thinking)
    ?? (options.reasoning === false ? "off" : options.reasoningEffort ?? "high");
  const result: ResponsesRequestBuildOptions = {
    model,
    maxTokens: input.maxTokens ?? options.maxTokens ?? DEEPSEEK_DEFINITION.defaultRequestMaxTokens,
    reasoningEffort: effort,
    inputCapabilities: descriptor.inputCapabilities ?? ["text"],
  };
  const temperature = input.temperature ?? options.temperature;
  if (temperature !== undefined) result.temperature = temperature;
  return result;
}

function deepSeekReasoningEffort(effort: ReasoningLevel): "none" | "low" | "high" | "max" {
  if (effort === "off") return "none";
  if (effort === "minimal" || effort === "low") return "low";
  if (effort === "max" || effort === "ultra") return "max";
  return "high";
}

function deepSeekInputItems(message: Message, images: boolean): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = toResponsesInput([message], images, "omit", preserveResponsesId);
  let hasReasoning = false;
  const result = items.flatMap((item) => {
    if (item.type !== "reasoning") return [item];
    const content = reasoningContent(item.content);
    if (!content.length) return [];
    hasReasoning = true;
    // DeepSeek does not consume OpenAI IDs, encrypted_content or summaries.
    return [{ type: "reasoning", content }];
  });
  if (message.role === "assistant" && !hasReasoning) {
    // Preserve conversations written by the former Chat Completions adapter.
    // New Responses turns already carry a complete reasoning item, so their
    // display deltas must not be replayed a second time.
    const text = message.parts.flatMap((part) => part.type === "reasoning" && !part.redacted && part.modelOutput === undefined ? [part.text] : []).join("");
    if (text) result.unshift({ type: "reasoning", content: [{ type: "reasoning_text", text }] });
  }
  return result;
}

function reasoningContent(value: unknown): Array<{ type: "reasoning_text"; text: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part: unknown) => {
    if (!part || typeof part !== "object" || !("type" in part) || !("text" in part)) return [];
    return part.type === "reasoning_text" && typeof part.text === "string" && part.text.length > 0
      ? [{ type: "reasoning_text" as const, text: part.text }] : [];
  });
}
