import { platform, release, arch } from "node:os";
import {
  formatToolResultForModel,
  type AssistantMessagePhase,
  type Message,
  type MessagePart,
  type ServiceTier,
} from "@chili/protocol";
import { FileAuthStorage, type OAuthCredentials } from "./auth.js";
import { type EnvironmentSource, isAbsoluteHttpUrl, readCodexApiEnvironment } from "./env.js";
import {
  assertCodexApiModel,
  assertOpenAICodexModel,
  canonicalizeCodexApiModel,
  canonicalizeOpenAICodexModel,
  CODEX_API_DEFAULT_MODEL,
  CODEX_API_PROVIDER_ID,
  findDefaultKnownModel,
  findKnownModel,
  listKnownModels,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID,
} from "./models.js";
import { clampModelReasoningLevel, normalizeReasoningLevel, parseModelSelectionPattern } from "./model-selection.js";
import { extractOpenAICodexAccountId, refreshOpenAICodexToken } from "./oauth/openai-codex.js";
import { assertImageInputSupported } from "./image-input.js";
import {
  providerHttpError,
  providerPayloadError,
  type ProviderRequestError,
} from "./provider-error.js";
import { readSseEvents } from "./sse.js";
import { prependContextualUserMessage, transformModelMessages } from "./transform-messages.js";
import type {
  ChiliModel,
  ChiliModelProvider,
  ModelDescriptor,
  ModelInputCapability,
  ModelStreamEvent,
  ModelStreamInput,
  ModelTool,
  ModelUsage,
  ReasoningLevel,
} from "./types.js";

export {
  CODEX_API_DEFAULT_MODEL,
  CODEX_API_PROVIDER_ID,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID,
} from "./models.js";

export type OpenAICodexReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type OpenAICodexReasoningMode = "pro";
export type OpenAICodexReasoningContext = "auto" | "all_turns" | "current_turn";

export interface OpenAICodexModelOptions {
  /** @deprecated ChatGPT Codex is OAuth-only. Use CodexApiModelOptions with the codex-api provider. */
  apiKey?: string;
  /** @deprecated ChatGPT Codex is OAuth-only. Account IDs come from OAuth credentials. */
  accountId?: string;
  /** @deprecated ChatGPT Codex always uses the fixed ChatGPT endpoint. Use the codex-api provider for custom endpoints. */
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  authPath?: string;
  authStorage?: FileAuthStorage;
  env?: EnvironmentSource;
  reasoningEffort?: ReasoningLevel;
  reasoningMode?: OpenAICodexReasoningMode;
  reasoningContext?: OpenAICodexReasoningContext;
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  serviceTier?: ServiceTier;
  textVerbosity?: "low" | "medium" | "high";
}

export interface CodexApiModelOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  env?: EnvironmentSource;
  reasoningEffort?: ReasoningLevel;
  reasoningMode?: OpenAICodexReasoningMode;
  reasoningContext?: OpenAICodexReasoningContext;
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  serviceTier?: ServiceTier;
  textVerbosity?: "low" | "medium" | "high";
}

export type CodexApiRequestBuildOptions = OpenAICodexRequestBuildOptions;

export interface OpenAICodexRequestBuildOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  sessionId?: string;
  reasoningEffort?: ReasoningLevel;
  reasoningMode?: OpenAICodexReasoningMode;
  reasoningContext?: OpenAICodexReasoningContext;
  reasoningSummary?: OpenAICodexModelOptions["reasoningSummary"];
  serviceTier?: ServiceTier;
  textVerbosity?: OpenAICodexModelOptions["textVerbosity"];
  inputCapabilities?: readonly ModelInputCapability[];
}

type CodexResponseMessageContent =
  | { type: "input_text" | "output_text"; text: string }
  | { type: "input_image"; image_url: string };

type CodexResponseInputItem =
  | {
      role: "user";
      content: CodexResponseMessageContent[];
    }
  | {
      role: "assistant";
      phase: AssistantMessagePhase;
      content: CodexResponseMessageContent[];
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    }
  | (Record<string, unknown> & {
      type: "reasoning";
      encrypted_content: string;
    });

interface CodexStreamPayload {
  type?: string;
  response?: {
    id?: string;
    status?: string;
    usage?: CodexUsage;
    model?: string;
    error?: CodexErrorPayload;
  };
  error?: CodexErrorPayload | string;
  item?: CodexOutputItem;
  delta?: string;
  arguments?: string;
  output_index?: number;
  summary_index?: number;
  item_id?: string;
  code?: string | number;
  message?: string;
}

interface CodexErrorPayload {
  message?: string;
  code?: string | number;
  type?: string;
  param?: string;
  request_id?: string;
  requestId?: string;
  plan_type?: string;
  resets_at?: number;
}

interface CodexOutputItem extends Record<string, unknown> {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
  summary?: Array<{ text?: string }>;
  phase?: string;
  encrypted_content?: string;
}

interface CodexUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  input_tokens_details?: {
    cached_tokens?: number | null;
    cache_write_tokens?: number | null;
  };
}

interface ResolvedCodexCredentials {
  access: string;
  accountId?: string;
}

interface CodexResponsesModelRuntimeOptions {
  provider: typeof OPENAI_CODEX_PROVIDER_ID | typeof CODEX_API_PROVIDER_ID;
  model: string;
  baseUrl: string;
  fetch: typeof fetch;
  headers?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningLevel;
  reasoningMode?: OpenAICodexReasoningMode;
  reasoningContext?: OpenAICodexReasoningContext;
  reasoningSummary?: OpenAICodexModelOptions["reasoningSummary"];
  serviceTier?: ServiceTier;
  textVerbosity?: OpenAICodexModelOptions["textVerbosity"];
  chatGptHeaders: boolean;
  resolveCredentials: () => Promise<ResolvedCodexCredentials>;
}

interface ToolStreamState {
  toolCallId: string;
  itemId?: string;
  name: string;
  partialJson: string;
  index?: number;
  started: boolean;
  ended: boolean;
}

interface FinalToolInput {
  input: unknown;
  inputParseError?: string;
}

interface CodexProviderErrorDetails {
  message?: string;
  code?: string | number;
  type?: string;
  param?: string;
  requestId?: string;
  retryAfterMs?: number;
  category?: "quota_exhausted";
  retryable?: boolean;
  opensCircuit?: boolean;
}

const TOKEN_REFRESH_SKEW_MS = 60_000;

export class OpenAICodexProvider implements ChiliModelProvider {
  readonly id = OPENAI_CODEX_PROVIDER_ID;
  readonly name = "ChatGPT Codex";

  constructor(private readonly options: OpenAICodexModelOptions = {}) {
    assertOpenAICodexOAuthOptions(options);
    this.defaultModel();
  }

  models(): readonly ModelDescriptor[] {
    const models = listKnownModels(this.id);
    const defaultModel = this.defaultModel();
    if (models.some((model) => model.model === defaultModel)) {
      return models.map((model) => {
        const descriptor: ModelDescriptor = { ...model };
        descriptor.baseUrl = this.defaultBaseUrl();
        if (model.model === defaultModel) {
          descriptor.default = true;
        } else {
          delete descriptor.default;
        }
        return descriptor;
      });
    }

    const fallback = findDefaultKnownModel(this.id);
    const descriptor: ModelDescriptor = {
      provider: this.id,
      model: defaultModel,
      displayName: defaultModel,
      apiFamily: fallback?.apiFamily ?? "openai-responses",
      baseUrl: this.defaultBaseUrl(),
      default: true,
    };
    if (fallback?.capabilities) descriptor.capabilities = fallback.capabilities;
    if (fallback?.inputCapabilities) descriptor.inputCapabilities = fallback.inputCapabilities;
    if (fallback?.contextWindowTokens !== undefined) descriptor.contextWindowTokens = fallback.contextWindowTokens;
    if (fallback?.maxOutputTokens !== undefined) descriptor.maxOutputTokens = fallback.maxOutputTokens;
    if (fallback?.cost) descriptor.cost = fallback.cost;
    return [descriptor, ...models.map(withoutDefaultFlag)];
  }

  getModel(model?: string): OpenAICodexResponsesModel {
    return createOpenAICodexModel({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const model = canonicalizeOpenAICodexModel(this.options.model ?? OPENAI_CODEX_DEFAULT_MODEL);
    assertOpenAICodexModel(model);
    return model;
  }

  private defaultBaseUrl(): string {
    return OPENAI_CODEX_BASE_URL;
  }
}

export class CodexApiProvider implements ChiliModelProvider {
  readonly id = CODEX_API_PROVIDER_ID;
  readonly name = "Codex API";

  constructor(private readonly options: CodexApiModelOptions = {}) {
    this.defaultModel();
  }

  models(): readonly ModelDescriptor[] {
    const models = listKnownModels(this.id);
    const defaultModel = this.defaultModel();
    return models.map((model) => {
      const descriptor: ModelDescriptor = { ...model };
      if (model.model === defaultModel) {
        descriptor.default = true;
      } else {
        delete descriptor.default;
      }
      return descriptor;
    });
  }

  getModel(model?: string): CodexApiResponsesModel {
    return createCodexApiModel({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    const env = readCodexApiEnvironment(this.options.env);
    const model = canonicalizeCodexApiModel(this.options.model ?? env.model ?? CODEX_API_DEFAULT_MODEL);
    assertCodexApiModel(model);
    return model;
  }
}

class CodexResponsesModel implements ChiliModel {
  readonly provider: typeof OPENAI_CODEX_PROVIDER_ID | typeof CODEX_API_PROVIDER_ID;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CodexResponsesModelRuntimeOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.fetchImpl = options.fetch;
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    const requestOptions = resolveCodexStreamRequestOptions(input, this.provider, this.options);
    assertImageInputSupported(input, {
      provider: this.provider,
      model: requestOptions.model,
      inputCapabilities: requestOptions.inputCapabilities,
    });
    const credentials = await this.options.resolveCredentials();
    const requestBody = this.provider === CODEX_API_PROVIDER_ID
      ? buildCodexApiResponsesRequestBody(input, requestOptions)
      : buildOpenAICodexResponsesRequestBody(input, requestOptions);

    const init: RequestInit = {
      method: "POST",
      headers: this.headers(credentials, requestOptions.sessionId),
      body: JSON.stringify(requestBody),
    };
    if (input.signal) init.signal = input.signal;

    yield { type: "metadata", provider: this.provider, model: requestOptions.model };
    const response = await this.fetchImpl(resolveCodexResponsesUrl(this.options.baseUrl), init);
    if (!response.ok) {
      throw await parseCodexErrorResponse(
        response,
        this.provider,
        this.options.chatGptHeaders,
        `${getProviderDisplayLabel(this.provider)} request`,
      );
    }
    if (!response.body) {
      throw codexProtocolError(this.provider, "OpenAI Codex response did not include a body", response);
    }
    if (!isEventStreamResponse(response)) {
      const payload = parseJson<CodexStreamPayload>(await response.text(), undefined);
      if (payload?.error || payload?.type === "error" || payload?.type === "response.failed") {
        throw formatCodexStreamError(payload, this.provider, "OpenAI Codex response failed", response);
      }
      throw codexProtocolError(this.provider, "OpenAI Codex response was not an event stream", response);
    }
    yield* this.streamSseResponse(response.body, response, input.signal, requestOptions.model);
  }

  private headers(credentials: ResolvedCodexCredentials, sessionId: string | undefined): HeadersInit {
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${credentials.access}`,
      originator: "chili",
      "user-agent": `chili (${platform()} ${release()}; ${arch()})`,
      ...this.options.headers,
    };
    if (this.options.chatGptHeaders) {
      if (!credentials.accountId) throw new Error("ChatGPT Codex OAuth credentials are missing an account id");
      headers["chatgpt-account-id"] = credentials.accountId;
      headers["openai-beta"] = "responses=experimental";
    }
    if (sessionId) {
      headers.session_id = sessionId;
      headers["x-client-request-id"] = sessionId;
    }
    return headers;
  }

  private async *streamSseResponse(
    body: ReadableStream<Uint8Array>,
    response: Response,
    signal?: AbortSignal,
    requestModel: string = this.model,
  ): AsyncIterable<ModelStreamEvent> {
    let responseId: string | undefined;
    let usage: ModelUsage | undefined;
    let finishReason = "stop";
    let sawToolCall = false;
    const toolCalls = new Map<string, ToolStreamState>();
    const messagePhases = new Map<number, AssistantMessagePhase>();
    const reasoningSectionIndexes = new Map<string, number>();
    let activeToolKey: string | undefined;

    for await (const event of readSseEvents(body, signal)) {
      if (event.data === "[DONE]") break;
      const payload = parseJson<CodexStreamPayload>(event.data, undefined);

      if (event.event === "error" || payload?.type === "error") {
        throw formatCodexStreamError(payload, this.provider, "OpenAI Codex stream error", response);
      }
      if (!payload?.type) continue;

      if (payload.type === "response.failed") {
        throw formatCodexStreamError(payload, this.provider, "OpenAI Codex response failed", response);
      }

      if (payload.type === "response.created") {
        responseId = payload.response?.id ?? responseId;
        yield metadataEvent(this.provider, payload.response?.model ?? requestModel, responseId, usage);
        continue;
      }

      if (payload.type === "response.output_item.added" && payload.item) {
        if (payload.item.type === "message") {
          recordCodexAssistantPhase(messagePhases, payload.output_index, payload.item.phase, this.provider, response);
        }
        if (payload.item.type === "function_call") {
          sawToolCall = true;
          const state = createToolState(payload.item, payload.output_index);
          const key = toolStateKey(state);
          toolCalls.set(key, state);
          activeToolKey = key;
          if (state.name) yield startToolEvent(state);
        }
        continue;
      }

      if (payload.type === "response.reasoning_summary_text.delta" && payload.delta) {
        yield {
          type: "reasoning_delta",
          text: payload.delta,
          index: reasoningSectionEventIndex(payload, reasoningSectionIndexes),
        };
        continue;
      }

      if ((payload.type === "response.output_text.delta" || payload.type === "response.refusal.delta") && payload.delta) {
        const index = payload.output_index;
        const phase = index === undefined ? undefined : messagePhases.get(index);
        if (index === undefined || phase === undefined) {
          throw codexProtocolError(
            this.provider,
            "OpenAI Codex stream has text delta for an undeclared message output",
            response,
          );
        }
        yield { type: "text_delta", text: payload.delta, index, phase };
        continue;
      }

      if (payload.type === "response.function_call_arguments.delta" && payload.delta) {
        const state = findToolState(toolCalls, payload, activeToolKey);
        if (!state) continue;
        state.partialJson += payload.delta;
        const parsed = parseJson<unknown>(state.partialJson, undefined);
        yield toolDeltaEvent(state, payload.delta, parsed);
        continue;
      }

      if (payload.type === "response.function_call_arguments.done" && payload.arguments !== undefined) {
        const state = findToolState(toolCalls, payload, activeToolKey);
        if (!state) continue;
        const delta = payload.arguments.startsWith(state.partialJson)
          ? payload.arguments.slice(state.partialJson.length)
          : "";
        state.partialJson = payload.arguments;
        if (delta) yield toolDeltaEvent(state, delta, parseJson<unknown>(state.partialJson, undefined));
        continue;
      }

      if (payload.type === "response.output_item.done" && payload.item) {
        if (
          payload.item.type === "reasoning"
          && typeof payload.item.encrypted_content === "string"
        ) {
          yield {
            type: "reasoning_item",
            output: {
              apiFamily: "openai-responses",
              ...(payload.output_index === undefined ? {} : { outputIndex: payload.output_index }),
              item: payload.item,
            },
          };
        }
        if (payload.item.type === "message") {
          recordCodexAssistantPhase(messagePhases, payload.output_index, payload.item.phase, this.provider, response);
        }
        if (payload.item.type === "function_call") {
          const state = findToolState(toolCalls, payload, activeToolKey) ?? createToolState(payload.item, payload.output_index);
          if (payload.item.name) state.name = payload.item.name;
          if (payload.item.arguments !== undefined) state.partialJson = payload.item.arguments;
          if (!state.started && state.name) yield startToolEvent(state);
          if (!state.ended) {
            state.ended = true;
            yield finishToolEvent(state);
          }
        }
        continue;
      }

      if (payload.type === "response.completed" || payload.type === "response.done" || payload.type === "response.incomplete") {
        responseId = payload.response?.id ?? responseId;
        usage = toModelUsage(payload.response?.usage) ?? usage;
        finishReason = mapCodexFinishReason(
          payload.response?.status ?? (payload.type === "response.incomplete" ? "incomplete" : undefined),
          sawToolCall,
        );
        if (responseId || usage) yield metadataEvent(this.provider, payload.response?.model ?? requestModel, responseId, usage);
        break;
      }
    }

    for (const state of toolCalls.values()) {
      if (!state.ended) yield finishToolEvent(state);
    }
    yield finishEvent(finishReason, responseId, usage);
  }
}

export class OpenAICodexResponsesModel extends CodexResponsesModel {
  constructor(options: OpenAICodexModelOptions = {}) {
    assertOpenAICodexOAuthOptions(options);
    const model = canonicalizeOpenAICodexModel(options.model ?? OPENAI_CODEX_DEFAULT_MODEL);
    assertOpenAICodexModel(model);
    const fetchImpl = options.fetch ?? fetch;
    const authStorage = options.authStorage ?? new FileAuthStorage(options.authPath);
    super(codexRuntimeOptions(
      OPENAI_CODEX_PROVIDER_ID,
      model,
      OPENAI_CODEX_BASE_URL,
      options,
      fetchImpl,
      true,
      () => resolveOpenAICodexOAuthCredentials(authStorage, fetchImpl),
    ));
  }
}

export class CodexApiResponsesModel extends CodexResponsesModel {
  constructor(options: CodexApiModelOptions = {}) {
    const env = readCodexApiEnvironment(options.env);
    const apiKey = nonEmptyString(options.apiKey ?? env.apiKey);
    if (!apiKey) {
      throw new Error(
        "Codex API provider requires CODEX_API_KEY (legacy OPENAI_CODEX_ACCESS_TOKEN is also supported)",
      );
    }
    const baseUrl = nonEmptyString(options.baseUrl ?? env.baseUrl);
    if (!baseUrl) {
      throw new Error(
        "Codex API provider requires CODEX_API_BASE_URL (legacy OPENAI_CODEX_BASE_URL is also supported)",
      );
    }
    if (!isAbsoluteHttpUrl(baseUrl)) {
      throw new Error("Codex API provider requires CODEX_API_BASE_URL to be an absolute HTTP(S) URL");
    }
    if (
      options.apiKey === undefined
      && env.apiKeyEnv === "OPENAI_CODEX_ACCESS_TOKEN"
      && isChatGptOAuthAccessToken(apiKey)
    ) {
      throw new Error(
        "OPENAI_CODEX_ACCESS_TOKEN looks like a ChatGPT OAuth token and cannot be used by codex-api; "
        + "use /auth login for ChatGPT OAuth or set CODEX_API_KEY explicitly for the third-party API",
      );
    }
    const model = canonicalizeCodexApiModel(options.model ?? env.model ?? CODEX_API_DEFAULT_MODEL);
    assertCodexApiModel(model);
    const fetchImpl = options.fetch ?? fetch;
    super(codexRuntimeOptions(
      CODEX_API_PROVIDER_ID,
      model,
      baseUrl,
      options,
      fetchImpl,
      false,
      async () => ({ access: apiKey }),
    ));
  }
}

export function createOpenAICodexProvider(options: OpenAICodexModelOptions = {}): OpenAICodexProvider {
  return new OpenAICodexProvider(options);
}

export function createOpenAICodexRouter(options: OpenAICodexModelOptions = {}): OpenAICodexResponsesModel {
  return createOpenAICodexModel(options);
}

export function createOpenAICodexModel(options: OpenAICodexModelOptions = {}): OpenAICodexResponsesModel {
  return new OpenAICodexResponsesModel(options);
}

export function createCodexApiProvider(options: CodexApiModelOptions = {}): CodexApiProvider {
  return new CodexApiProvider(options);
}

export function createCodexApiRouter(options: CodexApiModelOptions = {}): CodexApiResponsesModel {
  return createCodexApiModel(options);
}

export function createCodexApiModel(options: CodexApiModelOptions = {}): CodexApiResponsesModel {
  return new CodexApiResponsesModel(options);
}

export function resolveOpenAICodexStreamRequestOptions(
  input: ModelStreamInput,
  options: OpenAICodexModelOptions = {},
): OpenAICodexRequestBuildOptions {
  assertOpenAICodexOAuthOptions(options);
  return resolveCodexStreamRequestOptions(input, OPENAI_CODEX_PROVIDER_ID, {
    ...options,
    provider: OPENAI_CODEX_PROVIDER_ID,
    model: options.model ?? OPENAI_CODEX_DEFAULT_MODEL,
    baseUrl: OPENAI_CODEX_BASE_URL,
    fetch: options.fetch ?? fetch,
    chatGptHeaders: true,
    resolveCredentials: async () => ({ access: "unused" }),
  });
}

export function resolveCodexApiStreamRequestOptions(
  input: ModelStreamInput,
  options: CodexApiModelOptions = {},
): CodexApiRequestBuildOptions {
  const env = readCodexApiEnvironment(options.env);
  return resolveCodexStreamRequestOptions(input, CODEX_API_PROVIDER_ID, {
    ...options,
    provider: CODEX_API_PROVIDER_ID,
    model: options.model ?? env.model ?? CODEX_API_DEFAULT_MODEL,
    baseUrl: options.baseUrl ?? env.baseUrl ?? "",
    fetch: options.fetch ?? fetch,
    chatGptHeaders: false,
    resolveCredentials: async () => ({ access: "unused" }),
  });
}

function resolveCodexStreamRequestOptions(
  input: ModelStreamInput,
  provider: typeof OPENAI_CODEX_PROVIDER_ID | typeof CODEX_API_PROVIDER_ID,
  options: CodexResponsesModelRuntimeOptions,
): OpenAICodexRequestBuildOptions {
  const selection = readOpenAICodexInputSelection(input);
  if (selection.provider && selection.provider.toLowerCase() !== provider) {
    throw new Error(`${getProviderDisplayLabel(provider)} model cannot stream provider "${selection.provider}"`);
  }

  const selectedModel = selection.model ?? options.model;
  const model = provider === OPENAI_CODEX_PROVIDER_ID
    ? canonicalizeOpenAICodexModel(selectedModel)
    : canonicalizeCodexApiModel(selectedModel);
  if (provider === OPENAI_CODEX_PROVIDER_ID) assertOpenAICodexModel(model);
  else assertCodexApiModel(model);
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

export function resolveOpenAICodexResponsesUrl(baseUrl?: string): string {
  if (baseUrl && normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(OPENAI_CODEX_BASE_URL)) {
    throw new Error("ChatGPT Codex uses a fixed endpoint; use the codex-api provider for custom base URLs");
  }
  return resolveCodexResponsesUrl(OPENAI_CODEX_BASE_URL);
}

export function resolveCodexApiResponsesUrl(baseUrl: string): string {
  const normalizedBaseUrl = nonEmptyString(baseUrl);
  if (!normalizedBaseUrl) throw new Error("Codex API provider requires a non-empty base URL");
  if (!isAbsoluteHttpUrl(normalizedBaseUrl)) {
    throw new Error("Codex API provider requires an absolute HTTP(S) base URL");
  }
  return resolveCodexResponsesUrl(normalizedBaseUrl);
}

function resolveCodexResponsesUrl(baseUrl: string): string {
  const raw = baseUrl;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  if (normalized.endsWith("/v1")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function codexRuntimeOptions(
  provider: typeof OPENAI_CODEX_PROVIDER_ID | typeof CODEX_API_PROVIDER_ID,
  model: string,
  baseUrl: string,
  options: OpenAICodexModelOptions | CodexApiModelOptions,
  fetchImpl: typeof fetch,
  chatGptHeaders: boolean,
  resolveCredentials: () => Promise<ResolvedCodexCredentials>,
): CodexResponsesModelRuntimeOptions {
  const runtimeOptions: CodexResponsesModelRuntimeOptions = {
    provider,
    model,
    baseUrl,
    fetch: fetchImpl,
    chatGptHeaders,
    resolveCredentials,
  };
  if (options.headers !== undefined) runtimeOptions.headers = options.headers;
  if (options.maxTokens !== undefined) runtimeOptions.maxTokens = options.maxTokens;
  if (options.temperature !== undefined) runtimeOptions.temperature = options.temperature;
  if (options.reasoningEffort !== undefined) runtimeOptions.reasoningEffort = options.reasoningEffort;
  if (options.reasoningMode !== undefined) runtimeOptions.reasoningMode = options.reasoningMode;
  if (options.reasoningContext !== undefined) runtimeOptions.reasoningContext = options.reasoningContext;
  if (options.reasoningSummary !== undefined) runtimeOptions.reasoningSummary = options.reasoningSummary;
  if (options.serviceTier !== undefined) runtimeOptions.serviceTier = options.serviceTier;
  if (options.textVerbosity !== undefined) runtimeOptions.textVerbosity = options.textVerbosity;
  return runtimeOptions;
}

async function resolveOpenAICodexOAuthCredentials(
  authStorage: FileAuthStorage,
  fetchImpl: typeof fetch,
): Promise<ResolvedCodexCredentials> {
  const stored = await authStorage.getOAuthCredentials(OPENAI_CODEX_PROVIDER_ID);
  if (!stored) {
    throw new Error(
      "No ChatGPT Codex OAuth credentials found. Run /auth login in the Chili TUI before using openai-codex.",
    );
  }
  if (stored.expires > Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return { access: stored.access, accountId: stored.accountId };
  }

  const refreshed = await refreshOpenAICodexToken(stored.refresh, { fetch: fetchImpl, previous: stored });
  await authStorage.setOAuthCredentials(OPENAI_CODEX_PROVIDER_ID, refreshed);
  return { access: refreshed.access, accountId: refreshed.accountId };
}

function assertOpenAICodexOAuthOptions(options: OpenAICodexModelOptions): void {
  if (options.apiKey !== undefined || options.accountId !== undefined) {
    throw new Error("ChatGPT Codex is OAuth-only; use the codex-api provider for API keys");
  }
  if (options.baseUrl !== undefined && normalizeBaseUrl(options.baseUrl) !== normalizeBaseUrl(OPENAI_CODEX_BASE_URL)) {
    throw new Error("ChatGPT Codex uses a fixed endpoint; use the codex-api provider for custom base URLs");
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isChatGptOAuthAccessToken(token: string): boolean {
  try {
    extractOpenAICodexAccountId(token);
    return true;
  } catch {
    return false;
  }
}

function getProviderDisplayLabel(provider: typeof OPENAI_CODEX_PROVIDER_ID | typeof CODEX_API_PROVIDER_ID): string {
  return provider === OPENAI_CODEX_PROVIDER_ID ? "OpenAI Codex" : "Codex API";
}

export function buildOpenAICodexResponsesRequestBody(
  input: ModelStreamInput,
  options: OpenAICodexRequestBuildOptions,
): Record<string, unknown> {
  return buildCodexResponsesRequestBody(input, options, false);
}

function buildCodexApiResponsesRequestBody(
  input: ModelStreamInput,
  options: CodexApiRequestBuildOptions,
): Record<string, unknown> {
  return buildCodexResponsesRequestBody(input, options, true);
}

function buildCodexResponsesRequestBody(
  input: ModelStreamInput,
  options: OpenAICodexRequestBuildOptions,
  includeMaxOutputTokens: boolean,
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
    input: toResponsesInput(messages, supportsImageInput(options.inputCapabilities)),
    text: { verbosity: options.textVerbosity ?? "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  const instructions = instructionText(messages, input.system ?? [], input.developer ?? []);
  if (instructions) body.instructions = instructions;
  if (includeMaxOutputTokens && options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.sessionId) body.prompt_cache_key = options.sessionId;
  const serviceTier = openAICodexWireServiceTier(options.serviceTier);
  if (serviceTier) body.service_tier = serviceTier;
  const effort = resolveOpenAICodexReasoningEffort(model, options.reasoningEffort);
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

function toResponsesInput(messages: readonly Message[], includeImageContent = true): CodexResponseInputItem[] {
  const output: CodexResponseInputItem[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      for (const part of message.parts) {
        if (part.type === "reasoning" && isReplayableResponsesReasoningItem(part.modelOutput)) {
          output.push(part.modelOutput.item);
          continue;
        }
        if (part.type === "text") {
          if (!part.text) continue;
          output.push({
            role: "assistant",
            phase: requireCodexHistoryPhase(part.phase),
            content: [{ type: "output_text", text: part.text }],
          });
          continue;
        }
        if (part.type === "tool_call") {
          output.push({
            type: "function_call",
            call_id: normalizeResponsesId(String(part.callId)),
            name: part.toolName,
            arguments: stringifyToolInput(part.input),
          });
        }
      }
      continue;
    }

    const content = userMessageContent(message.parts, includeImageContent);
    if (content.length > 0) output.push({ role: "user", content });
    for (const part of message.parts) {
      if (part.type !== "tool_result") continue;
      output.push({
        type: "function_call_output",
        call_id: normalizeResponsesId(String(part.callId)),
        output: formatToolResultForModel(part),
      });
      const imageContent = toolResultImageContent(part, includeImageContent);
      if (imageContent.length > 0) output.push({ role: "user", content: imageContent });
    }
  }
  return output;
}

function isReplayableResponsesReasoningItem(
  output: Extract<MessagePart, { type: "reasoning" }>["modelOutput"],
): output is NonNullable<Extract<MessagePart, { type: "reasoning" }>["modelOutput"]> & {
  item: Record<string, unknown> & { type: "reasoning"; encrypted_content: string };
} {
  return output?.apiFamily === "openai-responses"
    && output.item.type === "reasoning"
    && typeof output.item.encrypted_content === "string";
}

function userMessageContent(parts: readonly MessagePart[], includeImageContent = true): CodexResponseMessageContent[] {
  const content: CodexResponseMessageContent[] = [];
  const text = messageText(parts, "text");
  if (text) content.push({ type: "input_text", text });
  if (!includeImageContent) return content;
  for (const part of parts) {
    if (part.type !== "image") continue;
    content.push({
      type: "input_image",
      image_url: imageDataUrl(part),
    });
  }
  return content;
}

function instructionText(messages: readonly Message[], system: readonly string[], developer: readonly string[]): string {
  return [
    ...system,
    ...developer,
    ...messages
      .filter((message) => message.role === "system")
      .map((message) => messageText(message.parts, "text"))
      .filter(Boolean),
  ].join("\n\n");
}

function messageText(parts: readonly MessagePart[], mode: "text" | "reasoning"): string {
  return parts
    .filter((part): part is Extract<MessagePart, { type: "text" | "reasoning" }> =>
      mode === "reasoning" ? part.type === "reasoning" : part.type === "text" || part.type === "reasoning",
    )
    .map((part) => part.text)
    .join("\n");
}

function toResponsesTools(tools: readonly ModelTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: null,
  }));
}

function reasoningSectionEventIndex(payload: CodexStreamPayload, indexes: Map<string, number>): number {
  const itemKey = payload.item_id ?? `output:${payload.output_index ?? 0}`;
  const key = `${itemKey}\0${payload.summary_index ?? 0}`;
  const existing = indexes.get(key);
  if (existing !== undefined) return existing;
  const index = indexes.size;
  indexes.set(key, index);
  return index;
}

function requireCodexMessageOutputIndex(index: number | undefined): number {
  if (index === undefined || !Number.isInteger(index) || index < 0) {
    throw new Error("OpenAI Codex stream message output item has an invalid output index");
  }
  return index;
}

function requireCodexAssistantPhase(phase: string | undefined, index: number): AssistantMessagePhase {
  if (phase === undefined) {
    throw new Error(`OpenAI Codex message output index ${index} is missing assistant phase`);
  }
  if (phase !== "commentary" && phase !== "final_answer") {
    throw new Error(`OpenAI Codex message output index ${index} has an invalid assistant phase`);
  }
  return phase;
}

function recordCodexAssistantPhase(
  phases: Map<number, AssistantMessagePhase>,
  outputIndex: number | undefined,
  rawPhase: string | undefined,
  provider: typeof OPENAI_CODEX_PROVIDER_ID | typeof CODEX_API_PROVIDER_ID,
  response: Response,
): void {
  let index: number;
  let phase: AssistantMessagePhase;
  try {
    index = requireCodexMessageOutputIndex(outputIndex);
    phase = requireCodexAssistantPhase(rawPhase, index);
  } catch (error) {
    throw codexProtocolError(
      provider,
      error instanceof Error ? error.message : "OpenAI Codex stream contained an invalid message item",
      response,
    );
  }
  const existing = phases.get(index);
  if (existing !== undefined && existing !== phase) {
    throw codexProtocolError(
      provider,
      `OpenAI Codex stream has conflicting assistant phase for output index ${index}`,
      response,
    );
  }
  phases.set(index, phase);
}

function requireCodexHistoryPhase(phase: AssistantMessagePhase | undefined): AssistantMessagePhase {
  if (phase === undefined) {
    throw new Error("OpenAI Codex assistant text part is missing phase");
  }
  if (phase !== "commentary" && phase !== "final_answer") {
    throw new Error(`OpenAI Codex assistant text part has invalid phase ${JSON.stringify(phase)}`);
  }
  return phase;
}

function createToolState(item: CodexOutputItem, index: number | undefined): ToolStreamState {
  const state: ToolStreamState = {
    toolCallId: normalizeResponsesId(item.call_id ?? item.id ?? `call_${index ?? 0}`),
    name: item.name ?? "",
    partialJson: item.arguments ?? "",
    started: Boolean(item.name),
    ended: false,
  };
  if (item.id) state.itemId = item.id;
  if (index !== undefined) state.index = index;
  return state;
}

function toolStateKey(state: ToolStreamState): string {
  return state.itemId ?? state.toolCallId;
}

function findToolState(
  tools: Map<string, ToolStreamState>,
  payload: CodexStreamPayload,
  activeKey: string | undefined,
): ToolStreamState | undefined {
  if (payload.item_id && tools.has(payload.item_id)) return tools.get(payload.item_id);
  if (payload.item?.id && tools.has(payload.item.id)) return tools.get(payload.item.id);
  if (payload.item?.call_id) {
    const byCallId = Array.from(tools.values()).find((tool) => tool.toolCallId === normalizeResponsesId(payload.item?.call_id ?? ""));
    if (byCallId) return byCallId;
  }
  if (activeKey) return tools.get(activeKey);
  return Array.from(tools.values()).at(-1);
}

function startToolEvent(tool: ToolStreamState): ModelStreamEvent {
  const event: ModelStreamEvent = {
    type: "tool_call_start",
    toolCallId: tool.toolCallId,
    name: tool.name,
  };
  if (tool.index !== undefined) event.index = tool.index;
  return event;
}

function toolDeltaEvent(tool: ToolStreamState, delta: string, partialInput: unknown): ModelStreamEvent {
  const event: ModelStreamEvent = {
    type: "tool_call_delta",
    toolCallId: tool.toolCallId,
    name: tool.name,
    delta,
  };
  if (tool.index !== undefined) event.index = tool.index;
  if (partialInput !== undefined) event.partialInput = partialInput;
  return event;
}

function finishToolEvent(tool: ToolStreamState): ModelStreamEvent {
  const finalInput = finalToolInput(tool.partialJson);
  const event: ModelStreamEvent = {
    type: "tool_call_end",
    toolCallId: tool.toolCallId,
    name: tool.name,
    input: finalInput.input,
  };
  if (finalInput.inputParseError) event.inputParseError = finalInput.inputParseError;
  if (tool.index !== undefined) event.index = tool.index;
  return event;
}

function toModelUsage(usage: CodexUsage | undefined): ModelUsage | undefined {
  if (!usage) return undefined;
  const modelUsage: ModelUsage = { raw: usage };
  const cacheReadInputTokens = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheCreationInputTokens = usage.input_tokens_details?.cache_write_tokens ?? 0;
  if (usage.input_tokens != null) {
    modelUsage.inputTokens = Math.max(0, usage.input_tokens - cacheReadInputTokens - cacheCreationInputTokens);
  }
  if (usage.output_tokens != null) modelUsage.outputTokens = usage.output_tokens;
  if (cacheReadInputTokens > 0) modelUsage.cacheReadInputTokens = cacheReadInputTokens;
  if (cacheCreationInputTokens > 0) modelUsage.cacheCreationInputTokens = cacheCreationInputTokens;
  modelUsage.totalTokens =
    usage.total_tokens ??
    (modelUsage.inputTokens ?? 0) +
      (modelUsage.outputTokens ?? 0) +
      (modelUsage.cacheReadInputTokens ?? 0) +
      (modelUsage.cacheCreationInputTokens ?? 0);
  return modelUsage;
}

function metadataEvent(provider: string, model: string, responseId: string | undefined, usage: ModelUsage | undefined): ModelStreamEvent {
  const event: ModelStreamEvent = { type: "metadata", provider, model };
  if (responseId) event.responseId = responseId;
  if (usage) event.usage = usage;
  return event;
}

function finishEvent(reason: string, responseId: string | undefined, usage: ModelUsage | undefined): ModelStreamEvent {
  const event: ModelStreamEvent = { type: "finish", reason };
  if (responseId) event.responseId = responseId;
  if (usage) event.usage = usage;
  return event;
}

function mapCodexFinishReason(status: string | undefined, sawToolCall: boolean): string {
  if (status === "incomplete") return "length";
  if (status === "failed" || status === "cancelled") return "error";
  if (sawToolCall) return "tool_use";
  return "stop";
}

async function parseCodexErrorResponse(
  response: Response,
  provider: typeof OPENAI_CODEX_PROVIDER_ID | typeof CODEX_API_PROVIDER_ID,
  chatGptUsageMessage: boolean,
  label: string,
): Promise<ProviderRequestError> {
  return providerHttpError(response, {
    provider,
    label,
    selectJson: ({ json }) => {
      const error = codexJsonError(json);
      if (!error) return undefined;
      const details = codexProviderErrorDetails(error);
      const code = typeof error === "string"
        ? error
        : nonEmptyCode(error.code) ?? nonEmptyString(error.type) ?? "";
      if (
        chatGptUsageMessage
        && /(?:^|[_-])usage(?:[_-]limit[_-]reached|[_-]not[_-]included)(?:$|[_-])/i.test(code)
      ) {
        const resetsAt = typeof error === "string" || typeof error.resets_at !== "number" || !Number.isFinite(error.resets_at)
          ? undefined
          : error.resets_at;
        const minutes = resetsAt === undefined
          ? undefined
          : Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60000));
        const retryAfterMs = resetsAt === undefined
          ? undefined
          : Math.max(0, resetsAt * 1000 - Date.now());
        const retry = minutes !== undefined ? ` Try again in ~${minutes} min.` : "";
        return {
          ...(details ?? {}),
          publicMessage: `You have hit your ChatGPT usage limit.${retry}`.trim(),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          category: "quota_exhausted",
          retryable: false,
          opensCircuit: true,
        };
      }
      return details;
    },
  });
}

function formatCodexStreamError(
  payload: CodexStreamPayload | undefined,
  provider: typeof OPENAI_CODEX_PROVIDER_ID | typeof CODEX_API_PROVIDER_ID,
  label: string,
  response?: Response,
): ProviderRequestError {
  const details = codexStreamErrorDetails(payload);
  return providerPayloadError(payload, {
    provider,
    label,
    ...(response ? { response } : {}),
    ...(details ? { details } : {}),
  });
}

function codexProtocolError(
  provider: typeof OPENAI_CODEX_PROVIDER_ID | typeof CODEX_API_PROVIDER_ID,
  label: string,
  response?: Response,
): ProviderRequestError {
  return providerPayloadError(undefined, {
    provider,
    label,
    ...(response ? { response } : {}),
  });
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  return contentType === undefined || contentType.includes("text/event-stream");
}

function codexStreamErrorDetails(payload: CodexStreamPayload | undefined): CodexProviderErrorDetails | undefined {
  if (!payload) return undefined;
  const direct: CodexErrorPayload = {};
  const message = nonEmptyString(payload.message);
  const code = nonEmptyCode(payload.code);
  if (message) direct.message = message;
  if (code) direct.code = code;
  return codexProviderErrorDetails(payload.error)
    ?? codexProviderErrorDetails(payload.response?.error)
    ?? codexProviderErrorDetails(direct);
}

function codexJsonError(value: unknown): CodexErrorPayload | string | undefined {
  if (!isRecord(value)) return undefined;
  const error = value.error;
  if (typeof error === "string") return nonEmptyString(error);
  if (!isRecord(error)) return undefined;

  const result: CodexErrorPayload = {};
  const message = nonEmptyString(error.message);
  const code = nonEmptyCode(error.code);
  const type = nonEmptyString(error.type);
  const param = nonEmptyString(error.param);
  const requestId = nonEmptyString(error.request_id);
  const camelRequestId = nonEmptyString(error.requestId);
  const planType = nonEmptyString(error.plan_type);
  if (message) result.message = message;
  if (code) result.code = code;
  if (type) result.type = type;
  if (param) result.param = param;
  if (requestId) result.request_id = requestId;
  if (camelRequestId) result.requestId = camelRequestId;
  if (planType) result.plan_type = planType;
  if (typeof error.resets_at === "number" && Number.isFinite(error.resets_at)) {
    result.resets_at = error.resets_at;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codexProviderErrorDetails(
  error: CodexErrorPayload | string | undefined,
): CodexProviderErrorDetails | undefined {
  if (!error) return undefined;
  if (typeof error === "string") return { message: error };

  const message = nonEmptyString(error.message);
  const code = nonEmptyCode(error.code);
  const type = nonEmptyString(error.type);
  const param = nonEmptyString(error.param);
  const requestId = nonEmptyString(error.request_id ?? error.requestId);
  if (!message && !code && !type && !param && !requestId) return undefined;
  return {
    ...(message ? { message } : {}),
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
    ...(param ? { param } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function nonEmptyCode(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return nonEmptyString(value);
}

function nonEmptyString(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
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
  const clamped = clampModelReasoningLevel(canonicalModel, effort);
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

function normalizeResponsesId(id: string): string {
  const sanitized = id.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  if (!sanitized) return "call";
  return sanitized.slice(0, 64);
}

function stringifyToolInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

function finalToolInput(value: string): FinalToolInput {
  if (!value) return { input: {} };
  try {
    return { input: JSON.parse(value) as unknown };
  } catch (error) {
    return {
      input: {},
      inputParseError: formatToolInputParseError(error),
    };
  }
}

function formatToolInputParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    ? `Tool call arguments were not valid JSON: ${message}`
    : "Tool call arguments were not valid JSON.";
}

function toolResultImageContent(
  part: Extract<MessagePart, { type: "tool_result" }>,
  includeImageContent = true,
): CodexResponseMessageContent[] {
  if (part.error || !includeImageContent) return [];
  const images = (part.content ?? []).filter((item) => item.type === "image");
  if (images.length === 0) return [];
  return [
    { type: "input_text", text: `Image returned by tool call ${String(part.callId)}.` },
    ...images.map((image) => ({
      type: "input_image" as const,
      image_url: imageDataUrl(image),
    })),
  ];
}

function imageDataUrl(image: Pick<Extract<MessagePart, { type: "image" }>, "data" | "mimeType">): string {
  return `data:${image.mimeType};base64,${image.data}`;
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

function parseJson<T>(text: string, fallback: T | undefined): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function withoutDefaultFlag(model: ModelDescriptor): ModelDescriptor {
  const descriptor: ModelDescriptor = { ...model };
  delete descriptor.default;
  return descriptor;
}
