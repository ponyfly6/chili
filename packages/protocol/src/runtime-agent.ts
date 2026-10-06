import type { SessionId } from "./ids.js";
import type { RuntimeSessionInput } from "./session-input.js";

/** An Agent is a persistent session; lists include the root and its children. */
export interface RuntimeAgentRecord {
  agentId: string;
  name: string;
  path: string;
  parentAgentId?: string;
  state: "idle" | "running" | "paused";
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
