import { expect, test } from "bun:test";
import type { ChiliEvent, EventEnvelope, ModelUsage, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import type { EventQuery, EventStore } from "@chili/store";
import { GoalService, goalTokenDelta } from "./goal.js";

test("goal token accounting prefers complete provider totals", () => {
  expect(goalTokenDelta({
    inputTokens: 4,
    outputTokens: 1,
    cacheReadInputTokens: 11_963,
    totalTokens: 11_968,
  })).toBe(11_968);
});

test("goal token accounting includes cache usage when totals are unavailable", () => {
  expect(goalTokenDelta({
    inputTokens: 4,
    outputTokens: 1,
    cacheReadInputTokens: 11,
    cacheCreationInputTokens: 3,
  })).toBe(19);
});

test("goal token accounting treats a reported zero total as authoritative", () => {
  expect(goalTokenDelta({
    inputTokens: 4,
    outputTokens: 1,
    totalTokens: 0,
  })).toBe(0);
});

test("goal token accounting rejects non-safe provider usage and cumulative deltas", () => {
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "totalTokens",
  ] as const) {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => goalTokenDelta({ [field]: value } as ModelUsage)).toThrow("non-negative safe integer");
    }
  }

  expect(goalTokenDelta({ totalTokens: Number.MAX_SAFE_INTEGER })).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => goalTokenDelta({
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 1,
  })).toThrow("Goal token usage delta must be a non-negative safe integer");
});

test("goal inputs trim objectives and require positive safe-integer token budgets", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_validation" as SessionId;

  await expect(service.setGoal({ sessionId, objective: "   " })).rejects.toThrow("Goal objective is required");
  for (const tokenBudget of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(service.setGoal({ sessionId, objective: "ship", tokenBudget })).rejects.toThrow(
      "Goal token budget must be a positive safe integer",
    );
  }

  const goal = await service.setGoal({ sessionId, objective: "  ship safely  ", tokenBudget: 10 });
  expect(goal.objective).toBe("ship safely");
  for (const tokenBudget of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(service.updateGoal({ sessionId, tokenBudget })).rejects.toThrow(
      "Goal token budget must be a positive safe integer",
    );
  }
  await expect(service.updateGoal({ sessionId, objective: "\t\n" })).rejects.toThrow("Goal objective is required");

  const boundaryStore = new MemoryEventStore();
  const boundary = await new GoalService({ store: boundaryStore }).setGoal({
    sessionId: "session_goal_max_safe_budget" as SessionId,
    objective: "keep precise",
    tokenBudget: Number.MAX_SAFE_INTEGER,
  });
  expect(boundary.tokenBudget).toBe(Number.MAX_SAFE_INTEGER);
});

test("goal default token budget must be a positive safe integer", async () => {
  for (const defaultTokenBudget of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const service = new GoalService({
      store: new MemoryEventStore(),
      defaultTokenBudget,
    });
    await expect(service.setGoal({
      sessionId: "session_goal_invalid_default" as SessionId,
      objective: "ship",
    })).rejects.toThrow("Default goal token budget must be a positive safe integer");
  }
});

test("goal accounting requires finite non-negative time and cumulative values", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_accounting_validation" as SessionId;
  const turnId = "turn_goal_accounting_validation" as TurnId;
  await service.setGoal({ sessionId, objective: "account safely" });

  for (const timeSeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(service.accountUsage({ sessionId, turnId, timeSeconds })).rejects.toThrow(
      "Goal usage timeSeconds must be a finite non-negative number",
    );
  }
  await expect(service.accountUsage({
    sessionId,
    turnId,
    usage: { inputTokens: -1 },
    timeSeconds: 0,
  })).rejects.toThrow("Goal usage inputTokens must be a non-negative safe integer");

  await service.updateGoal({ sessionId, status: "complete" });
  await service.accountUsage({
    sessionId,
    turnId,
    usage: { totalTokens: Number.MAX_SAFE_INTEGER },
    timeSeconds: Number.MAX_VALUE,
  });
  await expect(service.accountUsage({
    sessionId,
    turnId,
    usage: { totalTokens: 1 },
    timeSeconds: 0,
  })).rejects.toThrow("Goal tokensUsed must be a non-negative safe integer");
  await expect(service.accountUsage({
    sessionId,
    turnId,
    usage: { totalTokens: 0 },
    timeSeconds: Number.MAX_VALUE,
  })).rejects.toThrow("Goal timeUsedSeconds must be a finite non-negative number");
});

test("budget-limited goals require additional budget before reactivation", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_budget_reactivation" as SessionId;
  await service.setGoal({ sessionId, objective: "finish within budget", tokenBudget: 10 });
  const limited = await service.accountUsage({
    sessionId,
    turnId: "turn_goal_budget_reactivation" as TurnId,
    usage: { totalTokens: 10 },
    timeSeconds: 1,
  });
  expect(limited.goal?.status).toBe("budgetLimited");

  const eventCount = store.items.length;
  await expect(service.updateGoal({ sessionId, status: "active" })).rejects.toThrow(
    "Goal token budget must exceed tokens used (10)",
  );
  await expect(service.updateGoal({ sessionId, status: "active", tokenBudget: 10 })).rejects.toThrow(
    "Goal token budget must exceed tokens used (10)",
  );
  await expect(service.setGoal({
    sessionId,
    objective: "replace without more budget",
    replace: true,
  })).rejects.toThrow("Goal token budget must exceed tokens used (10)");
  expect(store.items).toHaveLength(eventCount);

  const resumed = await service.updateGoal({ sessionId, status: "active", tokenBudget: 11 });
  expect(resumed).toMatchObject({ status: "active", tokenBudget: 11, tokensUsed: 10, lastReason: "resume" });
});

test("goal state is isolated by session", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({
    store,
    createId: sequentialId(),
    now: () => 10 as TimestampMs,
  });
  const firstSessionId = "session_goal_first" as SessionId;
  const secondSessionId = "session_goal_second" as SessionId;

  await service.setGoal({ sessionId: firstSessionId, objective: "first" });
  await service.setGoal({ sessionId: secondSessionId, objective: "second" });
  await service.clearGoal({ sessionId: firstSessionId });

  expect(await service.getGoal({ sessionId: firstSessionId })).toBeUndefined();
  expect(await service.getGoal({ sessionId: secondSessionId })).toMatchObject({
    sessionId: secondSessionId,
    objective: "second",
    status: "active",
  });
});

test("goal replay fills the envelope session into legacy goal payloads", async () => {
  const store = new MemoryEventStore();
  const sessionId = "session_goal_legacy" as SessionId;
  store.items.push({
    id: "event_goal_legacy",
    type: "goal.updated",
    time: 1 as TimestampMs,
    sessionId,
    payload: {
      goal: {
        objective: "resume legacy goal",
        status: "active",
        tokensUsed: 12,
        timeUsedSeconds: 3,
        createdAt: 1,
        updatedAt: 1,
      },
      reason: "set",
    },
  } as unknown as ChiliEvent);

  expect(await new GoalService({ store }).getGoal({ sessionId })).toEqual({
    sessionId,
    objective: "resume legacy goal",
    status: "active",
    tokensUsed: 12,
    timeUsedSeconds: 3,
    createdAt: 1 as TimestampMs,
    updatedAt: 1 as TimestampMs,
  });
});

test("goal replay treats the queried session as authoritative", async () => {
  const store = new MemoryEventStore();
  const sessionId = "session_goal_authoritative" as SessionId;
  store.items.push(goalUpdatedEvent({
    id: "event_goal_mismatched_session",
    sessionId,
    goalSessionId: "session_goal_wrong" as SessionId,
    objective: "stay in the envelope session",
  }));

  expect(await new GoalService({ store }).getGoal({ sessionId })).toMatchObject({
    sessionId,
    objective: "stay in the envelope session",
  });
});

test("goal replay paginates through late updates and clears", async () => {
  const store = new MemoryEventStore();
  const sessionId = "session_goal_paginated" as SessionId;
  store.items.push(...Array.from({ length: 1_000 }, (_, index) => fillerEvent(
    `event_goal_before_${index}`,
    sessionId,
  )));
  store.items.push(goalUpdatedEvent({
    id: "event_goal_late_update",
    sessionId,
    goalSessionId: sessionId,
    objective: "late goal",
  }));
  const service = new GoalService({ store });

  expect(await service.getGoal({ sessionId })).toMatchObject({ objective: "late goal" });

  store.items.push(...Array.from({ length: 999 }, (_, index) => fillerEvent(
    `event_goal_after_${index}`,
    sessionId,
  )));
  store.items.push({
    id: "event_goal_late_clear",
    type: "goal.cleared",
    time: 3 as TimestampMs,
    sessionId,
    payload: { sessionId, reason: "clear" },
  } as ChiliEvent);

  expect(await service.getGoal({ sessionId })).toBeUndefined();
});

class MemoryEventStore implements EventStore {
  readonly items: ChiliEvent[] = [];

  async append(event: ChiliEvent): Promise<void> {
    this.items.push(event);
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    this.items.push(...events);
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    let events = this.items.filter((event) =>
      (!query.sessionId || event.sessionId === query.sessionId) &&
      (!query.type || event.type === query.type)
    );
    if (query.afterEventId) {
      const index = events.findIndex((event) => event.id === query.afterEventId);
      events = index < 0 ? [] : events.slice(index + 1);
    }
    if (query.limit !== undefined) {
      events = query.tail ? events.slice(-query.limit) : events.slice(0, query.limit);
    }
    return events;
  }

  async sessions(): Promise<[]> {
    return [];
  }

  async messages(): Promise<[]> {
    return [];
  }

  async pendingApprovals(): Promise<[]> {
    return [];
  }
}

function sequentialId(): (prefix: string) => string {
  let value = 0;
  return (prefix) => `${prefix}_${++value}`;
}

function goalUpdatedEvent(input: {
  id: string;
  sessionId: SessionId;
  goalSessionId: SessionId;
  objective: string;
}): ChiliEvent {
  return {
    id: input.id,
    type: "goal.updated",
    time: 2 as TimestampMs,
    sessionId: input.sessionId,
    payload: {
      goal: {
        sessionId: input.goalSessionId,
        objective: input.objective,
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 2 as TimestampMs,
        updatedAt: 2 as TimestampMs,
      },
      reason: "set",
    },
  };
}

function fillerEvent(id: string, sessionId: SessionId): ChiliEvent {
  return {
    id,
    type: "session.status_changed",
    time: 1 as TimestampMs,
    sessionId,
    payload: { sessionId, status: "running" },
  };
}
