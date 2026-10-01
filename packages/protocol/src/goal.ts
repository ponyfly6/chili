import type { SessionId, TimestampMs, TurnId } from "./ids.js";

export const SESSION_GOAL_STATUSES = ["active", "paused", "budgetLimited", "complete"] as const;

export type SessionGoalStatus = (typeof SESSION_GOAL_STATUSES)[number];

export type SessionGoalUpdateReason =
  | "set"
  | "replace"
  | "pause"
  | "resume"
  | "clear"
  | "complete"
  | "budget_limited"
  | "usage"
  | "external";

export interface SessionGoal {
  sessionId: SessionId;
  objective: string;
  status: SessionGoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
  completedAt?: TimestampMs;
  lastReason?: SessionGoalUpdateReason;
}

export interface SessionGoalUsageDelta {
  turnId?: TurnId;
  tokens: number;
  timeSeconds: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
}
