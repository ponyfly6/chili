export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type TurnId = Brand<string, "TurnId">;
export type MessageId = Brand<string, "MessageId">;
export type PartId = Brand<string, "PartId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type AgentRunId = Brand<string, "AgentRunId">;
export type TeamId = Brand<string, "TeamId">;
export type TaskId = Brand<string, "TaskId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type UserInputId = Brand<string, "UserInputId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type SnapshotId = Brand<string, "SnapshotId">;

export type TimestampMs = Brand<number, "TimestampMs">;

export const PERSISTED_IDENTIFIER_MAX_CHARS = 512;

/**
 * Preserves valid provider/tool call ids and deterministically replaces values
 * that cannot safely cross the persisted-event/desktop boundary. The optional
 * discriminator keeps repeated hostile ids at different stream indexes distinct.
 */
export function normalizeToolCallId(value: unknown, discriminator?: string | number): ToolCallId {
  if (isSafePersistedIdentifier(value)) return value as ToolCallId;
  const rendered = safeIdentifierSource(value);
  const suffix = stableIdentifierHash(`${rendered}\0${discriminator ?? ""}`);
  return `toolcall_invalid_${suffix}` as ToolCallId;
}

export function timestampNow(): TimestampMs {
  return Date.now() as TimestampMs;
}

function isSafePersistedIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= PERSISTED_IDENTIFIER_MAX_CHARS
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value !== "__proto__"
    && value !== "prototype"
    && value !== "constructor";
}

function safeIdentifierSource(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return "unreadable";
  }
}

function stableIdentifierHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}
