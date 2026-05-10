export type MaxTokensField = "max_tokens" | "max_completion_tokens";
export type ReasoningParameterStyle =
  | "native"
  | "openrouter"
  | "deepseek"
  | "moonshot"
  | "zai"
  | "qwen"
  | "qwen-chat-template";
export type ToolCallDeltaMode = "standard" | "zai-tool-stream";

export interface MessagesCompatibility {
  supportsEagerToolInputStreaming: boolean;
}

export interface ChatCompletionsCompatibility {
  supportsStore: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  reasoningEffortMap: Partial<Record<string, string>>;
  supportsUsageInStreaming: boolean;
  maxTokensField: MaxTokensField;
  requiresReasoningContentOnAssistantMessages: boolean;
  reasoningParameterStyle: ReasoningParameterStyle;
  toolCallDeltaMode: ToolCallDeltaMode;
}

export interface ResponsesCompatibility {
  sendSessionIdHeader: boolean;
}

export interface ModelCompatibilityOverrides {
  messages?: Partial<MessagesCompatibility>;
  chatCompletions?: Partial<ChatCompletionsCompatibility>;
  responses?: Partial<ResponsesCompatibility>;
}

export interface CompatibilityResolutionInput {
  provider: string;
  model: string;
  apiFamily?: string;
  baseUrl?: string;
  compatibility?: ModelCompatibilityOverrides;
}

export type ResolvedModelCompatibility =
  | { apiFamily: "anthropic-messages"; compatibility: MessagesCompatibility }
  | { apiFamily: "openai-completions"; compatibility: ChatCompletionsCompatibility }
  | { apiFamily: "openai-responses"; compatibility: ResponsesCompatibility };

export function resolveModelCompatibility(input: CompatibilityResolutionInput): ResolvedModelCompatibility | undefined {
  if (input.apiFamily === "anthropic-messages") {
    return {
      apiFamily: "anthropic-messages",
      compatibility: resolveMessagesCompatibility(input.compatibility?.messages),
    };
  }

  if (input.apiFamily === "openai-completions") {
    return {
      apiFamily: "openai-completions",
      compatibility: resolveChatCompletionsCompatibility(input, input.compatibility?.chatCompletions),
    };
  }

  if (input.apiFamily === "openai-responses") {
    return {
      apiFamily: "openai-responses",
      compatibility: resolveResponsesCompatibility(input.compatibility?.responses),
    };
  }

  return undefined;
}

export function resolveMessagesCompatibility(
  overrides: Partial<MessagesCompatibility> = {},
): MessagesCompatibility {
  return {
    supportsEagerToolInputStreaming: overrides.supportsEagerToolInputStreaming ?? true,
  };
}

export function resolveResponsesCompatibility(
  overrides: Partial<ResponsesCompatibility> = {},
): ResponsesCompatibility {
  return {
    sendSessionIdHeader: overrides.sendSessionIdHeader ?? true,
  };
}

export function resolveChatCompletionsCompatibility(
  input: CompatibilityResolutionInput,
  overrides: Partial<ChatCompletionsCompatibility> = {},
): ChatCompletionsCompatibility {
  const detected = detectChatCompletionsCompatibility(input);
  return {
    supportsStore: overrides.supportsStore ?? detected.supportsStore,
    supportsDeveloperRole: overrides.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsReasoningEffort: overrides.supportsReasoningEffort ?? detected.supportsReasoningEffort,
    reasoningEffortMap: overrides.reasoningEffortMap ?? detected.reasoningEffortMap,
    supportsUsageInStreaming: overrides.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: overrides.maxTokensField ?? detected.maxTokensField,
    requiresReasoningContentOnAssistantMessages:
      overrides.requiresReasoningContentOnAssistantMessages ?? detected.requiresReasoningContentOnAssistantMessages,
    reasoningParameterStyle: overrides.reasoningParameterStyle ?? detected.reasoningParameterStyle,
    toolCallDeltaMode: overrides.toolCallDeltaMode ?? detected.toolCallDeltaMode,
  };
}

function detectChatCompletionsCompatibility(input: CompatibilityResolutionInput): ChatCompletionsCompatibility {
  const provider = input.provider.toLowerCase();
  const model = input.model.toLowerCase();
  const baseUrl = (input.baseUrl ?? "").toLowerCase();
  const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
  const isXai = provider === "xai" || baseUrl.includes("api.x.ai");
  const isGroq = provider === "groq" || baseUrl.includes("groq.com");
  const isDeepSeek = provider === "deepseek" || baseUrl.includes("deepseek.com");
  const isMoonshot = provider === "kimi" || provider === "moonshot" || baseUrl.includes("moonshot.cn") || baseUrl.includes("moonshot.ai");
  const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");
  const isChutes = baseUrl.includes("chutes.ai");
  const isNonStandard = isZai || isXai || isDeepSeek || isMoonshot || isCerebras || isChutes;

  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    supportsReasoningEffort: !isXai && !isZai && !isMoonshot,
    reasoningEffortMap: detectReasoningEffortMap(model, isDeepSeek, isGroq),
    supportsUsageInStreaming: true,
    maxTokensField: isDeepSeek || isMoonshot || isChutes ? "max_tokens" : "max_completion_tokens",
    requiresReasoningContentOnAssistantMessages: isDeepSeek || isMoonshot,
    reasoningParameterStyle: detectReasoningParameterStyle(provider, baseUrl, isDeepSeek, isMoonshot, isZai),
    toolCallDeltaMode: isZai ? "zai-tool-stream" : "standard",
  };
}

function detectReasoningParameterStyle(
  provider: string,
  baseUrl: string,
  isDeepSeek: boolean,
  isMoonshot: boolean,
  isZai: boolean,
): ReasoningParameterStyle {
  if (isDeepSeek) return "deepseek";
  if (isMoonshot) return "moonshot";
  if (isZai) return "zai";
  if (provider === "openrouter" || baseUrl.includes("openrouter.ai")) return "openrouter";
  return "native";
}

function detectReasoningEffortMap(
  model: string,
  isDeepSeek: boolean,
  isGroq: boolean,
): Partial<Record<string, string>> {
  if (isDeepSeek) {
    return {
      minimal: "high",
      low: "high",
      medium: "high",
      high: "high",
      xhigh: "max",
    };
  }

  if (isGroq && model === "qwen/qwen3-32b") {
    return {
      minimal: "default",
      low: "default",
      medium: "default",
      high: "default",
      xhigh: "default",
    };
  }

  return {};
}
