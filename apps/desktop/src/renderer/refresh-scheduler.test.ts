import { expect, test } from "bun:test";
import { IndependentRefreshScheduler } from "./refresh-scheduler.js";

test("session and snapshot refreshes debounce independently in either event order", () => {
  for (const order of [["snapshot", "sessions"], ["sessions", "snapshot"]] as const) {
    let nextId = 0;
    const pending = new Map<number, () => void>();
    const calls: string[] = [];
    const scheduler = new IndependentRefreshScheduler<number>({
      schedule: (callback) => {
        const id = ++nextId;
        pending.set(id, callback);
        return id;
      },
      cancel: (id) => pending.delete(id),
    });

    for (const lane of order) scheduler[lane](() => calls.push(lane));
    expect(pending.size).toBe(2);
    for (const callback of [...pending.values()]) callback();
    expect(new Set(calls)).toEqual(new Set(["sessions", "snapshot"]));
  }
});

test("a newer refresh cancels only its own lane and cleanup cancels both", () => {
  let nextId = 0;
  const pending = new Map<number, () => void>();
  const scheduler = new IndependentRefreshScheduler<number>({
    schedule: (callback) => {
      const id = ++nextId;
      pending.set(id, callback);
      return id;
    },
    cancel: (id) => pending.delete(id),
  });
  scheduler.sessions(() => undefined);
  scheduler.snapshot(() => undefined);
  scheduler.sessions(() => undefined);
  expect(pending.size).toBe(2);
  scheduler.cancel();
  expect(pending.size).toBe(0);
});
