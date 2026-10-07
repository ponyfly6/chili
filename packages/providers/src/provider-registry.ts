import type { ServiceTier } from "@chili/protocol";
import type { FileAuthStorage } from "./auth.js";
import { createMiniMaxRouter } from "./minimax.js";
import { createDeepSeekRouter } from "./deepseek.js";
import { createKimiRouter } from "./kimi.js";
import { createZaiRouter } from "./zai.js";
import { createXaiRouter } from "./xai.js";
import { createCodexApiRouter, createOpenAICodexRouter } from "./openai-codex.js";
import { readProviderEnvironment, snapshotProviderEnvironment, type EnvironmentSource } from "./env.js";
import { clampModelReasoningLevel } from "./model-selection.js";
import { findDefaultKnownModel, findKnownModel } from "./models.js";
import { BUILTIN_PROVIDERS, canonicalizeProviderModel, type BuiltinProviderId } from "./provider-definition.js";
import { REASONING_LEVELS, type ChiliModel, type ReasoningLevel } from "./types.js";

/** Shared construction options; protocol-specific wire options stay in the adapters. */
export interface ProviderModelOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  authStorage?: FileAuthStorage;
  env?: EnvironmentSource;
  reasoning?: boolean;
  reasoningEffort?: ReasoningLevel;
  reasoningMode?: "pro";
  reasoningContext?: "auto" | "all_turns" | "current_turn";
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  serviceTier?: ServiceTier;
}

export interface ResolvedProviderModelOptions extends ProviderModelOptions {
  model: string;
  maxTokens: number;
  env: EnvironmentSource;
}

const factories = {
  minimax: createMiniMaxRouter,
  deepseek: createDeepSeekRouter,
  kimi: createKimiRouter,
  zai: createZaiRouter,
  xai: createXaiRouter,
  "openai-codex": createOpenAICodexRouter,
  "codex-api": createCodexApiRouter,
} satisfies Record<BuiltinProviderId, (options: ProviderModelOptions) => ChiliModel>;

export function assertProviderConnectionOptions(provider: BuiltinProviderId, input: ProviderModelOptions): void {
  if (BUILTIN_PROVIDERS[provider].auth === "oauth" && (input.apiKey !== undefined || input.baseUrl !== undefined)) {
    throw new Error(`${provider} is OAuth-only; use codex-api for API keys and custom endpoints`);
  }
}

/** Resolve each attempt against one environment snapshot; never resolve/cache OAuth tokens here. */
export function resolveProviderModelOptions(
  provider: BuiltinProviderId,
  input: ProviderModelOptions = {},
  controls: { reasoningLevel?: ReasoningLevel; serviceTier?: ServiceTier } = {},
): ResolvedProviderModelOptions {
  assertProviderConnectionOptions(provider, input);
  const definition = BUILTIN_PROVIDERS[provider];
  const env = snapshotProviderEnvironment(provider, input.env);
  const environment = readProviderEnvironment(provider, env);
  const selectedModel = input.model ?? environment.model ?? findDefaultKnownModel(provider)?.model;
  if (!selectedModel) throw new Error(`No default model registered for ${provider}`);
  const model = canonicalizeProviderModel(provider, selectedModel);
  const options: ResolvedProviderModelOptions = {
    ...input, model, env, maxTokens: input.maxTokens ?? definition.defaultRequestMaxTokens,
    ...(input.headers ? { headers: { ...input.headers } } : {}),
  };
  // Keep environment credentials in the snapshot, rather than disguising them as
  // explicit options. Adapters validate their provenance (notably legacy OAuth tokens).
  if (!definition.serviceTier) delete options.serviceTier;
  else if (controls.serviceTier !== undefined) options.serviceTier = controls.serviceTier;
  const descriptor = findKnownModel(provider, model);
  const requested = controls.reasoningLevel;
  const mapped = requested && requested !== "off" ? descriptor?.compatibility?.chatCompletions?.reasoningEffortMap?.[requested] : undefined;
  const level = requested ? clampModelReasoningLevel(
    descriptor ?? model,
    mapped && (REASONING_LEVELS as readonly string[]).includes(mapped) ? mapped as ReasoningLevel : requested,
  ) : undefined;
  if (level) {
    switch (definition.reasoning) {
      case "responses": options.reasoningEffort = level; options.reasoningSummary = "auto"; break;
      case "toggle": options.reasoning = level !== "off"; break;
      case "toggle-effort":
        options.reasoning = level !== "off";
        if (level !== "off") options.reasoningEffort = level;
        break;
      case "effort": options.reasoning = true; options.reasoningEffort = level; break;
    }
  }
  return options;
}

/** The typed table makes missing registrations a build error, not a guessed export name. */
export function createRegisteredProviderModel(provider: BuiltinProviderId, options: ResolvedProviderModelOptions): ChiliModel {
  return factories[provider](options);
}

/** Connection secrets and endpoint headers belong only to their selected provider. */
export function scopeProviderModelOptions(
  input: ProviderModelOptions,
  source: BuiltinProviderId,
  target: BuiltinProviderId,
): ProviderModelOptions {
  const { apiKey, baseUrl, headers, authStorage, model: _model, env, ...shared } = input;
  return {
    ...shared,
    ...(env ? { env } : {}),
    ...(source === target ? {
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(headers !== undefined ? { headers } : {}),
    } : {}),
    ...(BUILTIN_PROVIDERS[target].auth === "oauth" && authStorage ? { authStorage } : {}),
  };
}
