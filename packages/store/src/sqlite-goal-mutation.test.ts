import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ChiliEvent, SessionGoalUpdateReason, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import {
  SessionCreationClaimConflictError,
  SessionRunClaimConflictError,
  SqliteEventStore,
} from "./sqlite-event-store.js";
import type { GoalMutationDecision, GoalMutationSnapshot } from "./types.js";

type GoalUpdatedEvent = Extract<ChiliEvent, { type: "goal.updated" }>;

test("goal mutation snapshots include the latest peer projection and updates in commit order", async () => {
  await withGoalStores(async ({ store, peer }) => {
    const sessionId = "session_goal_snapshot" as SessionId;
    const first = goalUpdated("z_goal_first", sessionId, 0, 300, "set");
    const second = goalUpdated("m_goal_second", sessionId, 5, 200);
    const latest = goalUpdated("a_goal_latest", sessionId, 9, 100);
    await store.append(first);
    expect((await store.sessionGoal(sessionId))?.tokensUsed).toBe(0);
    await peer.appendMany([
      second,
      goalUpdated("event_other_session", "session_other_goal" as SessionId, 99, 150, "set"),
      { id: "event_non_goal", type: "session.created", time: 125 as TimestampMs,
        sessionId, payload: { sessionId, cwd: "/repo" } },
      latest,
    ]);

    const result = await store.mutateGoal(sessionId, (snapshot) => ({ value: snapshot }));
    expect(result.value.goal).toEqual(latest.payload.goal);
    expect(result.value.updatedEvents).toEqual([first, second, latest]);
    expect(result.events).toEqual([]);
    expect(await store.events({ sessionId, type: "goal.updated" })).toEqual([first, second, latest]);
  });
});

test("goal mutation rolls back its event, projection, and usage receipt if projection writing fails", async () => {
  await withGoalStores(async ({ store, peer, db, mirrored }) => {
    const sessionId = "session_goal_rollback" as SessionId;
    const initial = goalUpdated("event_goal_before_failure", sessionId, 0, 1, "set");
    const usage = goalUpdated("event_goal_usage_retry", sessionId, 7, 2);
    const turnId = "turn_goal_usage_retry" as TurnId;
    usage.payload.usageDelta = { turnId, tokens: 7, timeSeconds: 0.7 };
    await store.append(initial);
    mirrored.length = 0;
    db.exec(`create trigger fail_goal_projection after update on session_goals
      when new.tokens_used = 7
      begin select raise(abort, 'injected goal projection failure'); end`);

    const decide = (snapshot: GoalMutationSnapshot) => {
      const alreadyAccounted = snapshot.updatedEvents.some((event) => event.payload.usageDelta?.turnId === turnId);
      return alreadyAccounted ? { value: false } : { value: true, event: usage };
    };
    await expect(store.mutateGoal(sessionId, decide)).rejects.toThrow("injected goal projection failure");
    expect(await peer.sessionGoal(sessionId)).toEqual(initial.payload.goal);
    expect(await peer.events({ sessionId })).toEqual([initial]);
    expect(mirrored).toEqual([]);
    const afterFailure = await store.mutateGoal(sessionId, (snapshot) => ({ value: snapshot.updatedEvents }));
    expect(afterFailure.value.some((event) => event.payload.usageDelta?.turnId === turnId)).toBe(false);

    db.exec("drop trigger fail_goal_projection");
    expect(await store.mutateGoal(sessionId, decide)).toEqual({ value: true, events: [usage] });
    expect(await peer.sessionGoal(sessionId)).toEqual(usage.payload.goal);
    expect(await peer.events({ sessionId })).toEqual([initial, usage]);
    expect(mirrored).toEqual([usage]);
    expect(await store.mutateGoal(sessionId, decide)).toEqual({ value: false, events: [] });
    expect(mirrored).toEqual([usage]);
  });
});

test("goal mutation rejects promise and custom thenable decisions without committing", async () => {
  await withGoalStores(async ({ store, mirrored }) => {
    const sessionId = "session_goal_async_decision" as SessionId;
    const event = goalUpdated("event_goal_async_decision", sessionId, 0, 1, "set");
    let thenCalls = 0;
    const invalidDecisions: unknown[] = [
      Promise.resolve({ value: true, event }),
      { value: true, event, then: () => { thenCalls += 1; } },
    ];
    for (const decision of invalidDecisions) {
      await expect(store.mutateGoal(sessionId, () => decision as GoalMutationDecision<boolean>)).rejects.toThrow();
      expect(await store.sessionGoal(sessionId)).toBeUndefined();
      expect(await store.events({ sessionId })).toEqual([]);
    }
    expect(thenCalls).toBe(0);
    expect(mirrored).toEqual([]);
    expect(await store.mutateGoal(sessionId, () => ({ value: true, event })))
      .toEqual({ value: true, events: [event] });
  });
});

test("goal mutation preserves read-only results and commits clears without inventing history", async () => {
  await withGoalStores(async ({ store, peer, mirrored }) => {
    const sessionId = "session_goal_read_clear" as SessionId;
    expect(await store.mutateGoal(sessionId, (snapshot) => {
      expect(snapshot.goal).toBeUndefined();
      expect(snapshot.updatedEvents).toEqual([]);
      return { value: undefined };
    })).toEqual({ value: undefined, events: [] });
    const initial = goalUpdated("event_goal_read_clear_set", sessionId, 0, 1, "set");
    await store.mutateGoal(sessionId, () => ({ value: "created", event: initial }));
    const clear: Extract<ChiliEvent, { type: "goal.cleared" }> = {
      id: "event_goal_read_clear_cleared",
      type: "goal.cleared",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId, previousGoal: initial.payload.goal, reason: "clear" },
    };
    expect(await store.mutateGoal(sessionId, (snapshot) => ({ value: snapshot.goal, event: clear })))
      .toEqual({ value: initial.payload.goal, events: [clear] });
    expect(await peer.sessionGoal(sessionId)).toBeUndefined();
    const result = await peer.mutateGoal(sessionId, (snapshot) => ({ value: snapshot }));
    expect(result.value.goal).toBeUndefined();
    expect(result.value.updatedEvents).toEqual([initial]);
    expect(result.events).toEqual([]);
    expect(mirrored).toEqual([initial, clear]);
    expect(await store.events({ sessionId })).toEqual([initial, clear]);
  });
});

test("goal mutation rejects events outside its target and mismatched payload identities", async () => {
  await withGoalStores(async ({ store, mirrored }) => {
    const sessionId = "session_goal_event_identity" as SessionId;
    const otherSessionId = "session_goal_identity_other" as SessionId;
    const otherGoal = goalUpdated("event_goal_other_identity", otherSessionId, 0, 1, "set");
    const invalidEvents: ChiliEvent[] = [
      { id: "event_not_a_goal", type: "session.created", time: 1 as TimestampMs,
        sessionId, payload: { sessionId, cwd: "/repo" } },
      otherGoal,
      { ...otherGoal, id: "event_goal_payload_mismatch", sessionId },
      { id: "event_goal_clear_payload_mismatch", type: "goal.cleared", time: 1 as TimestampMs,
        sessionId, payload: { sessionId, previousGoal: otherGoal.payload.goal, reason: "clear" } },
    ];
    for (const event of invalidEvents) {
      await expect(store.mutateGoal(sessionId, () => ({ value: true, event }) as GoalMutationDecision<boolean>))
        .rejects.toThrow();
      expect(await store.sessionGoal(sessionId)).toBeUndefined();
      expect(await store.sessionGoal(otherSessionId)).toBeUndefined();
      expect(await store.events()).toEqual([]);
    }
    expect(mirrored).toEqual([]);
  });
});

test("goal mutation preserves run claim identity and the connection owner fence", async () => {
  await withGoalStores(async ({ store, peer, db }) => {
    const sessionId = "session_goal_run_fence" as SessionId;
    const claimId = "run_claim_goal_mutation";
    const now = Date.now();
    await store.append({ id: "event_goal_run_session", type: "session.created", time: now as TimestampMs,
      sessionId, payload: { sessionId, cwd: "/repo" } });
    expect(store.claimSessionRun({ sessionId, claimId, sessionAccess: "root",
      time: now, leaseDurationMs: 120_000 })).toEqual({ status: "claimed" });
    const event = goalUpdated("event_goal_run_authorized", sessionId, 0, now, "set");
    const decision = () => ({ value: true, event });
    await expect(store.mutateGoal(sessionId, decision, {
      runClaim: { sessionId, claimId: "wrong_claim" },
    })).rejects.toBeInstanceOf(SessionRunClaimConflictError);
    await expect(peer.mutateGoal(sessionId, decision, {
      runClaim: { sessionId, claimId },
    })).rejects.toBeInstanceOf(SessionRunClaimConflictError);
    expect(await store.events({ sessionId, type: "goal.updated" })).toEqual([]);
    expect(await store.mutateGoal(sessionId, decision, { runClaim: { sessionId, claimId } }))
      .toEqual({ value: true, events: [event] });

    db.query("update session_run_claims set lease_expires_at = ? where session_id = ?")
      .run(now - 1, sessionId);
    const stale = goalUpdated("event_goal_stale_run", sessionId, 4, now + 1);
    await expect(store.mutateGoal(sessionId, () => ({ value: true, event: stale })))
      .rejects.toBeInstanceOf(SessionRunClaimConflictError);
    expect(await peer.sessionGoal(sessionId)).toEqual(event.payload.goal);
    expect(await peer.events({ sessionId, type: "goal.updated" })).toEqual([event]);
  });
});

test("goal mutation preserves creation claim identity and the connection owner fence", async () => {
  await withGoalStores(async ({ store, peer, db }) => {
    const sessionId = "session_goal_creation_fence" as SessionId;
    const claimId = "creation_claim_goal_mutation";
    const now = Date.now();
    expect(store.claimSessionCreation({ sessionId, claimId, cwd: "/repo",
      time: now, leaseDurationMs: 120_000 })).toEqual({ status: "claimed" });
    const event = goalUpdated("event_goal_creation_authorized", sessionId, 0, now, "set");
    const decision = () => ({ value: true, event });
    await expect(store.mutateGoal(sessionId, decision, {
      creationClaim: { sessionId, claimId: "wrong_claim" },
    })).rejects.toBeInstanceOf(SessionCreationClaimConflictError);
    await expect(peer.mutateGoal(sessionId, decision, {
      creationClaim: { sessionId, claimId },
    })).rejects.toBeInstanceOf(SessionCreationClaimConflictError);
    expect(await store.events({ sessionId })).toEqual([]);
    expect(await store.mutateGoal(sessionId, decision, { creationClaim: { sessionId, claimId } }))
      .toEqual({ value: true, events: [event] });

    db.query("update session_creation_claims set lease_expires_at = ? where session_id = ?")
      .run(now - 1, sessionId);
    const stale = goalUpdated("event_goal_stale_creation", sessionId, 4, now + 1);
    await expect(store.mutateGoal(sessionId, () => ({ value: true, event: stale })))
      .rejects.toBeInstanceOf(SessionCreationClaimConflictError);
    expect(await peer.sessionGoal(sessionId)).toEqual(event.payload.goal);
    expect(await peer.events({ sessionId })).toEqual([event]);
  });
});

interface GoalStoreFixture {
  store: SqliteEventStore;
  peer: SqliteEventStore;
  db: Database;
  mirrored: ChiliEvent[];
}

async function withGoalStores(run: (fixture: GoalStoreFixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "chili-goal-mutation-"));
  const path = join(dir, "events.sqlite");
  const mirrored: ChiliEvent[] = [];
  const store = new SqliteEventStore(path, { mirror: { write: async (event) => { mirrored.push(event); } } });
  const peer = new SqliteEventStore(path);
  const db = new Database(path, { strict: true });
  try {
    await run({ store, peer, db, mirrored });
  } finally {
    db.close();
    peer.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function goalUpdated(
  id: string,
  sessionId: SessionId,
  tokensUsed: number,
  time: number,
  reason: SessionGoalUpdateReason = "usage",
): GoalUpdatedEvent {
  return {
    id,
    type: "goal.updated",
    time: time as TimestampMs,
    sessionId,
    payload: {
      reason,
      goal: {
        sessionId,
        objective: "finish the atomic goal fixture",
        status: "active",
        tokenBudget: 100,
        tokensUsed,
        timeUsedSeconds: tokensUsed / 10,
        createdAt: 1 as TimestampMs,
        updatedAt: time as TimestampMs,
        lastReason: reason,
      },
    },
  };
}
