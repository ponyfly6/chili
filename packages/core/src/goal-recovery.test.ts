import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { GoalService } from "./goal.js";

test("missing Goal projections preserve replayed identity, receipts and terminal state after reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-goal-recovery-"));
  const path = join(directory, "events.sqlite");
  const sessionId = "session_goal_recovery" as SessionId;
  let store = new SqliteEventStore(path);
  try {
    let goals = new GoalService({ store });
    await goals.setGoal({ sessionId, objective: "recover from durable events" });
    const scope = await goals.captureUsage({ sessionId });
    const usage = { sessionId, scope, turnId: "turn_before_recovery" as TurnId, usage: { totalTokens: 7 }, timeSeconds: 1 };
    await goals.accountUsage(usage);
    await goals.updateGoal({ sessionId, status: "complete" });
    store.close();
    const database = new Database(path);
    database.query("delete from session_goals where session_id = ?").run(sessionId);
    database.close();
    store = new SqliteEventStore(path);
    goals = new GoalService({ store });

    expect(await goals.getGoal({ sessionId })).toMatchObject({ status: "complete", tokensUsed: 7 });
    expect(await goals.captureUsage({ sessionId })).toMatchObject({ goalEventId: scope.goalEventId, accountStopped: true });
    await expect(goals.setGoal({ sessionId, objective: "accidental new ledger" })).rejects.toThrow("Goal already exists");
    expect((await goals.accountUsage(usage)).usageDelta).toBeUndefined();
    await goals.accountUsage({ ...usage, turnId: "turn_after_recovery" as TurnId, usage: { totalTokens: 3 } });
    expect(await store.sessionGoal(sessionId)).toMatchObject({ status: "complete", tokensUsed: 10, timeUsedSeconds: 2 });
    await goals.clearGoal({ sessionId });
    // A deliberately cleared projection is also absent. Its final event must
    // keep recovery from resurrecting the previous ledger.
    expect(await goals.captureUsage({ sessionId })).toMatchObject({ goalEventId: null, accountStopped: false });
    expect(await goals.getGoal({ sessionId })).toBeUndefined();
    await goals.setGoal({ sessionId, objective: "new ledger after clear" });
    await goals.accountUsage({ ...usage, turnId: "turn_retired" as TurnId });
    expect(await store.sessionGoal(sessionId)).toMatchObject({ objective: "new ledger after clear", tokensUsed: 0 });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("over ten thousand durable receipts survive replay and reset only at clear and recreate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-goal-long-history-"));
  const path = join(directory, "events.sqlite");
  const sessionId = "session_goal_long_history" as SessionId;
  let store = new SqliteEventStore(path);
  try {
    let goals = new GoalService({ store });
    const initial = await goals.setGoal({ sessionId, objective: "long ledger", tokenBudget: 50_000 });
    const scope = await goals.captureUsage({ sessionId });
    const events: RuntimeEvent[] = Array.from({ length: 10_001 }, (_, index) => ({
      id: `event_history_${index}`,
      type: "goal.updated",
      sessionId,
      // Replay follows commit sequence even with decreasing wall-clock times.
      time: (20_000 - index) as TimestampMs,
      payload: {
        reason: "usage",
        goal: { ...initial, tokensUsed: index + 1, timeUsedSeconds: index + 1, updatedAt: (20_000 - index) as TimestampMs },
        usageDelta: { turnId: `turn_history_${index}` as TurnId, tokens: 1, timeSeconds: 1 },
      },
    }));
    await store.appendMany(events);
    store.close();
    store = new SqliteEventStore(path);
    goals = new GoalService({ store });
    const usage = { sessionId, scope, turnId: "turn_history_0" as TurnId, usage: { totalTokens: 1 }, timeSeconds: 1 };
    expect((await goals.accountUsage(usage)).usageDelta).toBeUndefined();
    expect(await goals.getGoal({ sessionId })).toMatchObject({ tokensUsed: 10_001, timeUsedSeconds: 10_001 });
    await goals.clearGoal({ sessionId });
    await goals.setGoal({ sessionId, objective: "fresh ledger" });
    const freshScope = await goals.captureUsage({ sessionId });
    expect(freshScope.goalEventId).not.toBe(scope.goalEventId);
    await goals.accountUsage({ ...usage, turnId: "turn_retired_late" as TurnId });
    await goals.accountUsage({ ...usage, scope: freshScope });
    await goals.accountUsage({ ...usage, scope: freshScope });
    expect(await goals.getGoal({ sessionId })).toMatchObject({ objective: "fresh ledger", tokensUsed: 1, timeUsedSeconds: 1 });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
