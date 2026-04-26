import { expect, test } from "bun:test";
import { findDefaultKnownModel, MINIMAX_PROVIDER_ID } from "./index.js";
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
      model: "deepseek-reasoner",
      apiFamily: "openai-completions",
      baseUrl: "https://api.deepseek.com",
    }),
  ).toMatchObject({
    supportsStore: false,
    supportsDeveloperRole: false,
    requiresReasoningContentOnAssistantMessages: true,
    reasoningParameterStyle: "deepseek",
    reasoningEffortMap: {
      minimal: "high",
      low: "high",
      medium: "high",
      high: "high",
      xhigh: "max",
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
