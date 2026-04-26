import type {
  ApprovalDecision,
  ApprovalId,
  ChiliEvent,
  EventEnvelope,
  SessionId,
  SnapshotId,
  ThreadId,
  TimestampMs,
  ToolCallId,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  TurnId,
} from "@chili/protocol";

export type ValidationResult<Input> =
  | { ok: true; value: Input }
  | { ok: false; message: string };

export interface ChiliToolDefinition<Input = unknown, Output extends ToolResult = ToolResult>
  extends ToolDefinition<Input, Output> {
  aliases?: string[];
  validate?(input: unknown): Promise<ValidationResult<Input>> | ValidationResult<Input>;
  approval?(input: Input): false | ToolApprovalSpec;
}

export interface ToolApprovalSpec {
  permission?: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
}

export interface ToolRegistry {
  register(tool: ChiliToolDefinition): void;
  get(name: string): ChiliToolDefinition | undefined;
  list(): ChiliToolDefinition[];
}

export interface ToolEventSink {
  publish(event: ChiliEvent): Promise<void>;
}

export interface ApprovalBrokerRequest {
  approvalId: ApprovalId;
  sessionId: SessionId;
  threadId?: ThreadId;
  callId: ToolCallId;
  toolName: string;
  risk: ChiliToolDefinition["risk"];
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
}

export interface ApprovalBroker {
  decide(request: ApprovalBrokerRequest): Promise<ApprovalDecision>;
}

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  events: ToolEventSink;
  approvals: ApprovalBroker;
  snapshotProvider?: SnapshotProvider;
  snapshotPolicy?: SnapshotPolicy;
  maxResultOutputBytes?: number;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
}

export interface ExecuteToolInput {
  sessionId: SessionId;
  threadId?: ThreadId;
  turnId: TurnId;
  callId?: ToolCallId;
  toolName: string;
  input: unknown;
  cwd: string;
  signal?: AbortSignal;
}

export type ExecuteToolResult =
  | { status: "completed"; callId: ToolCallId; result: ToolResult }
  | { status: "failed"; callId: ToolCallId; error: Error }
  | { status: "cancelled"; callId: ToolCallId; error: Error };

export interface SnapshotCreateRequest {
  cwd: string;
  sessionId: SessionId;
  threadId?: ThreadId;
  callId: ToolCallId;
  toolName: string;
  patterns: string[];
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface SnapshotRecord {
  id: SnapshotId;
  cwd: string;
  paths: string[];
  createdAt: TimestampMs;
}

export interface SnapshotRevertResult {
  snapshotId: SnapshotId;
  paths: string[];
  restored: string[];
  removed: string[];
}

export interface SnapshotRevertOptions {
  cwd?: string;
}

export interface SnapshotProvider {
  create(request: SnapshotCreateRequest): Promise<SnapshotRecord | undefined>;
  revert(snapshotId: SnapshotId, options?: SnapshotRevertOptions): Promise<SnapshotRevertResult>;
}

export type SnapshotPolicy = (input: {
  tool: ChiliToolDefinition;
  spec: Required<ToolApprovalSpec>;
}) => boolean;

export type ToolContextFactory = (tool: ChiliToolDefinition, input: ExecuteToolInput, callId: ToolCallId) => ToolExecutionContext;

export type ToolEventFactory<TType extends ChiliEvent["type"], TPayload> = (
  type: TType,
  payload: TPayload,
) => Extract<ChiliEvent, EventEnvelope<TType, TPayload>>;
