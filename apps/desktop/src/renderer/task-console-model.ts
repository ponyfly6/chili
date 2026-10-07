import { REASONING_LEVELS } from "@chili/protocol";
import type {
  DelegationPolicy,
  ModelSelection,
  ReasoningLevel,
  RuntimeModelConfig,
  RuntimeModelDescriptor,
  RuntimePermissionProfileId,
  RuntimeSessionStatus,
  ServiceTier,
} from "@chili/protocol";
import type { RuntimeSessionSummary } from "@chili/sdk";

export type SessionListStatus = "active" | "archived";
export type ReasoningSelection = ReasoningLevel | "";
export type ServiceTierSelection = ServiceTier | "";

export interface NewTaskDraft {
  title: string;
  prompt: string;
  modelKey: string;
  reasoningLevel: ReasoningSelection;
  serviceTier: ServiceTierSelection;
  permissionProfile: RuntimePermissionProfileId;
  delegationPolicy: DelegationPolicy;
}

export interface NewTaskValidation {
  valid: boolean;
  errors: Partial<Record<"prompt" | "model" | "reasoningLevel" | "serviceTier", string>>;
}

export interface NewTaskSubmission {
  title?: string;
  prompt: string;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  permissionProfile: RuntimePermissionProfileId;
  delegationPolicy: DelegationPolicy;
}

export interface SessionModelSettingsDraft {
  modelKey: string;
  reasoningLevel: ReasoningSelection;
  serviceTier: ServiceTierSelection;
}

export interface SessionModelSettingsValidation {
  valid: boolean;
  errors: Partial<Record<"model" | "reasoningLevel" | "serviceTier", string>>;
}

export interface SessionModelSettingsMutations {
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
}

const DEFAULT_REASONING: ReasoningLevel = "high";
const DEFAULT_SERVICE_TIER: ServiceTier = "standard";

export function modelKey(selection: ModelSelection): string {
  return JSON.stringify([selection.provider, selection.model]);
}

export function modelFromKey(
  models: readonly RuntimeModelDescriptor[],
  key: string,
): RuntimeModelDescriptor | undefined {
  return models.find((model) => modelKey(model) === key);
}

export function createNewTaskDraft(models: readonly RuntimeModelDescriptor[] = []): NewTaskDraft {
  const selected = preferredModel(models);
  return {
    title: "",
    prompt: "",
    modelKey: selected ? modelKey(selected) : "",
    reasoningLevel: preferredReasoning(selected),
    serviceTier: preferredServiceTier(selected),
    permissionProfile: "auto-review",
    delegationPolicy: "proactive",
  };
}

export function reconcileNewTaskModel(
  draft: NewTaskDraft,
  models: readonly RuntimeModelDescriptor[],
  nextKey: string,
): NewTaskDraft {
  const selected = modelFromKey(models, nextKey);
  if (!selected) return { ...draft, modelKey: nextKey };
  return {
    ...draft,
    modelKey: nextKey,
    reasoningLevel: preferredReasoning(selected, draft.reasoningLevel),
    serviceTier: preferredServiceTier(selected, draft.serviceTier),
  };
}

export function hydrateNewTaskChoices(
  draft: NewTaskDraft,
  models: readonly RuntimeModelDescriptor[],
  permissionProfile: RuntimePermissionProfileId,
): NewTaskDraft {
  const defaults = createNewTaskDraft(models);
  const withModel = draft.modelKey && modelFromKey(models, draft.modelKey)
    ? reconcileNewTaskModel(draft, models, draft.modelKey)
    : {
        ...draft,
        modelKey: defaults.modelKey,
        reasoningLevel: defaults.reasoningLevel,
        serviceTier: defaults.serviceTier,
      };
  return { ...withModel, permissionProfile };
}

export function availableReasoningLevels(
  models: readonly RuntimeModelDescriptor[],
  key: string,
): readonly ReasoningLevel[] {
  const model = modelFromKey(models, key);
  return model ? reasoningLevelsForModel(model) : REASONING_LEVELS;
}

export function availableServiceTiers(
  models: readonly RuntimeModelDescriptor[],
  key: string,
): readonly ServiceTier[] {
  return modelFromKey(models, key)?.serviceTiers ?? [];
}

export function validateNewTaskDraft(
  draft: NewTaskDraft,
  models: readonly RuntimeModelDescriptor[],
): NewTaskValidation {
  const errors: NewTaskValidation["errors"] = {};
  if (!draft.prompt.trim()) errors.prompt = "Describe what Chili should accomplish.";
  const selectedModel = modelFromKey(models, draft.modelKey);
  if (models.length > 0 && (!selectedModel || selectedModel.available === false)) {
    errors.model = "Choose an available model.";
  }
  if (selectedModel && !isServiceTierSelectionValid(selectedModel, draft.serviceTier)) {
    errors.serviceTier = selectedModel.serviceTiers?.length
      ? "Choose a service tier supported by this model."
      : "This model uses its provider-default service tier.";
  }
  if (selectedModel && !isReasoningSelectionValid(selectedModel, draft.reasoningLevel, false)) {
    errors.reasoningLevel = reasoningLevelsForModel(selectedModel).length > 0
      ? "Choose a reasoning level supported by this model."
      : "This model uses provider-default reasoning.";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function newTaskSubmission(
  draft: NewTaskDraft,
  models: readonly RuntimeModelDescriptor[],
): NewTaskSubmission {
  const validation = validateNewTaskDraft(draft, models);
  if (!validation.valid) throw new TypeError(Object.values(validation.errors)[0] ?? "Invalid task configuration");
  const selected = modelFromKey(models, draft.modelKey);
  const submission: NewTaskSubmission = {
    prompt: draft.prompt.trim(),
    permissionProfile: draft.permissionProfile,
    delegationPolicy: draft.delegationPolicy,
  };
  if (draft.reasoningLevel) submission.reasoningLevel = draft.reasoningLevel;
  if (draft.serviceTier) submission.serviceTier = draft.serviceTier;
  const title = draft.title.trim();
  if (title) submission.title = title;
  if (selected) submission.modelSelection = { provider: selected.provider, model: selected.model };
  return submission;
}

export function filterSessions(
  sessions: readonly RuntimeSessionSummary[],
  query: string,
  status: SessionListStatus,
): RuntimeSessionSummary[] {
  const normalized = query.trim().toLocaleLowerCase();
  return sessions
    .filter((session) => session.status === status)
    .filter((session) => !normalized || searchableSessionText(session).includes(normalized))
    .sort((left, right) => right.updatedAt - left.updatedAt || String(left.id).localeCompare(String(right.id)));
}

export function canResumeTask(
  sessionStatus: RuntimeSessionStatus | "unknown" | undefined,
  readOnly: boolean,
  dispatchPaused = false,
): boolean {
  return dispatchPaused && !readOnly
    && sessionStatus !== "running"
    && sessionStatus !== "cancelling"
    && sessionStatus !== "waiting_for_approval";
}

export function isSessionReadOnly(
  session: Pick<RuntimeSessionSummary, "status"> | undefined,
): boolean {
  return session?.status === "archived";
}

export function canExposeTaskActions(session: Pick<RuntimeSessionSummary, "status">): boolean {
  return session.status === "active";
}

export function canReloadSessionMcp(
  sessionId: string | undefined,
  readOnly: boolean,
  actionsDisabled: boolean,
): boolean {
  return Boolean(sessionId) && !readOnly && !actionsDisabled;
}

function preferredModel(models: readonly RuntimeModelDescriptor[]): RuntimeModelDescriptor | undefined {
  return models.find((model) => model.default && model.available !== false)
    ?? models.find((model) => model.available !== false);
}

function preferredReasoning(
  model: RuntimeModelDescriptor | undefined,
  current: ReasoningSelection = DEFAULT_REASONING,
): ReasoningSelection {
  const levels = model ? reasoningLevelsForModel(model) : REASONING_LEVELS;
  if (levels.length === 0) return "";
  if (current && levels.includes(current)) return current;
  return levels.includes(DEFAULT_REASONING) ? DEFAULT_REASONING : levels.at(-1) ?? "off";
}

export function isReasoningSelectionValid(
  model: RuntimeModelDescriptor,
  selection: ReasoningSelection,
  allowProviderDefault: boolean,
): boolean {
  if (!selection) return allowProviderDefault || reasoningLevelsForModel(model).length === 0;
  return reasoningLevelsForModel(model).includes(selection);
}

export function createSessionModelSettingsDraft(
  models: readonly RuntimeModelDescriptor[],
  config: Pick<RuntimeModelConfig, "modelSelection" | "reasoningLevel" | "serviceTier">,
): SessionModelSettingsDraft {
  const selected = config.modelSelection ?? preferredModel(models);
  return {
    modelKey: selected ? modelKey(selected) : "",
    reasoningLevel: config.reasoningLevel ?? "",
    serviceTier: config.serviceTier ?? "",
  };
}

export function reconcileSessionModelSettingsModel(
  draft: SessionModelSettingsDraft,
  models: readonly RuntimeModelDescriptor[],
  nextKey: string,
): SessionModelSettingsDraft {
  const selected = modelFromKey(models, nextKey);
  if (!selected) return { ...draft, modelKey: nextKey };
  const reasoningLevels = reasoningLevelsForModel(selected);
  const serviceTiers = selected.serviceTiers ?? [];
  return {
    ...draft,
    modelKey: nextKey,
    reasoningLevel: draft.reasoningLevel && reasoningLevels.includes(draft.reasoningLevel)
      ? draft.reasoningLevel
      : "",
    serviceTier: draft.serviceTier && serviceTiers.includes(draft.serviceTier)
      ? draft.serviceTier
      : "",
  };
}

export function validateSessionModelSettingsDraft(
  draft: SessionModelSettingsDraft,
  models: readonly RuntimeModelDescriptor[],
  current?: Pick<RuntimeModelConfig, "reasoningLevel" | "serviceTier">,
): SessionModelSettingsValidation {
  const errors: SessionModelSettingsValidation["errors"] = {};
  const selected = modelFromKey(models, draft.modelKey);
  if (!selected || selected.available === false) {
    errors.model = "Choose an available model.";
  } else {
    const reasoningLevels = reasoningLevelsForModel(selected);
    const serviceTiers = selected.serviceTiers ?? [];
    if (!isReasoningSelectionValid(selected, draft.reasoningLevel, true)) {
      errors.reasoningLevel = reasoningLevels.length > 0
        ? "Choose a reasoning level supported by this model."
        : "This model uses provider-default reasoning.";
    } else if (!draft.reasoningLevel && current?.reasoningLevel !== undefined && reasoningLevels.length > 0) {
      errors.reasoningLevel = "Choose an explicit reasoning level; this runtime cannot clear the current setting.";
    }
    if (draft.serviceTier && !serviceTiers.includes(draft.serviceTier)) {
      errors.serviceTier = serviceTiers.length > 0
        ? "Choose a service tier supported by this model."
        : "This model uses its provider-default service tier.";
    } else if (!draft.serviceTier && current?.serviceTier !== undefined && serviceTiers.length > 0) {
      errors.serviceTier = "Choose an explicit service tier; this runtime cannot clear the current setting.";
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function sessionModelSettingsMutations(
  draft: Pick<SessionModelSettingsDraft, "reasoningLevel" | "serviceTier">,
  current: Pick<RuntimeModelConfig, "reasoningLevel" | "serviceTier">,
): SessionModelSettingsMutations {
  const mutations: SessionModelSettingsMutations = {};
  if (draft.reasoningLevel && draft.reasoningLevel !== current.reasoningLevel) {
    mutations.reasoningLevel = draft.reasoningLevel;
  }
  if (draft.serviceTier && draft.serviceTier !== current.serviceTier) {
    mutations.serviceTier = draft.serviceTier;
  }
  return mutations;
}

export function canSelectProviderDefault(current: string | undefined): boolean {
  return current === undefined;
}

export function preferredServiceTier(
  model: RuntimeModelDescriptor | undefined,
  current: ServiceTierSelection = DEFAULT_SERVICE_TIER,
): ServiceTierSelection {
  const tiers = model?.serviceTiers;
  if (!tiers || tiers.length === 0) return "";
  return current && tiers.includes(current) ? current : tiers[0] ?? "";
}

export function isServiceTierSelectionValid(
  model: RuntimeModelDescriptor,
  selection: ServiceTierSelection,
): boolean {
  const tiers = model.serviceTiers ?? [];
  return tiers.length === 0 ? selection === "" : Boolean(selection && tiers.includes(selection));
}

export function serviceTierMutationValue(
  selection: ServiceTierSelection,
  current: ServiceTier | undefined,
): ServiceTier | undefined {
  return selection && selection !== current ? selection : undefined;
}

function reasoningLevelsForModel(model: RuntimeModelDescriptor): readonly ReasoningLevel[] {
  if (model.reasoningLevels !== undefined) return model.reasoningLevels;
  return model.capabilities?.reasoning === false ? [] : REASONING_LEVELS;
}

function searchableSessionText(session: RuntimeSessionSummary): string {
  return [session.title, session.preview, session.cwd, String(session.id)]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLocaleLowerCase();
}
