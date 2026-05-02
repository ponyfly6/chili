import type { Message, MessagePart } from "@chili/protocol";
import type {
  ChiliModel,
  ModelStreamEvent,
  ModelStreamInput,
  ModelTool,
  ModelUsage,
} from "./types.js";
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
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export interface AnthropicRequestBuildOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

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

export class AnthropicCompatibleModel implements ChiliModel {
  readonly provider: string;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicCompatibleModelOptions) {
    if (!options.apiKey) throw new Error("Anthropic-compatible model requires an API key");
    if (!options.model) throw new Error("Anthropic-compatible model requires a model name");
    if (!options.baseUrl) throw new Error("Anthropic-compatible model requires a baseUrl");
    this.provider = options.provider ?? "anthropic-compatible";
    this.model = options.model;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    const requestOptions: AnthropicRequestBuildOptions = {
      model: this.options.model,
      stream: true,
    };
    const maxTokens = input.maxTokens ?? this.options.maxTokens;
    const temperature = input.temperature ?? this.options.temperature;
    if (maxTokens !== undefined) requestOptions.maxTokens = maxTokens;
    if (temperature !== undefined) requestOptions.temperature = temperature;

    const init: RequestInit = {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(buildAnthropicRequestBody(input, requestOptions)),
    };
    if (input.signal) init.signal = input.signal;

    const response = await this.fetchImpl(resolveMessagesUrl(this.options.baseUrl), init);
    if (!response.ok) {
      const text = await response.text();
      const payload = parseJson<AnthropicResponse>(text, undefined);
      throw new Error(payload?.error?.message ?? `Model request failed with HTTP ${response.status}: ${text}`);
    }

    if (isEventStream(response) && response.body) {
      yield* this.streamSseResponse(response.body, input.signal);
      return;
    }

    yield* this.streamJsonResponse(await response.text());
  }

  private async *streamSseResponse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    let responseId: string | undefined;
    let usage: ModelUsage | undefined;
    let finishReason = "stop";
    let finished = false;
    const toolBlocks = new Map<number, ToolBlockState>();

    for await (const event of readSseEvents(body, signal)) {
      if (event.data === "[DONE]") break;
      const fallback: AnthropicSsePayload = {};
      if (event.event !== undefined) fallback.type = event.event;
      const payload = parseJson<AnthropicSsePayload>(event.data, fallback);
      if (!payload) continue;

      if (payload.type === "error" || event.event === "error") {
        yield errorEvent(payload.error ?? payload, responseId, usage);
        return;
      }

      if (payload.type === "message_start") {
        responseId = payload.message?.id;
        usage = mergeUsage(usage, payload.message?.usage);
        const metadata = metadataEvent(this.provider, payload.message?.model ?? this.model, responseId, usage);
        if (metadata) yield metadata;
        continue;
      }

      if (payload.type === "content_block_start" && payload.index !== undefined && payload.content_block) {
        const block = payload.content_block;
        if (block.type === "text") continue;
        if (block.type === "thinking" && block.thinking) {
          yield { type: "reasoning_delta", text: block.thinking, index: payload.index };
          continue;
        }
        if (block.type === "redacted_thinking") {
          yield { type: "reasoning_delta", text: "[Reasoning redacted]", index: payload.index, redacted: true };
          continue;
        }
        if (block.type === "tool_use") {
          const toolCallId = block.id ?? `tool_${payload.index}`;
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
          yield { type: "text_delta", text: payload.delta.text, index: payload.index };
          continue;
        }
        if (payload.delta.type === "thinking_delta" && payload.delta.thinking) {
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
        const tool = toolBlocks.get(payload.index);
        if (tool) {
          toolBlocks.delete(payload.index);
          yield {
            type: "tool_call_end",
            toolCallId: tool.toolCallId,
            name: tool.name,
            input: finalToolInput(tool),
            index: payload.index,
          };
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
        finished = true;
        yield finishEvent(finishReason, responseId, usage);
      }
    }

    if (!finished) {
      yield finishEvent(finishReason, responseId, usage);
    }
  }

  private async *streamJsonResponse(text: string): AsyncIterable<ModelStreamEvent> {
    const payload = parseJson<AnthropicResponse>(text, undefined);
    if (!payload) throw new Error(`Model response was not JSON: ${text}`);
    if (payload.error) {
      yield errorEvent(payload.error, payload.id, undefined);
      return;
    }

    const usage = toModelUsage(payload.usage);
    const metadata = metadataEvent(this.provider, payload.model ?? this.model, payload.id, usage);
    if (metadata) yield metadata;

    for (const block of payload.content ?? []) {
      if (block.type === "text") {
        yield { type: "text_delta", text: block.text };
      } else if (block.type === "thinking") {
        yield { type: "reasoning_delta", text: block.thinking };
      } else if (block.type === "redacted_thinking") {
        yield { type: "reasoning_delta", text: "[Reasoning redacted]", redacted: true };
      } else if (block.type === "tool_use") {
        yield { type: "tool_call_start", toolCallId: block.id, name: block.name };
        yield { type: "tool_call_end", toolCallId: block.id, name: block.name, input: block.input };
      }
    }

    yield finishEvent(payload.stop_reason ?? "stop", payload.id, usage);
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = {
      accept: "text/event-stream, application/json",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...this.options.headers,
    };
    if ((this.options.authScheme ?? "x-api-key") === "bearer") {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    } else {
      headers["x-api-key"] = this.options.apiKey;
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
    messages: toAnthropicMessages(messages),
    stream: options.stream ?? true,
  };

  const tools = toAnthropicTools(input.tools ?? []);
  if (tools.length > 0) body.tools = tools;

  const system = [...(input.system ?? []), ...(input.developer ?? []), ...systemMessages(messages)].filter(Boolean).join("\n\n");
  if (system) body.system = system;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  return body;
}

export function resolveMessagesUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  if (clean.endsWith("/v1/messages")) return clean;
  if (clean.endsWith("/v1")) return `${clean}/messages`;
  return `${clean}/v1/messages`;
}

function toAnthropicMessages(messages: readonly Message[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;

    const assistantBlocks: AnthropicContentBlock[] = [];
    const userBlocks: AnthropicContentBlock[] = [];

    for (const part of message.parts) {
      if (part.type === "text") {
        if (message.role === "assistant") assistantBlocks.push({ type: "text", text: part.text });
        else userBlocks.push({ type: "text", text: part.text });
      } else if (part.type === "reasoning") {
        assistantBlocks.push({ type: "text", text: part.text });
      } else if (part.type === "tool_call") {
        assistantBlocks.push({
          type: "tool_use",
          id: part.callId,
          name: part.toolName,
          input: part.input,
        });
      } else if (part.type === "tool_result") {
        const block: AnthropicContentBlock = {
          type: "tool_result",
          tool_use_id: part.callId,
          content: formatToolResult(part),
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

function finalToolInput(tool: ToolBlockState): unknown {
  if (!tool.partialJson) return tool.initialInput;
  return parseJson(tool.partialJson, tool.initialInput);
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
