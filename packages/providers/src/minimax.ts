import type { ChiliModelProvider, ModelDescriptor } from "./types.js";
import {
  AnthropicCompatibleModel,
  type AnthropicAuthScheme,
  type AnthropicCompatibleModelOptions,
} from "./anthropic-compatible.js";

export const MINIMAX_PROVIDER_ID = "minimax";
export const MINIMAX_M27_HIGHSPEED_MODEL = "MiniMax-M2.7-highspeed";
export const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";

export interface MiniMaxModelOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  authScheme?: AnthropicAuthScheme;
}

export class MiniMaxAnthropicProvider implements ChiliModelProvider {
  readonly id = MINIMAX_PROVIDER_ID;
  readonly name = "MiniMax";

  constructor(private readonly options: MiniMaxModelOptions = {}) {}

  models(): readonly ModelDescriptor[] {
    return [
      {
        provider: this.id,
        model: this.defaultModel(),
        displayName: this.defaultModel(),
        capabilities: {
          streaming: true,
          reasoning: true,
          toolCalls: true,
          toolCallDeltas: true,
          usage: true,
          responseId: true,
        },
      },
    ];
  }

  getModel(model?: string): AnthropicCompatibleModel {
    return createMiniMaxM27HighspeedModel({ ...this.options, ...(model ? { model } : {}) });
  }

  private defaultModel(): string {
    return this.options.model ?? process.env.MINIMAX_MODEL ?? process.env.ANTHROPIC_MODEL ?? MINIMAX_M27_HIGHSPEED_MODEL;
  }
}

export function createMiniMaxProvider(options: MiniMaxModelOptions = {}): MiniMaxAnthropicProvider {
  return new MiniMaxAnthropicProvider(options);
}

export function createMiniMaxM27HighspeedModel(options: MiniMaxModelOptions = {}): AnthropicCompatibleModel {
  const modelOptions: AnthropicCompatibleModelOptions = {
    provider: MINIMAX_PROVIDER_ID,
    model: options.model ?? process.env.MINIMAX_MODEL ?? process.env.ANTHROPIC_MODEL ?? MINIMAX_M27_HIGHSPEED_MODEL,
    baseUrl:
      options.baseUrl ??
      process.env.MINIMAX_BASE_URL ??
      process.env.MINIMAX_ANTHROPIC_BASE_URL ??
      process.env.ANTHROPIC_BASE_URL ??
      MINIMAX_ANTHROPIC_BASE_URL,
    apiKey: options.apiKey ?? process.env.MINIMAX_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
    authScheme: options.authScheme ?? "bearer",
  };
  if (options.maxTokens !== undefined) modelOptions.maxTokens = options.maxTokens;
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.fetch !== undefined) modelOptions.fetch = options.fetch;
  if (options.headers !== undefined) modelOptions.headers = options.headers;
  return new AnthropicCompatibleModel(modelOptions);
}
