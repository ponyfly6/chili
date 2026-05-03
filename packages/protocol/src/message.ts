import type {
  ArtifactId,
  MessageId,
  PartId,
  SessionId,
  TimestampMs,
  ToolCallId,
} from "./ids.js";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  id: MessageId;
  sessionId: SessionId;
  role: MessageRole;
  parts: MessagePart[];
  parentId?: MessageId;
  createdAt: TimestampMs;
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | PatchPart
  | ArtifactPart
  | CompactionPart
  | AgentHandoffPart;

export interface BasePart {
  id: PartId;
  messageId: MessageId;
  sessionId: SessionId;
}

export interface TextPart extends BasePart {
  type: "text";
  text: string;
  displayText?: string;
  synthetic?: boolean;
}

export interface ReasoningPart extends BasePart {
  type: "reasoning";
  text: string;
  redacted?: boolean;
}

export interface ToolCallPart extends BasePart {
  type: "tool_call";
  callId: ToolCallId;
  toolName: string;
  input: unknown;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
}

export interface ToolResultPart extends BasePart {
  type: "tool_result";
  callId: ToolCallId;
  output: string;
  error?: string;
  synthetic?: boolean;
  artifactIds?: ArtifactId[];
}

export interface PatchPart extends BasePart {
  type: "patch";
  files: string[];
  artifactId?: ArtifactId;
}

export interface ArtifactPart extends BasePart {
  type: "artifact";
  artifactId: ArtifactId;
}

export interface CompactionPart extends BasePart {
  type: "compaction";
  boundaryMessageId: MessageId;
  reason: "manual" | "token_budget" | "recovery";
  summary?: string;
  sourceMessageIds?: MessageId[];
  estimatedCharsBefore?: number;
  estimatedCharsAfter?: number;
}

export interface AgentHandoffPart extends BasePart {
  type: "agent_handoff";
  agentPath: string;
  summary: string;
}
