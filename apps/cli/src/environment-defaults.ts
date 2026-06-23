import type { ServiceTier } from "@chili/protocol";
import type { CliReasoningLevel } from "./model.js";

export function cliEnvironmentDefaults(
  env: NodeJS.ProcessEnv,
): { provider?: string; model?: string; reasoningLevel?: CliReasoningLevel; serviceTier?: ServiceTier } {
  const defaults: { provider?: string; model?: string; reasoningLevel?: CliReasoningLevel; serviceTier?: ServiceTier } = {};
  const provider = firstEnv(env, "CHILI_PROVIDER", "CHILI_DEFAULT_PROVIDER");
  const model = firstEnv(env, "CHILI_MODEL", "CHILI_DEFAULT_MODEL");
  const reasoningLevel = firstEnv(env, "CHILI_REASONING_LEVEL", "CHILI_DEFAULT_REASONING_LEVEL", "OPENAI_CODEX_REASONING_EFFORT");
  const serviceTier = firstEnv(env, "CHILI_SERVICE_TIER", "CHILI_DEFAULT_SERVICE_TIER", "OPENAI_CODEX_SERVICE_TIER");
  if (provider !== undefined) defaults.provider = provider;
  if (model !== undefined) defaults.model = model;
  if (reasoningLevel !== undefined) defaults.reasoningLevel = parseEnvironmentReasoningLevel(reasoningLevel);
  if (serviceTier !== undefined) defaults.serviceTier = parseEnvironmentServiceTier(serviceTier);
  return defaults;
}

function firstEnv(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseEnvironmentReasoningLevel(value: string): CliReasoningLevel {
  if (
    value === "off"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
  ) {
    return value;
  }
  throw new Error("CHILI_REASONING_LEVEL must be off, minimal, low, medium, high, or xhigh");
}

function parseEnvironmentServiceTier(value: string): ServiceTier {
  if (value === "fast" || value === "standard") return value;
  throw new Error("CHILI_SERVICE_TIER must be standard or fast");
}
