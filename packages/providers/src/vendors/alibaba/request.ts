import { instructionText, preserveResponsesId, toResponsesInput, toResponsesTools, type ResponsesRequestBuildOptions } from "../../protocols/responses.js";
import { prependContextualUserMessage, transformModelMessages } from "../../protocols/transform-messages.js";
import type { ModelStreamInput } from "../../types.js";

export function resolveAlibabaResponsesUrl(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl.trim()); } catch { throw new Error("Alibaba requires an absolute HTTP(S) Responses URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Alibaba requires an absolute HTTP(S) Responses URL");
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) {
    throw new Error("Alibaba uses Responses; configure the API base URL or a /responses endpoint, not /chat/completions");
  }
  url.pathname = path.endsWith("/responses") ? path : `${path}/responses`;
  url.hash = "";
  return url.toString();
}

export function buildAlibabaResponsesRequestBody(input: ModelStreamInput, options: ResponsesRequestBuildOptions): Record<string, unknown> {
  const messages = prependContextualUserMessage(
    transformModelMessages(input.messages, { normalizeToolCallId: preserveResponsesId }), input.contextualUser,
  );
  const items = toResponsesInput(messages, options.inputCapabilities?.includes("image") ?? false, "omit", preserveResponsesId);
  // Qwen requires each tool result immediately after its matching call, including
  // history that originated from a provider issuing several parallel calls.
  const outputs = new Map(items.filter((item) => "type" in item && item.type === "function_call_output")
    .map((item) => [String(item.call_id), item]));
  const calls = new Set(items.filter((item) => "type" in item && item.type === "function_call").map((item) => String(item.call_id)));
  const body: Record<string, unknown> = {
    model: options.model,
    stream: true,
    store: false,
    input: items.flatMap<(typeof items)[number]>((item) => {
      if (!("type" in item)) return [item];
      if (item.type === "function_call_output") return calls.has(String(item.call_id)) ? [] : [item];
      const result = item.type === "function_call" ? outputs.get(String(item.call_id)) : undefined;
      return result ? [item, result] : [item];
    }),
  };
  const instructions = instructionText(messages, input.system ?? [], input.developer ?? []);
  if (instructions) body.instructions = instructions;
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.reasoningEffort !== undefined) body.reasoning = { effort: options.reasoningEffort === "off" ? "none" : options.reasoningEffort };
  const tools = toResponsesTools(input.tools ?? []).map(({ strict: _strict, ...tool }) => tool);
  if (tools.length) body.tools = tools;
  return body;
}
