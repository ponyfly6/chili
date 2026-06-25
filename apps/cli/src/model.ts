import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";
import type { ModelSelection, RuntimeModelDescriptor, ServiceTier } from "@chili/protocol";
import { createMiniMaxM27HighspeedRouter } from "@chili/core";
import {
  DEEPSEEK_OPENAI_BASE_URL,
  DEEPSEEK_PROVIDER_ID,
  FileAuthStorage,
  DEEPSEEK_V4_PRO_MODEL,
  findKnownModel,
  KIMI_K26_MODEL,
  KIMI_OPENAI_BASE_URL,
  KIMI_PROVIDER_ID,
  listModelCatalogFromStorage,
  listKnownModels,
  MINIMAX_ANTHROPIC_BASE_URL,
  MINIMAX_M27_HIGHSPEED_MODEL,
  MINIMAX_M3_MODEL,
  MINIMAX_PROVIDER_ID,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID,
  readDeepSeekEnvironment,
  readKimiEnvironment,
  readMiniMaxEnvironment,
  readOpenAICodexEnvironment,
} from "@chili/providers";
import { FakeModelRouter } from "./fake-model.js";

export type CliModelName = string;
export type CliProviderName = "minimax" | "deepseek" | "kimi" | "openai-codex";
export type CliReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CliModelSelection {
  provider?: string;
  model?: CliModelName;
  reasoningLevel?: CliReasoningLevel;
  serviceTier?: ServiceTier;
}

interface ProviderRouterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  reasoning?: boolean;
  reasoningEffort?: CliReasoningLevel;
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  serviceTier?: ServiceTier;
}

type CliModelOptions = ProviderRouterOptions & CliModelSelection;

type ProviderRouterFactory = (options?: ProviderRouterOptions) => ProviderModelOrProvider | Promise<ProviderModelOrProvider>;

interface ProviderModel {
  stream(input: ProviderModelStreamInput): AsyncIterable<ProviderModelStreamEvent>;
}

interface ProviderModelProvider {
  getModel(model?: string): ProviderModel;
}

interface ProviderModelStreamInput {
  messages: ModelStreamInput["messages"];
  tools?: ModelStreamInput["tools"];
  system?: readonly string[];
  developer?: readonly string[];
  contextualUser?: readonly string[];
  serviceTier?: ServiceTier;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

type ProviderModelOrProvider = ProviderModel | ProviderModelProvider;

type ProviderModelStreamEvent =
  | ModelStreamEvent
  | { type: "metadata"; [key: string]: unknown }
  | { type: "reasoning_delta"; [key: string]: unknown }
  | { type: "tool_call_start"; [key: string]: unknown }
  | { type: "tool_call_delta"; [key: string]: unknown }
  | { type: "tool_call_end"; name: string; input: unknown; [key: string]: unknown };

const PROVIDERS_PACKAGE_NAME = "@chili/providers";
const DEFAULT_DEEPSEEK_MAX_TOKENS = 128 * 1024;
const DEFAULT_KIMI_MAX_TOKENS = 32 * 1024;
const DEFAULT_MINIMAX_MAX_TOKENS = 32 * 1024;
const DEFAULT_PROVIDER: CliProviderName = "minimax";
const PROVIDER_DISPLAY_NAMES: Record<CliProviderName, string> = {
  minimax: "MiniMax",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  "openai-codex": "OpenAI Codex",
};

export async function createCliModel(selection?: CliModelName | CliModelSelection, options: CliModelOptions = {}): Promise<ModelRouter> {
  const config = normalizeCreateCliModelInput(selection, options);
  const defaultSelection = resolveCliModelSelection(config.provider, config.model);
  const baseOptions = providerBaseOptions(config);

  if (defaultSelection.kind === "fake") return new FakeModelRouter();
  if (defaultSelection.kind === "legacy-minimax") {
    return createMiniMaxM27HighspeedRouter(readMiniMaxOptionsFromEnv({
      ...baseOptions,
      ...(defaultSelection.model ? { model: defaultSelection.model } : {}),
    }));
  }

  const routerOptions: CliProviderRouterOptions = {
    defaultSelection,
    baseOptions,
  };
  if (config.reasoningLevel !== undefined) routerOptions.defaultReasoningLevel = config.reasoningLevel;
  if (config.serviceTier !== undefined) routerOptions.defaultServiceTier = config.serviceTier;
  return new CliProviderRouter(routerOptions);
}

export function resolveCliRuntimeModelSelection(selection: CliModelSelection): ModelSelection | undefined {
  const resolved = resolveCliModelSelection(selection.provider, selection.model);
  if (resolved.kind === "fake") return undefined;
  if (resolved.kind === "legacy-minimax") {
    return { provider: MINIMAX_PROVIDER_ID, model: resolved.model ?? MINIMAX_M27_HIGHSPEED_MODEL };
  }
  const providerOptions = readOptionsForProvider(resolved.provider, resolved.model ? { model: resolved.model } : {});
  const model = providerOptions.model;
  if (!model) return undefined;
  return { provider: resolved.provider, model };
}

async function loadProvidersModule(providerName: "minimax" | "deepseek" | "kimi" | "codex"): Promise<Record<string, unknown>> {
  try {
    return (await import(PROVIDERS_PACKAGE_NAME)) as Record<string, unknown>;
  } catch (error) {
    const fallback = providerName === "minimax" ? " Use --model legacy-minimax to temporarily use the old @chili/core router," : "";
    throw new Error(
      [
        `Unable to load @chili/providers for --model ${providerName}.`,
        fallback,
        "or --model fake for local smoke tests until the providers package is merged.",
      ]
        .filter(Boolean)
        .join(" "),
      { cause: error },
    );
  }
}

function resolveMiniMaxFactory(providers: Record<string, unknown>): ProviderRouterFactory {
  const defaultExport = providers.default;
  const defaultObject = isRecord(defaultExport) ? defaultExport : {};
  const candidates = [
    providers.createMiniMaxRouter,
    providers.createMiniMaxM27HighspeedRouter,
    providers.createMiniMaxM27HighspeedModel,
    providers.createMiniMaxProvider,
    providers.createMiniMaxProviderRouter,
    defaultObject.createMiniMaxRouter,
    defaultObject.createMiniMaxM27HighspeedModel,
    typeof defaultExport === "function" ? defaultExport : undefined,
  ];
  const factory = candidates.find((candidate) => typeof candidate === "function");
  if (!factory) {
    throw new Error(
      "@chili/providers must export createMiniMaxRouter(options) or another compatible MiniMax router factory",
    );
  }
  return factory as ProviderRouterFactory;
}

function resolveDeepSeekFactory(providers: Record<string, unknown>): ProviderRouterFactory {
  const defaultExport = providers.default;
  const defaultObject = isRecord(defaultExport) ? defaultExport : {};
  const candidates = [
    providers.createDeepSeekRouter,
    providers.createDeepSeekV4Model,
    providers.createDeepSeekProvider,
    defaultObject.createDeepSeekRouter,
    defaultObject.createDeepSeekV4Model,
    defaultObject.createDeepSeekProvider,
    typeof defaultExport === "function" ? defaultExport : undefined,
  ];
  const factory = candidates.find((candidate) => typeof candidate === "function");
  if (!factory) {
    throw new Error("@chili/providers must export createDeepSeekRouter(options) or another compatible DeepSeek factory");
  }
  return factory as ProviderRouterFactory;
}

function resolveKimiFactory(providers: Record<string, unknown>): ProviderRouterFactory {
  const defaultExport = providers.default;
  const defaultObject = isRecord(defaultExport) ? defaultExport : {};
  const candidates = [
    providers.createKimiRouter,
    providers.createKimiModel,
    providers.createKimiProvider,
    providers.createMoonshotRouter,
    providers.createMoonshotProvider,
    defaultObject.createKimiRouter,
    defaultObject.createKimiModel,
    defaultObject.createKimiProvider,
    defaultObject.createMoonshotRouter,
    defaultObject.createMoonshotProvider,
    typeof defaultExport === "function" ? defaultExport : undefined,
  ];
  const factory = candidates.find((candidate) => typeof candidate === "function");
  if (!factory) {
    throw new Error("@chili/providers must export createKimiRouter(options) or another compatible Kimi factory");
  }
  return factory as ProviderRouterFactory;
}

function resolveOpenAICodexFactory(providers: Record<string, unknown>): ProviderRouterFactory {
  const defaultExport = providers.default;
  const defaultObject = isRecord(defaultExport) ? defaultExport : {};
  const candidates = [
    providers.createOpenAICodexRouter,
    providers.createOpenAICodexModel,
    providers.createOpenAICodexProvider,
    defaultObject.createOpenAICodexRouter,
    defaultObject.createOpenAICodexModel,
    defaultObject.createOpenAICodexProvider,
    typeof defaultExport === "function" ? defaultExport : undefined,
  ];
  const factory = candidates.find((candidate) => typeof candidate === "function");
  if (!factory) {
    throw new Error("@chili/providers must export createOpenAICodexRouter(options) or another compatible OpenAI Codex factory");
  }
  return factory as ProviderRouterFactory;
}

function modelFromFactoryResult(
  modelOrProvider: ProviderModelOrProvider,
  modelName: string | undefined,
  providerName: string,
): ProviderModel {
  if (isProviderModelProvider(modelOrProvider)) return modelOrProvider.getModel(modelName);
  if (isProviderModel(modelOrProvider)) return modelOrProvider;
  throw new Error(`@chili/providers ${providerName} factory did not return a model or provider-compatible object`);
}

function normalizeCreateCliModelInput(
  selection: CliModelName | CliModelSelection | undefined,
  options: CliModelOptions,
): CliModelSelection & ProviderRouterOptions {
  const merged: CliModelSelection & ProviderRouterOptions = { ...options };
  if (typeof selection === "string") {
    const parsed = splitReasoningSuffix(selection);
    merged.model = parsed.model;
    if (parsed.reasoningLevel && merged.reasoningLevel === undefined) merged.reasoningLevel = parsed.reasoningLevel;
    return merged;
  }
  if (selection) {
    if (selection.provider !== undefined) merged.provider = selection.provider;
    if (selection.model !== undefined) {
      const parsed = splitReasoningSuffix(selection.model);
      merged.model = parsed.model;
      if (parsed.reasoningLevel && merged.reasoningLevel === undefined) merged.reasoningLevel = parsed.reasoningLevel;
    }
    if (selection.reasoningLevel !== undefined) merged.reasoningLevel = selection.reasoningLevel;
    if (selection.serviceTier !== undefined) merged.serviceTier = selection.serviceTier;
  }
  return merged;
}

function providerBaseOptions(input: CliModelOptions): ProviderRouterOptions {
  const options: ProviderRouterOptions = {};
  if (input.apiKey !== undefined) options.apiKey = input.apiKey;
  if (input.baseUrl !== undefined) options.baseUrl = input.baseUrl;
  if (input.maxTokens !== undefined) options.maxTokens = input.maxTokens;
  if (input.temperature !== undefined) options.temperature = input.temperature;
  if (input.fetch !== undefined) options.fetch = input.fetch;
  if (input.headers !== undefined) options.headers = input.headers;
  if (input.serviceTier !== undefined) options.serviceTier = input.serviceTier;
  return options;
}

type ResolvedCliModelSelection =
  | { kind: "fake"; model?: string }
  | { kind: "legacy-minimax"; model?: string }
  | { kind: "provider"; provider: CliProviderName; model?: string };

function resolveCliModelSelection(providerInput: string | undefined, modelInput: string | undefined): ResolvedCliModelSelection {
  const provider = normalizeProviderName(providerInput);
  let model = modelInput?.trim();
  if (model) {
    const parsed = splitReasoningSuffix(model);
    model = parsed.model;
  }

  if (!model) {
    return { kind: "provider", provider: provider ?? DEFAULT_PROVIDER };
  }

  const modelAlias = normalizeSpecialModelAlias(model);
  if (!provider && modelAlias) return modelAlias;

  const split = splitProviderModelReference(model);
  if (provider) {
    if (split && split.provider !== provider) {
      throw new Error(`--model ${model} conflicts with --provider ${provider}`);
    }
    return { kind: "provider", provider, model: split?.model ?? model };
  }

  if (split) return { kind: "provider", provider: split.provider, model: split.model };

  const exact = findKnownModelByBareId(model);
  if (exact) return { kind: "provider", provider: exact.provider, model: exact.model };

  const heuristicProvider = inferProviderFromBareModel(model);
  if (heuristicProvider) return { kind: "provider", provider: heuristicProvider, model };

  return { kind: "provider", provider: DEFAULT_PROVIDER, model };
}

function normalizeProviderName(value: string | undefined): CliProviderName | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "minimax") return "minimax";
  if (normalized === "deepseek") return "deepseek";
  if (normalized === "kimi" || normalized === "moonshot") return "kimi";
  if (normalized === "codex" || normalized === "openai-codex") return "openai-codex";
  throw new Error(`Unknown provider: ${value}`);
}

function normalizeSpecialModelAlias(value: string): ResolvedCliModelSelection | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "fake") return { kind: "fake" };
  if (normalized === "legacy-minimax") return { kind: "legacy-minimax" };
  const provider = normalizeProviderAlias(normalized);
  return provider ? { kind: "provider", provider } : undefined;
}

function normalizeProviderAlias(value: string): CliProviderName | undefined {
  if (value === "minimax") return "minimax";
  if (value === "deepseek") return "deepseek";
  if (value === "kimi" || value === "moonshot") return "kimi";
  if (value === "codex" || value === "openai-codex") return "openai-codex";
  return undefined;
}

function splitProviderModelReference(value: string): { provider: CliProviderName; model: string } | undefined {
  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) return undefined;
  const provider = normalizeProviderAlias(value.slice(0, slashIndex).trim().toLowerCase());
  const model = value.slice(slashIndex + 1).trim();
  if (!provider || !model) return undefined;
  return { provider, model };
}

function findKnownModelByBareId(model: string): { provider: CliProviderName; model: string } | undefined {
  const normalized = model.toLowerCase();
  const matches = listKnownModels()
    .filter((descriptor) => isCliProviderName(descriptor.provider) && descriptor.model.toLowerCase() === normalized)
    .map((descriptor) => ({ provider: descriptor.provider as CliProviderName, model: descriptor.model }));
  return matches.length === 1 ? matches[0] : undefined;
}

function inferProviderFromBareModel(model: string): CliProviderName | undefined {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("gpt-")) return "openai-codex";
  if (normalized.startsWith("deepseek-")) return "deepseek";
  if (normalized.startsWith("kimi-") || normalized.startsWith("moonshot-")) return "kimi";
  if (normalized.startsWith("minimax-")) return "minimax";
  return undefined;
}

function isCliProviderName(provider: string): provider is CliProviderName {
  return provider === MINIMAX_PROVIDER_ID
    || provider === DEEPSEEK_PROVIDER_ID
    || provider === KIMI_PROVIDER_ID
    || provider === OPENAI_CODEX_PROVIDER_ID;
}

function splitReasoningSuffix(value: string): { model: string; reasoningLevel?: CliReasoningLevel } {
  const trimmed = value.trim();
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex === -1) return { model: trimmed };
  const suffix = trimmed.slice(colonIndex + 1);
  if (!isReasoningLevel(suffix)) return { model: trimmed };
  const model = trimmed.slice(0, colonIndex).trim();
  if (!model) throw new Error(`Model reference ${value} is missing a model before the thinking suffix`);
  return { model, reasoningLevel: suffix };
}

function isReasoningLevel(value: string): value is CliReasoningLevel {
  return value === "off"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh";
}

interface CliProviderRouterOptions {
  defaultSelection: Extract<ResolvedCliModelSelection, { kind: "provider" }>;
  defaultReasoningLevel?: CliReasoningLevel;
  defaultServiceTier?: ServiceTier;
  baseOptions: ProviderRouterOptions;
}

class CliProviderRouter implements ModelRouter {
  private readonly factories = new Map<CliProviderName, Promise<ProviderRouterFactory>>();

  constructor(private readonly options: CliProviderRouterOptions) {}

  async listModels(): Promise<readonly RuntimeModelDescriptor[]> {
    const catalog = await listModelCatalogFromStorage(undefined, new FileAuthStorage());
    return catalog.filter((model) => isCliProviderName(model.provider)).map((model) => ({
      provider: model.provider,
      model: model.model,
      ...(model.displayName ? { displayName: model.displayName } : {}),
      ...(model.providerDisplayName ? { providerDisplayName: model.providerDisplayName } : {}),
      available: model.available,
      ...(model.capabilities ? { capabilities: { ...model.capabilities } } : {}),
      ...(model.inputCapabilities ? { inputCapabilities: [...model.inputCapabilities] } : {}),
      ...(model.contextWindowTokens !== undefined ? { contextWindowTokens: model.contextWindowTokens } : {}),
      ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...(model.default !== undefined ? { default: model.default } : {}),
    }));
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    const extended = input as ExtendedModelStreamInput;
    const selection = this.selectionForInput(extended);
    if (selection.kind === "fake") {
      yield* new FakeModelRouter().stream(input);
      return;
    }
    if (selection.kind === "legacy-minimax") {
      const legacyOptions = readMiniMaxOptionsFromEnv({
        ...this.options.baseOptions,
        ...(selection.model ? { model: selection.model } : {}),
      });
      yield* createMiniMaxM27HighspeedRouter(legacyOptions).stream(input);
      return;
    }

    const reasoningLevel = reasoningLevelForInput(extended, this.options.defaultReasoningLevel);
    const serviceTier = serviceTierForInput(extended, this.options.defaultServiceTier);
    const providerOptions = this.optionsForProvider(selection, reasoningLevel, serviceTier);
    const factory = await this.factoryFor(selection.provider);
    const modelOrProvider = await factory(providerOptions);
    const model = modelFromFactoryResult(
      modelOrProvider,
      providerOptions.model,
      PROVIDER_DISPLAY_NAMES[selection.provider],
    );
    yield* new ProviderModelRouterAdapter(model).stream(input);
  }

  private selectionForInput(input: ExtendedModelStreamInput): ResolvedCliModelSelection {
    const override = modelSelectionForInput(input);
    if (!override) return this.options.defaultSelection;
    return resolveCliModelSelection(override.provider, override.model);
  }

  private optionsForProvider(
    selection: Extract<ResolvedCliModelSelection, { kind: "provider" }>,
    reasoningLevel: CliReasoningLevel | undefined,
    serviceTier: ServiceTier | undefined,
  ): ProviderRouterOptions {
    const input: ProviderRouterOptions = {
      ...this.options.baseOptions,
      ...(selection.model ? { model: selection.model } : {}),
    };
    if (selection.provider === "openai-codex" && serviceTier !== undefined) input.serviceTier = serviceTier;
    const withEnv = readOptionsForProvider(selection.provider, input);
    applyReasoningOptions(withEnv, selection.provider, reasoningLevel);
    return withEnv;
  }

  private async factoryFor(provider: CliProviderName): Promise<ProviderRouterFactory> {
    const existing = this.factories.get(provider);
    if (existing) return existing;
    const promise = loadFactoryForProvider(provider);
    this.factories.set(provider, promise);
    return promise;
  }
}

type ExtendedModelStreamInput = ModelStreamInput & {
  model?: unknown;
  modelSelection?: unknown;
  provider?: unknown;
  reasoning?: unknown;
  reasoningLevel?: unknown;
  serviceTier?: unknown;
  thinking?: unknown;
  maxTokens?: number;
  temperature?: number;
};

function modelSelectionForInput(input: ExtendedModelStreamInput): { provider?: string; model?: string } | undefined {
  const fromSelection = parseModelSelectionValue(input.modelSelection);
  if (fromSelection) return fromSelection;
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
  const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : undefined;
  if (!model && !provider) return undefined;
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}

function parseModelSelectionValue(value: unknown): { provider?: string; model?: string } | undefined {
  if (typeof value === "string" && value.trim()) return { model: value.trim() };
  if (!isRecord(value)) return undefined;
  const provider = stringProperty(value, "provider");
  const model = stringProperty(value, "model") ?? stringProperty(value, "modelId") ?? stringProperty(value, "id");
  if (!provider && !model) return undefined;
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}

function reasoningLevelForInput(
  input: ExtendedModelStreamInput,
  defaultReasoningLevel: CliReasoningLevel | undefined,
): CliReasoningLevel | undefined {
  const candidates = [input.reasoningLevel, input.thinking, input.reasoning];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && isReasoningLevel(candidate)) return candidate;
  }
  return defaultReasoningLevel;
}

function serviceTierForInput(
  input: ExtendedModelStreamInput,
  defaultServiceTier: ServiceTier | undefined,
): ServiceTier | undefined {
  return input.serviceTier === "fast" || input.serviceTier === "standard" ? input.serviceTier : defaultServiceTier;
}

function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function loadFactoryForProvider(provider: CliProviderName): Promise<ProviderRouterFactory> {
  if (provider === "deepseek") return resolveDeepSeekFactory(await loadProvidersModule("deepseek"));
  if (provider === "kimi") return resolveKimiFactory(await loadProvidersModule("kimi"));
  if (provider === "openai-codex") return resolveOpenAICodexFactory(await loadProvidersModule("codex"));
  return resolveMiniMaxFactory(await loadProvidersModule("minimax"));
}

function readMiniMaxOptionsFromEnv(input: CliModelOptions): ProviderRouterOptions {
  const options: ProviderRouterOptions = { maxTokens: input.maxTokens ?? DEFAULT_MINIMAX_MAX_TOKENS };
  const env = readMiniMaxEnvironment();
  const resolvedApiKey = input.apiKey ?? env.apiKey;
  const resolvedBaseUrl = input.baseUrl ?? env.baseUrl ?? MINIMAX_ANTHROPIC_BASE_URL;
  const resolvedModel = input.model ?? env.model ?? MINIMAX_M3_MODEL;

  if (resolvedApiKey) options.apiKey = resolvedApiKey;
  if (resolvedBaseUrl) options.baseUrl = resolvedBaseUrl;
  if (resolvedModel) options.model = resolvedModel;
  if (input.temperature !== undefined) options.temperature = input.temperature;
  if (input.fetch) options.fetch = input.fetch;
  if (input.headers !== undefined) options.headers = input.headers;
  return options;
}

function readDeepSeekOptionsFromEnv(input: CliModelOptions): ProviderRouterOptions {
  const options: ProviderRouterOptions = { maxTokens: input.maxTokens ?? DEFAULT_DEEPSEEK_MAX_TOKENS };
  const env = readDeepSeekEnvironment();
  const resolvedApiKey = input.apiKey ?? env.apiKey;
  const resolvedBaseUrl = input.baseUrl ?? env.baseUrl ?? DEEPSEEK_OPENAI_BASE_URL;
  const resolvedModel = input.model ?? env.model ?? DEEPSEEK_V4_PRO_MODEL;

  if (resolvedApiKey) options.apiKey = resolvedApiKey;
  if (resolvedBaseUrl) options.baseUrl = resolvedBaseUrl;
  if (resolvedModel) options.model = resolvedModel;
  if (input.temperature !== undefined) options.temperature = input.temperature;
  if (input.fetch) options.fetch = input.fetch;
  if (input.headers !== undefined) options.headers = input.headers;
  return options;
}

function readKimiOptionsFromEnv(input: CliModelOptions): ProviderRouterOptions {
  const options: ProviderRouterOptions = { maxTokens: input.maxTokens ?? DEFAULT_KIMI_MAX_TOKENS };
  const env = readKimiEnvironment();
  const resolvedApiKey = input.apiKey ?? env.apiKey;
  const resolvedBaseUrl = input.baseUrl ?? env.baseUrl ?? KIMI_OPENAI_BASE_URL;
  const resolvedModel = input.model ?? env.model ?? KIMI_K26_MODEL;

  if (resolvedApiKey) options.apiKey = resolvedApiKey;
  if (resolvedBaseUrl) options.baseUrl = resolvedBaseUrl;
  if (resolvedModel) options.model = resolvedModel;
  if (input.temperature !== undefined) options.temperature = input.temperature;
  if (input.fetch) options.fetch = input.fetch;
  if (input.headers !== undefined) options.headers = input.headers;
  return options;
}

function readOpenAICodexOptionsFromEnv(input: CliModelOptions): ProviderRouterOptions {
  const options: ProviderRouterOptions = {};
  const env = readOpenAICodexEnvironment();
  const resolvedApiKey = input.apiKey ?? env.apiKey;
  const resolvedBaseUrl = input.baseUrl ?? env.baseUrl ?? OPENAI_CODEX_BASE_URL;
  const resolvedModel = input.model ?? env.model ?? OPENAI_CODEX_DEFAULT_MODEL;

  if (resolvedApiKey) options.apiKey = resolvedApiKey;
  if (resolvedBaseUrl) options.baseUrl = resolvedBaseUrl;
  if (resolvedModel) options.model = resolvedModel;
  if (input.maxTokens !== undefined) options.maxTokens = input.maxTokens;
  if (input.temperature !== undefined) options.temperature = input.temperature;
  if (input.fetch) options.fetch = input.fetch;
  if (input.headers !== undefined) options.headers = input.headers;
  if (input.serviceTier !== undefined) options.serviceTier = input.serviceTier;
  return options;
}

function readOptionsForProvider(provider: CliProviderName, input: ProviderRouterOptions): ProviderRouterOptions {
  if (provider === "deepseek") return readDeepSeekOptionsFromEnv(input);
  if (provider === "kimi") return readKimiOptionsFromEnv(input);
  if (provider === "openai-codex") return readOpenAICodexOptionsFromEnv(input);
  return readMiniMaxOptionsFromEnv(input);
}

function applyReasoningOptions(
  options: ProviderRouterOptions,
  provider: CliProviderName,
  reasoningLevel: CliReasoningLevel | undefined,
): void {
  if (!reasoningLevel) return;
  if (provider === "openai-codex") {
    if (reasoningLevel === "off") return;
    options.reasoningEffort = reasoningLevel;
    options.reasoningSummary = "auto";
    return;
  }
  if (provider === "deepseek" || provider === "kimi") {
    options.reasoning = reasoningLevel !== "off";
  }
}

function isProviderModel(value: unknown): value is ProviderModel {
  return isRecord(value) && typeof value.stream === "function";
}

function isProviderModelProvider(value: unknown): value is ProviderModelProvider {
  return isRecord(value) && typeof value.getModel === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class ProviderModelRouterAdapter implements ModelRouter {
  constructor(private readonly model: ProviderModel) {}

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    for await (const event of this.model.stream(toProviderInput(input))) {
      if (isModelStreamEvent(event)) {
        yield enrichMetadata(event as ModelStreamEvent);
      }
    }
  }
}

function enrichMetadata(event: ModelStreamEvent): ModelStreamEvent {
  if (event.type !== "metadata" || !event.provider || !event.model) return event;
  const descriptor = findKnownModel(event.provider, event.model);
  if (!descriptor) return event;

  const output: Extract<ModelStreamEvent, { type: "metadata" }> = { ...event };
  if (output.contextWindowTokens === undefined && descriptor.contextWindowTokens !== undefined) {
    output.contextWindowTokens = descriptor.contextWindowTokens;
  }
  if (output.maxOutputTokens === undefined && descriptor.maxOutputTokens !== undefined) {
    output.maxOutputTokens = descriptor.maxOutputTokens;
  }
  return output;
}

function isModelStreamEvent(event: ProviderModelStreamEvent): boolean {
  return (
    event.type === "metadata" ||
    event.type === "text_delta" ||
    event.type === "reasoning_delta" ||
    event.type === "tool_call_start" ||
    event.type === "tool_call_delta" ||
    event.type === "tool_call_end" ||
    event.type === "tool_call" ||
    event.type === "finish" ||
    event.type === "error"
  );
}

function toProviderInput(input: ModelStreamInput): ProviderModelStreamInput {
  const extended = input as ExtendedModelStreamInput;
  const providerInput: ProviderModelStreamInput = {
    messages: input.messages,
    tools: input.tools,
    system: input.system,
    metadata: {
      sessionId: input.sessionId,
      threadId: input.threadId,
      turnId: input.turnId,
    },
  };
  if (input.developer !== undefined) providerInput.developer = input.developer;
  if (input.contextualUser !== undefined) providerInput.contextualUser = input.contextualUser;
  if (input.signal) providerInput.signal = input.signal;
  if (input.serviceTier !== undefined) providerInput.serviceTier = input.serviceTier;
  if (extended.maxTokens !== undefined) providerInput.maxTokens = extended.maxTokens;
  if (extended.temperature !== undefined) providerInput.temperature = extended.temperature;
  return providerInput;
}
