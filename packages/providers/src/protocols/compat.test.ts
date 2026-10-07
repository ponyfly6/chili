import { expect, test } from "bun:test";
import { findDefaultKnownModel, MINIMAX_PROVIDER_ID } from "../index.js";
import {
  resolveChatCompletionsCompatibility,
  resolveMessagesCompatibility,
  resolveModelCompatibility,
  resolveResponsesCompatibility,
} from "./compat.js";

test("resolves Messages compatibility defaults and overrides", () => {
  expect(resolveMessagesCompatibility()).toEqual({
    supportsEagerToolInputStreaming: true,
  });

  expect(resolveMessagesCompatibility({ supportsEagerToolInputStreaming: false })).toEqual({
    supportsEagerToolInputStreaming: false,
  });
});

test("resolves compatibility from model descriptors", () => {
  const descriptor = findDefaultKnownModel(MINIMAX_PROVIDER_ID);

  expect(descriptor).toBeDefined();
  expect(resolveModelCompatibility(descriptor!)).toEqual({
    apiFamily: "anthropic-messages",
    compatibility: {
      supportsEagerToolInputStreaming: true,
    },
  });
});

test("detects chat completions differences from provider and baseUrl", () => {
  expect(
    resolveChatCompletionsCompatibility({
      provider: "openai",
      model: "gpt-5-mini",
      apiFamily: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
    }),
  ).toMatchObject({
    supportsStore: true,
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
    maxTokensField: "max_completion_tokens",
    reasoningParameterStyle: "native",
    toolCallDeltaMode: "standard",
  });

  expect(
    resolveChatCompletionsCompatibility({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiFamily: "openai-completions",
      baseUrl: "https://api.deepseek.com",
    }),
  ).toMatchObject({
    supportsStore: false,
    supportsDeveloperRole: false,
    requiresReasoningContentOnAssistantMessages: true,
    maxTokensField: "max_tokens",
    reasoningParameterStyle: "deepseek",
    reasoningEffortMap: {
      off: "low",
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "high",
      max: "max",
      ultra: "max",
    },
  });

  expect(
    resolveChatCompletionsCompatibility({
      provider: "kimi",
      model: "kimi-k3",
      apiFamily: "openai-completions",
      baseUrl: "https://api.moonshot.cn/v1",
    }),
  ).toMatchObject({
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    requiresReasoningContentOnAssistantMessages: true,
    maxTokensField: "max_completion_tokens",
    reasoningParameterStyle: "moonshot-k3",
    reasoningEffortMap: {
      off: "low",
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
      ultra: "max",
    },
  });

  expect(
    resolveChatCompletionsCompatibility({
      provider: "moonshot",
      model: "kimi-k2.6",
      apiFamily: "openai-completions",
      baseUrl: "https://api.moonshot.cn/v1",
    }),
  ).toMatchObject({
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
    reasoningParameterStyle: "moonshot",
  });

  expect(
    resolveChatCompletionsCompatibility({
      provider: "xai",
      model: "grok-4.6",
      apiFamily: "openai-completions",
      baseUrl: "https://api.x.ai/v1",
    }),
  ).toMatchObject({
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    maxTokensField: "max_completion_tokens",
    reasoningParameterStyle: "xai",
    reasoningEffortMap: {
      off: "low",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "xhigh",
      ultra: "xhigh",
    },
  });

  expect(
    resolveChatCompletionsCompatibility({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
      apiFamily: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    }),
  ).toMatchObject({
    reasoningParameterStyle: "openrouter",
  });

  expect(
    resolveChatCompletionsCompatibility({
      provider: "zai",
      model: "glm-5.3",
      apiFamily: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
    }),
  ).toMatchObject({
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    requiresReasoningContentOnAssistantMessages: true,
    maxTokensField: "max_tokens",
    reasoningParameterStyle: "zai-5.3",
    reasoningEffortMap: {
      off: "low",
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
      ultra: "max",
    },
    toolCallDeltaMode: "zai-tool-stream",
  });

  expect(
    resolveChatCompletionsCompatibility({
      provider: "zai",
      model: "glm-5.2",
      apiFamily: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
    }),
  ).toMatchObject({
    reasoningParameterStyle: "zai",
    reasoningEffortMap: {
      minimal: "high",
      low: "high",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
      ultra: "max",
    },
  });
});

test("chat completions overrides win over detected values", () => {
  expect(
    resolveChatCompletionsCompatibility(
      {
        provider: "deepseek",
        model: "deepseek-reasoner",
        apiFamily: "openai-completions",
        baseUrl: "https://api.deepseek.com",
      },
      {
        supportsDeveloperRole: true,
        maxTokensField: "max_tokens",
      },
    ),
  ).toMatchObject({
    supportsDeveloperRole: true,
    supportsStore: false,
    maxTokensField: "max_tokens",
    reasoningParameterStyle: "deepseek",
  });
});

test("resolves Responses compatibility defaults and overrides", () => {
  expect(resolveResponsesCompatibility()).toEqual({
    sendSessionIdHeader: true,
  });

  expect(resolveResponsesCompatibility({ sendSessionIdHeader: false })).toEqual({
    sendSessionIdHeader: false,
  });
});
