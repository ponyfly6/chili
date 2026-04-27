import { expect, test } from "bun:test";
import {
  findDefaultKnownModel,
  findKnownModel,
  listKnownModels,
  MINIMAX_ANTHROPIC_BASE_URL,
  MINIMAX_M27_HIGHSPEED_MODEL,
  MINIMAX_M27_MODEL,
  MINIMAX_PROVIDER_ID,
  readMiniMaxEnvironment,
} from "./index.js";

test("catalog describes the built-in MiniMax Anthropic-family models", () => {
  const models = listKnownModels(MINIMAX_PROVIDER_ID);

  expect(models.map((model) => model.model)).toEqual([MINIMAX_M27_HIGHSPEED_MODEL, MINIMAX_M27_MODEL]);
  expect(findDefaultKnownModel(MINIMAX_PROVIDER_ID)).toMatchObject({
    provider: MINIMAX_PROVIDER_ID,
    model: MINIMAX_M27_HIGHSPEED_MODEL,
    apiFamily: "anthropic-messages",
    baseUrl: MINIMAX_ANTHROPIC_BASE_URL,
    default: true,
    inputCapabilities: ["text"],
    contextWindowTokens: 204800,
    maxOutputTokens: 131072,
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
      usage: true,
      responseId: true,
    },
  });
  expect(findKnownModel(MINIMAX_PROVIDER_ID, MINIMAX_M27_MODEL)).toMatchObject({
    model: MINIMAX_M27_MODEL,
    apiFamily: "anthropic-messages",
  });
});

test("MiniMax env resolution prefers provider-specific variables before Anthropic fallbacks", () => {
  expect(
    readMiniMaxEnvironment({
      ANTHROPIC_API_KEY: "anthropic-key",
      MINIMAX_API_KEY: "minimax-key",
      ANTHROPIC_BASE_URL: "https://anthropic.test",
      MINIMAX_ANTHROPIC_BASE_URL: "https://minimax-anthropic.test",
      MINIMAX_BASE_URL: "https://minimax-generic.test/v1",
      ANTHROPIC_MODEL: "anthropic-model",
      MINIMAX_MODEL: "minimax-model",
    }),
  ).toEqual({
    apiKey: "minimax-key",
    apiKeyEnv: "MINIMAX_API_KEY",
    baseUrl: "https://minimax-anthropic.test",
    baseUrlEnv: "MINIMAX_ANTHROPIC_BASE_URL",
    model: "minimax-model",
    modelEnv: "MINIMAX_MODEL",
  });
});

test("MiniMax env resolution uses Anthropic base URL before generic MiniMax base URL", () => {
  expect(
    readMiniMaxEnvironment({
      ANTHROPIC_BASE_URL: "https://anthropic.test",
      MINIMAX_BASE_URL: "https://minimax-generic.test/v1",
    }),
  ).toEqual({
    baseUrl: "https://anthropic.test",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
  });
});
