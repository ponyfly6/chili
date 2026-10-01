import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { ParentLossWatchdog } from "./parent-loss-watchdog.js";
import {
  closeSidecarResources,
  createSidecarShutdownCoordinator,
} from "./shutdown-coordinator.js";

describe("sidecar shutdown coordinator", () => {
  test("contains an early parent loss after close becomes available", async () => {
    const fixture = coordinatorFixture();
    fixture.coordinator.markParentGone("parent gone");
    expect(fixture.events).toEqual(["arm"]);

    fixture.coordinator.installClose(async (reason) => {
      fixture.events.push(`close:${reason}`);
    });
    await flushResolvedDecision();

    expect(fixture.events).toEqual([
      "arm",
      "close:parent gone",
      "hard-contain",
      "exit:1",
    ]);
  });

  test("keeps an explicit graceful shutdown at exit zero", async () => {
    const fixture = coordinatorFixture();
    fixture.coordinator.installClose(async () => {
      fixture.events.push("close");
    });
    fixture.coordinator.requestGraceful("requested", 0);
    await flushResolvedDecision();

    expect(fixture.events).toEqual(["arm", "close", "disarm", "teardown", "exit:0"]);
  });

  test("upgrades an in-flight graceful close when the parent disappears", async () => {
    const fixture = coordinatorFixture();
    const close = deferred<void>();
    fixture.coordinator.installClose(() => close.promise);
    fixture.coordinator.requestGraceful("requested", 0);
    await flushPromises();
    fixture.coordinator.markParentGone("parent gone during close");
    close.resolve();
    await flushResolvedDecision();

    expect(fixture.events).toEqual(["arm", "hard-contain", "exit:1"]);
  });

  test("observes queued parent EOF before the default final decision", async () => {
    const fixture = coordinatorFixture();
    const ownership = new PassThrough();
    ownership.once("end", () => {
      fixture.coordinator.markParentGone("queued parent EOF");
    });
    ownership.resume();
    fixture.coordinator.installClose(async () => {
      fixture.events.push("resources-settled");
    });
    fixture.coordinator.requestGraceful("requested", 0);
    ownership.end();

    await flushResolvedDecision();

    expect(fixture.events).toEqual([
      "arm",
      "resources-settled",
      "hard-contain",
      "exit:1",
    ]);
  });

  test("upgrades after resources settle but before the final exit decision", async () => {
    const fixture = coordinatorFixture({ delayResolvedDecision: true });
    fixture.coordinator.installClose(async () => {
      fixture.events.push("resources-settled");
    });
    fixture.coordinator.requestGraceful("requested", 0);
    await flushPromises();
    expect(fixture.events).toEqual(["arm", "resources-settled"]);

    fixture.coordinator.markParentGone("parent gone after resources settled");
    fixture.fireResolvedDecision();

    expect(fixture.events).toEqual([
      "arm",
      "resources-settled",
      "hard-contain",
      "exit:1",
    ]);
  });

  test("promotes a late fatal request above an in-flight zero exit", async () => {
    const fixture = coordinatorFixture();
    const close = deferred<void>();
    fixture.coordinator.installClose(() => close.promise);
    fixture.coordinator.requestGraceful("SIGTERM", 0);
    fixture.coordinator.requestGraceful("uncaught exception", 1);
    close.resolve();
    await flushResolvedDecision();

    expect(fixture.events).toEqual(["arm", "disarm", "teardown", "exit:1"]);
  });

  test("hard-contains a rejecting close before disarming the watchdog", async () => {
    const fixture = coordinatorFixture();
    fixture.coordinator.installClose(async () => {
      throw new Error("close rejected");
    });
    fixture.coordinator.requestGraceful("requested", 0);
    await flushPromises();

    expect(fixture.events).toEqual([
      "arm",
      "close-error:close rejected",
      "hard-contain",
      "exit:1",
    ]);
  });

  test("hard-contains a never-settling close at the deadline", async () => {
    const fixture = coordinatorFixture();
    fixture.coordinator.installClose(() => new Promise<void>(() => undefined));
    fixture.coordinator.requestGraceful("requested", 0);
    await flushPromises();
    fixture.fireDeadline();

    expect(fixture.events).toEqual(["arm", "hard-contain", "exit:1"]);
  });
});

test("resource close still attempts the Host after server rejection", async () => {
  const events: string[] = [];
  await expect(closeSidecarResources({
    denyPending() {
      events.push("deny");
    },
    async closeServer() {
      events.push("server");
      throw new Error("server close rejected");
    },
    async closeHost() {
      events.push("host");
    },
  })).rejects.toThrow("server close rejected");
  expect(events).toEqual(["deny", "server", "host"]);
});

function coordinatorFixture(options: { delayResolvedDecision?: boolean } = {}): {
  coordinator: ReturnType<typeof createSidecarShutdownCoordinator>;
  events: string[];
  fireDeadline(): void;
  fireResolvedDecision(): void;
} {
  const events: string[] = [];
  let deadline: (() => void) | undefined;
  let resolvedDecision: (() => void) | undefined;
  let armed = false;
  const coordinator = createSidecarShutdownCoordinator({
    deadlineMs: 100,
    createWatchdog(onDeadline): ParentLossWatchdog {
      deadline = onDeadline;
      return {
        arm() {
          if (armed) return;
          armed = true;
          events.push("arm");
        },
        disarm() {
          if (!armed) return;
          armed = false;
          events.push("disarm");
        },
      };
    },
    hardContain() {
      events.push("hard-contain");
    },
    exit(code) {
      events.push(`exit:${code}`);
    },
    onCloseError(error) {
      events.push(`close-error:${error instanceof Error ? error.message : String(error)}`);
    },
    teardownObservation() {
      events.push("teardown");
    },
    ...(options.delayResolvedDecision
      ? { scheduleResolvedDecision: (decision: () => void) => {
          resolvedDecision = decision;
        } }
      : {}),
  });
  return {
    coordinator,
    events,
    fireDeadline() {
      deadline?.();
    },
    fireResolvedDecision() {
      resolvedDecision?.();
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value as T) };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushResolvedDecision(): Promise<void> {
  await flushPromises();
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  await flushPromises();
}
