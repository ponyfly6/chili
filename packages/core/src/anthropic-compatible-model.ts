import type { Message, MessagePart, ToolDefinition } from "@chili/protocol";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";

export type AnthropicAuthScheme = "bearer" | "x-api-key";

export interface AnthropicCompatibleModelOptions {
  model: string;
  apiKey: string;
  baseUrl: string;
  authScheme?: AnthropicAuthScheme;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
}

export interface MiniMaxModelOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: unknown;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  error?: {
    message?: string;
    type?: string;
  };
}

export const MINIMAX_M27_HIGHSPEED_MODEL = "MiniMax-M2.7-highspeed";
export const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";

export class AnthropicCompatibleModelRouter implements ModelRouter {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicCompatibleModelOptions) {
    if (!options.apiKey) throw new Error("Anthropic-compatible model requires an API key");
    if (!options.model) throw new Error("Anthropic-compatible model requires a model name");
    if (!options.baseUrl) throw new Error("Anthropic-compatible model requires a baseUrl");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    const init: RequestInit = {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(input)),
    };
    if (input.signal) init.signal = input.signal;
    const response = await this.fetchImpl(resolveMessagesUrl(this.options.baseUrl), init);

    const text = await response.text();
    const payload = parseResponse(text);
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Model request failed with HTTP ${response.status}: ${text}`);
    }
    if (payload.error) {
      throw new Error(payload.error.message ?? payload.error.type ?? "Model request failed");
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
    const body: Record<string, unknown> = {
      model: this.options.model,
      max_tokens: this.options.maxTokens ?? 4096,
      messages: toAnthropicMessages(messages),
      tools: toAnthropicTools(input.tools),
      stream: false,
    };
    const system = [...input.system, ...(input.developer ?? []), ...systemMessages(messages)].filter(Boolean).join("\n\n");
    if (system) body.system = system;
    if (this.options.temperature !== undefined) body.temperature = this.options.temperature;
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

export function createMiniMaxM27HighspeedRouter(options: MiniMaxModelOptions = {}): AnthropicCompatibleModelRouter {
  const routerOptions: AnthropicCompatibleModelOptions = {
    model: options.model ?? process.env.ANTHROPIC_MODEL ?? process.env.MINIMAX_MODEL ?? MINIMAX_M27_HIGHSPEED_MODEL,
    baseUrl: options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? process.env.MINIMAX_ANTHROPIC_BASE_URL ?? MINIMAX_ANTHROPIC_BASE_URL,
    apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.MINIMAX_API_KEY ?? "",
    authScheme: "bearer",
  };
  if (options.maxTokens !== undefined) routerOptions.maxTokens = options.maxTokens;
  if (options.temperature !== undefined) routerOptions.temperature = options.temperature;
  if (options.fetch !== undefined) routerOptions.fetch = options.fetch;
  return new AnthropicCompatibleModelRouter(routerOptions);
}

export function resolveMessagesUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  if (clean.endsWith("/v1/messages")) return clean;
  if (clean.endsWith("/v1")) return `${clean}/messages`;
  return `${clean}/v1/messages`;
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

function formatToolResult(part: Extract<MessagePart, { type: "tool_result" }>): string {
  if (part.error) return part.output ? `${part.output}\n\nError: ${part.error}` : `Error: ${part.error}`;
  return part.output;
}

function parseResponse(text: string): AnthropicResponse {
  try {
    return JSON.parse(text) as AnthropicResponse;
  } catch {
    throw new Error(`Model response was not JSON: ${text}`);
  }
}
