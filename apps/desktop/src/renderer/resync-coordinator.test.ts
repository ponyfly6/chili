import { describe, expect, test } from "bun:test";
import {
  RecoveryInvalidatedError,
  ProjectionReplayWindowError,
  ResyncCoordinator,
  ResyncCoordinatorDisposedError,
  ResyncRetryLimitError,
  SnapshotIdentityMismatchError,
  SupersededProjectionRequestError,
  type CoordinatedProjection,
  type ResyncCoordinatorOptions,
  type SequencedProjectionFrame,
} from "./resync-coordinator.js";
import { serializedJsonUtf8Bytes } from "./json-bytes.js";

interface State {
  workspace?: string;
  queue: Record<string, number>;
}

interface Session {
  id: string;
  status: "active" | "archived";
}

interface Snapshot {
  sessionId: string;
  latestTurnId?: string;
  events: EventRow[];
}

interface EventRow {
  id: string;
  sessionId: string;
  type: string;
}

type Frame =
  | { type: "state"; state: State }
  | { type: "queue"; sessionId: string; count: number }
  | { type: "event"; event: EventRow };

type Projection = CoordinatedProjection<State, Session, Snapshot>;

describe("resync coordinator", () => {
  test("binds hydration reads and remembered selection to the state returned for that recovery", async () => {
    const calls: string[] = [];
    const published: Projection[] = [];
    const coordinator = createCoordinator({
      loadState: async () => state("/project-b"),
      listSessions: async (owner) => {
        calls.push(`list:${owner.workspace}`);
        return [session("newest-b"), session("remembered-b")];
      },
      preferredSessionId: (owner) => owner.workspace === "/project-b" ? "remembered-b" : undefined,
      loadSnapshot: async (sessionId, owner) => {
        calls.push(`snapshot:${owner?.workspace}:${sessionId}`);
        return { sessionId, events: [] };
      },
      publish: (value) => published.push(value),
    });
    await coordinator.barrier({ sequence: 1, preferredSessionId: "old-project-a-selection" });
    expect(calls).toEqual(["list:/project-b", "snapshot:/project-b:remembered-b"]);
    expect(published[0]?.selectedId).toBe("remembered-b");
  });

  test("hydrates state, sessions, and snapshot in order, then replays live events atomically", async () => {
    const snapshot = deferred<Snapshot>();
    const calls: string[] = [];
    const published: Projection[] = [];
    const completed: string[] = [];
    const coordinator = createCoordinator({
      loadState: async () => {
        calls.push("state");
        return state("/repo");
      },
      listSessions: async () => {
        calls.push("sessions");
        return [session("root")];
      },
      loadSnapshot: async (sessionId) => {
        calls.push(`snapshot:${sessionId}`);
        return snapshot.promise;
      },
      publish: (projection) => {
        calls.push("publish");
        published.push(projection);
      },
      complete: ({ projection }) => {
        calls.push("complete");
        completed.push(projection.selectedId ?? "none");
      },
    });

    const recovery = coordinator.barrier({ sequence: 10, preferredSessionId: "root" });
    await eventually(() => expect(calls).toEqual(["state", "sessions", "snapshot:root"]));
    expect(coordinator.status()).toMatchObject({ syncing: true, actionsDisabled: true });
    expect(published).toEqual([]);

    coordinator.recordFrame(frame(12, {
      type: "event",
      event: event("event_live", "root", "message.part_added"),
    }));
    snapshot.resolve({
      sessionId: "root",
      latestTurnId: "turn_same",
      events: [event("event_base", "root", "turn.started")],
    });

    expect(await recovery).toBe("completed");
    expect(calls).toEqual(["state", "sessions", "snapshot:root", "publish", "complete"]);
    expect(published).toHaveLength(1);
    expect(published[0]?.snapshot?.events.map((row) => row.id)).toEqual(["event_base", "event_live"]);
    expect(completed).toEqual(["root"]);
    expect(coordinator.status()).toMatchObject({ syncing: false, actionsDisabled: false, diffRevision: 1 });
  });

  test("a second barrier supersedes late old-workspace work without running hydrations concurrently", async () => {
    const oldState = deferred<State>();
    let stateCalls = 0;
    let activeHydrations = 0;
    let maximumHydrations = 0;
    const published: Projection[] = [];
    const coordinator = createCoordinator({
      loadState: async () => {
        activeHydrations += 1;
        maximumHydrations = Math.max(maximumHydrations, activeHydrations);
        try {
          stateCalls += 1;
          return stateCalls === 1 ? await oldState.promise : state("/new");
        } finally {
          activeHydrations -= 1;
        }
      },
      listSessions: async () => [session("new_session")],
      loadSnapshot: async (sessionId) => ({ sessionId, events: [] }),
      publish: (projection) => published.push(projection),
    });

    const first = coordinator.barrier({ sequence: 1, preferredSessionId: "old_session" });
    await eventually(() => expect(stateCalls).toBe(1));
    const second = coordinator.barrier({ sequence: 5, preferredSessionId: "new_session" });
    await Promise.resolve();
    expect(stateCalls).toBe(1);

    oldState.resolve(state("/old"));
    expect(await first).toBe("superseded");
    expect(await second).toBe("completed");
    expect(maximumHydrations).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      epoch: 2,
      state: { workspace: "/new" },
      selectedId: "new_session",
      snapshot: { sessionId: "new_session" },
    });
  });

  test("supersedes an old snapshot response when another barrier arrives", async () => {
    const oldSnapshot = deferred<Snapshot>();
    let snapshotCalls = 0;
    const published: Projection[] = [];
    const coordinator = createCoordinator({
      loadState: async () => state(snapshotCalls === 0 ? "/old" : "/new"),
      listSessions: async () => [session(snapshotCalls === 0 ? "old" : "new")],
      loadSnapshot: async (sessionId) => {
        snapshotCalls += 1;
        return snapshotCalls === 1 ? oldSnapshot.promise : { sessionId, events: [] };
      },
      publish: (projection) => published.push(projection),
    });

    const first = coordinator.barrier({ sequence: 1, preferredSessionId: "old" });
    await eventually(() => expect(snapshotCalls).toBe(1));
    const second = coordinator.barrier({ sequence: 2, preferredSessionId: "new" });
    oldSnapshot.resolve({ sessionId: "old", events: [] });

    expect(await first).toBe("superseded");
    expect(await second).toBe("completed");
    expect(published.map((projection) => projection.selectedId)).toEqual(["new"]);
  });

  test("a barrier invalidates every kind of response token from the prior epoch", async () => {
    const coordinator = createCoordinator();
    const tokens = (["state", "sessions", "snapshot", "diff"] as const)
      .map((kind) => coordinator.beginRequest(kind));

    await coordinator.barrier({ sequence: 1, preferredSessionId: "root" });

    for (const token of tokens) {
      expect(coordinator.isRequestCurrent(token)).toBe(false);
      expect(() => coordinator.acceptResponse(token)).toThrow(SupersededProjectionRequestError);
    }
  });

  test("falls back from an archived preference and clears selection for an empty active list", async () => {
    const publications: Projection[] = [];
    let sessions = [session("archived", "archived"), session("active")];
    const coordinator = createCoordinator({
      loadState: async () => state("/repo"),
      listSessions: async () => sessions,
      loadSnapshot: async (sessionId) => ({ sessionId, events: [] }),
      publish: (projection) => publications.push(projection),
    });

    await coordinator.barrier({ sequence: 1, preferredSessionId: "archived" });
    expect(publications[0]?.sessions.map((row) => row.id)).toEqual(["active"]);
    expect(publications[0]?.selectedId).toBe("active");

    sessions = [session("archived", "archived")];
    await coordinator.barrier({ sequence: 2, preferredSessionId: "active" });
    expect(publications[1]?.sessions).toEqual([]);
    expect(publications[1]?.selectedId).toBeUndefined();
    expect(publications[1]?.snapshot).toBeUndefined();
  });

  test("publishes state without querying sessions when its authority is unavailable", async () => {
    let listCalls = 0;
    const publications: Projection[] = [];
    const coordinator = createCoordinator({
      loadState: async () => state(""),
      canListSessions: (value) => Boolean(value.workspace),
      listSessions: async () => {
        listCalls += 1;
        return [session("must_not_load")];
      },
      publish: (projection) => publications.push(projection),
    });

    expect(await coordinator.barrier({ sequence: 3, preferredSessionId: "root" })).toBe("completed");
    expect(listCalls).toBe(0);
    expect(publications[0]).toMatchObject({ sessions: [] });
    expect(publications[0]?.selectedId).toBeUndefined();
  });

  test("rejects a mismatched snapshot and keeps the same barrier suppressed for retry", async () => {
    let mismatch = true;
    const published: Projection[] = [];
    const coordinator = createCoordinator({
      loadState: async () => state("/repo"),
      listSessions: async () => [session("root")],
      loadSnapshot: async () => ({ sessionId: mismatch ? "wrong" : "root", events: [] }),
      publish: (projection) => published.push(projection),
    });

    const epoch = coordinator.status().epoch + 1;
    await expect(coordinator.barrier({ sequence: 8, preferredSessionId: "root" }))
      .rejects.toBeInstanceOf(SnapshotIdentityMismatchError);
    expect(coordinator.status()).toMatchObject({ epoch, syncing: true, actionsDisabled: true, diffRevision: 0 });
    expect(() => coordinator.beginRequest("diff")).toThrow("diff request is suppressed while resync is in progress");
    expect(published).toEqual([]);

    coordinator.recordFrame(frame(9, { type: "queue", sessionId: "root", count: 2 }));
    mismatch = false;
    expect(await coordinator.retry()).toBe("completed");
    expect(coordinator.status()).toMatchObject({ epoch, syncing: false, diffRevision: 1 });
    expect(published[0]?.state.queue).toEqual({ root: 2 });
  });

  test("a complete retry rehydrates the same barrier without releasing suppression", async () => {
    const statuses: boolean[] = [];
    const published: Projection[] = [];
    let completionCalls = 0;
    const coordinator = createCoordinator({
      publish: (projection) => published.push(projection),
      complete: async ({ barrierId }) => {
        completionCalls += 1;
        expect(barrierId).toBe("barrier_1");
        statuses.push(coordinator.status().syncing);
        return completionCalls === 1 ? { status: "retry" } : { status: "completed" };
      },
    });

    expect(await coordinator.barrier({
      sequence: 1,
      barrierId: "barrier_1",
      preferredSessionId: "root",
    })).toBe("completed");

    expect(completionCalls).toBe(2);
    expect(statuses).toEqual([true, true]);
    expect(published).toHaveLength(2);
    expect(coordinator.status().syncing).toBe(false);
  });

  test("replays frames released during complete before lifting suppression", async () => {
    const completing = deferred<{ status: "completed" }>();
    const published: Projection[] = [];
    const coordinator = createCoordinator({
      publish: (projection) => published.push(projection),
      complete: () => completing.promise,
    });

    const recovery = coordinator.barrier({ sequence: 20, barrierId: "barrier_20", preferredSessionId: "root" });
    await eventually(() => expect(published).toHaveLength(1));
    expect(coordinator.status().syncing).toBe(true);
    coordinator.recordFrame(frame(21, {
      type: "event",
      event: event("released_during_complete", "root", "message.part_added"),
    }));

    completing.resolve({ status: "completed" });
    expect(await recovery).toBe("completed");
    expect(published).toHaveLength(2);
    expect(published.at(-1)?.snapshot?.events.map((row) => row.id)).toEqual(["released_during_complete"]);
    expect(coordinator.status().syncing).toBe(false);
  });

  test("rehydrates again when an authoritative frame arrives during post-release queries", async () => {
    const completing = deferred<{ status: "completed" }>();
    const secondSnapshot = deferred<Snapshot>();
    const sessionCreated = event("session_created", "root", "session.created");
    const inputQueueChanged = event("input_queue_changed", "root", "session.input_queue_changed");
    let snapshotCalls = 0;
    const published: Projection[] = [];
    const coordinator = createCoordinator({
      loadSnapshot: async (sessionId) => {
        snapshotCalls += 1;
        if (snapshotCalls === 2) return secondSnapshot.promise;
        return {
          sessionId,
          events: snapshotCalls === 1
            ? []
            : [sessionCreated, inputQueueChanged],
        };
      },
      frameRequiresRehydrate: (value) => value.type === "event"
        && (value.event.type === "session.created" || value.event.type === "session.input_queue_changed"),
      publish: (projection) => published.push(projection),
      complete: () => completing.promise,
    });

    const recovery = coordinator.barrier({ sequence: 30, barrierId: "barrier_30", preferredSessionId: "root" });
    await eventually(() => expect(published).toHaveLength(1));
    coordinator.recordFrame(frame(31, { type: "event", event: sessionCreated }));
    completing.resolve({ status: "completed" });
    await eventually(() => expect(snapshotCalls).toBe(2));
    coordinator.recordFrame(frame(32, { type: "event", event: inputQueueChanged }));
    expect(coordinator.status()).toMatchObject({ syncing: true, actionsDisabled: true });
    secondSnapshot.resolve({
      sessionId: "root",
      events: [sessionCreated],
    });

    expect(await recovery).toBe("completed");
    expect(snapshotCalls).toBe(3);
    expect(published).toHaveLength(2);
    expect(published.at(-1)?.snapshot?.events).toEqual([sessionCreated, inputQueueChanged]);
    expect(coordinator.status().syncing).toBe(false);
  });

  test("an authority-changing frame prevents partial publish and succeeds on same-barrier retry", async () => {
    let currentWorkspace = "/old";
    const published: Projection[] = [];
    const coordinator = createCoordinator({
      loadState: async () => state(currentWorkspace),
      listSessions: async () => [session("root")],
      loadSnapshot: async (sessionId) => ({ sessionId, events: [] }),
      publish: (projection) => published.push(projection),
    });

    coordinator.recordFrame(frame(11, { type: "state", state: state("/new") }));
    await expect(coordinator.barrier({ sequence: 10, preferredSessionId: "root" }))
      .rejects.toBeInstanceOf(RecoveryInvalidatedError);
    expect(published).toEqual([]);
    expect(coordinator.status().syncing).toBe(true);

    currentWorkspace = "/new";
    expect(await coordinator.retry()).toBe("completed");
    expect(published[0]?.state.workspace).toBe("/new");
  });

  test("ordinary snapshot refresh replays related frames once and is invalidated by a barrier", async () => {
    const coordinator = createCoordinator({
      loadState: async () => state("/repo"),
      listSessions: async () => [session("root")],
      loadSnapshot: async (sessionId) => ({ sessionId, events: [] }),
    });
    coordinator.recordFrame(frame(3, { type: "event", event: event("before", "root", "message.created") }));
    const loading = deferred<Snapshot>();
    const refreshed = coordinator.refreshSessionSnapshot("root", () => loading.promise);
    coordinator.recordFrame(frame(4, { type: "event", event: event("duplicate", "root", "message.created") }));
    coordinator.recordFrame(frame(5, { type: "event", event: event("duplicate", "root", "message.created") }));
    coordinator.recordFrame(frame(6, { type: "event", event: event("other", "child", "message.created") }));
    loading.resolve({ sessionId: "root", events: [event("base", "root", "turn.started")] });

    expect((await refreshed).events.map((row) => row.id)).toEqual(["base", "duplicate"]);

    const staleLoad = deferred<Snapshot>();
    const stale = coordinator.refreshSessionSnapshot("root", () => staleLoad.promise);
    const oldDiff = coordinator.beginRequest("diff");
    const barrier = coordinator.barrier({ sequence: 7, preferredSessionId: "root" });
    staleLoad.resolve({ sessionId: "root", events: [] });
    await expect(stale).rejects.toBeInstanceOf(SupersededProjectionRequestError);
    expect(() => coordinator.acceptResponse(oldDiff)).toThrow(SupersededProjectionRequestError);
    expect(await barrier).toBe("completed");
  });

  test("every completed barrier forces a diff revision even when the latest turn is unchanged", async () => {
    const revisions: number[] = [];
    const coordinator = createCoordinator({
      loadState: async () => state("/repo"),
      listSessions: async () => [session("root")],
      loadSnapshot: async (sessionId) => ({ sessionId, latestTurnId: "turn_same", events: [] }),
      publish: (projection) => revisions.push(projection.diffRevision),
    });

    await coordinator.barrier({ sequence: 1, preferredSessionId: "root" });
    await coordinator.barrier({ sequence: 2, preferredSessionId: "root" });

    expect(revisions).toEqual([1, 2]);
    expect(coordinator.status().diffRevision).toBe(2);
  });

  test("uses exact serialized UTF-8 bytes and evicts oldest frames without hiding replay loss", async () => {
    const escaped = frame(1, {
      type: "event",
      event: event("quote_\"_slash_\\_emoji_😀", "root", "message.part_added"),
    });
    expect(serializedJsonUtf8Bytes(escaped)).toBe(
      new TextEncoder().encode(JSON.stringify(escaped)).byteLength,
    );
    const perFrame = serializedJsonUtf8Bytes(escaped);
    const coordinator = createCoordinator({
      maxBufferedBytes: perFrame * 2,
      maxBufferedFrames: 100,
    });
    const loading = deferred<Snapshot>();
    const refresh = coordinator.refreshSessionSnapshot("root", () => loading.promise);
    coordinator.recordFrame(escaped);
    coordinator.recordFrame({ ...escaped, sequence: 2 });
    coordinator.recordFrame({ ...escaped, sequence: 3 });

    const diagnostics = coordinator.journalDiagnostics();
    expect(diagnostics.bufferedFrames).toBe(2);
    expect(diagnostics.bufferedBytes).toBeLessThanOrEqual(perFrame * 2);
    expect(diagnostics.droppedThroughSequence).toBe(1);
    loading.resolve({ sessionId: "root", events: [] });
    await expect(refresh).rejects.toBeInstanceOf(ProjectionReplayWindowError);
  });

  test("keeps many near-limit frames within both journal budgets", () => {
    const sample = frame(1, {
      type: "event",
      event: event(`large_${"界".repeat(2_000)}`, "root", "message.part_added"),
    });
    const frames = Array.from({ length: 32 }, (_, index) => ({ ...sample, sequence: index + 1 }));
    const byteBudget = frames.slice(-8).reduce(
      (total, current) => total + serializedJsonUtf8Bytes(current),
      0,
    );
    const coordinator = createCoordinator({ maxBufferedBytes: byteBudget, maxBufferedFrames: 8 });
    for (const current of frames) coordinator.recordFrame(current);
    expect(coordinator.journalDiagnostics()).toMatchObject({
      bufferedFrames: 8,
      droppedThroughSequence: 24,
    });
    expect(coordinator.journalDiagnostics().bufferedBytes).toBeLessThanOrEqual(byteBudget);
  });

  test("uses an ordered deque for a long monotonic live-frame stream", () => {
    const coordinator = createCoordinator({ maxBufferedBytes: 12_000_000, maxBufferedFrames: 512 });
    for (let sequence = 1; sequence <= 50_000; sequence += 1) {
      coordinator.recordFrame(frame(sequence, {
        type: "event",
        event: event(`event_journal_${sequence}`, "root", "message.part_delta"),
      }));
    }
    expect(coordinator.journalDiagnostics()).toMatchObject({
      bufferedFrames: 512,
      droppedThroughSequence: 49_488,
      outOfOrderInsertions: 0,
    });
    expect(coordinator.journalDiagnostics().storageCompactions).toBeLessThan(200);
  });

  test("cancel supersedes in-flight recovery and allows a remounted owner to start cleanly", async () => {
    const oldState = deferred<State>();
    let loadCalls = 0;
    const published: Projection[] = [];
    const coordinator = createCoordinator({
      loadState: async () => {
        loadCalls += 1;
        return loadCalls === 1 ? oldState.promise : state("/new");
      },
      publish: (projection) => published.push(projection),
    });

    const stale = coordinator.barrier({ sequence: 1, preferredSessionId: "root" });
    await eventually(() => expect(loadCalls).toBe(1));
    coordinator.cancel();
    const remounted = coordinator.barrier({ sequence: 1, preferredSessionId: "root" });
    expect(await remounted).toBe("completed");
    oldState.resolve(state("/old"));
    expect(await stale).toBe("superseded");
    expect(published).toHaveLength(1);
    expect(published[0]?.state.workspace).toBe("/new");

    coordinator.dispose();
    expect(() => coordinator.beginRequest("diff")).toThrow(ResyncCoordinatorDisposedError);
  });

  test("throttles and bounds repeated complete retries", async () => {
    let completionCalls = 0;
    const coordinator = createCoordinator({
      retryDelayMs: 0,
      maxCompleteRetries: 2,
      complete: () => {
        completionCalls += 1;
        return { status: "retry" };
      },
    });

    await expect(coordinator.barrier({ sequence: 1, barrierId: "retry_forever", preferredSessionId: "root" }))
      .rejects.toBeInstanceOf(ResyncRetryLimitError);
    expect(completionCalls).toBe(3);
    expect(coordinator.status().syncing).toBe(true);
    await expect(coordinator.retry()).rejects.toBeInstanceOf(ResyncRetryLimitError);
    expect(completionCalls).toBe(3);
    await expect(coordinator.retry({ resetCompletionBudget: true })).rejects.toBeInstanceOf(ResyncRetryLimitError);
    expect(completionCalls).toBe(6);
    coordinator.cancel();
  });

  test("cancel interrupts a delayed completion retry without issuing more hydration calls", async () => {
    let stateCalls = 0;
    let completionCalls = 0;
    const coordinator = createCoordinator({
      retryDelayMs: 60_000,
      loadState: async () => {
        stateCalls += 1;
        return state("/repo");
      },
      complete: () => {
        completionCalls += 1;
        return { status: "retry" };
      },
    });

    const recovery = coordinator.barrier({ sequence: 1, barrierId: "old_mount", preferredSessionId: "root" });
    await eventually(() => expect(completionCalls).toBe(1));
    coordinator.cancel();

    expect(await recovery).toBe("superseded");
    expect(stateCalls).toBe(1);
    expect(completionCalls).toBe(1);
  });
});

function createCoordinator(
  overrides: Partial<ResyncCoordinatorOptions<State, Session, Snapshot, Frame>> = {},
): ResyncCoordinator<State, Session, Snapshot, Frame> {
  const options: ResyncCoordinatorOptions<State, Session, Snapshot, Frame> = {
    loadState: async () => state("/repo"),
    listSessions: async () => [session("root")],
    loadSnapshot: async (sessionId) => ({ sessionId, events: [] }),
    authorityKey: (value) => value.workspace,
    sessionId: (value) => value.id,
    isSessionActive: (value) => value.status === "active",
    snapshotSessionId: (value) => value.sessionId,
    snapshotEventIds: (value) => value.events.map((row) => row.id),
    frameEventId: (value) => value.type === "event" ? value.event.id : undefined,
    frameRelatedToSnapshot: (value, _snapshot, sessionId) => (
      value.type === "event" && value.event.sessionId === sessionId
    ),
    applyFrameToSnapshot: (value, input) => input.type === "event"
      ? { ...value, events: [...value.events, input.event] }
      : value,
    applyFrames: (projection, frames) => frames.reduce(applyFrame, projection),
    publish: () => undefined,
    retryDelayMs: 0,
    ...overrides,
  };
  return new ResyncCoordinator(options);
}

function applyFrame(projection: Projection, input: SequencedProjectionFrame<Frame>): Projection {
  const value = input.frame;
  if (value.type === "state") return { ...projection, state: value.state };
  if (value.type === "queue") {
    return {
      ...projection,
      state: {
        ...projection.state,
        queue: { ...projection.state.queue, [value.sessionId]: value.count },
      },
    };
  }
  if (!projection.snapshot || value.event.sessionId !== projection.snapshot.sessionId) return projection;
  return {
    ...projection,
    snapshot: { ...projection.snapshot, events: [...projection.snapshot.events, value.event] },
  };
}

function state(workspace: string): State {
  return { workspace, queue: {} };
}

function session(id: string, status: Session["status"] = "active"): Session {
  return { id, status };
}

function event(id: string, sessionId: string, type: string): EventRow {
  return { id, sessionId, type };
}

function frame(sequence: number, value: Frame): SequencedProjectionFrame<Frame> {
  return { sequence, frame: value };
}

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve(value: Value): void;
} {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}
