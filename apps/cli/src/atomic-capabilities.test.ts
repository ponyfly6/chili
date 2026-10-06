import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { GoalService } from "@chili/core";
import type { ChiliEvent, SessionId, TurnId } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import type { EventStore, SessionGoalRow } from "@chili/store";
import { CliPrinter, PrintingEventStore } from "./printing-store.js";

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

for (const printingOutside of [false, true]) {
  test(`Goal accounting commits and notifies once through mixed wrappers (printing outside: ${printingOutside})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "chili-goal-accounting-"));
    const path = join(directory, "events.sqlite");
    const mirrored: ChiliEvent[] = [];
    const sqlite = new SqliteEventStore(path, { mirror: { async write(event) { mirrored.push(event); } } });
    const peer = new SqliteEventStore(path);
    const { store, observable, printed, observed } = mixedWrappers(sqlite, printingOutside);
    const observedGoals: Promise<{ event: ChiliEvent; goal: SessionGoalRow | undefined }>[] = [];
    const sessionId = `session_accounting_${printingOutside}` as SessionId;
    const unsubscribe = observable.subscribe((event) => {
      if (event.type === "goal.updated") {
        observedGoals.push(peer.sessionGoal(sessionId).then((goal) => ({ event, goal })));
      }
    });
    try {
      expect(store.supportsGoalMutation()).toBe(true);
      const goals = new GoalService({ store });
      await goals.setGoal({ sessionId, objective: "Preserve goal accounting" });
      const usage = { sessionId, turnId: "turn_accounting" as TurnId, usage: { totalTokens: 7 }, timeSeconds: 2 };
      await goals.accountUsage(usage);
      await goals.accountUsage(usage);
      const persisted = await peer.events({ sessionId });
      expect(persisted).toHaveLength(2);
      for (const notifications of [printed, observed, mirrored]) {
        expect(notifications.map((event) => event.id)).toEqual(persisted.map((event) => event.id));
      }
      for (const { event, goal } of await Promise.all(observedGoals)) {
        if (event.type !== "goal.updated") throw new Error("Expected a Goal event");
        expect(goal).toMatchObject(event.payload.goal);
      }
      expect(await peer.sessionGoal(sessionId)).toMatchObject({ tokensUsed: 7, timeUsedSeconds: 2 });
    } finally {
      unsubscribe();
      peer.close();
      sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
