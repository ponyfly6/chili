import { expect, test } from "bun:test";
import type { RuntimeSnapshot } from "../shared/contracts.js";
import { HistoryNavigation } from "./history-navigation.js";

function page(sessionId: string, nextBeforeEventId?: string): RuntimeSnapshot {
  return { sessionId, events: [], agents: [], pendingApprovals: [], pendingInputs: [],
    ...(nextBeforeEventId ? { nextBeforeEventId } : {}) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("history replaces one page and supports older, newer, and return to live", async () => {
  const calls: Array<string | undefined> = [];
  const latest = page("s", "old_1");
  const earlier = page("s", "old_2");
  const oldest = page("s");
  const navigation = new HistoryNavigation(() => undefined);
  navigation.configure("project:s", "s", async (_, cursor) => {
    calls.push(cursor);
    return cursor === "old_1" ? earlier : cursor === "old_2" ? oldest : latest;
  });
  await navigation.open();
  expect(navigation.state.page).toBe(latest);
  await navigation.older();
  expect(navigation.state.page).toBe(earlier);
  await navigation.older();
  expect(navigation.state.page).toBe(oldest);
  await navigation.newer();
  expect(navigation.state.page).toBe(earlier);
  navigation.live();
  expect(navigation.state.page).toBeUndefined();
  expect(navigation.state.canGoNewer).toBe(false);
  expect(calls).toEqual([undefined, "old_1", "old_2", "old_1"]);
});

test("switching projects away and back rejects a late response from the old generation", async () => {
  const pending = deferred<RuntimeSnapshot>();
  const navigation = new HistoryNavigation(() => undefined);
  navigation.configure("project_a:s", "s", async () => pending.promise);
  const oldLoad = navigation.open();
  navigation.configure("project_b:s", "s", async () => page("s"));
  navigation.configure("project_a:s", "s", async () => page("s", "current"));
  await navigation.open();
  pending.resolve(page("s", "stale"));
  await oldLoad;
  expect(navigation.state.page?.nextBeforeEventId).toBe("current");
});

test("returning to live cancels a pending history publication", async () => {
  const pending = deferred<RuntimeSnapshot>();
  const navigation = new HistoryNavigation(() => undefined);
  navigation.configure("a", "s", async () => pending.promise);
  const load = navigation.open();
  navigation.live();
  pending.resolve(page("s", "stale"));
  await load;
  expect(navigation.state.page).toBeUndefined();
  expect(navigation.state.loading).toBe(false);
});

test("a failed page keeps the visible page and allows retry; foreign sessions cannot replace it", async () => {
  let fail = true;
  const latest = page("s", "older");
  const navigation = new HistoryNavigation(() => undefined);
  navigation.configure("a", "s", async (_, cursor) => {
    if (!cursor) return latest;
    if (fail) throw new Error("offline");
    return page("foreign");
  });
  await navigation.open();
  await navigation.older();
  expect(navigation.state.page).toBe(latest);
  expect(navigation.state.error).toBe("offline");
  fail = false;
  await navigation.older();
  expect(navigation.state.error).toContain("different session");
  expect(navigation.state.page).toBe(latest);
});
