import type { ProviderBackpressureCoordinator } from "../runtime/backpressure.js";
import type { ModelStreamInput } from "../types.js";
import { preserveResponsesId, ResponsesModel, type ResponsesRequestBuildOptions } from "./responses.js";

/** Vendor code owns model selection and the body; this composes shared transport only. */
export interface ApiKeyResponsesModelOptions {
  provider: string;
  model: string;
  apiKey: string;
  /** Complete HTTP(S) Responses endpoint, including any vendor-specific path. */
  endpoint: string;
  providerLabel?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  backpressureCoordinator?: ProviderBackpressureCoordinator;
  /** Where reasoning_text events appear in the finalized reasoning item. */
  reasoningTextField?: "content" | "summary";
  /** Restrict continuation to the resolved request model as well as its connection. */
  scopeReasoningToModel?: boolean;
  resolveRequestOptions: (input: ModelStreamInput) => ResponsesRequestBuildOptions;
  buildRequestBody: (input: ModelStreamInput, options: ResponsesRequestBuildOptions) => Record<string, unknown>;
}

export function createApiKeyResponsesModel(options: ApiKeyResponsesModelOptions): ResponsesModel {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error(`${options.providerLabel ?? options.provider} requires an API key`);
  const endpoint = options.endpoint.trim();
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error(`${options.provider} requires an absolute HTTP(S) Responses endpoint`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${options.provider} requires an absolute HTTP(S) Responses endpoint`);
  return new ResponsesModel({
    provider: options.provider,
    model: options.model,
    endpoint,
    providerLabel: options.providerLabel ?? options.provider,
    protocolLabel: options.providerLabel ?? options.provider,
    normalizeToolCallId: preserveResponsesId,
    fetch: options.fetch ?? fetch,
    ...(options.backpressureCoordinator === undefined ? {} : { backpressureCoordinator: options.backpressureCoordinator }),
    ...(options.reasoningTextField === undefined ? {} : { reasoningTextField: options.reasoningTextField }),
    ...(options.scopeReasoningToModel === undefined ? {} : { scopeReasoningToModel: options.scopeReasoningToModel }),
    requireAssistantPhase: false,
    replayPlainReasoning: true,
    allowUnscopedReasoningReplay: false,
    resolveCredentials: async () => ({ access: apiKey }),
    resolveRequestOptions: options.resolveRequestOptions,
    buildRequestBody: options.buildRequestBody,
    buildHeaders: (credentials, sessionId) => {
      const headers = new Headers({
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${credentials.access}`,
      });
      new Headers(options.headers).forEach((value, name) => headers.set(name, value));
      if (sessionId) headers.set("x-client-request-id", sessionId);
      return headers;
    },
  });
}
