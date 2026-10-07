import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { CliPrinter, PrintingEventStore } from "./printing-store.js";

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
