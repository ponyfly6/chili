import { expect, test } from "bun:test";
import {
  defaultModelCandidates,
  modelSupportsReasoning,
  modelSupportsServiceTier,
} from "./model-state.js";

test("built-in model capabilities distinguish reasoning output from configurable controls", () => {
  const candidates = defaultModelCandidates();
  const minimax = { provider: "minimax", model: "MiniMax-M3[1m]" };
  const codex = { provider: "openai-codex", model: "gpt-5.6-sol" };

  expect(modelSupportsReasoning(minimax, candidates)).toBe(false);
  expect(modelSupportsServiceTier(minimax, candidates)).toBe(false);
  expect(modelSupportsReasoning(codex, candidates)).toBe(true);
  expect(modelSupportsServiceTier(codex, candidates)).toBe(true);
});

test("unknown custom models retain the legacy reasoning fallback without claiming fast service", () => {
  const selection = { provider: "custom", model: "future-model" };

  expect(modelSupportsReasoning(selection, [])).toBe(true);
  expect(modelSupportsServiceTier(selection, [])).toBe(false);
});
