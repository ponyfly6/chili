import type { ModelUsage } from "@chili/protocol";

const MODEL_USAGE_ERROR = Symbol("chili.modelUsage");

interface ModelUsageError extends Error {
  [MODEL_USAGE_ERROR]?: ModelUsage;
}

export function addModelUsage(
  current: ModelUsage | undefined,
  next: ModelUsage | undefined,
): ModelUsage | undefined {
  if (!current && !next) return undefined;

  const output: ModelUsage = {};
  let hasNumericUsage = false;
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
  ] as const) {
    const value = finiteNonNegative(current?.[field]) + finiteNonNegative(next?.[field]);
    if (value > 0 || current?.[field] === 0 || next?.[field] === 0) {
      output[field] = value;
      hasNumericUsage = true;
    }
  }

  const currentTotal = usageTokenTotal(current);
  const nextTotal = usageTokenTotal(next);
  if (currentTotal !== undefined || nextTotal !== undefined) {
    output.totalTokens = (currentTotal ?? 0) + (nextTotal ?? 0);
    hasNumericUsage = true;
  }

  if (!current && next?.raw !== undefined) output.raw = next.raw;
  if (!next && current?.raw !== undefined) output.raw = current.raw;
  return hasNumericUsage || output.raw !== undefined ? output : undefined;
}

export function attachModelUsage(error: Error, usage: ModelUsage | undefined): Error {
  if (!usage) return error;
  const target = error as ModelUsageError;
  const combined = addModelUsage(target[MODEL_USAGE_ERROR], usage);
  if (combined) target[MODEL_USAGE_ERROR] = combined;
  return error;
}

export function takeModelUsage(error: Error): ModelUsage | undefined {
  const target = error as ModelUsageError;
  const usage = target[MODEL_USAGE_ERROR];
  delete target[MODEL_USAGE_ERROR];
  return usage;
}

function usageTokenTotal(usage: ModelUsage | undefined): number | undefined {
  if (!usage) return undefined;
  if (isFiniteNonNegative(usage.totalTokens)) return usage.totalTokens;
  const fields = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadInputTokens,
    usage.cacheCreationInputTokens,
  ];
  if (!fields.some(isFiniteNonNegative)) return undefined;
  return fields.reduce<number>((total, value) => total + finiteNonNegative(value), 0);
}

function finiteNonNegative(value: number | undefined): number {
  return isFiniteNonNegative(value) ? value : 0;
}

function isFiniteNonNegative(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
