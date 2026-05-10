import {
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID,
  listKnownModels,
} from "@chili/providers";

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
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
  available?: boolean;
  capabilities?: {
    reasoning?: boolean;
  };
  inputCapabilities?: readonly string[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
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
  return candidate?.capabilities?.reasoning ?? true;
}

export function findExactModelSelection(
  reference: string,
  candidates: readonly ModelCandidate[],
): ModelSelection | undefined {
  const normalized = reference.trim().toLowerCase();
  if (!normalized) return undefined;

  const canonical = candidates.filter((model) => `${model.provider}/${model.model}`.toLowerCase() === normalized);
  if (canonical.length === 1) return modelDescriptorSelection(canonical[0]!);
  if (canonical.length > 1) return undefined;

  const slashIndex = normalized.indexOf("/");
  if (slashIndex !== -1) {
    const provider = normalized.slice(0, slashIndex);
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
  const filtered = normalized
    ? candidates.filter((candidate) => fuzzyMatch(modelSearchText(candidate), normalized))
    : candidates;
  return sortModelCandidates(filtered, current);
}

function sortModelCandidates(candidates: readonly ModelCandidate[], current: ModelSelection | undefined): ModelCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftCurrent = sameModelSelection(current, modelDescriptorSelection(left));
    const rightCurrent = sameModelSelection(current, modelDescriptorSelection(right));
    if (leftCurrent && !rightCurrent) return -1;
    if (!leftCurrent && rightCurrent) return 1;
    if (left.provider !== right.provider) return left.provider.localeCompare(right.provider);
    if (left.default && !right.default) return -1;
    if (!left.default && right.default) return 1;
    return left.model.localeCompare(right.model);
  });
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
  const provider = reference.trim().toLowerCase();
  if (!provider) return undefined;
  const providerCandidates = candidates.filter((candidate) => candidate.provider.toLowerCase() === provider);
  if (providerCandidates.length === 0) return undefined;
  const selected = providerCandidates.find((candidate) => candidate.default) ?? providerCandidates[0];
  return selected ? modelDescriptorSelection(selected) : undefined;
}

function modelSearchText(candidate: ModelCandidate): string {
  return [
    candidate.model,
    candidate.provider,
    `${candidate.provider}/${candidate.model}`,
    candidate.displayName,
  ].filter(Boolean).join(" ").toLowerCase();
}

function fuzzyMatch(value: string, query: string): boolean {
  if (value.includes(query)) return true;
  let index = 0;
  for (const char of query) {
    index = value.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}
