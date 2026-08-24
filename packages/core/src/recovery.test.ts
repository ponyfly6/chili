import { expect, test } from "bun:test";
import type {
  ChiliEvent,
  EventEnvelope,
  SessionId,
  SnapshotId,
  TimestampMs,
} from "@chili/protocol";
import type { EventQuery, EventStore, SessionRow } from "@chili/store";
import type { SnapshotProvider, SnapshotRevertOptions } from "@chili/tools";
import { SnapshotRecoveryService } from "./recovery.js";

const sessionId = "session_recovery" as SessionId;
const otherSessionId = "session_recovery_other" as SessionId;
const snapshotId = "snapshot_recovery" as SnapshotId;

test("reverts only a snapshot created by the target session and records the result", async () => {
  const fixture = recoveryFixture({
    sessions: [sessionRow(sessionId, "/workspace")],
    events: [snapshotCreatedEvent(sessionId, snapshotId, "event_snapshot_created")],
  });

  await expect(fixture.service.revert({ sessionId, snapshotId })).resolves.toEqual({
    snapshotId,
    paths: ["src/file.ts"],
    restored: ["src/file.ts"],
    removed: [],
  });

  expect(fixture.revertCalls).toEqual([{ snapshotId, options: { cwd: "/workspace" } }]);
  expect(fixture.appended).toEqual([expect.objectContaining({
    type: "snapshot.reverted",
    sessionId,
    payload: {
      snapshotId,
      status: "completed",
      paths: ["src/file.ts"],
    },
  })]);
});

test("rejects a missing target session before reading snapshots or mutating state", async () => {
  const fixture = recoveryFixture({
    sessions: [],
    events: [snapshotCreatedEvent(otherSessionId, snapshotId, "event_other_snapshot")],
  });

  await expect(fixture.service.revert({ sessionId, snapshotId }))
    .rejects.toThrow(`Session not found: ${sessionId}`);
  expect(fixture.eventQueries).toEqual([]);
  expect(fixture.revertCalls).toEqual([]);
  expect(fixture.appended).toEqual([]);
});

test("rejects cross-session and unknown snapshots without provider or event side effects", async () => {
  const fixture = recoveryFixture({
    sessions: [sessionRow(sessionId, "/workspace"), sessionRow(otherSessionId, "/other")],
    events: [snapshotCreatedEvent(otherSessionId, snapshotId, "event_other_snapshot")],
  });
  const unknownSnapshotId = "snapshot_unknown" as SnapshotId;

  for (const requestedSnapshotId of [snapshotId, unknownSnapshotId]) {
    await expect(fixture.service.revert({ sessionId, snapshotId: requestedSnapshotId }))
      .rejects.toThrow(`Snapshot not found for session ${sessionId}: ${requestedSnapshotId}`);
  }

  expect(fixture.revertCalls).toEqual([]);
  expect(fixture.appended).toEqual([]);
});

test("rejects archived and subagent sessions before reading snapshots", async () => {
  for (const session of [
    { ...sessionRow(sessionId, "/workspace"), status: "archived" as const },
    { ...sessionRow(sessionId, "/workspace"), source: "subagent" as const },
  ]) {
    const fixture = recoveryFixture({
      sessions: [session],
      events: [snapshotCreatedEvent(sessionId, snapshotId, "event_snapshot_created")],
    });

    await expect(fixture.service.revert({ sessionId, snapshotId })).rejects.toThrow();
    expect(fixture.eventQueries).toEqual([]);
    expect(fixture.revertCalls).toEqual([]);
    expect(fixture.appended).toEqual([]);
  }
});

test("rechecks session authority immediately before reverting", async () => {
  const active = sessionRow(sessionId, "/workspace");
  const archived = { ...active, status: "archived" as const };
  const fixture = recoveryFixture({
    sessions: [active],
    sessionReads: [[active], [archived]],
    events: [snapshotCreatedEvent(sessionId, snapshotId, "event_snapshot_created")],
  });

  await expect(fixture.service.revert({ sessionId, snapshotId }))
    .rejects.toThrow(`Session is not active: ${sessionId} (archived)`);
  expect(fixture.eventQueries).toHaveLength(1);
  expect(fixture.revertCalls).toEqual([]);
  expect(fixture.appended).toEqual([]);
});

test("finds snapshot ownership beyond the first bounded event page", async () => {
  const earlierSnapshots = Array.from({ length: 500 }, (_, index) => snapshotCreatedEvent(
    sessionId,
    `snapshot_earlier_${index}` as SnapshotId,
    `event_snapshot_earlier_${index}`,
  ));
  const fixture = recoveryFixture({
    sessions: [sessionRow(sessionId, "/workspace")],
    events: [...earlierSnapshots, snapshotCreatedEvent(sessionId, snapshotId, "event_snapshot_created")],
  });

  await expect(fixture.service.revert({ sessionId, snapshotId })).resolves.toMatchObject({ snapshotId });
  expect(fixture.eventQueries).toHaveLength(2);
  expect(fixture.eventQueries[1]).toMatchObject({
    sessionId,
    type: "snapshot.created",
    afterEventId: "event_snapshot_earlier_499",
  });
});

function recoveryFixture(input: {
  sessions: SessionRow[];
  sessionReads?: SessionRow[][];
  events: ChiliEvent[];
}): {
  service: SnapshotRecoveryService;
  appended: ChiliEvent[];
  eventQueries: EventQuery[];
  revertCalls: Array<{ snapshotId: SnapshotId; options?: SnapshotRevertOptions }>;
} {
  const events = [...input.events];
  const appended: ChiliEvent[] = [];
  const eventQueries: EventQuery[] = [];
  let sessionReadIndex = 0;
  const store = {
    async append(event: ChiliEvent) {
      events.push(event);
      appended.push(event);
    },
    async appendMany(next: readonly ChiliEvent[]) {
      events.push(...next);
      appended.push(...next);
    },
    async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
      eventQueries.push(query);
      let matches: EventEnvelope[] = events;
      if (query.sessionId) matches = matches.filter((event) => event.sessionId === query.sessionId);
      if (query.type) matches = matches.filter((event) => event.type === query.type);
      if (query.afterEventId) {
        const cursor = matches.findIndex((event) => event.id === query.afterEventId);
        matches = cursor < 0 ? [] : matches.slice(cursor + 1);
      }
      if (query.tail) matches = matches.slice(-(query.limit ?? 500));
      else matches = matches.slice(0, query.limit ?? 500);
      return matches;
    },
    async sessions() {
      const sessions = input.sessionReads?.[sessionReadIndex] ?? input.sessions;
      sessionReadIndex += 1;
      return sessions;
    },
    async messages() {
      return [];
    },
    async pendingApprovals() {
      return [];
    },
  } satisfies EventStore;
  const revertCalls: Array<{ snapshotId: SnapshotId; options?: SnapshotRevertOptions }> = [];
  const snapshotProvider: SnapshotProvider = {
    async create() {
      return undefined;
    },
    async revert(requestedSnapshotId, options) {
      revertCalls.push({
        snapshotId: requestedSnapshotId,
        ...(options ? { options } : {}),
      });
      return {
        snapshotId: requestedSnapshotId,
        paths: ["src/file.ts"],
        restored: ["src/file.ts"],
        removed: [],
      };
    },
  };
  return {
    service: new SnapshotRecoveryService({
      store,
      snapshotProvider,
      createId: () => "event_snapshot_reverted",
      now: () => 100 as TimestampMs,
    }),
    appended,
    eventQueries,
    revertCalls,
  };
}

function sessionRow(id: SessionId, cwd: string): SessionRow {
  return {
    id,
    cwd,
    source: "interactive",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  };
}

function snapshotCreatedEvent(
  ownerSessionId: SessionId,
  ownerSnapshotId: SnapshotId,
  id: string,
): Extract<ChiliEvent, { type: "snapshot.created" }> {
  return {
    id,
    type: "snapshot.created",
    time: 1 as TimestampMs,
    sessionId: ownerSessionId,
    payload: {
      snapshotId: ownerSnapshotId,
      paths: ["src/file.ts"],
      reason: "before edit",
    },
  };
}
