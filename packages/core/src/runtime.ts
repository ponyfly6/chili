import type {
  AssistantMessagePhase,
  ChiliEvent,
  RuntimeEvent,
  Message,
  ModelSelection,
  ModelUsage as ProtocolModelUsage,
  PersistedModelOutput,
  PreparedModelIdentity,
  ReasoningLevel,
  RuntimeModelDescriptor,
  ServiceTier,
  SessionId,
  ToolDefinition,
  TurnId,
} from "@chili/protocol";
import type { PromptDebugManifest } from "./prompt/index.js";

export interface RuntimeConfig {
  cwd: string;
}

export interface RuntimeServices {
  events: EventSink;
  store: SessionStore;
  tools: ToolRegistry;
  model: ModelRouter;
}

export interface EventSink {
  publish<T extends RuntimeEvent>(event: T): Promise<void>;
  subscribe(listener: (event: ChiliEvent) => void): () => void;
}

export interface SessionStore {
  append(event: RuntimeEvent): Promise<void>;
  messages(sessionId: SessionId): Promise<Message[]>;
}

export interface ToolRegistry {
  list(): Promise<ToolDefinition[]>;
  get(name: string): Promise<ToolDefinition | undefined>;
}

export interface ModelRouter {
  stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent>;
  listModels?(): Promise<readonly RuntimeModelDescriptor[]> | readonly RuntimeModelDescriptor[];
  resolveRequestLimits?(
    input: ModelRequestLimitsInput,
  ): Promise<ModelRequestLimits | undefined> | ModelRequestLimits | undefined;
}

export interface ModelRequestLimitsInput {
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
}

export interface ModelRequestLimits {
  contextWindowTokens?: number;
  requestMaxOutputTokens?: number;
}

export type ModelRequestIdentity = PreparedModelIdentity;

export type ModelRequestPurpose = "task" | "review" | "compaction" | "validation";

export interface ModelStreamInput {
  sessionId: SessionId;
  turnId: TurnId;
  /** Host observability only; does not change the provider request. */
  purpose?: ModelRequestPurpose;
  messages: Message[];
  tools: ToolDefinition[];
  system: string[];
  developer?: string[];
  contextualUser?: string[];
  promptDebug?: PromptDebugManifest;
  onRequestIdentity?: (identity: ModelRequestIdentity) => Promise<void>;
  /** Total provider request deadline, including credentials and concurrency wait. */
  requestTimeoutMs?: number;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type ModelUsage = ProtocolModelUsage;

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
  | ModelLegacyToolCallEvent
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

export interface ModelLegacyToolCallEvent {
  type: "tool_call";
  name: string;
  input: unknown;
  inputParseError?: string;
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
