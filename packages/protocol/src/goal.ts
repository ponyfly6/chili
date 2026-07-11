import type { SessionId, ThreadId, TimestampMs, TurnId } from "./ids.js";

export const THREAD_GOAL_STATUSES = ["active", "paused", "budgetLimited", "complete"] as const;

export type ThreadGoalStatus = (typeof THREAD_GOAL_STATUSES)[number];

export type ThreadGoalUpdateReason =
  | "set"
  | "replace"
  | "pause"
  | "resume"
  | "clear"
  | "complete"
  | "budget_limited"
  | "usage"
  | "external";

export interface ThreadGoal {
  sessionId?: SessionId;
  threadId: ThreadId;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
  completedAt?: TimestampMs;
  lastReason?: ThreadGoalUpdateReason;
}

export interface ThreadGoalUsageDelta {
  turnId?: TurnId;
  tokens: number;
  timeSeconds: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
}
