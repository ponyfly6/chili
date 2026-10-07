import { createApiKeyResponsesModel } from "../../protocols/api-key-responses.js";
import { instructionText, preserveResponsesId, toResponsesInput, toResponsesTools, type ResponsesRequestBuildOptions } from "../../protocols/responses.js";
import { prependContextualUserMessage, transformModelMessages } from "../../protocols/transform-messages.js";
import type { ChiliModel, ModelDescriptor, ModelStreamInput, ReasoningLevel } from "../../types.js";

export const ZHIPU_RESPONSES_BASE_URL = "https://open.bigmodel.cn/api/v1";
export const ZAI_RESPONSES_BASE_URL = "https://api.z.ai/api/v1";

/** An explicit Responses endpoint opts in; arbitrary proxy /v1 paths do not. */
export function isGlmResponsesEndpoint(baseUrl: string): boolean {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return false; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const path = url.pathname.replace(/\/+$/, "");
  return path.endsWith("/responses")
    || ((url.origin === "https://open.bigmodel.cn" || url.origin === "https://api.z.ai") && path === "/api/v1");
}

export function resolveGlmResponsesUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/responses") ? path : `${path}/responses`;
  return url.toString();
}

interface GlmResponsesOptions {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
  descriptor?: ModelDescriptor;
  temperature?: number;
  reasoning?: boolean;
  reasoningEffort?: ReasoningLevel;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export function createGlmResponsesModel(options: GlmResponsesOptions): ChiliModel {
  return createApiKeyResponsesModel({
    provider: options.provider,
    model: options.model,
    apiKey: options.apiKey,
    endpoint: resolveGlmResponsesUrl(options.baseUrl),
    reasoningTextField: "content",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    resolveRequestOptions(input): ResponsesRequestBuildOptions {
      const resolved: ResponsesRequestBuildOptions = {
        model: options.model,
        maxTokens: input.maxTokens ?? options.maxTokens,
        inputCapabilities: options.descriptor?.inputCapabilities ?? ["text"],
      };
      const temperature = input.temperature ?? options.temperature;
      if (temperature !== undefined) resolved.temperature = temperature;
      if (options.descriptor?.capabilities?.reasoning) {
        const effort = input.reasoningLevel ?? input.reasoning ?? input.thinking ?? input.selection?.reasoning
          ?? input.selection?.thinking ?? (options.reasoning === false ? "off" : options.reasoningEffort);
        if (effort !== undefined) resolved.reasoningEffort = glmReasoningEffort(effort);
      }
      return resolved;
    },
    buildRequestBody: buildGlmResponsesRequestBody,
  });
}

export function buildGlmResponsesRequestBody(input: ModelStreamInput, options: ResponsesRequestBuildOptions): Record<string, unknown> {
  const messages = prependContextualUserMessage(
    transformModelMessages(input.messages, { normalizeToolCallId: preserveResponsesId }),
    input.contextualUser,
  );
  const body: Record<string, unknown> = {
    model: options.model,
    input: toResponsesInput(messages, options.inputCapabilities?.includes("image") ?? false, "omit", preserveResponsesId).map((item) => {
      if (!("role" in item)) return item;
      return { type: "message", ...item };
    }),
    store: false,
    stream: true,
  };
  const instructions = instructionText(messages, input.system ?? [], input.developer ?? []);
  if (instructions) body.instructions = instructions;
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.reasoningEffort !== undefined) body.reasoning = { effort: glmReasoningEffort(options.reasoningEffort) };
  const tools = toResponsesTools(input.tools ?? []).map(({ strict: _strict, ...tool }) => tool);
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return body;
}

function glmReasoningEffort(effort: ReasoningLevel): "low" | "high" | "max" {
  if (effort === "off" || effort === "minimal" || effort === "low") return "low";
  if (effort === "medium" || effort === "high") return "high";
  return "max";
}
