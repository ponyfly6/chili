import type { ApprovalId, ArtifactId, SessionId, ThreadId, ToolCallId, TurnId } from "./ids.js";

export type ToolRisk = "read" | "write" | "execute" | "network" | "dangerous";

export type ToolCallStatus =
  | "pending"
  | "validating"
  | "waiting_for_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ToolOutputStream = "stdout" | "stderr";

export interface ToolDefinition<Input = unknown, Output extends ToolResult = ToolResult> {
  name: string;
  description: string;
  risk: ToolRisk;
  inputSchema: unknown;
  execute(input: Input, context: ToolExecutionContext): Promise<Output>;
}

export interface ToolExecutionContext {
  sessionId: SessionId;
  threadId?: ThreadId;
  turnId: TurnId;
  callId: ToolCallId;
  signal: AbortSignal;
  cwd: string;
  metadata(update: ToolMetadataUpdate): Promise<void>;
  streamOutput(update: ToolOutputUpdate): Promise<void>;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface ToolMetadataUpdate {
  title?: string;
  status?: ToolCallStatus;
  metadata?: Record<string, unknown>;
}

export interface ToolOutputUpdate {
  stream: ToolOutputStream;
  delta: string;
  bytes?: number;
  truncated?: boolean;
}

export interface ToolResult {
  title: string;
  output: string;
  metadata?: Record<string, unknown>;
  artifactIds?: ArtifactId[];
}

export interface ApprovalRequest {
  id?: ApprovalId;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
}

export type ApprovalDecisionAction = "allow_once" | "allow_session" | "allow_always" | "deny";

export interface ApprovalDecision {
  action: ApprovalDecisionAction;
  feedback?: string;
}
