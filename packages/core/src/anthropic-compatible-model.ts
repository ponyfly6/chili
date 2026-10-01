import { isIP } from "node:net";
import {
  formatToolResultForModel,
  type Message,
  type MessagePart,
  type ServiceTier,
  type ToolDefinition,
} from "@chili/protocol";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";

export type AnthropicAuthScheme = "bearer" | "x-api-key";

export interface AnthropicCompatibleModelOptions {
  model: string;
  apiKey: string;
  baseUrl: string;
  authScheme?: AnthropicAuthScheme;
  maxTokens?: number;
  temperature?: number;
  reasoning?: boolean;
  serviceTier?: ServiceTier;
  fetch?: typeof fetch;
  inputCapabilities?: readonly ("text" | "image")[];
}

export interface MiniMaxModelOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: boolean;
  serviceTier?: ServiceTier;
  fetch?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource }
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
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  error?: unknown;
}

interface ProviderErrorDetails {
  message?: string;
  code?: string;
  type?: string;
  param?: string;
  requestId?: string;
}

type ProviderRequestError = Error & {
  status?: number;
  code?: string;
  type?: string;
  param?: string;
  requestId?: string;
};

export const MINIMAX_M3_MODEL = "MiniMax-M3";
export const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";

const DEFAULT_MINIMAX_MAX_TOKENS = 128 * 1024;
const PROVIDER_ERROR_BODY_MAX_BYTES = 64 * 1024;
const PROVIDER_PUBLIC_ERROR_MAX_BYTES = 1024;

const HTTP_STATUS_LABELS: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  529: "Service Overloaded",
};

const MARKUP_PATTERN = /(?:<!doctype\s+html|<!--|<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]{0,512})?\s*\/?>)/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const IPV6_CANDIDATE_PATTERN = /(?<![A-Za-z0-9:])(?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9]{0,4}(?![A-Za-z0-9:])/g;

export class AnthropicCompatibleModelRouter implements ModelRouter {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicCompatibleModelOptions) {
    if (!options.apiKey) throw new Error("Anthropic-compatible model requires an API key");
    if (!options.model) throw new Error("Anthropic-compatible model requires a model name");
    if (!options.baseUrl) throw new Error("Anthropic-compatible model requires a baseUrl");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    if (
      this.options.inputCapabilities &&
      !this.options.inputCapabilities.includes("image") &&
      messagesContainDirectImageInput(input.messages)
    ) {
      throw new Error(`${this.options.model} does not support image input. Switch to an image-capable model before sending images.`);
    }

    const init: RequestInit = {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(input)),
    };
    if (input.signal) init.signal = input.signal;
    const response = await this.fetchImpl(resolveMessagesUrl(this.options.baseUrl), init);

    if (!response.ok) {
      const payload = await readProviderErrorJson(response);
      throw createProviderRequestError(payload, response);
    }

    // Successful responses are intentionally not subject to the error-body cap:
    // a valid assistant message or tool input can be much larger than 64 KiB.
    const payload = parseSuccessfulResponse(await response.text());
    if (hasProviderPayloadError(payload)) {
      throw createProviderRequestError(payload, response);
    }

    for (const block of payload.content ?? []) {
      if (block.type === "text") {
        yield { type: "text_delta", text: block.text };
      }
      if (block.type === "tool_use") {
        yield { type: "tool_call", name: block.name, input: block.input };
      }
    }

    yield { type: "finish", reason: payload.stop_reason ?? "stop" };
  }

  private requestBody(input: ModelStreamInput): Record<string, unknown> {
    const messages = prependContextualUserMessage(input.messages, input.contextualUser);
    const includeImageContent = supportsImageInput(this.options.inputCapabilities);
    const body: Record<string, unknown> = {
      model: this.options.model,
      max_tokens: this.options.maxTokens ?? 4096,
      messages: toAnthropicMessages(messages, includeImageContent),
      tools: toAnthropicTools(input.tools),
      stream: false,
    };
    const system = [...input.system, ...(input.developer ?? []), ...systemMessages(messages)].filter(Boolean).join("\n\n");
    if (system) body.system = system;
    if (this.options.temperature !== undefined) body.temperature = this.options.temperature;
    const miniMaxControlsEnabled = this.options.reasoning !== undefined || this.options.serviceTier !== undefined;
    if (miniMaxControlsEnabled) {
      const reasoning = input.reasoningLevel === undefined
        ? this.options.reasoning
        : input.reasoningLevel !== "off";
      if (reasoning !== undefined) body.thinking = { type: reasoning ? "adaptive" : "disabled" };
      const serviceTier = input.serviceTier ?? this.options.serviceTier;
      if (serviceTier === "fast") body.service_tier = "priority";
    }
    return body;
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if ((this.options.authScheme ?? "x-api-key") === "bearer") {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    } else {
      headers["x-api-key"] = this.options.apiKey;
    }
    return headers;
  }
}

export function createMiniMaxM3Router(options: MiniMaxModelOptions = {}): AnthropicCompatibleModelRouter {
  const env = options.env ?? process.env;
  const routerOptions: AnthropicCompatibleModelOptions = {
    model: options.model ?? env.MINIMAX_MODEL ?? env.ANTHROPIC_MODEL ?? MINIMAX_M3_MODEL,
    baseUrl: options.baseUrl
      ?? env.MINIMAX_ANTHROPIC_BASE_URL
      ?? env.ANTHROPIC_BASE_URL
      ?? env.MINIMAX_BASE_URL
      ?? MINIMAX_ANTHROPIC_BASE_URL,
    apiKey: options.apiKey ?? env.MINIMAX_API_KEY ?? env.ANTHROPIC_API_KEY ?? "",
    authScheme: "bearer",
    maxTokens: options.maxTokens ?? DEFAULT_MINIMAX_MAX_TOKENS,
    reasoning: options.reasoning ?? true,
    inputCapabilities: ["text", "image"],
  };
  if (options.temperature !== undefined) routerOptions.temperature = options.temperature;
  if (options.serviceTier !== undefined) routerOptions.serviceTier = options.serviceTier;
  if (options.fetch !== undefined) routerOptions.fetch = options.fetch;
  return new AnthropicCompatibleModelRouter(routerOptions);
}

/** @deprecated Use createMiniMaxM3Router. */
export function createMiniMaxM27HighspeedRouter(options: MiniMaxModelOptions = {}): AnthropicCompatibleModelRouter {
  return createMiniMaxM3Router(options);
}

function messagesContainDirectImageInput(messages: readonly Message[]): boolean {
  return messages.some((message) =>
    message.parts.some((part) => part.type === "image"),
  );
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

function prependContextualUserMessage(
  messages: readonly Message[],
  contextualUser: readonly string[] | undefined,
): Message[] {
  const content = (contextualUser ?? []).map((item) => item.trim()).filter(Boolean).join("\n\n");
  if (!content) return [...messages];

  const sessionId = messages[0]?.sessionId ?? ("session_context" as Message["sessionId"]);
  return [
    {
      id: "msg_contextual_user" as Message["id"],
      sessionId,
      role: "user",
      createdAt: 0 as Message["createdAt"],
      parts: [
        {
          id: "part_contextual_user" as MessagePart["id"],
          messageId: "msg_contextual_user" as Message["id"],
          sessionId,
          type: "text",
          text: content,
          synthetic: true,
        },
      ],
    },
    ...messages,
  ];
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

function toAnthropicTools(tools: readonly ToolDefinition[]): AnthropicTool[] {
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

function supportsImageInput(inputCapabilities: readonly ("text" | "image")[] | undefined): boolean {
  return inputCapabilities === undefined || inputCapabilities.includes("image");
}

function parseSuccessfulResponse(text: string): AnthropicResponse {
  try {
    return JSON.parse(text) as AnthropicResponse;
  } catch {
    throw new Error("Model response was not valid JSON");
  }
}

function hasProviderPayloadError(payload: unknown): boolean {
  if (!isRecord(payload) || !("error" in payload)) return false;
  return payload.error !== undefined && payload.error !== null && payload.error !== false;
}

async function readProviderErrorJson(response: Response): Promise<unknown | undefined> {
  const body = await readResponseBodyBounded(response, PROVIDER_ERROR_BODY_MAX_BYTES);
  const trimmed = body.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

async function readResponseBodyBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = maxBytes - total;
      const chunk = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < value.byteLength || total >= maxBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    await reader.cancel().catch(() => undefined);
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function createProviderRequestError(payload: unknown, response: Response): ProviderRequestError {
  const details = extractProviderErrorDetails(payload);
  const requestId = safeRequestId(details?.requestId) ?? responseRequestId(response);
  const publicMessage = formatProviderErrorDetails(details);
  const fallback = response.status >= 400
    ? httpFailureMessage(response.status)
    : "Model request failed";
  let message = publicMessage ?? fallback;
  if (!publicMessage && requestId && !message.includes(requestId)) {
    message = `${message} (request id: ${requestId})`;
  }
  message = safePublicText(message) ?? fallback;

  const error = new Error(message) as ProviderRequestError;
  error.status = response.status;
  const code = safeDetailText(details?.code);
  const type = safeDetailText(details?.type);
  const param = safeDetailText(details?.param);
  if (code) error.code = code;
  if (type) error.type = type;
  if (param) error.param = param;
  if (requestId) error.requestId = requestId;
  return error;
}

function extractProviderErrorDetails(value: unknown): ProviderErrorDetails | undefined {
  if (!isRecord(value)) return undefined;
  const nested = isRecord(value.error) ? value.error : undefined;
  const message = firstString(nested?.message, value.message, value.error_description);
  const code = firstStringOrNumber(nested?.code, value.code);
  const type = firstString(nested?.type, value.type);
  const param = firstString(nested?.param, value.param);
  const requestId = firstString(
    nested?.request_id,
    nested?.requestId,
    value.request_id,
    value.requestId,
  );
  if (!message && !code && !type && !param && !requestId) return undefined;
  return {
    ...(message ? { message } : {}),
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
    ...(param ? { param } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function formatProviderErrorDetails(details: ProviderErrorDetails | undefined): string | undefined {
  if (!details) return undefined;
  const message = safePublicText(details.message);
  const code = safeDetailText(details.code);
  const type = safeDetailText(details.type);
  const param = safeDetailText(details.param);
  const requestId = safeRequestId(details.requestId);
  const primary = message ?? code ?? type;
  if (!primary) return undefined;

  const suffixes: string[] = [];
  if (code && code !== primary && !primary.includes(code)) suffixes.push(`code: ${code}`);
  if (type && type !== primary && type !== code && !primary.includes(type)) suffixes.push(`type: ${type}`);
  if (param && !primary.includes(param)) suffixes.push(`param: ${param}`);
  if (requestId && !primary.includes(requestId)) suffixes.push(`request id: ${requestId}`);
  return safePublicText(suffixes.length > 0 ? `${primary} (${suffixes.join(", ")})` : primary);
}

function safePublicText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = redactSensitiveText(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || MARKUP_PATTERN.test(normalized)) return undefined;
  return truncateUtf8(normalized, PROVIDER_PUBLIC_ERROR_MAX_BYTES);
}

function safeDetailText(value: string | undefined): string | undefined {
  const safe = safePublicText(value);
  if (!safe || new TextEncoder().encode(safe).byteLength > 160) return undefined;
  return safe;
}

function safeRequestId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || !REQUEST_ID_PATTERN.test(normalized)) return undefined;
  return redactSensitiveText(normalized) === normalized ? normalized : undefined;
}

function responseRequestId(response: Response): string | undefined {
  return safeRequestId(
    response.headers.get("x-request-id")
      ?? response.headers.get("request-id")
      ?? response.headers.get("x-correlation-id")
      ?? undefined,
  );
}

function httpFailureMessage(status: number): string {
  const statusLabel = HTTP_STATUS_LABELS[status];
  return `Model request failed with HTTP ${status}${statusLabel ? ` ${statusLabel}` : ""}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  const ellipsis = new TextEncoder().encode("…");
  const prefixBytes = encoded.subarray(0, Math.max(0, maxBytes - ellipsis.byteLength));
  const prefix = new TextDecoder().decode(prefixBytes, { stream: true }).trimEnd();
  return `${prefix}…`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, "sk-[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/\b((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|authorization|token)\s*(?::|=|\bis\b)\s*)["']?[A-Za-z0-9._~+/=-]{4,}["']?/gi, "$1[REDACTED]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]")
    .replace(IPV6_CANDIDATE_PATTERN, (candidate) => isIP(candidate) === 6 ? "[REDACTED_IP]" : candidate);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstStringOrNumber(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
