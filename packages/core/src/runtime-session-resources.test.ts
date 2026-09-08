import { afterEach, expect, test } from "bun:test";
import type { MessageId, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type { AgentRunner, RunTurnInput, RunTurnResult } from "./runner.js";
import { RuntimeBusyError, RuntimeService, type RuntimeServiceOptions } from "./runtime-service.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("idle Stop waits for owned resources without reporting an interrupted model turn", async () => {
  const released = deferred();
  const started = deferred();
  const calls: Array<[SessionId, string]> = [];
  const { service, sessionId, store } = await fixture(async (owner, reason) => {
    calls.push([owner, reason]);
    started.resolve();
    await released.promise;
    return true;
  });
  const stopping = service.interrupt(sessionId, "desktop_stop");
  await started.promise;
  let settled = false;
  void stopping.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  released.resolve();
  expect(await stopping).toBe(false);
  expect(calls).toEqual([[sessionId, "desktop_stop"]]);
  expect((await store.events({ sessionId, type: "session.status_changed" })).length).toBe(0);
});

test("normal replies and model failures preserve working session resources", async () => {
  const calls: string[] = [];
  const { service, sessionId, runner } = await fixture(async (_owner, reason) => {
    calls.push(reason);
    return true;
  });
  expect((await service.submitPrompt({ sessionId, text: "show the running app" })).status).toBe("completed");
  runner.fail = true;
  expect((await service.submitPrompt({ sessionId, text: "continue" })).status).toBe("failed");
  expect(calls).toEqual([]);
});

test("Desktop steering cancels the model while preserving its working services", async () => {
  const calls: string[] = [];
  const { service, sessionId, runner } = await fixture(async (_owner, reason) => {
    calls.push(reason);
    return true;
  });
  runner.waitForAbort = true;
  const prompt = service.submitPrompt({ sessionId, text: "work" });
  await runner.started.promise;
  expect(await service.interrupt(sessionId, "desktop_steer")).toBe(true);
  expect((await prompt).status).toBe("cancelled");
  expect(calls).toEqual([]);
  expect(await service.interrupt(sessionId, "desktop_steer")).toBe(false);
  expect(calls).toEqual([]);
});

test("active Stop aborts promptly and holds prompt settlement until resources are drained", async () => {
  const released = deferred();
  const resourceStopStarted = deferred();
  const { service, sessionId, runner } = await fixture(async () => {
    resourceStopStarted.resolve();
    await released.promise;
    return true;
  });
  runner.waitForAbort = true;
  const prompt = service.submitPrompt({ sessionId, text: "work" });
  await runner.started.promise;
  const stopping = service.interrupt(sessionId);
  await Promise.all([runner.aborted.promise, resourceStopStarted.promise]);
  let promptSettled = false;
  void prompt.then(() => { promptSettled = true; });
  await Promise.resolve();
  expect(promptSettled).toBe(false);
  expect(service.isRunning(sessionId)).toBe(true);
  released.resolve();
  expect(await stopping).toBe(true);
  expect((await prompt).status).toBe("cancelled");
  expect(service.isRunning(sessionId)).toBe(false);
});

test("a synchronous resource callback failure cannot skip model cancellation", async () => {
  const failure = new Error("resource cleanup failed");
  const { service, sessionId, runner } = await fixture(() => { throw failure; });
  runner.waitForAbort = true;
  const prompt = service.submitPrompt({ sessionId, text: "work" });
  const promptOutcome = prompt.catch((error: unknown) => error);
  await runner.started.promise;
  await expect(service.interrupt(sessionId)).rejects.toBe(failure);
  await runner.aborted.promise;
  expect(await promptOutcome).toBe(failure);
  expect(service.isRunning(sessionId)).toBe(false);
});

test("interrupt publication failure still waits for resource cleanup", async () => {
  const released = deferred();
  const resourceStopStarted = deferred();
  const { service, sessionId, runner, store } = await fixture(async () => {
    resourceStopStarted.resolve();
    await released.promise;
    return true;
  });
  const append = store.append.bind(store);
  const failure = new Error("cannot publish cancelling");
  store.append = async (event, options) => {
    if (event.type === "session.status_changed" && event.payload.status === "cancelling") throw failure;
    await append(event, options);
  };
  runner.waitForAbort = true;
  const prompt = service.submitPrompt({ sessionId, text: "work" });
  const promptOutcome = prompt.catch((error: unknown) => error);
  await runner.started.promise;
  const stopping = service.interrupt(sessionId);
  const stopOutcome = stopping.catch((error: unknown) => error);
  await Promise.all([runner.aborted.promise, resourceStopStarted.promise]);
  let stopSettled = false;
  void stopOutcome.then(() => { stopSettled = true; });
  await Promise.resolve();
  expect(stopSettled).toBe(false);
  released.resolve();
  expect(await stopOutcome).toBe(failure);
  await promptOutcome;
  expect(service.isRunning(sessionId)).toBe(false);
});

test("external prompt abort drains resources once before releasing the session", async () => {
  const released = deferred();
  const resourceStopStarted = deferred();
  const calls: string[] = [];
  const { service, sessionId, runner } = await fixture(async (_owner, reason) => {
    calls.push(reason);
    resourceStopStarted.resolve();
    await released.promise;
    return true;
  });
  runner.waitForAbort = true;
  const controller = new AbortController();
  const prompt = service.submitPrompt({ sessionId, text: "work", signal: controller.signal });
  await runner.started.promise;
  controller.abort();
  await Promise.all([runner.aborted.promise, resourceStopStarted.promise]);
  const stopping = service.interrupt(sessionId);
  expect(service.isRunning(sessionId)).toBe(true);
  released.resolve();
  expect((await prompt).status).toBe("cancelled");
  expect(await stopping).toBe(true);
  expect(calls).toEqual(["prompt_aborted"]);
});

test("aborting a completed prompt's old signal does not stop services used by later work", async () => {
  const calls: string[] = [];
  const { service, sessionId, runner } = await fixture(async (_owner, reason) => {
    calls.push(reason);
    return true;
  });
  const oldController = new AbortController();
  await service.submitPrompt({ sessionId, text: "first", signal: oldController.signal });
  runner.started = deferred();
  runner.waitForAbort = true;
  const next = service.submitPrompt({ sessionId, text: "next" });
  await runner.started.promise;
  oldController.abort();
  await Promise.resolve();
  expect(calls).toEqual([]);
  expect(service.isRunning(sessionId)).toBe(true);
  await service.interrupt(sessionId);
  await next;
  expect(calls).toEqual(["user_interrupt"]);
});

test("archive commits its state then waits for session resource cleanup", async () => {
  const released = deferred();
  const resourceStopStarted = deferred();
  let archivedBeforeCleanup = false;
  const state = await fixture(async (owner, reason) => {
    expect(owner).toBe(state.sessionId);
    expect(reason).toBe("session_archived");
    archivedBeforeCleanup = (await state.store.sessions()).find((row) => row.id === owner)?.status === "archived";
    resourceStopStarted.resolve();
    await released.promise;
    return true;
  });
  const archiving = state.service.archiveSession(state.sessionId);
  await resourceStopStarted.promise;
  expect(archivedBeforeCleanup).toBe(true);
  let settled = false;
  void archiving.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  released.resolve();
  await archiving;
});

test("rejected archive does not clean the running task's resources", async () => {
  const calls: string[] = [];
  const { service, sessionId, runner } = await fixture(async (_owner, reason) => {
    calls.push(reason);
    return true;
  });
  runner.waitForAbort = true;
  const prompt = service.submitPrompt({ sessionId, text: "work" });
  await runner.started.promise;
  await expect(service.archiveSession(sessionId)).rejects.toBeInstanceOf(RuntimeBusyError);
  expect(calls).toEqual([]);
  await service.interrupt(sessionId);
  await prompt;
});

async function fixture(stopSessionResources: NonNullable<RuntimeServiceOptions["stopSessionResources"]>) {
  const store = new SqliteEventStore(":memory:");
  const sessionId = "session_managed_resources" as SessionId;
  await store.append({
    id: "event_session_created",
    type: "session.created",
    sessionId,
    time: 1 as TimestampMs,
    payload: { sessionId, cwd: process.cwd() },
  });
  const runner = new ResourceTestRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: process.cwd(),
    stopSessionResources,
  });
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
  });
  return { service, store, runner, sessionId };
}

class ResourceTestRunner implements AgentRunner {
  started = deferred();
  readonly aborted = deferred();
  waitForAbort = false;
  fail = false;

  async createSession(): Promise<SessionId> {
    return "session_managed_resources" as SessionId;
  }

  async appendUserMessage(): Promise<MessageId> {
    return "message_user" as MessageId;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.started.resolve();
    const turnId = input.turnId ?? "turn_resources" as TurnId;
    if (this.waitForAbort) {
      const signal = input.signal!;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      this.aborted.resolve();
      return { status: "cancelled", turnId, error: Object.assign(new Error("cancelled"), { name: "AbortError" }) };
    }
    if (this.fail) return { status: "failed", turnId, error: new Error("transient model failure") };
    return { status: "completed", turnId, assistantMessageId: "message_assistant" as MessageId, finishReason: "stop" };
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
