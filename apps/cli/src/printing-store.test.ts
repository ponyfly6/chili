import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import type {
  EventAppendOptions,
  EventStore,
  GoalMutationDecision,
  GoalMutationEvent,
  GoalMutationResult,
  GoalMutationSnapshot,
  GoalMutationStore,
  SessionGoalRow,
} from "@chili/store";
import { CliPrinter, PrintingEventStore } from "./printing-store.js";

function goalMutationAppendOnlyStore(): EventStore {
  return {
    async append() { throw new Error("Goal mutations must not append again"); },
    async appendMany() { throw new Error("Goal mutations must not append again"); },
    async events() { return []; },
    async sessions() { return []; },
    async messages() { return []; },
    async pendingApprovals() { return []; },
  };
}

test("printing goal capability follows mixed wrapper chains and rejects unsupported stores", async () => {
  const sessionId = "session_printing_goal_capability" as SessionId;
  const printed: ChiliEvent[] = [];
  const printer = new CliPrinter();
  printer.event = (event) => { printed.push(event); };
  let mutations = 0;
  let decisions = 0;
  const capable: EventStore & GoalMutationStore = {
    ...goalMutationAppendOnlyStore(),
    async mutateGoal<T>(_sessionId: SessionId, decide: (snapshot: GoalMutationSnapshot) => GoalMutationDecision<T>) {
      mutations++;
      const decision = decide({ updatedEvents: [] });
      return { value: decision.value, events: [] };
    },
  };
  for (const inner of [
    goalMutationAppendOnlyStore(),
    { ...capable, supportsGoalMutation: () => false },
    { ...goalMutationAppendOnlyStore(), supportsGoalMutation: () => true },
  ]) {
    const printing = new PrintingEventStore(new ObservableEventStore(inner), printer);
    const outer = new ObservableEventStore(new PrintingEventStore(printing, printer));
    expect(printing.supportsGoalMutation()).toBe(false);
    expect(outer.supportsGoalMutation()).toBe(false);
    await expect(outer.mutateGoal(sessionId, () => {
      decisions++;
      return { value: "unsupported" };
    })).rejects.toThrow("does not support atomic goal mutations");
  }
  expect(mutations).toBe(0);
  expect(decisions).toBe(0);
  expect(printed).toEqual([]);
  const supported = new PrintingEventStore(new ObservableEventStore(new PrintingEventStore(capable, printer)), printer);
  expect(supported.supportsGoalMutation()).toBe(true);
  expect(await supported.mutateGoal(sessionId, () => ({ value: "read" }))).toEqual({ value: "read", events: [] });
  expect(mutations).toBe(1);
  expect(printed).toEqual([]);
});

for (const printingOutside of [false, true]) {
  test(`goal mutation waits for commit and notifies each mixed wrapper once (printing outside: ${printingOutside})`, async () => {
    const sessionId = "session_printing_goal_commit" as SessionId;
    const event: GoalMutationEvent = {
      id: "event_printing_goal_commit",
      type: "goal.cleared",
      sessionId,
      time: 1 as TimestampMs,
      payload: { sessionId },
    };
    const options: EventAppendOptions = { runClaim: { sessionId, claimId: "goal_commit_claim" } };
    const printed: ChiliEvent[] = [];
    const observed: ChiliEvent[] = [];
    const prematureEvents: ChiliEvent[] = [];
    let committed = false;
    let fail = false;
    let releaseCommit!: () => void;
    const commit = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let receivedSession: SessionId | undefined;
    let receivedOptions: EventAppendOptions | undefined;
    const inner: EventStore & GoalMutationStore = {
      ...goalMutationAppendOnlyStore(),
      async mutateGoal<T>(
        target: SessionId,
        decide: (snapshot: GoalMutationSnapshot) => GoalMutationDecision<T>,
        appendOptions?: EventAppendOptions,
      ): Promise<GoalMutationResult<T>> {
        receivedSession = target;
        receivedOptions = appendOptions;
        const decision = decide({ updatedEvents: [] });
        await commit;
        if (fail) throw new Error("goal commit failed");
        if (committed) return { value: decision.value, events: [] };
        committed = true;
        return { value: decision.value, events: decision.event ? [decision.event] : [] };
      },
    };
    const printer = new CliPrinter();
    printer.event = (printedEvent) => {
      if (!committed) prematureEvents.push(printedEvent);
      printed.push(printedEvent);
    };
    const observable = new ObservableEventStore(printingOutside ? inner : new PrintingEventStore(inner, printer));
    const store = printingOutside ? new PrintingEventStore(observable, printer) : observable;
    observable.subscribe((observedEvent) => {
      if (!committed) prematureEvents.push(observedEvent);
      observed.push(observedEvent);
    });
    const value = { status: "cleared" };
    const pending = store.mutateGoal(sessionId, () => ({ value, event }), options);
    expect(receivedSession).toBe(sessionId);
    expect(receivedOptions).toBe(options);
    expect(printed).toEqual([]);
    expect(observed).toEqual([]);
    releaseCommit();
    const result = await pending;
    expect(result.value).toBe(value);
    expect(result.events).toEqual([event]);
    expect(printed).toEqual([event]);
    expect(observed).toEqual([event]);
    expect(prematureEvents).toEqual([]);

    expect(await store.mutateGoal(sessionId, () => ({ value: "duplicate", event }))).toEqual({ value: "duplicate", events: [] });
    expect(await store.mutateGoal(sessionId, () => ({ value: "read" }))).toEqual({ value: "read", events: [] });
    fail = true;
    await expect(store.mutateGoal(sessionId, () => ({ value: "failed", event }))).rejects.toThrow("goal commit failed");
    expect(printed).toEqual([event]);
    expect(observed).toEqual([event]);
  });
}

test("printing and observable goal mutations publish committed SQLite projections without duplicates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-printing-goal-mutation-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_printing_atomic_goal" as SessionId;
  const printed: ChiliEvent[] = [];
  const observed: ChiliEvent[] = [];
  const observedGoals: Promise<SessionGoalRow | undefined>[] = [];
  const printer = new CliPrinter();
  printer.event = (event) => { printed.push(event); };
  const store = new ObservableEventStore(new PrintingEventStore(sqlite, printer));
  const unsubscribe = store.subscribe((event) => {
    observed.push(event);
    observedGoals.push(sqlite.sessionGoal(sessionId));
  });
  const event: GoalMutationEvent = {
    id: "event_printing_atomic_goal_set",
    type: "goal.updated",
    sessionId,
    time: 1 as TimestampMs,
    payload: {
      reason: "set",
      goal: {
        sessionId,
        objective: "commit once and notify once",
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1 as TimestampMs,
        updatedAt: 1 as TimestampMs,
      },
    },
  };

  try {
    expect(store.supportsGoalMutation()).toBe(true);
    const created = await store.mutateGoal(sessionId, (snapshot) => {
      expect(snapshot.goal).toBeUndefined();
      expect(snapshot.updatedEvents).toEqual([]);
      return { value: "created", event };
    });
    expect(created).toEqual({ value: "created", events: [event] });
    const duplicate = await store.mutateGoal(sessionId, (snapshot) => {
      expect(snapshot.goal?.objective).toBe(event.payload.goal.objective);
      expect(snapshot.updatedEvents).toEqual([event]);
      return { value: "duplicate" };
    });
    expect(duplicate).toEqual({ value: "duplicate", events: [] });
    expect(await store.mutateGoal(sessionId, (snapshot) => ({ value: snapshot.goal?.status })))
      .toEqual({ value: "active", events: [] });
    const failed: GoalMutationEvent = { ...event, id: "event_printing_atomic_goal_failed" };
    await expect(store.mutateGoal(sessionId, () => ({ value: "failed", event: failed }), {
      runClaim: { sessionId, claimId: "absent_claim" },
    })).rejects.toThrow();

    expect(printed).toEqual([event]);
    expect(observed).toEqual([event]);
    expect(await Promise.all(observedGoals)).toEqual([expect.objectContaining(event.payload.goal)]);
    expect(await sqlite.events({ sessionId, type: "goal.updated" })).toEqual([event]);
  } finally {
    unsubscribe();
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("printing and observable wrappers forward committed stale-turn recovery without duplicates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-printing-stale-recovery-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const printed: ChiliEvent[] = [];
  const printer = new CliPrinter();
  printer.event = (event: ChiliEvent) => {
    printed.push(event);
  };
  const store = new ObservableEventStore(new PrintingEventStore(sqlite, printer));
  const observed: ChiliEvent[] = [];
  const unsubscribe = store.subscribe((event) => observed.push(event));
  const sessionId = "session_printing_stale" as SessionId;
  const turnId = "turn_printing_stale" as TurnId;
  let recoveryId = 0;

  try {
    await store.appendMany([
      {
        id: "event_printing_stale_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: dir },
      },
      {
        id: "event_printing_stale_running",
        type: "session.status_changed",
        time: 2 as TimestampMs,
        sessionId,
        payload: { sessionId, status: "running" },
      },
      {
        id: "event_printing_stale_turn",
        type: "turn.started",
        time: 3 as TimestampMs,
        sessionId,
        payload: { turnId },
      },
    ]);
    printed.length = 0;
    observed.length = 0;

    const recovered = await store.reconcileStaleTurns({
      staleBefore: 10,
      now: 11,
      status: "failed",
      reason: "stale_turn_recovered",
      createId: (prefix) => `${prefix}_printing_recovery_${++recoveryId}`,
    });

    expect(recovered.map((event) => event.type)).toEqual(["turn.completed", "session.status_changed"]);
    expect(printed).toEqual(recovered);
    expect(observed).toEqual(recovered);
    expect((await sqlite.events({ sessionId, type: "turn.completed", limit: 10 }))).toHaveLength(1);
    expect(await store.reconcileStaleTurns({
      staleBefore: 20,
      now: 21,
      createId: (prefix) => `${prefix}_duplicate_recovery`,
    })).toEqual([]);
    expect(printed).toEqual(recovered);
    expect(observed).toEqual(recovered);
  } finally {
    unsubscribe();
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("printing and observable wrappers forward session goal projections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-printing-session-goal-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const printer = { event: (_event: ChiliEvent) => undefined } as CliPrinter;
  const store = new ObservableEventStore(new PrintingEventStore(sqlite, printer));
  const sessionId = "session_printing_goal" as SessionId;

  try {
    await store.append({
      id: "event_printing_goal_updated",
      type: "goal.updated",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        reason: "set",
        goal: {
          sessionId,
          objective: "finish the CLI migration",
          status: "active",
          tokenBudget: 10_000,
          tokensUsed: 25,
          timeUsedSeconds: 2,
          createdAt: 1 as TimestampMs,
          updatedAt: 2 as TimestampMs,
        },
      },
    });

    expect(await store.sessionGoal(sessionId)).toMatchObject({
      sessionId,
      objective: "finish the CLI migration",
      tokensUsed: 25,
    });
    expect(await store.sessionGoals({ sessionId, limit: 1 })).toHaveLength(1);
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});
