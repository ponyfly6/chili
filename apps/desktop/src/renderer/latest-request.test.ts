import { describe, expect, test } from "bun:test";
import { createLatestRequestGate } from "./latest-request.js";

describe("latest request gate", () => {
  test("prevents an older response from replacing a newer result", async () => {
    const gate = createLatestRequestGate();
    const older = deferred<string>();
    const newer = deferred<string>();
    const applied: string[] = [];
    const load = async (result: Promise<string>): Promise<void> => {
      const isCurrent = gate.begin();
      const value = await result;
      if (isCurrent()) applied.push(value);
    };

    const olderLoad = load(older.promise);
    const newerLoad = load(newer.promise);
    newer.resolve("new workspace");
    await newerLoad;
    older.resolve("old workspace");
    await olderLoad;

    expect(applied).toEqual(["new workspace"]);
  });

  test("invalidates an in-flight response when the workspace is cleared", async () => {
    const gate = createLatestRequestGate();
    const result = deferred<string>();
    const applied: string[] = [];
    const isCurrent = gate.begin();
    const load = result.promise.then((value) => {
      if (isCurrent()) applied.push(value);
    });

    gate.invalidate();
    result.resolve("stale diff");
    await load;

    expect(applied).toEqual([]);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}
