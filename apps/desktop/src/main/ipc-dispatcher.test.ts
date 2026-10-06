import { expect, test } from "bun:test";
import { HttpRuntimeClient } from "@chili/sdk";
import { DesktopControlService } from "./control-service.js";
import { DESKTOP_INVOKE_CLOSING_RESPONSE } from "../shared/contracts.js";
import {
  createDesktopInvokeShutdownGate,
  createDesktopRequestDispatcher,
} from "./ipc-dispatcher.js";
import { MAX_DESKTOP_ERROR_MESSAGE_BYTES } from "../shared/safe-error.js";

test("shutdown resolves pending and later invokes without rejecting the main IPC handler", async () => {
  const gate = createDesktopInvokeShutdownGate();
  const entered = deferred<void>();
  const release = deferred<void>();
  const pending = gate.invoke(async () => {
    entered.resolve();
    await release.promise;
    throw new Error("Desktop is closing");
  });
  await entered.promise;

  gate.beginShutdown();
  release.resolve();
  await expect(pending).resolves.toBe(DESKTOP_INVOKE_CLOSING_RESPONSE);

  let laterDispatches = 0;
  await expect(gate.invoke(() => {
    laterDispatches += 1;
    return Promise.resolve("unexpected");
  })).resolves.toBe(DESKTOP_INVOKE_CLOSING_RESPONSE);
  expect(laterDispatches).toBe(0);

  const activeGate = createDesktopInvokeShutdownGate();
  await expect(activeGate.invoke(() => Promise.reject(new Error("real failure"))))
    .rejects.toThrow("real failure");
});

test("renderer invoke rejections redact labeled secrets and loopback URLs", async () => {
  const password = "abc";
  const clientSecret = "renderer-client-secret";
  const querySecret = "renderer-query-secret";
  const dispatch = createDesktopRequestDispatcher({
    invoke: async () => {
      throw new Error(
        `password\0=${password}\u007f client_secret=${clientSecret} `
        + `http://127.0.0.1:4312/fail?token=${querySecret}`,
      );
    },
  }, {
    completeResync: () => ({ status: "retry" }),
  });

  const rejection = await dispatch({ type: "app.state" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(Error);
  const message = (rejection as Error).message;
  expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(MAX_DESKTOP_ERROR_MESSAGE_BYTES);
  expect(message).not.toContain(password);
  expect(message).not.toContain(clientSecret);
  expect(message).not.toContain(querySecret);
  expect(message).not.toContain("127.0.0.1");
  expect(message).not.toMatch(/[\u0000-\u001f\u007f]/u);
});

test("the registered dispatcher bounds a 100-snapshot burst before mock sidecar HTTP", async () => {
  const gate = deferred<void>();
  let activeHttp = 0;
  let peakHttp = 0;
  let totalHttp = 0;
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test/",
    fetch: (async (input) => {
      totalHttp += 1;
      activeHttp += 1;
      peakHttp = Math.max(peakHttp, activeHttp);
      await gate.promise;
      activeHttp -= 1;
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
      const path = url.pathname;
      const body = path.endsWith("/input_queue")
        ? { sessionId: "session_1", paused: false, revision: 0, pendingCount: 0, interruptedCount: 0, items: [] }
        : url.searchParams.get("window") === "replayable"
          ? { events: [], pendingApprovals: [], truncated: false, bytes: 2, pinnedEventIds: [] }
          : [];
      return Response.json(body);
    }) as typeof fetch,
  });
  const sidecar = {
    state: () => ({
      sidecar: { phase: "healthy" as const, attempt: 0 },
      workspace: "/workspace",
      queuedBySession: {},
    }),
    getClient: () => client,
    getClientContext: () => ({ client, generation: 1 }),
    currentGeneration: () => 1,
    currentWorkspace: () => "/workspace",
    setQueuedCount: () => undefined,
  };
  const service = new DesktopControlService({
    sidecar: sidecar as never,
    selectWorkspace: async () => undefined,
    persistWorkspace: async () => undefined,
    emitQueue: () => undefined,
    onError: () => undefined,
  });
  // registerDesktopIpc installs this exact dispatcher behind sender validation.
  const dispatch = createDesktopRequestDispatcher(service, {
    completeResync: () => ({ status: "retry" }),
  });

  const requests = Array.from({ length: 100 }, () => dispatch({
    type: "session.snapshot",
    sessionId: "session_1",
  }).then(
    () => "fulfilled" as const,
    (error: unknown) => error instanceof Error && error.message.includes("DESKTOP_IPC_CAPACITY")
      ? "capacity" as const
      : `unexpected:${error instanceof Error ? error.message : String(error)}` as const,
  ));

  await waitUntil(() => totalHttp === 8);
  expect(activeHttp).toBe(8);
  gate.resolve();
  const outcomes = await Promise.all(requests);
  expect(outcomes.filter((outcome) => outcome.startsWith("unexpected:"))).toEqual([]);
  expect(outcomes.filter((outcome) => outcome === "fulfilled")).toHaveLength(8);
  expect(outcomes.filter((outcome) => outcome === "capacity")).toHaveLength(92);
  expect(peakHttp).toBeLessThanOrEqual(32);
});

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value as T) };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for snapshot HTTP admission");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
