import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { GoalService } from "@chili/core";
import type { AgentPath, ChiliEvent, SessionId, TaskId, TimestampMs, TurnId } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import type { AgentTaskRow, EventStore, SessionGoalRow } from "@chili/store";
import { CliPrinter, PrintingEventStore } from "./printing-store.js";

type CreatedEvent = Extract<ChiliEvent, { type: "agent.task_created" }>;

function taskCreated(sessionId: SessionId): CreatedEvent {
  return {
    id: `created_${sessionId}`,
    type: "agent.task_created",
    time: 100 as TimestampMs,
    sessionId,
    payload: {
      taskId: `task_${sessionId}` as TaskId,
      path: "/root/atomic_capabilities" as AgentPath,
      parentPath: "/root" as AgentPath,
      parentSessionId: sessionId,
      childSessionId: `child_${sessionId}` as SessionId,
      taskName: "atomic_capabilities",
      cwd: "/repo",
      prompt: "Inspect the project",
      mode: "background",
    },
  };
}

function mixedWrappers(inner: EventStore, printingOutside: boolean) {
  const printed: ChiliEvent[] = [];
  const observed: ChiliEvent[] = [];
  const printer = new CliPrinter();
  printer.event = (event) => { printed.push(event); };
  const observable = new ObservableEventStore(printingOutside ? inner : new PrintingEventStore(inner, printer));
  const store = printingOutside ? new PrintingEventStore(observable, printer) : observable;
  observable.subscribe((event) => { observed.push(event); });
  return { store, observable, printed, observed };
}

function eventIds(events: readonly { id: string }[]): string[] {
  return events.map((event) => event.id).sort();
}

for (const printingOutside of [false, true]) {
  test(`Goal accounting and task admission commit and notify once through mixed wrappers (printing outside: ${printingOutside})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "chili-atomic-capabilities-"));
    const path = join(directory, "events.sqlite");
    const mirrored: ChiliEvent[] = [];
    const sqlite = new SqliteEventStore(path, { mirror: { async write(event) { mirrored.push(event); } } });
    const peer = new SqliteEventStore(path);
    const { store, observable, printed, observed } = mixedWrappers(sqlite, printingOutside);
    const observedGoals: Promise<{ event: ChiliEvent; goal: SessionGoalRow | undefined }>[] = [];
    const observedTasks: Promise<AgentTaskRow | undefined>[] = [];
    const sessionId = `session_combined_${printingOutside}` as SessionId;
    const event = taskCreated(sessionId);
    const owner = `admission:v1:${sessionId}`;
    const unsubscribe = observable.subscribe((published) => {
      if (published.type === "goal.updated") {
        observedGoals.push(peer.sessionGoal(sessionId).then((goal) => ({ event: published, goal })));
      } else if (published.type === "agent.task_created") {
        observedTasks.push(peer.agentTask(published.payload.taskId));
      }
    });

    try {
      expect(store.supportsGoalMutation()).toBe(true);
      expect(store.supportsAgentTaskCapability("admission")).toBe(true);
      const goals = new GoalService({ store });
      await goals.setGoal({ sessionId, objective: "Keep both atomic capabilities available" });
      const usage = { sessionId, turnId: "turn_combined" as TurnId, usage: { totalTokens: 7 }, timeSeconds: 2 };
      const admission = { event, owner, ttlMs: 1_000, now: 100 };
      const [, admitted] = await Promise.all([
        goals.accountUsage(usage),
        store.admitAgentTask(admission),
      ]);
      expect(admitted).toMatchObject({ applied: true, task: { status: "pending", generation: 0, leaseOwner: owner } });
      await goals.accountUsage(usage);
      expect(await store.admitAgentTask(admission)).toMatchObject({ applied: false, events: [] });

      const persisted = await peer.events({ sessionId });
      expect(persisted).toHaveLength(3);
      expect(persisted.filter((item) => item.type === "goal.updated").map((item) => item.payload)).toEqual([
        expect.objectContaining({ reason: "set" }),
        expect.objectContaining({ usageDelta: expect.objectContaining({ turnId: usage.turnId, tokens: 7, timeSeconds: 2 }) }),
      ]);
      expect(persisted.filter((item) => item.type === "agent.task_created")).toEqual([event]);
      for (const notifications of [printed, observed, mirrored]) {
        expect(eventIds(notifications)).toEqual(eventIds(persisted));
        expect(new Set(notifications.map((item) => item.id)).size).toBe(3);
      }
      for (const { event: published, goal } of await Promise.all(observedGoals)) {
        if (published.type !== "goal.updated") throw new Error("Expected a Goal event");
        expect(goal).toMatchObject(published.payload.goal);
      }
      expect(await Promise.all(observedTasks)).toEqual([
        expect.objectContaining({ status: "pending", generation: 0, leaseOwner: owner, leaseExpiresAt: 1_100 }),
      ]);
      expect(await peer.sessionGoal(sessionId)).toMatchObject({ tokensUsed: 7, timeUsedSeconds: 2 });
    } finally {
      unsubscribe();
      peer.close();
      sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const disabled of ["goal", "admission"] as const) {
    test(`recursive ${disabled} capability denial preserves the other atomic operation (printing outside: ${printingOutside})`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "chili-atomic-capability-denial-"));
      const sqlite = new SqliteEventStore(join(directory, "events.sqlite"));
      // Both forwarding methods remain present; the explicit inner capability
      // decision must survive every outer wrapper without disabling its peer.
      const inner = new ObservableEventStore(sqlite);
      const taskCapability = inner.supportsAgentTaskCapability.bind(inner);
      inner.supportsGoalMutation = () => disabled !== "goal";
      inner.supportsAgentTaskCapability = (capability) => capability === "admission"
        ? disabled !== "admission"
        : taskCapability(capability);
      const { store, printed, observed } = mixedWrappers(inner, printingOutside);
      const sessionId = `session_denied_${disabled}_${printingOutside}` as SessionId;
      const event = taskCreated(sessionId);
      const admission = { event, owner: `admission:v1:${sessionId}`, ttlMs: 1_000, now: 100 };

      try {
        expect(store.supportsGoalMutation()).toBe(disabled !== "goal");
        expect(store.supportsAgentTaskCapability("admission")).toBe(disabled !== "admission");
        if (disabled === "goal") {
          let decisions = 0;
          await expect(store.mutateGoal(sessionId, () => {
            decisions++;
            return { value: "must not run" };
          })).rejects.toThrow("does not support atomic goal mutations");
          expect(decisions).toBe(0);
          expect((await store.admitAgentTask(admission)).applied).toBe(true);
          expect(await sqlite.sessionGoal(sessionId)).toBeUndefined();
          expect(await sqlite.agentTask(event.payload.taskId)).toMatchObject({ leaseOwner: admission.owner });
          expect(await sqlite.events({ sessionId })).toEqual([event]);
        } else {
          expect(await store.admitAgentTask(admission)).toEqual({ applied: false, events: [] });
          const goals = new GoalService({ store });
          await goals.setGoal({ sessionId, objective: "Goal mutations remain available" });
          await goals.accountUsage({ sessionId, turnId: "turn_available" as TurnId, usage: { totalTokens: 5 }, timeSeconds: 1 });
          expect(await sqlite.agentTask(event.payload.taskId)).toBeUndefined();
          expect(await sqlite.sessionGoal(sessionId)).toMatchObject({ tokensUsed: 5 });
          expect(await sqlite.events({ sessionId })).toHaveLength(2);
        }
        const persisted = await sqlite.events({ sessionId });
        expect(eventIds(printed)).toEqual(eventIds(persisted));
        expect(eventIds(observed)).toEqual(eventIds(persisted));
      } finally {
        sqlite.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
