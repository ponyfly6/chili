import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import type { ChiliEvent, MessageId, PartId, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore, type EventStore } from "@chili/store";
import { CliPrinter, PrintingEventStore } from "./printing-store.js";

const printSessionId = "session_print" as SessionId;
const printMessageId = "message_print" as MessageId;
const printPartId = "part_print" as PartId;

test("CLI prints streaming text once across overlap, snapshots, final commit and late deltas", () => {
  const output = capturePrinter((printer) => {
    printer.event(printEvent("message.created", { messageId: printMessageId, role: "assistant" }));
    printer.event(printEvent("message.part_stream_delta", {
      messageId: printMessageId, partId: printPartId, partType: "text", delta: "Hi 🌶", offset: 0,
    }));
    printer.event(printEvent("message.part_stream_delta", {
      messageId: printMessageId, partId: printPartId, partType: "text", delta: "🌶 there", offset: 3,
    }));
    printer.event(printEvent("message.part_stream_snapshot", {
      messageId: printMessageId, part: textPart("Hi 🌶 there"),
    }));
    printer.event(printEvent("message.part_committed", {
      messageId: printMessageId, part: { ...textPart("Hi 🌶 there!"), completion: "completed" },
    }));
    printer.event(printEvent("message.part_stream_delta", {
      messageId: printMessageId, partId: printPartId, partType: "text", delta: "! stale", offset: 11,
    }));
    printer.event(printEvent("message.part_committed", {
      messageId: printMessageId, part: { ...textPart("Hi 🌶 there!"), completion: "completed" },
    }));
  });
  expect(output).toBe("Hi 🌶 there!");
});

test("CLI repairs missing streamed text from a snapshot and saves cancelled text without duplication", () => {
  const output = capturePrinter((printer) => {
    printer.event(printEvent("message.created", { messageId: printMessageId, role: "assistant" }));
    printer.event(printEvent("message.part_stream_delta", {
      messageId: printMessageId, partId: printPartId, partType: "text", delta: "Hello", offset: 0,
    }));
    printer.event(printEvent("message.part_stream_delta", {
      messageId: printMessageId, partId: printPartId, partType: "text", delta: "world", offset: 6,
    }));
    printer.event(printEvent("message.part_stream_snapshot", {
      messageId: printMessageId, part: textPart("Hello world"),
    }));
    printer.event(printEvent("message.part_stream_snapshot", {
      messageId: printMessageId, part: textPart("Hello"),
    }));
    printer.event(printEvent("message.part_committed", {
      messageId: printMessageId, part: { ...textPart("Hello world, part"), completion: "cancelled" },
    }));
  });
  expect(output).toBe("Hello world, part");
});

test("CLI prints a full failed block without streamed deltas and keeps reasoning and user input silent", () => {
  const output = capturePrinter((printer) => {
    printer.event(printEvent("message.created", { messageId: printMessageId, role: "assistant" }));
    printer.event(printEvent("message.part_stream_delta", {
      messageId: printMessageId, partId: "part_reasoning", partType: "reasoning", delta: "Thinking", offset: 0,
    }));
    printer.event(printEvent("message.part_committed", {
      messageId: printMessageId, part: { ...textPart("Thinking"), id: "part_reasoning" as PartId, type: "reasoning", completion: "completed" },
    }));
    printer.event(printEvent("message.part_committed", {
      messageId: printMessageId, part: { ...textPart("Partial answer"), completion: "failed" },
    }));
    const userMessageId = "message_user" as MessageId;
    printer.event(printEvent("message.created", { messageId: userMessageId, role: "user" }));
    printer.event(printEvent("message.part_added", {
      messageId: userMessageId, part: { ...textPart("User input"), messageId: userMessageId, id: "part_user" as PartId },
    }));
  });
  expect(output).toBe("Partial answer");
});

test("CLI continues printing legacy delta history", () => {
  const output = capturePrinter((printer) => {
    printer.event(printEvent("message.created", { messageId: printMessageId, role: "assistant" }));
    printer.event(printEvent("message.part_added", { messageId: printMessageId, part: textPart("Hello") }));
    printer.event(printEvent("message.part_delta", {
      messageId: printMessageId, partId: printPartId, field: "text", delta: " world",
    }));
  });
  expect(output).toBe("Hello world");
});

test("printing wrapper preserves optional recovery capabilities and their absence", async () => {
  const inner: EventStore = {
    append: async () => {},
    appendMany: async () => {},
    events: async () => [],
    sessions: async () => [],
    messages: async () => [],
    pendingApprovals: async () => [],
  };
  const absent = new PrintingEventStore(inner, new CliPrinter());
  expect(absent.eventReplayBoundary).toBeUndefined();
  expect(absent.runtimeSnapshot).toBeUndefined();
  expect(absent.activeMessageParts).toBeUndefined();

  const sqliteDir = await mkdtemp(join(tmpdir(), "chili-printing-capabilities-"));
  const sqlite = new SqliteEventStore(join(sqliteDir, "events.sqlite"));
  try {
    const observable = new ObservableEventStore(sqlite);
    const store = new PrintingEventStore(observable, new CliPrinter());
    expect(store.eventReplayBoundary).toBeFunction();
    expect(store.runtimeSnapshot).toBeFunction();
    expect(store.activeMessageParts).toBeFunction();
    expect(await store.eventReplayBoundary!({ sessionId: printSessionId })).toEqual(
      await sqlite.eventReplayBoundary({ sessionId: printSessionId }),
    );
    expect(await store.runtimeSnapshot!({ sessionId: printSessionId })).toEqual(
      await observable.runtimeSnapshot!({ sessionId: printSessionId }),
    );
    await observable.append(printEvent("message.created", { messageId: printMessageId, role: "assistant" }));
    await observable.append(printEvent("message.part_stream_delta", {
      messageId: printMessageId, partId: printPartId, partType: "text", delta: "In progress", offset: 0,
    }));
    expect(store.activeMessageParts!({ sessionId: printSessionId })).toEqual(
      observable.activeMessageParts({ sessionId: printSessionId }),
    );
    expect(store.activeMessageParts!({ sessionId: printSessionId })).toHaveLength(1);
  } finally {
    sqlite.close();
    await rm(sqliteDir, { recursive: true, force: true });
  }
});

function printEvent<T extends ChiliEvent["type"]>(
  type: T,
  payload: Extract<ChiliEvent, { type: T }>["payload"],
): Extract<ChiliEvent, { type: T }> {
  return { id: `event_print_${type}`, type, time: 1 as TimestampMs, sessionId: printSessionId, payload } as Extract<ChiliEvent, { type: T }>;
}

function textPart(text: string) {
  return { id: printPartId, messageId: printMessageId, sessionId: printSessionId, type: "text" as const, text };
}

function capturePrinter(run: (printer: CliPrinter) => void): string {
  const chunks: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    run(new CliPrinter());
    return chunks.join("");
  } finally {
    write.mockRestore();
  }
}

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
