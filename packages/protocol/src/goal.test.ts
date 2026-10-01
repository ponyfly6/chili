import { expect, test } from "bun:test";
import {
  SESSION_GOAL_STATUSES,
  type ChiliEvent,
  type SessionGoal,
  type SessionGoalUpdateReason,
  type SessionGoalUsageDelta,
  type SessionId,
  type TimestampMs,
  type TurnId,
} from "./index.js";

const sessionId = "session-1" as SessionId;
const time = 1 as TimestampMs;

test("session goals expose the supported lifecycle states", () => {
  expect(SESSION_GOAL_STATUSES).toEqual(["active", "paused", "budgetLimited", "complete"]);
});

test("goal events are owned by a session", () => {
  const reason: SessionGoalUpdateReason = "set";
  const goal: SessionGoal = {
    sessionId,
    objective: "Finish the migration",
    status: "active",
    tokensUsed: 10,
    timeUsedSeconds: 2,
    createdAt: time,
    updatedAt: time,
    lastReason: reason,
  };
  const usageDelta: SessionGoalUsageDelta = {
    turnId: "turn-1" as TurnId,
    tokens: 10,
    timeSeconds: 2,
  };
  const updated: ChiliEvent = {
    id: "goal-1",
    type: "goal.updated",
    time,
    sessionId,
    payload: { goal, reason, usageDelta },
  };
  const cleared: ChiliEvent = {
    id: "goal-2",
    type: "goal.cleared",
    time,
    sessionId,
    payload: { sessionId, previousGoal: goal, reason: "clear" },
  };

  expect(updated.payload.goal.sessionId).toBe(sessionId);
  expect(cleared.payload.sessionId).toBe(sessionId);
});

test("session and goal event types require an envelope session identity", () => {
  // @ts-expect-error Session-scoped events cannot omit the authoritative envelope identity.
  const missingSessionEnvelope: Extract<ChiliEvent, { type: "session.created" }> = {
    id: "session-missing-envelope",
    type: "session.created",
    time,
    payload: { sessionId, cwd: "/workspace" },
  };
  // @ts-expect-error Goal events use the same required envelope identity contract.
  const missingGoalEnvelope: Extract<ChiliEvent, { type: "goal.updated" }> = {
    id: "goal-missing-envelope",
    type: "goal.updated",
    time,
    payload: {
      goal: {
        sessionId,
        objective: "Finish the migration",
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: time,
        updatedAt: time,
      },
    },
  };

  expect(missingSessionEnvelope.payload.sessionId).toBe(sessionId);
  expect(missingGoalEnvelope.payload.goal.sessionId).toBe(sessionId);
});
