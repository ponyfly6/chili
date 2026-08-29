import { describe, expect, test } from "bun:test";
import type { RuntimeModelDescriptor, SessionId } from "@chili/protocol";
import type { RuntimeSessionSummary } from "@chili/sdk";
import {
  availableReasoningLevels,
  availableServiceTiers,
  canExposeTaskActions,
  canReloadSessionMcp,
  canResumeTask,
  createNewTaskDraft,
  filterSessions,
  goalResumeBudgetMinimum,
  goalProgress,
  hydrateNewTaskChoices,
  isServiceTierSelectionValid,
  modelKey,
  newTaskSubmission,
  preferredServiceTier,
  reconcileNewTaskModel,
  serviceTierMutationValue,
  validateNewTaskDraft,
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
