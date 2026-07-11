import type { Message, MessagePart } from "@chili/protocol";
import { resolveChatCompletionsCompatibility, type ChatCompletionsCompatibility } from "./compat.js";
import { assertImageInputSupported } from "./image-input.js";
import { readSseEvents } from "./sse.js";
import { prependContextualUserMessage, transformModelMessages } from "./transform-messages.js";
import type { ChiliModel, ModelInputCapability, ModelStreamEvent, ModelStreamInput, ModelTool, ModelUsage } from "./types.js";

export interface OpenAICompletionsModelOptions {
  provider?: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  reasoning?: boolean;
  compatibility?: Partial<ChatCompletionsCompatibility>;
  inputCapabilities?: readonly ModelInputCapability[];
}

export interface OpenAICompletionsRequestBuildOptions {
  provider: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  reasoning?: boolean;
  compatibility?: Partial<ChatCompletionsCompatibility>;
}

type OpenAIMessage =
  | { role: "system" | "developer" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface OpenAIChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage;
  error?: OpenAIErrorPayload;
}

interface OpenAIChoice {
  index?: number;
  finish_reason?: string | null;
  message?: OpenAIChoiceMessage;
  delta?: OpenAIChoiceDelta;
}

interface OpenAIChoiceMessage {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAIChoiceToolCall[];
}

interface OpenAIChoiceDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAIChoiceToolCallDelta[];
}

interface OpenAIChoiceToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIChoiceToolCallDelta extends OpenAIChoiceToolCall {}

interface OpenAIUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  prompt_cache_hit_tokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
  prompt_tokens_details?: {
    cached_tokens?: number | null;
    cache_write_tokens?: number | null;
  };
}

interface OpenAIErrorPayload {
  message?: string;
  type?: string;
}

interface ToolStreamState {
  toolCallId: string;
  name: string;
  partialJson: string;
  started: boolean;
}

interface FinalToolInput {
  input: unknown;
  inputParseError?: string;
}

export class OpenAICompletionsModel implements ChiliModel {
  readonly provider: string;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompletionsModelOptions) {
    if (!options.apiKey) throw new Error("OpenAI-compatible completions model requires an API key");
    if (!options.model) throw new Error("OpenAI-compatible completions model requires a model name");
    if (!options.baseUrl) throw new Error("OpenAI-compatible completions model requires a baseUrl");
    this.provider = options.provider ?? "openai-compatible";
    this.model = options.model;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    assertImageInputSupported(input, {
      provider: this.provider,
      model: this.options.model,
      inputCapabilities: this.options.inputCapabilities ?? ["text"],
    });

    const requestOptions: OpenAICompletionsRequestBuildOptions = {
      provider: this.provider,
      model: this.options.model,
      baseUrl: this.options.baseUrl,
      stream: true,
    };
    if (this.options.reasoning !== undefined) requestOptions.reasoning = this.options.reasoning;
    if (this.options.compatibility !== undefined) requestOptions.compatibility = this.options.compatibility;
    const maxTokens = input.maxTokens ?? this.options.maxTokens;
    const temperature = input.temperature ?? this.options.temperature;
    if (maxTokens !== undefined) requestOptions.maxTokens = maxTokens;
    if (temperature !== undefined) requestOptions.temperature = temperature;

    const init: RequestInit = {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(buildOpenAICompletionsRequestBody(input, requestOptions)),
    };
    if (input.signal) init.signal = input.signal;

    const response = await this.fetchImpl(resolveChatCompletionsUrl(this.options.baseUrl), init);
    if (!response.ok) {
      const text = await response.text();
      const payload = parseJson<OpenAIChatCompletionResponse>(text, undefined);
      throw new Error(payload?.error?.message ?? `Model request failed with HTTP ${response.status}: ${text}`);
    }

    if (isEventStream(response) && response.body) {
      yield* this.streamSseResponse(response.body, input.signal);
      return;
    }

    yield* this.streamJsonResponse(await response.text());
  }

  private async *streamSseResponse(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    let responseId: string | undefined;
    let usage: ModelUsage | undefined;
    let finishReason = "stop";
    let finished = false;
    let emittedInitialMetadata = false;
    const toolCalls = new Map<number, ToolStreamState>();

    for await (const event of readSseEvents(body, signal)) {
      if (event.data === "[DONE]") break;
      const payload = parseJson<OpenAIChatCompletionResponse>(event.data, undefined);
      if (!payload) continue;

      if (payload.error) {
        yield errorEvent(payload.error, responseId, usage);
        return;
      }

      responseId = responseId ?? payload.id;
      const usageUpdate = toModelUsage(payload.usage);
      usage = mergeUsage(usage, payload.usage);
      if ((!emittedInitialMetadata && responseId) || usageUpdate) {
        emittedInitialMetadata = true;
        const metadata = metadataEvent(this.provider, payload.model ?? this.model, responseId, usage);
        if (metadata) yield metadata;
      }

      for (const choice of payload.choices ?? []) {
        const index = choice.index ?? 0;
        if (choice.delta?.reasoning_content) {
          yield { type: "reasoning_delta", text: choice.delta.reasoning_content, index };
        }
        if (choice.delta?.content) {
          yield { type: "text_delta", text: choice.delta.content, index };
        }
        for (const toolCall of choice.delta?.tool_calls ?? []) {
          yield* applyToolCallDelta(toolCalls, toolCall, index);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }

    for (const [index, tool] of toolCalls) {
      yield finishToolCallEvent(tool, index);
    }
    if (!finished) {
      finished = true;
      yield finishEvent(finishReason, responseId, usage);
    }
  }

  private async *streamJsonResponse(text: string): AsyncIterable<ModelStreamEvent> {
    const payload = parseJson<OpenAIChatCompletionResponse>(text, undefined);
    if (!payload) throw new Error(`Model response was not JSON: ${text}`);
    if (payload.error) {
      yield errorEvent(payload.error, payload.id, undefined);
      return;
    }

    const usage = toModelUsage(payload.usage);
    const metadata = metadataEvent(this.provider, payload.model ?? this.model, payload.id, usage);
    if (metadata) yield metadata;

    let finishReason = "stop";
    for (const choice of payload.choices ?? []) {
      const index = choice.index ?? 0;
      const message = choice.message;
      if (message?.reasoning_content) {
        yield { type: "reasoning_delta", text: message.reasoning_content, index };
      }
      if (message?.content) {
        yield { type: "text_delta", text: message.content, index };
      }
      for (const toolCall of message?.tool_calls ?? []) {
        const tool = toolStateFromCompleteToolCall(toolCall, index);
        yield { type: "tool_call_start", toolCallId: tool.toolCallId, name: tool.name, index };
        yield finishToolCallEvent(tool, index);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    yield finishEvent(finishReason, payload.id, usage);
  }

  private headers(): HeadersInit {
    return {
      accept: "text/event-stream, application/json",
      "content-type": "application/json",
      authorization: `Bearer ${this.options.apiKey}`,
      ...this.options.headers,
    };
  }
}

export function buildOpenAICompletionsRequestBody(
  input: ModelStreamInput,
  options: OpenAICompletionsRequestBuildOptions,
): Record<string, unknown> {
  const compatibilityInput: Parameters<typeof resolveChatCompletionsCompatibility>[0] = {
    provider: options.provider,
    model: options.model,
    apiFamily: "openai-completions",
  };
  if (options.baseUrl !== undefined) compatibilityInput.baseUrl = options.baseUrl;
  const compatibility = resolveChatCompletionsCompatibility(compatibilityInput, options.compatibility);
  const messages = prependContextualUserMessage(transformModelMessages(input.messages), input.contextualUser);
  const body: Record<string, unknown> = {
    model: options.model,
    messages: toOpenAIMessages(messages, input.system ?? [], input.developer ?? [], compatibility, options.reasoning ?? false),
    stream: options.stream ?? true,
  };

  body[compatibility.maxTokensField] = options.maxTokens ?? 4096;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (compatibility.supportsStore) body.store = false;
  if ((options.stream ?? true) && compatibility.supportsUsageInStreaming) {
    body.stream_options = { include_usage: true };
  }
  if (options.reasoning !== undefined) applyReasoningOptions(body, compatibility, options.reasoning);

  const tools = toOpenAITools(input.tools ?? []);
  if (tools.length > 0) body.tools = tools;
  return body;
}

function applyReasoningOptions(
  body: Record<string, unknown>,
  compatibility: ChatCompletionsCompatibility,
  reasoning: boolean,
): void {
  if (compatibility.reasoningParameterStyle !== "deepseek" && compatibility.reasoningParameterStyle !== "moonshot") return;
  body.thinking = { type: reasoning ? "enabled" : "disabled" };
  if (compatibility.reasoningParameterStyle === "deepseek" && reasoning && compatibility.supportsReasoningEffort) {
    body.reasoning_effort = compatibility.reasoningEffortMap.high ?? "high";
  }
}

export function resolveChatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  if (clean.endsWith("/chat/completions")) return clean;
  if (clean.endsWith("/v1")) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

function toOpenAIMessages(
  messages: readonly Message[],
  system: readonly string[],
  developer: readonly string[],
  compatibility: ChatCompletionsCompatibility,
  reasoning: boolean,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  const systemText = [...system, ...systemMessages(messages)].filter(Boolean).join("\n\n");
  const developerText = developer.filter(Boolean).join("\n\n");
  if (developerText) {
    const fallbackSystem = [systemText, compatibility.supportsDeveloperRole ? "" : developerText].filter(Boolean).join("\n\n");
    if (fallbackSystem) result.push({ role: "system", content: fallbackSystem });
    if (compatibility.supportsDeveloperRole) result.push({ role: "developer", content: developerText });
  } else if (systemText) {
    result.push({
      role: reasoning && compatibility.supportsDeveloperRole ? "developer" : "system",
      content: systemText,
    });
  }

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      const assistant = toOpenAIAssistantMessage(message, compatibility);
      if (assistant) result.push(assistant);
      continue;
    }
    result.push(...toOpenAIUserOrToolMessages(message));
  }
  return result;
}

function toOpenAIAssistantMessage(
  message: Message,
  compatibility: ChatCompletionsCompatibility,
): OpenAIMessage | undefined {
  const text = message.parts
    .filter((part): part is Extract<MessagePart, { type: "text" | "reasoning" }> =>
      part.type === "text" || part.type === "reasoning",
    )
    .map((part) => part.text)
    .join("\n");
  const toolCalls = message.parts
    .filter((part): part is Extract<MessagePart, { type: "tool_call" }> => part.type === "tool_call")
    .map((part) => ({
      id: part.callId,
      type: "function" as const,
      function: {
        name: part.toolName,
        arguments: stringifyToolInput(part.input),
      },
    }));

  if (!text && toolCalls.length === 0) return undefined;
  const result: OpenAIMessage = {
    role: "assistant",
    content: text || null,
  };
  if (toolCalls.length > 0) result.tool_calls = toolCalls;
  if (compatibility.requiresReasoningContentOnAssistantMessages) result.reasoning_content = "";
  return result;
}

function toOpenAIUserOrToolMessages(message: Message): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  const text = message.parts
    .filter((part): part is Extract<MessagePart, { type: "text" | "reasoning" }> =>
      part.type === "text" || part.type === "reasoning",
    )
    .map((part) => part.text)
    .join("\n");
  if (text) result.push({ role: "user", content: text });

  for (const part of message.parts) {
    if (part.type !== "tool_result") continue;
    result.push({
      role: "tool",
      tool_call_id: part.callId,
      content: formatToolResult(part),
    });
  }
  return result;
}

function systemMessages(messages: readonly Message[]): string[] {
  return messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text);
}

function toOpenAITools(tools: readonly ModelTool[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function* applyToolCallDelta(
  toolCalls: Map<number, ToolStreamState>,
  delta: OpenAIChoiceToolCallDelta,
  fallbackIndex: number,
): Iterable<ModelStreamEvent> {
  const index = delta.index ?? fallbackIndex;
  const tool = toolCalls.get(index) ?? {
    toolCallId: delta.id ?? `tool_${index}`,
    name: delta.function?.name ?? "",
    partialJson: "",
    started: false,
  };

  if (delta.id) tool.toolCallId = delta.id;
  if (delta.function?.name) tool.name = delta.function.name;
  toolCalls.set(index, tool);

  if (!tool.started && tool.name) {
    tool.started = true;
    yield { type: "tool_call_start", toolCallId: tool.toolCallId, name: tool.name, index };
  }

  const argumentsDelta = delta.function?.arguments ?? "";
  if (argumentsDelta) {
    tool.partialJson += argumentsDelta;
    const parsed = parseJson<unknown>(tool.partialJson, undefined);
    yield toolCallDeltaEvent(tool, argumentsDelta, index, parsed);
  }
}

function toolStateFromCompleteToolCall(toolCall: OpenAIChoiceToolCall, fallbackIndex: number): ToolStreamState {
  const index = toolCall.index ?? fallbackIndex;
  return {
    toolCallId: toolCall.id ?? `tool_${index}`,
    name: toolCall.function?.name ?? "",
    partialJson: toolCall.function?.arguments ?? "",
    started: true,
  };
}

function toolCallDeltaEvent(
  tool: ToolStreamState,
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

function finishToolCallEvent(tool: ToolStreamState, index: number): ModelStreamEvent {
  const finalInput = finalToolInput(tool);
  const event: ModelStreamEvent = {
    type: "tool_call_end",
    toolCallId: tool.toolCallId,
    name: tool.name,
    input: finalInput.input,
    index,
  };
  if (finalInput.inputParseError) event.inputParseError = finalInput.inputParseError;
  return event;
}

function finalToolInput(tool: ToolStreamState): FinalToolInput {
  if (!tool.partialJson) return { input: {} };
  try {
    return { input: JSON.parse(tool.partialJson) as unknown };
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

function stringifyToolInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

function formatToolResult(part: Extract<MessagePart, { type: "tool_result" }>): string {
  if (part.error) return part.output ? `${part.output}\n\nError: ${part.error}` : `Error: ${part.error}`;
  return part.output;
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

function mergeUsage(previous: ModelUsage | undefined, usage: OpenAIUsage | undefined): ModelUsage | undefined {
  const next = toModelUsage(usage);
  if (!next) return previous;
  return {
    ...previous,
    ...next,
    totalTokens:
      next.totalTokens ??
      (next.inputTokens ?? previous?.inputTokens ?? 0) +
        (next.outputTokens ?? previous?.outputTokens ?? 0) +
        (next.cacheReadInputTokens ?? previous?.cacheReadInputTokens ?? 0) +
        (next.cacheCreationInputTokens ?? previous?.cacheCreationInputTokens ?? 0),
  };
}

function toModelUsage(usage: OpenAIUsage | undefined): ModelUsage | undefined {
  if (!usage) return undefined;
  const modelUsage: ModelUsage = { raw: usage };
  const cacheReadInputTokens = usage.prompt_cache_hit_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? 0;
  const cacheCreationInputTokens = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
  const reportedNonCachedInput = usage.prompt_cache_miss_tokens
    ?? (usage.prompt_tokens == null ? undefined : usage.prompt_tokens - cacheReadInputTokens);
  if (reportedNonCachedInput !== undefined) {
    modelUsage.inputTokens = Math.max(0, reportedNonCachedInput - cacheCreationInputTokens);
  }
  if (usage.completion_tokens != null) modelUsage.outputTokens = usage.completion_tokens;
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
  const event: ModelStreamEvent = { type: "finish", reason: normalizeFinishReason(reason) };
  if (responseId) event.responseId = responseId;
  if (usage) event.usage = usage;
  return event;
}

function normalizeFinishReason(reason: string): string {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  return reason;
}

function errorEvent(error: unknown, responseId: string | undefined, usage: ModelUsage | undefined): ModelStreamEvent {
  const event: ModelStreamEvent = { type: "error", error };
  if (responseId) event.responseId = responseId;
  if (usage) event.usage = usage;
  return event;
}
