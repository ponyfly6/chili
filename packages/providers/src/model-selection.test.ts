import { expect, test } from "bun:test";
import {
  getProviderCatalogStatus,
  listKnownModels,
  listModelCatalog,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID,
  parseModelSelectionPattern,
  resolveModelSelectionPattern,
} from "./index.js";
import type { ModelDescriptor } from "./types.js";

test("parses provider/model patterns with optional reasoning suffixes", () => {
  expect(parseModelSelectionPattern("openai-codex/gpt-5.5:xhigh")).toEqual({
    provider: "openai-codex",
    model: "gpt-5.5",
    reasoning: "xhigh",
    thinking: "xhigh",
  });

  expect(parseModelSelectionPattern("amazon-bedrock/amazon.nova-lite-v1:0")).toEqual({
    provider: "amazon-bedrock",
    model: "amazon.nova-lite-v1:0",
  });

  expect(parseModelSelectionPattern("gpt-5.5:low")).toEqual({
    model: "gpt-5.5",
    reasoning: "low",
    thinking: "low",
  });
});

test("resolves model selection patterns against descriptors", () => {
  const models: ModelDescriptor[] = [
    {
      provider: OPENAI_CODEX_PROVIDER_ID,
      model: "gpt-5.1",
      displayName: "GPT-5.1",
      capabilities: { streaming: true, reasoning: true },
    },
    {
      provider: OPENAI_CODEX_PROVIDER_ID,
      model: OPENAI_CODEX_DEFAULT_MODEL,
      displayName: "GPT-5.5",
      capabilities: { streaming: true, reasoning: true },
    },
    {
      provider: "openrouter",
      model: "openai/gpt-5.5:floor",
      displayName: "GPT-5.5 Floor",
      capabilities: { streaming: true, reasoning: true },
    },
  ];

  expect(resolveModelSelectionPattern("openai-codex/gpt-5.5:xhigh", models)).toMatchObject({
    selection: {
      provider: OPENAI_CODEX_PROVIDER_ID,
      model: OPENAI_CODEX_DEFAULT_MODEL,
      reasoning: "xhigh",
      thinking: "xhigh",
    },
  });

  expect(resolveModelSelectionPattern("openrouter/openai/gpt-5.5:floor", models)).toMatchObject({
    selection: {
      provider: "openrouter",
      model: "openai/gpt-5.5:floor",
    },
  });

  expect(resolveModelSelectionPattern("openai-codex/gpt-5.1:xhigh", models)).toMatchObject({
    selection: {
      provider: OPENAI_CODEX_PROVIDER_ID,
      model: "gpt-5.1",
      reasoning: "high",
    },
  });
});

test("catalog exposes display names, auth state, and Codex model metadata", () => {
  const status = getProviderCatalogStatus(OPENAI_CODEX_PROVIDER_ID, {
    env: { OPENAI_CODEX_ACCESS_TOKEN: "token" },
  });

  expect(status).toMatchObject({
    provider: OPENAI_CODEX_PROVIDER_ID,
    displayName: "ChatGPT Codex",
    configured: true,
    available: true,
    authSource: "environment",
  });

  const catalog = listModelCatalog(OPENAI_CODEX_PROVIDER_ID, {
    env: { OPENAI_CODEX_ACCESS_TOKEN: "token" },
  });
  expect(catalog.find((model) => model.model === OPENAI_CODEX_DEFAULT_MODEL)).toMatchObject({
    providerDisplayName: "ChatGPT Codex",
    displayName: "GPT-5.5",
    available: true,
    cost: {
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 0,
    },
  });

  expect(listKnownModels(OPENAI_CODEX_PROVIDER_ID).map((model) => model.model)).toEqual([
    "gpt-5.1",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "gpt-5.4-mini",
    OPENAI_CODEX_DEFAULT_MODEL,
  ]);
});
