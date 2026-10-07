import { credentialVersionFingerprint, recordRequestIdentity, runModelRequest } from "./request-lifecycle.js";
import {
  formatToolResultForModel,
  normalizeToolCallId,
  type Message,
  type MessagePart,
  type ServiceTier,
} from "@chili/protocol";
import type {
  ChiliModel,
  ModelInputCapability,
  ModelStreamEvent,
  ModelStreamInput,
  ModelTool,
  ModelUsage,
  ReasoningLevel,
} from "./types.js";
import type { MessagesCompatibility } from "./compat.js";
import { clampReasoningLevel } from "./model-selection.js";
import { assertImageInputSupported } from "./image-input.js";
import {
  sharedProviderBackpressureCoordinator,
  type ProviderBackpressureCoordinator,
  type ProviderRequestScope,
} from "./provider-backpressure.js";
import {
  providerHttpError,
  providerPayloadError,
  providerStreamProtocolError,
  type ProviderErrorDetails,
} from "./provider-error.js";
import { readSseEvents } from "./sse.js";
import { normalizeAnthropicToolCallId, prependContextualUserMessage, transformModelMessages } from "./transform-messages.js";

export type AnthropicAuthScheme = "bearer" | "x-api-key";

export interface AnthropicCompatibleModelOptions {
  provider?: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  authScheme?: AnthropicAuthScheme;
  maxTokens?: number;
  temperature?: number;
  reasoning?: boolean;
  reasoningEffort?: ReasoningLevel;
  compatibility?: Partial<MessagesCompatibility>;
  serviceTier?: ServiceTier;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  inputCapabilities?: readonly ModelInputCapability[];
  backpressureCoordinator?: ProviderBackpressureCoordinator;
  /** Defaults to streaming. Legacy adapters may request JSON while sharing the same execution boundary. */
  stream?: boolean;
}

export interface AnthropicRequestBuildOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: boolean;
  reasoningEffort?: ReasoningLevel;
  compatibility?: Partial<MessagesCompatibility>;
  serviceTier?: ServiceTier;
  stream?: boolean;
  inputCapabilities?: readonly ModelInputCapability[];
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: AnthropicToolResultContent; is_error?: boolean };

interface AnthropicImageSource {
  type: "base64";
  media_type: string;
  data: string;
}

type AnthropicToolResultContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; source: AnthropicImageSource }
    >;

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: unknown;
}

interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: AnthropicUsage;
  error?: AnthropicErrorPayload;
}

interface AnthropicErrorPayload {
  message?: string;
  type?: string;
  code?: string | number;
  error_code?: string | number;
  status_code?: string | number;
  retry_after?: string | number;
  retry_after_ms?: string | number;
}

interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface AnthropicSsePayload {
  type?: string;
  index?: number;
  message?: {
    id?: string;
    model?: string;
    usage?: AnthropicUsage;
  };
  content_block?: AnthropicContentBlock & {
    id?: string;
    name?: string;
    input?: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: AnthropicUsage;
  error?: AnthropicErrorPayload;
}

interface ToolBlockState {
  toolCallId: string;
  name: string;
  partialJson: string;
  initialInput: unknown;
}

interface FinalToolInput {
  input: unknown;
  inputParseError?: string;
}

export class AnthropicCompatibleModel implements ChiliModel {
  readonly provider: string;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly backpressureCoordinator: ProviderBackpressureCoordinator;
  private readonly requestScope: ProviderRequestScope;

  constructor(private readonly options: AnthropicCompatibleModelOptions) {
    if (!options.apiKey) throw new Error("Anthropic-compatible model requires an API key");
    if (!options.model) throw new Error("Anthropic-compatible model requires a model name");
    if (!options.baseUrl) throw new Error("Anthropic-compatible model requires a baseUrl");
    this.provider = options.provider ?? "anthropic-compatible";
    this.model = options.model;
    this.fetchImpl = options.fetch ?? fetch;
    this.backpressureCoordinator = options.backpressureCoordinator ?? sharedProviderBackpressureCoordinator;
    this.requestScope = {
      provider: this.provider,
      endpoint: resolveMessagesUrl(options.baseUrl),
      credential: options.apiKey,
    };
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    yield* runModelRequest(input, (bounded) => this.streamRequest(bounded));
  }

  private async *streamRequest(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    assertImageInputSupported(input, {
      provider: this.provider,
      model: this.options.model,
      inputCapabilities: this.options.inputCapabilities,
    });

    const requestOptions: AnthropicRequestBuildOptions = {
      model: this.options.model,
      stream: this.options.stream ?? true,
    };
    if (this.options.inputCapabilities) requestOptions.inputCapabilities = this.options.inputCapabilities;
    const maxTokens = input.maxTokens ?? this.options.maxTokens;
    const temperature = input.temperature ?? this.options.temperature;
    if (maxTokens !== undefined) requestOptions.maxTokens = maxTokens;
    if (temperature !== undefined) requestOptions.temperature = temperature;
    const requestControlsEnabled = this.provider === "minimax"
      || this.options.reasoning !== undefined || this.options.serviceTier !== undefined;
    const requestReasoning = requestControlsEnabled
      ? reasoningEnabledForInput(input) ?? this.options.reasoning
      : this.options.reasoning;
    const requestServiceTier = requestControlsEnabled
      ? input.serviceTier ?? this.options.serviceTier
      : this.options.serviceTier;
    if (requestReasoning !== undefined) requestOptions.reasoning = requestReasoning;
    if (this.options.compatibility) requestOptions.compatibility = this.options.compatibility;
    const effort = reasoningLevelForInput(input) ?? this.options.reasoningEffort;
    if (effort !== undefined) requestOptions.reasoningEffort = effort;
    if (requestServiceTier !== undefined) requestOptions.serviceTier = requestServiceTier;

    const init: RequestInit = {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(buildAnthropicRequestBody(input, requestOptions)),
    };
    if (input.signal) init.signal = input.signal;

    await this.backpressureCoordinator.beforeRequest(this.requestScope, input.signal);
    await recordRequestIdentity(input, {
      provider: this.provider,
      model: this.model,
      credentialVersion: credentialVersionFingerprint(new Headers(init.headers).get(this.options.authScheme === "bearer" ? "authorization" : "x-api-key") ?? this.options.apiKey),
    });
    const response = await this.fetchImpl(this.requestScope.endpoint ?? resolveMessagesUrl(this.options.baseUrl), init);
    if (!response.ok) {
      const error = await providerHttpError(response, {
        provider: this.provider,
        label: "Model request",
        selectJson: ({ json }) => anthropicErrorDetails(json),
      });
      this.backpressureCoordinator.recordError(this.requestScope, error);
      throw error;
    }

    if (isEventStream(response) && response.body) {
      yield* this.streamSseResponse(response.body, response, input.signal);
      return;
    }

    yield* this.streamJsonResponse(await response.text(), response);
  }

  private async *streamSseResponse(
    body: ReadableStream<Uint8Array>,
    response: Response,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    let responseId: string | undefined;
    let usage: ModelUsage | undefined;
    let finishReason = "stop";
    const toolBlocks = new Map<number, ToolBlockState>();
    const contentBlocks = new Map<number, "text" | "reasoning">();

    for await (const event of readSseEvents(body, signal)) {
      if (event.data === "[DONE]") break;
      const parsed = parseJson<AnthropicSsePayload>(event.data, undefined);
      if (parsed?.type === "error" || event.event === "error") {
        const details = anthropicErrorDetails(parsed);
        const error = providerPayloadError(parsed, {
          provider: this.provider,
          label: "Model stream failed",
          response,
          ...(details ? { details } : {}),
        });
        this.backpressureCoordinator.recordError(this.requestScope, error);
        yield errorEvent(error, responseId, usage);
        return;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        if (!event.data.trim()) continue;
        throw providerStreamProtocolError(this.provider, "Model stream contained invalid JSON", response, "invalid_stream");
      }
      const payload = parsed;
      if (payload.type === undefined && event.event !== undefined) payload.type = event.event;

      if (payload.type === "message_start") {
        responseId = payload.message?.id;
        usage = mergeUsage(usage, payload.message?.usage);
        const metadata = metadataEvent(this.provider, payload.message?.model ?? this.model, responseId, usage);
        if (metadata) yield metadata;
        continue;
      }

      if (payload.type === "content_block_start" && payload.index !== undefined && payload.content_block) {
        const block = payload.content_block;
        if (block.type === "text") {
          contentBlocks.set(payload.index, "text");
          if (block.text) yield { type: "text_delta", text: block.text, index: payload.index };
          continue;
        }
        if (block.type === "thinking") {
          contentBlocks.set(payload.index, "reasoning");
          if (block.thinking) yield { type: "reasoning_delta", text: block.thinking, index: payload.index };
          continue;
        }
        if (block.type === "redacted_thinking") {
          contentBlocks.set(payload.index, "reasoning");
          yield { type: "reasoning_delta", text: "[Reasoning redacted]", index: payload.index, redacted: true };
          continue;
        }
        if (block.type === "tool_use") {
          const toolCallId = normalizeToolCallId(block.id ?? `tool_${payload.index}`, payload.index);
          const name = block.name ?? "";
          toolBlocks.set(payload.index, {
            toolCallId,
            name,
            partialJson: "",
            initialInput: block.input ?? {},
          });
          yield { type: "tool_call_start", toolCallId, name, index: payload.index };
        }
        continue;
      }

      if (payload.type === "content_block_delta" && payload.index !== undefined && payload.delta) {
        if (payload.delta.type === "text_delta" && payload.delta.text) {
          contentBlocks.set(payload.index, "text");
          yield { type: "text_delta", text: payload.delta.text, index: payload.index };
          continue;
        }
        if (payload.delta.type === "thinking_delta" && payload.delta.thinking) {
          contentBlocks.set(payload.index, "reasoning");
          yield { type: "reasoning_delta", text: payload.delta.thinking, index: payload.index };
          continue;
        }
        if (payload.delta.type === "input_json_delta") {
          const tool = toolBlocks.get(payload.index);
          if (!tool) continue;
          const delta = payload.delta.partial_json ?? "";
          tool.partialJson += delta;
          const parsed = parseJson<unknown>(tool.partialJson, undefined);
          yield toolCallDeltaEvent(tool, delta, payload.index, parsed);
        }
        continue;
      }

      if (payload.type === "content_block_stop" && payload.index !== undefined) {
        const contentType = contentBlocks.get(payload.index);
        if (contentType) {
          contentBlocks.delete(payload.index);
          yield { type: contentType === "text" ? "text_end" : "reasoning_end", index: payload.index };
        }
        const tool = toolBlocks.get(payload.index);
        if (tool) {
          toolBlocks.delete(payload.index);
          const finalInput = finalToolInput(tool);
          const event: ModelStreamEvent = {
            type: "tool_call_end",
            toolCallId: tool.toolCallId,
            name: tool.name,
            input: finalInput.input,
            index: payload.index,
          };
          if (finalInput.inputParseError) event.inputParseError = finalInput.inputParseError;
          yield event;
        }
        continue;
      }

      if (payload.type === "message_delta") {
        if (payload.delta?.stop_reason) finishReason = payload.delta.stop_reason;
        usage = mergeUsage(usage, payload.usage);
        const metadata = metadataEvent(this.provider, this.model, responseId, usage);
        if (metadata) yield metadata;
        continue;
      }

      if (payload.type === "message_stop") {
        if (toolBlocks.size > 0) {
          throw providerStreamProtocolError(this.provider, "Model stream stopped before tool content_block_stop", response, "incomplete_stream");
        }
        yield finishEvent(finishReason, responseId, usage);
        return;
      }
    }

    throw providerStreamProtocolError(this.provider, "Model stream ended before message_stop", response, "incomplete_stream");
  }

  private async *streamJsonResponse(text: string, response: Response): AsyncIterable<ModelStreamEvent> {
    const payload = parseJson<AnthropicResponse>(text, undefined);
    if (!payload) {
      throw providerPayloadError(undefined, {
        provider: this.provider,
        label: "Model response was not valid JSON",
        response,
      });
    }
    if (payload.error) {
      const details = anthropicErrorDetails(payload);
      const error = providerPayloadError(payload, {
        provider: this.provider,
        label: "Model response failed",
        response,
        ...(details ? { details } : {}),
      });
      this.backpressureCoordinator.recordError(this.requestScope, error);
      yield errorEvent(error, payload.id, undefined);
      return;
    }

    const usage = toModelUsage(payload.usage);
    const metadata = metadataEvent(this.provider, payload.model ?? this.model, payload.id, usage);
    if (metadata) yield metadata;

    const complete = payload.stop_reason === undefined
      || payload.stop_reason === "stop"
      || payload.stop_reason === "end_turn"
      || payload.stop_reason === "stop_sequence"
      || payload.stop_reason === "tool_use";
    for (const [blockIndex, block] of (payload.content ?? []).entries()) {
      if (block.type === "text") {
        yield { type: "text_delta", text: block.text, index: blockIndex };
        if (complete) yield { type: "text_end", index: blockIndex };
      } else if (block.type === "thinking") {
        yield { type: "reasoning_delta", text: block.thinking, index: blockIndex };
        if (complete) yield { type: "reasoning_end", index: blockIndex };
      } else if (block.type === "redacted_thinking") {
        yield { type: "reasoning_delta", text: "[Reasoning redacted]", redacted: true, index: blockIndex };
        if (complete) yield { type: "reasoning_end", index: blockIndex };
      } else if (block.type === "tool_use") {
        const toolCallId = normalizeToolCallId(block.id, blockIndex);
        yield { type: "tool_call_start", toolCallId, name: block.name };
        yield { type: "tool_call_end", toolCallId, name: block.name, input: block.input };
      }
    }

    yield finishEvent(payload.stop_reason ?? "stop", payload.id, usage);
  }

  private headers(): HeadersInit {
    const headers = new Headers({
      accept: "text/event-stream, application/json",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...this.options.headers,
    });
    if ((this.options.authScheme ?? "x-api-key") === "bearer") {
      headers.set("authorization", `Bearer ${this.options.apiKey}`);
    } else {
      headers.set("x-api-key", this.options.apiKey);
    }
    return headers;
  }

}

export function buildAnthropicRequestBody(
  input: ModelStreamInput,
  options: AnthropicRequestBuildOptions,
): Record<string, unknown> {
  const messages = prependContextualUserMessage(
    transformModelMessages(input.messages, {
      normalizeToolCallId: normalizeAnthropicToolCallId,
    }),
    input.contextualUser,
  );
  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: options.maxTokens ?? 4096,
    messages: toAnthropicMessages(messages, supportsImageInput(options.inputCapabilities)),
    stream: options.stream ?? true,
  };

  const tools = toAnthropicTools(input.tools ?? []);
  if (tools.length > 0) body.tools = tools;

  const system = [...(input.system ?? []), ...(input.developer ?? []), ...systemMessages(messages)].filter(Boolean).join("\n\n");
  if (system) body.system = system;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.compatibility?.supportsAdaptiveReasoningEffort) {
    body.thinking = { type: "adaptive" };
    const requested = options.reasoning === false ? "off" : options.reasoningEffort;
    if (requested !== undefined) {
      body.output_config = { effort: clampReasoningLevel(requested, ["low", "medium", "high", "xhigh", "max"]) };
    }
  } else if (options.reasoning !== undefined) {
    body.thinking = { type: options.reasoning ? "adaptive" : "disabled" };
  }
  if (options.serviceTier === "fast") body.service_tier = "priority";
  return body;
}

export function resolveMessagesUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.hash = "";
  const cleanPath = url.pathname.replace(/\/+$/, "");
  if (cleanPath.endsWith("/v1/messages")) {
    url.pathname = cleanPath;
  } else if (cleanPath.endsWith("/v1")) {
    url.pathname = `${cleanPath}/messages`;
  } else {
    url.pathname = `${cleanPath}/v1/messages`;
  }
  return url.toString();
}

function reasoningEnabledForInput(input: ModelStreamInput): boolean | undefined {
  const reasoning = reasoningLevelForInput(input);
  return reasoning === undefined ? undefined : reasoning !== "off";
}

function reasoningLevelForInput(input: ModelStreamInput): ReasoningLevel | undefined {
  return input.reasoningLevel
    ?? input.reasoning
    ?? input.thinking
    ?? input.selection?.reasoning
    ?? input.selection?.thinking;
}

function toAnthropicMessages(messages: readonly Message[], includeImageContent = true): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;

    const assistantBlocks: AnthropicContentBlock[] = [];
    const userBlocks: AnthropicContentBlock[] = [];

    for (const part of message.parts) {
      if (part.type === "text") {
        if (message.role === "assistant") assistantBlocks.push({ type: "text", text: part.text });
        else userBlocks.push({ type: "text", text: part.text });
      } else if (part.type === "image" && includeImageContent) {
        userBlocks.push(formatImageBlock(part));
      } else if (part.type === "reasoning") {
        if (part.text) assistantBlocks.push({ type: "text", text: part.text });
      } else if (part.type === "tool_call") {
        assistantBlocks.push({
          type: "tool_use",
          id: part.providerCallId ?? part.callId,
          name: part.toolName,
          input: part.input,
        });
      } else if (part.type === "tool_result") {
        const block: AnthropicContentBlock = {
          type: "tool_result",
          tool_use_id: part.providerCallId ?? part.callId,
          content: formatToolResultContent(part, includeImageContent),
        };
        if (part.error) block.is_error = true;
        userBlocks.push(block);
      }
    }

    if (assistantBlocks.length > 0) result.push({ role: "assistant", content: assistantBlocks });
    if (userBlocks.length > 0) result.push({ role: "user", content: userBlocks });
  }
  return mergeAdjacentMessages(result);
}

function systemMessages(messages: readonly Message[]): string[] {
  return messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text);
}

function toAnthropicTools(tools: readonly ModelTool[]): AnthropicTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function mergeAdjacentMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (previous && previous.role === message.role) {
      previous.content.push(...message.content);
    } else {
      result.push({ role: message.role, content: [...message.content] });
    }
  }
  return result;
}

function formatImageBlock(part: Pick<Extract<MessagePart, { type: "image" }>, "data" | "mimeType">): Extract<AnthropicContentBlock, { type: "image" }> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: part.mimeType,
      data: part.data,
    },
  };
}

function formatToolResultContent(part: Extract<MessagePart, { type: "tool_result" }>, includeImageContent = true): AnthropicToolResultContent {
  if (part.error || !includeImageContent || !part.content?.some((item) => item.type === "image")) {
    return formatToolResultForModel(part);
  }
  const blocks: Exclude<AnthropicToolResultContent, string> = [];
  const output = formatToolResultForModel(part);
  if (output) blocks.push({ type: "text", text: output });
  for (const item of part.content) {
    if (item.type === "text") {
      if (item.text) blocks.push({ type: "text", text: item.text });
      continue;
    }
    blocks.push(formatImageBlock(item));
  }
  return blocks.length > 0 ? blocks : formatToolResultForModel(part);
}

function supportsImageInput(inputCapabilities: readonly ModelInputCapability[] | undefined): boolean {
  return inputCapabilities === undefined || inputCapabilities.includes("image");
}

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
}

function parseJson<T>(text: string, fallback: T | undefined): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function anthropicErrorDetails(value: unknown): ProviderErrorDetails | undefined {
  const payload = extractAnthropicErrorPayload(value);
  if (!payload) return undefined;
  const message = stringField(payload, "message");
  const code = codeField(payload, "code")
    ?? codeField(payload, "error_code")
    ?? codeField(payload, "status_code")
    ?? (message ? errorCodeFromMessage(message) : undefined);
  const type = stringField(payload, "type");
  const retryAfterMs = retryAfterFromPayload(payload);
  if (!message && code === undefined && !type && retryAfterMs === undefined) return undefined;
  return {
    ...(message ? { message } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(type ? { type } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function extractAnthropicErrorPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.error) ? value.error : value;
}

function errorCodeFromMessage(message: string): string | undefined {
  return /\((\d{3,6})\)\s*[.!]?\s*$/.exec(message)?.[1]
    ?? /\b(?:error|status)[ _-]?code\s*[:=]?\s*(\d{3,6})\b/i.exec(message)?.[1];
}

function retryAfterFromPayload(payload: Record<string, unknown>): number | undefined {
  const milliseconds = finiteNumber(payload.retry_after_ms);
  if (milliseconds !== undefined && milliseconds >= 0) return Math.round(milliseconds);
  const seconds = finiteNumber(payload.retry_after);
  return seconds !== undefined && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function codeField(record: Record<string, unknown>, key: string): string | number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolCallDeltaEvent(
  tool: ToolBlockState,
  delta: string,
  index: number,
  partialInput: unknown,
): ModelStreamEvent {
  const event: ModelStreamEvent = {
    type: "tool_call_delta",
    toolCallId: tool.toolCallId,
    name: tool.name,
    delta,
    index,
  };
  if (partialInput !== undefined) event.partialInput = partialInput;
  return event;
}

function finalToolInput(tool: ToolBlockState): FinalToolInput {
  if (!tool.partialJson) return { input: tool.initialInput };
  try {
    return { input: JSON.parse(tool.partialJson) as unknown };
  } catch (error) {
    return {
      input: tool.initialInput,
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

function mergeUsage(previous: ModelUsage | undefined, usage: AnthropicUsage | undefined): ModelUsage | undefined {
  const next = toModelUsage(usage);
  if (!next) return previous;
  return {
    ...previous,
    ...next,
    totalTokens:
      (next.inputTokens ?? previous?.inputTokens ?? 0) +
      (next.outputTokens ?? previous?.outputTokens ?? 0) +
      (next.cacheReadInputTokens ?? previous?.cacheReadInputTokens ?? 0) +
      (next.cacheCreationInputTokens ?? previous?.cacheCreationInputTokens ?? 0),
  };
}

function toModelUsage(usage: AnthropicUsage | undefined): ModelUsage | undefined {
  if (!usage) return undefined;
  const modelUsage: ModelUsage = { raw: usage };
  if (usage.input_tokens != null) modelUsage.inputTokens = usage.input_tokens;
  if (usage.output_tokens != null) modelUsage.outputTokens = usage.output_tokens;
  if (usage.cache_read_input_tokens != null) modelUsage.cacheReadInputTokens = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null) modelUsage.cacheCreationInputTokens = usage.cache_creation_input_tokens;
  modelUsage.totalTokens =
    (modelUsage.inputTokens ?? 0) +
    (modelUsage.outputTokens ?? 0) +
    (modelUsage.cacheReadInputTokens ?? 0) +
    (modelUsage.cacheCreationInputTokens ?? 0);
  return modelUsage;
}

function metadataEvent(
  provider: string,
  model: string,
  responseId: string | undefined,
  usage: ModelUsage | undefined,
): ModelStreamEvent | undefined {
  if (!responseId && !usage) return undefined;
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

function errorEvent(error: unknown, responseId: string | undefined, usage: ModelUsage | undefined): ModelStreamEvent {
  const event: ModelStreamEvent = { type: "error", error };
  if (responseId) event.responseId = responseId;
  if (usage) event.usage = usage;
  return event;
}
