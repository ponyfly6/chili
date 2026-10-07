import type { AssistantMessagePhase, Message, PersistedModelOutput, PreparedModelIdentity, ServiceTier } from "@chili/protocol";
import type { ModelCompatibilityOverrides } from "./compat.js";

export type ModelApiFamily = "anthropic-messages" | "openai-completions" | "openai-responses" | (string & {});

export type ModelInputCapability = "text" | "image";

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
export const THINKING_LEVELS = REASONING_LEVELS;
export type ThinkingLevel = ReasoningLevel;

/** Reference prices per million tokens, not an invoice calculator. */
export interface ModelCost {
  /** USD when omitted, for compatibility with existing catalogs. */
  currency?: "USD" | "CNY";
  /** Endpoint, tier, context-length, TTL or time-of-day conditions on these rates. */
  notes?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCapabilities {
  streaming: boolean;
  reasoning?: boolean;
  toolCalls?: boolean;
  toolCallDeltas?: boolean;
  usage?: boolean;
  responseId?: boolean;
}

export interface ModelDescriptor {
  provider: string;
  model: string;
  apiFamily?: ModelApiFamily;
  baseUrl?: string;
  displayName?: string;
  capabilities?: ModelCapabilities;
  compatibility?: ModelCompatibilityOverrides;
  inputCapabilities?: readonly ModelInputCapability[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  reasoningLevels?: readonly ReasoningLevel[];
  serviceTiers?: readonly ServiceTier[];
  cost?: ModelCost;
  default?: boolean;
}

export interface ModelSelection {
  provider: string;
  model: string;
  reasoning?: ReasoningLevel;
  thinking?: ThinkingLevel;
}

export interface ChiliModelProvider {
  readonly id: string;
  readonly name: string;
  models(): readonly ModelDescriptor[];
  getModel(model?: string): ChiliModel;
}

export interface ChiliModel {
  readonly provider: string;
  readonly model: string;
  stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent>;
}

export interface ModelTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ModelStreamInput {
  messages: readonly Message[];
  provider?: string;
  model?: string;
  selection?: Partial<ModelSelection>;
  reasoningLevel?: ReasoningLevel;
  reasoning?: ReasoningLevel;
  thinking?: ThinkingLevel;
  serviceTier?: ServiceTier;
  tools?: readonly ModelTool[];
  system?: readonly string[];
  developer?: readonly string[];
  contextualUser?: readonly string[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Total provider request deadline, including authentication and backpressure. Default: five minutes. */
  requestTimeoutMs?: number;
  /** Records the identity actually authorized for this attempt before network dispatch. */
  onRequestIdentity?: (identity: ModelRequestIdentity) => Promise<void>;
  metadata?: Record<string, unknown>;
}

export type ModelRequestIdentity = PreparedModelIdentity;

export interface ModelUsage {
  /** Non-cached input tokens. Cached reads and writes are reported separately. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
  raw?: unknown;
}

export type ModelStreamEvent =
  | ModelMetadataEvent
  | ModelTextDeltaEvent
  | ModelTextEndEvent
  | ModelReasoningDeltaEvent
  | ModelReasoningEndEvent
  | ModelReasoningItemEvent
  | ModelToolCallStartEvent
  | ModelToolCallDeltaEvent
  | ModelToolCallEndEvent
  | ModelFinishEvent
  | ModelErrorEvent;

export interface ModelMetadataEvent {
  type: "metadata";
  provider?: string;
  model?: string;
  responseId?: string;
  usage?: ModelUsage;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export interface ModelTextDeltaEvent {
  type: "text_delta";
  text: string;
  index?: number;
  phase?: AssistantMessagePhase;
}

/** The provider explicitly completed this text block. Missing signals flush at response finish. */
export interface ModelTextEndEvent {
  type: "text_end";
  index?: number;
  phase?: AssistantMessagePhase;
}

export interface ModelReasoningDeltaEvent {
  type: "reasoning_delta";
  text: string;
  index?: number;
  redacted?: boolean;
}

/** The provider explicitly completed this reasoning block. */
export interface ModelReasoningEndEvent {
  type: "reasoning_end";
  index?: number;
}

export interface ModelReasoningItemEvent {
  type: "reasoning_item";
  output: PersistedModelOutput;
}

export interface ModelToolCallStartEvent {
  type: "tool_call_start";
  toolCallId: string;
  name: string;
  index?: number;
}

export interface ModelToolCallDeltaEvent {
  type: "tool_call_delta";
  toolCallId: string;
  delta: string;
  name?: string;
  index?: number;
  partialInput?: unknown;
}

export interface ModelToolCallEndEvent {
  type: "tool_call_end";
  toolCallId: string;
  name: string;
  input: unknown;
  inputParseError?: string;
  index?: number;
}

export interface ModelFinishEvent {
  type: "finish";
  reason: string;
  responseId?: string;
  usage?: ModelUsage;
}

export interface ModelErrorEvent {
  type: "error";
  error: unknown;
  responseId?: string;
  usage?: ModelUsage;
}
