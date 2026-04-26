import type { Message } from "@chili/protocol";

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
  displayName?: string;
  capabilities?: ModelCapabilities;
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
  tools?: readonly ModelTool[];
  system?: readonly string[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ModelUsage {
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
  | ModelReasoningDeltaEvent
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
}

export interface ModelTextDeltaEvent {
  type: "text_delta";
  text: string;
  index?: number;
}

export interface ModelReasoningDeltaEvent {
  type: "reasoning_delta";
  text: string;
  index?: number;
  redacted?: boolean;
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
