import { describe, expect, test } from "bun:test";
import { SESSION_TITLE_MAX_CHARS } from "@chili/protocol";
import { reduceRuntimeEvents, type RuntimeClient } from "@chili/sdk";
import { acceptedInput, emptyInputQueue } from "./testing/input-receipts.js";
import { RuntimeHttpError } from "@chili/sdk";
import { DesktopControlService } from "./control-service.js";
import { parseDesktopResponse } from "../shared/contracts.js";

describe("desktop prompt controls", () => {
  test("Agent controls preserve caller and target identity and return input receipts", async () => {
    const calls: Array<{ operation: string; sessionId: string; agentId: string; text?: string; mode?: string }> = [];
    const client = {
      sendAgent: async (input: { sessionId: string; agentId: string; text: string; mode?: string }) => {
        calls.push({ operation: "send", ...input });
        return { agentId: input.agentId, inputId: "input_accepted" };
      },
      stopAgent: async (input: { sessionId: string; agentId: string }) => {
        calls.push({ operation: "stop", ...input });
        return { agentId: input.agentId };
      },
      resumeAgent: async (input: { sessionId: string; agentId: string }) => {
        calls.push({ operation: "resume", ...input });
        return { agentId: input.agentId, inputId: "input_resumed" };
      },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);
    const target = { sessionId: "parent", agentId: "child" };
    expect(await service.invoke({ type: "agent.send", ...target, text: "Review", mode: "steer" }))
      .toEqual({ agentId: "child", inputId: "input_accepted" });
    expect(await service.invoke({ type: "agent.stop", ...target })).toEqual({ agentId: "child" });
    expect(await service.invoke({ type: "agent.resume", ...target }))
      .toEqual({ agentId: "child", inputId: "input_resumed" });
    expect(calls).toMatchObject([
      { operation: "send", ...target, text: "Review", mode: "steer" },
      { operation: "stop", ...target },
      { operation: "resume", ...target },
    ]);
  });

  test("Agent control writes serialize by target without blocking other Agents", async () => {
    const gate = deferred<void>();
    const calls: string[] = [];
    const client = {
      sendAgent: async ({ agentId }: { agentId: string }) => {
        calls.push(`send:${agentId}`);
        await gate.promise;
        return { agentId, inputId: "input_accepted" };
      },
      stopAgent: async ({ agentId }: { agentId: string }) => { calls.push(`stop:${agentId}`); return { agentId }; },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);
    const sending = service.invoke({ type: "agent.send", sessionId: "root", agentId: "first", text: "Work" });
    await waitUntil(() => calls.length === 1);
    const stopping = service.invoke({ type: "agent.stop", sessionId: "root", agentId: "first" });
    await service.invoke({ type: "agent.stop", sessionId: "root", agentId: "second" });
    expect(calls).toEqual(["send:first", "stop:second"]);
    gate.resolve();
    await Promise.all([sending, stopping]);
    expect(calls).toEqual(["send:first", "stop:second", "stop:first"]);
  });

  test("forwards every input and its mode to durable admission without reading busy state", async () => {
    const submitted: unknown[] = [];
    const client = {
      sessionEvents: async () => { throw new Error("send must not read busy state"); },
      submitPromptAsync: async (input: { sessionId: string; text: string; mode: string; submissionId: string }) => {
        submitted.push(input);
        return acceptedInput(input.sessionId, input.text, submitted.length > 1, input.submissionId);
      },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);
    expect(await service.invoke({ type: "session.send", sessionId: "s", text: "one", mode: "queue", submissionId: "stable_one" })).toEqual({ status: "accepted" });
    expect(await service.invoke({ type: "session.send", sessionId: "s", text: "two", mode: "steer", submissionId: "stable_two" })).toEqual({ status: "queued", position: 1 });
    expect(submitted).toMatchObject([{ submissionId: "stable_one", mode: "queue" }, { submissionId: "stable_two", mode: "steer" }]);
  });

  test("serializes a held admission before Stop and gives Stop separate capacity", async () => {
    const gate = deferred<void>();
    const order: string[] = [];
    const client = {
      submitPromptAsync: async (input: { text: string }) => { order.push(input.text); await gate.promise; return acceptedInput("s", input.text); },
      interruptSession: async () => { order.push("stop"); return { interrupted: true }; },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);
    const sends = Array.from({ length: 8 }, (_, i) => service.invoke({ type: "session.send", sessionId: "s", text: String(i), mode: "queue" }));
    await waitUntil(() => order.length === 1);
    await expect(service.invoke({ type: "session.send", sessionId: "s", text: "overflow", mode: "queue" })).rejects.toThrow("Too many pending");
    const stop = service.invoke({ type: "session.stop", sessionId: "s" });
    expect(order).toEqual(["0"]);
    gate.resolve();
    await Promise.all(sends);
    await stop;
    expect(order).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "stop"]);
  });

  test("a lost response queries the same input instead of resubmitting it", async () => {
    let submits = 0;
    const lookedUp: string[] = [];
    const saved = acceptedInput("s", "one", false, "stable");
    const client = {
      submitPromptAsync: async () => { submits++; throw new Error("connection lost"); },
      getInput: async ({ submissionId }: { submissionId: string }) => { lookedUp.push(submissionId); return saved.input; },
      inputQueue: async () => saved.queue,
    } as unknown as RuntimeClient;
    expect(await serviceFor(client).invoke({ type: "session.send", sessionId: "s", text: "one", mode: "queue", submissionId: "stable" })).toEqual({ status: "accepted" });
    expect(submits).toBe(1);
    expect(lookedUp).toEqual(["stable"]);
  });

  test("a content conflict is not mistaken for a lost response", async () => {
    let queries = 0;
    const client = {
      submitPromptAsync: async () => { throw new RuntimeHttpError(409, "different content"); },
      getInput: async () => { queries++; return acceptedInput("s").input; },
    } as unknown as RuntimeClient;
    await expect(serviceFor(client).invoke({ type: "session.send", sessionId: "s", text: "changed", mode: "queue", submissionId: "stable" })).rejects.toThrow("different content");
    expect(queries).toBe(0);
  });

  test("idle events and Stop never dispatch client-owned work", async () => {
    let submits = 0;
    const queue = { ...emptyInputQueue("s", true, 4), pendingCount: 1 };
    const client = {
      submitPromptAsync: async () => { submits++; return acceptedInput("s", "queued", true); },
      interruptSession: async () => ({ interrupted: false }),
      inputQueue: async () => queue,
    } as unknown as RuntimeClient;
    const service = serviceFor(client);
    await service.invoke({ type: "session.send", sessionId: "s", text: "queued", mode: "queue" });
    await service.invoke({ type: "session.stop", sessionId: "s" });
    service.observeEvent({ id: "idle", type: "session.status_changed", sessionId: "s", time: 1, payload: { sessionId: "s", status: "idle" } } as never, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(submits).toBe(1);
  });

  test("session admission failures propagate without receipt recovery or mutation retries", async () => {
    let receiptReads = 0;
    let resumes = 0;
    const forbidden = new RuntimeHttpError(403, "Access denied");
    const client = {
      listSessions: async () => [{ id: "history", cwd: "/repo", status: "archived", createdAt: 1, updatedAt: 1 }],
      submitPromptAsync: async () => { throw forbidden; },
      interruptSession: async () => { throw forbidden; },
      getInput: async () => { receiptReads++; return undefined; },
      resumeInputs: async () => { resumes++; return emptyInputQueue("history"); },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);
    for (const mode of ["queue", "steer"] as const) {
      await expect(service.invoke({ type: "session.send", sessionId: "history", text: "continue", mode })).rejects.toBe(forbidden);
    }
    await expect(service.invoke({ type: "session.stop", sessionId: "history" })).rejects.toBe(forbidden);
    await expect(service.invoke({ type: "session.resume", sessionId: "history" })).rejects.toThrow("Archived");
    expect({ receiptReads, resumes }).toEqual({ receiptReads: 0, resumes: 0 });
  });

  test("healthy-state hydration cannot recursively trigger itself", async () => {
    let reads = 0;
    let emissions = 0;
    const state = { sidecar: { phase: "healthy" as const, attempt: 0 }, queuedBySession: {} };
    const client = { listSessions: async () => [sessionSummary("s")], inputQueue: async () => { reads++; return emptyInputQueue("s"); } } as unknown as RuntimeClient;
    const service = new DesktopControlService({
      sidecar: { getClientContext: () => ({ client, generation: 1 }), currentGeneration: () => 1,
        setQueuedCount: () => { emissions++; service.observeState(state, 1); } } as never,
      selectWorkspace: async () => undefined, persistWorkspace: async () => undefined, emitQueue: () => undefined, onError: (error) => { throw error; },
    });
    service.observeState(state, 1);
    await waitUntil(() => emissions === 1);
    for (let i = 0; i < 4; i++) service.observeState(state, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reads).toBe(1);
  });

  test("snapshot keeps a newer queue event that arrived after its initial queue read", async () => {
    const queue = emptyInputQueue("s", true, 3);
    const client = { ...snapshotClientMethods(), inputQueue: async () => emptyInputQueue("s", false, 1),
      sessionEventWindow: async () => ({ events: [{ id: "pause", type: "session.input_queue_changed", sessionId: "s", time: 1, payload: queue }], pendingApprovals: [], truncated: false, bytes: 2, pinnedEventIds: [] }),
    } as unknown as RuntimeClient;
    expect((await serviceFor(client).invoke({ type: "session.snapshot", sessionId: "s" })).inputQueue).toEqual(queue);
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

});

describe("desktop task controls", () => {
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
      getPermissionConfig: async () => permissionConfig("auto-review"),
      getDelegationConfig: async () => ({
        sessionId: "session_archived",
        policy: "proactive",
        source: "session",
      }),
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
      permission: { profile: "auto-review" },
      delegation: { sessionId: "session_archived", policy: "proactive" },
      mcp: { summary: { running: 1 } },
    });
    expect(mcpScopes).toEqual(["session_archived"]);
  });

  test("forwards review preferences as one runtime permission update", async () => {
    const updates: unknown[] = [];
    const client = {
      setPermissionProfile: async (update: unknown) => {
        updates.push(update);
        return permissionConfig("auto-review");
      },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);
    await service.invoke({
      type: "permissions.set",
      profile: "auto-review",
      reviewInstructions: "Allow necessary project edits.",
      reviewerModel: { provider: "local", model: "reviewer" },
    });
    await service.invoke({ type: "permissions.set", profile: "auto-review", reviewerModel: null });
    expect(updates).toMatchObject([
      {
        profile: "auto-review",
        reviewInstructions: "Allow necessary project edits.",
        reviewerModel: { provider: "local", model: "reviewer" },
      },
      { profile: "auto-review", reviewerModel: null },
    ]);
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
      title: "  Overnight   Release\nconsole  ",
    });

    expect(result).toMatchObject({
      sessionId: "session_normalized_title",
      status: "created",
      startState: "not_started",
    });
    expect(order).toEqual(["create", "rename"]);
    expect(renamedTitles).toEqual(["Overnight Release console"]);
  });

  test("configures a task in safe order before submitting its prompt", async () => {
    const order: string[] = [];
    let permission: "auto-review" | "full-access" = "auto-review";
    let promptSubmissions = 0;
    const client = {
      createSession: async () => {
        order.push("create");
        return { sessionId: "session_created" };
      },
      renameSession: async () => {
        order.push("rename");
        return sessionSummary("session_created");
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
      setPermissionProfile: async ({ profile }: { profile: "auto-review" | "full-access" }) => {
        permission = profile;
        order.push(`permission:set:${profile}`);
        return permissionConfig(permission);
      },
      submitPromptAsync: async () => {
        promptSubmissions += 1;
        order.push("prompt");
        return { status: "accepted", sessionId: "session_created" };
      },
    } as unknown as RuntimeClient;

    const result = await serviceFor(client).invoke({
      type: "sessions.create",
      title: "Overnight Release",
      prompt: "finish the release",
      modelSelection: { provider: "openai", model: "gpt-5" },
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionProfile: "full-access",
      delegationPolicy: "proactive",
    });

    expect(result).toMatchObject({ sessionId: "session_created", status: "started", started: true });
    expect(order).toEqual([
      "create",
      "rename",
      "model",
      "reasoning",
      "service_tier",
      "delegation",
      "permission:get:auto-review",
      "permission:set:full-access",
      "prompt",
    ]);
    expect(promptSubmissions).toBe(1);
  });

  test("serializes global permission rollback before a later desktop permission write", async () => {
    const permissionGate = deferred<void>();
    const order: string[] = [];
    let permission: "auto-review" | "full-access" = "auto-review";
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
      "get:auto-review",
      "set:full-access",
      "get:full-access",
      "set:auto-review",
      "set:auto-review",
    ]);
    expect(String(permission)).toBe("auto-review");
    expect(archived).toBe(0);
  });

  test("does not roll back global permission after an uncertain launch commit", async () => {
    let permission: "auto-review" | "full-access" = "auto-review";
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
    expect(order).toEqual(["get:auto-review", "set:full-access", "prompt:dispatch"]);
    expect(String(permission)).toBe("full-access");
  });

  test("archives an idle task", async () => {
    const order: string[] = [];
    const client = {
      sessionEvents: async () => [],
      archiveSession: async () => {
        order.push("archive");
      },
    } as unknown as RuntimeClient;

    expect(await serviceFor(client).invoke({ type: "session.archive", sessionId: "session_archive" }))
      .toEqual({ archived: true });
    expect(order).toEqual(["archive"]);
  });

  test("rejects archiving while a run is busy", async () => {
    let archives = 0;
    const client = {
      sessionEvents: async () => [{
        id: "event_archive_running",
        type: "session.status_changed",
        time: 1,
        sessionId: "session_archive",
        payload: { sessionId: "session_archive", status: "running" },
      }],
      archiveSession: async () => {
        archives += 1;
      },
    } as unknown as RuntimeClient;

    await expect(serviceFor(client).invoke({ type: "session.archive", sessionId: "session_archive" }))
      .rejects.toThrow("Stop the current run before archiving");
    expect(archives).toBe(0);
  });

  test("resumes the input queue and rejects archived tasks", async () => {
    const resumedSessions: string[] = [];
    const openedSessions: string[] = [];
    let lifecycle: "active" | "archived" = "active";
    const client = {
      openSession: async (sessionId: string) => { openedSessions.push(sessionId); },
      listSessions: async () => [sessionSummary("session_resume", lifecycle)],
      resumeInputs: async ({ sessionId }: { sessionId: string }) => {
        resumedSessions.push(sessionId);
        return emptyInputQueue(sessionId);
      },
      ...snapshotClientMethods(),
    } as unknown as RuntimeClient;
    const service = serviceFor(client);

    expect((await service.invoke({ type: "session.resume", sessionId: "session_resume" })).sessionId)
      .toBe("session_resume");
    expect(resumedSessions).toEqual(["session_resume"]);
    expect(openedSessions).toEqual(["session_resume"]);

    lifecycle = "archived";
    await expect(service.invoke({ type: "session.resume", sessionId: "session_resume" }))
      .rejects.toThrow("Archived tasks cannot be resumed");
    expect(resumedSessions).toEqual(["session_resume"]);
    expect(openedSessions).toEqual(["session_resume"]);
  });

  test("opening active tasks acquires ownership while snapshots and archived tasks remain readable", async () => {
    const opened: string[] = [];
    let lifecycle: "active" | "archived" = "active";
    const client = {
      ...snapshotClientMethods(),
      listSessions: async () => [sessionSummary("saved", lifecycle)],
      openSession: async (sessionId: string) => { opened.push(sessionId); },
    } as unknown as RuntimeClient;
    const service = serviceFor(client);
    await service.invoke({ type: "session.snapshot", sessionId: "saved" });
    expect(opened).toEqual([]);
    await service.invoke({ type: "session.open", sessionId: "saved" });
    expect(opened).toEqual(["saved"]);
    lifecycle = "archived";
    await service.invoke({ type: "session.open", sessionId: "saved" });
    expect(opened).toEqual(["saved"]);
  });

  test("a foreign session owner prevents resume before queued inputs are touched", async () => {
    let resumes = 0;
    const client = {
      ...snapshotClientMethods(),
      listSessions: async () => [sessionSummary("owned")],
      openSession: async () => { throw new Error("This session is open in another Host"); },
      resumeInputs: async () => { resumes++; return emptyInputQueue("owned"); },
    } as unknown as RuntimeClient;
    await expect(serviceFor(client).invoke({ type: "session.resume", sessionId: "owned" }))
      .rejects.toThrow("another Host");
    expect(resumes).toBe(0);
  });

  test("Steer delegates input arbitration entirely to RuntimeService", async () => {
    const seen: string[] = [];
    const client = {
      interruptSession: async () => { throw new Error("steer must not issue a separate interrupt"); },
      submitPromptAsync: async (input: { mode: string }) => { seen.push(input.mode); return acceptedInput("s", "change", true); },
    } as unknown as RuntimeClient;
    expect(await serviceFor(client).invoke({ type: "session.send", sessionId: "s", text: "change", mode: "steer" })).toEqual({ status: "queued", position: 1 });
    expect(seen).toEqual(["steer"]);
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

  test("hides metadata-bearing child Agents while keeping root sessions", async () => {
    const client = {
      listSessions: async () => [
        { id: "archived", cwd: "/repo", status: "archived", createdAt: 1, updatedAt: 1 },
        { id: "root", cwd: "/repo", status: "active", createdAt: 2, updatedAt: 2 },
        { id: "child", cwd: "/repo", agent: { parentSessionId: "root", name: "child", path: "/root/child", policy: {} }, status: "active", createdAt: 3, updatedAt: 3 },
      ],
    } as unknown as RuntimeClient;

    const sessions = await serviceFor(client).invoke({ type: "sessions.list" });
    expect(sessions.map((session) => String(session.id))).toEqual(["archived", "root"]);
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
      listAgents: async () => [],
      listUserInputs: async () => [],
    } as unknown as RuntimeClient;

    const snapshot = await serviceFor(client).invoke({ type: "session.snapshot", sessionId: "root" });
    expect(snapshot.events.map((event) => event.id)).toEqual(["z-created", "a-part"]);
    expect(reduceRuntimeEvents(snapshot.events).messages.message_1?.parts).toMatchObject([
      { id: "part_1", type: "text", text: "kept" },
    ]);
  });

  test("projects pinned history without execution identity paths or losing message dependencies", async () => {
    const identity = {
      profileId: "profile_one", profilePath: "/PRIVATE_PROFILE", authPath: "/PRIVATE_PROFILE/auth.json",
      projectId: "project_one", projectRoot: "/PRIVATE_SOURCE", workspaceId: "workspace_one", workspaceRoot: "/repo",
    };
    const sourceEvents = [
      { id: "created", type: "session.created", sessionId: "root", time: 1, payload: { sessionId: "root", cwd: "/repo", identity } },
      { id: "bound", type: "session.identity_bound", sessionId: "root", time: 2, payload: { sessionId: "root", identity } },
      { id: "message", type: "message.created", sessionId: "root", time: 3, payload: { messageId: "message_one", role: "assistant" } },
      { id: "part", type: "message.part_added", sessionId: "root", time: 4, payload: { messageId: "message_one", part: {
        id: "part_one", messageId: "message_one", sessionId: "root", type: "text", text: "History remains readable",
      } } },
    ];
    const original = structuredClone(sourceEvents);
    const client = {
      ...snapshotClientMethods(),
      sessionEventWindow: async () => ({ events: sourceEvents, pendingApprovals: [], truncated: false,
        bytes: Buffer.byteLength(JSON.stringify(sourceEvents)), pinnedEventIds: ["created", "bound", "message"] }),
    } as unknown as RuntimeClient;
    const request = { type: "session.snapshot", sessionId: "root" } as const;
    const snapshot = parseDesktopResponse(request, await serviceFor(client).invoke(request));
    expect(snapshot.events.map((event) => event.id)).toEqual(["created", "message", "part"]);
    expect(snapshot.events[0]).toMatchObject({ id: "created", sessionId: "root", payload: { sessionId: "root", cwd: "/repo" } });
    expect(snapshot.events[0]?.payload).not.toHaveProperty("identity");
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
    expect(sourceEvents).toEqual(original);
    expect(reduceRuntimeEvents(snapshot.events).messages.message_one?.parts).toMatchObject([{ text: "History remains readable" }]);
  });

  test("keeps archived root history readable when Agent control listing is forbidden", async () => {
    const client = {
      ...snapshotClientMethods(),
      listAgents: async () => { throw new RuntimeHttpError(403, "Agent control requires an active root session"); },
      sessionEventWindow: async () => ({
        events: [{ id: "historical", type: "session.renamed", sessionId: "archived", time: 1, payload: { sessionId: "archived", title: "History" } }],
        pendingApprovals: [], truncated: false, bytes: 2, pinnedEventIds: [],
      }),
    } as unknown as RuntimeClient;
    const snapshot = await serviceFor(client).invoke({ type: "session.snapshot", sessionId: "archived" });
    expect(snapshot.events.map((event) => event.id)).toEqual(["historical"]);
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.warning).toContain("Agent controls are unavailable");
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
      listAgents: async ({ sessionId: parentSessionId }: { sessionId: string }) => parentSessionId === "root"
        ? childSessionIds.map((childSessionId, index) => agentRecord(
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
      listAgents: async ({ sessionId: parentSessionId }: { sessionId: string }) => parentSessionId === "root"
        ? childSessionIds.map((childSessionId, index) => agentRecord(
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
      listAgents: async ({ sessionId: parentSessionId }: { sessionId: string }) => parentSessionId === "root"
        ? [agentRecord("task_child", "/root/task_child", "root", "child")]
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
      listAgents: async () => [],
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
      listAgents: async ({ sessionId: parentSessionId }: { sessionId: string }) => parentSessionId === "root"
        ? [agentRecord("task_child", "/root/task_child", "root", "child")]
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
      listAgents: async ({ sessionId: parentSessionId }: { sessionId: string }) => parentSessionId === "root"
        ? childSessionIds.map((childSessionId, index) => agentRecord(
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
      listAgents: async ({ sessionId: parentSessionId }: { sessionId: string }) => parentSessionId === "root"
        ? [agentRecord("task_child", "/root/task_child", "root", "child")]
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

  test("includes the root-visible hierarchy without using child identities as HTTP callers", async () => {
    const queried: string[] = [];
    const client = {
      inputQueue: async ({ sessionId }: { sessionId: string }) => {
        expect(sessionId).toBe("root");
        return emptyInputQueue(sessionId);
      },
      eventSnapshot: async ({ sessionId }: { sessionId?: string }) => {
        queried.push(`active:${sessionId ?? "workspace"}`);
        if (sessionId) throw new RuntimeHttpError(403, `Session identity is not admitted by this runtime: ${sessionId}`);
        return { events: [] };
      },
      sessionEvents: async ({ sessionId }: { sessionId: string }) => {
        queried.push(`events:${sessionId}`);
        return [{ id: `event_${sessionId}`, type: "turn.started", time: queried.length, sessionId, payload: { turnId: `turn_${sessionId}` } }];
      },
      listAgents: async ({ sessionId }: { sessionId: string }) => {
        expect(sessionId).toBe("root");
        queried.push(`agents:${sessionId}`);
        return [agentRecord("child", "/root/child", "root", "child"),
          agentRecord("grandchild", "/root/child/grandchild", "child", "grandchild")];
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
    expect(queried.filter((item) => item.startsWith("active:"))).toEqual(["active:workspace"]);
    expect(queried.filter((item) => item.startsWith("agents:"))).toEqual(["agents:root"]);
    expect(new Set(snapshot.events.map((event) => String(event.sessionId)))).toEqual(new Set(["root", "child", "grandchild"]));
    expect(new Set(snapshot.pendingInputs.map((input) => String(input.sessionId)))).toEqual(new Set(["root", "child", "grandchild"]));
    expect(new Set(snapshot.agents.map((agent) => agent.agentId))).toEqual(new Set(["child", "grandchild"]));
    expect(snapshot.agents.find((agent) => agent.agentId === "grandchild")).toMatchObject({ parentAgentId: "child", path: "/root/child/grandchild" });
  });

  test("combines the root active prefix with persisted child messages, status, and queue", async () => {
    const activeReads: string[] = [];
    const childQueue = emptyInputQueue("child", true, 4);
    const client = {
      ...snapshotClientMethods(),
      inputQueue: async ({ sessionId }: { sessionId: string }) => {
        expect(sessionId).toBe("root");
        return emptyInputQueue(sessionId);
      },
      eventSnapshot: async ({ sessionId: requestedSessionId }: { sessionId?: string }) => {
        activeReads.push(requestedSessionId ?? "workspace");
        if (requestedSessionId) throw new RuntimeHttpError(403, `Session identity is not admitted by this runtime: ${requestedSessionId}`);
        const sessionId = "root";
        return { events: [
          { id: "root_message", type: "message.created", sessionId, time: 1, payload: { messageId: "root_reply", role: "assistant" } },
          { id: "root_prefix", type: "message.part_stream_snapshot", sessionId, time: 2, payload: {
            messageId: "root_reply", part: { id: "root_part", messageId: "root_reply", sessionId, type: "text", text: "Still working" },
          } },
        ] };
      },
      sessionEventWindow: async ({ sessionId }: { sessionId: string }) => {
        const events = sessionId === "root" ? [] : [
          { id: "child_message", type: "message.created", sessionId, time: 3, payload: { messageId: "child_reply", role: "assistant" } },
          { id: "child_part", type: "message.part_committed", sessionId, time: 4, payload: {
            messageId: "child_reply", part: { id: "child_text", messageId: "child_reply", sessionId, type: "text", text: "Child result", completion: "completed" },
          } },
          { id: "child_status", type: "session.status_changed", sessionId, time: 5, payload: { sessionId, status: "idle" } },
          { id: "child_queue", type: "session.input_queue_changed", sessionId, time: 6, payload: childQueue },
        ];
        return { events, pendingApprovals: [], truncated: false, bytes: Buffer.byteLength(JSON.stringify(events)), pinnedEventIds: [] };
      },
      listAgents: async ({ sessionId }: { sessionId: string }) => {
        expect(sessionId).toBe("root");
        return [agentRecord("child", "/root/child", "root", "child")];
      },
    } as unknown as RuntimeClient;

    const request = { type: "session.snapshot", sessionId: "root" } as const;
    const snapshot = parseDesktopResponse(request, await serviceFor(client).invoke(request));
    const runtime = reduceRuntimeEvents(snapshot.events);
    expect(activeReads).toEqual(["workspace"]);
    expect(runtime.messages.root_reply?.parts).toMatchObject([{ text: "Still working" }]);
    expect(runtime.messages.child_reply?.parts).toMatchObject([{ text: "Child result", completion: "completed" }]);
    expect(runtime.sessions.child).toMatchObject({ status: "idle", inputQueue: childQueue });
    expect(snapshot.inputQueue).toEqual(emptyInputQueue("root"));
    expect(snapshot.truncated).toBeUndefined();
  });

  test("requires root admission and propagates active snapshot or child durable history failures", async () => {
    const rootError = new RuntimeHttpError(403, "Root identity rejected");
    const rootClient = {
      ...snapshotClientMethods(),
      inputQueue: async () => { throw rootError; },
      eventSnapshot: async () => { throw new Error("Must verify root admission before reading workspace state"); },
    } as unknown as RuntimeClient;
    await expect(serviceFor(rootClient).invoke({ type: "session.snapshot", sessionId: "root" })).rejects.toBe(rootError);

    const activeError = new RuntimeHttpError(503, "Runtime state recovery exceeds its bounded snapshot capacity.");
    const activeClient = {
      ...snapshotClientMethods(),
      eventSnapshot: async () => { throw activeError; },
    } as unknown as RuntimeClient;
    await expect(serviceFor(activeClient).invoke({ type: "session.snapshot", sessionId: "root" })).rejects.toBe(activeError);

    const childError = new RuntimeHttpError(500, "Child history unavailable");
    const childClient = {
      ...snapshotClientMethods(),
      eventSnapshot: async () => ({ events: [] }),
      listAgents: async () => [agentRecord("child", "/root/child", "root", "child")],
      sessionEventWindow: async ({ sessionId }: { sessionId: string }) => {
        if (sessionId === "child") throw childError;
        return { events: [], pendingApprovals: [], truncated: false, bytes: 2, pinnedEventIds: [] };
      },
    } as unknown as RuntimeClient;
    await expect(serviceFor(childClient).invoke({ type: "session.snapshot", sessionId: "root" })).rejects.toBe(childError);
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
      listAgents: ({ sessionId: parentSessionId }: { sessionId: string }) => tracked(
        parentSessionId === "root"
          ? childSessionIds.map((childSessionId, index) => agentRecord(
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
    expect(snapshot.agents.length).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(8_500_000);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.warning).toContain("timeline events");
  }, 10_000);
});

function serviceFor(client: RuntimeClient, onError: (error: Error) => void = () => undefined): DesktopControlService {
  client.openSession ??= async () => undefined;
  client.inputQueue ??= async ({ sessionId }) => emptyInputQueue(sessionId);
  client.getInput ??= async () => undefined;
  client.resumeInputs ??= async ({ sessionId }) => emptyInputQueue(sessionId);

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
    status,
    createdAt: 1,
    updatedAt: 1,
  } as never;
}

function permissionConfig(profile: "auto-review" | "full-access") {
  return {
    profile,
    reviewInstructions: "Review the exact operation against user intent.",
    defaultReviewInstructions: "Review the exact operation against user intent.",
    profiles: ["auto-review", "full-access"].map((id) => ({
      id,
      label: id,
      description: id,
      current: id === profile,
    })),
  } as never;
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
    listAgents: async () => [],
    listUserInputs: async () => [],
  };
}

function agentRecord(name: string, path: string, parentAgentId: string, agentId: string) {
  return { agentId, name, path, parentAgentId, state: "running" } as const;
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
