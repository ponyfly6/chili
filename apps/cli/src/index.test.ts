import { expect, test } from "bun:test";
import { cliEnvironmentDefaults } from "./environment-defaults.js";

test("CLI environment defaults configure Codex model, reasoning, and fast tier", () => {
  expect(cliEnvironmentDefaults({
    CHILI_PROVIDER: "openai-codex",
    CHILI_MODEL: "gpt-5.5",
    CHILI_REASONING_LEVEL: "xhigh",
    CHILI_SERVICE_TIER: "fast",
  })).toEqual({
    provider: "openai-codex",
    model: "gpt-5.5",
    reasoningLevel: "xhigh",
    serviceTier: "fast",
  });
});

test("CLI environment defaults accept OpenAI Codex aliases", () => {
  expect(cliEnvironmentDefaults({
    OPENAI_CODEX_REASONING_EFFORT: "high",
    OPENAI_CODEX_SERVICE_TIER: "standard",
  })).toEqual({
    reasoningLevel: "high",
    serviceTier: "standard",
  });
});
