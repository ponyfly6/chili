import { describe, expect, test } from "bun:test";
import { REASONING_LEVELS } from "@chili/protocol";
import type { RuntimeModelDescriptor, SessionId } from "@chili/protocol";
import type { RuntimeSessionSummary } from "@chili/sdk";
import {
  availableReasoningLevels,
  availableServiceTiers,
  canExposeTaskActions,
  canReloadSessionMcp,
  canResumeTask,
  canSelectProviderDefault,
  createNewTaskDraft,
  createSessionModelSettingsDraft,
  filterSessions,
  goalResumeBudgetMinimum,
  goalProgress,
  hydrateNewTaskChoices,
  isServiceTierSelectionValid,
  modelKey,
  newTaskSubmission,
  preferredServiceTier,
  reconcileNewTaskModel,
  reconcileSessionModelSettingsModel,
  sessionModelSettingsMutations,
  serviceTierMutationValue,
  validateNewTaskDraft,
  validateSessionModelSettingsDraft,
  type NewTaskDraft,
} from "./task-console-model.js";

const models: RuntimeModelDescriptor[] = [
  {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    default: true,
    reasoningLevels: ["low", "high", "xhigh"],
    serviceTiers: ["standard", "fast"],
  },
  {
    provider: "local",
    model: "small",
    reasoningLevels: ["off", "medium"],
    serviceTiers: ["standard"],
  },
];

const tierlessModel: RuntimeModelDescriptor = {
  provider: "deepseek",
  model: "deepseek-v4-pro",
  displayName: "DeepSeek V4 Pro",
  default: true,
  reasoningLevels: ["low", "high"],
};

const noReasoningModel: RuntimeModelDescriptor = {
  provider: "local",
  model: "no-reasoning",
  reasoningLevels: [],
  serviceTiers: ["standard"],
};

const missingReasoningMetadataModel: RuntimeModelDescriptor = {
  provider: "local",
  model: "implicit-reasoning-defaults",
  serviceTiers: ["standard"],
};

const reasoningCapabilityDisabledModel: RuntimeModelDescriptor = {
  provider: "local",
  model: "reasoning-capability-disabled",
  capabilities: { reasoning: false },
  serviceTiers: ["standard"],
};

const offOnlyReasoningModel: RuntimeModelDescriptor = {
  provider: "local",
  model: "off-only-reasoning",
  reasoningLevels: ["off"],
  serviceTiers: ["standard"],
};

const providerDefaultOnlyModel: RuntimeModelDescriptor = {
  provider: "local",
  model: "provider-default-only",
  reasoningLevels: [],
};

describe("new task setup", () => {
  test("starts from the available default model and safe daily-driver defaults", () => {
    const draft = createNewTaskDraft(models);
    expect(draft).toMatchObject({
      modelKey: modelKey(models[0]!),
      reasoningLevel: "high",
      serviceTier: "standard",
      permissionProfile: "default",
      delegationPolicy: "proactive",
      goalEnabled: false,
    });
  });

  test("clamps runtime choices when the model changes", () => {
    const draft = { ...createNewTaskDraft(models), reasoningLevel: "xhigh" as const, serviceTier: "fast" as const };
    const next = reconcileNewTaskModel(draft, models, modelKey(models[1]!));
    expect(next.reasoningLevel).toBe("medium");
    expect(next.serviceTier).toBe("standard");
    expect(availableReasoningLevels(models, next.modelKey)).toEqual(["off", "medium"]);
    expect(availableServiceTiers(models, next.modelKey)).toEqual(["standard"]);
  });

  test("uses provider default and omits service tier for a tierless model", () => {
    const draft = { ...createNewTaskDraft([tierlessModel]), prompt: "Run the deterministic Goal" };
    expect(draft.serviceTier).toBe("");
    expect(availableServiceTiers([tierlessModel], draft.modelKey)).toEqual([]);
    expect(newTaskSubmission(draft, [tierlessModel])).toEqual({
      prompt: "Run the deterministic Goal",
      modelSelection: { provider: "deepseek", model: "deepseek-v4-pro" },
      reasoningLevel: "high",
      permissionProfile: "default",
      delegationPolicy: "proactive",
    });
  });

  test("resets and validates service tier against the selected model capability", () => {
    const tieredDraft = { ...createNewTaskDraft(models), serviceTier: "fast" as const };
    const switched = reconcileNewTaskModel(tieredDraft, [...models, tierlessModel], modelKey(tierlessModel));
    expect(switched.serviceTier).toBe("");
    expect(preferredServiceTier(tierlessModel, "standard")).toBe("");
    expect(isServiceTierSelectionValid(tierlessModel, "")).toBe(true);
    expect(isServiceTierSelectionValid(tierlessModel, "standard")).toBe(false);
    expect(serviceTierMutationValue("", "standard")).toBeUndefined();
    expect(serviceTierMutationValue("fast", "standard")).toBe("fast");

    const stale = { ...switched, prompt: "Do the work", serviceTier: "standard" as const };
    expect(validateNewTaskDraft(stale, [...models, tierlessModel]).errors.serviceTier)
      .toBe("This model uses its provider-default service tier.");
    expect(() => newTaskSubmission(stale, [...models, tierlessModel])).toThrow();
  });

  test("preserves undefined reasoning and service tier in the Session Settings draft", () => {
    expect(createSessionModelSettingsDraft(models, {
      modelSelection: { provider: models[0]!.provider, model: models[0]!.model },
    })).toEqual({
      modelKey: modelKey(models[0]!),
      reasoningLevel: "",
      serviceTier: "",
    });
    expect(createSessionModelSettingsDraft(models, {
      modelSelection: { provider: models[0]!.provider, model: models[0]!.model },
      reasoningLevel: "off",
      serviceTier: "standard",
    })).toEqual({
      modelKey: modelKey(models[0]!),
      reasoningLevel: "off",
      serviceTier: "standard",
    });
  });

  test("accepts provider-default Settings values for a tier-capable model", () => {
    expect(validateSessionModelSettingsDraft({
      modelKey: modelKey(models[0]!),
      reasoningLevel: "",
      serviceTier: "",
    }, models, {})).toEqual({ valid: true, errors: {} });
  });

  test("rejects blank Settings after an explicit A to provider-default B to A round trip", () => {
    const catalog = [...models, providerDefaultOnlyModel];
    const current = {
      modelSelection: { provider: models[0]!.provider, model: models[0]!.model },
      reasoningLevel: "high" as const,
      serviceTier: "fast" as const,
    };
    const initial = createSessionModelSettingsDraft(catalog, current);
    const onProviderDefaultModel = reconcileSessionModelSettingsModel(
      initial,
      catalog,
      modelKey(providerDefaultOnlyModel),
    );
    expect(onProviderDefaultModel).toMatchObject({ reasoningLevel: "", serviceTier: "" });
    expect(validateSessionModelSettingsDraft(onProviderDefaultModel, catalog, current))
      .toEqual({ valid: true, errors: {} });

    const backOnExplicitModel = reconcileSessionModelSettingsModel(
      onProviderDefaultModel,
      catalog,
      modelKey(models[0]!),
    );
    const validation = validateSessionModelSettingsDraft(backOnExplicitModel, catalog, current);
    expect(validation.valid).toBe(false);
    expect(validation.errors.reasoningLevel).toBeDefined();
    expect(validation.errors.serviceTier).toBeDefined();
  });

  test("distinguishes missing reasoning metadata, explicit empty capability, and explicit off", () => {
    expect(availableReasoningLevels(
      [missingReasoningMetadataModel],
      modelKey(missingReasoningMetadataModel),
    )).toEqual(REASONING_LEVELS);
    expect(availableReasoningLevels([noReasoningModel], modelKey(noReasoningModel))).toEqual([]);
    expect(availableReasoningLevels(
      [reasoningCapabilityDisabledModel],
      modelKey(reasoningCapabilityDisabledModel),
    )).toEqual([]);
    expect(availableReasoningLevels(
      [offOnlyReasoningModel],
      modelKey(offOnlyReasoningModel),
    )).toEqual(["off"]);
  });

  test("clears stale reasoning when switching to an explicitly non-configurable model", () => {
    const draft = { ...createNewTaskDraft(models), reasoningLevel: "high" as const };
    const switched = reconcileNewTaskModel(
      draft,
      [...models, noReasoningModel],
      modelKey(noReasoningModel),
    );
    expect(switched.reasoningLevel).toBe("");
  });

  test("validates stale reasoning for an explicitly non-configurable model", () => {
    const stale = {
      ...createNewTaskDraft([noReasoningModel]),
      prompt: "Run without configurable reasoning",
      reasoningLevel: "high" as const,
    };
    const validation = validateNewTaskDraft(stale, [noReasoningModel]);
    expect((validation.errors as Record<string, string | undefined>).reasoningLevel)
      .toBe("This model uses provider-default reasoning.");
  });

  test("rejects a stale reasoning submission for an explicitly non-configurable model", () => {
    const stale = {
      ...createNewTaskDraft([noReasoningModel]),
      prompt: "Run without configurable reasoning",
      reasoningLevel: "high" as const,
    };
    expect(() => newTaskSubmission(stale, [noReasoningModel])).toThrow();
  });

  test("omits provider-default reasoning from the submission", () => {
    const providerDefault: NewTaskDraft = {
      ...createNewTaskDraft([noReasoningModel]),
      prompt: "Use provider-default reasoning",
      reasoningLevel: "",
    };
    expect(newTaskSubmission(providerDefault, [noReasoningModel])).toEqual({
      prompt: "Use provider-default reasoning",
      modelSelection: { provider: "local", model: "no-reasoning" },
      serviceTier: "standard",
      permissionProfile: "default",
      delegationPolicy: "proactive",
    });
  });

  test("preserves explicit off reasoning through reconciliation and submission", () => {
    const explicitOff = reconcileNewTaskModel(
      { ...createNewTaskDraft(models), prompt: "Keep off explicit", reasoningLevel: "high" },
      [...models, offOnlyReasoningModel],
      modelKey(offOnlyReasoningModel),
    );
    expect(explicitOff.reasoningLevel).toBe("off");
    expect(newTaskSubmission(explicitOff, [...models, offOnlyReasoningModel]).reasoningLevel).toBe("off");
  });

  test("emits no Settings mutations for unchanged provider defaults but preserves explicit values", () => {
    expect(sessionModelSettingsMutations(
      { reasoningLevel: "", serviceTier: "" },
      {},
    )).toEqual({});
    expect(sessionModelSettingsMutations(
      { reasoningLevel: "off", serviceTier: "standard" },
      {},
    )).toEqual({ reasoningLevel: "off", serviceTier: "standard" });
    expect(sessionModelSettingsMutations(
      { reasoningLevel: "off", serviceTier: "standard" },
      { reasoningLevel: "off", serviceTier: "standard" },
    )).toEqual({});
    expect(sessionModelSettingsMutations(
      { reasoningLevel: "", serviceTier: "" },
      { reasoningLevel: "high", serviceTier: "fast" },
    )).toEqual({});
  });

  test("offers Provider default only when Settings opened with an undefined value", () => {
    expect(canSelectProviderDefault(undefined)).toBe(true);
    expect(canSelectProviderDefault("high")).toBe(false);
    expect(canSelectProviderDefault("fast")).toBe(false);
  });

  test("clears and rejects stale Settings reasoning for a model with no configurable reasoning", () => {
    const switched = reconcileSessionModelSettingsModel({
      modelKey: modelKey(models[0]!),
      reasoningLevel: "high",
      serviceTier: "standard",
    }, [...models, noReasoningModel], modelKey(noReasoningModel));
    expect(switched).toEqual({
      modelKey: modelKey(noReasoningModel),
      reasoningLevel: "",
      serviceTier: "standard",
    });
    expect(validateSessionModelSettingsDraft({
      ...switched,
      reasoningLevel: "high",
    }, [...models, noReasoningModel])).toEqual({
      valid: false,
      errors: { reasoningLevel: "This model uses provider-default reasoning." },
    });
  });

  test("hydrates async runtime choices without erasing outcome or Goal edits", () => {
    const editing = {
      ...createNewTaskDraft(),
      title: "Nightly",
      prompt: "Finish everything",
      delegationPolicy: "off" as const,
      goalEnabled: true,
      tokenBudget: "80000",
    };
    expect(hydrateNewTaskChoices(editing, models, "auto-review")).toMatchObject({
      title: "Nightly",
      prompt: "Finish everything",
      delegationPolicy: "off",
      goalEnabled: true,
      tokenBudget: "80000",
      modelKey: modelKey(models[0]!),
      permissionProfile: "auto-review",
    });
  });

  test("validates required outcome and positive Goal budgets", () => {
    const draft = { ...createNewTaskDraft(models), goalEnabled: true, tokenBudget: "1.5" };
    expect(validateNewTaskDraft(draft, models)).toEqual({
      valid: false,
      errors: {
        prompt: "Describe what Chili should accomplish.",
        tokenBudget: "Token budget must be a positive whole number.",
      },
    });
  });

  test("fails closed when the catalog has no available model", () => {
    const unavailable = [{ ...models[0]!, available: false }];
    const draft = { ...createNewTaskDraft(unavailable), prompt: "Do the work" };
    expect(draft.modelKey).toBe("");
    expect(validateNewTaskDraft(draft, unavailable).errors.model).toBe("Choose an available model.");
  });

  test("builds one trimmed create-and-run submission and defaults Goal objective to the outcome", () => {
    const draft = {
      ...createNewTaskDraft(models),
      title: "  Overnight polish  ",
      prompt: "  Finish the desktop control console.  ",
      goalEnabled: true,
      tokenBudget: "120000",
    };
    expect(newTaskSubmission(draft, models)).toEqual({
      title: "Overnight polish",
      prompt: "Finish the desktop control console.",
      modelSelection: { provider: "openai-codex", model: "gpt-5.6-sol" },
      reasoningLevel: "high",
      serviceTier: "standard",
      permissionProfile: "default",
      delegationPolicy: "proactive",
      goal: { objective: "Finish the desktop control console.", tokenBudget: 120000 },
    });
  });
});

test("filters active and archived tasks across title, preview, path, and id", () => {
  const sessions: RuntimeSessionSummary[] = [
    session("session_active_old", "active", 10, "Desktop", "Goal console"),
    session("session_archived", "archived", 30, "API hardening", "Authentication"),
    session("session_active_new", "active", 20, "SQLite gate", "WAL safety"),
  ];
  expect(filterSessions(sessions, "", "active").map(StringId)).toEqual(["session_active_new", "session_active_old"]);
  expect(filterSessions(sessions, "wal", "active").map(StringId)).toEqual(["session_active_new"]);
  expect(filterSessions(sessions, "AUTH", "archived").map(StringId)).toEqual(["session_archived"]);
});

test("bounds Goal progress while preserving an unbudgeted state", () => {
  expect(goalProgress(25, 100)).toBe(0.25);
  expect(goalProgress(150, 100)).toBe(1);
  expect(goalProgress(20)).toBeUndefined();
});

test("only offers generic resume for a stopped active or paused Goal", () => {
  expect(canResumeTask("cancelled", "paused", false)).toBe(true);
  expect(canResumeTask("failed", "active", false)).toBe(true);
  expect(canResumeTask("cancelled", undefined, false)).toBe(false);
  expect(canResumeTask("failed", "budgetLimited", false)).toBe(false);
  expect(canResumeTask("cancelled", "paused", true)).toBe(false);
});

test("keeps archived task menus and MCP mutations fail closed", () => {
  expect(canExposeTaskActions("active")).toBe(true);
  expect(canExposeTaskActions("archived")).toBe(false);
  expect(canReloadSessionMcp("session_active", false, false)).toBe(true);
  expect(canReloadSessionMcp("session_archived", true, false)).toBe(false);
  expect(canReloadSessionMcp(undefined, false, false)).toBe(false);
  expect(canReloadSessionMcp("session_busy", false, true)).toBe(false);
});

test("requires budget-limited recovery to exceed both usage and the previous budget", () => {
  expect(goalResumeBudgetMinimum({ tokensUsed: 50_000, tokenBudget: 50_000 })).toBe(50_001);
  expect(goalResumeBudgetMinimum({ tokensUsed: 60_000, tokenBudget: 50_000 })).toBe(60_001);
  expect(goalResumeBudgetMinimum({ tokensUsed: 5, tokenBudget: 10 })).toBe(11);
});

function session(
  id: string,
  status: RuntimeSessionSummary["status"],
  updatedAt: number,
  title: string,
  preview: string,
): RuntimeSessionSummary {
  return {
    id: id as SessionId,
    cwd: "/repo",
    status,
    createdAt: 1,
    updatedAt,
    title,
    preview,
  };
}

function StringId(session: RuntimeSessionSummary): string {
  return String(session.id);
}
