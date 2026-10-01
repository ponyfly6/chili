import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TimestampMs } from "@chili/protocol";
import { ObservableEventStore } from "./observable-event-store.js";
import type {
  EventAppendOptions,
  EventStore,
  GoalMutationCapabilityStore,
  GoalMutationDecision,
  GoalMutationEvent,
  GoalMutationResult,
  GoalMutationSnapshot,
  GoalMutationStore,
} from "./types.js";

const sessionId = "session_observable_goal_mutation" as SessionId;
const clearEvent: GoalMutationEvent = {
  id: "event_observable_goal_cleared",
  type: "goal.cleared",
  time: 1 as TimestampMs,
  sessionId,
  payload: { sessionId },
};

function appendOnlyStore(): EventStore {
  return {
    async append() { throw new Error("Goal mutations must not append again"); },
    async appendMany() { throw new Error("Goal mutations must not append again"); },
    async events() { return []; },
    async sessions() { return []; },
    async messages() { return []; },
    async pendingApprovals() { return []; },
  };
}

test("observable goal capability follows nested wrappers and rejects unsupported mutations", async () => {
  let decisions = 0;
  let mutations = 0;
  const capable: EventStore & GoalMutationStore = {
    ...appendOnlyStore(),
    async mutateGoal<T>(_sessionId: SessionId, decide: (snapshot: GoalMutationSnapshot) => GoalMutationDecision<T>) {
      mutations++;
      const decision = decide({ updatedEvents: [] });
      return { value: decision.value, events: [] };
    },
  };
  const disabled: EventStore & GoalMutationStore & GoalMutationCapabilityStore = {
    ...capable,
    supportsGoalMutation: () => false,
  };
  const declaredWithoutMethod = { ...appendOnlyStore(), supportsGoalMutation: () => true };
  for (const inner of [appendOnlyStore(), disabled, declaredWithoutMethod]) {
    const first = new ObservableEventStore(inner);
    const second = new ObservableEventStore(first);
    expect(first.supportsGoalMutation()).toBe(false);
    expect(second.supportsGoalMutation()).toBe(false);
    await expect(second.mutateGoal(sessionId, () => {
      decisions++;
      return { value: "unsupported", event: clearEvent };
    })).rejects.toThrow("does not support atomic goal mutations");
  }
  expect(decisions).toBe(0);
  expect(mutations).toBe(0);

  const supported = new ObservableEventStore(new ObservableEventStore(capable));
  expect(supported.supportsGoalMutation()).toBe(true);
  expect(await supported.mutateGoal(sessionId, () => ({ value: "read" }))).toEqual({ value: "read", events: [] });
  expect(mutations).toBe(1);
});

test("observable goal mutations forward options and emit only after commit without appending again", async () => {
  let releaseCommit!: () => void;
  const commit = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const snapshot: GoalMutationSnapshot = { updatedEvents: [] };
  const options: EventAppendOptions = { runClaim: { sessionId, claimId: "claim_goal" } };
  let receivedSession: SessionId | undefined;
  let receivedOptions: EventAppendOptions | undefined;
  let receivedDecide: unknown;
  let committed = false;
  const inner: EventStore & GoalMutationStore = {
    ...appendOnlyStore(),
    async mutateGoal<T>(
      target: SessionId,
      decide: (snapshot: GoalMutationSnapshot) => GoalMutationDecision<T>,
      appendOptions?: EventAppendOptions,
    ): Promise<GoalMutationResult<T>> {
      receivedSession = target;
      receivedOptions = appendOptions;
      receivedDecide = decide;
      const decision = decide(snapshot);
      await commit;
      committed = true;
      return { value: decision.value, events: decision.event ? [decision.event] : [] };
    },
  };
  const first = new ObservableEventStore(inner);
  const second = new ObservableEventStore(first);
  const firstEvents: ChiliEvent[] = [];
  const secondEvents: ChiliEvent[] = [];
  const prematureEvents: ChiliEvent[] = [];
  first.subscribe((event) => {
    if (!committed) prematureEvents.push(event);
    firstEvents.push(event);
  });
  second.subscribe((event) => secondEvents.push(event));
  const value = { operation: "clear" };
  const decide = (received: GoalMutationSnapshot) => {
    expect(received).toBe(snapshot);
    return { value, event: clearEvent };
  };
  const pending = second.mutateGoal(sessionId, decide, options);

  expect(receivedSession).toBe(sessionId);
  expect(receivedOptions).toBe(options);
  expect(receivedDecide).toBe(decide);
  expect(firstEvents).toEqual([]);
  expect(secondEvents).toEqual([]);
  releaseCommit();
  const result = await pending;
  expect(result.value).toBe(value);
  expect(result.events).toEqual([clearEvent]);
  expect(firstEvents).toEqual([clearEvent]);
  expect(secondEvents).toEqual([clearEvent]);
  expect(prematureEvents).toEqual([]);
});

test("observable goal mutation emits no events for committed no-ops or failed commits", async () => {
  let fail = false;
  const inner: EventStore & GoalMutationStore = {
    ...appendOnlyStore(),
    async mutateGoal<T>(_sessionId: SessionId, decide: (snapshot: GoalMutationSnapshot) => GoalMutationDecision<T>) {
      const decision = decide({ updatedEvents: [] });
      if (fail) throw new Error("commit failed");
      // The store can suppress an already committed event, even if proposed again.
      return { value: decision.value, events: [] };
    },
  };
  const store = new ObservableEventStore(inner);
  const observed: ChiliEvent[] = [];
  store.subscribe((event) => observed.push(event));
  expect(await store.mutateGoal(sessionId, () => ({ value: "duplicate", event: clearEvent }))).toEqual({
    value: "duplicate",
    events: [],
  });
  expect(await store.mutateGoal(sessionId, () => ({ value: "read" }))).toEqual({ value: "read", events: [] });
  fail = true;
  await expect(store.mutateGoal(sessionId, () => ({ value: "failed", event: clearEvent }))).rejects.toThrow("commit failed");
  expect(observed).toEqual([]);
});
