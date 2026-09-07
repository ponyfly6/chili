import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TurnId } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { GoalService } from "./goal.js";

test("separate SQLite connections accumulate distinct turns and deduplicate shared receipts", async () => {
  await withGoals(async ({ goals, peerGoals, store, sessionId }) => {
    await goals.setGoal({ sessionId, objective: "concurrent ledger" });
    const scope = await goals.captureUsage({ sessionId });
    const usage = { sessionId, scope, timeSeconds: 1 };
    await Promise.all([
      goals.accountUsage({ ...usage, turnId: "turn_a" as TurnId, usage: { totalTokens: 10 } }),
      peerGoals.accountUsage({ ...usage, turnId: "turn_b" as TurnId, usage: { totalTokens: 20 } }),
    ]);
    const duplicate = { ...usage, turnId: "turn_shared" as TurnId, usage: { totalTokens: 7 } };
    await Promise.all([goals.accountUsage(duplicate), peerGoals.accountUsage(duplicate)]);
    expect(await goals.getGoal({ sessionId })).toMatchObject({ tokensUsed: 37, timeUsedSeconds: 3 });
    const events = await store.events({ sessionId, type: "goal.updated" }) as Extract<ChiliEvent, { type: "goal.updated" }>[];
    const receipts = events.filter((event) => event.payload.usageDelta);
    expect(receipts).toHaveLength(3);
    expect(receipts.filter((event) => event.payload.usageDelta?.turnId === duplicate.turnId))
      .toHaveLength(1);
  });
});

test("a peer pause cannot be overwritten by in-flight accounting and replacement fences survive transactions", async () => {
  await withGoals(async ({ goals, peerGoals, sessionId }) => {
    await goals.setGoal({ sessionId, objective: "original", tokenBudget: 10 });
    const scope = await goals.captureUsage({ sessionId });
    await Promise.all([
      peerGoals.pauseActiveGoal({ sessionId }),
      goals.accountUsage({ sessionId, scope, turnId: "turn_in_flight" as TurnId, usage: { totalTokens: 12 }, timeSeconds: 2 }),
    ]);
    expect(await goals.getGoal({ sessionId })).toMatchObject({ status: "paused", tokensUsed: 12 });
    await expect(peerGoals.updateGoal({ sessionId, status: "active" })).rejects.toThrow("must exceed tokens used (12)");
    await peerGoals.setGoal({ sessionId, objective: "replacement", replace: true, tokenBudget: 30 });
    await goals.accountUsage({ sessionId, scope, turnId: "turn_replacement" as TurnId, usage: { totalTokens: 3 }, timeSeconds: 1 });
    expect(await peerGoals.getGoal({ sessionId })).toMatchObject({ objective: "replacement", tokensUsed: 15 });
    await peerGoals.clearGoal({ sessionId });
    await peerGoals.setGoal({ sessionId, objective: "new ledger" });
    await goals.accountUsage({ sessionId, scope, turnId: "turn_retired" as TurnId, usage: { totalTokens: 20 }, timeSeconds: 1 });
    expect(await goals.getGoal({ sessionId })).toMatchObject({ objective: "new ledger", tokensUsed: 0 });
  });
});

test("atomic capture and decisions never mix projection or history reads outside their snapshot", async () => {
  await withGoals(async ({ goals, peerGoals, store, sessionId }) => {
    // These asynchronous APIs may observe different commits. The atomic path
    // must obtain both ledger identity and status from mutateGoal's snapshot.
    store.sessionGoal = async () => { throw new Error("out-of-transaction projection read"); };
    store.events = async () => { throw new Error("out-of-transaction history read"); };
    const unownedScope = await goals.captureUsage({ sessionId });
    await goals.setGoal({ sessionId, objective: "created during work" });
    await goals.accountUsage({ sessionId, scope: unownedScope, turnId: "turn_create" as TurnId, usage: { totalTokens: 4 }, timeSeconds: 1 });
    const scope = await goals.captureUsage({ sessionId });
    await peerGoals.updateGoal({ sessionId, status: "complete" });
    await goals.accountUsage({ sessionId, scope, turnId: "turn_complete" as TurnId, usage: { totalTokens: 6 }, timeSeconds: 1 });
    expect(await peerGoals.getGoal({ sessionId })).toMatchObject({ status: "complete", tokensUsed: 10 });
    await goals.clearGoal({ sessionId });
    expect(await peerGoals.getGoal({ sessionId })).toBeUndefined();
  });
});

test("a lost mirror acknowledgement leaves one durable receipt and releases the local queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-goal-mirror-retry-"));
  const path = join(directory, "events.sqlite");
  const sessionId = "session_goal_mirror_retry" as SessionId;
  let fail = false;
  const mirrored: ChiliEvent[] = [];
  const store = new SqliteEventStore(path, {
    mirror: { async write(event) {
      mirrored.push(event);
      if (fail) throw new Error("mirror failed after commit");
    } },
    onMirrorError(error) { throw error; },
  });
  const peer = new SqliteEventStore(path);
  try {
    const goals = new GoalService({ store });
    await goals.setGoal({ sessionId, objective: "lost acknowledgement" });
    const scope = await goals.captureUsage({ sessionId });
    const input = { sessionId, scope, turnId: "turn_lost_ack" as TurnId, usage: { totalTokens: 7 }, timeSeconds: 2 };
    fail = true;
    await expect(goals.accountUsage(input)).rejects.toThrow("mirror failed after commit");
    expect(await peer.sessionGoal(sessionId)).toMatchObject({ tokensUsed: 7 });
    fail = false;
    expect((await goals.accountUsage(input)).usageDelta).toBeUndefined();
    expect((await new GoalService({ store: peer }).accountUsage(input)).usageDelta).toBeUndefined();
    expect(await peer.sessionGoal(sessionId)).toMatchObject({ tokensUsed: 7, timeUsedSeconds: 2 });
    expect(mirrored).toHaveLength(2);
    await goals.updateGoal({ sessionId, status: "complete" });
    expect(await peer.sessionGoal(sessionId)).toMatchObject({ status: "complete", tokensUsed: 7 });
  } finally {
    store.close();
    peer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("observable goal callbacks can start another connection's write after the transaction commits", async () => {
  await withGoals(async ({ store, peerGoals, sessionId }) => {
    const observable = new ObservableEventStore(store);
    const goals = new GoalService({ store: observable });
    let followup: Promise<unknown> | undefined;
    observable.subscribe((event) => {
      if (event.type === "goal.updated" && event.payload.reason === "set") {
        followup = peerGoals.updateGoal({ sessionId, status: "paused" });
      }
    });
    await goals.setGoal({ sessionId, objective: "commit before callback" });
    expect(followup).toBeDefined();
    await followup;
    expect(await goals.getGoal({ sessionId })).toMatchObject({ status: "paused" });
  });
});

async function withGoals(run: (input: {
  goals: GoalService;
  peerGoals: GoalService;
  store: SqliteEventStore;
  sessionId: SessionId;
}) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "chili-goal-atomic-"));
  const path = join(directory, "events.sqlite");
  const store = new SqliteEventStore(path);
  const peer = new SqliteEventStore(path);
  try {
    await run({
      goals: new GoalService({ store }),
      peerGoals: new GoalService({ store: peer }),
      store,
      sessionId: "session_goal_atomic" as SessionId,
    });
  } finally {
    store.close();
    peer.close();
    await rm(directory, { recursive: true, force: true });
  }
}
