import type { SessionId } from "./ids.js";
import type { RuntimeSessionInput } from "./session-input.js";

/** An Agent is a persistent session; lists include the root and its children. */
export interface RuntimeAgentRecord {
  agentId: string;
  name: string;
  path: string;
  parentAgentId?: string;
  state: "idle" | "running" | "paused";
  progress?: RuntimeAgentProgress;
}

export interface RuntimeAgentSubmission {
  agentId: string;
  inputId: string;
}

export interface RuntimeAgentWaitResult {
  input: RuntimeSessionInput;
  result?: unknown;
  timedOut: boolean;
}

export interface RuntimeAgentControlRequest {
  /** The persisted root session acting as caller. */
  sessionId: SessionId;
  signal?: AbortSignal;
}

/** Work outcome is separate from the persistent Agent session's lifecycle. */
export interface RuntimeAgentProgress {
  state: "running" | "queued" | "waiting" | "paused" | "completed" | "attention" | "failed" | "stopped";
  task?: string;
  detail?: string;
  action?: string;
  subject?: string;
  startedAt?: number;
  updatedAt?: number;
}

export function parseRuntimeAgentProgress(value: unknown): RuntimeAgentProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Agent progress");
  const row = value as Record<string, unknown>;
  if (!["running", "queued", "waiting", "paused", "completed", "attention", "failed", "stopped"].includes(String(row.state))) throw new TypeError("Invalid Agent work state");
  const result: RuntimeAgentProgress = { state: row.state as RuntimeAgentProgress["state"] };
  for (const key of ["task", "detail", "action", "subject"] as const) if (row[key] !== undefined) {
    if (typeof row[key] !== "string" || row[key].length > 2000) throw new TypeError(`Invalid Agent ${key}`);
    result[key] = row[key];
  }
  for (const key of ["startedAt", "updatedAt"] as const) if (row[key] !== undefined) {
    if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0) throw new TypeError(`Invalid Agent ${key}`);
    result[key] = row[key];
  }
  return result;
}
