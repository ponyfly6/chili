import { afterEach, expect, test } from "bun:test";
import type { MessageId, SessionId, TimestampMs } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import type { AgentRunner } from "./runner.js";
import {
  RuntimeBusyError,
  RuntimeService,
  RuntimeServiceClosedError,
  RuntimeSessionAccessError,
  RuntimeSessionNotFoundError,
  type RuntimeServiceOptions,
} from "./runtime-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("deleting active and archived conversations removes history through observable stores", async () => {
  for (const archived of [false, true]) {
    const f = await fixture();
    if (archived) await f.service.archiveSession(f.rootId);
    f.resourceStops.length = 0;
    await f.service.deleteSession(f.rootId);
    expect(await f.store.sessions()).toEqual([]);
    expect(await f.store.events()).toEqual([]);
    expect(await f.store.messages(f.rootId)).toEqual([]);
    expect(f.resourceStops).toEqual([[f.rootId, "session_deleted"]]);
    await expect(f.service.assertSessionReadAllowed(f.rootId)).rejects.toBeInstanceOf(RuntimeSessionNotFoundError);
    await expect(f.service.deleteSession(f.rootId)).rejects.toBeInstanceOf(RuntimeSessionNotFoundError);
  }
});

test("deletion rejects local operations and running descendant Agents without stopping them", async () => {
  const f = await fixture();
  await f.service.withSessionOperation(f.rootId, async () => {
    await expect(f.service.deleteSession(f.rootId)).rejects.toBeInstanceOf(RuntimeBusyError);
    expect(await f.store.session(f.rootId)).toBeDefined();
    expect(f.resourceStops).toEqual([]);
  });
  const childId = await f.addChild();
  await f.childService.withSessionOperation(childId, async () => {
    await expect(f.service.deleteSession(f.rootId)).rejects.toBeInstanceOf(RuntimeBusyError);
    expect((await f.store.sessions()).map((session) => session.id).sort()).toEqual([childId, f.rootId].sort());
    expect(f.resourceStops).toEqual([]);
  });
  await f.service.deleteSession(f.rootId);
  expect(await f.store.sessions()).toEqual([]);
  expect(f.resourceStops.map(([sessionId]) => sessionId).sort()).toEqual([childId, f.rootId].sort());
  expect(f.resourceStops.every(([, reason]) => reason === "session_deleted")).toBe(true);
});

test("deletion preserves runtime role access for roots and children", async () => {
  const f = await fixture();
  const childId = await f.addChild();
  await expect(f.service.deleteSession(childId)).rejects.toBeInstanceOf(RuntimeSessionAccessError);
  await expect(f.childService.deleteSession(f.rootId)).rejects.toBeInstanceOf(RuntimeSessionAccessError);
  expect(await f.store.sessions()).toHaveLength(2);
  expect(f.resourceStops).toEqual([]);
});

test("shutdown drains deletion resource cleanup and rejects new deletions", async () => {
  const started = deferred();
  const released = deferred();
  const f = await fixture(async () => { started.resolve(); await released.promise; return true; });
  const deleting = f.service.deleteSession(f.rootId);
  await started.promise;
  expect(await f.store.sessions()).toEqual([]);
  const shutdown = f.service.shutdown();
  let settled = false;
  void shutdown.then(() => { settled = true; });
  await expect(f.service.deleteSession(f.rootId)).rejects.toBeInstanceOf(RuntimeServiceClosedError);
  expect(settled).toBe(false);
  released.resolve();
  await Promise.all([deleting, shutdown]);
  expect(settled).toBe(true);
});

test("resource cleanup failures remain diagnostics after deletion commits", async () => {
  const failure = new Error("Process cleanup failed");
  const diagnostics: Array<[unknown, SessionId]> = [];
  const f = await fixture(async () => { throw failure; }, (error, sessionId) => {
    diagnostics.push([error, sessionId]);
    throw new Error("Diagnostic callback failed");
  });
  const childId = await f.addChild();
  await expect(f.service.deleteSession(f.rootId)).resolves.toBeUndefined();
  expect(await f.store.sessions()).toEqual([]);
  expect(diagnostics).toHaveLength(2);
  expect(diagnostics.every(([error]) => error === failure)).toBe(true);
  expect(diagnostics.map(([, sessionId]) => sessionId).sort()).toEqual([childId, f.rootId].sort());
});

async function fixture(
  stopResources?: RuntimeServiceOptions["stopSessionResources"],
  onCleanupError?: RuntimeServiceOptions["onSessionDeleteCleanupError"],
) {
  const sqlite = new SqliteEventStore(":memory:");
  const store = new ObservableEventStore(new ObservableEventStore(sqlite));
  const rootId = "session_delete_root" as SessionId;
  const time = Date.now() as TimestampMs;
  await store.append({ id: crypto.randomUUID(), type: "session.created", sessionId: rootId, time,
    payload: { sessionId: rootId, cwd: process.cwd() } });
  await store.append({ id: crypto.randomUUID(), type: "message.created", sessionId: rootId, time,
    payload: { messageId: "message_delete" as MessageId, role: "user" } });
  const resourceStops: Array<[SessionId, string]> = [];
  const runtime: AgentRunner = {
    async createSession() { throw new Error("Unexpected creation"); },
    async appendUserMessage() { throw new Error("Unexpected message"); },
    async runTurn() { throw new Error("Unexpected turn"); },
  };
  const service = new RuntimeService({ runtime, store, cwd: process.cwd(),
    stopSessionResources: stopResources ?? (async (sessionId, reason) => { resourceStops.push([sessionId, reason]); return true; }),
    ...(onCleanupError ? { onSessionDeleteCleanupError: onCleanupError } : {}),
  });
  const childService = new RuntimeService({ runtime, store, cwd: process.cwd(), sessionAccess: "child" });
  cleanups.push(async () => { await Promise.all([service.shutdown(), childService.shutdown()]); sqlite.close(); });
  return { service, childService, store, rootId, resourceStops, async addChild() {
    const childId = "session_delete_child" as SessionId;
    await store.append({ id: crypto.randomUUID(), type: "session.created", sessionId: childId, time,
      payload: { sessionId: childId, cwd: process.cwd(), agent: { parentSessionId: rootId, name: "child", path: "/root/child", policy: {} } } });
    return childId;
  } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
