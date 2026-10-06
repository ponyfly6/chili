import { expect, test } from "bun:test";
import { PERSISTED_ERROR_LIMITS, SESSION_TITLE_MAX_CHARS } from "@chili/protocol";
import type {
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  SessionId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import type { ApprovalRow, EventQuery, EventStore, SessionRow } from "@chili/store";
import type {
  AgentRunner,
  AppendUserMessageInput,
  CreateSessionInput,
  RunTurnInput,
  RunTurnResult,
} from "./runner.js";
import { RuntimeService, RuntimeServiceClosedError } from "./runtime-service.js";

test("RuntimeService shutdown waits for an aborted prompt to settle and release its run claim", async () => {
  const sessionId = "session_shutdown_slow_prompt" as SessionId;
  const runner = new AbortAwareSlowRunner();
  const { service, store } = runtimeFixture(runner, sessionId);
  const prompt = service.submitPrompt({ sessionId, text: "keep running" });

  await runner.started.promise;
  expect(store.claims.has(sessionId)).toBe(true);

  const shutdown = service.shutdown("test_shutdown");
  await runner.abortObserved.promise;

  let shutdownSettled = false;
  void shutdown.then(() => {
    shutdownSettled = true;
  });
  await Promise.resolve();

  expect(shutdownSettled).toBe(false);
  expect(store.releaseCalls).toEqual([]);
  expect(service.isRunning(sessionId)).toBe(true);

  runner.finish.resolve();
  const result = await prompt;
  expect(result.status).toBe("cancelled");
  await shutdown;

  expect(shutdownSettled).toBe(true);
  expect(service.isRunning(sessionId)).toBe(false);
  expect(store.claims.has(sessionId)).toBe(false);
  expect(store.releaseCalls).toEqual([sessionId]);
});

test("RuntimeService normalizes hostile runner Errors before returning or persisting status", async () => {
  const sessionId = "session_hostile_runner_error" as SessionId;
  const hugeMessage = "错".repeat(Math.ceil((5 * 1024 * 1024) / 3));
  const source = Object.assign(new Error(hugeMessage), {
    name: "RemoteRunnerError",
    code: "E_REMOTE_RUNNER",
    cause: { secret: "CAUSE_SECRET_MUST_NOT_PERSIST" },
  });
  const hostile = new Proxy(source, {
    get(target, key, receiver) {
      if (typeof key === "symbol") throw new Error("symbol getter trap");
      return Reflect.get(target, key, receiver);
    },
    deleteProperty() {
      throw new Error("delete trap");
    },
  });
  const { service, store } = runtimeFixture(new ProxyFailureRunner(hostile), sessionId);

  const result = await service.submitPrompt({ sessionId, text: "trigger failure" });
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  if (!result.error) throw new Error("Expected failed prompt error");
  expect(result.error).not.toBe(hostile);
  expect(result.error.name).toBe("RemoteRunnerError");
  expect((result.error as Error & { code?: string }).code).toBe("E_REMOTE_RUNNER");
  expect((result.error as Error & { cause?: unknown }).cause).toBeUndefined();
  expect(Buffer.byteLength(result.error.message, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
  const terminal = store.items.findLast(
    (event) => event.type === "session.status_changed" && event.payload.status === "failed",
  );
  expect(terminal?.type).toBe("session.status_changed");
  if (!terminal || terminal.type !== "session.status_changed") return;
  expect(Buffer.byteLength(terminal.payload.reason ?? "", "utf8"))
    .toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
  expect(JSON.stringify(terminal)).not.toContain("CAUSE_SECRET_MUST_NOT_PERSIST");
});

test("RuntimeService redacts, cleans, and bounds hostile interrupt reasons before status persistence", async () => {
  const sessionId = "session_hostile_interrupt_reason" as SessionId;
  const secret = "INTERRUPT_REASON_SECRET_MUST_NOT_PERSIST";
  const hostileReason = [
    `Authorization: Bearer ${secret}`,
    `password=${secret}\u0000`,
    "错".repeat(Math.ceil((5 * 1024 * 1024) / 3)),
  ].join("\n");
  expect(Buffer.byteLength(hostileReason, "utf8")).toBeGreaterThan(5 * 1024 * 1024);
  const runner = new AbortAwareSlowRunner();
  const { service, store } = runtimeFixture(runner, sessionId);
  const prompt = service.submitPrompt({ sessionId, text: "wait for hostile interrupt" });

  try {
    await runner.started.promise;
    expect(await service.interrupt(sessionId, hostileReason)).toBe(true);
    runner.finish.resolve();
    const result = await prompt;
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") return;
    expect(result.error).toBeDefined();
    const resultError = result.error!;
    expect(Buffer.byteLength(resultError.message, "utf8"))
      .toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    expect(resultError.message).not.toContain(secret);
    expect(resultError.message).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);

    const statusEvents = store.items.filter(
      (event): event is Extract<ChiliEvent, { type: "session.status_changed" }> =>
        event.type === "session.status_changed"
          && (event.payload.status === "cancelling" || event.payload.status === "cancelled"),
    );
    expect(statusEvents.map((event) => event.payload.status)).toEqual(["cancelling", "cancelled"]);
    for (const event of statusEvents) {
      const reason = event.payload.reason ?? "";
      expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
      expect(reason).not.toContain(secret);
      expect(reason).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
      expect(reason).toContain("[REDACTED]");
    }
  } finally {
    runner.finish.resolve();
    await Promise.allSettled([prompt]);
  }
});

test("RuntimeService shutdown closes the prompt admission gate synchronously", async () => {
  const runningSessionId = "session_shutdown_gate_running" as SessionId;
  const rejectedSessionId = "session_shutdown_gate_rejected" as SessionId;
  const runner = new AbortAwareSlowRunner();
  const { service, store } = runtimeFixture(runner, runningSessionId, rejectedSessionId);
  const prompt = service.submitPrompt({ sessionId: runningSessionId, text: "first" });

  await runner.started.promise;
  const shutdown = service.shutdown("test_shutdown");

  await expect(service.submitPrompt({
    sessionId: rejectedSessionId,
    text: "must not be admitted",
  })).rejects.toBeInstanceOf(RuntimeServiceClosedError);
  expect(store.claimAttempts).toEqual([runningSessionId]);
  expect(runner.turnInputs).toHaveLength(1);

  runner.finish.resolve();
  await Promise.all([prompt, shutdown]);
  expect(store.releaseCalls).toEqual([runningSessionId]);
});

test("RuntimeService validates and applies configurable claim lease timing", async () => {
  const invalidStore = new ClaimTrackingEventStore();
  expect(() => new RuntimeService({
    runtime: new ImmediateAbortRunner(),
    store: invalidStore,
    cwd: "/repo",
    sessionClaimLeaseMs: 100,
    sessionClaimHeartbeatMs: 100,
  })).toThrow("smaller than sessionClaimLeaseMs");

  const sessionId = "session_short_claim_lease" as SessionId;
  const runner = new AbortAwareSlowRunner();
  const store = new ClaimTrackingEventStore();
  store.addSession(sessionId);
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    sessionClaimLeaseMs: 80,
    sessionClaimHeartbeatMs: 10,
  });
  const prompt = service.submitPrompt({ sessionId, text: "exercise short claim" });
  await runner.started.promise;
  await waitUntil(() => store.renewLeaseDurations.length > 0);

  expect(store.claimLeaseDurations).toEqual([80]);
  expect(store.renewLeaseDurations.every((duration) => duration === 80)).toBe(true);
  const shutdown = service.shutdown("test_shutdown");
  runner.finish.resolve();
  await Promise.all([prompt, shutdown]);
});

test("RuntimeService shutdown drains a submitPromptAsync reservation before its queued microtask runs", async () => {
  const sessionId = "session_shutdown_async_window" as SessionId;
  const runner = new ImmediateAbortRunner();
  const { service, store } = runtimeFixture(runner, sessionId);
  const backgroundErrors: unknown[] = [];

  service.submitPromptAsync(
    { sessionId, text: "accepted before the microtask" },
    (error) => backgroundErrors.push(error),
  );

  expect(service.isRunning(sessionId)).toBe(true);
  expect(store.claims.has(sessionId)).toBe(true);
  expect(store.releaseCalls).toEqual([]);

  const shutdown = service.shutdown("test_shutdown");
  expect(store.releaseCalls).toEqual([]);
  await shutdown;
  await Promise.resolve();

  expect(service.isRunning(sessionId)).toBe(false);
  expect(store.claims.has(sessionId)).toBe(false);
  expect(store.claimAttempts).toEqual([sessionId]);
  expect(store.releaseCalls).toEqual([sessionId]);
  expect(backgroundErrors).toEqual([]);
});

test("RuntimeService shutdown during async prompt preparation never publishes running or appends the user message", async () => {
  const sessionId = "session_shutdown_prepare_window" as SessionId;
  const runner = new ImmediateAbortRunner();
  const store = new SessionLookupGateStore();
  store.addSession(sessionId);
  const service = createRuntimeService(runner, store);
  const prompt = service.submitPrompt({ sessionId, text: "must remain uncommitted" });

  await store.lookupStarted.promise;
  const shutdown = service.shutdown("test_shutdown");
  store.allowLookup.resolve();

  expect(await prompt).toMatchObject({ status: "cancelled" });
  await shutdown;
  expect(statuses(store)).toEqual(["cancelled"]);
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
});

test("RuntimeService shutdown after running commits still fences appendUserMessage", async () => {
  const sessionId = "session_shutdown_running_publish_window" as SessionId;
  const runner = new ImmediateAbortRunner();
  const store = new RunningStatusReturnGateStore();
  store.addSession(sessionId);
  const service = createRuntimeService(runner, store);
  const prompt = service.submitPrompt({ sessionId, text: "must not append after shutdown" });

  await store.runningCommitted.promise;
  const shutdown = service.shutdown("test_shutdown");
  store.allowRunningReturn.resolve();

  expect(await prompt).toMatchObject({ status: "cancelled" });
  await shutdown;
  expect(statuses(store)).toEqual(["running", "cancelled"]);
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
});

test("RuntimeService shutdown during prompt assembly does not start the first turn", async () => {
  const sessionId = "session_shutdown_prompt_assembly" as SessionId;
  const runner = new ImmediateAbortRunner();
  const store = new ClaimTrackingEventStore();
  store.addSession(sessionId);
  const assemblyStarted = deferred<void>();
  const allowAssembly = deferred<void>();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    promptFragments: async () => {
      assemblyStarted.resolve();
      await allowAssembly.promise;
      return [];
    },
  });
  const prompt = service.submitPrompt({ sessionId, text: "stop during assembly" });

  await assemblyStarted.promise;
  const shutdown = service.shutdown("test_shutdown");
  allowAssembly.resolve();

  expect(await prompt).toMatchObject({ status: "cancelled" });
  await shutdown;
  expect(runner.turnInputs).toEqual([]);
  expect(statuses(store)).toEqual(["running", "cancelled"]);
});

test("RuntimeService shutdown during final prompt assembly does not start the final turn", async () => {
  const sessionId = "session_shutdown_final_assembly" as SessionId;
  const runner = new ToolUseThenFinalRunner();
  const store = new ClaimTrackingEventStore();
  store.addSession(sessionId);
  const finalAssemblyStarted = deferred<void>();
  const allowFinalAssembly = deferred<void>();
  let assemblyCalls = 0;
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    maxTurns: 1,
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    promptFragments: async () => {
      assemblyCalls += 1;
      if (assemblyCalls === 2) {
        finalAssemblyStarted.resolve();
        await allowFinalAssembly.promise;
      }
      return [];
    },
  });
  const prompt = service.submitPrompt({ sessionId, text: "reach the final response" });

  await finalAssemblyStarted.promise;
  const shutdown = service.shutdown("test_shutdown");
  allowFinalAssembly.resolve();

  expect(await prompt).toMatchObject({ status: "cancelled" });
  await shutdown;
  expect(runner.turnInputs).toHaveLength(1);
  expect(statuses(store)).toEqual(["running", "cancelled"]);
});

test("RuntimeService shutdown aborts a generic session operation without ghost status", async () => {
  const sessionId = "session_shutdown_generic_operation" as SessionId;
  const { service, store } = runtimeFixture(new ImmediateAbortRunner(), sessionId);
  const started = deferred<void>();
  const operation = service.withSessionOperation(sessionId, async ({ signal }) => {
    started.resolve();
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  });

  await started.promise;
  await Promise.all([operation, service.shutdown("test_shutdown")]);

  expect(statuses(store)).toEqual([]);
  expect(store.releaseCalls).toEqual([sessionId]);
});

test("RuntimeService shutdown after a completed prompt preserves the final idle status", async () => {
  const sessionId = "session_shutdown_after_idle" as SessionId;
  const runner = new ImmediateAbortRunner();
  const { service, store } = runtimeFixture(runner, sessionId);

  expect(await service.submitPrompt({ sessionId, text: "finish normally" })).toMatchObject({
    status: "completed",
  });
  await service.shutdown("test_shutdown");

  expect(statuses(store)).toEqual(["running", "idle"]);
  expect(store.items.filter((event) => (
    event.type === "session.status_changed" && event.payload.status === "cancelled"
  ))).toEqual([]);
});

test("standalone goal failure terminalizes before releasing its exact run claim", async () => {
  const sessionId = "session_goal_failure_claim_fence" as SessionId;
  const store = new PeerTakeoverOnReleaseStore(sessionId);
  store.addSession(sessionId);
  const service = createRuntimeService(new ThrowingGoalRunner(), store);

  await service.setGoal({ sessionId, objective: "fail inside the held claim" });
  await waitUntil(() => !service.isRunning(sessionId));

  expect(statuses(store)).toEqual(["running", "failed"]);
  expect(store.postReleaseStatuses).toEqual([]);
  expect(store.claims.get(sessionId)).toBe("peer_claim_after_release");
});

test("RuntimeService shutdown is idempotent while closing and after closure", async () => {
  const sessionId = "session_shutdown_idempotent" as SessionId;
  const runner = new AbortAwareSlowRunner();
  const { service, store } = runtimeFixture(runner, sessionId);
  const prompt = service.submitPrompt({ sessionId, text: "one run" });

  await runner.started.promise;
  const first = service.shutdown("first_shutdown");
  const second = service.shutdown("second_shutdown");
  expect(second).toBe(first);

  await runner.abortObserved.promise;
  runner.finish.resolve();
  await Promise.all([prompt, first, second]);

  const third = service.shutdown("third_shutdown");
  expect(third).toBe(first);
  await third;

  expect(runner.abortEvents).toBe(1);
  expect(store.releaseCalls).toEqual([sessionId]);
  expect(store.items.filter((event) => (
    event.type === "session.status_changed" && event.payload.status === "cancelled"
  ))).toHaveLength(1);
});

test("RuntimeService installs its shutdown promise before abort listeners can reenter", async () => {
  const sessionId = "session_shutdown_reentrant" as SessionId;
  const { service } = runtimeFixture(new ImmediateAbortRunner(), sessionId);
  const started = deferred<void>();
  let reentrantShutdown: Promise<void> | undefined;
  const operation = service.withSessionOperation(sessionId, ({ signal }) => new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => {
      reentrantShutdown = service.shutdown("reentrant_shutdown");
      resolve();
    }, { once: true });
    started.resolve();
  }));

  await started.promise;
  const shutdown = service.shutdown("outer_shutdown");
  await Promise.all([operation, shutdown]);

  expect(reentrantShutdown).toBe(shutdown);
});

test("RuntimeService shutdown waits for an admitted createSession and rejects later creations", async () => {
  const admittedSessionId = "session_shutdown_create_admitted" as SessionId;
  const rejectedSessionId = "session_shutdown_create_rejected" as SessionId;
  const runner = new CreateSessionGateRunner();
  const store = new ClaimTrackingEventStore();
  const service = createRuntimeService(runner, store);
  const creation = service.createSession({
    sessionId: admittedSessionId,
    cwd: "/repo",
  });

  try {
    await runner.createStarted.promise;
    const shutdown = service.shutdown("test_shutdown");

    await expect(service.createSession({
      sessionId: rejectedSessionId,
      cwd: "/repo",
    })).rejects.toBeInstanceOf(RuntimeServiceClosedError);
    expect(runner.createInputs).toEqual([
      { sessionId: admittedSessionId, cwd: "/repo" },
    ]);

    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    runner.allowCreate.resolve();
    await expect(creation).resolves.toEqual({ sessionId: admittedSessionId });
    await shutdown;

    expect(shutdownSettled).toBe(true);
    expect(store.items.filter((event) => (
      event.type === "session.status_changed"
      && event.sessionId === admittedSessionId
      && event.payload.status === "idle"
    ))).toHaveLength(1);
  } finally {
    runner.allowCreate.resolve();
    await Promise.allSettled([creation]);
  }
});

test("RuntimeService rejects every public mutation after shutdown", async () => {
  const holdingSessionId = "session_shutdown_mutation_holding" as SessionId;
  const sessionId = "session_shutdown_mutation_gate" as SessionId;
  const runner = new ImmediateAbortRunner();
  const { service, store } = runtimeFixture(runner, holdingSessionId, sessionId);
  const holdingStarted = deferred<void>();
  const allowHoldingToSettle = deferred<void>();
  const holding = service.withSessionOperation(holdingSessionId, async () => {
    holdingStarted.resolve();
    await allowHoldingToSettle.promise;
  });
  await holdingStarted.promise;
  const shutdown = service.shutdown("test_shutdown");

  const mutations: Array<{
    name: string;
    invoke(): unknown | Promise<unknown>;
  }> = [
    {
      name: "createSession",
      invoke: () => service.createSession({
        sessionId: "session_shutdown_mutation_create" as SessionId,
        cwd: "/repo",
      }),
    },
    {
      name: "appendUserMessage",
      invoke: () => service.appendUserMessage({ sessionId, text: "blocked" }),
    },
    {
      name: "setModel",
      invoke: () => service.setModel({
        sessionId,
        modelSelection: { provider: "test", model: "blocked" },
      }),
    },
    {
      name: "setReasoning",
      invoke: () => service.setReasoning({ sessionId, reasoningLevel: "high" }),
    },
    {
      name: "setServiceTier",
      invoke: () => service.setServiceTier({ sessionId, serviceTier: "fast" }),
    },
    {
      name: "setDelegationPolicy",
      invoke: () => service.setDelegationPolicy({ sessionId, policy: "off" }),
    },
    {
      name: "setGoal",
      invoke: () => service.setGoal({ sessionId, objective: "blocked" }),
    },
    {
      name: "updateGoal",
      invoke: () => service.updateGoal({ sessionId, status: "paused" }),
    },
    {
      name: "clearGoal",
      invoke: () => service.clearGoal({ sessionId }),
    },
    {
      name: "compactSession",
      invoke: () => service.compactSession({ sessionId }),
    },
    {
      name: "submitPrompt",
      invoke: () => service.submitPrompt({ sessionId, text: "blocked" }),
    },
    {
      name: "submitPromptAsync",
      invoke: () => service.submitPromptAsync({ sessionId, text: "blocked" }),
    },
    {
      name: "withSessionOperation",
      invoke: () => service.withSessionOperation(sessionId, () => undefined),
    },
    {
      name: "interrupt",
      invoke: () => service.interrupt(sessionId),
    },
    {
      name: "archiveSession",
      invoke: () => service.archiveSession(sessionId),
    },
    {
      name: "renameSession",
      invoke: () => service.renameSession(sessionId, "blocked"),
    },
  ];
  const eventsBefore = store.items.length;

  try {
    for (const mutation of mutations) {
      await expect(Promise.resolve().then(() => mutation.invoke()), mutation.name)
        .rejects.toBeInstanceOf(RuntimeServiceClosedError);
    }

    expect(store.items).toHaveLength(eventsBefore);
    expect(store.claimAttempts).toEqual([holdingSessionId]);
    expect(runner.userMessages).toEqual([]);
    expect(runner.turnInputs).toEqual([]);
  } finally {
    allowHoldingToSettle.resolve();
    await Promise.allSettled([holding, shutdown]);
  }
});

test("RuntimeService shutdown waits for an admitted non-run mutation", async () => {
  const sessionId = "session_shutdown_mutation_drain" as SessionId;
  const store = new RenameAppendGateStore();
  store.addSession(sessionId);
  const service = createRuntimeService(new ImmediateAbortRunner(), store);
  const rename = service.renameSession(sessionId, "admitted rename");

  await store.renameStarted.promise;
  const shutdown = service.shutdown("test_shutdown");
  let shutdownSettled = false;
  void shutdown.then(() => {
    shutdownSettled = true;
  });
  await Promise.resolve();

  expect(shutdownSettled).toBe(false);
  store.allowRename.resolve();
  await Promise.all([rename, shutdown]);

  expect(shutdownSettled).toBe(true);
  expect(store.items).toContainEqual(expect.objectContaining({
    type: "session.renamed",
    sessionId,
    payload: { sessionId, title: "admitted rename" },
  }));
  await expect(service.renameSession(sessionId, "too late"))
    .rejects.toBeInstanceOf(RuntimeServiceClosedError);
});

test("RuntimeService applies the canonical session title normalization and limit", async () => {
  const sessionId = "session_canonical_title" as SessionId;
  const { service, store } = runtimeFixture(new ImmediateAbortRunner(), sessionId);

  await service.renameSession(sessionId, "  Overnight   Goal\nconsole  ");
  await expect(service.renameSession(sessionId, "x".repeat(SESSION_TITLE_MAX_CHARS + 1)))
    .rejects.toThrow(`${SESSION_TITLE_MAX_CHARS} characters or fewer`);

  expect(store.items.filter((event) => event.type === "session.renamed")).toEqual([
    expect.objectContaining({
      sessionId,
      payload: { sessionId, title: "Overnight Goal console" },
    }),
  ]);
});

test("RuntimeService interrupt still aborts and settles when cancelling metadata fails", async () => {
  const sessionId = "session_shutdown_cancelling_failure" as SessionId;
  const runner = new AbortAwareBoundaryRunner();
  const store = new CancellingAppendFailureStore();
  store.addSession(sessionId);
  const service = createRuntimeService(runner, store);
  const prompt = service.submitPrompt({ sessionId, text: "wait for shutdown" });

  try {
    await runner.started.promise;
    expect(statuses(store)).toEqual(["running"]);

    const interrupt = service.interrupt(sessionId, "interrupt_metadata_failure");

    expect(runner.abortEvents).toBe(1);
    expect(store.cancellingAttempts).toBe(1);
    expect(store.releaseCalls).toEqual([]);
    expect(service.isRunning(sessionId)).toBe(true);
    await expect(interrupt).rejects.toThrow("cancelling status write failed");

    const shutdown = service.shutdown("shutdown_after_metadata_failure");

    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await runner.abortObserved.promise;
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    runner.finish.resolve();
    await expect(prompt).resolves.toMatchObject({ status: "cancelled" });
    await shutdown;

    expect(shutdownSettled).toBe(true);
    expect(service.isRunning(sessionId)).toBe(false);
    expect(store.claims.has(sessionId)).toBe(false);
    expect(store.releaseCalls).toEqual([sessionId]);
    expect(statuses(store)).toEqual(["running", "cancelled"]);
    expect(store.items.at(-1)).toMatchObject({
      type: "session.status_changed",
      sessionId,
      payload: {
        status: "cancelled",
        reason: "interrupt_metadata_failure",
      },
    });
  } finally {
    runner.finish.resolve();
    await Promise.allSettled([prompt]);
  }
});

test("RuntimeService keeps terminal cancellation behind an admitted interrupt metadata append", async () => {
  const sessionId = "session_interrupt_metadata_order" as SessionId;
  const runner = new AbortAwareBoundaryRunner();
  const store = new CancellingAppendGateStore();
  store.addSession(sessionId);
  const service = createRuntimeService(runner, store);
  const prompt = service.submitPrompt({ sessionId, text: "hold terminal status behind cancelling" });

  try {
    await runner.started.promise;
    const interrupt = service.interrupt(sessionId, "ordered_interrupt");
    await store.cancellingStarted.promise;

    expect(runner.abortEvents).toBe(1);
    runner.finish.resolve();
    await runner.abortObserved.promise;
    let promptSettled = false;
    void prompt.then(() => {
      promptSettled = true;
    });
    await Promise.resolve();

    expect(promptSettled).toBe(false);
    expect(store.releaseCalls).toEqual([]);
    expect(statuses(store)).toEqual(["running"]);

    store.allowCancelling.resolve();
    expect(await interrupt).toBe(true);
    await expect(prompt).resolves.toMatchObject({ status: "cancelled" });

    expect(store.releaseCalls).toEqual([sessionId]);
    expect(statuses(store)).toEqual(["running", "cancelling", "cancelled"]);
  } finally {
    store.allowCancelling.resolve();
    runner.finish.resolve();
    await Promise.allSettled([prompt]);
  }
});

test("RuntimeService concurrent shutdown drains interrupt metadata before terminal status and claim release", async () => {
  const sessionId = "session_shutdown_interrupt_metadata_order" as SessionId;
  const runner = new AbortAwareBoundaryRunner();
  const store = new CancellingAppendGateStore();
  store.addSession(sessionId);
  const service = createRuntimeService(runner, store);
  const prompt = service.submitPrompt({ sessionId, text: "shutdown during interrupt metadata" });

  try {
    await runner.started.promise;
    const interrupt = service.interrupt(sessionId, "shutdown_ordered_interrupt");
    await store.cancellingStarted.promise;
    const shutdown = service.shutdown("concurrent_shutdown");
    runner.finish.resolve();
    await runner.abortObserved.promise;

    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();

    expect(runner.abortEvents).toBe(1);
    expect(shutdownSettled).toBe(false);
    expect(service.isRunning(sessionId)).toBe(true);
    expect(store.claims.has(sessionId)).toBe(true);
    expect(store.releaseCalls).toEqual([]);
    expect(statuses(store)).toEqual(["running"]);

    store.allowCancelling.resolve();
    const [interrupted, result] = await Promise.all([interrupt, prompt, shutdown]);

    expect(interrupted).toBe(true);
    expect(result).toMatchObject({ status: "cancelled" });
    expect(shutdownSettled).toBe(true);
    expect(service.isRunning(sessionId)).toBe(false);
    expect(store.claims.has(sessionId)).toBe(false);
    expect(store.releaseCalls).toEqual([sessionId]);
    expect(statuses(store)).toEqual(["running", "cancelling", "cancelled"]);
  } finally {
    store.allowCancelling.resolve();
    runner.finish.resolve();
    await Promise.allSettled([prompt]);
  }
});

function runtimeFixture(runner: AgentRunner, ...sessionIds: SessionId[]): {
  service: RuntimeService;
  store: ClaimTrackingEventStore;
} {
  const store = new ClaimTrackingEventStore();
  for (const sessionId of sessionIds) store.addSession(sessionId);
  return {
    service: createRuntimeService(runner, store),
    store,
  };
}

function createRuntimeService(runner: AgentRunner, store: ClaimTrackingEventStore): RuntimeService {
  return new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
}

class AbortAwareSlowRunner implements AgentRunner {
  readonly started = deferred<void>();
  readonly abortObserved = deferred<void>();
  readonly finish = deferred<void>();
  readonly turnInputs: RunTurnInput[] = [];
  abortEvents = 0;

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    return input.sessionId ?? ("session_shutdown_created" as SessionId);
  }

  async appendUserMessage(_input: AppendUserMessageInput): Promise<MessageId> {
    return "message_shutdown_user" as MessageId;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.turnInputs.push(input);
    this.started.resolve();
    const signal = requiredSignal(input.signal);
    await this.waitForAbort(signal);
    await this.finish.promise;
    return {
      status: "cancelled",
      turnId: input.turnId ?? ("turn_shutdown_cancelled" as TurnId),
      error: abortReason(signal),
    };
  }

  private async waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.abortEvents += 1;
      this.abortObserved.resolve();
      return;
    }
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        this.abortEvents += 1;
        this.abortObserved.resolve();
        resolve();
      }, { once: true });
    });
  }
}

class ImmediateAbortRunner implements AgentRunner {
  readonly turnInputs: RunTurnInput[] = [];
  readonly userMessages: AppendUserMessageInput[] = [];

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    return input.sessionId ?? ("session_shutdown_created" as SessionId);
  }

  async appendUserMessage(input: AppendUserMessageInput): Promise<MessageId> {
    this.userMessages.push(input);
    return "message_shutdown_user" as MessageId;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.turnInputs.push(input);
    const signal = requiredSignal(input.signal);
    if (signal.aborted) {
      return {
        status: "cancelled",
        turnId: input.turnId ?? ("turn_shutdown_cancelled" as TurnId),
        error: abortReason(signal),
      };
    }
    return {
      status: "completed",
      turnId: input.turnId ?? ("turn_shutdown_completed" as TurnId),
      assistantMessageId: "message_shutdown_assistant" as MessageId,
      finishReason: "stop",
    };
  }
}

class ProxyFailureRunner extends ImmediateAbortRunner {
  constructor(private readonly error: Error) {
    super();
  }

  override async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    return {
      status: "failed",
      turnId: input.turnId ?? ("turn_hostile_runner_error" as TurnId),
      error: this.error,
    };
  }
}

class ToolUseThenFinalRunner extends ImmediateAbortRunner {
  override async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.turnInputs.push(input);
    return {
      status: "completed",
      turnId: input.turnId ?? ("turn_shutdown_tool_use" as TurnId),
      assistantMessageId: "message_shutdown_assistant" as MessageId,
      finishReason: "tool_use",
    };
  }
}

class CreateSessionGateRunner implements AgentRunner {
  readonly createStarted = deferred<void>();
  readonly allowCreate = deferred<void>();
  readonly createInputs: CreateSessionInput[] = [];

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    this.createInputs.push(input);
    this.createStarted.resolve();
    await this.allowCreate.promise;
    return input.sessionId ?? ("session_shutdown_created" as SessionId);
  }

  async appendUserMessage(_input: AppendUserMessageInput): Promise<MessageId> {
    return "message_shutdown_user" as MessageId;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    return {
      status: "completed",
      turnId: input.turnId ?? ("turn_shutdown_completed" as TurnId),
      assistantMessageId: "message_shutdown_assistant" as MessageId,
      finishReason: "stop",
    };
  }
}

class AbortAwareBoundaryRunner implements AgentRunner {
  readonly started = deferred<void>();
  readonly abortObserved = deferred<void>();
  readonly finish = deferred<void>();
  abortEvents = 0;

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    return input.sessionId ?? ("session_shutdown_created" as SessionId);
  }

  async appendUserMessage(_input: AppendUserMessageInput): Promise<MessageId> {
    return "message_shutdown_user" as MessageId;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.started.resolve();
    const signal = requiredSignal(input.signal);
    if (signal.aborted) {
      this.abortEvents += 1;
      this.abortObserved.resolve();
    } else {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          this.abortEvents += 1;
          this.abortObserved.resolve();
          resolve();
        }, { once: true });
      });
    }
    await this.finish.promise;
    throw abortReason(signal);
  }
}

class ThrowingGoalRunner implements AgentRunner {
  async createSession(input: CreateSessionInput): Promise<SessionId> {
    return input.sessionId ?? ("session_shutdown_created" as SessionId);
  }

  async appendUserMessage(_input: AppendUserMessageInput): Promise<MessageId> {
    return "message_goal_failure_user" as MessageId;
  }

  async runTurn(): Promise<RunTurnResult> {
    throw new Error("goal continuation failed inside claim");
  }
}

class ClaimTrackingEventStore implements EventStore {
  readonly items: ChiliEvent[] = [];
  readonly sessionRows: SessionRow[] = [];
  readonly claims = new Map<SessionId, string>();
  readonly claimAttempts: SessionId[] = [];
  readonly releaseCalls: SessionId[] = [];
  readonly claimLeaseDurations: number[] = [];
  readonly renewLeaseDurations: number[] = [];

  async append(event: ChiliEvent): Promise<void> {
    this.items.push(event);
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    this.items.push(...events);
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    const afterIndex = query.afterEventId
      ? this.items.findIndex((event) => event.id === query.afterEventId)
      : -1;
    const filtered = this.items
      .slice(afterIndex + 1)
      .filter((event) => !query.sessionId || event.sessionId === query.sessionId)
      .filter((event) => !query.type || event.type === query.type);
    const limit = query.limit ?? 500;
    return query.tail ? filtered.slice(-limit) : filtered.slice(0, limit);
  }

  async sessions(): Promise<SessionRow[]> {
    return this.sessionRows.map((row) => ({ ...row }));
  }

  async messages(_sessionId: SessionId): Promise<Message[]> {
    return [];
  }

  async pendingApprovals(_sessionId?: SessionId): Promise<ApprovalRow[]> {
    return [];
  }

  addSession(sessionId: SessionId): void {
    this.sessionRows.push({
      id: sessionId,
      cwd: "/repo",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
  }

  claimSessionRun(input: {
    sessionId: SessionId;
    claimId: string;
    sessionAccess?: "root" | "child";
    time: number;
    leaseDurationMs: number;
  }): { status: "claimed" | "busy" | "inactive" | "not_found" | "forbidden"; sessionStatus?: string } {
    this.claimAttempts.push(input.sessionId);
    this.claimLeaseDurations.push(input.leaseDurationMs);
    const session = this.sessionRows.find((candidate) => candidate.id === input.sessionId);
    if (!session) return { status: "not_found" };
    if (session.status !== "active") return { status: "inactive", sessionStatus: session.status };
    if (session.readOnly || Boolean(session.agent) !== (input.sessionAccess === "child")) return { status: "forbidden" };
    if (this.claims.has(input.sessionId)) return { status: "busy" };
    this.claims.set(input.sessionId, input.claimId);
    return { status: "claimed" };
  }

  renewSessionRun(input: {
    sessionId: SessionId;
    claimId: string;
    time: number;
    leaseDurationMs: number;
  }): boolean {
    this.renewLeaseDurations.push(input.leaseDurationMs);
    return this.claims.get(input.sessionId) === input.claimId;
  }

  releaseSessionRun(input: { sessionId: SessionId; claimId: string }): void {
    if (this.claims.get(input.sessionId) !== input.claimId) return;
    this.claims.delete(input.sessionId);
    this.releaseCalls.push(input.sessionId);
  }
}

class CancellingAppendFailureStore extends ClaimTrackingEventStore {
  cancellingAttempts = 0;

  override async append(event: ChiliEvent): Promise<void> {
    if (event.type === "session.status_changed" && event.payload.status === "cancelling") {
      this.cancellingAttempts += 1;
      throw new Error("cancelling status write failed");
    }
    await super.append(event);
  }
}

class CancellingAppendGateStore extends ClaimTrackingEventStore {
  readonly cancellingStarted = deferred<void>();
  readonly allowCancelling = deferred<void>();

  override async append(event: ChiliEvent): Promise<void> {
    if (event.type === "session.status_changed" && event.payload.status === "cancelling") {
      this.cancellingStarted.resolve();
      await this.allowCancelling.promise;
    }
    await super.append(event);
  }
}

class SessionLookupGateStore extends ClaimTrackingEventStore {
  readonly lookupStarted = deferred<void>();
  readonly allowLookup = deferred<void>();

  override async sessions(): Promise<SessionRow[]> {
    this.lookupStarted.resolve();
    await this.allowLookup.promise;
    return super.sessions();
  }
}

class RunningStatusReturnGateStore extends ClaimTrackingEventStore {
  readonly runningCommitted = deferred<void>();
  readonly allowRunningReturn = deferred<void>();

  override async append(event: ChiliEvent): Promise<void> {
    await super.append(event);
    if (event.type === "session.status_changed" && event.payload.status === "running") {
      this.runningCommitted.resolve();
      await this.allowRunningReturn.promise;
    }
  }
}

class RenameAppendGateStore extends ClaimTrackingEventStore {
  readonly renameStarted = deferred<void>();
  readonly allowRename = deferred<void>();

  override async append(event: ChiliEvent): Promise<void> {
    if (event.type === "session.renamed") {
      this.renameStarted.resolve();
      await this.allowRename.promise;
    }
    await super.append(event);
  }
}

class PeerTakeoverOnReleaseStore extends ClaimTrackingEventStore {
  readonly postReleaseStatuses: string[] = [];
  private released = false;

  constructor(private readonly fencedSessionId: SessionId) {
    super();
  }

  override async append(event: ChiliEvent): Promise<void> {
    if (this.released && event.type === "session.status_changed" && event.sessionId === this.fencedSessionId) {
      this.postReleaseStatuses.push(event.payload.status);
    }
    await super.append(event);
  }

  override releaseSessionRun(input: { sessionId: SessionId; claimId: string }): void {
    super.releaseSessionRun(input);
    if (input.sessionId !== this.fencedSessionId) return;
    this.released = true;
    this.claims.set(input.sessionId, "peer_claim_after_release");
  }
}

function statuses(store: ClaimTrackingEventStore): string[] {
  return store.items.flatMap((event) => (
    event.type === "session.status_changed" ? [event.payload.status] : []
  ));
}

function requiredSignal(signal: AbortSignal | undefined): AbortSignal {
  if (!signal) throw new Error("Expected RuntimeService to pass a run signal");
  return signal;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Prompt aborted");
  error.name = "AbortError";
  return error;
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T | PromiseLike<T>): void } {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise(value as T | PromiseLike<T>);
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
