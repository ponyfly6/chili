import type { ModelCost, ModelDescriptor } from "../../types.js";

export const OPENAI_PROVIDER_ID = "openai";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_DEFAULT_MODEL = "gpt-6.1-sol";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const OPENAI_CODEX_DEFAULT_MODEL = "gpt-6.1-sol";
export const OPENAI_CODEX_MODELS = [
  OPENAI_CODEX_DEFAULT_MODEL,
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
export const OPENAI_CODEX_MODEL_ALIASES = ["gpt-5.6"] as const;
export type OpenAICodexCanonicalModel = (typeof OPENAI_CODEX_MODELS)[number];
export type OpenAICodexModelAlias = (typeof OPENAI_CODEX_MODEL_ALIASES)[number];
export type OpenAICodexModel = OpenAICodexCanonicalModel | OpenAICodexModelAlias;
export const CODEX_API_PROVIDER_ID = "codex-api";
export const CODEX_API_DEFAULT_MODEL = OPENAI_CODEX_DEFAULT_MODEL;
export const CODEX_API_MODELS = [...OPENAI_CODEX_MODELS] as const;
export type CodexApiCanonicalModel = (typeof CODEX_API_MODELS)[number];
export type CodexApiModel = CodexApiCanonicalModel | OpenAICodexModelAlias;

export function isOpenAICodexModel(model: string): model is OpenAICodexModel {
  return (OPENAI_CODEX_MODELS as readonly string[]).includes(model)
    || (OPENAI_CODEX_MODEL_ALIASES as readonly string[]).includes(model);
}

export function assertOpenAICodexModel(model: string): asserts model is OpenAICodexModel {
  if (isOpenAICodexModel(model)) return;
  throw new Error(
    `Unsupported OpenAI Codex model "${model}". Supported models: ${[
      ...OPENAI_CODEX_MODELS,
      ...OPENAI_CODEX_MODEL_ALIASES,
    ].join(", ")}`,
  );
}

export function isCodexApiModel(model: string): model is CodexApiModel {
  return (CODEX_API_MODELS as readonly string[]).includes(model)
    || (OPENAI_CODEX_MODEL_ALIASES as readonly string[]).includes(model);
}

export function assertCodexApiModel(model: string): asserts model is CodexApiModel {
  if (isCodexApiModel(model)) return;
  throw new Error(
    `Unsupported Codex API model "${model}". Supported models: ${[
      ...CODEX_API_MODELS,
      ...OPENAI_CODEX_MODEL_ALIASES,
    ].join(", ")}`,
  );
}

export function canonicalizeOpenAICodexModel(model: string): OpenAICodexCanonicalModel {
  assertOpenAICodexModel(model);
  return model === "gpt-5.6" ? "gpt-5.6-sol" : model;
}

export function canonicalizeCodexApiModel(model: string): CodexApiCanonicalModel {
  assertCodexApiModel(model);
  return model === "gpt-5.6" ? "gpt-5.6-sol" : model;
}

export const OPENAI_MODELS = [...OPENAI_CODEX_MODELS] as const;
export type OpenAIModel = (typeof OPENAI_MODELS)[number] | OpenAICodexModelAlias;

export function canonicalizeOpenAIModel(model: string): OpenAICodexCanonicalModel {
  if (isOpenAICodexModel(model)) return canonicalizeOpenAICodexModel(model);
  throw new Error(`Unsupported OpenAI model "${model}". Supported models: ${[...OPENAI_MODELS, ...OPENAI_CODEX_MODEL_ALIASES].join(", ")}`);
}

const OPENAI_CODEX_MODEL_COSTS = {
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
} satisfies Record<(typeof OPENAI_CODEX_MODELS)[number], ModelCost>;

export const OPENAI_MODEL_DESCRIPTORS = [
  ...OPENAI_MODELS.map((model) => codexModelDescriptor(OPENAI_PROVIDER_ID, model, OPENAI_BASE_URL)),
  ...OPENAI_CODEX_MODELS.map((model) => codexModelDescriptor(OPENAI_CODEX_PROVIDER_ID, model, OPENAI_CODEX_BASE_URL)),
  ...CODEX_API_MODELS.map((model) => codexModelDescriptor(CODEX_API_PROVIDER_ID, model)),
] satisfies readonly ModelDescriptor[];

function openAICodexDisplayName(model: string): string {
  const match = /^gpt-(\d+(?:\.\d+)?)(?:-(.*))?$/.exec(model);
  if (!match) return model;
  const suffix = match[2]
    ?.split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return suffix ? `GPT-${match[1]} ${suffix}` : `GPT-${match[1]}`;
}

function codexModelDescriptor(
  provider: typeof OPENAI_CODEX_PROVIDER_ID | typeof CODEX_API_PROVIDER_ID | typeof OPENAI_PROVIDER_ID,
  model: (typeof OPENAI_CODEX_MODELS)[number],
  baseUrl?: string,
): ModelDescriptor {
  const reasoningLevels = model === "gpt-6.1-sol" || model === "gpt-6-astra"
    ? ["low", "medium", "high", "xhigh", "max", "ultra"] as const
    : model.endsWith("-luna")
      ? ["off", "low", "medium", "high", "xhigh", "max"] as const
      : ["off", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
  return {
    provider,
    model,
    displayName: openAICodexDisplayName(model),
    apiFamily: "openai-responses",
    ...(baseUrl ? { baseUrl } : {}),
    default: model === OPENAI_CODEX_DEFAULT_MODEL,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
    reasoningLevels,
    serviceTiers: ["standard", "fast"],
    cost: OPENAI_CODEX_MODEL_COSTS[model],
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
      usage: true,
      responseId: true,
    },
  };
}
