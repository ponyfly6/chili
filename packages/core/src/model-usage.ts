import type { ModelUsage } from "@chili/protocol";

const modelUsageByError = new WeakMap<object, ModelUsage>();

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
    const currentValue = usageNumber(current, field);
    const nextValue = usageNumber(next, field);
    const value = finiteNonNegative(currentValue) + finiteNonNegative(nextValue);
    if (value > 0 || currentValue === 0 || nextValue === 0) {
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

  const currentRaw = usageProperty(current, "raw");
  const nextRaw = usageProperty(next, "raw");
  if (!current && nextRaw !== undefined) output.raw = nextRaw;
  if (!next && currentRaw !== undefined) output.raw = currentRaw;
  return hasNumericUsage || output.raw !== undefined ? output : undefined;
}

export function attachModelUsage(error: Error, usage: ModelUsage | undefined): Error {
  if (!usage) return error;
  const combined = addModelUsage(modelUsageByError.get(error), usage);
  if (combined) modelUsageByError.set(error, combined);
  return error;
}

export function takeModelUsage(error: unknown): ModelUsage | undefined {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return undefined;
  const usage = modelUsageByError.get(error);
  modelUsageByError.delete(error);
  return usage;
}

function usageTokenTotal(usage: ModelUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const totalTokens = usageNumber(usage, "totalTokens");
  if (isFiniteNonNegative(totalTokens)) return totalTokens;
  const fields = [
    usageNumber(usage, "inputTokens"),
    usageNumber(usage, "outputTokens"),
    usageNumber(usage, "cacheReadInputTokens"),
    usageNumber(usage, "cacheCreationInputTokens"),
  ];
  if (!fields.some(isFiniteNonNegative)) return undefined;
  return fields.reduce<number>((total, value) => total + finiteNonNegative(value), 0);
}

function usageNumber(usage: ModelUsage | undefined, key: keyof ModelUsage): number | undefined {
  const value = usageProperty(usage, key);
  return typeof value === "number" ? value : undefined;
}

function usageProperty(usage: ModelUsage | undefined, key: keyof ModelUsage): unknown {
  if (!usage) return undefined;
  try {
    return Reflect.get(usage, key);
  } catch {
    return undefined;
  }
}

function finiteNonNegative(value: number | undefined): number {
  return isFiniteNonNegative(value) ? value : 0;
}

function isFiniteNonNegative(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
