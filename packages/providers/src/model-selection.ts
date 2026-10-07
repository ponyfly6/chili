import type { ModelDescriptor, ModelSelection, ReasoningLevel, ThinkingLevel } from "./types.js";
import { REASONING_LEVELS } from "./types.js";
import {
  CODEX_API_PROVIDER_ID,
  canonicalizeOpenAICodexModel,
  findKnownModel,
  isOpenAICodexModel,
  OPENAI_CODEX_PROVIDER_ID,
} from "./models.js";

export interface ParsedModelSelectionPattern {
  provider?: string;
  model: string;
  reasoning?: ReasoningLevel;
  thinking?: ThinkingLevel;
}

export interface ModelSelectionPatternResult {
  selection?: ModelSelection;
  descriptor?: ModelDescriptor;
  warning?: string;
}

export interface ResolveModelSelectionPatternOptions {
  defaultProvider?: string;
  allowFuzzy?: boolean;
  allowCustomModel?: boolean;
  allowInvalidReasoningLevelFallback?: boolean;
}

const REASONING_LEVEL_SET = new Set<string>(REASONING_LEVELS);
const REASONING_LEVEL_ORDER: readonly ReasoningLevel[] = REASONING_LEVELS;
const REASONING_LEVELS_THROUGH_HIGH: readonly ReasoningLevel[] = ["off", "minimal", "low", "medium", "high"];
const REASONING_LEVELS_THROUGH_XHIGH: readonly ReasoningLevel[] = [...REASONING_LEVELS_THROUGH_HIGH, "xhigh"];
const REASONING_LEVELS_THROUGH_MAX: readonly ReasoningLevel[] = [...REASONING_LEVELS_THROUGH_XHIGH, "max"];

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return REASONING_LEVEL_SET.has(value);
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return isReasoningLevel(value);
}

export function normalizeReasoningLevel(value: unknown): ReasoningLevel | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isReasoningLevel(normalized) ? normalized : undefined;
}

export function parseModelSelectionPattern(pattern: string): ParsedModelSelectionPattern | undefined {
  const trimmed = pattern.trim();
  if (!trimmed) return undefined;

  const { modelPattern, reasoning } = splitReasoningSuffix(trimmed);
  const slashIndex = modelPattern.indexOf("/");
  const parsed: ParsedModelSelectionPattern =
    slashIndex > 0 && slashIndex < modelPattern.length - 1
      ? {
          provider: modelPattern.slice(0, slashIndex).trim(),
          model: modelPattern.slice(slashIndex + 1).trim(),
        }
      : { model: modelPattern };

  if (!parsed.model) return undefined;
  if (reasoning) {
    parsed.reasoning = reasoning;
    parsed.thinking = reasoning;
  }
  return parsed;
}

export function resolveModelSelectionPattern(
  pattern: string,
  models: readonly ModelDescriptor[],
  options: ResolveModelSelectionPatternOptions = {},
): ModelSelectionPatternResult {
  const input = pattern.trim();
  if (!input) return {};
  const trimmed = canonicalizeOfficialModelAlias(input, options.defaultProvider);

  const matched = tryMatchModel(trimmed, models, options.allowFuzzy ?? true, options.defaultProvider);
  if (matched) {
    return {
      descriptor: cloneDescriptor(matched),
      selection: {
        provider: matched.provider,
        model: matched.model,
      },
    };
  }

  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex !== -1) {
    const prefix = trimmed.slice(0, colonIndex);
    const suffix = trimmed.slice(colonIndex + 1).trim().toLowerCase();
    const reasoning = normalizeReasoningLevel(suffix);

    if (reasoning) {
      const resolved = resolveModelSelectionPattern(prefix, models, options);
      if (!resolved.selection) return resolved;
      const clamped = resolved.descriptor ? clampModelReasoningLevel(resolved.descriptor, reasoning) : reasoning;
      return {
        ...resolved,
        selection: {
          ...resolved.selection,
          reasoning: clamped,
          thinking: clamped,
        },
      };
    }

    if (options.allowInvalidReasoningLevelFallback ?? true) {
      const resolved = resolveModelSelectionPattern(prefix, models, options);
      if (resolved.selection) {
        return {
          ...resolved,
          warning: `Invalid reasoning level "${suffix}" in pattern "${trimmed}". Using default instead.`,
        };
      }
    }
  }

  const parsed = parseModelSelectionPattern(trimmed);
  if (!parsed) return {};
  const provider = parsed.provider ?? options.defaultProvider;
  if (!provider) return {};

  const providerModels = models.filter((model) => equalsIgnoreCase(model.provider, provider));
  if (providerModels.length === 0 || !options.allowCustomModel) return {};

  const canonicalProvider = providerModels[0]?.provider ?? provider;
  const clamped = clampModelReasoningLevel(parsed.model, parsed.reasoning ?? "off");
  const selection: ModelSelection = {
    provider: canonicalProvider,
    model: parsed.model,
  };
  if (parsed.reasoning) {
    selection.reasoning = clamped;
    selection.thinking = clamped;
  }
  return {
    selection,
    warning: `Model "${parsed.model}" not found for provider "${canonicalProvider}". Using custom model id.`,
  };
}

function canonicalizeOfficialModelAlias(pattern: string, defaultProvider: string | undefined): string {
  const match = /^(?:(openai-codex|codex-api|openai)\/)?gpt-5\.6(.*)$/i.exec(pattern);
  if (!match) return pattern;
  const suffix = match[2] ?? "";
  if (suffix && !suffix.startsWith(":")) return pattern;

  const explicitProvider = match[1]?.toLowerCase();
  const provider = explicitProvider
    ?? (defaultProvider === OPENAI_CODEX_PROVIDER_ID || defaultProvider === CODEX_API_PROVIDER_ID || defaultProvider === "openai"
      ? defaultProvider
      : undefined);
  if (!provider) return pattern;
  return `${provider}/${canonicalizeOpenAICodexModel("gpt-5.6")}${suffix}`;
}

export function getModelSelectionAvailableReasoningLevels(model: ModelDescriptor | undefined): readonly ReasoningLevel[] {
  if (model && model.capabilities?.reasoning === false) return [];
  if (model?.reasoningLevels !== undefined) return model.reasoningLevels;
  if (model && isOpenAICodexModel(model.model)) {
    const known = findKnownModel(OPENAI_CODEX_PROVIDER_ID, canonicalizeOpenAICodexModel(model.model));
    if (known?.reasoningLevels) return known.reasoningLevels;
  }
  if (supportsUltraReasoning(model)) return REASONING_LEVELS;
  if (supportsMaxReasoning(model)) return REASONING_LEVELS_THROUGH_MAX;
  return supportsXHighReasoning(model) ? REASONING_LEVELS_THROUGH_XHIGH : REASONING_LEVELS_THROUGH_HIGH;
}

export function clampModelReasoningLevel(model: ModelDescriptor | string | undefined, level: ReasoningLevel): ReasoningLevel {
  return clampReasoningLevel(level, getModelSelectionAvailableReasoningLevels(typeof model === "string" ? { provider: "", model } : model));
}

export function clampReasoningLevel(level: ReasoningLevel, availableLevels: readonly ReasoningLevel[]): ReasoningLevel {
  if (availableLevels.includes(level)) return level;
  const available = new Set(availableLevels);
  const requestedIndex = REASONING_LEVEL_ORDER.indexOf(level);
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = REASONING_LEVEL_ORDER[index];
    if (candidate && available.has(candidate)) return candidate;
  }
  for (let index = requestedIndex + 1; index < REASONING_LEVEL_ORDER.length; index += 1) {
    const candidate = REASONING_LEVEL_ORDER[index];
    if (candidate && available.has(candidate)) return candidate;
  }
  return availableLevels[0] ?? "off";
}

export function supportsXHighReasoning(model: ModelDescriptor | string | undefined): boolean {
  const modelId = typeof model === "string" ? model : model?.model;
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return (
    id.includes("gpt-5.6") ||
    /^gpt-6(?:\.1)?-/.test(id) ||
    id.includes("grok-4.6") ||
    id.includes("grok-4.7") ||
    id.includes("minimax-m3.1-flash-preview") ||
    id.includes("opus-4-6") ||
    id.includes("opus-4.6") ||
    id.includes("opus-4-7") ||
    id.includes("opus-4.7")
  );
}

export function supportsMaxReasoning(model: ModelDescriptor | string | undefined): boolean {
  const modelId = typeof model === "string" ? model : model?.model;
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return id.includes("gpt-5.6")
    || /^gpt-6(?:\.1)?-/.test(id)
    || id.includes("deepseek-v4-")
    || id === "deepseek-flash"
    || id.includes("minimax-m3.1-flash-preview")
    || id.includes("kimi-k3")
    || id.includes("glm-5.3");
}

export function supportsUltraReasoning(model: ModelDescriptor | string | undefined): boolean {
  const modelId = typeof model === "string" ? model : model?.model;
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return (id.includes("gpt-5.6") || /^gpt-6(?:\.1)?-/.test(id)) && !id.endsWith("-luna");
}

export function formatModelSelection(selection: Pick<ModelSelection, "provider" | "model" | "reasoning">): string {
  return `${selection.provider}/${selection.model}${selection.reasoning ? `:${selection.reasoning}` : ""}`;
}

function splitReasoningSuffix(pattern: string): { modelPattern: string; reasoning?: ReasoningLevel } {
  const colonIndex = pattern.lastIndexOf(":");
  if (colonIndex === -1) return { modelPattern: pattern };
  const suffix = normalizeReasoningLevel(pattern.slice(colonIndex + 1));
  if (!suffix) return { modelPattern: pattern };
  return {
    modelPattern: pattern.slice(0, colonIndex),
    reasoning: suffix,
  };
}

function tryMatchModel(
  modelPattern: string,
  models: readonly ModelDescriptor[],
  allowFuzzy: boolean,
  defaultProvider?: string,
): ModelDescriptor | undefined {
  if (!modelPattern.includes("/")) {
    const normalized = modelPattern.trim().toLowerCase();
    const bareMatches = models.filter((model) => model.model.toLowerCase() === normalized);
    if (bareMatches.length > 1) {
      if (!defaultProvider) return undefined;
      const providerMatches = bareMatches.filter((model) => equalsIgnoreCase(model.provider, defaultProvider));
      return providerMatches.length === 1 ? providerMatches[0] : undefined;
    }
  }
  const exact = findExactModelReferenceMatch(modelPattern, models);
  if (exact || !allowFuzzy) return exact;

  const normalized = modelPattern.toLowerCase();
  const matches = models.filter((model) => {
    return (
      model.model.toLowerCase().includes(normalized) ||
      model.displayName?.toLowerCase().includes(normalized) === true
    );
  });
  if (matches.length === 0) return undefined;

  const aliases = matches.filter((model) => isAlias(model.model));
  let candidates = aliases.length > 0 ? aliases : matches;
  if (!modelPattern.includes("/")) {
    const matchingProviders = new Set(candidates.map((model) => model.provider.toLowerCase()));
    if (matchingProviders.size > 1) {
      if (!defaultProvider) return undefined;
      candidates = candidates.filter((model) => equalsIgnoreCase(model.provider, defaultProvider));
      if (candidates.length === 0) return undefined;
    }
  }
  return candidates.slice().sort((a, b) => b.model.localeCompare(a.model))[0];
}

function findExactModelReferenceMatch(
  modelReference: string,
  models: readonly ModelDescriptor[],
): ModelDescriptor | undefined {
  const normalized = modelReference.trim().toLowerCase();
  if (!normalized) return undefined;

  const canonicalMatches = models.filter((model) => `${model.provider}/${model.model}`.toLowerCase() === normalized);
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;

  const slashIndex = modelReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = modelReference.slice(0, slashIndex).trim();
    const modelId = modelReference.slice(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = models.filter(
        (model) => equalsIgnoreCase(model.provider, provider) && equalsIgnoreCase(model.model, modelId),
      );
      if (providerMatches.length === 1) return providerMatches[0];
      if (providerMatches.length > 1) return undefined;
    }
  }

  const idMatches = models.filter((model) => model.model.toLowerCase() === normalized);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function isAlias(id: string): boolean {
  if (id.endsWith("-latest")) return true;
  return !/-\d{8}$/.test(id);
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function cloneDescriptor(model: ModelDescriptor): ModelDescriptor {
  const clone: ModelDescriptor = { ...model };
  if (model.capabilities) clone.capabilities = { ...model.capabilities };
  if (model.compatibility) clone.compatibility = { ...model.compatibility };
  if (model.inputCapabilities) clone.inputCapabilities = [...model.inputCapabilities];
  if (model.reasoningLevels) clone.reasoningLevels = [...model.reasoningLevels];
  if (model.serviceTiers) clone.serviceTiers = [...model.serviceTiers];
  if (model.cost) clone.cost = { ...model.cost };
  return clone;
}
