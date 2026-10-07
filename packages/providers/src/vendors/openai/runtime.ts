import { platform, release, arch } from "node:os";
import { isAbsoluteHttpUrl } from "../../env.js";
import type { ResponsesCredentials, ResponsesModelRuntimeOptions } from "../../protocols/responses.js";
import type { CodexApiModelOptions } from "./types.js";
import { OPENAI_BASE_URL, OPENAI_CODEX_PROVIDER_ID, OPENAI_PROVIDER_ID } from "./models.js";
import { buildCodexApiResponsesRequestBody, buildCodexResponsesRequestBody, buildOpenAICodexResponsesRequestBody, getProviderDisplayLabel, resolveCodexStreamRequestOptions, type OpenAIProviderId } from "./request.js";

export function codexRuntimeOptions(
  provider: OpenAIProviderId,
  model: string,
  baseUrl: string,
  options: CodexApiModelOptions,
  fetchImpl: typeof fetch,
  chatGptHeaders: boolean,
  resolveCredentials: (signal?: AbortSignal) => Promise<ResponsesCredentials>,
): ResponsesModelRuntimeOptions {
  return {
    provider, model, fetch: fetchImpl, resolveCredentials,
    endpoint: provider === OPENAI_PROVIDER_ID ? resolveOpenAIResponsesUrl(baseUrl) : resolveCodexResponsesUrl(baseUrl),
    providerLabel: getProviderDisplayLabel(provider),
    oauthPlanErrors: chatGptHeaders,
    requireAssistantPhase: provider !== OPENAI_PROVIDER_ID,
    allowUnscopedReasoningReplay: provider !== OPENAI_PROVIDER_ID,
    ...(options.backpressureCoordinator === undefined ? {} : { backpressureCoordinator: options.backpressureCoordinator }),
    resolveRequestOptions: (input) => resolveCodexStreamRequestOptions(input, provider, { ...options, model }),
    buildRequestBody: (input, requestOptions) => provider === OPENAI_CODEX_PROVIDER_ID
      ? buildOpenAICodexResponsesRequestBody(input, requestOptions)
      : provider === OPENAI_PROVIDER_ID
        ? buildCodexResponsesRequestBody(input, requestOptions, true, false)
        : buildCodexApiResponsesRequestBody(input, requestOptions),
    buildHeaders: (credentials, sessionId) => openAIHeaders(credentials, options, provider, sessionId),
  };
}

export function resolveOpenAIResponsesUrl(baseUrl = OPENAI_BASE_URL): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!isAbsoluteHttpUrl(normalized)) throw new Error("OpenAI provider requires an absolute HTTP(S) base URL");
  if (normalized.endsWith("/responses")) return normalized;
  return `${normalized}/responses`;
}

function openAIHeaders(credentials: ResponsesCredentials, options: CodexApiModelOptions, provider: OpenAIProviderId, sessionId: string | undefined): HeadersInit {
  const headers = new Headers({
    accept: "text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${credentials.access}`,
    ...(provider === OPENAI_PROVIDER_ID ? {} : { originator: "chili" }),
    "user-agent": `chili (${platform()} ${release()}; ${arch()})`,
  });
  new Headers(options.headers).forEach((value, name) => headers.set(name, value));
  if (provider === OPENAI_CODEX_PROVIDER_ID) {
    if (!credentials.accountId) throw new Error("ChatGPT Codex OAuth credentials are missing an account id");
    // OAuth credentials and their account are one identity, even when custom
    // headers use a different case for a protected header name.
    headers.set("authorization", `Bearer ${credentials.access}`);
    headers.set("chatgpt-account-id", credentials.accountId);
    headers.set("openai-beta", "responses=experimental");
  }
  if (sessionId) {
    if (provider !== OPENAI_PROVIDER_ID) headers.set("session_id", sessionId);
    headers.set("x-client-request-id", sessionId);
  }
  return headers;
}

export function resolveCodexResponsesUrl(baseUrl: string): string {
  const raw = baseUrl;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  if (normalized.endsWith("/v1")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}
