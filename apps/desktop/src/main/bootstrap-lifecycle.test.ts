import { describe, expect, test } from "bun:test";
import { BootstrapLifecycleGuard } from "./bootstrap-lifecycle.js";

const guardedStages = [
  ["app-ready"],
  ["renderer-protocol"],
  ["window-load"],
  ["persisted-workspace"],
  ["workspace-switch"],
  ["workspace-persist"],
  ["smoke-scenario"],
] as const;

describe("desktop bootstrap lifecycle guard", () => {
  test.each(guardedStages)("stops after shutdown wins the deferred %s stage", async (stage) => {
    const lifecycle = new BootstrapLifecycleGuard();
    const gate = deferred<void>();
    const continued: string[] = [];
    const bootstrap = (async () => {
      await gate.promise;
      if (!lifecycle.canContinue()) return;
      continued.push(stage);
    })();

    expect(lifecycle.beginShutdown()).toBe(true);
    gate.resolve();
    await bootstrap;

    expect(lifecycle.quitStarted).toBe(true);
    expect(continued).toEqual([]);
  });

  test("keeps shutdown terminal and admits a stage only before it starts", async () => {
    const lifecycle = new BootstrapLifecycleGuard();
    const first = deferred<void>();
    const second = deferred<void>();
    const continued: string[] = [];
    const bootstrap = (async () => {
      await first.promise;
      if (!lifecycle.canContinue()) return;
      continued.push("first");
      await second.promise;
      if (!lifecycle.canContinue()) return;
      continued.push("second");
    })();

    first.resolve();
    await waitUntil(() => continued.length === 1);
    expect(lifecycle.beginShutdown()).toBe(true);
    expect(lifecycle.beginShutdown()).toBe(false);
    second.resolve();
    await bootstrap;

    expect(continued).toEqual(["first"]);
    expect(lifecycle.canContinue()).toBe(false);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value as T) };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for guarded bootstrap stage");
}
