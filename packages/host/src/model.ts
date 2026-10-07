import type {
  ModelRequestLimits,
  ModelRequestLimitsInput,
  ModelRouter,
  ModelStreamEvent,
  ModelStreamInput,
} from "@chili/core";
import type { ModelSelection, RuntimeModelDescriptor, ServiceTier } from "@chili/protocol";
import {
  BUILTIN_PROVIDERS,
  assertProviderConnectionOptions,
  canonicalizeProviderModel,
  createRegisteredProviderModel,
  FileAuthStorage,
  findKnownModel,
  getModelSelectionAvailableReasoningLevels,
  inferBuiltinProviderId,
  isBuiltinProviderId,
  listModelCatalogFromStorage,
  listKnownModels,
  REASONING_LEVELS,
  resolveBuiltinProviderId,
  resolveProviderModelOptions,
  scopeProviderModelOptions,
  type BuiltinProviderId,
  type ChiliModel,
  type ModelStreamInput as ProviderModelStreamInput,
  type ProviderModelOptions,
  type ReasoningLevel,
  type ResolvedProviderModelOptions,
} from "@chili/providers";
import { FakeModelRouter } from "./fake-model.js";

export type HostModelName = string;
export type HostProviderName = BuiltinProviderId;
export type HostReasoningLevel = ReasoningLevel;

export interface HostModelSelection {
  provider?: string;
  model?: HostModelName;
  reasoningLevel?: HostReasoningLevel;
  serviceTier?: ServiceTier;
}

type HostModelOptions = ProviderModelOptions & HostModelSelection & { profileId?: string };
const DEFAULT_PROVIDER: HostProviderName = "minimax";

export async function createHostModel(selection?: HostModelName | HostModelSelection, options: HostModelOptions = {}): Promise<ModelRouter> {
  const config = normalizeCreateHostModelInput(selection, options);
  const defaultSelection = resolveHostModelSelection(config.provider, config.model);
  const baseOptions = providerBaseOptions(config);

  if (defaultSelection.kind === "fake") return new FakeModelRouter();
  assertProviderConnectionOptions(defaultSelection.provider, baseOptions);

  const routerOptions: HostProviderRouterOptions = {
    defaultSelection,
    baseOptions,
    ...(config.profileId !== undefined ? { profileId: config.profileId } : {}),
  };
  if (config.reasoningLevel !== undefined) routerOptions.defaultReasoningLevel = config.reasoningLevel;
  if (config.serviceTier !== undefined) routerOptions.defaultServiceTier = config.serviceTier;
  return new HostProviderRouter(routerOptions);
}

export function resolveHostRuntimeModelSelection(selection: HostModelSelection): ModelSelection | undefined {
  const resolved = resolveHostModelSelection(selection.provider, selection.model);
  if (resolved.kind === "fake") return undefined;
  const providerOptions = resolveProviderModelOptions(resolved.provider, resolved.model ? { model: resolved.model } : {});
  const model = providerOptions.model;
  if (!model) return undefined;
  return { provider: resolved.provider, model };
}

function normalizeCreateHostModelInput(
  selection: HostModelName | HostModelSelection | undefined,
  options: HostModelOptions,
): HostModelOptions {
  const merged: HostModelOptions = { ...options };
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

function providerBaseOptions(input: HostModelOptions): ProviderModelOptions {
  const options: ProviderModelOptions = {};
  if (input.env !== undefined) options.env = input.env;
  if (input.apiKey !== undefined) options.apiKey = input.apiKey;
  if (input.baseUrl !== undefined) options.baseUrl = input.baseUrl;
  if (input.maxTokens !== undefined) options.maxTokens = input.maxTokens;
  if (input.temperature !== undefined) options.temperature = input.temperature;
  if (input.fetch !== undefined) options.fetch = input.fetch;
  if (input.headers !== undefined) options.headers = input.headers;
  if (input.authStorage !== undefined) options.authStorage = input.authStorage;
  if (input.serviceTier !== undefined) options.serviceTier = input.serviceTier;
  if (input.reasoningMode !== undefined) options.reasoningMode = input.reasoningMode;
  if (input.reasoningContext !== undefined) options.reasoningContext = input.reasoningContext;
  return options;
}

type ResolvedHostModelSelection =
  | { kind: "fake"; model?: string }
  | { kind: "provider"; provider: HostProviderName; model?: string };

function resolveHostModelSelection(providerInput: string | undefined, modelInput: string | undefined): ResolvedHostModelSelection {
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
    const resolvedModel = canonicalizeProviderModel(provider, split?.model ?? model);
    return { kind: "provider", provider, model: resolvedModel };
  }

  if (split) {
    const resolvedModel = canonicalizeProviderModel(split.provider, split.model);
    return { kind: "provider", provider: split.provider, model: resolvedModel };
  }

  const exact = findKnownModelByBareId(model);
  if (exact) return { kind: "provider", provider: exact.provider, model: exact.model };

  const heuristicProvider = inferBuiltinProviderId(model);
  if (heuristicProvider) {
    const resolvedModel = canonicalizeProviderModel(heuristicProvider, model);
    return { kind: "provider", provider: heuristicProvider, model: resolvedModel };
  }

  return { kind: "provider", provider: DEFAULT_PROVIDER, model };
}

function normalizeProviderName(value: string | undefined): HostProviderName | undefined {
  if (!value) return undefined;
  const provider = resolveBuiltinProviderId(value);
  if (!provider) throw new Error(`Unknown provider: ${value}`);
  return provider;
}

function normalizeSpecialModelAlias(value: string): ResolvedHostModelSelection | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "fake") return { kind: "fake" };
  const provider = resolveBuiltinProviderId(normalized);
  return provider ? { kind: "provider", provider } : undefined;
}

function splitProviderModelReference(value: string): { provider: HostProviderName; model: string } | undefined {
  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) return undefined;
  const provider = resolveBuiltinProviderId(value.slice(0, slashIndex).trim().toLowerCase());
  const model = value.slice(slashIndex + 1).trim();
  if (!provider || !model) return undefined;
  return { provider, model };
}

function findKnownModelByBareId(model: string): { provider: HostProviderName; model: string } | undefined {
  const normalized = model.toLowerCase();
  const matches = listKnownModels()
    .filter((descriptor) => isBuiltinProviderId(descriptor.provider) && descriptor.model.toLowerCase() === normalized)
    .map((descriptor) => ({ provider: descriptor.provider as HostProviderName, model: descriptor.model }));
  return matches.length === 1 ? matches[0] : undefined;
}

function splitReasoningSuffix(value: string): { model: string; reasoningLevel?: HostReasoningLevel } {
  const trimmed = value.trim();
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex === -1) return { model: trimmed };
  const suffix = trimmed.slice(colonIndex + 1);
  if (!isReasoningLevel(suffix)) return { model: trimmed };
  const model = trimmed.slice(0, colonIndex).trim();
  if (!model) throw new Error(`Model reference ${value} is missing a model before the thinking suffix`);
  return { model, reasoningLevel: suffix };
}

function isReasoningLevel(value: string): value is HostReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

interface HostProviderRouterOptions {
  defaultSelection: Extract<ResolvedHostModelSelection, { kind: "provider" }>;
  defaultReasoningLevel?: HostReasoningLevel;
  defaultServiceTier?: ServiceTier;
  baseOptions: ProviderModelOptions;
  profileId?: string;
}

class HostProviderRouter implements ModelRouter {
  constructor(private readonly options: HostProviderRouterOptions) {}

  async listModels(): Promise<readonly RuntimeModelDescriptor[]> {
    const catalog = await listModelCatalogFromStorage(
      undefined,
      this.options.baseOptions.authStorage ?? new FileAuthStorage(),
      this.options.baseOptions.env ? { env: this.options.baseOptions.env } : {},
    );
    return catalog.filter((model) => isBuiltinProviderId(model.provider)).map((model) => {
      const endpoint = safeEndpointOrigin(model.endpoint);
      const connectionLabel = isBuiltinProviderId(model.provider) ? BUILTIN_PROVIDERS[model.provider].connectionLabel : undefined;
      return {
        provider: model.provider,
        model: model.model,
        ...(model.displayName ? { displayName: model.displayName } : {}),
        ...(model.providerDisplayName ? { providerDisplayName: model.providerDisplayName } : {}),
        ...(connectionLabel ? { connectionLabel } : {}),
        authSource: model.authSource,
        ...(endpoint ? { endpoint } : {}),
        available: model.available,
        ...(model.capabilities ? { capabilities: { ...model.capabilities } } : {}),
        ...(model.inputCapabilities ? { inputCapabilities: [...model.inputCapabilities] } : {}),
        ...(model.contextWindowTokens !== undefined ? { contextWindowTokens: model.contextWindowTokens } : {}),
        ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
        reasoningLevels: [...getModelSelectionAvailableReasoningLevels(model)],
        ...(model.serviceTiers ? { serviceTiers: [...model.serviceTiers] } : {}),
        ...(model.default !== undefined ? { default: model.default } : {}),
      };
    });
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    const extended = input as ExtendedModelStreamInput;
    const selection = this.selectionForInput(extended);
    if (selection.kind === "fake") {
      yield* new FakeModelRouter().stream(input);
      return;
    }
    const reasoningLevel = reasoningLevelForInput(extended, this.options.defaultReasoningLevel);
    const serviceTier = serviceTierForInput(extended, this.options.defaultServiceTier);
    const providerOptions = this.optionsForProvider(selection, reasoningLevel, serviceTier);
    const model = createRegisteredProviderModel(selection.provider, providerOptions);
    yield* new ProviderModelRouterAdapter(model, this.options.profileId).stream(input);
  }

  resolveRequestLimits(input: ModelRequestLimitsInput): ModelRequestLimits | undefined {
    const extended = input as ExtendedModelStreamInput;
    const selection = this.selectionForInput(extended);
    if (selection.kind === "fake") return undefined;
    const reasoningLevel = reasoningLevelForInput(extended, this.options.defaultReasoningLevel);
    const serviceTier = serviceTierForInput(extended, this.options.defaultServiceTier);
    return requestLimitsForProvider(
      selection.provider,
      this.optionsForProvider(selection, reasoningLevel, serviceTier),
    );
  }

  private selectionForInput(input: ExtendedModelStreamInput): ResolvedHostModelSelection {
    const override = modelSelectionForInput(input);
    if (!override) return this.options.defaultSelection;
    return resolveHostModelSelection(override.provider, override.model);
  }

  private optionsForProvider(
    selection: Extract<ResolvedHostModelSelection, { kind: "provider" }>,
    reasoningLevel: HostReasoningLevel | undefined,
    serviceTier: ServiceTier | undefined,
  ): ResolvedProviderModelOptions {
    return resolveProviderModelOptions(selection.provider, {
      ...scopeProviderModelOptions(this.options.baseOptions, this.options.defaultSelection.provider, selection.provider),
      ...(selection.model ? { model: selection.model } : {}),
    }, {
      ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
    });
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
  defaultReasoningLevel: HostReasoningLevel | undefined,
): HostReasoningLevel | undefined {
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

function requestLimitsForProvider(
  provider: HostProviderName,
  options: ProviderModelOptions,
): ModelRequestLimits | undefined {
  const descriptor = options.model ? findKnownModel(provider, options.model) : undefined;
  const limits: ModelRequestLimits = {};
  if (descriptor?.contextWindowTokens !== undefined) {
    limits.contextWindowTokens = descriptor.contextWindowTokens;
  }
  if (options.maxTokens !== undefined) {
    limits.requestMaxOutputTokens = options.maxTokens;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeEndpointOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") return undefined;
    return endpoint.origin;
  } catch {
    return undefined;
  }
}

class ProviderModelRouterAdapter implements ModelRouter {
  constructor(private readonly model: ChiliModel, private readonly profileId?: string) {}

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    for await (const event of this.model.stream(toProviderInput(input, this.profileId))) {
      yield enrichMetadata(event);
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

function toProviderInput(input: ModelStreamInput, profileId?: string): ProviderModelStreamInput {
  const extended = input as ExtendedModelStreamInput;
  const providerInput: ProviderModelStreamInput = {
    messages: input.messages,
    tools: input.tools,
    system: input.system,
    metadata: {
      sessionId: input.sessionId,
      turnId: input.turnId,
    },
  };
  if (input.developer !== undefined) providerInput.developer = input.developer;
  if (input.contextualUser !== undefined) providerInput.contextualUser = input.contextualUser;
  if (input.signal) providerInput.signal = input.signal;
  if (input.requestTimeoutMs !== undefined) providerInput.requestTimeoutMs = input.requestTimeoutMs;
  if (input.onRequestIdentity) {
    const onRequestIdentity = input.onRequestIdentity;
    providerInput.onRequestIdentity = async (identity) => {
      // Explicitly copy the audit fields; provider internals must never persist credentials.
      await onRequestIdentity({
        provider: identity.provider,
        model: identity.model,
        ...(identity.accountId !== undefined ? { accountId: identity.accountId } : {}),
        ...(identity.credentialVersion !== undefined ? { credentialVersion: identity.credentialVersion } : {}),
        ...(profileId !== undefined ? { profileId } : {}),
      });
    };
  }
  if (input.serviceTier !== undefined) providerInput.serviceTier = input.serviceTier;
  if (extended.maxTokens !== undefined) providerInput.maxTokens = extended.maxTokens;
  if (extended.temperature !== undefined) providerInput.temperature = extended.temperature;
  return providerInput;
}
