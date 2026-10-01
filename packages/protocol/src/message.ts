import type {
  ArtifactId,
  MessageId,
  PartId,
  SessionId,
  TimestampMs,
  ToolCallId,
  TurnId,
} from "./ids.js";
import type { ToolResultContent } from "./tool.js";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type AssistantMessagePhase = "commentary" | "final_answer";

export interface Message {
  id: MessageId;
  sessionId: SessionId;
  role: MessageRole;
  parts: MessagePart[];
  parentId?: MessageId;
  turnId?: TurnId;
  createdAt: TimestampMs;
}

export type MessagePart =
  | TextPart
  | ImagePart
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
  phase?: AssistantMessagePhase;
  displayText?: string;
  synthetic?: boolean;
}

export interface MessageImageContent {
  data: string;
  mimeType: string;
  filename?: string;
  sourcePath?: string;
}

export interface ImagePart extends BasePart, MessageImageContent {
  type: "image";
  displayText?: string;
}

export interface ReasoningPart extends BasePart {
  type: "reasoning";
  text: string;
  redacted?: boolean;
  modelOutput?: PersistedModelOutput;
}

/** Opaque provider output that must be replayed to continue a stateless response. */
export interface PersistedModelOutput {
  apiFamily: string;
  outputIndex?: number;
  item: Record<string, unknown>;
}

export interface ToolCallPart extends BasePart {
  type: "tool_call";
  callId: ToolCallId;
  toolName: string;
  input: unknown;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
}

export type ToolResultSandbox = "macos-seatbelt" | "none";

export type ToolResultExecutionMode = "sandboxed" | "unsandboxed";

export interface ToolResultExecutionContext {
  sandbox?: ToolResultSandbox;
  executionMode?: ToolResultExecutionMode;
  exitCode?: number | null;
  timedOut?: boolean;
  aborted?: boolean;
  signal?: string | null;
}

export interface ToolResultPart extends BasePart {
  type: "tool_result";
  callId: ToolCallId;
  output: string;
  content?: ToolResultContent[];
  error?: string;
  executionContext?: ToolResultExecutionContext;
  synthetic?: boolean;
  artifactIds?: ArtifactId[];
}

export function formatToolResultForModel(
  part: Pick<ToolResultPart, "output" | "error" | "executionContext">,
): string {
  const result = part.error
    ? part.output
      ? `${part.output}\n\nError: ${part.error}`
      : `Error: ${part.error}`
    : part.output;
  const executionContext = formatToolResultExecutionContext(part.executionContext);
  if (!executionContext) return result;
  return result ? `${result}\n\n${executionContext}` : executionContext;
}

function formatToolResultExecutionContext(context: ToolResultExecutionContext | undefined): string {
  if (!context) return "";
  const lines: string[] = [];
  if (context.sandbox !== undefined) lines.push(`sandbox: ${context.sandbox}`);
  if (context.executionMode !== undefined) lines.push(`execution_mode: ${context.executionMode}`);
  if (context.exitCode !== undefined) lines.push(`exit_code: ${context.exitCode ?? "null"}`);
  if (context.timedOut !== undefined) lines.push(`timed_out: ${String(context.timedOut)}`);
  if (context.aborted !== undefined) lines.push(`aborted: ${String(context.aborted)}`);
  if (context.signal !== undefined) lines.push(`signal: ${context.signal ?? "null"}`);
  return lines.length > 0 ? `[tool execution context]\n${lines.join("\n")}` : "";
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
