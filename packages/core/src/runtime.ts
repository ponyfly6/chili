import type {
  AgentRunId,
  ChiliEvent,
  EventEnvelope,
  Message,
  ModelUsage as ProtocolModelUsage,
  SessionId,
  ThreadId,
  ToolDefinition,
  TurnId,
} from "@chili/protocol";
import type { PermissionRule } from "@chili/policy";

export interface RuntimeConfig {
  cwd: string;
  permissions?: PermissionRule[];
}

export interface RuntimeServices {
  events: EventSink;
  store: SessionStore;
  tools: ToolRegistry;
  model: ModelRouter;
}

export interface EventSink {
  publish<T extends ChiliEvent>(event: T): Promise<void>;
  subscribe(listener: (event: ChiliEvent) => void): () => void;
}

export interface SessionStore {
  append(event: EventEnvelope): Promise<void>;
  messages(sessionId: SessionId): Promise<Message[]>;
}

export interface ToolRegistry {
  list(): Promise<ToolDefinition[]>;
  get(name: string): Promise<ToolDefinition | undefined>;
}

export interface ModelRouter {
  stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent>;
}

export interface ModelStreamInput {
  sessionId: SessionId;
  threadId: ThreadId;
  turnId: TurnId;
  messages: Message[];
  tools: ToolDefinition[];
  system: string[];
  signal?: AbortSignal;
}

export type ModelUsage = ProtocolModelUsage;

export type ModelStreamEvent =
  | ModelMetadataEvent
  | ModelTextDeltaEvent
  | ModelReasoningDeltaEvent
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

export interface ModelLegacyToolCallEvent {
  type: "tool_call";
  name: string;
  input: unknown;
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

export interface SpawnAgentInput {
  parentRunId?: AgentRunId;
  taskName: string;
  prompt: string;
  mode: "one_shot" | "resumable" | "background";
  fork: "none" | "last_turn" | "all";
}
