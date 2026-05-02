import { platform, release, arch } from "node:os";
import type { Message, MessagePart } from "@chili/protocol";
import { FileAuthStorage, type OAuthCredentials } from "./auth.js";
import { type EnvironmentSource, readOpenAICodexEnvironment } from "./env.js";
import {
  findDefaultKnownModel,
  findKnownModel,
  listKnownModels,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID,
} from "./models.js";
import { normalizeReasoningLevel, parseModelSelectionPattern } from "./model-selection.js";
import {
  extractOpenAICodexAccountId,
  refreshOpenAICodexToken,
} from "./oauth/openai-codex.js";
import { readSseEvents } from "./sse.js";
import { prependContextualUserMessage, transformModelMessages } from "./transform-messages.js";
import type {
  ChiliModel,
  ChiliModelProvider,
  ModelDescriptor,
  ModelStreamEvent,
  ModelStreamInput,
  ModelTool,
  ModelUsage,
  ReasoningLevel,
} from "./types.js";

export {
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID,
} from "./models.js";

export type OpenAICodexReasoningEffort = Exclude<ReasoningLevel, "off">;

export interface OpenAICodexModelOptions {
  apiKey?: string;
  accountId?: string;
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
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  textVerbosity?: "low" | "medium" | "high";
}

export interface OpenAICodexRequestBuildOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  sessionId?: string;
  reasoningEffort?: ReasoningLevel;
  reasoningSummary?: OpenAICodexModelOptions["reasoningSummary"];
  textVerbosity?: OpenAICodexModelOptions["textVerbosity"];
}

type CodexResponseInputItem =
  | {
      role: "user" | "assistant";
      content: Array<{ type: "input_text" | "output_text"; text: string }>;
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
    };

interface CodexStreamPayload {
  type?: string;
  response?: {
    id?: string;
    status?: string;
    usage?: CodexUsage;
    model?: string;
    error?: { message?: string; code?: string };
  };
  item?: CodexOutputItem;
  delta?: string;
  arguments?: string;
  output_index?: number;
  item_id?: string;
  code?: string;
  message?: string;
}

interface CodexOutputItem {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
  summary?: Array<{ text?: string }>;
}

interface CodexUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  input_tokens_details?: {
    cached_tokens?: number | null;
  };
}

interface ResolvedCodexCredentials {
  access: string;
  accountId: string;
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

const TOKEN_REFRESH_SKEW_MS = 60_000;

export class OpenAICodexProvider implements ChiliModelProvider {
  readonly id = OPENAI_CODEX_PROVIDER_ID;
  readonly name = "ChatGPT Codex";

  constructor(private readonly options: OpenAICodexModelOptions = {}) {}

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
    const env = readOpenAICodexEnvironment(this.options.env);
    return this.options.model ?? env.model ?? OPENAI_CODEX_DEFAULT_MODEL;
  }

  private defaultBaseUrl(): string {
    const env = readOpenAICodexEnvironment(this.options.env);
    const descriptor = findKnownModel(this.id, this.defaultModel()) ?? findDefaultKnownModel(this.id);
    return this.options.baseUrl ?? env.baseUrl ?? descriptor?.baseUrl ?? OPENAI_CODEX_BASE_URL;
  }
}

export class OpenAICodexResponsesModel implements ChiliModel {
  readonly provider = OPENAI_CODEX_PROVIDER_ID;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authStorage: FileAuthStorage;

  constructor(private readonly options: OpenAICodexModelOptions = {}) {
    const env = readOpenAICodexEnvironment(options.env);
    this.model = options.model ?? env.model ?? OPENAI_CODEX_DEFAULT_MODEL;
    this.fetchImpl = options.fetch ?? fetch;
    this.authStorage = options.authStorage ?? new FileAuthStorage(options.authPath);
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    const credentials = await this.resolveCredentials();
    const env = readOpenAICodexEnvironment(this.options.env);
    const requestOptions = resolveOpenAICodexStreamRequestOptions(input, this.options);

    const init: RequestInit = {
      method: "POST",
      headers: this.headers(credentials, requestOptions.sessionId),
      body: JSON.stringify(buildOpenAICodexResponsesRequestBody(input, requestOptions)),
    };
    if (input.signal) init.signal = input.signal;

    yield { type: "metadata", provider: this.provider, model: requestOptions.model };
    const response = await this.fetchImpl(resolveOpenAICodexResponsesUrl(this.options.baseUrl ?? env.baseUrl), init);
    if (!response.ok) {
      throw new Error(await parseCodexErrorResponse(response));
    }
    if (!response.body) throw new Error("OpenAI Codex response did not include a body");
    yield* this.streamSseResponse(response.body, input.signal, requestOptions.model);
  }

  private async resolveCredentials(): Promise<ResolvedCodexCredentials> {
    const env = readOpenAICodexEnvironment(this.options.env);
    const directAccess = this.options.apiKey ?? env.apiKey;
    if (directAccess) {
      return {
        access: directAccess,
        accountId: this.options.accountId ?? extractOpenAICodexAccountId(directAccess),
      };
    }

    const stored = await this.authStorage.getOAuthCredentials(this.provider);
    if (!stored) {
      throw new Error(
        `No ChatGPT Codex credentials found. Run /login in the Chili TUI, then start Chili with --model codex.`,
      );
    }
    if (stored.expires > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return { access: stored.access, accountId: stored.accountId };
    }

    const refreshed = await refreshOpenAICodexToken(stored.refresh, { fetch: this.fetchImpl, previous: stored });
    await this.authStorage.setOAuthCredentials(this.provider, refreshed);
    return { access: refreshed.access, accountId: refreshed.accountId };
  }

  private headers(credentials: ResolvedCodexCredentials, sessionId: string | undefined): HeadersInit {
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${credentials.access}`,
      "chatgpt-account-id": credentials.accountId,
      originator: "chili",
      "user-agent": `chili (${platform()} ${release()}; ${arch()})`,
      "openai-beta": "responses=experimental",
      ...this.options.headers,
    };
    if (sessionId) {
      headers.session_id = sessionId;
      headers["x-client-request-id"] = sessionId;
    }
    return headers;
  }

  private async *streamSseResponse(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
    requestModel: string = this.model,
  ): AsyncIterable<ModelStreamEvent> {
    let responseId: string | undefined;
    let usage: ModelUsage | undefined;
    let finishReason = "stop";
    let sawToolCall = false;
    const toolCalls = new Map<string, ToolStreamState>();
    let activeToolKey: string | undefined;

    for await (const event of readSseEvents(body, signal)) {
      if (event.data === "[DONE]") break;
      const payload = parseJson<CodexStreamPayload>(event.data, undefined);
      if (!payload?.type) continue;

      if (payload.type === "error") {
        throw new Error(payload.message || payload.code || "OpenAI Codex stream error");
      }
      if (payload.type === "response.failed") {
        throw new Error(payload.response?.error?.message || "OpenAI Codex response failed");
      }

      if (payload.type === "response.created") {
        responseId = payload.response?.id ?? responseId;
        yield metadataEvent(this.provider, payload.response?.model ?? requestModel, responseId, usage);
        continue;
      }

      if (payload.type === "response.output_item.added" && payload.item) {
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
        yield { type: "reasoning_delta", text: payload.delta, index: payload.output_index ?? 0 };
        continue;
      }

      if ((payload.type === "response.output_text.delta" || payload.type === "response.refusal.delta") && payload.delta) {
        yield { type: "text_delta", text: payload.delta, index: payload.output_index ?? 0 };
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
        finishReason = mapCodexFinishReason(payload.response?.status, sawToolCall);
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

export function createOpenAICodexProvider(options: OpenAICodexModelOptions = {}): OpenAICodexProvider {
  return new OpenAICodexProvider(options);
}

export function createOpenAICodexRouter(options: OpenAICodexModelOptions = {}): OpenAICodexResponsesModel {
  return createOpenAICodexModel(options);
}

export function createOpenAICodexModel(options: OpenAICodexModelOptions = {}): OpenAICodexResponsesModel {
  return new OpenAICodexResponsesModel(options);
}

export function resolveOpenAICodexStreamRequestOptions(
  input: ModelStreamInput,
  options: OpenAICodexModelOptions = {},
): OpenAICodexRequestBuildOptions {
  const env = readOpenAICodexEnvironment(options.env);
  const selection = readOpenAICodexInputSelection(input);
  if (selection.provider && selection.provider.toLowerCase() !== OPENAI_CODEX_PROVIDER_ID) {
    throw new Error(`OpenAI Codex model cannot stream provider "${selection.provider}"`);
  }

  const model = selection.model ?? options.model ?? env.model ?? OPENAI_CODEX_DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? options.maxTokens;
  const temperature = input.temperature ?? options.temperature;
  const requestOptions: OpenAICodexRequestBuildOptions = { model };
  const sessionId = metadataString(input.metadata, "sessionId");
  const reasoningEffort = selection.reasoning ?? options.reasoningEffort;
  if (sessionId) requestOptions.sessionId = sessionId;
  if (options.textVerbosity !== undefined) requestOptions.textVerbosity = options.textVerbosity;
  if (reasoningEffort !== undefined) requestOptions.reasoningEffort = reasoningEffort;
  if (options.reasoningSummary !== undefined) requestOptions.reasoningSummary = options.reasoningSummary;
  if (maxTokens !== undefined) requestOptions.maxTokens = maxTokens;
  if (temperature !== undefined) requestOptions.temperature = temperature;
  return requestOptions;
}

export function resolveOpenAICodexResponsesUrl(baseUrl?: string): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : OPENAI_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

export function buildOpenAICodexResponsesRequestBody(
  input: ModelStreamInput,
  options: OpenAICodexRequestBuildOptions,
): Record<string, unknown> {
  const messages = prependContextualUserMessage(
    transformModelMessages(input.messages, { normalizeToolCallId: normalizeResponsesId }),
    input.contextualUser,
  );
  const body: Record<string, unknown> = {
    model: options.model,
    store: false,
    stream: true,
    input: toResponsesInput(messages),
    text: { verbosity: options.textVerbosity ?? "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  const instructions = instructionText(messages, input.system ?? [], input.developer ?? []);
  if (instructions) body.instructions = instructions;
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.sessionId) body.prompt_cache_key = options.sessionId;
  const effort = resolveOpenAICodexReasoningEffort(options.model, options.reasoningEffort);
  if (effort !== undefined || options.reasoningSummary !== undefined) {
    const reasoning: Record<string, string> = {};
    if (effort !== undefined) reasoning.effort = effort;
    if (options.reasoningSummary !== null) reasoning.summary = options.reasoningSummary ?? "auto";
    if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;
  }

  const tools = toResponsesTools(input.tools ?? []);
  if (tools.length > 0) body.tools = tools;
  return body;
}

function toResponsesInput(messages: readonly Message[]): CodexResponseInputItem[] {
  const output: CodexResponseInputItem[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      const text = messageText(message.parts, "text");
      if (text) output.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const part of message.parts) {
        if (part.type !== "tool_call") continue;
        output.push({
          type: "function_call",
          call_id: normalizeResponsesId(String(part.callId)),
          name: part.toolName,
          arguments: stringifyToolInput(part.input),
        });
      }
      continue;
    }

    const text = messageText(message.parts, "text");
    if (text) output.push({ role: "user", content: [{ type: "input_text", text }] });
    for (const part of message.parts) {
      if (part.type !== "tool_result") continue;
      output.push({
        type: "function_call_output",
        call_id: normalizeResponsesId(String(part.callId)),
        output: formatToolResult(part),
      });
    }
  }
  return output;
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
  const event: ModelStreamEvent = {
    type: "tool_call_end",
    toolCallId: tool.toolCallId,
    name: tool.name,
    input: finalToolInput(tool.partialJson),
  };
  if (tool.index !== undefined) event.index = tool.index;
  return event;
}

function toModelUsage(usage: CodexUsage | undefined): ModelUsage | undefined {
  if (!usage) return undefined;
  const modelUsage: ModelUsage = { raw: usage };
  if (usage.input_tokens != null) modelUsage.inputTokens = usage.input_tokens;
  if (usage.output_tokens != null) modelUsage.outputTokens = usage.output_tokens;
  if (usage.input_tokens_details?.cached_tokens != null) {
    modelUsage.cacheReadInputTokens = usage.input_tokens_details.cached_tokens;
  }
  modelUsage.totalTokens =
    usage.total_tokens ??
    (modelUsage.inputTokens ?? 0) + (modelUsage.outputTokens ?? 0) + (modelUsage.cacheReadInputTokens ?? 0);
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
  if (sawToolCall) return "tool_use";
  if (status === "incomplete") return "length";
  if (status === "failed" || status === "cancelled") return "error";
  return "stop";
}

async function parseCodexErrorResponse(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: string; type?: string; message?: string; plan_type?: string; resets_at?: number } };
    const error = parsed.error;
    if (error) {
      const code = error.code || error.type || "";
      if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
        const plan = error.plan_type ? ` (${error.plan_type.toLowerCase()} plan)` : "";
        const minutes = error.resets_at ? Math.max(0, Math.round((error.resets_at * 1000 - Date.now()) / 60000)) : undefined;
        const retry = minutes !== undefined ? ` Try again in ~${minutes} min.` : "";
        return `You have hit your ChatGPT usage limit${plan}.${retry}`.trim();
      }
      return error.message || raw || `OpenAI Codex request failed with HTTP ${response.status}`;
    }
  } catch {
    // Fall back to raw text below.
  }
  return raw || `OpenAI Codex request failed with HTTP ${response.status}`;
}

export function resolveOpenAICodexReasoningEffort(
  model: string,
  effort: ReasoningLevel | null | undefined,
): OpenAICodexReasoningEffort | undefined {
  if (effort === undefined || effort === null || effort === "off") return undefined;
  return clampOpenAICodexReasoningEffort(model, effort);
}

export function clampOpenAICodexReasoningEffort(
  model: string,
  effort: OpenAICodexReasoningEffort,
): OpenAICodexReasoningEffort {
  const id = model.includes("/") ? model.split("/").at(-1) ?? model : model;
  if (
    (id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3") || id.startsWith("gpt-5.4") || id.startsWith("gpt-5.5")) &&
    effort === "minimal"
  ) {
    return "low";
  }
  if (id === "gpt-5.1" && effort === "xhigh") return "high";
  if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
  return effort;
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

function finalToolInput(value: string): unknown {
  if (!value) return {};
  return parseJson(value, {});
}

function formatToolResult(part: Extract<MessagePart, { type: "tool_result" }>): string {
  if (part.error) return part.output ? `${part.output}\n\nError: ${part.error}` : `Error: ${part.error}`;
  return part.output;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value ? value : undefined;
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
