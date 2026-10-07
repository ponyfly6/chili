import type { Message } from "@chili/protocol";
import { parseModelSelectionPattern } from "../../model-selection.js";
import { findKnownModel } from "../../models.js";
import { instructionText, preserveResponsesId, toResponsesInput, type ResponsesRequestBuildOptions } from "../../protocols/responses.js";
import { prependContextualUserMessage, transformModelMessages } from "../../protocols/transform-messages.js";
import type { ModelStreamInput, ReasoningLevel } from "../../types.js";
import { KIMI_DEFINITION } from "./config.js";
import { KIMI_K3_MODEL, KIMI_OPENAI_BASE_URL, KIMI_PROVIDER_ID } from "./models.js";
import type { KimiModelOptions } from "./provider.js";

export function resolveKimiResponsesUrl(baseUrl = KIMI_OPENAI_BASE_URL): string {
  let url: URL;
  try { url = new URL(baseUrl.trim()); } catch { throw new Error("Kimi requires an absolute HTTP(S) base URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Kimi requires an absolute HTTP(S) base URL");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions") || path.endsWith("/messages")) {
    throw new Error("Kimi K3 uses Responses; configure a base URL or /responses endpoint instead of a Chat Completions or Messages endpoint");
  }
  url.pathname = path.endsWith("/responses") ? path : `${path || "/v1"}/responses`;
  return url.toString();
}

export function resolveKimiResponsesRequestOptions(
  input: ModelStreamInput,
  options: KimiModelOptions & { model: string },
): ResponsesRequestBuildOptions {
  const selected = input.selection?.model ?? input.model;
  const parsed = selected === undefined ? undefined : parseModelSelectionPattern(selected);
  const provider = input.selection?.provider ?? input.provider ?? parsed?.provider;
  if (provider !== undefined && provider !== KIMI_PROVIDER_ID && provider !== "moonshot") {
    throw new Error(`Kimi model cannot stream provider "${provider}"`);
  }
  const model = parsed?.model ?? selected ?? options.model;
  if (model !== KIMI_K3_MODEL) {
    throw new Error("Kimi Responses currently supports only kimi-k3; create a separate Kimi model for Chat Completions models");
  }
  const descriptor = findKnownModel(KIMI_PROVIDER_ID, model);
  const requestedEffort = input.reasoningLevel ?? input.reasoning ?? input.thinking
    ?? input.selection?.reasoning ?? input.selection?.thinking ?? parsed?.reasoning
    ?? (options.reasoning === false ? "off" : options.reasoningEffort);
  const sessionId = input.metadata?.sessionId;
  return {
    model,
    inputCapabilities: options.inputCapabilities ?? descriptor?.inputCapabilities ?? ["text", "image"],
    maxTokens: input.maxTokens ?? options.maxTokens ?? KIMI_DEFINITION.defaultRequestMaxTokens,
    ...(requestedEffort === undefined ? {} : { reasoningEffort: kimiReasoningEffort(requestedEffort) }),
    ...(typeof sessionId === "string" && sessionId ? { sessionId } : {}),
  };
}

/** Kimi's request schema is narrower than OpenAI's despite sharing Responses events. */
export function buildKimiResponsesRequestBody(
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
    input: messages.flatMap((message) => kimiInputItems(message, options.inputCapabilities?.includes("image") ?? true)),
  };
  const instructions = instructionText(messages, input.system ?? [], input.developer ?? []);
  if (instructions) body.instructions = instructions;
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.reasoningEffort !== undefined) body.reasoning = { effort: kimiReasoningEffort(options.reasoningEffort) };
  if (options.sessionId) body.prompt_cache_key = options.sessionId;
  if (input.tools?.length) {
    body.tools = input.tools.map((tool) => ({
      type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema,
    }));
    body.tool_choice = "auto";
  }
  return body;
}

function kimiInputItems(message: Message, images: boolean): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = toResponsesInput([message], images, "omit", preserveResponsesId);
  let hasReasoning = false;
  const result = items.flatMap((item) => {
    if (item.type !== "reasoning") return [item];
    if (!hasReasoningText(item.summary) && !hasReasoningText(item.content)) return [];
    hasReasoning = true;
    // The output echoes encrypted_content:null; Kimi's input schema only accepts
    // the ordinary reasoning item fields. Keep complete content, not UI text.
    const reasoning: Record<string, unknown> = { type: "reasoning" };
    for (const key of ["id", "summary", "content", "status"] as const) {
      if (item[key] !== undefined && item[key] !== null) reasoning[key] = item[key];
    }
    return [reasoning];
  });
  if (message.role === "assistant" && !hasReasoning) {
    // Older Chat turns only have visible reasoning text. The same plain schema
    // can carry it across protocols without fabricating signatures or ciphertext.
    // If a complete item was replayed, its display text must not be sent twice.
    const text = message.parts.flatMap((part) => part.type === "reasoning" && !part.redacted && part.modelOutput === undefined ? [part.text] : []).join("");
    if (text.trim()) result.unshift({ type: "reasoning", content: [{ type: "reasoning_text", text }] });
  }
  return result;
}

function hasReasoningText(value: unknown): boolean {
  return Array.isArray(value) && value.some((part: unknown) =>
    typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" && part.text.length > 0,
  );
}

function kimiReasoningEffort(level: ReasoningLevel): "low" | "high" | "max" {
  if (level === "off" || level === "minimal" || level === "low") return "low";
  if (level === "medium" || level === "high") return "high";
  return "max";
}
