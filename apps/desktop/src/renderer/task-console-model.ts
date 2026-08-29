import type {
  DelegationPolicy,
  ModelSelection,
  ReasoningLevel,
  RuntimeModelDescriptor,
  RuntimePermissionProfileId,
  RuntimeSessionStatus,
  ServiceTier,
  SessionGoal,
  SessionGoalStatus,
} from "@chili/protocol";
import type { RuntimeSessionSummary } from "@chili/sdk";

export type SessionListStatus = "active" | "archived";
export type ServiceTierSelection = ServiceTier | "";

export interface NewTaskDraft {
  title: string;
  prompt: string;
  modelKey: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTierSelection;
  permissionProfile: RuntimePermissionProfileId;
  delegationPolicy: DelegationPolicy;
  goalEnabled: boolean;
  tokenBudget: string;
}

export interface NewTaskValidation {
  valid: boolean;
  errors: Partial<Record<"prompt" | "tokenBudget" | "model" | "serviceTier", string>>;
}

export interface NewTaskSubmission {
  title?: string;
  prompt: string;
  modelSelection?: ModelSelection;
  reasoningLevel: ReasoningLevel;
  serviceTier?: ServiceTier;
  permissionProfile: RuntimePermissionProfileId;
  delegationPolicy: DelegationPolicy;
  goal?: {
    objective: string;
    tokenBudget?: number;
  };
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
    permissionProfile: "default",
    delegationPolicy: "proactive",
    goalEnabled: false,
    tokenBudget: "",
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
  const levels = modelFromKey(models, key)?.reasoningLevels;
  return levels && levels.length > 0 ? levels : ["off", "minimal", "low", "medium", "high", "xhigh"];
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
  const budget = draft.tokenBudget.trim();
  if (budget && (!/^\d+$/.test(budget) || Number(budget) <= 0 || !Number.isSafeInteger(Number(budget)))) {
    errors.tokenBudget = "Token budget must be a positive whole number.";
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
    reasoningLevel: draft.reasoningLevel,
    permissionProfile: draft.permissionProfile,
    delegationPolicy: draft.delegationPolicy,
  };
  if (draft.serviceTier) submission.serviceTier = draft.serviceTier;
  const title = draft.title.trim();
  if (title) submission.title = title;
  if (selected) submission.modelSelection = { provider: selected.provider, model: selected.model };
  if (draft.goalEnabled) {
    const goal: NonNullable<NewTaskSubmission["goal"]> = { objective: draft.prompt.trim() };
    if (draft.tokenBudget.trim()) goal.tokenBudget = Number(draft.tokenBudget.trim());
    submission.goal = goal;
  }
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

export function goalProgress(tokensUsed: number, tokenBudget?: number): number | undefined {
  if (!tokenBudget || tokenBudget <= 0) return undefined;
  return Math.max(0, Math.min(1, tokensUsed / tokenBudget));
}

export function canResumeTask(
  sessionStatus: RuntimeSessionStatus | "unknown" | undefined,
  goalStatus: SessionGoalStatus | undefined,
  archived: boolean,
): boolean {
  return !archived
    && (goalStatus === "active" || goalStatus === "paused")
    && (sessionStatus === "cancelled" || sessionStatus === "failed");
}

export function canExposeTaskActions(status: RuntimeSessionSummary["status"]): boolean {
  return status === "active";
}

export function canReloadSessionMcp(
  sessionId: string | undefined,
  archived: boolean,
  actionsDisabled: boolean,
): boolean {
  return Boolean(sessionId) && !archived && !actionsDisabled;
}

export function goalResumeBudgetMinimum(goal: Pick<SessionGoal, "tokenBudget" | "tokensUsed">): number {
  return Math.max(goal.tokensUsed + 1, (goal.tokenBudget ?? 0) + 1);
}

function preferredModel(models: readonly RuntimeModelDescriptor[]): RuntimeModelDescriptor | undefined {
  return models.find((model) => model.default && model.available !== false)
    ?? models.find((model) => model.available !== false);
}

function preferredReasoning(
  model: RuntimeModelDescriptor | undefined,
  current: ReasoningLevel = DEFAULT_REASONING,
): ReasoningLevel {
  const levels = model?.reasoningLevels;
  if (!levels || levels.length === 0) return current;
  if (levels.includes(current)) return current;
  return levels.includes(DEFAULT_REASONING) ? DEFAULT_REASONING : levels.at(-1) ?? "off";
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

function searchableSessionText(session: RuntimeSessionSummary): string {
  return [session.title, session.preview, session.cwd, String(session.id)]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLocaleLowerCase();
}
