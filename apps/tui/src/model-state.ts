import {
  CODEX_API_PROVIDER_ID,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID,
  listKnownModels,
} from "@chili/providers";
import type { RuntimeModelAuthSource, RuntimeModelCapabilities, ServiceTier } from "@chili/protocol";

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const DEFAULT_REASONING_LEVEL: ReasoningLevel = "medium";

export interface ModelSelection {
  provider: string;
  model: string;
}

export interface ModelCandidate {
  provider: string;
  model: string;
  displayName?: string;
  providerDisplayName?: string;
  connectionLabel?: string;
  authSource?: RuntimeModelAuthSource;
  endpoint?: string;
  available?: boolean;
  capabilities?: RuntimeModelCapabilities;
  inputCapabilities?: readonly string[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  reasoningLevels?: readonly ReasoningLevel[];
  serviceTiers?: readonly ServiceTier[];
  default?: boolean;
}

export interface ModelCommandMatch {
  selection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  query?: string;
}

export function defaultModelCandidates(): readonly ModelCandidate[] {
  return [...listKnownModels()].sort((left, right) => {
    if (left.provider !== right.provider) return left.provider.localeCompare(right.provider);
    if (left.default && !right.default) return -1;
    if (!left.default && right.default) return 1;
    return left.model.localeCompare(right.model);
  });
}

export function defaultOpenAICodexSelection(): ModelSelection {
  return {
    provider: OPENAI_CODEX_PROVIDER_ID,
    model: OPENAI_CODEX_DEFAULT_MODEL,
  };
}

export function isReasoningLevel(value: string | undefined): value is ReasoningLevel {
  return Boolean(value && (REASONING_LEVELS as readonly string[]).includes(value));
}

export function modelSelectionLabel(selection: ModelSelection): string {
  return `${selection.provider}/${selection.model}`;
}

export function modelDescriptorSelection(model: ModelCandidate): ModelSelection {
  return { provider: model.provider, model: model.model };
}

export function sameModelSelection(left: ModelSelection | undefined, right: ModelSelection | undefined): boolean {
  return Boolean(left && right && left.provider === right.provider && left.model === right.model);
}

export function isValidModelSelection(
  selection: ModelSelection | undefined,
  candidates: readonly ModelCandidate[],
): selection is ModelSelection {
  if (!selection) return false;
  return candidates.some((candidate) => candidate.provider === selection.provider && candidate.model === selection.model);
}

export function modelSupportsReasoning(
  selection: ModelSelection | undefined,
  candidates: readonly ModelCandidate[],
): boolean {
  if (!selection) return true;
  const candidate = candidates.find((model) => model.provider === selection.provider && model.model === selection.model);
  if (candidate?.reasoningLevels !== undefined) {
    return candidate.reasoningLevels.some((level) => level !== "off");
  }
  return candidate?.capabilities?.reasoning ?? true;
}

export function modelSupportsServiceTier(
  selection: ModelSelection | undefined,
  candidates: readonly ModelCandidate[],
): boolean {
  if (!selection) return false;
  const candidate = candidates.find((model) => model.provider === selection.provider && model.model === selection.model);
  return candidate?.serviceTiers?.includes("fast") ?? false;
}

export function modelSupportsImages(
  selection: ModelSelection | undefined,
  candidates: readonly ModelCandidate[],
): boolean {
  if (!selection) return true;
  const candidate = candidates.find((model) => model.provider === selection.provider && model.model === selection.model);
  return candidate?.inputCapabilities?.includes("image") ?? true;
}

export function findExactModelSelection(
  reference: string,
  candidates: readonly ModelCandidate[],
): ModelSelection | undefined {
  const normalized = normalizeModelReferenceAlias(reference);
  if (!normalized) return undefined;

  const canonical = candidates.filter((model) => `${model.provider}/${model.model}`.toLowerCase() === normalized);
  if (canonical.length === 1) return modelDescriptorSelection(canonical[0]!);
  if (canonical.length > 1) return undefined;

  const slashIndex = normalized.indexOf("/");
  if (slashIndex !== -1) {
    const provider = normalizeProviderAlias(normalized.slice(0, slashIndex));
    const model = normalized.slice(slashIndex + 1);
    const providerMatches = candidates.filter(
      (candidate) => candidate.provider.toLowerCase() === provider && candidate.model.toLowerCase() === model,
    );
    if (providerMatches.length === 1) return modelDescriptorSelection(providerMatches[0]!);
    return undefined;
  }

  const bare = candidates.filter((model) => model.model.toLowerCase() === normalized);
  return bare.length === 1 ? modelDescriptorSelection(bare[0]!) : undefined;
}

export function parseModelCommand(
  args: string,
  candidates: readonly ModelCandidate[],
): ModelCommandMatch {
  const trimmed = args.trim();
  if (!trimmed) return {};

  const parsed = splitReasoningSuffix(trimmed);
  const selection = findExactModelSelection(parsed.reference, candidates);
  if (selection) {
    return {
      selection,
      ...(parsed.reasoningLevel ? { reasoningLevel: parsed.reasoningLevel } : {}),
    };
  }

  const providerDefault = findProviderDefaultSelection(parsed.reference, candidates);
  if (providerDefault) {
    return {
      selection: providerDefault,
      ...(parsed.reasoningLevel ? { reasoningLevel: parsed.reasoningLevel } : {}),
    };
  }

  return { query: trimmed };
}

export function filterModelCandidates(
  candidates: readonly ModelCandidate[],
  query: string,
  current: ModelSelection | undefined,
): ModelCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return sortModelCandidates(candidates, current);

  return candidates
    .map((candidate) => ({ candidate, score: modelSearchScore(candidate, normalized) }))
    .filter((entry): entry is { candidate: ModelCandidate; score: number } => entry.score !== undefined)
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      return compareModelCandidates(left.candidate, right.candidate, current);
    })
    .map((entry) => entry.candidate);
}

function sortModelCandidates(candidates: readonly ModelCandidate[], current: ModelSelection | undefined): ModelCandidate[] {
  return [...candidates].sort((left, right) => compareModelCandidates(left, right, current));
}

function compareModelCandidates(
  left: ModelCandidate,
  right: ModelCandidate,
  current: ModelSelection | undefined,
): number {
  const leftCurrentModel = current?.model === left.model;
  const rightCurrentModel = current?.model === right.model;
  if (leftCurrentModel && !rightCurrentModel) return -1;
  if (!leftCurrentModel && rightCurrentModel) return 1;

  const modelOrder = left.model.localeCompare(right.model, undefined, { numeric: true, sensitivity: "base" });
  if (modelOrder !== 0) return modelOrder;

  const leftCurrent = sameModelSelection(current, modelDescriptorSelection(left));
  const rightCurrent = sameModelSelection(current, modelDescriptorSelection(right));
  if (leftCurrent && !rightCurrent) return -1;
  if (!leftCurrent && rightCurrent) return 1;

  if (left.default && !right.default) return -1;
  if (!left.default && right.default) return 1;

  const providerOrder = modelProviderSortRank(left.provider) - modelProviderSortRank(right.provider);
  if (providerOrder !== 0) return providerOrder;
  return left.provider.localeCompare(right.provider);
}

function splitReasoningSuffix(value: string): { reference: string; reasoningLevel?: ReasoningLevel } {
  const index = value.lastIndexOf(":");
  if (index <= 0) return { reference: value };

  const suffix = value.slice(index + 1).toLowerCase();
  if (!isReasoningLevel(suffix)) return { reference: value };

  return {
    reference: value.slice(0, index).trim(),
    reasoningLevel: suffix,
  };
}

function findProviderDefaultSelection(
  reference: string,
  candidates: readonly ModelCandidate[],
): ModelSelection | undefined {
  const provider = normalizeProviderAlias(reference.trim().toLowerCase());
  if (!provider) return undefined;
  const providerCandidates = candidates.filter((candidate) => candidate.provider.toLowerCase() === provider);
  if (providerCandidates.length === 0) return undefined;
  const selected = providerCandidates.find((candidate) => candidate.default) ?? providerCandidates[0];
  return selected ? modelDescriptorSelection(selected) : undefined;
}

function normalizeModelReferenceAlias(reference: string): string {
  const normalized = reference.trim().toLowerCase();
  if (normalized === "gpt-5.6") return "gpt-5.6-sol";
  const slashIndex = normalized.indexOf("/");
  if (slashIndex === -1) return normalized;
  const provider = normalizeProviderAlias(normalized.slice(0, slashIndex));
  const model = normalized.slice(slashIndex + 1);
  const canonicalModel = model === "gpt-5.6" && (provider === "openai-codex" || provider === "codex-api")
    ? "gpt-5.6-sol"
    : model;
  return `${provider}/${canonicalModel}`;
}

function normalizeProviderAlias(provider: string): string {
  if (provider === "grok" || provider === "x.ai") return "xai";
  if (provider === "codex") return "openai-codex";
  return provider;
}

function modelSearchScore(candidate: ModelCandidate, query: string): number | undefined {
  const model = candidate.model.toLowerCase();
  const canonical = `${candidate.provider}/${candidate.model}`.toLowerCase();
  const primaryFields = [model, candidate.displayName?.toLowerCase()].filter(
    (value): value is string => Boolean(value),
  );
  const sourceFields = [
    candidate.provider,
    candidate.providerDisplayName,
    candidate.connectionLabel,
  ].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  const auxiliaryFields = [
    candidate.authSource,
    safeEndpointHost(candidate.endpoint),
  ].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  const fields = [...primaryFields, canonical, ...sourceFields, ...auxiliaryFields];

  if (model === query || canonical === query) return 0;
  if (primaryFields.some((field) => field.startsWith(query))) return 10;
  if (primaryFields.some((field) => field.includes(query))) return 20;
  if (sourceFields.some((field) => field === query)) return 30;
  if (sourceFields.some((field) => field.startsWith(query))) return 40;
  if (sourceFields.some((field) => field.includes(query))) return 50;
  if (auxiliaryFields.some((field) => field.includes(query))) return 60;

  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => fields.some((field) => field.includes(token)))) return 70;

  const fuzzyScores = fields
    .map((field) => fuzzyFieldScore(field, query))
    .filter((score): score is number => score !== undefined);
  return fuzzyScores.length > 0 ? 100 + Math.min(...fuzzyScores) : undefined;
}

function fuzzyFieldScore(value: string, query: string): number | undefined {
  let valueIndex = 0;
  let firstMatch = -1;
  let gapCount = 0;
  for (const char of query) {
    const matchIndex = value.indexOf(char, valueIndex);
    if (matchIndex === -1) return undefined;
    if (firstMatch === -1) firstMatch = matchIndex;
    gapCount += matchIndex - valueIndex;
    valueIndex = matchIndex + 1;
  }
  return Math.max(0, firstMatch) + gapCount;
}

function modelProviderSortRank(provider: string): number {
  if (provider === OPENAI_CODEX_PROVIDER_ID) return 0;
  if (provider === CODEX_API_PROVIDER_ID) return 1;
  return 2;
}

export function safeEndpointHost(endpoint: string | undefined): string | undefined {
  const value = endpoint?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(hasUrlScheme(value) ? value : `https://${value}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.host || undefined;
  } catch {
    return undefined;
  }
}

export function modelAuthLabel(authSource: RuntimeModelAuthSource | undefined): string {
  if (authSource === "oauth") return "ChatGPT OAuth";
  if (authSource === "environment" || authSource === "api_key") return "API key";
  if (authSource === "none") return "not configured";
  return "unknown";
}

function hasUrlScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}
