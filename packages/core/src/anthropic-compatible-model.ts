import {
  AnthropicCompatibleModel,
  createMiniMaxM3Model,
  isProviderError,
  type AnthropicCompatibleModelOptions as ProviderAnthropicOptions,
  type AnthropicAuthScheme,
} from "@chili/providers";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";

export { MINIMAX_BASE_URL, MINIMAX_M3_MODEL, resolveMessagesUrl } from "@chili/providers";
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
  serviceTier?: NonNullable<ProviderAnthropicOptions["serviceTier"]>;
  fetch?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
}

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
export function createMiniMaxM3Router(options: MiniMaxModelOptions = {}): ModelRouter {
  const model = createMiniMaxM3Model(options);
  return {
    async *stream(input) {
      try {
        for await (const event of model.stream({
          ...input,
          metadata: { sessionId: input.sessionId, turnId: input.turnId },
        })) {
          if (event.type === "error") throw event.error;
          yield event;
        }
      } catch (error) {
        throw legacyErrorLabel(error);
      }
    },
  };
}

/** @deprecated Use createMiniMaxM3Router. */
export function createMiniMaxM27HighspeedRouter(options: MiniMaxModelOptions = {}): ModelRouter {
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
