import type { ModelDescriptor } from "./types.js";
import { ALIBABA_MODELS } from "./vendors/alibaba/models.js";
import { ANTHROPIC_MODELS } from "./vendors/anthropic/models.js";
import { DEEPSEEK_MODELS } from "./vendors/deepseek/models.js";
import { DOUBAO_MODELS } from "./vendors/doubao/models.js";
import { KIMI_MODELS } from "./vendors/kimi/models.js";
import { MINIMAX_MODELS } from "./vendors/minimax/models.js";
import { OPENAI_MODEL_DESCRIPTORS } from "./vendors/openai/models.js";
import { XAI_MODELS } from "./vendors/xai/models.js";
import { ZHIPU_MODELS } from "./vendors/zhipu/domestic-models.js";
import { ZAI_MODELS } from "./vendors/zhipu/models.js";

export * from "./vendors/zhipu/domestic-models.js";
export * from "./vendors/anthropic/models.js";
export * from "./vendors/doubao/models.js";
export * from "./vendors/alibaba/models.js";
export * from "./vendors/deepseek/models.js";
export * from "./vendors/kimi/models.js";
export * from "./vendors/zhipu/models.js";
export * from "./vendors/minimax/models.js";
export * from "./vendors/xai/models.js";
export * from "./vendors/openai/models.js";

const BUILTIN_MODELS = [
  ...DEEPSEEK_MODELS,
  ...KIMI_MODELS,
  ...ZAI_MODELS,
  ...MINIMAX_MODELS,
  ...XAI_MODELS,
  ...OPENAI_MODEL_DESCRIPTORS,
  ...ALIBABA_MODELS,
  ...DOUBAO_MODELS,
  ...ANTHROPIC_MODELS,
  ...ZHIPU_MODELS,
] satisfies readonly ModelDescriptor[];

const knownModels = new Map<string, Map<string, ModelDescriptor>>();

registerKnownModels(BUILTIN_MODELS);

export function registerKnownModels(models: readonly ModelDescriptor[]): void {
  for (const model of models) {
    const providerModels = knownModels.get(model.provider) ?? new Map<string, ModelDescriptor>();
    providerModels.set(model.model, cloneModelDescriptor(model));
    knownModels.set(model.provider, providerModels);
  }
}

export function listKnownModels(provider?: string): readonly ModelDescriptor[] {
  if (provider) {
    return Array.from(knownModels.get(provider)?.values() ?? [], cloneModelDescriptor);
  }
  return Array.from(knownModels.values()).flatMap((models) => Array.from(models.values(), cloneModelDescriptor));
}

export function findKnownModel(provider: string, model: string): ModelDescriptor | undefined {
  const descriptor = knownModels.get(provider)?.get(model);
  return descriptor ? cloneModelDescriptor(descriptor) : undefined;
}

export function findDefaultKnownModel(provider: string): ModelDescriptor | undefined {
  const providerModels = knownModels.get(provider);
  const descriptor = Array.from(providerModels?.values() ?? []).find((model) => model.default) ?? providerModels?.values().next().value;
  return descriptor ? cloneModelDescriptor(descriptor) : undefined;
}

function cloneModelDescriptor(model: ModelDescriptor): ModelDescriptor {
  const clone: ModelDescriptor = { ...model };
  if (model.capabilities) clone.capabilities = { ...model.capabilities };
  if (model.compatibility) {
    clone.compatibility = {
      ...(model.compatibility.messages
        ? { messages: { ...model.compatibility.messages } }
        : {}),
      ...(model.compatibility.chatCompletions
        ? {
            chatCompletions: {
              ...model.compatibility.chatCompletions,
              reasoningEffortMap: {
                ...model.compatibility.chatCompletions.reasoningEffortMap,
              },
            },
          }
        : {}),
      ...(model.compatibility.responses ? { responses: { ...model.compatibility.responses } } : {}),
    };
  }
  if (model.inputCapabilities) clone.inputCapabilities = [...model.inputCapabilities];
  if (model.reasoningLevels) clone.reasoningLevels = [...model.reasoningLevels];
  if (model.serviceTiers) clone.serviceTiers = [...model.serviceTiers];
  if (model.cost) clone.cost = { ...model.cost };
  return clone;
}
