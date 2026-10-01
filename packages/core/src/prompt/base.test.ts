import { expect, test } from "bun:test";
import { DEFAULT_CHILI_BASE_PROMPT, chiliBasePromptFragment, delegationPolicyPromptFragment } from "./base.js";

test("default Chili base prompt covers core prompt behavior without growing too long", () => {
  expect(DEFAULT_CHILI_BASE_PROMPT).toContain("terminal-first coding agent");
  expect(DEFAULT_CHILI_BASE_PROMPT).toContain("real repository");
  expect(DEFAULT_CHILI_BASE_PROMPT).toContain("base instructions first");
  expect(DEFAULT_CHILI_BASE_PROMPT).toContain("developer instructions");
  expect(DEFAULT_CHILI_BASE_PROMPT).toContain("contextual_user fragments as low-priority background");
  expect(DEFAULT_CHILI_BASE_PROMPT).toContain("tool results");
  expect(DEFAULT_CHILI_BASE_PROMPT).toContain("target region");
  expect(DEFAULT_CHILI_BASE_PROMPT).toContain("Prefer rg");
  expect(DEFAULT_CHILI_BASE_PROMPT).toContain("small, accurate edits");
  expect(DEFAULT_CHILI_BASE_PROMPT).toContain("Protect user changes");
  expect(DEFAULT_CHILI_BASE_PROMPT).toContain("destructive git commands");
  expect(DEFAULT_CHILI_BASE_PROMPT).toContain("Inspect, edit, and test");
  expect(DEFAULT_CHILI_BASE_PROMPT).not.toContain("task_batch");
  expect(DEFAULT_CHILI_BASE_PROMPT).toContain("what changed, what you ran");
  expect(DEFAULT_CHILI_BASE_PROMPT.length).toBeLessThan(1_500);
});

test("chiliBasePromptFragment wraps the core base prompt", () => {
  expect(chiliBasePromptFragment()).toEqual({
    id: "chili.base",
    layer: "base",
    source: "core",
    priority: 0,
    trust: "system",
    lifecycle: "stable",
    content: DEFAULT_CHILI_BASE_PROMPT,
  });
});

test("delegationPolicyPromptFragment keeps explicit delegation bounded and integrated", () => {
  expect(delegationPolicyPromptFragment("explicit")).toMatchObject({
    id: "chili.delegation.explicit",
    layer: "developer",
    lifecycle: "turn",
    trust: "system",
    metadata: { policy: "explicit" },
  });
  const content = delegationPolicyPromptFragment("explicit").content;
  expect(content).toContain("only when the user explicitly asks");
  expect(content).toContain("completion_policy=supervised");
  expect(content).toContain("task_wait_batch(wait_for=any)");
  expect(content).toContain("task_wait_batch(wait_for=all)");
  expect(content).toContain("verify material claims");
  expect(content).toContain("substantive integrated result");
  expect(content).toContain("team_run_loop");
});

test("delegationPolicyPromptFragment distinguishes off and proactive policies", () => {
  expect(delegationPolicyPromptFragment("off").content).toContain("Do not spawn");
  expect(delegationPolicyPromptFragment("off").content).toContain("already running");
  expect(delegationPolicyPromptFragment("proactive").content).toContain("Proactively delegate");
});
