import { describe, expect, test } from "bun:test";
import { SESSION_TITLE_MAX_CHARS } from "@chili/protocol";
import { reduceRuntimeEvents, type RuntimeClient } from "@chili/sdk";
import { DesktopControlService } from "./control-service.js";

describe("desktop prompt controls", () => {
  test("serializes concurrent idle sends so only one prompt is accepted", async () => {
    const eventsGate = deferred<never[]>();
    const submitted: string[] = [];
    let eventReads = 0;
    const client = {
      sessionEvents: async () => {
        eventReads += 1;
        return eventsGate.promise;
      },
      submitPromptAsync: async (input: { text: string }) => {
        submitted.push(input.text);
        return { status: "accepted", sessionId: "session_1" };
      },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);

    const first = service.invoke({ type: "session.send", sessionId: "session_1", text: "first", mode: "queue" });
    await waitUntil(() => eventReads === 1);
    const second = service.invoke({ type: "session.send", sessionId: "session_1", text: "second", mode: "queue" });
    await Promise.resolve();
    expect(eventReads).toBe(1);
    expect(submitted).toEqual([]);

    eventsGate.resolve([]);
    expect(await first).toEqual({ status: "accepted" });
    expect(await second).toEqual({ status: "queued", position: 1 });
    expect(submitted).toEqual(["first"]);
    expect(eventReads).toBe(1);
  });

  test("orders stop after a send that is still checking admission", async () => {
    const eventsGate = deferred<never[]>();
    const order: string[] = [];
    const client = {
      sessionEvents: async () => {
        order.push("events:start");
        const events = await eventsGate.promise;
        order.push("events:end");
        return events;
      },
      submitPromptAsync: async () => {
        order.push("submit");
        return { status: "accepted", sessionId: "session_1" };
      },
      interruptSession: async () => {
        order.push("interrupt");
        return { interrupted: true };
      },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);

    const sending = service.invoke({ type: "session.send", sessionId: "session_1", text: "first", mode: "queue" });
    await waitUntil(() => order.includes("events:start"));
    const stopping = service.invoke({ type: "session.stop", sessionId: "session_1" });
    await Promise.resolve();
    expect(order).toEqual(["events:start"]);

    eventsGate.resolve([]);
    expect(await sending).toEqual({ status: "accepted" });
    expect(await stopping).toEqual({ interrupted: true });
    expect(order).toEqual(["events:start", "events:end", "submit", "interrupt"]);
  });

  test("bounds pending sends while preserving a separate stop admission channel", async () => {
    const eventsGate = deferred<never[]>();
    let eventReads = 0;
    let interrupts = 0;
    const client = {
      sessionEvents: async () => {
        eventReads += 1;
        return eventsGate.promise;
      },
      submitPromptAsync: async () => ({ status: "accepted", sessionId: "session_1" }),
      interruptSession: async () => {
        interrupts += 1;
        return { interrupted: true };
      },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);

    const admitted = Array.from({ length: 8 }, (_, index) => service.invoke({
      type: "session.send" as const,
      sessionId: "session_1",
      text: `work ${index}`,
      mode: "queue" as const,
    }));
    await waitUntil(() => eventReads === 1);
    await expect(service.invoke({
      type: "session.send",
      sessionId: "session_1",
      text: "over capacity",
      mode: "queue",
    })).rejects.toThrow("Too many pending desktop send operations");
    const stopping = service.invoke({ type: "session.stop", sessionId: "session_1" });

    eventsGate.resolve([]);
    expect((await Promise.all(admitted)).map((result) => result.status)).toEqual([
      "accepted",
      "queued",
      "queued",
      "queued",
      "queued",
      "queued",
      "queued",
      "queued",
    ]);
    expect(await stopping).toEqual({ interrupted: true });
    expect(interrupts).toBe(1);
  });

  test("bounds queued prompt items and cumulative UTF-8 bytes", async () => {
    const client = {
      sessionEvents: async () => [{
        id: "event_queue_capacity_running",
        type: "session.status_changed",
        time: 1,
        sessionId: "session_1",
        payload: { sessionId: "session_1", status: "running" },
      }],
    } as unknown as RuntimeClient;
    const service = serviceFor(client);

    for (let index = 0; index < 64; index += 1) {
      expect(await service.invoke({
        type: "session.send",
        sessionId: "session_1",
        text: `item ${index}`,
        mode: "queue",
      })).toMatchObject({ status: "queued", position: index + 1 });
    }
    await expect(service.invoke({
      type: "session.send",
      sessionId: "session_1",
      text: "item overflow",
      mode: "queue",
    })).rejects.toThrow("Desktop prompt queue capacity exceeded");

    const byteService = serviceFor(client);
    const utf8Prompt = "界".repeat(63_000);
    for (let index = 0; index < 10; index += 1) {
      expect((await byteService.invoke({
        type: "session.send",
        sessionId: "session_1",
        text: utf8Prompt,
        mode: "queue",
      })).status).toBe("queued");
    }
    await expect(byteService.invoke({
      type: "session.send",
      sessionId: "session_1",
      text: utf8Prompt,
      mode: "queue",
    })).rejects.toThrow("Desktop prompt queue capacity exceeded");
  });

  test("invalidates an admitted send before switching to a new workspace client", async () => {
    const eventsGate = deferred<never[]>();
    const submissions: string[] = [];
    let eventReads = 0;
    const oldClient = {
      sessionEvents: async () => {
        eventReads += 1;
        return eventsGate.promise;
      },
      submitPromptAsync: async () => {
        submissions.push("old");
        return { status: "accepted", sessionId: "session_1" };
      },
    } as unknown as RuntimeClient;
    const newClient = {
      submitPromptAsync: async () => {
        submissions.push("new");
        return { status: "accepted", sessionId: "session_1" };
      },
    } as unknown as RuntimeClient;
    let client = oldClient;
    let generation = 1;
    let workspace = "/old";
    const sidecar = {
      state: () => ({ sidecar: { phase: "healthy" as const, attempt: 0 }, workspace, queuedBySession: {} }),
      getClient: () => client,
      getClientContext: () => ({ client, generation }),
      currentGeneration: () => generation,
      currentWorkspace: () => workspace,
      setQueuedCount: () => undefined,
      switchWorkspace: async (nextWorkspace: string, afterStop?: () => Promise<void>) => {
        generation += 1;
        await afterStop?.();
        client = newClient;
        workspace = nextWorkspace;
      },
    };
    const service = new DesktopControlService({
      sidecar: sidecar as never,
      selectWorkspace: async () => "/new",
      persistWorkspace: async () => undefined,
      emitQueue: () => undefined,
      onError: () => undefined,
    });

    const sending = service.invoke({ type: "session.send", sessionId: "session_1", text: "old work", mode: "queue" });
    await waitUntil(() => eventReads === 1);
    const switching = service.invoke({ type: "workspace.select" });
    await Promise.resolve();
    eventsGate.resolve([]);

    await expect(sending).rejects.toThrow("Workspace changed");
    expect((await switching).workspace).toBe("/new");
    expect(submissions).toEqual([]);
  });

  test("preserves queued work when the same workspace is selected again", async () => {
    let runtimeBusy = true;
    let submissions = 0;
    const client = {
      sessionEvents: async () => runtimeBusy ? [{
        id: "event_running",
        type: "session.status_changed",
        time: 1,
        sessionId: "session_1",
        payload: { sessionId: "session_1", status: "running" },
      }] : [],
      submitPromptAsync: async () => {
        submissions += 1;
        return { status: "accepted", sessionId: "session_1" };
      },
    } as unknown as RuntimeClient;
    const sidecar = {
      state: () => ({ sidecar: { phase: "healthy" as const, attempt: 0 }, workspace: "/same", queuedBySession: {} }),
      getClient: () => client,
      getClientContext: () => ({ client, generation: 1 }),
      currentGeneration: () => 1,
      currentWorkspace: () => "/same",
      setQueuedCount: () => undefined,
      switchWorkspace: async () => undefined,
    };
    const service = new DesktopControlService({
      sidecar: sidecar as never,
      selectWorkspace: async () => "/same",
      persistWorkspace: async () => undefined,
      emitQueue: () => undefined,
      onError: () => undefined,
    });

    expect(await service.invoke({
      type: "session.send",
      sessionId: "session_1",
      text: "queued old work",
      mode: "queue",
    })).toEqual({ status: "queued", position: 1 });
    runtimeBusy = false;
    await service.invoke({ type: "workspace.select" });
    expect(await service.invoke({
      type: "session.send",
      sessionId: "session_1",
      text: "fresh work",
      mode: "queue",
    })).toEqual({ status: "queued", position: 2 });
    expect(submissions).toBe(0);
  });

  test("serializes concurrent workspace selections", async () => {
    const gates = [deferred<string | undefined>(), deferred<string | undefined>()];
    let selectionCalls = 0;
    let activeSelections = 0;
    let maxActiveSelections = 0;
    let generation = 1;
    let workspace = "/initial";
    const client = {} as RuntimeClient;
    const sidecar = {
      state: () => ({ sidecar: { phase: "healthy" as const, attempt: 0 }, workspace, queuedBySession: {} }),
      getClient: () => client,
      getClientContext: () => ({ client, generation }),
      currentGeneration: () => generation,
      currentWorkspace: () => workspace,
      setQueuedCount: () => undefined,
      switchWorkspace: async (next: string, afterStop?: () => Promise<void>) => {
        generation += 1;
        await afterStop?.();
        workspace = next;
      },
    };
    const service = new DesktopControlService({
      sidecar: sidecar as never,
      selectWorkspace: async () => {
        const gate = gates[selectionCalls];
        selectionCalls += 1;
        activeSelections += 1;
        maxActiveSelections = Math.max(maxActiveSelections, activeSelections);
        try {
          return await gate?.promise;
        } finally {
          activeSelections -= 1;
        }
      },
      persistWorkspace: async () => undefined,
      emitQueue: () => undefined,
      onError: () => undefined,
    });

    const first = service.invoke({ type: "workspace.select" });
    const second = service.invoke({ type: "workspace.select" });
    await waitUntil(() => selectionCalls === 1);
    gates[0]?.resolve("/first");
    expect((await first).workspace).toBe("/first");
    await waitUntil(() => selectionCalls === 2);
    await expect(service.invoke({ type: "sessions.list" })).rejects.toThrow("selection is in progress");
    expect(maxActiveSelections).toBe(1);
    gates[1]?.resolve("/second");
    expect((await second).workspace).toBe("/second");
    expect(maxActiveSelections).toBe(1);
  });

  test("ignores a stale idle event while an accepted prompt awaits its turn start", async () => {
    const submitGate = deferred<{ status: "accepted"; sessionId: "session_1" }>();
    const priorIdle = {
      id: "event_prior_idle",
      type: "session.status_changed",
      time: 10,
      sessionId: "session_1",
      payload: { sessionId: "session_1", status: "idle" },
    } as never;
    let submissions = 0;
    const client = {
      sessionEvents: async () => [priorIdle],
      submitPromptAsync: async () => {
        submissions += 1;
        if (submissions === 1) return submitGate.promise;
        return { status: "accepted", sessionId: "session_1" };
      },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);

    const first = service.invoke({ type: "session.send", sessionId: "session_1", text: "first", mode: "queue" });
    await waitUntil(() => submissions === 1);
    service.observeEvent(priorIdle, 1);
    const second = service.invoke({ type: "session.send", sessionId: "session_1", text: "second", mode: "queue" });
    submitGate.resolve({ status: "accepted", sessionId: "session_1" });

    expect(await first).toEqual({ status: "accepted" });
    expect(await second).toEqual({ status: "queued", position: 1 });
    expect(submissions).toBe(1);

    service.observeEvent({
      id: "event_new_turn",
      type: "turn.started",
      time: 10,
      sessionId: "session_1",
      payload: { turnId: "turn_new" },
    } as never, 1);
    service.observeEvent({
      id: "event_new_idle",
      type: "session.status_changed",
      time: 30,
      sessionId: "session_1",
      payload: { sessionId: "session_1", status: "idle" },
    } as never, 1);
    await waitUntil(() => submissions === 2);
  });

  test("releases optimistic busy when stop cancels before turn.started", async () => {
    const baselineIdle = {
      id: "event_baseline_idle",
      type: "session.status_changed",
      time: 10,
      sessionId: "session_1",
      payload: { sessionId: "session_1", status: "idle" },
    } as never;
    const submitted: string[] = [];
    const client = {
      sessionEvents: async () => [baselineIdle],
      submitPromptAsync: async (input: { text: string }) => {
        submitted.push(input.text);
        return { status: "accepted", sessionId: "session_1" };
      },
      interruptSession: async () => ({ interrupted: true }),
    } as unknown as RuntimeClient;
    const service = serviceFor(client);

    expect(await service.invoke({
      type: "session.send",
      sessionId: "session_1",
      text: "first",
      mode: "queue",
    })).toEqual({ status: "accepted" });
    service.observeEvent({
      id: "event_running_without_turn",
      type: "session.status_changed",
      time: 10,
      sessionId: "session_1",
      payload: { sessionId: "session_1", status: "running" },
    } as never, 1);
    expect(await service.invoke({ type: "session.stop", sessionId: "session_1" })).toEqual({ interrupted: true });
    expect(await service.invoke({
      type: "session.send",
      sessionId: "session_1",
      text: "after stop",
      mode: "queue",
    })).toEqual({ status: "queued", position: 1 });

    service.observeEvent({
      id: "event_cancelled_without_turn",
      type: "session.status_changed",
      time: 10,
      sessionId: "session_1",
      payload: { sessionId: "session_1", status: "idle" },
    } as never, 1);
    await waitUntil(() => submitted.length === 2);
    expect(submitted).toEqual(["first", "after stop"]);
  });

  test("queues while busy and steer interrupts ahead of the queue", async () => {
    const submitted: string[] = [];
    const interrupts: string[] = [];
    const client = {
      sessionEvents: async () => [{
        id: "event_running",
        type: "session.status_changed",
        time: 1,
        sessionId: "session_1",
        payload: { sessionId: "session_1", status: "running" },
      }],
      submitPromptAsync: async (input: { text: string }) => {
        submitted.push(input.text);
        return { status: "accepted", sessionId: "session_1" };
      },
      interruptSession: async (input: { reason?: string }) => {
        interrupts.push(input.reason ?? "");
        return { interrupted: true };
      },
      getGoal: async () => undefined,
    } as unknown as RuntimeClient;
    const sidecar = {
      state: () => ({ sidecar: { phase: "healthy" as const, attempt: 0 }, queuedBySession: {} }),
      getClient: () => client,
      getClientContext: () => ({ client, generation: 1 }),
      currentGeneration: () => 1,
      currentWorkspace: () => "/repo",
      setQueuedCount: () => undefined,
    };
    const counts: number[] = [];
    const service = new DesktopControlService({
      sidecar: sidecar as never,
      selectWorkspace: async () => undefined,
      persistWorkspace: async () => undefined,
      emitQueue: (_sessionId, count) => counts.push(count),
      onError: () => undefined,
    });

    expect(await service.invoke({ type: "session.send", sessionId: "session_1", text: "later", mode: "queue" })).toMatchObject({ status: "queued", position: 1 });
    expect(await service.invoke({ type: "session.send", sessionId: "session_1", text: "now", mode: "steer" })).toMatchObject({ status: "queued", position: 1 });
    expect(interrupts).toEqual(["desktop_steer"]);
    expect(submitted).toEqual([]);

    service.observeEvent({
      id: "event_idle",
      type: "session.status_changed",
      time: 2,
      sessionId: "session_1",
      payload: { sessionId: "session_1", status: "idle" },
    } as never, 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(submitted).toEqual(["now"]);
    expect(counts).toContain(1);
  });

  test("clears the optimistic busy flag when initial submission fails", async () => {
    let submissions = 0;
    const client = {
      sessionEvents: async () => [],
      submitPromptAsync: async () => {
        submissions += 1;
        if (submissions === 1) throw new Error("submit failed before acceptance");
        return { status: "accepted", sessionId: "session_1" };
      },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);

    await expect(service.invoke({
      type: "session.send",
      sessionId: "session_1",
      text: "first",
      mode: "queue",
    })).rejects.toThrow("submit failed");
    expect(await service.invoke({
      type: "session.send",
      sessionId: "session_1",
      text: "retry",
      mode: "queue",
    })).toEqual({ status: "accepted" });
    expect(submissions).toBe(2);
  });

  test("clears the optimistic busy flag when stop is rejected or finds no active turn", async () => {
    for (const behavior of ["not-interrupted", "rejected"] as const) {
      let submissions = 0;
      const client = {
        sessionEvents: async () => [],
        submitPromptAsync: async () => {
          submissions += 1;
          return { status: "accepted", sessionId: "session_1" };
        },
        interruptSession: async () => {
          if (behavior === "rejected") throw new Error("interrupt failed");
          return { interrupted: false };
        },
      } as unknown as RuntimeClient;
      const service = serviceFor(client);

      const stopping = service.invoke({ type: "session.stop", sessionId: "session_1" });
      if (behavior === "rejected") await expect(stopping).rejects.toThrow("interrupt failed");
      else expect(await stopping).toEqual({ interrupted: false });
      expect(await service.invoke({
        type: "session.send",
        sessionId: "session_1",
        text: "still sendable",
        mode: "queue",
      })).toEqual({ status: "accepted" });
      expect(submissions).toBe(1);
    }
  });

  test("does not leak a queued background flush rejection across shutdown", async () => {
    const reported: Error[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const client = {
        sessionEvents: async () => [{
          id: "running",
          type: "session.status_changed",
          time: 1,
          sessionId: "session_1",
          payload: { sessionId: "session_1", status: "running" },
        }],
      } as unknown as RuntimeClient;
      const service = serviceFor(client, (error) => reported.push(error));
      expect(await service.invoke({
        type: "session.send",
        sessionId: "session_1",
        text: "queued",
        mode: "queue",
      })).toEqual({ status: "queued", position: 1 });

      const actorGate = deferred<void>();
      const internals = service as unknown as {
        withSessionActor(sessionId: string, operation: () => Promise<void>): Promise<void>;
        scheduleFlush(sessionId: string): void;
      };
      const blocker = internals.withSessionActor("session_1", () => actorGate.promise);
      internals.scheduleFlush("session_1");
      service.beginShutdown();
      actorGate.resolve(undefined);
      await blocker;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(reported).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("desktop task and Goal controls", () => {
  test("preserves archived task session scope when aggregating readable configuration", async () => {
    const mcpScopes: Array<string | undefined> = [];
    const client = {
      getModelConfig: async () => ({
        sessionId: "session_archived",
        availableReasoningLevels: ["low", "high"],
        models: [{ provider: "openai", model: "gpt-5", available: true }],
        modelSelection: { provider: "openai", model: "gpt-5" },
        reasoningLevel: "high",
        serviceTier: "fast",
      }),
      getPermissionConfig: async () => permissionConfig("default"),
      getDelegationConfig: async () => ({
        sessionId: "session_archived",
        policy: "proactive",
        source: "session",
      }),
      getGoal: async () => goalRecord("session_archived", "paused"),
      mcpStatus: async (input: { sessionId?: string } = {}) => {
        mcpScopes.push(input.sessionId);
        return {
          servers: [{ name: "github", status: "running", enabled: true, toolCount: 4 }],
          summary: { total: 1, running: 1, disabled: 0, authRequired: 0, errored: 0 },
        };
      },
    } as unknown as RuntimeClient;

    const config = await serviceFor(client).invoke({
      type: "session.config.get",
      sessionId: "session_archived",
    });

    expect(config).toMatchObject({
      model: { sessionId: "session_archived", reasoningLevel: "high" },
      permission: { profile: "default" },
      delegation: { sessionId: "session_archived", policy: "proactive" },
      goal: { sessionId: "session_archived", status: "paused" },
      mcp: { summary: { running: 1 } },
    });
    expect(mcpScopes).toEqual(["session_archived"]);
  });

  test("rejects an over-limit New Task title before allocating a partial session", async () => {
    const maximumTitleChars = SESSION_TITLE_MAX_CHARS;
    let creations = 0;
    let renames = 0;
    const client = {
      createSession: async () => {
        creations += 1;
        return { sessionId: "session_partial_title" };
      },
      renameSession: async () => {
        renames += 1;
        throw new Error("Session title must be 120 characters or fewer.");
      },
    } as unknown as RuntimeClient;

    const outcome = await serviceFor(client).invoke({
      type: "sessions.create",
      title: "x".repeat(maximumTitleChars + 1),
    }).then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({
        kind: "rejected" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );

    expect({ outcome, creations, renames }).toEqual({
      outcome: {
        kind: "rejected",
        message: `Session title must be ${maximumTitleChars} characters or fewer.`,
      },
      creations: 0,
      renames: 0,
    });
  });

  test("normalizes a valid New Task title before the post-create rename", async () => {
    const order: string[] = [];
    const renamedTitles: string[] = [];
    const client = {
      createSession: async () => {
        order.push("create");
        return { sessionId: "session_normalized_title" };
      },
      renameSession: async ({ title }: { title: string }) => {
        order.push("rename");
        renamedTitles.push(title);
        return sessionSummary("session_normalized_title");
      },
    } as unknown as RuntimeClient;

    const result = await serviceFor(client).invoke({
      type: "sessions.create",
      title: "  Overnight   Goal\nconsole  ",
    });

    expect(result).toMatchObject({
      sessionId: "session_normalized_title",
      status: "created",
      startState: "not_started",
    });
    expect(order).toEqual(["create", "rename"]);
    expect(renamedTitles).toEqual(["Overnight Goal console"]);
  });

  test("configures a Goal task in safe order and starts only through setGoal", async () => {
    const order: string[] = [];
    let permission: "default" | "full-access" = "default";
    let promptSubmissions = 0;
    const client = {
      createSession: async () => {
        order.push("create");
        return { sessionId: "session_goal" };
      },
      renameSession: async () => {
        order.push("rename");
        return sessionSummary("session_goal");
      },
      setModel: async () => {
        order.push("model");
        return {};
      },
      setReasoning: async () => {
        order.push("reasoning");
        return {};
      },
      setServiceTier: async () => {
        order.push("service_tier");
        return {};
      },
      setDelegationPolicy: async () => {
        order.push("delegation");
        return {};
      },
      getPermissionConfig: async () => {
        order.push(`permission:get:${permission}`);
        return permissionConfig(permission);
      },
      setPermissionProfile: async ({ profile }: { profile: "default" | "full-access" }) => {
        permission = profile;
        order.push(`permission:set:${profile}`);
        return permissionConfig(permission);
      },
      setGoal: async () => {
        order.push("goal");
        return goalRecord("session_goal", "active");
      },
      submitPromptAsync: async () => {
        promptSubmissions += 1;
        return { status: "accepted", sessionId: "session_goal" };
      },
    } as unknown as RuntimeClient;

    const result = await serviceFor(client).invoke({
      type: "sessions.create",
      title: "Overnight Goal",
      prompt: "finish the release",
      modelSelection: { provider: "openai", model: "gpt-5" },
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionProfile: "full-access",
      delegationPolicy: "proactive",
      goal: { objective: "finish the release", tokenBudget: 20_000 },
    });

    expect(result).toMatchObject({ sessionId: "session_goal", status: "started", started: true });
    expect(order).toEqual([
      "create",
      "rename",
      "model",
      "reasoning",
      "service_tier",
      "delegation",
      "permission:get:default",
      "permission:set:full-access",
      "goal",
    ]);
    expect(promptSubmissions).toBe(0);
  });

  test("serializes global permission rollback before a later desktop permission write", async () => {
    const permissionGate = deferred<void>();
    const order: string[] = [];
    let permission: "default" | "full-access" | "auto-review" = "default";
    let archived = 0;
    const client = {
      createSession: async () => ({ sessionId: "session_partial" }),
      getPermissionConfig: async () => {
        order.push(`get:${permission}`);
        return permissionConfig(permission);
      },
      setPermissionProfile: async ({ profile }: { profile: typeof permission }) => {
        permission = profile;
        order.push(`set:${profile}`);
        if (profile === "full-access") {
          await permissionGate.promise;
          throw new Error("permission response failed");
        }
        return permissionConfig(permission);
      },
      submitPromptAsync: async () => {
        order.push("prompt:start");
        return { status: "accepted", sessionId: "session_partial" };
      },
      archiveSession: async () => {
        archived += 1;
      },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);

    const creating = service.invoke({
      type: "sessions.create",
      prompt: "ordinary task",
      permissionProfile: "full-access",
    });
    await waitUntil(() => order.includes("set:full-access"));
    const laterWrite = service.invoke({ type: "permissions.set", profile: "auto-review" });
    permissionGate.resolve(undefined);

    expect(await creating).toMatchObject({
      sessionId: "session_partial",
      status: "partial",
      startState: "not_started",
      started: false,
      failure: { stage: "permission", permissionRestored: true },
    });
    expect((await laterWrite).profile).toBe("auto-review");
    expect(order).toEqual([
      "get:default",
      "set:full-access",
      "get:full-access",
      "set:default",
      "set:auto-review",
    ]);
    expect(String(permission)).toBe("auto-review");
    expect(archived).toBe(0);
  });

  test("does not roll back global permission after an uncertain launch commit", async () => {
    let permission: "default" | "full-access" = "default";
    const order: string[] = [];
    const client = {
      createSession: async () => ({ sessionId: "session_uncertain" }),
      getPermissionConfig: async () => {
        order.push(`get:${permission}`);
        return permissionConfig(permission);
      },
      setPermissionProfile: async ({ profile }: { profile: typeof permission }) => {
        permission = profile;
        order.push(`set:${profile}`);
        return permissionConfig(permission);
      },
      submitPromptAsync: async () => {
        order.push("prompt:dispatch");
        throw new Error("launch acknowledgement lost");
      },
    } as unknown as RuntimeClient;

    const result = await serviceFor(client).invoke({
      type: "sessions.create",
      prompt: "ordinary task",
      permissionProfile: "full-access",
    });
    expect(result).toMatchObject({
      status: "partial",
      startState: "unknown",
      started: false,
      failure: { stage: "prompt", launchMayHaveCommitted: true },
    });
    expect(order).toEqual(["get:default", "set:full-access", "prompt:dispatch"]);
    expect(String(permission)).toBe("full-access");
  });

  test("pauses an idle active Goal before making its task read-only", async () => {
    const order: string[] = [];
    const client = {
      sessionEvents: async () => [],
      getGoal: async () => {
        order.push("goal:active");
        return goalRecord("session_archive", "active");
      },
      updateGoal: async ({ status }: { status?: string }) => {
        order.push(`goal:${status}`);
        return goalRecord("session_archive", "paused");
      },
      archiveSession: async () => {
        order.push("archive");
      },
    } as unknown as RuntimeClient;

    expect(await serviceFor(client).invoke({ type: "session.archive", sessionId: "session_archive" }))
      .toEqual({ archived: true });
    expect(order).toEqual(["goal:active", "goal:paused", "archive"]);
  });

  test("keeps the busy-run archive guard ahead of Goal mutation", async () => {
    let goalReads = 0;
    let goalUpdates = 0;
    let archives = 0;
    const client = {
      sessionEvents: async () => [{
        id: "event_archive_running",
        type: "session.status_changed",
        time: 1,
        sessionId: "session_archive",
        payload: { sessionId: "session_archive", status: "running" },
      }],
      getGoal: async () => {
        goalReads += 1;
        return goalRecord("session_archive", "active");
      },
      updateGoal: async () => {
        goalUpdates += 1;
        return goalRecord("session_archive", "paused");
      },
      archiveSession: async () => {
        archives += 1;
      },
    } as unknown as RuntimeClient;

    await expect(serviceFor(client).invoke({ type: "session.archive", sessionId: "session_archive" }))
      .rejects.toThrow("Stop the current run before archiving");
    expect({ goalReads, goalUpdates, archives }).toEqual({ goalReads: 0, goalUpdates: 0, archives: 0 });
  });

  test("archives paused, completed, and budget-limited Goals without rewriting them", async () => {
    for (const status of ["paused", "complete", "budgetLimited"] as const) {
      let goalUpdates = 0;
      let archives = 0;
      const client = {
        sessionEvents: async () => [],
        getGoal: async () => goalRecord(`session_${status}`, status),
        updateGoal: async () => {
          goalUpdates += 1;
          return goalRecord(`session_${status}`, status);
        },
        archiveSession: async () => {
          archives += 1;
        },
      } as unknown as RuntimeClient;

      expect(await serviceFor(client).invoke({ type: "session.archive", sessionId: `session_${status}` }))
        .toEqual({ archived: true });
      expect({ status, goalUpdates, archives }).toEqual({ status, goalUpdates: 0, archives: 1 });
    }
  });

  test("resumes a paused Goal, rejects archived and budget-limited Goals", async () => {
    const updates: Array<{ status?: string; tokenBudget?: number }> = [];
    let goalStatus: "paused" | "budgetLimited" = "paused";
    let lifecycle: "active" | "archived" = "active";
    const client = {
      listSessions: async () => [sessionSummary("session_resume", lifecycle)],
      getGoal: async () => goalRecord("session_resume", goalStatus),
      updateGoal: async (input: { status?: string; tokenBudget?: number }) => {
        updates.push(input);
        return goalRecord("session_resume", "active");
      },
      ...snapshotClientMethods(),
    } as unknown as RuntimeClient;
    const service = serviceFor(client);

    expect((await service.invoke({ type: "session.resume", sessionId: "session_resume" })).sessionId)
      .toBe("session_resume");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.status).toBe("active");

    goalStatus = "budgetLimited";
    await expect(service.invoke({ type: "session.resume", sessionId: "session_resume" }))
      .rejects.toThrow("Increase the Goal token budget");
    expect(updates).toHaveLength(1);

    lifecycle = "archived";
    await expect(service.invoke({ type: "session.resume", sessionId: "session_resume" }))
      .rejects.toThrow("Archived tasks cannot be resumed");
    expect(updates).toHaveLength(1);
  });

  test("forwards a higher Goal budget with active status for explicit recovery", async () => {
    let received: { status?: string; tokenBudget?: number } | undefined;
    const client = {
      sessionEvents: async () => [],
      updateGoal: async (input: { status?: string; tokenBudget?: number }) => {
        received = input;
        return { ...goalRecord("session_budget", "active"), tokenBudget: input.tokenBudget };
      },
    } as unknown as RuntimeClient;

    const result = await serviceFor(client).invoke({
      type: "session.goal.update",
      sessionId: "session_budget",
      status: "active",
      tokenBudget: 40_000,
    });
    expect(received).toMatchObject({ status: "active", tokenBudget: 40_000 });
    expect(result).toMatchObject({ status: "active", tokenBudget: 40_000 });
  });

  test("does not claim an active Goal resume while a prior run is still draining", async () => {
    let updates = 0;
    const client = {
      sessionEvents: async () => [{
        id: "event_cancelling",
        type: "session.status_changed",
        time: 1,
        sessionId: "session_budget",
        payload: { sessionId: "session_budget", status: "cancelling" },
      }],
      updateGoal: async () => {
        updates += 1;
        return goalRecord("session_budget", "active");
      },
    } as unknown as RuntimeClient;

    await expect(serviceFor(client).invoke({
      type: "session.goal.update",
      sessionId: "session_budget",
      status: "active",
      tokenBudget: 40_000,
    })).rejects.toThrow("Wait for the current run to stop");
    expect(updates).toBe(0);
  });

  test("steers an active Goal and resumes it only after the queued prompt drains", async () => {
    const order: string[] = [];
    let goalStatus: "active" | "paused" = "active";
    let submissions = 0;
    let resumptions = 0;
    const client = {
      sessionEvents: async () => [{
        id: "event_running_goal",
        type: "session.status_changed",
        time: 1,
        sessionId: "session_goal",
        payload: { sessionId: "session_goal", status: "running" },
      }],
      getGoal: async () => {
        order.push(`goal:${goalStatus}`);
        return goalRecord("session_goal", goalStatus);
      },
      interruptSession: async () => {
        order.push("interrupt");
        goalStatus = "paused";
        return { interrupted: true };
      },
      submitPromptAsync: async () => {
        order.push("submit:steer");
        submissions += 1;
        return { status: "accepted", sessionId: "session_goal" };
      },
      updateGoal: async ({ status }: { status?: "active" | "paused" }) => {
        order.push(`update:${status}`);
        if (status === "active") {
          goalStatus = "active";
          resumptions += 1;
        }
        return goalRecord("session_goal", goalStatus);
      },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);

    expect(await service.invoke({
      type: "session.send",
      sessionId: "session_goal",
      text: "change direction",
      mode: "steer",
    })).toEqual({ status: "queued", position: 1 });
    expect(order).toEqual(["goal:active", "interrupt"]);

    service.observeEvent({
      id: "event_original_stopped",
      type: "session.status_changed",
      time: 2,
      sessionId: "session_goal",
      payload: { sessionId: "session_goal", status: "cancelled" },
    } as never, 1);
    await waitUntil(() => submissions === 1);
    expect(resumptions).toBe(0);

    service.observeEvent({
      id: "event_steer_finished",
      type: "session.status_changed",
      time: 3,
      sessionId: "session_goal",
      payload: { sessionId: "session_goal", status: "idle" },
    } as never, 1);
    await waitUntil(() => resumptions === 1);
    expect(order).toEqual([
      "goal:active",
      "interrupt",
      "submit:steer",
      "goal:paused",
      "update:active",
    ]);

    service.observeEvent({
      id: "event_extra_idle",
      type: "session.status_changed",
      time: 4,
      sessionId: "session_goal",
      payload: { sessionId: "session_goal", status: "idle" },
    } as never, 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(resumptions).toBe(1);
  });
});

describe("desktop session projections", () => {
  test("turns in-flight read failures into valid shutdown fallbacks", async () => {
    let rejectList: ((error: Error) => void) | undefined;
    const client = {
      listSessions: () => new Promise<never>((_, reject) => {
        rejectList = reject;
      }),
    } as unknown as RuntimeClient;
    const service = serviceFor(client);
    const reading = service.invoke({ type: "sessions.list" });
    await Promise.resolve();
    service.beginShutdown();
    rejectList?.(new Error("Chili sidecar is not ready"));

    expect(await reading).toEqual([]);
  });

  test("shutdown closes desktop mutation admission before sidecar cleanup", async () => {
    let submissions = 0;
    let listCalls = 0;
    const client = {
      sessionEvents: async () => [],
      submitPromptAsync: async () => {
        submissions += 1;
        return { status: "accepted", sessionId: "session_1" };
      },
      listSessions: async () => {
        listCalls += 1;
        return [];
      },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);

    service.beginShutdown();

    await expect(service.invoke({
      type: "session.send",
      sessionId: "session_1",
      text: "must not start",
      mode: "queue",
    })).rejects.toThrow("Desktop is closing");
    expect(await service.invoke({ type: "sessions.list" })).toEqual([]);
    expect((await service.invoke({ type: "app.state" })).sidecar.phase).toBe("healthy");
    expect(submissions).toBe(0);
    expect(listCalls).toBe(0);
  });

  test("exposes one idempotent main-process containment promise and a force hook", async () => {
    const containment = deferred<void>();
    let closeCalls = 0;
    let forceCalls = 0;
    const processGroups = {
      signal: new AbortController().signal,
      close: () => {
        closeCalls += 1;
        return containment.promise;
      },
      forceKillAll: () => {
        forceCalls += 1;
      },
    };
    const client = {} as RuntimeClient;
    const sidecar = {
      state: () => ({ sidecar: { phase: "healthy" as const, attempt: 0 }, queuedBySession: {} }),
      getClient: () => client,
      getClientContext: () => ({ client, generation: 1 }),
      currentGeneration: () => 1,
      currentWorkspace: () => "/repo",
      setQueuedCount: () => undefined,
    };
    const service = new DesktopControlService({
      sidecar: sidecar as never,
      selectWorkspace: async () => undefined,
      persistWorkspace: async () => undefined,
      emitQueue: () => undefined,
      onError: () => undefined,
      processGroups: processGroups as never,
    });

    service.beginShutdown();
    const close = service.close();
    expect(service.containMainProcesses()).toBe(close);
    expect(closeCalls).toBe(1);
    service.forceContainGitProcessGroups();
    expect(forceCalls).toBe(1);

    containment.resolve(undefined);
    await close;
  });

  test("shutdown rejects a workspace selected by a dialog that resolves late", async () => {
    const dialog = deferred<string | undefined>();
    let dialogCalls = 0;
    let switches = 0;
    let persists = 0;
    const client = {} as RuntimeClient;
    const sidecar = {
      state: () => ({
        sidecar: { phase: "healthy" as const, attempt: 0 },
        workspace: "/old",
        queuedBySession: {},
      }),
      getClient: () => client,
      getClientContext: () => ({ client, generation: 1 }),
      currentGeneration: () => 1,
      currentWorkspace: () => "/old",
      setQueuedCount: () => undefined,
      switchWorkspace: async () => {
        switches += 1;
      },
    };
    const service = new DesktopControlService({
      sidecar: sidecar as never,
      selectWorkspace: async () => {
        dialogCalls += 1;
        return dialog.promise;
      },
      persistWorkspace: async () => {
        persists += 1;
      },
      emitQueue: () => undefined,
      onError: () => undefined,
    });
    const selecting = service.invoke({ type: "workspace.select" });
    await waitUntil(() => dialogCalls === 1);

    service.beginShutdown();
    dialog.resolve("/late-workspace");

    await expect(selecting).rejects.toThrow("Desktop is closing");
    expect(switches).toBe(0);
    expect(persists).toBe(0);
  });

  test("rejects a stale session list after the workspace client changes", async () => {
    const oldList = deferred<Awaited<ReturnType<RuntimeClient["listSessions"]>>>();
    const oldClient = { listSessions: () => oldList.promise } as unknown as RuntimeClient;
    const newClient = {
      listSessions: async () => [{
        id: "session_new",
        cwd: "/new",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }],
    } as unknown as RuntimeClient;
    let client = oldClient;
    let generation = 1;
    let workspace = "/old";
    const sidecar = {
      state: () => ({ sidecar: { phase: "healthy" as const, attempt: 0 }, workspace, queuedBySession: {} }),
      getClient: () => client,
      getClientContext: () => ({ client, generation }),
      currentGeneration: () => generation,
      currentWorkspace: () => workspace,
      setQueuedCount: () => undefined,
      switchWorkspace: async (next: string, afterStop?: () => Promise<void>) => {
        generation += 1;
        await afterStop?.();
        client = newClient;
        workspace = next;
      },
    };
    const service = new DesktopControlService({
      sidecar: sidecar as never,
      selectWorkspace: async () => "/new",
      persistWorkspace: async () => undefined,
      emitQueue: () => undefined,
      onError: () => undefined,
    });

    const stale = service.invoke({ type: "sessions.list" });
    await Promise.resolve();
    await service.invoke({ type: "workspace.select" });
    oldList.resolve([{
      id: "session_old",
      cwd: "/old",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    } as never]);

    await expect(stale).rejects.toThrow("Workspace changed");
    expect((await service.invoke({ type: "sessions.list" })).map((session) => String(session.id)))
      .toEqual(["session_new"]);
  });

  test("hides subagent sessions while keeping legacy interactive sessions", async () => {
    const client = {
      listSessions: async () => [
        { id: "legacy", cwd: "/repo", status: "active", createdAt: 1, updatedAt: 1 },
        { id: "interactive", cwd: "/repo", source: "interactive", status: "active", createdAt: 2, updatedAt: 2 },
        { id: "child", cwd: "/repo", source: "subagent", status: "active", createdAt: 3, updatedAt: 3 },
      ],
    } as unknown as RuntimeClient;

    const sessions = await serviceFor(client).invoke({ type: "sessions.list" });
    expect(sessions.map((session) => String(session.id))).toEqual(["legacy", "interactive"]);
  });

  test("preserves durable order for same-millisecond message creation and part events", async () => {
    const client = {
      sessionEvents: async () => [
        {
          id: "z-created",
          type: "message.created",
          time: 100,
          sessionId: "root",
          payload: { messageId: "message_1", role: "assistant" },
        },
        {
          id: "a-part",
          type: "message.part_added",
          time: 100,
          sessionId: "root",
          payload: {
            messageId: "message_1",
            part: { id: "part_1", messageId: "message_1", sessionId: "root", type: "text", text: "kept" },
          },
        },
      ],
      agentTree: async () => ({ nodes: [], agents: [], tasks: [], mailbox: [] }),
      listTasks: async () => [],
      listUserInputs: async () => [],
    } as unknown as RuntimeClient;

    const snapshot = await serviceFor(client).invoke({ type: "session.snapshot", sessionId: "root" });
    expect(snapshot.events.map((event) => event.id)).toEqual(["z-created", "a-part"]);
    expect(reduceRuntimeEvents(snapshot.events).messages.message_1?.parts).toMatchObject([
      { id: "part_1", type: "text", text: "kept" },
    ]);
  });

  test("uses stable descendant and durable ordinals when retaining the event-budget tail", async () => {
    const childSessionIds = ["child_z", "child_a", "child_m", "child_b"];
    const client = {
      sessionEvents: async ({ sessionId }: { sessionId: string }) => Array.from({ length: 5_000 }, (_, index) => {
        if (sessionId === "root" && index === 4_998) {
          return {
            id: "root-active-turn",
            type: "turn.started",
            time: 100,
            sessionId,
            payload: { turnId: "turn_root_active" },
          };
        }
        if (sessionId === "root" && index === 4_999) {
          return {
            id: "root-pending-approval",
            type: "approval.requested",
            time: 100,
            sessionId,
            payload: { approvalId: "approval_root_pending", permission: "write", patterns: [] },
          };
        }
        return {
          id: `event_${sessionId}_${String(4_999 - index).padStart(4, "0")}`,
          type: "session.renamed",
          time: sessionId === "root" ? 100 : 1,
          sessionId,
          payload: { sessionId, title: `title_${sessionId}_${index}` },
        };
      }),
      agentTree: async () => ({ nodes: [], agents: [], tasks: [], mailbox: [] }),
      listTasks: async ({ parentSessionId }: { parentSessionId: string }) => parentSessionId === "root"
        ? childSessionIds.map((childSessionId, index) => taskRecord(
          `task_${index}`,
          `/root/task_${index}`,
          "root",
          childSessionId,
        ))
        : [],
      listUserInputs: async () => [],
    } as unknown as RuntimeClient;

    const snapshot = await serviceFor(client).invoke({ type: "session.snapshot", sessionId: "root" });
    expect(snapshot.events).toHaveLength(20_000);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.warning).toContain("timeline events");
    for (const [sourceIndex, sessionId] of childSessionIds.slice(1).entries()) {
      const offset = sourceIndex * 5_000;
      expect(String(snapshot.events[offset]?.sessionId)).toBe(sessionId);
      expect(snapshot.events[offset]?.payload).toMatchObject({ title: `title_${sessionId}_0` });
      expect(snapshot.events[offset + 4_999]?.payload).toMatchObject({ title: `title_${sessionId}_4999` });
    }
    expect(String(snapshot.events[15_000]?.sessionId)).toBe("root");
    expect(snapshot.events[15_000]?.payload).toMatchObject({ title: "title_root_0" });
    expect(snapshot.events[19_998]?.id).toBe("root-active-turn");
    expect(snapshot.events[19_999]?.id).toBe("root-pending-approval");
  });

  test("uses UTF-8 byte-budget tail retention without dropping a recent root event", async () => {
    const childSessionIds = ["child_oldest", "child_newer"];
    const largeError = "旧".repeat(700_000);
    const client = {
      sessionEvents: async ({ sessionId }: { sessionId: string }) => sessionId === "root"
        ? [{
            id: "root-recent",
            type: "turn.started",
            time: 100,
            sessionId,
            payload: { turnId: "turn_root_recent" },
          }]
        : [{
            id: `event_${sessionId}`,
            type: "session.renamed",
            time: 1,
            sessionId,
            payload: { sessionId, title: largeError },
          }],
      agentTree: async () => ({ nodes: [], agents: [], tasks: [], mailbox: [] }),
      listTasks: async ({ parentSessionId }: { parentSessionId: string }) => parentSessionId === "root"
        ? childSessionIds.map((childSessionId, index) => taskRecord(
          `task_${index}`,
          `/root/task_${index}`,
          "root",
          childSessionId,
        ))
        : [],
      listUserInputs: async () => [],
    } as unknown as RuntimeClient;

    const snapshot = await serviceFor(client).invoke({ type: "session.snapshot", sessionId: "root" });
    expect(snapshot.events.map((event) => event.id)).toEqual(["event_child_newer", "root-recent"]);
    expect(Buffer.byteLength(JSON.stringify(snapshot.events), "utf8")).toBeLessThan(4_000_000);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.warning).toContain("timeline events");
  });

  test("uses a composable continuous byte tail across descendant batches", async () => {
    const client = {
      sessionEvents: async ({ sessionId }: { sessionId: string }) => sessionId === "root"
        ? [
            sizedSessionRename("event_x", 1, sessionId, 250),
            sizedSessionRename("event_b", 2, sessionId, 250),
            sizedSessionRename("event_a", 3, sessionId, 3_999_500),
          ]
        : [sizedSessionRename("event_n", 4, sessionId, 600)],
      agentTree: async () => ({ nodes: [], agents: [], tasks: [], mailbox: [] }),
      listTasks: async ({ parentSessionId }: { parentSessionId: string }) => parentSessionId === "root"
        ? [taskRecord("task_child", "/root/task_child", "root", "child")]
        : [],
      listUserInputs: async () => [],
    } as unknown as RuntimeClient;

    const snapshot = await serviceFor(client).invoke({ type: "session.snapshot", sessionId: "root" });
    expect(snapshot.events.map((event) => event.id)).toEqual(["event_n"]);
    expect(Buffer.byteLength(JSON.stringify(snapshot.events), "utf8")).toBe(602);
    expect(snapshot.truncated).toBe(true);
  });

  test("counts JSON array brackets and separators at the byte-budget boundary", async () => {
    const exactClient = {
      sessionEvents: async () => [
        sizedSessionRename("event_first", 1, "root", 250),
        sizedSessionRename("event_last", 2, "root", 3_999_747),
      ],
      agentTree: async () => ({ nodes: [], agents: [], tasks: [], mailbox: [] }),
      listTasks: async () => [],
      listUserInputs: async () => [],
    } as unknown as RuntimeClient;
    const overClient = {
      ...exactClient,
      sessionEvents: async () => [
        sizedSessionRename("event_first", 1, "root", 250),
        sizedSessionRename("event_last", 2, "root", 3_999_748),
      ],
    } as unknown as RuntimeClient;

    const exact = await serviceFor(exactClient).invoke({ type: "session.snapshot", sessionId: "root" });
    expect(exact.events.map((event) => event.id)).toEqual(["event_first", "event_last"]);
    expect(Buffer.byteLength(JSON.stringify(exact.events), "utf8")).toBe(4_000_000);
    expect(exact.truncated).toBeUndefined();

    const over = await serviceFor(overClient).invoke({ type: "session.snapshot", sessionId: "root" });
    expect(over.events.map((event) => event.id)).toEqual(["event_last"]);
    expect(Buffer.byteLength(JSON.stringify(over.events), "utf8")).toBe(3_999_750);
    expect(over.truncated).toBe(true);
  });

  test("forwards authoritative event-window pins and truncation metadata", async () => {
    let legacyEventReads = 0;
    const client = {
      sessionEventWindow: async ({ sessionId }: { sessionId: string }) => {
        const events = sessionId === "root"
          ? [sizedSessionRename("root-authoritative-pin", 1, sessionId, 250)]
          : [sizedSessionRename("child-newer-large", 2, sessionId, 3_999_748)];
        return {
          events,
          bytes: Buffer.byteLength(JSON.stringify(events), "utf8"),
          truncated: sessionId === "root",
          pinnedEventIds: sessionId === "root" ? ["root-authoritative-pin"] : [],
          pendingApprovals: sessionId === "root"
            ? [pendingApproval("approval_root", sessionId, 1)]
            : [
                pendingApproval("approval_root", "root", 1),
                pendingApproval("approval_child", sessionId, 2),
              ],
        };
      },
      sessionEvents: async () => {
        legacyEventReads += 1;
        return [];
      },
      agentTree: async () => ({ nodes: [], agents: [], tasks: [], mailbox: [] }),
      listTasks: async ({ parentSessionId }: { parentSessionId: string }) => parentSessionId === "root"
        ? [taskRecord("task_child", "/root/task_child", "root", "child")]
        : [],
      listUserInputs: async () => [],
    } as unknown as RuntimeClient;

    const snapshot = await serviceFor(client).invoke({ type: "session.snapshot", sessionId: "root" });
    expect(snapshot.events.map((event) => event.id)).toEqual(["root-authoritative-pin"]);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.warning).toContain("timeline events");
    expect(legacyEventReads).toBe(0);
    expect(snapshot.pendingApprovals.map((approval) => approval.id)).toEqual([
      "approval_root",
      "approval_child",
    ]);
  });

  test("bounds legacy pending approvals across descendant count", async () => {
    const childSessionIds = ["child_a", "child_b"];
    const client = {
      sessionEvents: async () => [],
      pendingApprovalWindow: async ({ sessionId }: { sessionId: string }) => {
        const approvals = Array.from({ length: 1_000 }, (_, index) => pendingApproval(
          `approval_${sessionId}_${index}`,
          sessionId,
          index,
        ));
        return {
          approvals,
          truncated: false,
          bytes: Buffer.byteLength(JSON.stringify(approvals), "utf8"),
        };
      },
      agentTree: async () => ({ nodes: [], agents: [], tasks: [], mailbox: [] }),
      listTasks: async ({ parentSessionId }: { parentSessionId: string }) => parentSessionId === "root"
        ? childSessionIds.map((childSessionId, index) => taskRecord(
          `task_${index}`,
          `/root/task_${index}`,
          "root",
          childSessionId,
        ))
        : [],
      listUserInputs: async () => [],
    } as unknown as RuntimeClient;

    const snapshot = await serviceFor(client).invoke({ type: "session.snapshot", sessionId: "root" });
    expect(snapshot.pendingApprovals.length).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(JSON.stringify(snapshot.pendingApprovals), "utf8")).toBeLessThan(1_000_000);
    expect(snapshot.pendingApprovals.some((approval) => approval.sessionId === "root")).toBe(true);
    expect(snapshot.pendingApprovals.some((approval) => approval.sessionId === "child_a")).toBe(true);
    expect(snapshot.pendingApprovals.some((approval) => approval.sessionId === "child_b")).toBe(false);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.warning).toContain("pending approvals");
  });

  test("bounds aggregate pending approval JSON by UTF-8 bytes", async () => {
    const client = {
      sessionEvents: async () => [],
      pendingApprovalWindow: async ({ sessionId }: { sessionId: string }) => {
        const pattern = sessionId === "child" ? "界".repeat(300) : "safe";
        const approvals = Array.from({ length: 1_000 }, (_, index) => pendingApproval(
          `approval_${sessionId}_${index}`,
          sessionId,
          index,
          pattern,
        ));
        return {
          approvals,
          truncated: false,
          bytes: Buffer.byteLength(JSON.stringify(approvals), "utf8"),
        };
      },
      agentTree: async () => ({ nodes: [], agents: [], tasks: [], mailbox: [] }),
      listTasks: async ({ parentSessionId }: { parentSessionId: string }) => parentSessionId === "root"
        ? [taskRecord("task_child", "/root/task_child", "root", "child")]
        : [],
      listUserInputs: async () => [],
    } as unknown as RuntimeClient;

    const snapshot = await serviceFor(client).invoke({ type: "session.snapshot", sessionId: "root" });
    expect(snapshot.pendingApprovals.length).toBeGreaterThan(1_000);
    expect(snapshot.pendingApprovals.length).toBeLessThan(2_000);
    expect(Buffer.byteLength(JSON.stringify(snapshot.pendingApprovals), "utf8")).toBeLessThan(1_000_000);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.warning).toContain("pending approvals");
  });

  test("recursively includes nested child sessions in one snapshot", async () => {
    const children: Record<string, string | undefined> = {
      root: "child",
      child: "grandchild",
      grandchild: undefined,
    };
    const queried: string[] = [];
    const client = {
      sessionEvents: async ({ sessionId }: { sessionId: string }) => {
        queried.push(`events:${sessionId}`);
        return [{ id: `event_${sessionId}`, type: "turn.started", time: queried.length, sessionId, payload: { turnId: `turn_${sessionId}` } }];
      },
      agentTree: async ({ sessionId }: { sessionId: string }) => {
        const childSessionId = children[sessionId];
        const path = sessionId === "root" ? "/root" : sessionId === "child" ? "/root/child" : "/root/child/grandchild";
        const parentPath = sessionId === "root" ? undefined : sessionId === "child" ? "/root" : "/root/child";
        const task = childSessionId ? taskRecord(`tree_task_${sessionId}`, path, sessionId, childSessionId) : undefined;
        return {
          nodes: [{
            path,
            ...(parentPath ? { parentPath } : {}),
            taskName: sessionId,
            status: task ? "running" : "completed",
            runIds: [],
            runs: [],
            tasks: task ? [task] : [],
            mailbox: [],
            children: [],
            createdAt: 1,
            updatedAt: 1,
          }],
          agents: [],
          tasks: task ? [task] : [],
          mailbox: [],
        };
      },
      listTasks: async ({ parentSessionId }: { parentSessionId: string }) => {
        const childSessionId = children[parentSessionId];
        return childSessionId
          ? [taskRecord(`list_task_${parentSessionId}`, `/root/${parentSessionId}`, parentSessionId, childSessionId)]
          : [];
      },
      listUserInputs: async ({ sessionId }: { sessionId: string }) => [{
        id: `input_${sessionId}`,
        sessionId,
        callId: `call_${sessionId}`,
        questions: [],
        createdAt: 1,
      }],
    } as unknown as RuntimeClient;

    const snapshot = await serviceFor(client).invoke({ type: "session.snapshot", sessionId: "root" });
    expect(new Set(snapshot.events.map((event) => String(event.sessionId)))).toEqual(new Set(["root", "child", "grandchild"]));
    expect(new Set(snapshot.pendingInputs.map((input) => String(input.sessionId)))).toEqual(new Set(["root", "child", "grandchild"]));
    expect(new Set(snapshot.tasks.map((task) => String(task.childSessionId)))).toEqual(new Set(["child", "grandchild"]));
    expect(snapshot.agentTree.tasks.some((task) => task.childSessionId === "grandchild")).toBe(true);
    expect(flattenPaths(snapshot.agentTree.nodes)).toContain("/root/child/grandchild");
  });

  test("bounds descendant snapshot concurrency and output size", async () => {
    const childSessionIds = Array.from({ length: 511 }, (_, index) => `child_${index}`);
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const queriedSessions = new Set<string>();
    const tracked = async <T>(value: T): Promise<T> => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        await new Promise((resolvePromise) => setImmediate(resolvePromise));
        return value;
      } finally {
        activeRequests -= 1;
      }
    };
    const client = {
      sessionEvents: ({ sessionId }: { sessionId: string }) => {
        queriedSessions.add(sessionId);
        return tracked(Array.from({ length: 50 }, (_, index) => ({
          id: `event_${sessionId}_${index}`,
          type: "session.renamed",
          time: index,
          sessionId,
          payload: { sessionId, title: `title_${sessionId}_${index}` },
        })));
      },
      agentTree: () => tracked({ nodes: [], agents: [], tasks: [], mailbox: [] }),
      listTasks: ({ parentSessionId }: { parentSessionId: string }) => tracked(
        parentSessionId === "root"
          ? childSessionIds.map((childSessionId, index) => taskRecord(
            `task_${index}`,
            `/root/task_${index}`,
            "root",
            childSessionId,
          ))
          : [],
      ),
      listUserInputs: () => tracked([]),
    } as unknown as RuntimeClient;

    const snapshot = await serviceFor(client).invoke({ type: "session.snapshot", sessionId: "root" });
    expect(queriedSessions.size).toBe(512);
    expect(maxActiveRequests).toBeLessThanOrEqual(6);
    expect(snapshot.events.length).toBeLessThanOrEqual(20_000);
    expect(snapshot.tasks.length).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(8_500_000);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.warning).toContain("timeline events");
  }, 10_000);
});

function serviceFor(client: RuntimeClient, onError: (error: Error) => void = () => undefined): DesktopControlService {
  const sidecar = {
    state: () => ({ sidecar: { phase: "healthy" as const, attempt: 0 }, queuedBySession: {} }),
    getClient: () => client,
    getClientContext: () => ({ client, generation: 1 }),
    currentGeneration: () => 1,
    currentWorkspace: () => "/repo",
    setQueuedCount: () => undefined,
  };
  return new DesktopControlService({
    sidecar: sidecar as never,
    selectWorkspace: async () => undefined,
    persistWorkspace: async () => undefined,
    emitQueue: () => undefined,
    onError,
  });
}

function sessionSummary(id: string, status: "active" | "archived" = "active") {
  return {
    id,
    cwd: "/repo",
    source: "interactive",
    status,
    createdAt: 1,
    updatedAt: 1,
  } as never;
}

function permissionConfig(profile: "default" | "auto-review" | "full-access") {
  return {
    profile,
    profiles: ["default", "auto-review", "full-access"].map((id) => ({
      id,
      label: id,
      description: id,
      current: id === profile,
    })),
  } as never;
}

function goalRecord(sessionId: string, status: "active" | "paused" | "budgetLimited" | "complete") {
  return {
    sessionId,
    objective: "finish the release",
    status,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function snapshotClientMethods() {
  return {
    sessionEvents: async () => [],
    sessionEventWindow: async () => ({
      events: [],
      pendingApprovals: [],
      truncated: false,
      bytes: 2,
      pinnedEventIds: [],
    }),
    agentTree: async () => ({ nodes: [], agents: [], tasks: [], mailbox: [] }),
    listTasks: async () => [],
    listUserInputs: async () => [],
  };
}

function taskRecord(id: string, path: string, parentSessionId: string, childSessionId: string) {
  return {
    id,
    path,
    status: "running",
    taskName: id,
    generation: 0,
    parentSessionId,
    childSessionId,
    createdAt: 1,
    updatedAt: 1,
  } as never;
}

function pendingApproval(id: string, sessionId: string, createdAt: number, pattern = "safe") {
  return {
    id,
    sessionId,
    permission: "write",
    patterns: [pattern],
    createdAt,
  } as never;
}

function sizedSessionRename(id: string, time: number, sessionId: string, targetBytes: number) {
  const event = {
    id,
    type: "session.renamed",
    time,
    sessionId,
    payload: { sessionId, title: "" },
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  if (targetBytes < baseBytes) throw new Error(`Target event size ${targetBytes} is below ${baseBytes}`);
  event.payload.title = "x".repeat(targetBytes - baseBytes);
  return event;
}

function flattenPaths(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.path, ...flattenPaths(node.children)]);
}

interface TreeNode {
  path: string;
  children: TreeNode[];
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for condition");
}
