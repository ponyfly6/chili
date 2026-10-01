import type { MessageId, SessionId, TurnId } from "./ids.js";

export type RuntimeInputMode = "start" | "queue" | "steer";
export type RuntimeInputOutcome = "completed" | "failed" | "cancelled" | "interrupted";

/** A receipt is an acknowledgement of committed input, not of execution. */
export interface RuntimeSessionInput {
  inputId: string;
  submissionId: string;
  sessionId: SessionId;
  mode: RuntimeInputMode;
  state: "pending" | "claimed" | "settled";
  revision: number;
  sequence: number;
  text: string;
  acceptedAt: number;
  updatedAt: number;
  executionRef?: string;
  messageId?: MessageId;
  turnId?: TurnId;
  outcome?: RuntimeInputOutcome;
  error?: string;
}

export interface RuntimeInputQueue {
  sessionId: SessionId;
  paused: boolean;
  revision: number;
  pendingCount: number;
  interruptedCount: number;
  executionRef?: string;
  /** Pending/claimed inputs and the most recent interrupted input. */
  items: RuntimeSessionInput[];
}

export interface RuntimeInputAccepted {
  status: "accepted";
  sessionId: SessionId;
  input: RuntimeSessionInput;
  queue: RuntimeInputQueue;
}
