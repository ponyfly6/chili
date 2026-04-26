export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type ThreadId = Brand<string, "ThreadId">;
export type TurnId = Brand<string, "TurnId">;
export type MessageId = Brand<string, "MessageId">;
export type PartId = Brand<string, "PartId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type AgentRunId = Brand<string, "AgentRunId">;
export type TeamId = Brand<string, "TeamId">;
export type TaskId = Brand<string, "TaskId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type SnapshotId = Brand<string, "SnapshotId">;

export type TimestampMs = Brand<number, "TimestampMs">;

export function timestampNow(): TimestampMs {
  return Date.now() as TimestampMs;
}
