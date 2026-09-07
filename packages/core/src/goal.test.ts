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
    turnId: "turn_goal_token_overflow" as TurnId,
    usage: { totalTokens: 1 },
    timeSeconds: 0,
  })).rejects.toThrow("Goal tokensUsed must be a non-negative safe integer");
  await expect(service.accountUsage({
    sessionId,
    turnId: "turn_goal_time_overflow" as TurnId,
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

test("concurrent goal accounting accumulates distinct turns across service instances", async () => {
  const store = new MemoryEventStore();
  const createId = sequentialId();
  const first = new GoalService({ store, createId });
  const second = new GoalService({ store, createId });
  const sessionId = "session_goal_concurrent" as SessionId;
  await first.setGoal({ sessionId, objective: "account concurrent work" });

  await Promise.all([
    first.accountUsage({ sessionId, turnId: "turn_first" as TurnId, usage: { totalTokens: 10 }, timeSeconds: 1 }),
    second.accountUsage({ sessionId, turnId: "turn_second" as TurnId, usage: { totalTokens: 20 }, timeSeconds: 2 }),
  ]);

  expect(await first.getGoal({ sessionId })).toMatchObject({ tokensUsed: 30, timeUsedSeconds: 3 });
});

test("late in-flight accounting preserves a concurrent pause and an exhausted budget cannot resume", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_pause_accounting" as SessionId;
  await service.setGoal({ sessionId, objective: "pause safely", tokenBudget: 10 });
  const scope = await service.captureUsage({ sessionId });

  await Promise.all([
    service.updateGoal({ sessionId, status: "paused" }),
    service.accountUsage({ sessionId, scope, turnId: "turn_paused" as TurnId, usage: { totalTokens: 12 }, timeSeconds: 2 }),
  ]);

  expect(await service.getGoal({ sessionId })).toMatchObject({ status: "paused", tokensUsed: 12, timeUsedSeconds: 2 });
  await expect(service.updateGoal({ sessionId, status: "active" })).rejects.toThrow("must exceed tokens used (12)");
  await expect(service.setGoal({ sessionId, objective: "replace", replace: true })).rejects.toThrow("must exceed tokens used (12)");
  expect(await service.updateGoal({ sessionId, status: "active", tokenBudget: 13 })).toMatchObject({ tokensUsed: 12, status: "active" });
});

test("work started while paused does not charge the goal even if it later resumes", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_paused_work" as SessionId;
  await service.setGoal({ sessionId, objective: "keep paused work separate" });
  await service.updateGoal({ sessionId, status: "paused" });
  const scope = await service.captureUsage({ sessionId });
  await service.accountUsage({ sessionId, turnId: "turn_no_scope" as TurnId, usage: { totalTokens: 5 }, timeSeconds: 1 });
  await service.updateGoal({ sessionId, status: "active" });
  await service.accountUsage({ sessionId, scope, turnId: "turn_paused_work" as TurnId, usage: { totalTokens: 7 }, timeSeconds: 1 });
  expect(await service.getGoal({ sessionId })).toMatchObject({ tokensUsed: 0, timeUsedSeconds: 0 });
});

test("a completed goal retains its terminal state when the completing turn is accounted", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_complete_accounting" as SessionId;
  await service.setGoal({ sessionId, objective: "finish", tokenBudget: 5 });
  const scope = await service.captureUsage({ sessionId });
  await service.updateGoal({ sessionId, status: "complete" });
  await service.accountUsage({ sessionId, scope, turnId: "turn_complete" as TurnId, usage: { totalTokens: 8 }, timeSeconds: 1 });
  expect(await service.getGoal({ sessionId })).toMatchObject({ status: "complete", tokensUsed: 8 });
});

test("clear and recreate fences late accounting even when goal timestamps are identical", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId(), now: () => 1 as TimestampMs });
  const sessionId = "session_goal_recreated" as SessionId;
  await service.setGoal({ sessionId, objective: "old goal" });
  const scope = await service.captureUsage({ sessionId });
  await service.clearGoal({ sessionId });
  await service.accountUsage({ sessionId, scope, turnId: "turn_cleared" as TurnId, usage: { totalTokens: 9 }, timeSeconds: 1 });
  expect(await service.getGoal({ sessionId })).toBeUndefined();
  await service.setGoal({ sessionId, objective: "new goal" });
  await service.accountUsage({ sessionId, scope, turnId: "turn_old_goal" as TurnId, usage: { totalTokens: 9 }, timeSeconds: 1 });
  expect(await service.getGoal({ sessionId })).toMatchObject({ objective: "new goal", tokensUsed: 0 });
});

test("replacing an objective retains the existing budget ledger and in-flight usage", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_replaced" as SessionId;
  const initial = await service.setGoal({ sessionId, objective: "old objective" });
  await service.accountUsage({ sessionId, turnId: "turn_before_replace" as TurnId, usage: { totalTokens: 5 }, timeSeconds: 1 });
  const scope = await service.captureUsage({ sessionId });
  await service.setGoal({ sessionId, objective: "new objective", replace: true });
  await service.accountUsage({ sessionId, scope, turnId: "turn_after_replace" as TurnId, usage: { totalTokens: 7 }, timeSeconds: 2 });
  expect(await service.getGoal({ sessionId })).toMatchObject({ objective: "new objective", tokensUsed: 12, timeUsedSeconds: 3, createdAt: initial.createdAt });
});

test("the turn that creates a goal can account its usage once without a goal at turn start", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_creation_turn" as SessionId;
  const scope = await service.captureUsage({ sessionId });
  await service.setGoal({ sessionId, objective: "created inside the turn" });
  await service.updateGoal({ sessionId, status: "paused" });
  await service.accountUsage({ sessionId, scope, turnId: "turn_create_goal" as TurnId, usage: { totalTokens: 3 }, timeSeconds: 1 });
  expect(await service.getGoal({ sessionId })).toMatchObject({ status: "paused", tokensUsed: 3 });
});

test("turn accounting is durable and idempotent, including after an ambiguous append failure", async () => {
  const store = new MemoryEventStore();
  const createId = sequentialId();
  const service = new GoalService({ store, createId });
  const sessionId = "session_goal_accounting_retry" as SessionId;
  await service.setGoal({ sessionId, objective: "retry safely" });
  const input = { sessionId, turnId: "turn_retried" as TurnId, usage: { totalTokens: 4 }, timeSeconds: 1 };
  const append = store.append.bind(store);
  let fail = true;
  store.append = async (event) => {
    await append(event);
    if (fail) {
      fail = false;
      throw new Error("acknowledgement lost");
    }
  };
  await expect(service.accountUsage(input)).rejects.toThrow("acknowledgement lost");
  const reopened = new GoalService({ store, createId });
  await Promise.all([service.accountUsage(input), reopened.accountUsage(input)]);
  expect(await reopened.getGoal({ sessionId })).toMatchObject({ tokensUsed: 4, timeUsedSeconds: 1 });
  expect(store.items.filter((event) => event.type === "goal.updated" && event.payload.usageDelta)).toHaveLength(1);
});

test("a rejected goal mutation releases its queue and a blocked session does not block peers", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const firstId = "session_goal_slow" as SessionId;
  const secondId = "session_goal_fast" as SessionId;
  await service.setGoal({ sessionId: firstId, objective: "first" });
  await service.setGoal({ sessionId: secondId, objective: "second" });
  await expect(service.updateGoal({ sessionId: firstId, tokenBudget: -1 })).rejects.toThrow();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const append = store.append.bind(store);
  store.append = async (event) => {
    if (event.sessionId === firstId && event.type === "goal.updated" && event.payload.usageDelta) {
      entered.resolve();
      await release.promise;
    }
    await append(event);
  };
  const pending = service.accountUsage({ sessionId: firstId, turnId: "turn_slow" as TurnId, usage: { totalTokens: 2 }, timeSeconds: 1 });
  await entered.promise;
  try {
    await service.accountUsage({ sessionId: secondId, turnId: "turn_fast" as TurnId, usage: { totalTokens: 3 }, timeSeconds: 1 });
    expect(await service.getGoal({ sessionId: secondId })).toMatchObject({ tokensUsed: 3 });
  } finally {
    release.resolve();
    await pending;
  }
});

test("an initially unowned turn cannot charge a second goal created during that turn", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_unowned_recreated" as SessionId;
  const scope = await service.captureUsage({ sessionId });
  await service.setGoal({ sessionId, objective: "first goal" });
  await service.clearGoal({ sessionId });
  await service.setGoal({ sessionId, objective: "second goal" });
  await service.accountUsage({ sessionId, scope, turnId: "turn_spanning_two_goals" as TurnId, usage: { totalTokens: 9 }, timeSeconds: 1 });
  expect(await service.getGoal({ sessionId })).toMatchObject({ objective: "second goal", tokensUsed: 0 });
});

test("usage can retry an uncommitted append and duplicate concurrent setters cannot replace a goal", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_retry_uncommitted" as SessionId;
  const setters = await Promise.allSettled([
    service.setGoal({ sessionId, objective: "first" }),
    service.setGoal({ sessionId, objective: "second" }),
  ]);
  expect(setters.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  const append = store.append.bind(store);
  let fail = true;
  store.append = async (event) => {
    if (fail) {
      fail = false;
      throw new Error("write unavailable");
    }
    await append(event);
  };
  const input = { sessionId, turnId: "turn_uncommitted" as TurnId, usage: { totalTokens: 4 }, timeSeconds: 1 };
  await expect(service.accountUsage(input)).rejects.toThrow("write unavailable");
  await service.accountUsage(input);
  expect(await service.getGoal({ sessionId })).toMatchObject({ objective: "first", tokensUsed: 4, timeUsedSeconds: 1 });
});

test("goal turn receipts survive pagination and reset only when a new ledger is created", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_receipt_pagination" as SessionId;
  const goal = await service.setGoal({ sessionId, objective: "long goal" });
  for (let index = 0; index < 1_001; index += 1) {
    store.items.push({
      id: `event_goal_usage_${index}`,
      type: "goal.updated",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        goal: { ...goal, tokensUsed: index + 1, timeUsedSeconds: index + 1 },
        reason: "usage",
        usageDelta: { turnId: `turn_usage_${index}` as TurnId, tokens: 1, timeSeconds: 1 },
      },
    });
  }
  for (const index of [0, 999, 1_000]) {
    await service.accountUsage({ sessionId, turnId: `turn_usage_${index}` as TurnId, usage: { totalTokens: 1 }, timeSeconds: 1 });
  }
  expect(await service.getGoal({ sessionId })).toMatchObject({ tokensUsed: 1_001, timeUsedSeconds: 1_001 });
  await service.setGoal({ sessionId, objective: "edited objective", replace: true });
  await service.accountUsage({ sessionId, turnId: "turn_usage_0" as TurnId, usage: { totalTokens: 1 }, timeSeconds: 1 });
  expect(await service.getGoal({ sessionId })).toMatchObject({ tokensUsed: 1_001 });
  await service.clearGoal({ sessionId });
  await service.setGoal({ sessionId, objective: "new ledger" });
  await service.accountUsage({ sessionId, turnId: "turn_usage_0" as TurnId, usage: { totalTokens: 1 }, timeSeconds: 1 });
  expect(await service.getGoal({ sessionId })).toMatchObject({ tokensUsed: 1 });
});

test("budget wrap-up usage is counted while keeping the goal budget-limited", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_wrapup_usage" as SessionId;
  await service.setGoal({ sessionId, objective: "wrap up", tokenBudget: 1 });
  await service.accountUsage({ sessionId, turnId: "turn_budget_limit" as TurnId, usage: { totalTokens: 1 }, timeSeconds: 1 });
  const scope = await service.captureUsage({ sessionId, includeBudgetLimited: true });
  await service.accountUsage({ sessionId, scope, turnId: "turn_budget_wrapup" as TurnId, usage: { totalTokens: 2 }, timeSeconds: 1 });
  expect(await service.getGoal({ sessionId })).toMatchObject({ status: "budgetLimited", tokensUsed: 3, timeUsedSeconds: 2 });
  await service.pauseActiveGoal({ sessionId });
  expect(await service.getGoal({ sessionId })).toMatchObject({ status: "budgetLimited" });
  await service.updateGoal({ sessionId, status: "complete" });
  await service.pauseActiveGoal({ sessionId });
  expect(await service.getGoal({ sessionId })).toMatchObject({ status: "complete" });
});

test("ordinary updates cannot impersonate lifecycle events or reset turn receipts", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_reserved_reasons" as SessionId;
  await service.setGoal({ sessionId, objective: "original objective" });
  const input = { sessionId, turnId: "turn_reserved_reason" as TurnId, usage: { totalTokens: 7 }, timeSeconds: 1 };
  await service.accountUsage(input);
  const scope = await service.captureUsage({ sessionId });
  const eventCount = store.items.length;
  for (const reason of ["set", "replace", "clear", "usage"] as const) {
    await expect(service.updateGoal({ sessionId, objective: "spoofed objective", reason })).rejects.toThrow("reserved");
  }
  expect(store.items).toHaveLength(eventCount);
  await service.updateGoal({ sessionId, objective: "updated objective", reason: "external" });
  await service.accountUsage(input);
  await service.accountUsage({ ...input, scope, turnId: "turn_reserved_reason_late" as TurnId });
  expect(await service.getGoal({ sessionId })).toMatchObject({ objective: "updated objective", tokensUsed: 14 });
});

test("capturing a continuation while its goal is cleared cannot turn it into unowned work", async () => {
  const store = new MemoryEventStore();
  const service = new GoalService({ store, createId: sequentialId() });
  const sessionId = "session_goal_cleared_continuation" as SessionId;
  await service.setGoal({ sessionId, objective: "original goal" });
  const original = await service.captureUsage({ sessionId });
  await service.clearGoal({ sessionId });
  const scope = await service.captureUsage({ sessionId, continuationOf: original });
  await service.setGoal({ sessionId, objective: "replacement goal" });
  await service.accountUsage({ sessionId, scope, turnId: "turn_cleared_continuation" as TurnId, usage: { totalTokens: 9 }, timeSeconds: 1 });
  expect(await service.getGoal({ sessionId })).toMatchObject({ objective: "replacement goal", tokensUsed: 0 });
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
