import { expect, test } from "bun:test";
import {
  defaultModelCandidates,
  filterModelCandidates,
  findExactModelSelection,
  modelAuthLabel,
  modelSupportsImages,
  modelSupportsReasoning,
  modelSupportsServiceTier,
  parseModelCommand,
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
  const minimax = { provider: "minimax", model: "MiniMax-M3" };
  const codex = { provider: "openai-codex", model: "gpt-5.6-sol" };
  const grok = { provider: "xai", model: "grok-4.6" };

  expect(modelSupportsReasoning(minimax, candidates)).toBe(true);
  expect(modelSupportsServiceTier(minimax, candidates)).toBe(true);
  expect(modelSupportsReasoning(codex, candidates)).toBe(true);
  expect(modelSupportsServiceTier(codex, candidates)).toBe(true);
  expect(modelSupportsReasoning(grok, candidates)).toBe(true);
  expect(modelSupportsImages(grok, candidates)).toBe(true);
  expect(modelSupportsServiceTier(grok, candidates)).toBe(false);
});

test("built-in picker exposes only current model generations", () => {
  const candidates = defaultModelCandidates();
  const models = candidates.map(({ provider, model }) => `${provider}/${model}`);
  const openAIModels = candidates
    .filter(({ provider }) => provider === "openai-codex" || provider === "codex-api")
    .map(({ model }) => model);

  expect(openAIModels).toEqual([
    "gpt-6.1-sol",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
  ]);
  expect(models).toContain("minimax/MiniMax-M3");
  expect(models).toContain("kimi/kimi-k3");
  expect(models).toContain("zai/glm-5.3");
  expect(models).toContain("xai/grok-4.6");
  expect(models).toContain("xai/grok-4.7");
  expect(models.some((entry) => entry.includes("gpt-5.5"))).toBe(false);
  expect(models).not.toContain("minimax/MiniMax-M2.7");
  expect(models).not.toContain("minimax/MiniMax-M3[1m]");
  expect(models).not.toContain("kimi/kimi-k2.6");
  expect(models).not.toContain("zai/glm-5.2");
});

test("model references canonicalize the official GPT alias", () => {
  const candidates = defaultModelCandidates();

  expect(findExactModelSelection("codex/gpt-5.6", candidates)).toEqual({
    provider: "openai-codex",
    model: "gpt-5.6-sol",
  });
  expect(findExactModelSelection("codex-api/gpt-5.6", candidates)).toEqual({
    provider: "codex-api",
    model: "gpt-5.6-sol",
  });
  expect(findExactModelSelection("openai/gpt-5.6", candidates)).toEqual({
    provider: "openai",
    model: "gpt-5.6-sol",
  });
  expect(parseModelCommand("codex/gpt-5.6:high", candidates)).toEqual({
    selection: { provider: "openai-codex", model: "gpt-5.6-sol" },
    reasoningLevel: "high",
  });
});

test("Grok aliases select xAI and expose image and reasoning controls", () => {
  const candidates = defaultModelCandidates();
  const grok = candidates.find(({ provider, model }) => provider === "xai" && model === "grok-4.7");

  expect(parseModelCommand("grok", candidates)).toEqual({
    selection: { provider: "xai", model: "grok-4.7" },
  });
  expect(findExactModelSelection("grok/grok-4.6", candidates)).toEqual({
    provider: "xai",
    model: "grok-4.6",
  });
  expect(findExactModelSelection("x.ai/grok-4.6", candidates)).toEqual({
    provider: "xai",
    model: "grok-4.6",
  });
  expect(grok?.inputCapabilities).toEqual(["text", "image"]);
  expect(grok?.reasoningLevels).toEqual(["low", "medium", "high", "xhigh"]);
});

test("vendor commands and search use the same aliases as Host routing", () => {
  const candidates = defaultModelCandidates();
  const aliases = [
    ["qwen", "alibaba"], ["dashscope", "alibaba"], ["aliyun", "alibaba"],
    ["ark", "doubao"], ["volcengine", "doubao"], ["bytedance", "doubao"],
    ["moonshot", "kimi"], ["glm", "zai"], ["z.ai", "zai"],
    ["bigmodel", "zhipu"], ["智谱", "zhipu"],
  ] as const;
  for (const [alias, provider] of aliases) {
    const selected = candidates.find((model) => model.provider === provider && model.default);
    expect(selected).toBeDefined();
    const selection = { provider, model: selected!.model };
    expect(parseModelCommand(alias, candidates)).toEqual({ selection });
    expect(parseModelCommand(`${alias}/${selected!.model}:high`, candidates)).toEqual({ selection, reasoningLevel: "high" });
    expect(filterModelCandidates(candidates, alias, undefined).some((model) => model.provider === provider)).toBe(true);
  }
});

test("official APIs remain distinct selectable connections in the picker", () => {
  const candidates = defaultModelCandidates();
  for (const provider of ["openai", "anthropic", "openai-codex", "codex-api"]) {
    const selected = candidates.find((model) => model.provider === provider && model.default);
    expect(selected).toBeDefined();
    expect(parseModelCommand(provider, candidates)).toEqual({ selection: { provider, model: selected!.model } });
    expect(findExactModelSelection(`${provider}/${selected!.model}`, candidates)).toEqual({ provider, model: selected!.model });
  }
  expect(findExactModelSelection("gpt-6.1-sol", candidates)).toBeUndefined();
  expect(parseModelCommand("openai/gpt-unsupported", candidates)).toEqual({ query: "openai/gpt-unsupported" });
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
