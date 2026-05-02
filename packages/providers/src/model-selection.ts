import type { ModelDescriptor, ModelSelection, ReasoningLevel, ThinkingLevel } from "./types.js";
import { REASONING_LEVELS } from "./types.js";

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
const REASONING_LEVELS_WITHOUT_XHIGH: readonly ReasoningLevel[] = ["off", "minimal", "low", "medium", "high"];

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
  const trimmed = pattern.trim();
  if (!trimmed) return {};

  const matched = tryMatchModel(trimmed, models, options.allowFuzzy ?? true);
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
  const clamped = clampReasoningLevel(parsed.reasoning ?? "off", ["off", "minimal", "low", "medium", "high", "xhigh"]);
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

export function getModelSelectionAvailableReasoningLevels(model: ModelDescriptor | undefined): readonly ReasoningLevel[] {
  if (model && model.capabilities?.reasoning === false) return ["off"];
  return supportsXHighReasoning(model) ? REASONING_LEVELS : REASONING_LEVELS_WITHOUT_XHIGH;
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
    id.includes("gpt-5.2") ||
    id.includes("gpt-5.3") ||
    id.includes("gpt-5.4") ||
    id.includes("gpt-5.5") ||
    id.includes("deepseek-v4-pro") ||
    id.includes("deepseek-v4-flash") ||
    id.includes("opus-4-6") ||
    id.includes("opus-4.6") ||
    id.includes("opus-4-7") ||
    id.includes("opus-4.7")
  );
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
): ModelDescriptor | undefined {
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
  const candidates = aliases.length > 0 ? aliases : matches;
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
  if (model.cost) clone.cost = { ...model.cost };
  return clone;
}
