import { expect, test } from "bun:test";
import {
  DEEPSEEK_OPENAI_BASE_URL,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_V4_FLASH_MODEL,
  DEEPSEEK_V4_PRO_MODEL,
  findDefaultKnownModel,
  findKnownModel,
  KIMI_K26_MODEL,
  KIMI_OPENAI_BASE_URL,
  KIMI_PROVIDER_ID,
  listKnownModels,
  MINIMAX_ANTHROPIC_BASE_URL,
  MINIMAX_M27_HIGHSPEED_MODEL,
  MINIMAX_M27_MODEL,
  MINIMAX_M3_MODEL,
  MINIMAX_PROVIDER_ID,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID,
  readDeepSeekEnvironment,
  readKimiEnvironment,
  readMiniMaxEnvironment,
  readOpenAICodexEnvironment,
} from "./index.js";

test("catalog describes the built-in DeepSeek V4 OpenAI-compatible models", () => {
  const models = listKnownModels(DEEPSEEK_PROVIDER_ID);

  expect(models.map((model) => model.model)).toEqual([DEEPSEEK_V4_PRO_MODEL, DEEPSEEK_V4_FLASH_MODEL]);
  expect(findDefaultKnownModel(DEEPSEEK_PROVIDER_ID)).toMatchObject({
    provider: DEEPSEEK_PROVIDER_ID,
    model: DEEPSEEK_V4_PRO_MODEL,
    apiFamily: "openai-completions",
    baseUrl: DEEPSEEK_OPENAI_BASE_URL,
    default: true,
    inputCapabilities: ["text"],
    contextWindowTokens: 1048576,
    maxOutputTokens: 393216,
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
      usage: true,
      responseId: true,
    },
    compatibility: {
      chatCompletions: {
        maxTokensField: "max_tokens",
        reasoningParameterStyle: "deepseek",
      },
    },
  });
  expect(findKnownModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_V4_FLASH_MODEL)).toMatchObject({
    model: DEEPSEEK_V4_FLASH_MODEL,
    apiFamily: "openai-completions",
  });
});

test("catalog describes the built-in Kimi OpenAI-compatible model", () => {
  const models = listKnownModels(KIMI_PROVIDER_ID);

  expect(models.map((model) => model.model)).toEqual([KIMI_K26_MODEL]);
  expect(findDefaultKnownModel(KIMI_PROVIDER_ID)).toMatchObject({
    provider: KIMI_PROVIDER_ID,
    model: KIMI_K26_MODEL,
    apiFamily: "openai-completions",
    baseUrl: KIMI_OPENAI_BASE_URL,
    default: true,
    inputCapabilities: ["text"],
    contextWindowTokens: 256000,
    maxOutputTokens: 32768,
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
      usage: true,
      responseId: true,
    },
    compatibility: {
      chatCompletions: {
        maxTokensField: "max_tokens",
        reasoningParameterStyle: "moonshot",
      },
    },
  });
});

test("catalog describes the built-in MiniMax Anthropic-family models", () => {
  const models = listKnownModels(MINIMAX_PROVIDER_ID);

  expect(models.map((model) => model.model)).toEqual([MINIMAX_M3_MODEL, MINIMAX_M27_HIGHSPEED_MODEL, MINIMAX_M27_MODEL]);
  expect(findDefaultKnownModel(MINIMAX_PROVIDER_ID)).toMatchObject({
    provider: MINIMAX_PROVIDER_ID,
    model: MINIMAX_M3_MODEL,
    apiFamily: "anthropic-messages",
    baseUrl: MINIMAX_ANTHROPIC_BASE_URL,
    default: true,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 1000000,
    maxOutputTokens: 32768,
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

test("catalog describes the built-in ChatGPT Codex Responses models", () => {
  const models = listKnownModels(OPENAI_CODEX_PROVIDER_ID);

  expect(models.map((model) => model.model)).toContain(OPENAI_CODEX_DEFAULT_MODEL);
  expect(findDefaultKnownModel(OPENAI_CODEX_PROVIDER_ID)).toMatchObject({
    provider: OPENAI_CODEX_PROVIDER_ID,
    model: OPENAI_CODEX_DEFAULT_MODEL,
    apiFamily: "openai-responses",
    baseUrl: OPENAI_CODEX_BASE_URL,
    default: true,
    inputCapabilities: ["text", "image"],
    contextWindowTokens: 272000,
    maxOutputTokens: 128000,
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
      usage: true,
      responseId: true,
    },
  });
});

test("DeepSeek env resolution uses provider-specific variables", () => {
  expect(
    readDeepSeekEnvironment({
      DEEPSEEK_API_KEY: "deepseek-key",
      DEEPSEEK_BASE_URL: "https://deepseek.test",
      DEEPSEEK_MODEL: "deepseek-v4-flash",
    }),
  ).toEqual({
    apiKey: "deepseek-key",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://deepseek.test",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    model: "deepseek-v4-flash",
    modelEnv: "DEEPSEEK_MODEL",
  });
});

test("Kimi env resolution uses Moonshot variables with Kimi fallbacks", () => {
  expect(
    readKimiEnvironment({
      MOONSHOT_API_KEY: "moonshot-key",
      KIMI_API_KEY: "kimi-key",
      MOONSHOT_BASE_URL: "https://moonshot.test/v1",
      KIMI_BASE_URL: "https://kimi.test/v1",
      MOONSHOT_MODEL: "kimi-k2.6",
      KIMI_MODEL: "kimi-k2.5",
    }),
  ).toEqual({
    apiKey: "moonshot-key",
    apiKeyEnv: "MOONSHOT_API_KEY",
    baseUrl: "https://moonshot.test/v1",
    baseUrlEnv: "MOONSHOT_BASE_URL",
    model: "kimi-k2.6",
    modelEnv: "MOONSHOT_MODEL",
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

test("OpenAI Codex env resolution uses provider-specific variables", () => {
  expect(
    readOpenAICodexEnvironment({
      OPENAI_CODEX_ACCESS_TOKEN: "token",
      OPENAI_CODEX_BASE_URL: "https://chatgpt.test/backend-api",
      OPENAI_CODEX_MODEL: "gpt-5.3-codex",
    }),
  ).toEqual({
    apiKey: "token",
    apiKeyEnv: "OPENAI_CODEX_ACCESS_TOKEN",
    baseUrl: "https://chatgpt.test/backend-api",
    baseUrlEnv: "OPENAI_CODEX_BASE_URL",
    model: "gpt-5.3-codex",
    modelEnv: "OPENAI_CODEX_MODEL",
  });
});
