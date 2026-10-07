import {
  AnthropicCompatibleModel,
  isProviderError,
  MINIMAX_ANTHROPIC_BASE_URL,
  MINIMAX_M3_MODEL,
  readMiniMaxEnvironment,
  type AnthropicCompatibleModelOptions as ProviderAnthropicOptions,
  type AnthropicAuthScheme,
} from "@chili/providers";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";

export { MINIMAX_ANTHROPIC_BASE_URL, MINIMAX_M3_MODEL, resolveMessagesUrl } from "@chili/providers";
export type { AnthropicAuthScheme };

/** Compatibility options. Authentication and execution belong to @chili/providers. */
export interface AnthropicCompatibleModelOptions extends Omit<ProviderAnthropicOptions, "stream"> {}

export interface MiniMaxModelOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: boolean;
  serviceTier?: ProviderAnthropicOptions["serviceTier"];
  fetch?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_MINIMAX_MAX_TOKENS = 128 * 1024;

/**
 * @deprecated Prefer Host model routing or @chili/providers directly.
 * Retains the legacy constructor and non-streaming request default, while all
 * transport, replay, identity, cancellation and policy behavior is shared.
 */
export class AnthropicCompatibleModelRouter implements ModelRouter {
  private readonly model: AnthropicCompatibleModel;

  constructor(options: AnthropicCompatibleModelOptions) {
    this.model = new AnthropicCompatibleModel({
      ...options,
      stream: false,
    });
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    try {
      for await (const event of this.model.stream({
        ...input,
        metadata: { sessionId: input.sessionId, turnId: input.turnId },
      })) {
        // Older core callers receive failures as rejected iterators. Keep that
        // shape while retaining the provider's classification and retry verdict.
        if (event.type === "error") throw event.error;
        yield event;
      }
    } catch (error) {
      throw legacyErrorLabel(error);
    }
  }
}

/** @deprecated Prefer createMiniMaxM3Model from @chili/providers or shared Host routing. */
export function createMiniMaxM3Router(options: MiniMaxModelOptions = {}): AnthropicCompatibleModelRouter {
  const env = readMiniMaxEnvironment(options.env);
  const routerOptions: AnthropicCompatibleModelOptions = {
    provider: "minimax",
    model: options.model ?? env.model ?? MINIMAX_M3_MODEL,
    baseUrl: options.baseUrl
      ?? env.baseUrl
      ?? MINIMAX_ANTHROPIC_BASE_URL,
    apiKey: options.apiKey ?? env.apiKey ?? "",
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

function legacyErrorLabel(error: unknown): unknown {
  if (!isProviderError(error)) return error;
  // Preserve the previous public labels without interpreting raw server text or
  // duplicating the provider's sanitization/security boundary.
  if (error.message.startsWith("Model response was not valid JSON")) {
    error.message = "Model response was not valid JSON";
  } else if (error.category === "authentication") {
    error.message = `Authentication failed. ${error.message}`;
  }
  return error;
}
