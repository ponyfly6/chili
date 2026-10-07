import { expect, test } from "bun:test";
import {
  CODEX_API_ENVIRONMENT,
  CODEX_API_PROVIDER_ID,
  DEEPSEEK_ENVIRONMENT,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_V4_FLASH_MODEL,
  findConfiguredEnvironmentNames,
  isAbsoluteHttpUrl,
  KIMI_ENVIRONMENT,
  KIMI_K3_MODEL,
  KIMI_PROVIDER_ID,
  MINIMAX_ENVIRONMENT,
  MINIMAX_M3_MODEL,
  MINIMAX_PROVIDER_ID,
  OPENAI_CODEX_ENVIRONMENT,
  OPENAI_CODEX_PROVIDER_ID,
  readCodexApiEnvironment,
  readDeepSeekEnvironment,
  readKimiEnvironment,
  readMiniMaxEnvironment,
  readOpenAICodexEnvironment,
  readProviderEnvironment,
  readXaiEnvironment,
  readZaiEnvironment,
  XAI_ENVIRONMENT,
  XAI_GROK_46_MODEL,
  XAI_PROVIDER_ID,
  ZAI_ENVIRONMENT,
  ZAI_GLM_53_MODEL,
  ZAI_PROVIDER_ID,
} from "./index.js";
import { snapshotProviderEnvironment } from "./env.js";

test("provider environment specs expose the supported variable names and precedence", () => {
  expect(DEEPSEEK_ENVIRONMENT).toEqual({
    apiKey: ["DEEPSEEK_API_KEY"],
    baseUrl: ["DEEPSEEK_BASE_URL"],
    model: ["DEEPSEEK_MODEL"],
  });
  expect(KIMI_ENVIRONMENT).toEqual({
    apiKey: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    baseUrl: ["MOONSHOT_BASE_URL", "KIMI_BASE_URL"],
    model: ["MOONSHOT_MODEL", "KIMI_MODEL"],
  });
  expect(ZAI_ENVIRONMENT).toEqual({
    apiKey: ["ZAI_API_KEY"],
    baseUrl: ["ZAI_BASE_URL"],
    model: ["ZAI_MODEL"],
  });
  expect(MINIMAX_ENVIRONMENT).toEqual({
    apiKey: ["MINIMAX_API_KEY"],
    baseUrl: ["MINIMAX_ANTHROPIC_BASE_URL", "MINIMAX_BASE_URL"],
    model: ["MINIMAX_MODEL"],
  });
  expect(XAI_ENVIRONMENT).toEqual({
    apiKey: ["XAI_API_KEY"],
    baseUrl: ["XAI_BASE_URL"],
    model: ["XAI_MODEL"],
  });
  expect(OPENAI_CODEX_ENVIRONMENT).toEqual({ apiKey: [], baseUrl: [], model: [] });
  expect(CODEX_API_ENVIRONMENT).toEqual({
    apiKey: ["CODEX_API_KEY"],
    baseUrl: ["CODEX_API_BASE_URL"],
    model: ["CODEX_API_MODEL"],
  });
});

test("DeepSeek environment resolution uses only provider-specific variables", () => {
  const env = {
    DEEPSEEK_API_KEY: "deepseek-key",
    DEEPSEEK_BASE_URL: "https://deepseek.test/v1",
    DEEPSEEK_MODEL: DEEPSEEK_V4_FLASH_MODEL,
    OPENAI_API_KEY: "ignored-key",
  };
  expect(readDeepSeekEnvironment(env)).toEqual({
    apiKey: "deepseek-key",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://deepseek.test/v1",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    model: DEEPSEEK_V4_FLASH_MODEL,
    modelEnv: "DEEPSEEK_MODEL",
  });
  expect(readProviderEnvironment(DEEPSEEK_PROVIDER_ID, env)).toEqual(readDeepSeekEnvironment(env));
});

test("Kimi environment resolution prefers Moonshot variables over Kimi aliases", () => {
  const env = {
    MOONSHOT_API_KEY: "moonshot-key",
    KIMI_API_KEY: "kimi-key",
    MOONSHOT_BASE_URL: "https://moonshot.test/v1",
    KIMI_BASE_URL: "https://kimi.test/v1",
    MOONSHOT_MODEL: KIMI_K3_MODEL,
    KIMI_MODEL: "alternate-current-model",
  };
  expect(readKimiEnvironment(env)).toEqual({
    apiKey: "moonshot-key",
    apiKeyEnv: "MOONSHOT_API_KEY",
    baseUrl: "https://moonshot.test/v1",
    baseUrlEnv: "MOONSHOT_BASE_URL",
    model: KIMI_K3_MODEL,
    modelEnv: "MOONSHOT_MODEL",
  });
  expect(readProviderEnvironment(KIMI_PROVIDER_ID, env)).toEqual(readKimiEnvironment(env));
});

test("Z.ai environment resolution uses GLM provider-specific variables", () => {
  const env = {
    ZAI_API_KEY: "zai-key",
    ZAI_BASE_URL: "https://zai.test/v4",
    ZAI_MODEL: ZAI_GLM_53_MODEL,
  };
  expect(readZaiEnvironment(env)).toEqual({
    apiKey: "zai-key",
    apiKeyEnv: "ZAI_API_KEY",
    baseUrl: "https://zai.test/v4",
    baseUrlEnv: "ZAI_BASE_URL",
    model: ZAI_GLM_53_MODEL,
    modelEnv: "ZAI_MODEL",
  });
  expect(readProviderEnvironment(ZAI_PROVIDER_ID, env)).toEqual(readZaiEnvironment(env));
});

test("MiniMax environment resolution uses MiniMax variables without consuming Anthropic credentials", () => {
  const env = {
    MINIMAX_API_KEY: "minimax-key",
    ANTHROPIC_API_KEY: "anthropic-key",
    MINIMAX_ANTHROPIC_BASE_URL: "https://minimax-anthropic.test",
    ANTHROPIC_BASE_URL: "https://anthropic.test",
    MINIMAX_BASE_URL: "https://minimax-generic.test/v1",
    MINIMAX_MODEL: MINIMAX_M3_MODEL,
    ANTHROPIC_MODEL: "alternate-current-model",
  };
  expect(readMiniMaxEnvironment(env)).toEqual({
    apiKey: "minimax-key",
    apiKeyEnv: "MINIMAX_API_KEY",
    baseUrl: "https://minimax-anthropic.test",
    baseUrlEnv: "MINIMAX_ANTHROPIC_BASE_URL",
    model: MINIMAX_M3_MODEL,
    modelEnv: "MINIMAX_MODEL",
  });
  expect(readProviderEnvironment(MINIMAX_PROVIDER_ID, env)).toEqual(readMiniMaxEnvironment(env));

  expect(readMiniMaxEnvironment({
    ANTHROPIC_API_KEY: "anthropic-key",
    ANTHROPIC_BASE_URL: "https://anthropic.test",
    MINIMAX_BASE_URL: "https://minimax-generic.test/v1",
    ANTHROPIC_MODEL: MINIMAX_M3_MODEL,
  })).toEqual({
    baseUrl: "https://minimax-generic.test/v1",
    baseUrlEnv: "MINIMAX_BASE_URL",
  });
});

test("MiniMax ignores an Anthropic-only connection in reads, discovery, and snapshots", () => {
  const env = {
    ANTHROPIC_API_KEY: "anthropic-key",
    ANTHROPIC_BASE_URL: "https://anthropic.test",
    ANTHROPIC_MODEL: "claude-custom",
  };
  expect(readMiniMaxEnvironment(env)).toEqual({});
  expect(findConfiguredEnvironmentNames(MINIMAX_PROVIDER_ID, env)).toEqual([]);
  expect(snapshotProviderEnvironment(MINIMAX_PROVIDER_ID, env)).toEqual({});
});

test("xAI environment resolution supports Grok API key, endpoint, and model variables", () => {
  const env = {
    XAI_API_KEY: "xai-key",
    XAI_BASE_URL: "https://api.x.ai/v1",
    XAI_MODEL: XAI_GROK_46_MODEL,
    OPENAI_API_KEY: "ignored-key",
  };
  const expected = {
    apiKey: "xai-key",
    apiKeyEnv: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    baseUrlEnv: "XAI_BASE_URL",
    model: XAI_GROK_46_MODEL,
    modelEnv: "XAI_MODEL",
  };
  expect(readXaiEnvironment(env)).toEqual(expected);
  expect(readProviderEnvironment(XAI_PROVIDER_ID, env)).toEqual(expected);
  expect(findConfiguredEnvironmentNames(XAI_PROVIDER_ID, env)).toEqual([
    "XAI_API_KEY",
    "XAI_BASE_URL",
    "XAI_MODEL",
  ]);
});

test("ChatGPT OAuth provider ignores API environment variables", () => {
  const env = {
    OPENAI_CODEX_ACCESS_TOKEN: "ignored-token",
    OPENAI_CODEX_BASE_URL: "https://ignored.test/v1",
    OPENAI_CODEX_MODEL: "gpt-5.6-sol",
    CODEX_API_KEY: "ignored-api-key",
  };
  expect(readOpenAICodexEnvironment(env)).toEqual({});
  expect(readProviderEnvironment(OPENAI_CODEX_PROVIDER_ID, env)).toEqual({});
  expect(findConfiguredEnvironmentNames(OPENAI_CODEX_PROVIDER_ID, env)).toEqual([]);
});

test("Codex API environment uses the clean variable family atomically", () => {
  const env = {
    CODEX_API_KEY: "clean-key",
    CODEX_API_BASE_URL: "https://clean.test/v1",
    CODEX_API_MODEL: "gpt-5.6",
    OPENAI_CODEX_ACCESS_TOKEN: "legacy-key",
    OPENAI_CODEX_BASE_URL: "https://legacy.test/v1",
    OPENAI_CODEX_MODEL: "gpt-5.6-terra",
  };
  const expected = {
    apiKey: "clean-key",
    apiKeyEnv: "CODEX_API_KEY",
    baseUrl: "https://clean.test/v1",
    baseUrlEnv: "CODEX_API_BASE_URL",
    model: "gpt-5.6",
    modelEnv: "CODEX_API_MODEL",
  };
  expect(readCodexApiEnvironment(env)).toEqual(expected);
  expect(readProviderEnvironment(CODEX_API_PROVIDER_ID, env)).toEqual(expected);
  expect(findConfiguredEnvironmentNames(CODEX_API_PROVIDER_ID, env)).toEqual([
    "CODEX_API_KEY",
    "CODEX_API_BASE_URL",
    "CODEX_API_MODEL",
  ]);
});

test("Codex API environment falls back to the complete legacy variable family", () => {
  const env = {
    OPENAI_CODEX_ACCESS_TOKEN: "legacy-key",
    OPENAI_CODEX_BASE_URL: "https://legacy.test/v1",
    OPENAI_CODEX_MODEL: "gpt-5.6-sol",
  };
  expect(readCodexApiEnvironment(env)).toEqual({
    apiKey: "legacy-key",
    apiKeyEnv: "OPENAI_CODEX_ACCESS_TOKEN",
    baseUrl: "https://legacy.test/v1",
    baseUrlEnv: "OPENAI_CODEX_BASE_URL",
    model: "gpt-5.6-sol",
    modelEnv: "OPENAI_CODEX_MODEL",
  });
  expect(findConfiguredEnvironmentNames(CODEX_API_PROVIDER_ID, env)).toEqual([
    "OPENAI_CODEX_ACCESS_TOKEN",
    "OPENAI_CODEX_BASE_URL",
    "OPENAI_CODEX_MODEL",
  ]);
});

test("unknown providers have no environment contract", () => {
  const env = { UNKNOWN_API_KEY: "token", UNKNOWN_MODEL: "model" };
  expect(readProviderEnvironment("unknown", env)).toEqual({});
  expect(findConfiguredEnvironmentNames("unknown", env)).toEqual([]);
});

test("absolute endpoint validation accepts only HTTP and HTTPS URLs", () => {
  expect(isAbsoluteHttpUrl("https://gateway.test/v1")).toBe(true);
  expect(isAbsoluteHttpUrl("http://localhost:8080/v1")).toBe(true);
  expect(isAbsoluteHttpUrl("/relative/v1")).toBe(false);
  expect(isAbsoluteHttpUrl("ftp://gateway.test/v1")).toBe(false);
  expect(isAbsoluteHttpUrl("   ")).toBe(false);
  expect(isAbsoluteHttpUrl(undefined)).toBe(false);
});
