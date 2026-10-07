import {
  formatToolResultForModel,
  type AssistantMessagePhase,
  type Message,
  type MessagePart,
  type PersistedModelOutputSource,
  type ServiceTier,
} from "@chili/protocol";
import { assertImageInputSupported } from "./image-input.js";
import { providerHttpError, providerPayloadError, providerStreamProtocolError, type ProviderRequestError } from "../runtime/provider-error.js";
import { readSseEvents, throwIfStreamAborted } from "../runtime/sse.js";
import { credentialVersionFingerprint, recordRequestIdentity, runModelRequest, withProviderBackpressure } from "../runtime/request-lifecycle.js";
import { sharedProviderBackpressureCoordinator, type ProviderBackpressureCoordinator } from "../runtime/backpressure.js";
import type { ChiliModel, ModelInputCapability, ModelStreamEvent, ModelStreamInput, ModelTool, ModelUsage, ReasoningLevel } from "../types.js";

export interface ResponsesRequestBuildOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  sessionId?: string;
  reasoningEffort?: ReasoningLevel;
  reasoningMode?: "pro";
  reasoningContext?: "auto" | "all_turns" | "current_turn";
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  serviceTier?: ServiceTier;
  textVerbosity?: "low" | "medium" | "high";
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
      phase?: AssistantMessagePhase;
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
  status?: string;
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
  text?: string;
  refusal?: string;
  part?: { text?: string; status?: string };
  arguments?: string;
  output_index?: number;
  content_index?: number;
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
  status?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string; status?: string }>;
  summary?: Array<{ text?: string; status?: string }>;
  phase?: string | null;
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

export interface ResponsesCredentials {
  access: string;
  accountId?: string;
  credentialVersion?: string;
  assertCurrent?: () => Promise<void>;
}

export interface ResponsesModelRuntimeOptions {
  provider: string;
  model: string;
  endpoint: string;
  fetch: typeof fetch;
  backpressureCoordinator?: ProviderBackpressureCoordinator;
  providerLabel: string;
  oauthPlanErrors?: boolean;
  /** ChatGPT/Codex require phase; the public Responses API also allows omission. */
  requireAssistantPhase?: boolean;
  /** Migration-only compatibility for history written before connection scoping. */
  allowUnscopedReasoningReplay?: boolean;
  resolveCredentials: (signal?: AbortSignal) => Promise<ResponsesCredentials>;
  resolveRequestOptions: (input: ModelStreamInput) => ResponsesRequestBuildOptions;
  buildRequestBody: (input: ModelStreamInput, options: ResponsesRequestBuildOptions) => Record<string, unknown>;
  buildHeaders: (credentials: ResponsesCredentials, sessionId?: string) => HeadersInit;
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

export class ResponsesModel implements ChiliModel {
  readonly provider: string;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ResponsesModelRuntimeOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.fetchImpl = options.fetch;
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    yield* runModelRequest(input, (bounded) => this.streamRequest(bounded));
  }

  private async *streamRequest(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    const requestOptions = this.options.resolveRequestOptions(input);
    assertImageInputSupported(input, {
      provider: this.provider,
      model: requestOptions.model,
      inputCapabilities: requestOptions.inputCapabilities,
    });
    throwIfStreamAborted(input.signal);
    const credentials = await this.options.resolveCredentials(input.signal);
    throwIfStreamAborted(input.signal);
    yield* withProviderBackpressure(
      this.options.backpressureCoordinator ?? sharedProviderBackpressureCoordinator,
      { provider: this.provider, endpoint: this.options.endpoint, credential: credentials.accountId ? `oauth:${credentials.accountId}` : new Headers(this.options.buildHeaders(credentials, requestOptions.sessionId)).get("authorization") ?? credentials.access },
      input.signal,
      () => this.streamAuthorizedRequest(input, credentials, requestOptions),
    );
  }

  private async *streamAuthorizedRequest(input: ModelStreamInput, credentials: ResponsesCredentials, requestOptions: ResponsesRequestBuildOptions): AsyncIterable<ModelStreamEvent> {
    const headers = this.options.buildHeaders(credentials, requestOptions.sessionId);
    // Scope the opaque ciphertext to the connection that actually dispatched it.
    // OAuth token rotation keeps the account stable; API keys and endpoints do not.
    // Persist only a fingerprint, since URLs and credentials may contain secrets.
    const source = {
      provider: this.provider,
      connection: credentialVersionFingerprint(JSON.stringify([
        this.provider,
        this.options.endpoint,
        credentials.accountId
          ? ["oauth-account", credentials.accountId]
          : ["api-authorization", new Headers(headers).get("authorization") ?? credentials.access],
      ])),
    };
    const replayInput = scopeResponsesReplay(input, source, this.options.allowUnscopedReasoningReplay ?? false);
    const requestBody = this.options.buildRequestBody(replayInput, requestOptions);

    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    };
    if (input.signal) init.signal = input.signal;

    yield { type: "metadata", provider: this.provider, model: requestOptions.model };
    await credentials.assertCurrent?.();
    await recordRequestIdentity(input, {
      provider: this.provider,
      model: requestOptions.model,
      ...(credentials.accountId ? { accountId: credentials.accountId } : {}),
      credentialVersion: credentials.credentialVersion ?? credentialVersionFingerprint(new Headers(init.headers).get("authorization") ?? credentials.access),
    });
    await credentials.assertCurrent?.();
    input.signal?.throwIfAborted();
    const response = await this.fetchImpl(this.options.endpoint, init);
    if (!response.ok) {
      throw await parseCodexErrorResponse(
        response,
        this.provider,
        this.options.oauthPlanErrors ?? false,
        `${this.options.providerLabel} request`,
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
    yield* this.streamSseResponse(response.body, response, source, input.signal, requestOptions.model);
  }

  private async *streamSseResponse(
    body: ReadableStream<Uint8Array>,
    response: Response,
    source: PersistedModelOutputSource,
    signal?: AbortSignal,
    requestModel: string = this.model,
  ): AsyncIterable<ModelStreamEvent> {
    let responseId: string | undefined;
    let usage: ModelUsage | undefined;
    let finishReason = "stop";
    let finished = false;
    let sawToolCall = false;
    const toolCalls = new Map<string, ToolStreamState>();
    const messagePhases = new Map<number, AssistantMessagePhase | undefined>();
    const textBlockIndexes = new Map<string, number>();
    const openTextBlocks = new Map<number, number>();
    const textBlockTexts = new Map<number, string>();
    const endedTextBlocks = new Set<number>();
    const incompleteTextBlocks = new Set<number>();
    const reasoningSectionIndexes = new Map<string, number>();
    const openReasoningSections = new Map<number, { itemId?: string; outputIndex?: number }>();
    const reasoningSectionTexts = new Map<number, string>();
    const endedReasoningSections = new Set<number>();
    const incompleteReasoningSections = new Set<number>();
    const provider = this.provider;
    let activeToolKey: string | undefined;

    const finishTextBlock = function* (payload: CodexStreamPayload, text?: string, contentStatus?: string): Generator<ModelStreamEvent> {
      const knownIndex = textBlockIndexes.get(textBlockKey(payload));
      if (knownIndex === undefined && text === undefined) return;
      const index = knownIndex ?? textBlockEventIndex(payload, textBlockIndexes);
      if (endedTextBlocks.has(index)) return;
      const phase = payload.output_index === undefined ? undefined : messagePhases.get(payload.output_index);
      if (payload.output_index === undefined || !messagePhases.has(payload.output_index)) {
        throw codexProtocolError(provider, "OpenAI Codex stream completed text for an undeclared message output", response);
      }
      if (hasIncompleteContentStatus(payload, contentStatus)) incompleteTextBlocks.add(index);
      const suffix = completedContentSuffix(textBlockTexts.get(index) ?? "", text, provider, response);
      if (text !== undefined) textBlockTexts.set(index, text);
      if (payload.output_index !== undefined) openTextBlocks.set(index, payload.output_index);
      if (suffix) yield { type: "text_delta", text: suffix, index, ...(phase === undefined ? {} : { phase }) };
      if (incompleteTextBlocks.has(index)) return;
      openTextBlocks.delete(index);
      textBlockTexts.delete(index);
      endedTextBlocks.add(index);
      yield { type: "text_end", index, ...(phase === undefined ? {} : { phase }) };
    };

    const finishReasoningSection = function* (payload: CodexStreamPayload, text?: string, contentStatus?: string): Generator<ModelStreamEvent> {
      const knownIndex = reasoningSectionIndexes.get(reasoningSectionKey(payload));
      if (knownIndex === undefined && text === undefined) return;
      const index = knownIndex ?? reasoningSectionEventIndex(payload, reasoningSectionIndexes);
      if (endedReasoningSections.has(index)) return;
      if (hasIncompleteContentStatus(payload, contentStatus)) incompleteReasoningSections.add(index);
      const suffix = completedContentSuffix(reasoningSectionTexts.get(index) ?? "", text, provider, response);
      if (text !== undefined) reasoningSectionTexts.set(index, text);
      openReasoningSections.set(index, {
        ...(payload.item_id === undefined ? {} : { itemId: payload.item_id }),
        ...(payload.output_index === undefined ? {} : { outputIndex: payload.output_index }),
      });
      if (suffix) yield { type: "reasoning_delta", text: suffix, index };
      if (incompleteReasoningSections.has(index)) return;
      openReasoningSections.delete(index);
      reasoningSectionTexts.delete(index);
      endedReasoningSections.add(index);
      yield { type: "reasoning_end", index };
    };

    for await (const event of readSseEvents(body, signal)) {
      if (event.data === "[DONE]") break;
      const payload = parseJson<CodexStreamPayload>(event.data, undefined);

      if (event.event === "error" || payload?.type === "error") {
        throw formatCodexStreamError(payload, this.provider, "OpenAI Codex stream error", response);
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        if (!event.data.trim()) continue;
        throw providerStreamProtocolError(this.provider, "OpenAI Codex stream contained invalid JSON", response, "invalid_stream");
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
          recordCodexAssistantPhase(messagePhases, payload.output_index, payload.item.phase, this.provider, response, this.options.requireAssistantPhase ?? true);
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
        const index = reasoningSectionEventIndex(payload, reasoningSectionIndexes);
        reasoningSectionTexts.set(index, (reasoningSectionTexts.get(index) ?? "") + payload.delta);
        openReasoningSections.set(index, {
          ...(payload.item_id === undefined ? {} : { itemId: payload.item_id }),
          ...(payload.output_index === undefined ? {} : { outputIndex: payload.output_index }),
        });
        yield {
          type: "reasoning_delta",
          text: payload.delta,
          index,
        };
        continue;
      }

      if (payload.type === "response.reasoning_summary_text.done" || payload.type === "response.reasoning_summary_part.done") {
        yield* finishReasoningSection(payload, payload.text ?? payload.part?.text);
        continue;
      }

      if ((payload.type === "response.output_text.delta" || payload.type === "response.refusal.delta") && payload.delta) {
        const outputIndex = payload.output_index;
        const phase = outputIndex === undefined ? undefined : messagePhases.get(outputIndex);
        if (outputIndex === undefined || !messagePhases.has(outputIndex)) {
          throw codexProtocolError(
            this.provider,
            "OpenAI Codex stream has text delta for an undeclared message output",
            response,
          );
        }
        const index = textBlockEventIndex(payload, textBlockIndexes);
        openTextBlocks.set(index, outputIndex);
        textBlockTexts.set(index, (textBlockTexts.get(index) ?? "") + payload.delta);
        yield { type: "text_delta", text: payload.delta, index, ...(phase === undefined ? {} : { phase }) };
        continue;
      }

      if (payload.type === "response.output_text.done" || payload.type === "response.refusal.done") {
        yield* finishTextBlock(payload, payload.text ?? payload.refusal);
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
        if (payload.item.type === "reasoning") {
          for (const [summaryIndex, summary] of (payload.item.summary ?? []).entries()) {
            if (typeof summary.text !== "string") continue;
            yield* finishReasoningSection({
              ...payload,
              ...(payload.item.id === undefined ? {} : { item_id: payload.item.id }),
              summary_index: summaryIndex,
            }, summary.text, summary.status);
          }
          for (const [index, section] of openReasoningSections) {
            if (
              (payload.output_index !== undefined && section.outputIndex === payload.output_index)
              || (payload.item.id !== undefined && section.itemId === payload.item.id)
            ) {
              if (hasIncompleteContentStatus(payload)) incompleteReasoningSections.add(index);
              if (incompleteReasoningSections.has(index)) continue;
              openReasoningSections.delete(index);
              reasoningSectionTexts.delete(index);
              endedReasoningSections.add(index);
              yield { type: "reasoning_end", index };
            }
          }
        }
        if (
          payload.item.type === "reasoning"
          && typeof payload.item.encrypted_content === "string"
        ) {
          yield {
            type: "reasoning_item",
            output: {
              apiFamily: "openai-responses",
              source: { ...source },
              ...(payload.output_index === undefined ? {} : { outputIndex: payload.output_index }),
              item: payload.item,
            },
          };
        }
        if (payload.item.type === "message") {
          recordCodexAssistantPhase(messagePhases, payload.output_index, payload.item.phase, this.provider, response, this.options.requireAssistantPhase ?? true);
          for (const [contentIndex, content] of (payload.item.content ?? []).entries()) {
            const text = content.type === "refusal" ? content.refusal : content.type === "output_text" ? content.text : undefined;
            if (typeof text !== "string") continue;
            yield* finishTextBlock({ ...payload, content_index: contentIndex }, text, content.status);
          }
          for (const [index, outputIndex] of openTextBlocks) {
            if (outputIndex !== payload.output_index) continue;
            if (hasIncompleteContentStatus(payload)) incompleteTextBlocks.add(index);
            if (incompleteTextBlocks.has(index)) continue;
            openTextBlocks.delete(index);
            textBlockTexts.delete(index);
            endedTextBlocks.add(index);
            const phase = messagePhases.get(outputIndex);
            yield { type: "text_end", index, ...(phase === undefined ? {} : { phase }) };
          }
        }
        if (payload.item.type === "function_call") {
          const state = findToolState(toolCalls, payload, activeToolKey) ?? createToolState(payload.item, payload.output_index);
          if (payload.item.name) state.name = payload.item.name;
          if (payload.item.arguments !== undefined) state.partialJson = payload.item.arguments;
          if (!state.started && state.name) yield startToolEvent(state);
          if (!state.ended) {
            throwIfStreamAborted(signal);
            state.ended = true;
            yield finishToolEvent(state);
          }
        }
        continue;
      }

      if (payload.type === "response.completed" || payload.type === "response.done" || payload.type === "response.incomplete") {
        const status = payload.response?.status;
        if (payload.response?.error || status === "failed" || status === "cancelled") {
          throw formatCodexStreamError(payload, this.provider, "OpenAI Codex response did not complete successfully", response);
        }
        if (
          (status !== undefined && status !== "completed" && status !== "incomplete")
          || (payload.type === "response.done" && status === undefined)
          || (payload.type === "response.completed" && status === "incomplete")
          || (payload.type === "response.incomplete" && status === "completed")
        ) {
          throw providerStreamProtocolError(this.provider, "OpenAI Codex stream has an invalid terminal status", response, "invalid_stream");
        }
        finished = true;
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

    throwIfStreamAborted(signal);
    if (!finished) {
      throw providerStreamProtocolError(this.provider, "OpenAI Codex stream ended before a terminal response event", response, "incomplete_stream");
    }
    for (const state of toolCalls.values()) {
      throwIfStreamAborted(signal);
      if (!state.ended) yield finishToolEvent(state);
    }
    throwIfStreamAborted(signal);
    yield finishEvent(finishReason, responseId, usage);
  }
}

function scopeResponsesReplay(
  input: ModelStreamInput,
  source: PersistedModelOutputSource,
  allowUnscoped: boolean,
): ModelStreamInput {
  let changed = false;
  const messages = input.messages.map((message) => {
    let messageChanged = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "reasoning" || part.modelOutput?.apiFamily !== "openai-responses") return part;
      const previous = part.modelOutput.source;
      if (previous === undefined ? allowUnscoped : previous.provider === source.provider && previous.connection === source.connection) return part;
      messageChanged = true;
      // Keep ordinary conversation content; only the incompatible opaque state
      // is removed from this request, leaving the stored history untouched.
      const { modelOutput: _modelOutput, ...withoutOpaqueState } = part;
      return withoutOpaqueState;
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, parts };
  });
  return changed ? { ...input, messages } : input;
}

export function toResponsesInput(messages: readonly Message[], includeImageContent = true, requireAssistantPhase = true): CodexResponseInputItem[] {
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
            ...(requireAssistantPhase ? { phase: requireCodexHistoryPhase(part.phase) } : part.phase === undefined ? {} : { phase: requireCodexHistoryPhase(part.phase) }),
            content: [{ type: "output_text", text: part.text }],
          });
          continue;
        }
        if (part.type === "tool_call") {
          output.push({
            type: "function_call",
            call_id: normalizeResponsesId(String(part.providerCallId ?? part.callId)),
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
        call_id: normalizeResponsesId(String(part.providerCallId ?? part.callId)),
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

export function instructionText(messages: readonly Message[], system: readonly string[], developer: readonly string[]): string {
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

export function toResponsesTools(tools: readonly ModelTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: null,
  }));
}

function reasoningSectionKey(payload: CodexStreamPayload): string {
  const itemKey = payload.output_index === undefined ? payload.item_id ?? "output:0" : `output:${payload.output_index}`;
  return `${itemKey}\0${payload.summary_index ?? 0}`;
}

function hasIncompleteContentStatus(payload: CodexStreamPayload, contentStatus?: string): boolean {
  return payload.status === "incomplete"
    || payload.part?.status === "incomplete"
    || payload.item?.status === "incomplete"
    || contentStatus === "incomplete";
}

function completedContentSuffix(
  streamed: string,
  completed: string | undefined,
  provider: string,
  response: Response,
): string {
  if (completed === undefined) return "";
  if (!completed.startsWith(streamed)) {
    throw codexProtocolError(provider, "OpenAI Codex completed content disagrees with its streamed prefix", response);
  }
  return completed.slice(streamed.length);
}

function reasoningSectionEventIndex(payload: CodexStreamPayload, indexes: Map<string, number>): number {
  return contentEventIndex(reasoningSectionKey(payload), indexes);
}

function textBlockKey(payload: CodexStreamPayload): string {
  return `${payload.output_index ?? 0}\0${payload.content_index ?? 0}`;
}

function textBlockEventIndex(payload: CodexStreamPayload, indexes: Map<string, number>): number {
  return contentEventIndex(textBlockKey(payload), indexes);
}

function contentEventIndex(key: string, indexes: Map<string, number>): number {
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

function requireCodexAssistantPhase(phase: string | null | undefined, index: number): AssistantMessagePhase {
  if (phase === undefined) {
    throw new Error(`OpenAI Codex message output index ${index} is missing assistant phase`);
  }
  if (phase !== "commentary" && phase !== "final_answer") {
    throw new Error(`OpenAI Codex message output index ${index} has an invalid assistant phase`);
  }
  return phase;
}

function recordCodexAssistantPhase(
  phases: Map<number, AssistantMessagePhase | undefined>,
  outputIndex: number | undefined,
  rawPhase: string | null | undefined,
  provider: string,
  response: Response,
  requirePhase = true,
): void {
  let index: number;
  let phase: AssistantMessagePhase | undefined;
  try {
    index = requireCodexMessageOutputIndex(outputIndex);
    phase = rawPhase == null && !requirePhase ? phases.get(index) : requireCodexAssistantPhase(rawPhase, index);
  } catch (error) {
    throw codexProtocolError(
      provider,
      error instanceof Error ? error.message : "OpenAI Codex stream contained an invalid message item",
      response,
    );
  }
  const existing = phases.get(index);
  if (phases.has(index) && existing !== phase) {
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
  provider: string,
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
  provider: string,
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
  provider: string,
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

export function normalizeResponsesId(id: string): string {
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

function parseJson<T>(text: string, fallback: T | undefined): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
