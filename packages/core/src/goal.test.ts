import { expect, test } from "bun:test";
import type { ChiliEvent, EventEnvelope, SessionId, TimestampMs } from "@chili/protocol";
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
