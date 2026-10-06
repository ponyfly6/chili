import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type {
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  PartId,
  RuntimeEvent,
  RuntimeModelDescriptor,
  SessionId,
  TimestampMs,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import {
  ObservableEventStore,
  SessionCreationClaimConflictError,
  SessionCwdConflictError,
  SqliteEventStore,
  type ApprovalRow,
  type EventQuery,
  type EventStore,
  type SessionRow,
} from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import type { AgentRunner, AppendUserMessageInput, CreateSessionInput, RunTurnInput, RunTurnResult } from "./runner.js";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";
import {
  RuntimeBusyError,
  RuntimeSessionAlreadyExistsError,
  RuntimeSessionClaimCapabilityError,
  RuntimeSessionCreationConflictError,
  RuntimeSessionInactiveError,
  RuntimeSessionNotFoundError,
  RuntimeService,
  RuntimeSessionAccessError,
  type RuntimeSessionOperation,
} from "./runtime-service.js";
import { SingleAgentRuntime } from "./single-agent-runtime.js";

test("RuntimeService accepts an AgentRunner implementation", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_1" as SessionId;
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: () => [
      {
        id: "test.base",
        layer: "base",
        source: "core",
        priority: 0,
        lifecycle: "turn",
        trust: "system",
        content: "be brief",
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const handle = await service.createSession({
    cwd: "/workspace",
  });
  store.addSession(handle.sessionId, "/workspace");
  const result = await service.submitPrompt({
    sessionId: handle.sessionId,
    text: "hello",
    cwd: "/workspace",
  });

  expect(result.status).toBe("completed");
  if (result.status === "completed") {
    expect(result.finishReason).toBe("stop");
  }
  expect(handle).toEqual({ sessionId });
  expect(runner.createInputs[0]).toEqual({
    sessionId,
    cwd: "/workspace",
  });
  expect(runner.userMessages[0]).toMatchObject({
    sessionId,
    text: "hello",
  });
  expect(runner.userMessages[0]?.turnId).toBe(runner.turnInputs[0]?.turnId);
  expect(runner.turnInputs[0]?.cwd).toBe("/workspace");
  expect(runner.turnInputs[0]?.system).toEqual(["be brief"]);
  expect(runner.turnInputs[0]?.signal?.aborted).toBe(false);
  expect(statuses(store)).toEqual(["idle", "running", "idle"]);
});

test("root RuntimeService rejects child sessions while the child runtime admits their persisted identity", async () => {
  const sessionId = "session_guarded_child" as SessionId;
  const store = new SessionIdentityEventStore({
    id: sessionId,
    cwd: "/repo",
    agent: childMetadata(),
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  });
  const rootRunner = new FakeAgentRunner();
  const root = new RuntimeService({ runtime: rootRunner, store, cwd: "/repo" });
  const input = { sessionId, text: "bypass child policy" };

  await expect(root.assertSessionReadAllowed(sessionId)).rejects.toBeInstanceOf(
    RuntimeSessionAccessError,
  );
  await expect(root.submitPrompt(input)).rejects.toMatchObject({
    name: "RuntimeSessionAccessError",
    message: expect.stringContaining(sessionId),
  });
  const asyncError = new Promise<unknown>((resolve) => {
    root.submitPromptAsync({ ...input, text: "async bypass" }, resolve);
  });
  await expect(asyncError).resolves.toMatchObject({
    name: "RuntimeSessionAccessError",
    message: expect.stringContaining(sessionId),
  });
  expect(root.isRunning(sessionId)).toBe(false);
  await expect(root.appendUserMessage(input)).rejects.toThrow(sessionId);
  await expect(root.compactSession({ sessionId })).rejects.toBeInstanceOf(
    RuntimeSessionAccessError,
  );
  await expect(root.setGoal({ sessionId, objective: "bypass through goal continuation" })).rejects.toBeInstanceOf(
    RuntimeSessionAccessError,
  );
  await expect(root.updateGoal({ sessionId, status: "paused" })).rejects.toBeInstanceOf(
    RuntimeSessionAccessError,
  );
  await expect(root.clearGoal({ sessionId })).rejects.toBeInstanceOf(RuntimeSessionAccessError);
  await expect(root.inspectPrompt({ sessionId })).rejects.toBeInstanceOf(RuntimeSessionAccessError);
  await expect(root.setModel({
    sessionId,
    modelSelection: { provider: "custom", model: "blocked" },
  })).rejects.toBeInstanceOf(RuntimeSessionAccessError);
  await expect(root.setReasoning({ sessionId, reasoningLevel: "high" })).rejects.toBeInstanceOf(
    RuntimeSessionAccessError,
  );
  await expect(root.setServiceTier({ sessionId, serviceTier: "fast" })).rejects.toBeInstanceOf(
    RuntimeSessionAccessError,
  );
  await expect(root.setDelegationPolicy({ sessionId, policy: "off" })).rejects.toBeInstanceOf(
    RuntimeSessionAccessError,
  );
  await expect(root.renameSession(sessionId, "blocked rename")).rejects.toBeInstanceOf(
    RuntimeSessionAccessError,
  );
  await expect(root.archiveSession(sessionId)).rejects.toBeInstanceOf(RuntimeSessionAccessError);
  expect(rootRunner.userMessages).toEqual([]);
  expect(rootRunner.turnInputs).toEqual([]);

  const childRunner = new FakeAgentRunner();
  store.messageRows.push({
    id: "message_assistant_fake" as MessageId,
    sessionId,
    role: "assistant",
    createdAt: 1 as TimestampMs,
    parts: [{ id: "child_answer" as PartId, messageId: "message_assistant_fake" as MessageId,
      sessionId, type: "text", text: "Verified the parser implementation and its regression test." }],
  });
  const child = new RuntimeService({
    runtime: childRunner,
    store,
    cwd: "/repo",
    sessionAccess: "child",
  });
  await expect(child.assertSessionReadAllowed(sessionId)).resolves.toBeUndefined();
  await expect(child.submitPrompt({ ...input, text: "authorized child continuation" })).resolves.toMatchObject({
    status: "completed",
  });
  await expect(child.inspectPrompt({ sessionId })).resolves.toHaveProperty("fragments");
  await expect(child.setDelegationPolicy({ sessionId, policy: "off" })).resolves.toMatchObject({
    policy: "off",
  });
  expect(childRunner.userMessages).toHaveLength(1);
  expect(childRunner.turnInputs).toHaveLength(1);
});

test("child runtimes reject root sessions and cannot create sessions outside atomic Agent creation", async () => {
  const sessionId = "session_root_not_child" as SessionId;
  const store = new MemoryEventStore();
  store.addSession(sessionId);
  const runner = new FakeAgentRunner();
  const child = new RuntimeService({ runtime: runner, store, cwd: "/repo", sessionAccess: "child" });

  await expect(child.assertSessionReadAllowed(sessionId)).rejects.toBeInstanceOf(RuntimeSessionAccessError);
  await expect(child.submitPrompt({ sessionId, text: "wrong identity" })).rejects.toMatchObject({ name: "RuntimeSessionAccessError" });
  await expect(child.createSession({ sessionId: "session_unowned_child" as SessionId })).rejects.toBeInstanceOf(RuntimeSessionAccessError);
  expect(runner.createInputs).toEqual([]);
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
  expect(store.items).toEqual([]);
});

test("historical sessions remain readable and reject execution and mutation in both runtimes", async () => {
  const sessionId = "session_historical_read_only" as SessionId;
  for (const sessionAccess of ["root", "child"] as const) {
    const store = new SessionIdentityEventStore({ id: sessionId, cwd: "/history", readOnly: true,
      status: "active", createdAt: 1, updatedAt: 1 });
    const runner = new FakeAgentRunner();
    const service = new RuntimeService({ runtime: runner, store, cwd: "/repo", sessionAccess });
    await expect(service.assertSessionReadAllowed(sessionId)).resolves.toBeUndefined();
    const mutations: Array<() => Promise<unknown>> = [
      () => service.submitPrompt({ sessionId, text: "restart legacy work" }),
      () => service.appendUserMessage({ sessionId, text: "change history" }),
      () => service.compactSession({ sessionId }),
      () => service.setGoal({ sessionId, objective: "restart legacy work" }),
      () => service.updateGoal({ sessionId, status: "active" }),
      () => service.setDelegationPolicy({ sessionId, policy: "proactive" }),
      () => service.renameSession(sessionId, "changed"),
      () => service.archiveSession(sessionId),
    ];
    for (const mutate of mutations) await expect(mutate()).rejects.toMatchObject({ name: "RuntimeSessionAccessError" });
    expect(runner.userMessages).toEqual([]);
    expect(runner.turnInputs).toEqual([]);
    expect(store.items).toEqual([]);
  }
});

test("RuntimeService allows archived root reads without reopening turn admission", async () => {
  const sessionId = "session_archived_root_read" as SessionId;
  const store = new SessionIdentityEventStore({
    id: sessionId,
    cwd: "/repo",
    status: "archived",
    createdAt: 1,
    updatedAt: 2,
  });
  const service = new RuntimeService({ runtime: new FakeAgentRunner(), store, cwd: "/repo" });

  await expect(service.assertSessionReadAllowed(sessionId)).resolves.toBeUndefined();
  await expect(service.assertSessionTurnAllowed(sessionId)).rejects.toBeInstanceOf(
    RuntimeSessionInactiveError,
  );
});

test("RuntimeService rejects duplicate explicit session ids before creating or changing cwd", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_existing_create" as SessionId;
  store.addSession(sessionId, "/authoritative/repo");
  const service = new RuntimeService({ runtime: runner, store, cwd: "/default/repo" });

  await expect(service.createSession({
    sessionId,
    cwd: "/authoritative/repo",
  })).rejects.toBeInstanceOf(RuntimeSessionAlreadyExistsError);
  await expect(service.createSession({
    sessionId,
    cwd: "/attacker/repo",
  })).rejects.toBeInstanceOf(RuntimeSessionAlreadyExistsError);

  expect(runner.createInputs).toEqual([]);
  expect((await store.sessions())[0]?.cwd).toBe("/authoritative/repo");
  expect(store.items).toEqual([]);
});

test("RuntimeService rejects a concurrent duplicate explicit session id", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_concurrent_create" as SessionId;
  const started = deferred<void>();
  const release = deferred<void>();
  runner.onCreateSession = async () => {
    started.resolve();
    await release.promise;
  };
  const service = new RuntimeService({ runtime: runner, store, cwd: "/repo" });

  const first = service.createSession({ sessionId });
  await started.promise;
  await expect(service.createSession({ sessionId })).rejects.toBeInstanceOf(
    RuntimeSessionAlreadyExistsError,
  );
  release.resolve();

  await expect(first).resolves.toEqual({ sessionId });
  expect(runner.createInputs).toEqual([{ sessionId, cwd: "/repo" }]);
});

test("SQLite atomically rejects the same explicit session id across RuntimeService instances and connections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-cross-service-create-"));
  const path = join(dir, "events.sqlite");
  const firstStore = new SqliteEventStore(path);
  const secondStore = new SqliteEventStore(path);
  const firstEvents = new ObservableEventStore(firstStore);
  const secondEvents = new ObservableEventStore(secondStore);
  const firstRunner = new FakeAgentRunner();
  const secondRunner = new FakeAgentRunner();
  const sessionId = "session_cross_service_create" as SessionId;
  const createId = createSequentialId();
  const persistSession = (store: EventStore) => async (input: CreateSessionInput) => {
    const createdSessionId = input.sessionId ?? sessionId;
    await store.append({
      id: createId("event"),
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId: createdSessionId,
      payload: { sessionId: createdSessionId, cwd: input.cwd },
    });
  };
  firstRunner.onCreateSession = persistSession(firstEvents);
  secondRunner.onCreateSession = persistSession(secondEvents);

  try {
    const first = new RuntimeService({ runtime: firstRunner, store: firstEvents, cwd: "/repo", createId });
    const second = new RuntimeService({ runtime: secondRunner, store: secondEvents, cwd: "/repo", createId });
    const results = await Promise.allSettled([
      first.createSession({ sessionId, cwd: "/repo" }),
      second.createSession({ sessionId, cwd: "/repo" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" ? rejection.reason : undefined).toBeInstanceOf(
      RuntimeSessionAlreadyExistsError,
    );
    expect(firstRunner.createInputs.length + secondRunner.createInputs.length).toBe(1);
    expect((await firstStore.events({ sessionId, type: "session.created", limit: 10 }))).toHaveLength(1);
    expect((await firstStore.events({ sessionId, type: "session.status_changed", limit: 10 })).map((event) =>
      event.type === "session.status_changed"
        ? (event.payload as { status: string }).status
        : undefined
    )).toEqual(["idle"]);
    expect(await secondStore.sessions()).toEqual([
      expect.objectContaining({ id: sessionId, cwd: "/repo", status: "active" }),
    ]);
  } finally {
    secondStore.close();
    firstStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite keeps generated session creation fenced through the initial idle status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-cross-service-create-idle-"));
  const path = join(dir, "events.sqlite");
  const creatorStore = new SqliteEventStore(path);
  const peerStore = new SqliteEventStore(path);
  const idleEntered = deferred<void>();
  const releaseIdle = deferred<void>();
  class InitialIdleGateStore extends ObservableEventStore {
    override async append(event: RuntimeEvent, options?: Parameters<ObservableEventStore["append"]>[1]): Promise<void> {
      if (
        event.type === "session.status_changed"
        && event.payload.reason === "session_created"
      ) {
        idleEntered.resolve();
        await releaseIdle.promise;
      }
      await super.append(event, options);
    }
  }
  const creatorEvents = new InitialIdleGateStore(creatorStore);
  const peerEvents = new ObservableEventStore(peerStore);
  const creatorRunner = new FakeAgentRunner();
  const peerRunner = new FakeAgentRunner();
  let generatedSessionId: SessionId | undefined;
  creatorRunner.onCreateSession = async (input) => {
    if (!input.sessionId) throw new Error("RuntimeService must preallocate a generated session id");
    generatedSessionId = input.sessionId;
    await creatorEvents.append({
      id: "event_generated_session_create",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId: input.sessionId,
      payload: { sessionId: input.sessionId, cwd: input.cwd },
    });
  };
  const creator = new RuntimeService({
    runtime: creatorRunner,
    store: creatorEvents,
    cwd: "/repo",
    createId: createSequentialId(),
  });
  const peer = new RuntimeService({
    runtime: peerRunner,
    store: peerEvents,
    cwd: "/repo",
    createId: createSequentialId(),
  });
  let creation: ReturnType<RuntimeService["createSession"]> | undefined;

  try {
    creation = creator.createSession({ cwd: "/repo" });
    await idleEntered.promise;
    if (!generatedSessionId) throw new Error("Generated session id was not observed");

    const runError = await peer.submitPrompt({
      sessionId: generatedSessionId,
      text: "must stay fenced until idle",
    }).then(() => undefined, (error: unknown) => error);
    const archiveError = await peer.archiveSession(generatedSessionId)
      .then(() => undefined, (error: unknown) => error);

    expect(runError).toBeInstanceOf(RuntimeBusyError);
    expect(archiveError).toBeInstanceOf(RuntimeBusyError);
    expect(peerRunner.turnInputs).toEqual([]);
    expect(await peerStore.events({
      sessionId: generatedSessionId,
      type: "session.archived",
      limit: 10,
    })).toEqual([]);

    releaseIdle.resolve();
    await expect(creation).resolves.toEqual({ sessionId: generatedSessionId });
    await expect(peer.withSessionOperation(generatedSessionId, () => "available"))
      .resolves.toBe("available");
  } finally {
    releaseIdle.resolve();
    await creation?.catch(() => undefined);
    peerStore.close();
    creatorStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite rejects a stale initial idle after the creation claim is lost inside the append", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-create-idle-claim-loss-"));
  const path = join(dir, "events.sqlite");
  const creatorStore = new SqliteEventStore(path);
  const peerStore = new SqliteEventStore(path);
  const idleEntered = deferred<void>();
  const releaseIdle = deferred<void>();
  class InitialIdleGateStore extends ObservableEventStore {
    override async append(event: RuntimeEvent, options?: Parameters<ObservableEventStore["append"]>[1]): Promise<void> {
      if (
        event.type === "session.status_changed"
        && event.payload.reason === "session_created"
      ) {
        idleEntered.resolve();
        await releaseIdle.promise;
      }
      await super.append(event, options);
    }
  }
  const creatorEvents = new InitialIdleGateStore(creatorStore);
  const runner = new FakeAgentRunner();
  const sessionId = "session_initial_idle_claim_loss" as SessionId;
  runner.onCreateSession = async (input) => {
    await creatorEvents.append({
      id: "event_initial_idle_claim_loss_created",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: input.cwd },
    });
  };
  const creator = new RuntimeService({
    runtime: runner,
    store: creatorEvents,
    cwd: "/repo",
    createId: createSequentialId(),
  });
  const future = Date.now() + 1_000_000;
  let creation: ReturnType<RuntimeService["createSession"]> | undefined;

  try {
    creation = creator.createSession({ sessionId, cwd: "/repo" });
    await idleEntered.promise;

    expect(peerStore.claimSessionCreation({
      sessionId,
      claimId: "creation_claim_expiry_probe",
      cwd: "/repo",
      time: future,
      leaseDurationMs: 120_000,
    })).toEqual({ status: "already_exists" });
    expect(peerStore.claimSessionRun({
      sessionId,
      claimId: "run_claim_after_creation_expired",
      sessionAccess: "root",
      time: future,
      leaseDurationMs: 120_000,
    })).toEqual({ status: "claimed" });

    releaseIdle.resolve();
    await expect(creation).rejects.toBeInstanceOf(RuntimeSessionAlreadyExistsError);
    expect(await peerStore.events({
      sessionId,
      type: "session.status_changed",
      limit: 10,
    })).toEqual([]);
    peerStore.releaseSessionRun({
      sessionId,
      claimId: "run_claim_after_creation_expired",
    });
  } finally {
    releaseIdle.resolve();
    await creation?.catch(() => undefined);
    peerStore.releaseSessionRun({
      sessionId,
      claimId: "run_claim_after_creation_expired",
    });
    peerStore.close();
    creatorStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("RuntimeService distinguishes a lost creation claim from an existing session", async () => {
  const sessionId = "session_creation_conflict_without_entity" as SessionId;
  const errors = [
    new SessionCreationClaimConflictError(sessionId),
    new SessionCwdConflictError(sessionId, "/claimed/repo", "/runner/repo"),
  ];

  for (const sourceError of errors) {
    const store = Object.assign(new MemoryEventStore(), {
      claimSessionCreation: () => ({ status: "claimed" as const }),
      renewSessionCreation: () => true,
      releaseSessionCreation: () => undefined,
    });
    const runner = new FakeAgentRunner();
    runner.onCreateSession = () => {
      throw sourceError;
    };
    const service = new RuntimeService({
      runtime: runner,
      store,
      cwd: "/repo",
      createId: createSequentialId(),
    });

    await expect(service.createSession({ sessionId }))
      .rejects.toBeInstanceOf(RuntimeSessionCreationConflictError);
    expect(await store.sessions()).toEqual([]);
  }
});

test("RuntimeService fails closed on incomplete atomic session claim capabilities", async () => {
  const creationSessionId = "session_partial_creation_claim" as SessionId;
  const partialCreationStore = Object.assign(new MemoryEventStore(), {
    claimSessionCreation: () => ({ status: "claimed" as const }),
    releaseSessionCreation: () => undefined,
  });
  const creationRunner = new FakeAgentRunner();
  const creationService = new RuntimeService({
    runtime: creationRunner,
    store: partialCreationStore,
    cwd: "/repo",
    createId: createSequentialId(),
  });

  const creationError = await creationService.createSession({ sessionId: creationSessionId })
    .then(() => undefined, (error: unknown) => error);
  expect(creationError).toBeInstanceOf(RuntimeSessionClaimCapabilityError);
  expect(creationError).toMatchObject({
    capability: "creation",
    missingMethods: ["renewSessionCreation"],
  });
  expect(creationRunner.createInputs).toEqual([]);

  const runSessionId = "session_partial_run_claim" as SessionId;
  const partialRunStore = Object.assign(new MemoryEventStore(), {
    claimSessionRun: () => ({ status: "claimed" as const }),
    releaseSessionRun: () => undefined,
  });
  partialRunStore.addSession(runSessionId);
  const runService = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store: partialRunStore,
    cwd: "/repo",
    createId: createSequentialId(),
  });
  let called = false;

  const runError = await runService.withSessionOperation(runSessionId, () => {
    called = true;
  }).then(() => undefined, (error: unknown) => error);
  expect(runError).toBeInstanceOf(RuntimeSessionClaimCapabilityError);
  expect(runError).toMatchObject({
    capability: "run",
    missingMethods: ["renewSessionRun"],
  });
  expect(called).toBe(false);
  expect(runService.isRunning(runSessionId)).toBe(false);
});

test("RuntimeService rethrows inactive prompt boundaries without status side effects", async () => {
  const sessionId = "session_archived_guard" as SessionId;
  const row: SessionRow = {
    id: sessionId,
    cwd: "/archived/repo",
    status: "archived",
    createdAt: 1,
    updatedAt: 2,
  };

  for (const sessionAccess of ["root", "child"] as const) {
    const store = new SessionIdentityEventStore({ ...row, ...(sessionAccess === "child" ? { agent: childMetadata() } : {}) });
    const service = new RuntimeService({
      runtime: new FakeAgentRunner(),
      store,
      cwd: "/default/repo",
      sessionAccess,
    });
    const operations: Array<() => Promise<unknown>> = [
      () => service.inspectPrompt({ sessionId }),
      () => service.setModel({
        sessionId,
        modelSelection: { provider: "custom", model: "blocked" },
      }),
      () => service.setReasoning({ sessionId, reasoningLevel: "high" }),
      () => service.setServiceTier({ sessionId, serviceTier: "fast" }),
      () => service.setDelegationPolicy({ sessionId, policy: "off" }),
      () => service.updateGoal({ sessionId, status: "paused" }),
      () => service.clearGoal({ sessionId }),
      () => service.renameSession(sessionId, "blocked rename"),
      () => service.archiveSession(sessionId),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(RuntimeSessionInactiveError);
    }
    await expect(service.submitPrompt({ sessionId, text: "blocked sync prompt" })).rejects.toMatchObject({
      name: "RuntimeSessionInactiveError",
      message: `Session is not active: ${sessionId} (archived)`,
    });
    const asyncError = new Promise<unknown>((resolve) => {
      service.submitPromptAsync({ sessionId, text: "blocked async prompt" }, resolve);
    });
    await expect(asyncError).resolves.toMatchObject({
      name: "RuntimeSessionInactiveError",
      message: `Session is not active: ${sessionId} (archived)`,
    });
    expect(service.isRunning(sessionId)).toBe(false);
    expect(statuses(store)).toEqual([]);
    expect(store.items).toEqual([]);
  }
});

test("RuntimeService rejects an unknown session without writing orphan events", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({ runtime: runner, store, cwd: "/repo" });
  const sessionId = "session_unknown" as SessionId;

  await expect(service.submitPrompt({ sessionId, text: "do not persist this" })).rejects.toMatchObject({
    name: "RuntimeSessionNotFoundError",
    message: `Session not found: ${sessionId}`,
  });

  expect(store.items).toEqual([]);
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
  expect(service.isRunning(sessionId)).toBe(false);
});

test("RuntimeService preserves safe model connection metadata", async () => {
  const service = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store: new MemoryEventStore(),
    cwd: "/repo",
    models: [
      {
        provider: "codex-api",
        model: "gpt-5.6-sol",
        connectionLabel: "Codex API",
        authSource: "environment",
        endpoint: "https://gateway.example",
      },
    ],
  });

  expect(await service.listModels()).toEqual([
    {
      provider: "codex-api",
      model: "gpt-5.6-sol",
      connectionLabel: "Codex API",
      authSource: "environment",
      endpoint: "https://gateway.example",
    },
  ]);
});

test("RuntimeService rejects prompt images for text-only models before appending user messages", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_text_only_image" as SessionId);
  const runner = new FakeAgentRunner();
  const model = textOnlyModel();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    models: [model],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId: "session_text_only_image" as SessionId,
    text: "[Image #1] what is this?",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
    modelSelection: { provider: model.provider, model: model.model },
  });

  expect(result.status).toBe("failed");
  if (result.status === "completed") throw new Error("expected prompt to fail");
  expect(result.error?.message).toContain("does not support image input");
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
  expect(statuses(store)).toEqual(["failed"]);
});

test("RuntimeService converts sourced prompt images to tool-readable text for text-only models", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_text_only_image_path" as SessionId);
  const runner = new FakeAgentRunner();
  const model = textOnlyModel();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    models: [model],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId: "session_text_only_image_path" as SessionId,
    text: "[Image #1] what is this?",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png", sourcePath: ".chili/clipboard-images/paste.png" }],
    modelSelection: { provider: model.provider, model: model.model },
  });

  expect(result.status).toBe("completed");
  expect(runner.userMessages).toHaveLength(1);
  expect(runner.userMessages[0]?.text).toContain("[Image #1] what is this?");
  expect(runner.userMessages[0]?.text).toContain("<pasted_image_files>");
  expect(runner.userMessages[0]?.text).toContain("path=.chili/clipboard-images/paste.png");
  expect(runner.userMessages[0]?.text).toContain("absolutePath=/repo/.chili/clipboard-images/paste.png");
  expect(runner.userMessages[0]?.displayText).toBe("[Image #1] what is this?");
  expect(runner.userMessages[0]?.images).toBeUndefined();
  expect(runner.turnInputs).toHaveLength(1);
  expect(runner.turnInputs[0]?.preferExternalImageTools).toBe(true);
  expect(runner.turnInputs[0]?.system?.some((item) => item.includes("pasted image file path"))).toBe(true);
  expect(runner.turnInputs[0]?.promptDebug?.fragments).toContainEqual(expect.objectContaining({
    id: "runtime.path_image_input",
  }));
  expect(statuses(store)).toEqual(["running", "idle"]);
});

test("RuntimeService prefers direct image input over external image tools for image-capable turns", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_direct_image" as SessionId);
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId: "session_direct_image" as SessionId,
    text: "[Image #1] what is this?",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png", sourcePath: ".chili/clipboard-images/paste.png" }],
  });

  expect(result.status).toBe("completed");
  expect(runner.userMessages[0]?.images).toHaveLength(1);
  expect(runner.turnInputs[0]?.suppressExternalImageTools).toBe(true);
  expect(runner.turnInputs[0]?.system?.some((item) => item.includes("direct image attachment"))).toBe(true);
  expect(runner.turnInputs[0]?.promptDebug?.fragments).toContainEqual(expect.objectContaining({
    id: "runtime.direct_image_input",
    metadata: expect.objectContaining({ imageCount: 1 }),
  }));
});

test("RuntimeService allows external image tools when the prompt explicitly asks for tools", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_direct_image_tool" as SessionId);
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId: "session_direct_image_tool" as SessionId,
    text: "[Image #1] 用 MCP 工具识别",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png", sourcePath: ".chili/clipboard-images/paste.png" }],
  });

  expect(result.status).toBe("completed");
  expect(runner.turnInputs[0]?.suppressExternalImageTools).toBeUndefined();
});

test("RuntimeService allows text-only model turns when retained tool history contains image content", async () => {
  const sessionId = "session_text_only_tool_image" as SessionId;
  const callId = "call_read_image" as ToolCallId;
  const store = new MemoryEventStore();
  store.addSession(sessionId);
  store.messageRows.push({
    id: "msg_tool_result_image_history" as MessageId,
    sessionId,
    role: "user",
    createdAt: 1 as TimestampMs,
    parts: [
      {
        id: "part_tool_result_image_history" as PartId,
        messageId: "msg_tool_result_image_history" as MessageId,
        sessionId,
        type: "tool_result",
        callId,
        output: "MCP read image result text\n[image image/png 6 bytes]",
        content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      },
    ],
  });
  const runner = new FakeAgentRunner();
  const model = textOnlyModel();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    models: [model],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId,
    text: "hi",
    modelSelection: { provider: model.provider, model: model.model },
  });

  expect(result.status).toBe("completed");
  expect(runner.userMessages).toHaveLength(1);
  expect(runner.turnInputs).toHaveLength(1);
});

test("RuntimeService passes promptFragments by prompt layer", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_prompt_layers" as SessionId);
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: () => [
      {
        id: "base",
        layer: "base",
        source: "core",
        priority: 0,
        lifecycle: "stable",
        trust: "system",
        content: "base system",
      },
      {
        id: "skills",
        layer: "developer",
        source: "skills",
        priority: 10,
        lifecycle: "session",
        trust: "tool",
        content: "skills catalog",
      },
      {
        id: "memory",
        layer: "contextual_user",
        source: "memory",
        priority: 10,
        lifecycle: "session",
        trust: "user",
        content: "memory context",
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId: "session_prompt_layers" as SessionId,
    text: "hello",
  });

  expect(result.status).toBe("completed");
  expect(runner.turnInputs[0]?.system).toEqual(["base system"]);
  expect(runner.turnInputs[0]?.developer?.[0]).toContain("Delegation policy is proactive");
  expect(runner.turnInputs[0]?.contextualUser).toEqual(["skills catalog", "memory context"]);
  expect(runner.turnInputs[0]?.promptDebug?.fragments.map((fragment) => [fragment.id, fragment.source, fragment.layer])).toEqual([
    ["base", "core", "base"],
    ["chili.delegation.proactive", "runtime", "developer"],
    ["skills", "skills", "contextual_user"],
    ["memory", "memory", "contextual_user"],
  ]);
});

test("RuntimeService passes current turn text and skill mentions to prompt fragments", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_skill_turn" as SessionId);
  const runner = new FakeAgentRunner();
  const observed: unknown[] = [];
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: (input) => {
      observed.push(input.turn);
      return input.turn?.skillMentions?.length
        ? [
            {
              id: "chili.skill.reviewer",
              layer: "contextual_user",
              source: "skills",
              priority: 30,
              lifecycle: "turn",
              trust: "tool",
              content: `skill for ${input.turn.text}`,
            },
          ]
        : [];
    },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId: "session_skill_turn" as SessionId,
    text: "use $reviewer",
    skillMentions: [{ name: "reviewer", path: "/repo/.chili/skills/reviewer/SKILL.md" }],
  });

  expect(result.status).toBe("completed");
  expect(observed).toEqual([
    {
      text: "use $reviewer",
      skillMentions: [{ name: "reviewer", path: "/repo/.chili/skills/reviewer/SKILL.md" }],
    },
  ]);
  expect(runner.turnInputs[0]?.contextualUser).toEqual(["skill for use $reviewer"]);
  expect(runner.turnInputs[0]?.promptDebug?.fragments).toContainEqual(expect.objectContaining({
    id: "chili.skill.reviewer",
    lifecycle: "turn",
  }));
});

test("RuntimeService assembles turn prompt after appending submitted user message", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_prompt_after_append" as SessionId;
  store.addSession(sessionId);
  const observedUserMessages: AppendUserMessageInput[][] = [];
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: () => {
      observedUserMessages.push([...runner.userMessages]);
      return [
        {
          id: "runtime.latest_user_message",
          layer: "contextual_user",
          source: "runtime",
          priority: 0,
          lifecycle: "turn",
          trust: "user",
          content: `latest user: ${runner.userMessages.at(-1)?.text ?? "missing"}`,
        },
      ];
    },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId,
    text: "what changed?",
  });

  expect(result.status).toBe("completed");
  expect(observedUserMessages[0]?.[0]).toMatchObject({
    sessionId,
    text: "what changed?",
  });
  expect(runner.turnInputs[0]?.contextualUser).toEqual(["latest user: what changed?"]);
});

test("RuntimeService inspectPrompt includes conversation context as a prompt fragment", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_prompt_conversation" as SessionId;
  store.addSession(sessionId);
  store.messageRows.push(textMessage({
    id: "msg_existing_user" as MessageId,
    sessionId,
    role: "user",
    text: "existing request",
  }));
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: () => [
      {
        id: "debug.base",
        layer: "base",
        source: "core",
        priority: 0,
        lifecycle: "stable",
        trust: "system",
        content: "base instructions",
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const inspected = await service.inspectPrompt({
    sessionId,
    cwd: "/repo",
    text: "current turn",
    includeContent: true,
  });

  const conversation = inspected.fragments.find((fragment) => fragment.layer === "conversation");
  expect(inspected.debug.fragments.map((fragment) => fragment.layer)).toEqual(["base", "developer", "conversation"]);
  expect(conversation).toMatchObject({
    id: "runtime.conversation",
    source: "runtime",
    lifecycle: "turn",
    metadata: {
      kind: "conversation_context",
      messageCount: 2,
    },
  });
  expect(conversation?.content).toContain("existing request");
  expect(conversation?.content).toContain("current turn");
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
});

test("RuntimeService inspectPrompt resolves the persisted cwd and rejects a conflicting caller cwd", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_prompt_authoritative_cwd" as SessionId;
  store.addSession(sessionId, "/persisted/repo");
  const observedCwds: string[] = [];
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/process/default",
    promptFragments: ({ cwd }) => {
      observedCwds.push(cwd);
      return [];
    },
  });

  await expect(service.inspectPrompt({ sessionId })).resolves.toHaveProperty("fragments");
  await expect(service.inspectPrompt({
    sessionId,
    cwd: "/different/repo",
  })).rejects.toThrow(
    `Session cwd mismatch for ${sessionId}: expected /persisted/repo, received /different/repo`,
  );

  expect(observedCwds).toEqual(["/persisted/repo"]);
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
  expect(store.items).toEqual([]);
});

test("RuntimeService canonicalizes symlink cwd aliases and nonexistent lexical tails across session operations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-canonical-cwd-"));
  const workspace = join(dir, "workspace");
  const workspaceAlias = join(dir, "workspace-alias");
  const sessionId = "session_canonical_cwd" as SessionId;
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();

  try {
    await mkdir(workspace);
    await symlink(workspace, workspaceAlias, "dir");
    const canonicalWorkspace = await realpath(workspace);
    const aliasWithLexicalTail = `${workspaceAlias}/future/../future`;
    const canonicalCwd = join(canonicalWorkspace, "future");
    const service = new RuntimeService({
      runtime: runner,
      store,
      cwd: workspaceAlias,
      createId: createSequentialId(),
      now: () => 1 as TimestampMs,
    });

    await expect(service.createSession({
      sessionId,
      cwd: aliasWithLexicalTail,
    })).resolves.toEqual({ sessionId });
    expect(runner.createInputs).toEqual([{ sessionId, cwd: canonicalCwd }]);

    store.addSession(sessionId, `${workspaceAlias}/future`);
    await expect(service.inspectPrompt({
      sessionId,
      cwd: canonicalCwd,
    })).resolves.toHaveProperty("fragments");
    await expect(service.submitPrompt({
      sessionId,
      text: "use the authoritative workspace",
      cwd: aliasWithLexicalTail,
    })).resolves.toMatchObject({ status: "completed" });

    expect(runner.turnInputs.at(-1)?.cwd).toBe(canonicalCwd);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RuntimeService preserves explicitly configured delegation when reasoning is ultra", async () => {
  const runner = new FakeAgentRunner();
  const store = new MemoryEventStore();
  const sessionId = "session_ultra_prompt" as SessionId;
  store.addSession(sessionId);
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    defaultReasoningLevel: "ultra",
    defaultDelegationPolicy: "explicit",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const inspected = await service.inspectPrompt({
    sessionId,
    cwd: "/repo",
    includeContent: true,
  });

  expect(inspected.fragments.find((fragment) => fragment.id === "chili.delegation.explicit")).toMatchObject({
    layer: "developer",
    lifecycle: "turn",
    metadata: { policy: "explicit" },
  });
  expect(inspected.fragments.find((fragment) => fragment.id === "chili.delegation.explicit")?.content).toContain(
    "Delegate only when the user explicitly asks",
  );
});

test("RuntimeService applies session delegation policy independently of model reasoning support", async () => {
  const store = new MemoryEventStore();
  const sessionId = "session_delegation_policy" as SessionId;
  store.addSession(sessionId);
  const service = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store,
    cwd: "/repo",
    defaultModelSelection: { provider: "minimax", model: "MiniMax-M3[1m]" },
    models: [{
      provider: "minimax",
      model: "MiniMax-M3[1m]",
      default: true,
      capabilities: { reasoning: false, toolCalls: true },
      reasoningLevels: [],
    }],
    defaultDelegationPolicy: "proactive",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  expect(await service.getDelegationConfig(sessionId)).toEqual({
    sessionId,
    policy: "proactive",
    source: "default",
  });
  const proactive = await service.inspectPrompt({ sessionId, cwd: "/repo", includeContent: true });
  expect(proactive.fragments.some((fragment) => fragment.id === "chili.delegation.proactive")).toBe(true);

  expect(await service.setDelegationPolicy({ sessionId, policy: "off" })).toEqual({
    sessionId,
    policy: "off",
    source: "session",
  });
  expect((await store.events({ sessionId, type: "session.delegation_changed" })).at(-1)?.payload).toEqual({
    sessionId,
    policy: "off",
  });

  const resumed = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store,
    cwd: "/repo",
    defaultDelegationPolicy: "proactive",
  });
  expect(await resumed.getDelegationConfig(sessionId)).toEqual({
    sessionId,
    policy: "off",
    source: "session",
  });
  const disabled = await resumed.inspectPrompt({ sessionId, cwd: "/repo", includeContent: true });
  expect(disabled.fragments.find((fragment) => fragment.id === "chili.delegation.off")?.content).toContain(
    "Do not create Agents or send them new work",
  );
});

test("RuntimeService reports model-specific advanced reasoning levels", async () => {
  const store = new MemoryEventStore();
  const service = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store,
    cwd: "/repo",
    defaultModelSelection: { provider: "openai-codex", model: "gpt-5.6-sol" },
    defaultReasoningLevel: "ultra",
    models: [
      {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        default: true,
        reasoningLevels: ["off", "low", "medium", "high", "xhigh", "max", "ultra"],
      },
      {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        reasoningLevels: ["off", "low", "medium", "high", "xhigh", "max"],
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_reasoning_levels" as SessionId;
  store.addSession(sessionId);

  const solConfig = await service.getModelConfig(sessionId);
  expect(solConfig.availableReasoningLevels).toEqual([
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  expect(solConfig.reasoningLevel).toBe("ultra");
  const lunaConfig = await service.setModel({
    sessionId,
    modelSelection: { provider: "openai-codex", model: "gpt-5.6-luna" },
  });
  expect(lunaConfig.availableReasoningLevels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  expect(lunaConfig.reasoningLevel).toBe("max");
  expect((await store.events({ sessionId, type: "session.reasoning_changed" })).at(-1)?.payload).toMatchObject({
    reasoningLevel: "max",
  });

  const requestedUltra = await service.setReasoning({
    sessionId,
    reasoningLevel: "ultra",
  });
  expect(requestedUltra.reasoningLevel).toBe("max");

  const inspected = await service.inspectPrompt({ sessionId, cwd: "/repo", includeContent: true });
  expect(inspected.fragments.some((fragment) => fragment.id === "chili.delegation.proactive")).toBe(true);
  expect(inspected.fragments.some((fragment) => fragment.id === "chili.delegation.explicit")).toBe(false);
});

test("RuntimeService clears and rejects controls unsupported by a known model", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    defaultModelSelection: { provider: "minimax", model: "MiniMax-M3[1m]" },
    defaultReasoningLevel: "high",
    defaultServiceTier: "fast",
    models: [
      {
        provider: "minimax",
        model: "MiniMax-M3[1m]",
        default: true,
        reasoningLevels: [],
      },
      {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningLevels: ["off", "low", "medium", "high"],
        serviceTiers: ["standard", "fast"],
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_unsupported_model_controls" as SessionId;
  store.addSession(sessionId);

  const minimaxConfig = await service.getModelConfig(sessionId);
  expect(minimaxConfig.availableReasoningLevels).toEqual([]);
  expect(minimaxConfig.reasoningLevel).toBeUndefined();
  expect(minimaxConfig.serviceTier).toBeUndefined();
  const minimaxPrompt = await service.submitPrompt({
    sessionId,
    text: "hello from MiniMax",
  });
  expect(minimaxPrompt.status).toBe("completed");
  expect(runner.turnInputs[0]?.modelSelection).toEqual({ provider: "minimax", model: "MiniMax-M3[1m]" });
  expect(runner.turnInputs[0]?.reasoningLevel).toBeUndefined();
  expect(runner.turnInputs[0]?.serviceTier).toBeUndefined();
  await expect(service.setReasoning({ sessionId, reasoningLevel: "high" })).rejects.toThrow(
    "does not support configurable reasoning",
  );
  await expect(service.setServiceTier({ sessionId, serviceTier: "fast" })).rejects.toThrow(
    "does not support service tier fast",
  );

  await service.setModel({
    sessionId,
    modelSelection: { provider: "openai-codex", model: "gpt-5.6-sol" },
  });
  const reasoningConfig = await service.setReasoning({ sessionId, reasoningLevel: "high" });
  const serviceTierConfig = await service.setServiceTier({ sessionId, serviceTier: "fast" });
  expect(reasoningConfig.reasoningLevel).toBe("high");
  expect(serviceTierConfig.serviceTier).toBe("fast");

  await service.setModel({
    sessionId,
    modelSelection: { provider: "custom", model: "future-model" },
  });
  await expect(service.setServiceTier({ sessionId, serviceTier: "fast" })).rejects.toThrow(
    "does not support service tier fast",
  );
});

test("RuntimeService inspectPrompt only assembles prompt debug output", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_prompt_debug" as SessionId;
  store.addSession(sessionId, "/repo/app");
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: ({ cwd }) => [
      {
        id: "debug.base",
        layer: "base",
        source: "core",
        priority: 0,
        lifecycle: "stable",
        trust: "system",
        content: "base instructions",
      },
      {
        id: "debug.project",
        layer: "contextual_user",
        source: "project",
        priority: 100,
        lifecycle: "session",
        trust: "project",
        content: "project instructions",
        metadata: {
          path: `${cwd}/AGENTS.md`,
          kind: "project_instruction",
          scope: "project",
          truncated: false,
        },
      },
      {
        id: "debug.skills",
        layer: "developer",
        source: "skills",
        priority: 50,
        lifecycle: "session",
        trust: "tool",
        content: "skills catalog",
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const debug = await service.inspectPrompt({
    sessionId,
    cwd: "/repo/app",
  });

  expect(debug.fragments.map((fragment) => [fragment.id, fragment.layer, fragment.source])).toEqual([
    ["debug.base", "base", "core"],
    ["chili.delegation.proactive", "developer", "runtime"],
    ["debug.skills", "contextual_user", "skills"],
    ["debug.project", "contextual_user", "project"],
  ]);
  expect(debug.fragments[0]).not.toHaveProperty("content");
  expect(debug.fragments.find((fragment) => fragment.id === "debug.project")?.metadata).toMatchObject({
    path: "/repo/app/AGENTS.md",
    kind: "project_instruction",
    scope: "project",
    truncated: false,
  });
  expect(debug.totalChars).toBe(
    "base instructions".length
      + "skills catalog".length
      + "project instructions".length
      + debug.fragments.find((fragment) => fragment.id === "chili.delegation.proactive")!.chars,
  );
  expect(runner.createInputs).toEqual([]);
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
  expect(store.items).toEqual([]);
});

test("RuntimeService inspectPrompt only returns fragment content when requested", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const noContentSessionId = "session_prompt_debug_no_content" as SessionId;
  const contentSessionId = "session_prompt_debug_content" as SessionId;
  store.addSession(noContentSessionId);
  store.addSession(contentSessionId);
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: () => [
      {
        id: "debug.content",
        layer: "base",
        source: "core",
        priority: 0,
        lifecycle: "turn",
        trust: "system",
        content: "visible only with content flag",
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const debug = await service.inspectPrompt({
    sessionId: noContentSessionId,
    cwd: "/repo",
    includeContent: false,
  });
  const withContent = await service.inspectPrompt({
    sessionId: contentSessionId,
    cwd: "/repo",
    includeContent: true,
  });

  expect(debug.fragments[0]).not.toHaveProperty("content");
  expect(withContent.debug.fragments[0]).not.toHaveProperty("content");
  expect(withContent.fragments[0]?.content).toBe("visible only with content flag");
  expect(runner.createInputs).toEqual([]);
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
  expect(store.items).toEqual([]);
});

test("RuntimeService clears running reservation when initial running status write fails with a fake runner", async () => {
  const store = new ThrowingStatusStore();
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_status_failure" as SessionId;
  store.addSession(sessionId);

  await expect(
    service.submitPrompt({
      sessionId,
      text: "hello",
    }),
  ).rejects.toThrow("status write failed");
  expect(service.isRunning(sessionId)).toBe(false);
  expect(runner.userMessages).toHaveLength(0);
});

test("RuntimeService rejects async prompt claim boundary races synchronously", async () => {
  const cases = [
    {
      name: "archived",
      claim: { status: "inactive" as const, sessionStatus: "archived" },
      errorType: RuntimeSessionInactiveError,
    },
    {
      name: "forbidden",
      claim: { status: "forbidden" as const },
      errorType: RuntimeSessionAccessError,
    },
    {
      name: "not-found",
      claim: { status: "not_found" as const },
      errorType: RuntimeSessionNotFoundError,
    },
  ];

  for (const item of cases) {
    const sessionId = `session_async_claim_race_${item.name}` as SessionId;
    const store = Object.assign(new MemoryEventStore(), {
      claimSessionRun: () => item.claim,
      renewSessionRun: () => true,
      releaseSessionRun: () => undefined,
    });
    store.addSession(sessionId);
    const runner = new FakeAgentRunner();
    const service = new RuntimeService({
      runtime: runner,
      store,
      cwd: "/repo",
      createId: createSequentialId(),
    });
    let backgroundError: unknown;

    // Models a transport preflight that passed before the durable claim saw a
    // concurrent archive, ownership change, or deletion.
    await expect(service.assertSessionTurnAllowed(sessionId)).resolves.toBeUndefined();
    expect(() => service.submitPromptAsync(
      { sessionId, text: "race after preflight" },
      (error) => {
        backgroundError = error;
      },
    )).toThrow(item.errorType);

    await Promise.resolve();
    expect(backgroundError).toBeUndefined();
    expect(service.isRunning(sessionId)).toBe(false);
    expect(runner.userMessages).toEqual([]);
    expect(runner.turnInputs).toEqual([]);
  }
});

test("RuntimeService reserves busy sessions before the runner reaches runTurn", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const gate = deferred<void>();
  runner.runTurnWait = gate.promise;
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_busy" as SessionId;
  store.addSession(sessionId);

  const first = service.submitPrompt({
    sessionId,
    text: "first",
  });

  expect(service.isRunning(sessionId)).toBe(true);
  await expect(
    service.submitPrompt({
      sessionId,
      text: "second",
    }),
  ).rejects.toThrow(RuntimeBusyError);
  expect(() =>
    service.submitPromptAsync({
      sessionId,
      text: "third",
    }),
  ).toThrow(RuntimeBusyError);
  await expect(service.archiveSession(sessionId)).rejects.toBeInstanceOf(RuntimeBusyError);
  expect(store.items.some((event) => event.type === "session.archived")).toBe(false);

  gate.resolve();
  const result = await first;

  expect(result.status).toBe("completed");
  expect(service.isRunning(sessionId)).toBe(false);
  expect(runner.userMessages).toHaveLength(1);
});

test("SQLite run claims fence archive attempts from another RuntimeService connection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-cross-connection-archive-"));
  const path = join(dir, "events.sqlite");
  const runStore = new SqliteEventStore(path);
  const archiveStore = new SqliteEventStore(path);
  const runEvents = new ObservableEventStore(runStore);
  const archiveEvents = new ObservableEventStore(archiveStore);
  const sessionId = "session_cross_connection_archive" as SessionId;
  const runner = new FakeAgentRunner();
  const gate = deferred<void>();
  const createId = createSequentialId();
  runner.runTurnWait = gate.promise;

  try {
    await runEvents.append({
      id: "event_cross_connection_archive_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    });
    const runningService = new RuntimeService({
      runtime: runner,
      store: runEvents,
      cwd: "/repo",
      createId,
    });
    const archivingService = new RuntimeService({
      runtime: new FakeAgentRunner(),
      store: archiveEvents,
      cwd: "/repo",
      createId,
    });

    const running = runningService.submitPrompt({ sessionId, text: "hold the durable run claim" });
    await expect(archivingService.archiveSession(sessionId)).rejects.toBeInstanceOf(RuntimeBusyError);
    expect((await archiveStore.events({ sessionId, type: "session.archived", limit: 10 }))).toEqual([]);

    gate.resolve();
    await expect(running).resolves.toMatchObject({ status: "completed" });
    await expect(archivingService.archiveSession(sessionId)).resolves.toBeUndefined();
    expect((await runStore.sessions()).find((session) => session.id === sessionId)?.status).toBe("archived");
    expect((await runStore.events({ sessionId, type: "session.archived", limit: 10 }))).toHaveLength(1);
  } finally {
    archiveStore.close();
    runStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("withSessionOperation is reentrant only in its async chain and durably fences peers and archive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-session-operation-"));
  const path = join(dir, "events.sqlite");
  const firstStore = new SqliteEventStore(path);
  const secondStore = new SqliteEventStore(path);
  const firstEvents = new ObservableEventStore(firstStore);
  const secondEvents = new ObservableEventStore(secondStore);
  const sessionId = "session_operation_fence" as SessionId;
  const entered = deferred<void>();
  const release = deferred<void>();
  const createId = createSequentialId();

  try {
    await firstEvents.append({
      id: "event_session_operation_fence",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    });
    const first = new RuntimeService({
      runtime: new FakeAgentRunner(),
      store: firstEvents,
      cwd: "/repo",
      createId,
    });
    const second = new RuntimeService({
      runtime: new FakeAgentRunner(),
      store: secondEvents,
      cwd: "/repo",
      createId,
    });

    const operation = first.withSessionOperation(sessionId, async (outer) => {
      outer.assertCurrent();
      const nested = await first.withSessionOperation(sessionId, async (inner) => {
        expect(inner).toBe(outer);
        inner.assertCurrent();
        return "nested";
      });
      await expect(first.archiveSession(sessionId)).rejects.toBeInstanceOf(RuntimeBusyError);
      entered.resolve();
      await release.promise;
      outer.assertCurrent();
      return nested;
    });

    await entered.promise;
    expect(first.isRunning(sessionId)).toBe(true);
    await expect(first.withSessionOperation(sessionId, async () => "outside"))
      .rejects.toBeInstanceOf(RuntimeBusyError);
    await expect(second.withSessionOperation(sessionId, async () => "peer"))
      .rejects.toBeInstanceOf(RuntimeBusyError);
    await expect(second.archiveSession(sessionId)).rejects.toBeInstanceOf(RuntimeBusyError);

    release.resolve();
    await expect(operation).resolves.toBe("nested");
    expect(first.isRunning(sessionId)).toBe(false);
    await expect(second.archiveSession(sessionId)).resolves.toBeUndefined();
    expect((await secondStore.sessions()).find((session) => session.id === sessionId)?.status).toBe("archived");
  } finally {
    secondStore.close();
    firstStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("withSessionOperation retains its claim until ignored nested scopes finish", async () => {
  const store = new LeaseControlledEventStore();
  const sessionId = "session_operation_ignored_nested" as SessionId;
  store.addSession(sessionId);
  const first = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store,
    cwd: "/repo",
    createId: createSequentialId(),
  });
  const peer = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store,
    cwd: "/repo",
    createId: createSequentialId(),
  });
  const nestedEntered = deferred<void>();
  const releaseNested = deferred<void>();
  let nestedCompleted = false;
  let outerSettled = false;

  const outer = first.withSessionOperation(sessionId, () => {
    void first.withSessionOperation(sessionId, async (operation) => {
      nestedEntered.resolve();
      await releaseNested.promise;
      operation.assertCurrent();
      nestedCompleted = true;
    });
    return "outer result";
  });
  void outer.then(
    () => {
      outerSettled = true;
    },
    () => {
      outerSettled = true;
    },
  );

  await nestedEntered.promise;
  await Promise.resolve();
  expect(outerSettled).toBe(false);
  expect(first.isRunning(sessionId)).toBe(true);
  expect(store.claimId).toBeDefined();
  await expect(peer.withSessionOperation(sessionId, () => "must stay busy"))
    .rejects.toBeInstanceOf(RuntimeBusyError);

  releaseNested.resolve();
  await expect(outer).resolves.toBe("outer result");
  expect(nestedCompleted).toBe(true);
  expect(first.isRunning(sessionId)).toBe(false);
  expect(store.claimId).toBeUndefined();
  await expect(peer.withSessionOperation(sessionId, () => "available"))
    .resolves.toBe("available");
});

test("withSessionOperation propagates an ignored nested rejection without an unhandled promise", async () => {
  const store = new LeaseControlledEventStore();
  const sessionId = "session_operation_ignored_nested_rejection" as SessionId;
  store.addSession(sessionId);
  const service = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store,
    cwd: "/repo",
    createId: createSequentialId(),
  });
  const nestedEntered = deferred<void>();
  const releaseNested = deferred<void>();
  const nestedError = new Error("ignored nested operation failed");

  const outer = service.withSessionOperation(sessionId, () => {
    void service.withSessionOperation(sessionId, async () => {
      nestedEntered.resolve();
      await releaseNested.promise;
      throw nestedError;
    });
    return "outer result";
  });

  await nestedEntered.promise;
  releaseNested.resolve();
  await expect(outer).rejects.toBe(nestedError);
  expect(service.isRunning(sessionId)).toBe(false);
  expect(store.claimId).toBeUndefined();
});

test("withSessionOperation makes nested lease loss authoritative", async () => {
  const store = new LeaseControlledEventStore();
  const sessionId = "session_operation_nested_lease_loss" as SessionId;
  store.addSession(sessionId);
  const service = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store,
    cwd: "/repo",
    createId: createSequentialId(),
  });
  const nestedEntered = deferred<void>();
  const releaseNested = deferred<void>();
  let nestedCapability: RuntimeSessionOperation | undefined;

  const outer = service.withSessionOperation(sessionId, () => {
    void service.withSessionOperation(sessionId, async (operation) => {
      nestedCapability = operation;
      nestedEntered.resolve();
      await releaseNested.promise;
      return "nested observed abort";
    });
    return "outer result";
  });

  await nestedEntered.promise;
  store.allowRenew = false;
  expect(() => nestedCapability?.assertCurrent()).toThrow(RuntimeBusyError);
  expect(nestedCapability?.signal.aborted).toBe(true);
  releaseNested.resolve();

  await expect(outer).rejects.toBeInstanceOf(RuntimeBusyError);
  expect(service.isRunning(sessionId)).toBe(false);
  expect(store.claimId).toBeUndefined();
});

test("a detached async chain can acquire a fresh session operation after its inherited context is released", async () => {
  const store = new LeaseControlledEventStore();
  const sessionId = "session_operation_detached_reacquire" as SessionId;
  store.addSession(sessionId);
  const service = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store,
    cwd: "/repo",
    createId: createSequentialId(),
  });
  const continueDetached = deferred<void>();
  let outerCapability: RuntimeSessionOperation | undefined;
  let detached: Promise<RuntimeSessionOperation> | undefined;

  await expect(service.withSessionOperation(sessionId, (operation) => {
    outerCapability = operation;
    detached = (async () => {
      await continueDetached.promise;
      return service.withSessionOperation(sessionId, (freshOperation) => {
        freshOperation.assertCurrent();
        expect(store.claimId).toBeDefined();
        return freshOperation;
      });
    })();
    return "outer complete";
  })).resolves.toBe("outer complete");

  expect(service.isRunning(sessionId)).toBe(false);
  expect(store.claimId).toBeUndefined();
  expect(() => outerCapability?.assertCurrent()).toThrow(RuntimeBusyError);
  if (!detached || !outerCapability) throw new Error("detached operation was not initialized");

  continueDetached.resolve();
  const freshCapability = await detached;
  expect(freshCapability).not.toBe(outerCapability);
  expect(service.isRunning(sessionId)).toBe(false);
  expect(store.claimId).toBeUndefined();
});

test("prompt, standalone goal, and compaction expose their held claim to nested session operations", async () => {
  const store = new MemoryEventStore();
  const promptSessionId = "session_operation_prompt" as SessionId;
  const goalSessionId = "session_operation_goal" as SessionId;
  const compactSessionId = "session_operation_compact" as SessionId;
  for (const sessionId of [promptSessionId, goalSessionId, compactSessionId]) store.addSession(sessionId);
  const runner = new FakeAgentRunner() as FakeAgentRunner & {
    compactContext(input: { sessionId: SessionId }): Promise<{
      status: "skipped";
      turnId: TurnId;
      reason: string;
    }>;
  };
  const nestedSessions: SessionId[] = [];
  let service: RuntimeService;
  runner.onRunTurn = async (input) => {
    await service.withSessionOperation(input.sessionId, (operation) => {
      operation.assertCurrent();
      nestedSessions.push(input.sessionId);
    });
    if (input.sessionId === goalSessionId) {
      await service.updateGoal({ sessionId: goalSessionId, status: "complete" });
    }
  };
  runner.compactContext = async (input) => {
    await service.withSessionOperation(input.sessionId, (operation) => {
      operation.assertCurrent();
      nestedSessions.push(input.sessionId);
    });
    return {
      status: "skipped",
      turnId: "turn_operation_compact" as TurnId,
      reason: "test",
    };
  };
  service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    maxGoalTurns: 2,
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  await expect(service.submitPrompt({ sessionId: promptSessionId, text: "prompt" }))
    .resolves.toMatchObject({ status: "completed" });
  await service.setGoal({ sessionId: goalSessionId, objective: "finish once" });
  while (service.isRunning(goalSessionId)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  await expect(service.compactSession({ sessionId: compactSessionId }))
    .resolves.toMatchObject({ status: "skipped" });

  expect(nestedSessions).toEqual([promptSessionId, goalSessionId, compactSessionId]);
});

test("immediate Goal resume waits for the interrupted run to settle and starts exactly once", async () => {
  const store = new MemoryEventStore();
  const sessionId = "session_goal_pause_immediate_resume" as SessionId;
  store.addSession(sessionId);
  const runner = new FakeAgentRunner();
  const firstTurnStarted = deferred<void>();
  const releaseFirstTurn = deferred<void>();
  const resumedTurnStarted = deferred<void>();
  let service: RuntimeService;
  runner.onRunTurn = async () => {
    const turnNumber = runner.turnInputs.length;
    if (turnNumber === 1) {
      firstTurnStarted.resolve();
      await releaseFirstTurn.promise;
      runner.runTurnResult = {
        status: "completed",
        turnId: "turn_goal_before_pause" as TurnId,
        assistantMessageId: "message_goal_before_pause" as MessageId,
        finishReason: "stop",
      };
      return;
    }
    if (turnNumber === 2) {
      resumedTurnStarted.resolve();
      await service.updateGoal({ sessionId, status: "complete" });
      runner.runTurnResult = {
        status: "completed",
        turnId: "turn_goal_after_resume" as TurnId,
        assistantMessageId: "message_goal_after_resume" as MessageId,
        finishReason: "stop",
      };
      return;
    }
    throw new Error(`Unexpected Goal turn: ${turnNumber}`);
  };
  service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  await service.setGoal({ sessionId, objective: "resume after pause" });
  await firstTurnStarted.promise;
  await service.updateGoal({ sessionId, status: "paused" });
  await service.updateGoal({ sessionId, status: "active" });
  await service.updateGoal({ sessionId, status: "active" });

  expect(runner.turnInputs).toHaveLength(1);
  releaseFirstTurn.resolve();
  await resumedTurnStarted.promise;
  while (service.isRunning(sessionId)) await Promise.resolve();
  await Promise.resolve();

  expect(runner.turnInputs).toHaveLength(2);
  expect(await service.getGoal({ sessionId })).toMatchObject({ status: "complete" });
  expect(statuses(store)).toEqual(["running", "cancelled", "running", "idle"]);
});

test("raising a budget-limited Goal during wrap-up defers one continuation until wrap-up settles", async () => {
  const store = new MemoryEventStore();
  const sessionId = "session_goal_budget_resume_during_wrapup" as SessionId;
  store.addSession(sessionId);
  const runner = new FakeAgentRunner();
  const wrapUpStarted = deferred<void>();
  const releaseWrapUp = deferred<void>();
  const resumedTurnStarted = deferred<void>();
  let service: RuntimeService;
  runner.onRunTurn = async () => {
    const turnNumber = runner.turnInputs.length;
    if (turnNumber === 1) {
      runner.runTurnResult = {
        status: "completed",
        turnId: "turn_goal_budget_limit" as TurnId,
        assistantMessageId: "message_goal_budget_limit" as MessageId,
        finishReason: "stop",
        usage: { totalTokens: 1 },
      };
      return;
    }
    if (turnNumber === 2) {
      wrapUpStarted.resolve();
      await releaseWrapUp.promise;
      runner.runTurnResult = {
        status: "completed",
        turnId: "turn_goal_budget_wrapup" as TurnId,
        assistantMessageId: "message_goal_budget_wrapup" as MessageId,
        finishReason: "stop",
        usage: { totalTokens: 1 },
      };
      return;
    }
    if (turnNumber === 3) {
      resumedTurnStarted.resolve();
      await service.updateGoal({ sessionId, status: "complete" });
      runner.runTurnResult = {
        status: "completed",
        turnId: "turn_goal_after_budget_resume" as TurnId,
        assistantMessageId: "message_goal_after_budget_resume" as MessageId,
        finishReason: "stop",
        usage: { totalTokens: 0 },
      };
      return;
    }
    throw new Error(`Unexpected Goal turn: ${turnNumber}`);
  };
  service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  await service.setGoal({ sessionId, objective: "resume after budget wrap-up", tokenBudget: 1 });
  await wrapUpStarted.promise;
  expect(await service.getGoal({ sessionId })).toMatchObject({
    status: "budgetLimited",
    tokenBudget: 1,
    tokensUsed: 1,
  });

  await service.updateGoal({ sessionId, tokenBudget: 100, status: "active" });
  expect(runner.turnInputs).toHaveLength(2);
  releaseWrapUp.resolve();
  await resumedTurnStarted.promise;
  while (service.isRunning(sessionId)) await Promise.resolve();
  await Promise.resolve();

  expect(runner.turnInputs).toHaveLength(3);
  expect(await service.getGoal({ sessionId })).toMatchObject({
    status: "complete",
    tokenBudget: 100,
    tokensUsed: 2,
  });
  expect(statuses(store)).toEqual(["running", "idle", "running", "idle"]);
});

test("an owning prompt acknowledges the active Goal it continues without bypassing the turn fence", async () => {
  const store = new MemoryEventStore();
  const sessionId = "session_prompt_acknowledges_deferred_goal" as SessionId;
  store.addSession(sessionId);
  const runner = new FakeAgentRunner();
  const promptTurnStarted = deferred<void>();
  const releasePromptTurn = deferred<void>();
  runner.onRunTurn = async () => {
    const turnNumber = runner.turnInputs.length;
    if (turnNumber === 1) {
      promptTurnStarted.resolve();
      await releasePromptTurn.promise;
    }
    runner.runTurnResult = {
      status: "completed",
      turnId: `turn_prompt_goal_ack_${turnNumber}` as TurnId,
      assistantMessageId: `message_prompt_goal_ack_${turnNumber}` as MessageId,
      finishReason: "stop",
    };
  };
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    maxGoalTurns: 1,
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const prompt = service.submitPrompt({ sessionId, text: "start ordinary work" });
  await promptTurnStarted.promise;
  await service.setGoal({ sessionId, objective: "continue inside the owning prompt" });
  releasePromptTurn.resolve();

  await expect(prompt).resolves.toMatchObject({ status: "max_turns" });
  await Promise.resolve();
  await Promise.resolve();

  expect(service.isRunning(sessionId)).toBe(false);
  expect(runner.turnInputs).toHaveLength(2);
  expect(await service.getGoal({ sessionId })).toMatchObject({ status: "active" });
  expect(statuses(store)).toEqual(["running", "running", "failed"]);
});

test("withSessionOperation aborts and fails closed when its durable lease is lost", async () => {
  const store = new LeaseControlledEventStore();
  const sessionId = "session_operation_lease_lost" as SessionId;
  store.addSession(sessionId);
  const service = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store,
    cwd: "/repo",
    createId: createSequentialId(),
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  let captured: RuntimeSessionOperation | undefined;

  const operation = service.withSessionOperation(sessionId, async (capability) => {
    captured = capability;
    entered.resolve();
    await release.promise;
    return "finished";
  });
  await entered.promise;
  expect(captured?.signal.aborted).toBe(false);
  store.allowRenew = false;
  expect(() => captured?.assertCurrent()).toThrow(RuntimeBusyError);
  expect(captured?.signal.aborted).toBe(true);
  expect(captured?.signal.reason).toBeInstanceOf(RuntimeBusyError);

  release.resolve();
  await expect(operation).rejects.toBeInstanceOf(RuntimeBusyError);
  expect(store.claimId).toBeUndefined();
  store.allowRenew = true;
  await expect(service.withSessionOperation(sessionId, () => "reacquired")).resolves.toBe("reacquired");
});

test("withSessionOperation reports lease loss even when the callback observes abort first", async () => {
  const store = new LeaseControlledEventStore();
  const sessionId = "session_operation_abort_first" as SessionId;
  store.addSession(sessionId);
  const service = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store,
    cwd: "/repo",
    createId: createSequentialId(),
  });
  const entered = deferred<void>();
  let captured: RuntimeSessionOperation | undefined;

  const operation = service.withSessionOperation(sessionId, async (capability) => {
    captured = capability;
    entered.resolve();
    await new Promise<never>((_resolve, reject) => {
      capability.signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
  });
  await entered.promise;
  store.allowRenew = false;
  expect(() => captured?.assertCurrent()).toThrow(RuntimeBusyError);

  await expect(operation).rejects.toBeInstanceOf(RuntimeBusyError);
  expect(store.claimId).toBeUndefined();
});

test("prompt reports lease loss even when runReservedPrompt returns a normal cancellation first", async () => {
  const store = new LeaseControlledEventStore();
  const sessionId = "session_prompt_operation_abort_first" as SessionId;
  store.addSession(sessionId);
  const runner = new FakeAgentRunner();
  let service: RuntimeService;
  let observedBoundaryError: unknown;
  runner.onRunTurn = async (input) => {
    store.allowRenew = false;
    observedBoundaryError = await service.withSessionOperation(input.sessionId, () => undefined)
      .then(() => undefined, (error: unknown) => error);
    expect(input.signal?.aborted).toBe(true);
  };
  service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
  });

  await expect(service.submitPrompt({
    sessionId,
    text: "return cancelled after losing the durable lease",
  })).rejects.toBeInstanceOf(RuntimeBusyError);

  expect(observedBoundaryError).toBeInstanceOf(RuntimeBusyError);
  expect(statuses(store)).toEqual(["running", "cancelled"]);
  expect(service.isRunning(sessionId)).toBe(false);
  expect(store.claimId).toBeUndefined();
});

test("session operation callers release reservations when the initial lease assertion fails", async () => {
  const store = new LeaseControlledEventStore();
  const directSessionId = "session_operation_initial_direct" as SessionId;
  const promptSessionId = "session_operation_initial_prompt" as SessionId;
  const compactSessionId = "session_operation_initial_compact" as SessionId;
  const goalSessionId = "session_operation_initial_goal" as SessionId;
  for (const sessionId of [directSessionId, promptSessionId, compactSessionId, goalSessionId]) {
    store.addSession(sessionId);
  }
  store.allowRenew = false;
  let compactCalled = false;
  const runner = new FakeAgentRunner() as FakeAgentRunner & {
    compactContext(input: { sessionId: SessionId }): Promise<{
      status: "skipped";
      turnId: TurnId;
      reason: string;
    }>;
  };
  runner.compactContext = async () => {
    compactCalled = true;
    return {
      status: "skipped",
      turnId: "turn_initial_renew_compact" as TurnId,
      reason: "test",
    };
  };
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
  });
  let called = false;

  await expect(service.withSessionOperation(directSessionId, () => {
    called = true;
  })).rejects.toBeInstanceOf(RuntimeBusyError);
  expect(called).toBe(false);
  expect(service.isRunning(directSessionId)).toBe(false);
  expect(store.claimId).toBeUndefined();

  await expect(service.submitPrompt({ sessionId: promptSessionId, text: "blocked before callback" }))
    .rejects.toBeInstanceOf(RuntimeBusyError);
  expect(service.isRunning(promptSessionId)).toBe(false);
  expect(runner.userMessages).toEqual([]);
  expect(store.claimId).toBeUndefined();

  await expect(service.compactSession({ sessionId: compactSessionId }))
    .rejects.toBeInstanceOf(RuntimeBusyError);
  expect(service.isRunning(compactSessionId)).toBe(false);
  expect(compactCalled).toBe(false);
  expect(store.claimId).toBeUndefined();

  await service.setGoal({ sessionId: goalSessionId, objective: "blocked before callback" });
  while (service.isRunning(goalSessionId)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  expect(runner.turnInputs).toEqual([]);
  expect(store.claimId).toBeUndefined();

  store.allowRenew = true;
  await expect(service.withSessionOperation(directSessionId, () => "reacquired")).resolves.toBe("reacquired");
});

test("goal continuation boundary rejections do not publish failed session status", async () => {
  for (const boundary of ["inactive", "child", "missing"] as const) {
    const sessionId = `session_goal_boundary_${boundary}` as SessionId;
    const store = new GoalBoundaryEventStore(sessionId, boundary);
    const runner = new FakeAgentRunner();
    const service = new RuntimeService({
      runtime: runner,
      store,
      cwd: "/repo",
      createId: createSequentialId(),
      now: () => 1 as TimestampMs,
    });

    await service.setGoal({ sessionId, objective: `stop at ${boundary} boundary` });
    while (service.isRunning(sessionId)) await Promise.resolve();

    expect(statuses(store)).toEqual([]);
    expect(runner.turnInputs).toEqual([]);
    expect(store.items.filter((event) => event.type === "goal.updated")).toHaveLength(1);
  }
});

test("RuntimeService continues after OpenAI-compatible tool_calls finish reason", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_tool_calls" as SessionId);
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  runner.onRunTurn = async () => {
    const turnNumber = runner.turnInputs.length;
    runner.runTurnResult = {
      status: "completed",
      turnId: `turn_${turnNumber}` as TurnId,
      assistantMessageId: `message_assistant_${turnNumber}` as MessageId,
      finishReason: turnNumber === 1 ? "tool_calls" : "stop",
    };
  };

  const result = await service.submitPrompt({
    sessionId: "session_tool_calls" as SessionId,
    text: "use a tool",
    maxTurns: 3,
  });

  expect(result.status).toBe("completed");
  expect(result.finishReason).toBe("stop");
  expect(runner.turnInputs).toHaveLength(2);
  expect(statuses(store)).toEqual(["running", "idle"]);
});

test("RuntimeService adds a no-tool final turn after the tool continuation limit", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_final_after_tools" as SessionId);
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  runner.onRunTurn = async () => {
    const turnNumber = runner.turnInputs.length;
    runner.runTurnResult = {
      status: "completed",
      turnId: `turn_${turnNumber}` as TurnId,
      assistantMessageId: `message_assistant_${turnNumber}` as MessageId,
      finishReason: turnNumber <= 2 ? "tool_use" : "stop",
    };
  };

  const result = await service.submitPrompt({
    sessionId: "session_final_after_tools" as SessionId,
    text: "inspect deeply",
    maxTurns: 2,
  });

  expect(result.status).toBe("completed");
  expect(result.finishReason).toBe("stop");
  expect(runner.turnInputs).toHaveLength(3);
  expect(runner.turnInputs[2]?.toolMode).toBe("disabled");
  expect(runner.turnInputs[2]?.system?.at(-1)).toContain("Do not call tools");
  expect(statuses(store)).toEqual(["running", "idle"]);
});

test("RuntimeService uses the last persisted model config for new sessions", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const previousSessionId = "session_previous" as SessionId;
  store.addSession(previousSessionId);
  const firstService = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    defaultModelSelection: { provider: "minimax", model: "MiniMax-M2.7" },
    defaultReasoningLevel: "medium",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  await firstService.setModel({
    sessionId: previousSessionId,
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
  });
  await firstService.setReasoning({
    sessionId: previousSessionId,
    reasoningLevel: "high",
  });
  await firstService.setServiceTier({
    sessionId: previousSessionId,
    serviceTier: "fast",
  });

  const nextRunner = new FakeAgentRunner();
  const nextService = new RuntimeService({
    runtime: nextRunner,
    store,
    cwd: "/repo",
    defaultModelSelection: { provider: "minimax", model: "MiniMax-M2.7" },
    defaultReasoningLevel: "medium",
    createId: createSequentialId(),
    now: () => 2 as TimestampMs,
  });

  await nextService.createSession({
    sessionId: "session_next" as SessionId,
  });
  store.addSession("session_next" as SessionId);
  const config = await nextService.getModelConfig("session_next" as SessionId);
  expect(config.modelSelection).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
  expect(config.reasoningLevel).toBe("high");
  expect(config.serviceTier).toBe("fast");

  const result = await nextService.submitPrompt({
    sessionId: "session_next" as SessionId,
    text: "hello",
  });

  expect(result.status).toBe("completed");
  expect(nextRunner.turnInputs[0]?.modelSelection).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
  expect(nextRunner.turnInputs[0]?.reasoningLevel).toBe("high");
  expect(nextRunner.turnInputs[0]?.serviceTier).toBe("fast");
});

test("RuntimeService still stops on Anthropic-style end_turn finish reason", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_end_turn" as SessionId);
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  runner.runTurnResult = {
    status: "completed",
    turnId: "turn_end_turn" as TurnId,
    assistantMessageId: "message_assistant_end_turn" as MessageId,
    finishReason: "end_turn",
  };

  const result = await service.submitPrompt({
    sessionId: "session_end_turn" as SessionId,
    text: "answer directly",
    maxTurns: 3,
  });

  expect(result.status).toBe("completed");
  expect(result.finishReason).toBe("end_turn");
  expect(runner.turnInputs).toHaveLength(1);
  expect(statuses(store)).toEqual(["running", "idle"]);
});

test("RuntimeService stops before another tool-use turn when interrupted", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_interrupt_loop" as SessionId;
  store.addSession(sessionId);
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  runner.runTurnResult = {
    status: "completed",
    turnId: "turn_tool_use" as TurnId,
    assistantMessageId: "message_assistant_tool_use" as MessageId,
    finishReason: "tool_use",
  };
  runner.onRunTurn = async () => {
    await service.interrupt(sessionId, "stop");
  };

  const result = await service.submitPrompt({
    sessionId,
    text: "finish by tool",
    maxTurns: 3,
  });

  expect(result.status).toBe("cancelled");
  expect(runner.turnInputs).toHaveLength(1);
  expect(statuses(store)).toEqual(["running", "cancelling", "cancelled"]);
  const cancelling = store.items.find(
    (event) => event.type === "session.status_changed" && event.payload.status === "cancelling",
  );
  expect(cancelling?.sessionId).toBe(sessionId);
});

test("SingleAgentRuntime satisfies AgentRunner without starting an already aborted model request", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelCalls++;
      expect(input.signal?.aborted).toBe(true);
      throw abortError("provider aborted");
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event: RuntimeEvent) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    retryPolicy: { maxAttempts: 3, initialDelayMs: 0 },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const runner: AgentRunner = runtime;
  const controller = new AbortController();
  controller.abort();

  const result = await runner.runTurn({
    sessionId: "session_abort" as SessionId,
    cwd: "/repo",
    signal: controller.signal,
  });

  expect(result.status).toBe("cancelled");
  expect(modelCalls).toBe(0);
  expect(store.items.some((event) => event.type === "turn.retry_scheduled")).toBe(false);
});

test("RuntimeService excludes cancelled prompt with no assistant output from subsequent model context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-core-cancelled-prompt-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const registry = new InMemoryToolRegistry();
  const createId = createSequentialId();
  let now = 0;
  const modelInputs: ModelStreamInput[] = [];
  const firstCallStarted = deferred<void>();
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelInputs.push(input);
      if (modelInputs.length === 1) {
        firstCallStarted.resolve();
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) {
            resolve();
            return;
          }
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw abortError("provider aborted");
      }
      yield { type: "text_delta", text: "ok" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event: RuntimeEvent) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    createId,
    now: () => ++now as TimestampMs,
  });
  const service = new RuntimeService({
    runtime,
    store,
    cwd: "/repo",
    createId,
    now: () => ++now as TimestampMs,
  });
  const sessionId = "session_cancelled_prompt_context" as SessionId;

  try {
    await service.createSession({ sessionId });
    const cancelled = service.submitPrompt({
      sessionId,
      text: "理解一下这个幕落",
    });
    await firstCallStarted.promise;
    await service.interrupt(sessionId, "user_interrupt");

    const cancelledResult = await cancelled;
    expect(cancelledResult.status).toBe("cancelled");

    const completedResult = await service.submitPrompt({
      sessionId,
      text: "理解一下这个目录",
    });

    expect(completedResult.status).toBe("completed");
    expect(modelInputs).toHaveLength(2);
    const secondContext = messageTextContent(modelInputs[1]?.messages ?? []);
    expect(secondContext).not.toContain("理解一下这个幕落");
    expect(secondContext).toContain("理解一下这个目录");

    const transcriptText = messageTextContent(await store.messages(sessionId));
    expect(transcriptText).toContain("理解一下这个幕落");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("RuntimeService persists encrypted reasoning output into the next turn context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-core-reasoning-output-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const registry = new InMemoryToolRegistry();
  const createId = createSequentialId();
  let now = 0;
  const modelInputs: ModelStreamInput[] = [];
  const modelOutput = {
    apiFamily: "openai-responses",
    outputIndex: 0,
    item: {
      id: "reasoning_persisted",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Checked the repository." }],
      status: "completed",
      encrypted_content: "complete-ciphertext",
      provider_extension: { retained: true },
    },
  } as const;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelInputs.push(input);
      if (modelInputs.length === 1) {
        yield { type: "reasoning_item", output: modelOutput };
        yield { type: "text_delta", text: "First answer." };
      } else {
        yield { type: "text_delta", text: "Second answer." };
      }
      yield { type: "finish", reason: "stop" };
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event: RuntimeEvent) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    createId,
    now: () => ++now as TimestampMs,
  });
  const service = new RuntimeService({
    runtime,
    store,
    cwd: "/repo",
    createId,
    now: () => ++now as TimestampMs,
  });
  const sessionId = "session_reasoning_output_context" as SessionId;

  try {
    await service.createSession({ sessionId });
    expect((await service.submitPrompt({ sessionId, text: "First prompt." })).status).toBe("completed");
    expect((await service.submitPrompt({ sessionId, text: "Continue." })).status).toBe("completed");

    expect(modelInputs).toHaveLength(2);
    const replayedPart = modelInputs[1]?.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "reasoning" && part.modelOutput !== undefined);
    expect(replayedPart).toMatchObject({ type: "reasoning", text: "", modelOutput });

    const storedPart = (await store.messages(sessionId))
      .flatMap((message) => message.parts)
      .find((part) => part.type === "reasoning" && part.modelOutput !== undefined);
    expect(storedPart).toMatchObject({ type: "reasoning", text: "", modelOutput });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("RuntimeService excludes a failed prompt with only a synthetic error from subsequent model context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-core-failed-prompt-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const registry = new InMemoryToolRegistry();
  const createId = createSequentialId();
  let now = 0;
  const modelInputs: ModelStreamInput[] = [];
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelInputs.push(input);
      if (modelInputs.length === 1) throw new Error("startup exploded");
      yield { type: "text_delta", text: "ok" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event: RuntimeEvent) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    retryPolicy: { maxAttempts: 1 },
    createId,
    now: () => ++now as TimestampMs,
  });
  const service = new RuntimeService({
    runtime,
    store,
    cwd: "/repo",
    createId,
    now: () => ++now as TimestampMs,
  });
  const sessionId = "session_failed_prompt_context" as SessionId;

  try {
    await service.createSession({ sessionId });
    const failedResult = await service.submitPrompt({
      sessionId,
      text: "prompt that fails",
    });
    expect(failedResult.status).toBe("failed");

    const completedResult = await service.submitPrompt({
      sessionId,
      text: "prompt that succeeds",
    });

    expect(completedResult.status).toBe("completed");
    expect(modelInputs).toHaveLength(2);
    const secondContext = messageTextContent(modelInputs[1]?.messages ?? []);
    expect(secondContext).not.toContain("prompt that fails");
    expect(secondContext).not.toContain("Model request failed: startup exploded");
    expect(secondContext).toContain("prompt that succeeds");

    const transcript = await store.messages(sessionId);
    expect(messageTextContent(transcript)).toContain("Model request failed: startup exploded");
    const failurePart = transcript
      .flatMap((message) => message.parts)
      .find((part) => part.type === "text" && part.text.includes("startup exploded"));
    expect(failurePart).toMatchObject({ type: "text", synthetic: true });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function childMetadata(): NonNullable<SessionRow["agent"]> {
  return { parentSessionId: "session_guarded_parent" as SessionId, name: "worker", path: "/root/worker", policy: {} };
}

class FakeAgentRunner implements AgentRunner {
  readonly createInputs: CreateSessionInput[] = [];
  readonly userMessages: AppendUserMessageInput[] = [];
  readonly turnInputs: RunTurnInput[] = [];
  runTurnWait?: Promise<void>;
  onCreateSession?: (input: CreateSessionInput) => Promise<void> | void;
  onRunTurn?: (input: RunTurnInput) => Promise<void>;
  runTurnResult: RunTurnResult = {
    status: "completed",
    turnId: "turn_fake" as TurnId,
    assistantMessageId: "message_assistant_fake" as MessageId,
    finishReason: "stop",
  };

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    this.createInputs.push(input);
    await this.onCreateSession?.(input);
    return input.sessionId ?? ("session_fake" as SessionId);
  }

  async appendUserMessage(input: AppendUserMessageInput): Promise<MessageId> {
    this.userMessages.push(input);
    return "message_user_fake" as MessageId;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.turnInputs.push(input);
    await this.runTurnWait;
    await this.onRunTurn?.(input);
    return this.runTurnResult;
  }
}

class MemoryEventStore implements EventStore {
  readonly items: ChiliEvent[] = [];
  readonly messageRows: Message[] = [];
  readonly sessionRows: SessionRow[] = [];

  async append(event: ChiliEvent): Promise<void> {
    this.items.push(event);
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    const afterIndex = query.afterEventId
      ? this.items.findIndex((event) => event.id === query.afterEventId)
      : -1;
    const limit = query.limit ?? 500;
    return this.items
      .slice(afterIndex + 1)
      .filter((event) => {
        if (query.sessionId && event.sessionId !== query.sessionId) return false;
        if (query.type && event.type !== query.type) return false;
        return true;
      })
      .slice(0, limit);
  }

  async sessions(): Promise<SessionRow[]> {
    return this.sessionRows.map((row) => ({ ...row }));
  }

  addSession(
    sessionId: SessionId,
    cwd = "/repo",
  ): void {
    this.sessionRows.push({
      id: sessionId,
      cwd,
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
  }

  async messages(sessionId: SessionId): Promise<Message[]> {
    return this.messageRows
      .filter((message) => message.sessionId === sessionId)
      .map((message) => ({ ...message, parts: message.parts.map((part) => ({ ...part }) as Message["parts"][number]) }));
  }

  async pendingApprovals(): Promise<ApprovalRow[]> {
    return [];
  }
}

class LeaseControlledEventStore extends MemoryEventStore {
  claimId: string | undefined;
  allowRenew = true;

  claimSessionRun(input: {
    sessionId: SessionId;
    claimId: string;
    sessionAccess?: "root" | "child";
    time: number;
    leaseDurationMs: number;
  }): { status: "claimed" | "busy" | "inactive" | "not_found" | "forbidden"; sessionStatus?: string } {
    const session = this.sessionRows.find((candidate) => candidate.id === input.sessionId);
    if (!session) return { status: "not_found" };
    if (session.status !== "active") return { status: "inactive", sessionStatus: session.status };
    if (session.readOnly || Boolean(session.agent) !== (input.sessionAccess === "child")) return { status: "forbidden" };
    if (this.claimId) return { status: "busy" };
    this.claimId = input.claimId;
    return { status: "claimed" };
  }

  renewSessionRun(input: {
    sessionId: SessionId;
    claimId: string;
    time: number;
    leaseDurationMs: number;
  }): boolean {
    return this.allowRenew && this.claimId === input.claimId;
  }

  releaseSessionRun(input: { sessionId: SessionId; claimId: string }): void {
    if (this.claimId === input.claimId) this.claimId = undefined;
  }
}

class SessionIdentityEventStore extends MemoryEventStore {
  constructor(private readonly row: SessionRow) {
    super();
  }

  override async sessions(): Promise<SessionRow[]> {
    return [{ ...this.row }];
  }
}

class GoalBoundaryEventStore extends MemoryEventStore {
  private transitioned = false;

  constructor(
    private readonly sessionId: SessionId,
    private readonly boundary: "inactive" | "child" | "missing",
  ) {
    super();
    this.addSession(sessionId);
  }

  override async append(event: ChiliEvent): Promise<void> {
    await super.append(event);
    if (this.transitioned || event.type !== "goal.updated") return;
    this.transitioned = true;
    const row = this.sessionRows.find((candidate) => candidate.id === this.sessionId);
    if (this.boundary === "missing") {
      this.sessionRows.splice(0, this.sessionRows.length);
    } else if (row && this.boundary === "inactive") {
      row.status = "archived";
    } else if (row) {
      row.agent = childMetadata();
    }
  }
}

class ThrowingStatusStore extends MemoryEventStore {
  override async append(event: ChiliEvent): Promise<void> {
    if (event.type === "session.status_changed") {
      throw new Error("status write failed");
    }
    await super.append(event);
  }
}

function statuses(store: MemoryEventStore): string[] {
  return store.items.flatMap((event) => (event.type === "session.status_changed" ? [event.payload.status] : []));
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

function textMessage(input: {
  id: MessageId;
  sessionId: SessionId;
  role: Message["role"];
  text: string;
}): Message {
  return {
    id: input.id,
    sessionId: input.sessionId,
    role: input.role,
    createdAt: 1 as TimestampMs,
    parts: [
      {
        id: `${input.id}_part` as PartId,
        messageId: input.id,
        sessionId: input.sessionId,
        type: "text",
        text: input.text,
      },
    ],
  };
}

function messageTextContent(messages: readonly Message[]): string {
  return messages
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

function textOnlyModel(): RuntimeModelDescriptor {
  return {
    provider: "minimax",
    model: "MiniMax-M2.7-highspeed",
    inputCapabilities: ["text"],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
