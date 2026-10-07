export type MaxTokensField = "max_tokens" | "max_completion_tokens";
export type ReasoningParameterStyle =
  | "native"
  | "openrouter"
  | "deepseek"
  | "moonshot"
  | "moonshot-k3"
  | "moonshot-k2.7"
  | "zai"
  | "zai-5.3"
  | "xai"
  | "qwen"
  | "qwen-chat-template";
export type ToolCallDeltaMode = "standard" | "zai-tool-stream";

export interface MessagesCompatibility {
  supportsEagerToolInputStreaming: boolean;
  /** Always-on adaptive thinking with output_config.effort (low through max). */
  supportsAdaptiveReasoningEffort?: boolean;
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
    ...(overrides.supportsAdaptiveReasoningEffort !== undefined
      ? { supportsAdaptiveReasoningEffort: overrides.supportsAdaptiveReasoningEffort } : {}),
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
  const isKimiK3 = isMoonshot && model === "kimi-k3";
  const isGrokConfigurable = isXai && (model.startsWith("grok-4.6") || model.startsWith("grok-4.7"));
  const isKimiK27 = isMoonshot && (model === "kimi-k2.7-code" || model === "kimi-k2.7-code-highspeed");
  const isZai53 = isZai && model.startsWith("glm-5.3");
  const isNonStandard = isZai || isXai || isDeepSeek || isMoonshot || isCerebras || isChutes;

  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    supportsReasoningEffort: isKimiK3 || isGrokConfigurable || isZai53 || (!isXai && !isMoonshot),
    reasoningEffortMap: detectReasoningEffortMap(model, isDeepSeek, isGroq, isZai, isKimiK3, isGrokConfigurable, isZai53),
    supportsUsageInStreaming: true,
    maxTokensField: isKimiK3 || isKimiK27
      ? "max_completion_tokens"
      : isDeepSeek || isMoonshot || isZai || isChutes
        ? "max_tokens"
        : "max_completion_tokens",
    requiresReasoningContentOnAssistantMessages: isDeepSeek || isMoonshot || isZai,
    reasoningParameterStyle: isKimiK27 ? "moonshot-k2.7" : detectReasoningParameterStyle(
      provider,
      baseUrl,
      isDeepSeek,
      isMoonshot,
      isZai,
      isKimiK3,
      isZai53,
      isXai,
    ),
    toolCallDeltaMode: isZai ? "zai-tool-stream" : "standard",
  };
}

function detectReasoningParameterStyle(
  provider: string,
  baseUrl: string,
  isDeepSeek: boolean,
  isMoonshot: boolean,
  isZai: boolean,
  isKimiK3: boolean,
  isZai53: boolean,
  isXai: boolean,
): ReasoningParameterStyle {
  if (isDeepSeek) return "deepseek";
  if (isKimiK3) return "moonshot-k3";
  if (isMoonshot) return "moonshot";
  if (isZai53) return "zai-5.3";
  if (isZai) return "zai";
  if (isXai) return "xai";
  if (provider === "openrouter" || baseUrl.includes("openrouter.ai")) return "openrouter";
  return "native";
}

function detectReasoningEffortMap(
  model: string,
  isDeepSeek: boolean,
  isGroq: boolean,
  isZai: boolean,
  isKimiK3: boolean,
  isGrokConfigurable: boolean,
  isZai53: boolean,
): Partial<Record<string, string>> {
  if (isKimiK3 || isZai53) {
    return {
      off: "low",
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
      ultra: "max",
    };
  }

  if (isGrokConfigurable) {
    return {
      off: "low",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "xhigh",
      ultra: "xhigh",
    };
  }

  if (isDeepSeek) {
    return {
      off: "low",
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "high",
      max: "max",
      ultra: "max",
    };
  }

  if (isZai) {
    return {
      minimal: "high",
      low: "high",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
      ultra: "max",
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
