import { expect, test } from "bun:test";
import {
  defaultModelCandidates,
  filterModelCandidates,
  modelAuthLabel,
  modelSupportsReasoning,
  modelSupportsServiceTier,
  safeEndpointHost,
} from "./model-state.js";

test("model search ranks relevant results and keeps ChatGPT and Api variants together", () => {
  const candidates = [
    { provider: "codex-api", providerDisplayName: "Api", model: "gpt-5.6-luna" },
    { provider: "openai-codex", providerDisplayName: "ChatGPT", model: "gpt-5.6-luna" },
    { provider: "codex-api", providerDisplayName: "Api", model: "gpt-5.6-sol", default: true },
    { provider: "openai-codex", providerDisplayName: "ChatGPT", model: "gpt-5.6-sol", default: true },
  ];
  const current = { provider: "openai-codex", model: "gpt-5.6-sol" };

  expect(filterModelCandidates(candidates, "5.6", current).map(({ provider, model }) => `${model}:${provider}`)).toEqual([
    "gpt-5.6-sol:openai-codex",
    "gpt-5.6-sol:codex-api",
    "gpt-5.6-luna:openai-codex",
    "gpt-5.6-luna:codex-api",
  ]);
  expect(filterModelCandidates(candidates, "luna", current).map(({ model }) => model)).toEqual([
    "gpt-5.6-luna",
    "gpt-5.6-luna",
  ]);
  expect(filterModelCandidates(candidates, "chatgpt", current).every(({ provider }) => provider === "openai-codex")).toBe(true);
  expect(filterModelCandidates(candidates, "api", current).every(({ provider }) => provider === "codex-api")).toBe(true);
});

test("model search does not fuzzy-match across unrelated field boundaries", () => {
  const candidates = [{ provider: "beta", model: "alpha" }];

  expect(filterModelCandidates(candidates, "apt", undefined)).toEqual([]);
});

test("model ordering keeps same-name providers adjacent when their default flags differ", () => {
  const ordered = filterModelCandidates([
    { provider: "openai-codex", model: "alpha", default: true },
    { provider: "codex-api", model: "alpha" },
    { provider: "other", model: "zeta", default: true },
  ], "", undefined);

  expect(ordered.map(({ provider, model }) => `${model}:${provider}`)).toEqual([
    "alpha:openai-codex",
    "alpha:codex-api",
    "zeta:other",
  ]);

  expect(filterModelCandidates([
    { provider: "codex-api", model: "gpt-5.6-sol", default: true },
    { provider: "openai-codex", model: "gpt-5.6-sol" },
  ], "", { provider: "openai-codex", model: "gpt-5.6-sol" })[0]?.provider).toBe("openai-codex");
});

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

test("endpoint display keeps only a safe HTTP host", () => {
  expect(safeEndpointHost("https://user:secret@gateway.example:8443/v1/responses?api_key=hidden#fragment"))
    .toBe("gateway.example:8443");
  expect(safeEndpointHost("chatgpt.com/backend-api")).toBe("chatgpt.com");
  expect(safeEndpointHost("file:///tmp/provider-token")).toBeUndefined();
  expect(safeEndpointHost("not a valid endpoint")).toBeUndefined();
});

test("auth sources have user-facing connection labels", () => {
  expect(modelAuthLabel("oauth")).toBe("ChatGPT OAuth");
  expect(modelAuthLabel("environment")).toBe("API key");
  expect(modelAuthLabel("api_key")).toBe("API key");
  expect(modelAuthLabel("none")).toBe("not configured");
  expect(modelAuthLabel(undefined)).toBe("unknown");
});
