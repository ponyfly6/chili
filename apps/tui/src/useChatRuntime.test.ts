import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement } from "react";
import type {
  ChiliEvent,
  RuntimeCommandCatalog,
  RuntimeMcpAuthResponse,
  RuntimeMcpLogoutResponse,
  RuntimeMcpReloadResponse,
  RuntimeMcpRemoveServerResponse,
  RuntimeMcpServerDescriptor,
  RuntimeMcpStatusResponse,
  RuntimeMcpToolsResponse,
  RuntimeModelConfig,
  SessionId,
  TaskId,
  TeamId,
  TimestampMs,
} from "@chili/protocol";
import type { ChatSessionView, HttpRuntimeClient, RuntimeSessionSummary } from "@chili/sdk";
import {
  acceptedFeedbackMatchesStatus,
  useChatRuntime,
  type ChatRuntimeFeedback,
  type ChatRuntimeState,
} from "./useChatRuntime.js";
import type { TeamLiveTuiOptions } from "./useTeamLiveRuntime.js";

const sessionId = "session_feedback_gate" as SessionId;
const accepted: ChatRuntimeFeedback = {
  status: "accepted",
  message: "prompt queued",
  acceptedSessionId: sessionId,
  acceptedAgainstStatusEventId: "event_old_status",
};

test("unrelated events do not clear a per-session accepted acknowledgement", () => {
  const view = {
    sessionId,
    statusEventId: "event_old_status",
    lastEventId: "event_from_another_session",
  } as Pick<ChatSessionView, "sessionId" | "statusEventId" | "lastEventId">;

  expect(acceptedFeedbackMatchesStatus(accepted, view)).toBe(true);
});

test("a new status event for the accepted session clears the acknowledgement gate", () => {
  expect(acceptedFeedbackMatchesStatus(accepted, {
    sessionId,
    statusEventId: "event_new_status",
  })).toBe(false);
});

test("an acknowledgement never attaches to a different visible session", () => {
  expect(acceptedFeedbackMatchesStatus(accepted, {
    sessionId: "session_other" as SessionId,
    statusEventId: "event_old_status",
  })).toBe(false);
});

test("a late model-config response from the previous session cannot overwrite the resumed session", async () => {
  const sessionA = "session_model_config_a" as SessionId;
  const sessionB = "session_model_config_b" as SessionId;
  const modelConfigA = deferred<RuntimeModelConfig>();
  const modelConfigB = deferred<RuntimeModelConfig>();
  const requestedConfigs: SessionId[] = [];
  const sessions = [sessionSummary(sessionA), sessionSummary(sessionB)];
  const client = {
    listSessions: async () => sessions,
    sessionEvents: async (input: { sessionId: SessionId }) => [sessionCreatedEvent(input.sessionId)],
    streamEvents: async function* (input: { signal?: AbortSignal } = {}) {
      await waitForAbort(input.signal);
    },
    listModels: async () => [],
    getModelConfig: async (input: { sessionId: SessionId }) => {
      requestedConfigs.push(input.sessionId);
      return input.sessionId === sessionA ? modelConfigA.promise : modelConfigB.promise;
    },
    getDelegationConfig: async (input: { sessionId: SessionId }) => ({
      sessionId: input.sessionId,
      policy: "explicit" as const,
      source: "default" as const,
    }),
    getPermissionConfig: async () => ({ profile: "default" as const, profiles: [] }),
    listCommands: async () => ({ roots: [], diagnostics: [] }),
    mcpStatus: async () => ({
      servers: [],
      summary: { total: 0, running: 0, disabled: 0, authRequired: 0, errored: 0 },
    }),
  } as unknown as HttpRuntimeClient;
  const options: TeamLiveTuiOptions = {
    baseUrl: "http://chili.test",
    cwd: "/workspace",
    sessionId: sessionA,
    runLoop: false,
    once: false,
  };
  let runtime: ChatRuntimeState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(createElement(ChatRuntimeProbe, {
      client,
      options,
      onRuntime: (value: ChatRuntimeState) => { runtime = value; },
    }), { width: 100, height: 4, exitOnCtrlC: false });
  });

  try {
    await waitForRuntime(app, () => (
      runtime?.activeSessionId === sessionA && requestedConfigs.includes(sessionA)
    ));

    let resumed = false;
    await act(async () => {
      resumed = await runtime!.resumeSession({ id: sessionB });
      await app.renderOnce();
    });
    expect(resumed).toBe(true);
    await waitForRuntime(app, () => requestedConfigs.includes(sessionB));

    modelConfigB.resolve(runtimeModelConfig(sessionB, "model-b"));
    await waitForRuntime(app, () => runtime?.modelConfig?.sessionId === sessionB);

    modelConfigA.resolve(runtimeModelConfig(sessionA, "model-a"));
    await act(async () => {
      await Bun.sleep(10);
      await app.renderOnce();
    });

    expect(runtime?.activeSessionId).toBe(sessionB);
    expect(runtime?.modelConfig?.sessionId).toBe(sessionB);
    expect(runtime?.modelConfig?.modelSelection).toEqual({ provider: "test", model: "model-b" });
  } finally {
    act(() => app.renderer.destroy());
  }
});

test("team run-loop and merge use the resumed session authority instead of startup options", async () => {
  const sessionA = "session_team_resume_a" as SessionId;
  const sessionB = "session_team_resume_b" as SessionId;
  const teamId = "team_resume_authority" as TeamId;
  const taskId = "task_resume_authority" as TaskId;
  const sessions = [
    sessionSummary(sessionA, "/workspace/a"),
    sessionSummary(sessionB, "/workspace/b"),
  ];
  const runRequests: Array<Record<string, unknown>> = [];
  const mergeRequests: Array<Record<string, unknown>> = [];
  const client = chatRuntimeClient(sessions, {
    runTeamLoop: async (request: Record<string, unknown>) => {
      runRequests.push(request);
      return {};
    },
    mergeTeamTasks: async (request: Record<string, unknown>) => {
      mergeRequests.push(request);
      return {};
    },
  });
  const options: TeamLiveTuiOptions = {
    baseUrl: "http://chili.test",
    cwd: "/workspace/startup",
    sessionId: sessionA,
    runLoop: false,
    once: false,
  };
  let runtime: ChatRuntimeState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(createElement(ChatRuntimeProbe, {
      client,
      options,
      onRuntime: (value: ChatRuntimeState) => { runtime = value; },
    }), { width: 100, height: 4, exitOnCtrlC: false });
  });

  try {
    await waitForRuntime(app, () => runtime?.activeSessionId === sessionA);
    let resumed = false;
    await act(async () => {
      resumed = await runtime!.resumeSession({ id: sessionB });
      await app.renderOnce();
    });
    expect(resumed).toBe(true);
    await waitForRuntime(app, () => runtime?.activeSessionId === sessionB && runtime.chatView.cwd === "/workspace/b");

    await act(async () => {
      runtime!.executeAction({ type: "run_loop", teamId, enabled: true });
      runtime!.executeAction({ type: "merge", teamId, taskId, enabled: true });
      await Bun.sleep(5);
      await app.renderOnce();
    });

    expect(runRequests[0]).toMatchObject({ teamId, sessionId: sessionB, cwd: "/workspace/b" });
    expect(mergeRequests[0]).toMatchObject({ teamId, taskId, sessionId: sessionB, cwd: "/workspace/b" });
  } finally {
    act(() => app.renderer.destroy());
  }
});

test("resume aborts an in-flight submit and ignores its late acceptance", async () => {
  const sessionA = "session_submit_resume_a" as SessionId;
  const sessionB = "session_submit_resume_b" as SessionId;
  const sessions = [sessionSummary(sessionA), sessionSummary(sessionB)];
  const submit = deferred<unknown>();
  const submitSignals: AbortSignal[] = [];
  const client = chatRuntimeClient(sessions, {
    submitPromptAsync: async (request: { signal?: AbortSignal }) => {
      if (request.signal) submitSignals.push(request.signal);
      return submit.promise;
    },
  });
  const options: TeamLiveTuiOptions = {
    baseUrl: "http://chili.test",
    cwd: "/workspace",
    sessionId: sessionA,
    runLoop: false,
    once: false,
  };
  let runtime: ChatRuntimeState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(createElement(ChatRuntimeProbe, {
      client,
      options,
      onRuntime: (value: ChatRuntimeState) => { runtime = value; },
    }), { width: 100, height: 4, exitOnCtrlC: false });
  });

  try {
    await waitForRuntime(app, () => runtime?.activeSessionId === sessionA);
    let pendingSubmit!: Promise<boolean>;
    await act(async () => {
      pendingSubmit = runtime!.submitPrompt("do not attach this to B");
      await Bun.sleep(5);
      await app.renderOnce();
    });
    expect(submitSignals).toHaveLength(1);

    let resumed = false;
    await act(async () => {
      resumed = await runtime!.resumeSession({ id: sessionB });
      await app.renderOnce();
    });
    expect(resumed).toBe(true);
    await waitForRuntime(app, () => runtime?.activeSessionId === sessionB);
    expect(submitSignals[0]?.aborted).toBe(true);

    let submitted = true;
    await act(async () => {
      submit.resolve({ status: "accepted", sessionId: sessionA });
      submitted = await pendingSubmit;
      await app.renderOnce();
    });

    expect(submitted).toBe(false);
    expect(runtime?.activeSessionId).toBe(sessionB);
    expect(runtime?.chatFeedback).toEqual({ status: "success", message: "saved chat resumed" });
  } finally {
    act(() => app.renderer.destroy());
  }
});

test("resume aborts model, reasoning, and service-tier mutations and ignores late completions", async () => {
  const sessionA = "session_config_resume_a" as SessionId;
  const sessionB = "session_config_resume_b" as SessionId;
  const sessions = [sessionSummary(sessionA), sessionSummary(sessionB)];
  const modelUpdate = deferred<unknown>();
  const reasoningUpdate = deferred<unknown>();
  const tierUpdate = deferred<unknown>();
  const mutationSignals: AbortSignal[] = [];
  const configRequests: SessionId[] = [];
  const client = chatRuntimeClient(sessions, {
    getModelConfig: async (request: { sessionId: SessionId }) => {
      configRequests.push(request.sessionId);
      return runtimeModelConfig(request.sessionId, request.sessionId === sessionB ? "model-b" : "model-a");
    },
    setModel: async (request: { signal?: AbortSignal }) => {
      if (request.signal) mutationSignals.push(request.signal);
      return modelUpdate.promise;
    },
    setReasoning: async (request: { signal?: AbortSignal }) => {
      if (request.signal) mutationSignals.push(request.signal);
      return reasoningUpdate.promise;
    },
    setServiceTier: async (request: { signal?: AbortSignal }) => {
      if (request.signal) mutationSignals.push(request.signal);
      return tierUpdate.promise;
    },
  });
  const options: TeamLiveTuiOptions = {
    baseUrl: "http://chili.test",
    cwd: "/workspace",
    sessionId: sessionA,
    runLoop: false,
    once: false,
  };
  let runtime: ChatRuntimeState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(createElement(ChatRuntimeProbe, {
      client,
      options,
      onRuntime: (value: ChatRuntimeState) => { runtime = value; },
    }), { width: 100, height: 4, exitOnCtrlC: false });
  });

  try {
    await waitForRuntime(app, () => (
      runtime?.activeSessionId === sessionA && runtime.modelConfig?.sessionId === sessionA
    ));
    const configARequestsBeforeMutations = configRequests.filter((id) => id === sessionA).length;
    let mutations!: Promise<boolean>[];
    await act(async () => {
      mutations = [
        runtime!.setRuntimeModel!({ provider: "test", model: "late-model-a" }),
        runtime!.setRuntimeReasoning!("medium"),
        runtime!.setRuntimeServiceTier!("fast"),
      ];
      await Bun.sleep(5);
      await app.renderOnce();
    });
    expect(mutationSignals).toHaveLength(3);

    let resumed = false;
    await act(async () => {
      resumed = await runtime!.resumeSession({ id: sessionB });
      await app.renderOnce();
    });
    expect(resumed).toBe(true);
    await waitForRuntime(app, () => (
      runtime?.activeSessionId === sessionB && runtime.modelConfig?.sessionId === sessionB
    ));
    expect(mutationSignals.every((signal) => signal.aborted)).toBe(true);

    let results: boolean[] = [];
    await act(async () => {
      modelUpdate.resolve(runtimeModelConfig(sessionA, "late-model-a"));
      reasoningUpdate.resolve(runtimeModelConfig(sessionA, "late-reasoning-a"));
      tierUpdate.resolve(runtimeModelConfig(sessionA, "late-tier-a"));
      results = await Promise.all(mutations);
      await app.renderOnce();
    });

    expect(results).toEqual([false, false, false]);
    expect(runtime?.activeSessionId).toBe(sessionB);
    expect(runtime?.modelConfig?.sessionId).toBe(sessionB);
    expect(runtime?.modelConfig?.modelSelection).toEqual({ provider: "test", model: "model-b" });
    expect(runtime?.chatFeedback).toEqual({ status: "success", message: "saved chat resumed" });
    expect(configRequests.filter((id) => id === sessionA)).toHaveLength(configARequestsBeforeMutations);
  } finally {
    act(() => app.renderer.destroy());
  }
});

test("MCP status follows the selected session and ignores a late prior-workspace response", async () => {
  const sessionA = "session_mcp_status_a" as SessionId;
  const sessionB = "session_mcp_status_b" as SessionId;
  const statusA = deferred<RuntimeMcpStatusResponse>();
  const statusB = deferred<RuntimeMcpStatusResponse>();
  const requestedScopes: Array<SessionId | undefined> = [];
  const sessions = [sessionSummary(sessionA), sessionSummary(sessionB)];
  const client = {
    listSessions: async () => sessions,
    sessionEvents: async (input: { sessionId: SessionId }) => [sessionCreatedEvent(input.sessionId)],
    streamEvents: async function* (input: { signal?: AbortSignal } = {}) {
      await waitForAbort(input.signal);
    },
    listModels: async () => [],
    getModelConfig: async (input: { sessionId: SessionId }) => runtimeModelConfig(input.sessionId, "model"),
    getDelegationConfig: async (input: { sessionId: SessionId }) => ({
      sessionId: input.sessionId,
      policy: "explicit" as const,
      source: "default" as const,
    }),
    getPermissionConfig: async () => ({ profile: "default" as const, profiles: [] }),
    listCommands: async () => emptyCommandCatalog(),
    mcpStatus: async (input: { sessionId?: SessionId } = {}) => {
      requestedScopes.push(input.sessionId);
      if (input.sessionId === sessionA) return statusA.promise;
      if (input.sessionId === sessionB) return statusB.promise;
      return mcpStatusResponse();
    },
  } as unknown as HttpRuntimeClient;
  const options: TeamLiveTuiOptions = {
    baseUrl: "http://chili.test",
    cwd: "/workspace",
    sessionId: sessionA,
    runLoop: false,
    once: false,
  };
  let runtime: ChatRuntimeState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(createElement(ChatRuntimeProbe, {
      client,
      options,
      onRuntime: (value: ChatRuntimeState) => { runtime = value; },
    }), { width: 100, height: 4, exitOnCtrlC: false });
  });

  try {
    await waitForRuntime(app, () => runtime?.activeSessionId === sessionA && requestedScopes.includes(sessionA));

    let resumed = false;
    await act(async () => {
      resumed = await runtime!.resumeSession({ id: sessionB });
      await app.renderOnce();
    });
    expect(resumed).toBe(true);
    await waitForRuntime(app, () => requestedScopes.includes(sessionB));

    statusB.resolve(mcpStatusResponse("workspace-b"));
    await waitForRuntime(app, () => runtime?.mcpStatus?.servers[0]?.name === "workspace-b");

    statusA.resolve(mcpStatusResponse("workspace-a"));
    await act(async () => {
      await Bun.sleep(10);
      await app.renderOnce();
    });

    expect(runtime?.activeSessionId).toBe(sessionB);
    expect(runtime?.mcpStatus?.servers[0]?.name).toBe("workspace-b");
  } finally {
    act(() => app.renderer.destroy());
  }
});

test("all late MCP operations return undefined and cannot refresh the next session", async () => {
  const sessionA = "session_mcp_actions_a" as SessionId;
  const sessionB = "session_mcp_actions_b" as SessionId;
  const status = deferred<RuntimeMcpStatusResponse>();
  const server = deferred<RuntimeMcpServerDescriptor>();
  const reload = deferred<RuntimeMcpReloadResponse>();
  const tools = deferred<RuntimeMcpToolsResponse>();
  const add = deferred<RuntimeMcpServerDescriptor>();
  const remove = deferred<RuntimeMcpRemoveServerResponse>();
  const auth = deferred<RuntimeMcpAuthResponse>();
  const logout = deferred<RuntimeMcpLogoutResponse>();
  const requestedStatusScopes: Array<SessionId | undefined> = [];
  let deferSessionAStatus = false;
  const sessions = [sessionSummary(sessionA), sessionSummary(sessionB)];
  const client = {
    listSessions: async () => sessions,
    sessionEvents: async (input: { sessionId: SessionId }) => [sessionCreatedEvent(input.sessionId)],
    streamEvents: async function* (input: { signal?: AbortSignal } = {}) {
      await waitForAbort(input.signal);
    },
    listModels: async () => [],
    getModelConfig: async (input: { sessionId: SessionId }) => runtimeModelConfig(input.sessionId, "model"),
    getDelegationConfig: async (input: { sessionId: SessionId }) => ({
      sessionId: input.sessionId,
      policy: "explicit" as const,
      source: "default" as const,
    }),
    getPermissionConfig: async () => ({ profile: "default" as const, profiles: [] }),
    listCommands: async () => emptyCommandCatalog(),
    mcpStatus: async (input: { sessionId?: SessionId } = {}) => {
      requestedStatusScopes.push(input.sessionId);
      if (input.sessionId === sessionA && deferSessionAStatus) return status.promise;
      return mcpStatusResponse(input.sessionId === sessionB ? "workspace-b" : "workspace-a");
    },
    mcpServer: async () => server.promise,
    reloadMcp: async () => reload.promise,
    listMcpTools: async () => tools.promise,
    addMcpServer: async () => add.promise,
    removeMcpServer: async () => remove.promise,
    authMcpServer: async () => auth.promise,
    logoutMcpServer: async () => logout.promise,
  } as unknown as HttpRuntimeClient;
  const options: TeamLiveTuiOptions = {
    baseUrl: "http://chili.test",
    cwd: "/workspace",
    sessionId: sessionA,
    runLoop: false,
    once: false,
  };
  let runtime: ChatRuntimeState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(createElement(ChatRuntimeProbe, {
      client,
      options,
      onRuntime: (value: ChatRuntimeState) => { runtime = value; },
    }), { width: 100, height: 4, exitOnCtrlC: false });
  });

  try {
    await waitForRuntime(app, () => (
      runtime?.activeSessionId === sessionA
      && runtime.mcpStatus?.servers[0]?.name === "workspace-a"
    ));

    deferSessionAStatus = true;
    let pending!: Array<Promise<unknown>>;
    await act(async () => {
      pending = [
        runtime!.refreshMcpStatus!(),
        runtime!.getMcpServer!("old-server"),
        runtime!.reloadMcp!(),
        runtime!.listMcpTools!("old-server"),
        runtime!.addMcpServer!({ name: "old-added-server" }),
        runtime!.removeMcpServer!("old-server"),
        runtime!.authMcpServer!("old-server"),
        runtime!.logoutMcpServer!("old-server"),
      ];
      await app.renderOnce();
    });

    let resumed = false;
    await act(async () => {
      resumed = await runtime!.resumeSession({ id: sessionB });
      await app.renderOnce();
    });
    expect(resumed).toBe(true);
    await waitForRuntime(app, () => runtime?.mcpStatus?.servers[0]?.name === "workspace-b");
    const statusRequestsAfterSwitch = requestedStatusScopes.length;

    status.reject(new Error("late MCP status failure from session A"));
    server.resolve(mcpServerDescriptor("late-server-a"));
    reload.resolve({ reloaded: true, servers: [mcpServerDescriptor("late-reload-a")], errors: [] });
    tools.resolve({ server: "old-server", tools: [] });
    add.resolve(mcpServerDescriptor("late-add-a"));
    remove.resolve({ server: "old-server", removed: true });
    auth.resolve({ server: "old-server", status: "authenticated" });
    logout.resolve({ server: "old-server", loggedOut: true });

    const results = await Promise.all(pending);
    await act(async () => {
      await Bun.sleep(10);
      await app.renderOnce();
    });

    expect(results).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(runtime?.activeSessionId).toBe(sessionB);
    expect(runtime?.mcpStatus?.servers[0]?.name).toBe("workspace-b");
    expect(runtime?.chatFeedback).toEqual({ status: "success", message: "saved chat resumed" });
    expect(requestedStatusScopes.length).toBe(statusRequestsAfterSwitch);
    expect(requestedStatusScopes.at(-1)).toBe(sessionB);
  } finally {
    act(() => app.renderer.destroy());
  }
});

test("a failed command-catalog load for the resumed session cannot retain a late catalog from the previous session", async () => {
  const sessionA = "session_command_catalog_a" as SessionId;
  const sessionB = "session_command_catalog_b" as SessionId;
  const catalogA = deferred<RuntimeCommandCatalog>();
  const catalogB = deferred<RuntimeCommandCatalog>();
  const requestedCatalogs: Array<SessionId | undefined> = [];
  const sessions = [sessionSummary(sessionA), sessionSummary(sessionB)];
  const client = {
    listSessions: async () => sessions,
    sessionEvents: async (input: { sessionId: SessionId }) => [sessionCreatedEvent(input.sessionId)],
    streamEvents: async function* (input: { signal?: AbortSignal } = {}) {
      await waitForAbort(input.signal);
    },
    listModels: async () => [],
    getModelConfig: async (input: { sessionId: SessionId }) => (
      runtimeModelConfig(input.sessionId, `model-${input.sessionId}`)
    ),
    getDelegationConfig: async (input: { sessionId: SessionId }) => ({
      sessionId: input.sessionId,
      policy: "explicit" as const,
      source: "default" as const,
    }),
    getPermissionConfig: async () => ({ profile: "default" as const, profiles: [] }),
    listCommands: async (input: { sessionId?: SessionId } = {}) => {
      requestedCatalogs.push(input.sessionId);
      if (input.sessionId === sessionA) return catalogA.promise;
      if (input.sessionId === sessionB) return catalogB.promise;
      return emptyCommandCatalog();
    },
    mcpStatus: async () => ({
      servers: [],
      summary: { total: 0, running: 0, disabled: 0, authRequired: 0, errored: 0 },
    }),
  } as unknown as HttpRuntimeClient;
  const options: TeamLiveTuiOptions = {
    baseUrl: "http://chili.test",
    cwd: "/workspace",
    sessionId: sessionA,
    runLoop: false,
    once: false,
  };
  let runtime: ChatRuntimeState | undefined;
  let app!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    app = await testRender(createElement(ChatRuntimeProbe, {
      client,
      options,
      onRuntime: (value: ChatRuntimeState) => { runtime = value; },
    }), { width: 100, height: 4, exitOnCtrlC: false });
  });

  try {
    await waitForRuntime(app, () => (
      runtime?.activeSessionId === sessionA && requestedCatalogs.includes(sessionA)
    ));

    let resumed = false;
    await act(async () => {
      resumed = await runtime!.resumeSession({ id: sessionB });
      await app.renderOnce();
    });
    expect(resumed).toBe(true);
    await waitForRuntime(app, () => requestedCatalogs.includes(sessionB));
    expect(runtime?.commandList).toBeUndefined();

    catalogB.reject(new Error("B command catalog unavailable"));
    await waitForRuntime(app, () => runtime?.chatFeedback?.message === "B command catalog unavailable");

    catalogA.resolve(commandCatalog("prompt.project.from-a"));
    await act(async () => {
      await Bun.sleep(10);
      await app.renderOnce();
    });

    expect(runtime?.activeSessionId).toBe(sessionB);
    expect(runtime?.commandList).toBeUndefined();
  } finally {
    act(() => app.renderer.destroy());
  }
});

function ChatRuntimeProbe(props: {
  client: HttpRuntimeClient;
  options: TeamLiveTuiOptions;
  onRuntime: (runtime: ChatRuntimeState) => void;
}) {
  const runtime = useChatRuntime({ client: props.client, options: props.options });
  props.onRuntime(runtime);
  return createElement(
    "text",
    null,
    `session:${runtime.activeSessionId ?? "none"} model:${runtime.modelConfig?.sessionId ?? "none"}`,
  );
}

function chatRuntimeClient(
  sessions: readonly RuntimeSessionSummary[],
  overrides: Record<string, unknown> = {},
): HttpRuntimeClient {
  return {
    listSessions: async () => sessions,
    sessionEvents: async (input: { sessionId: SessionId }) => {
      const session = sessions.find((candidate) => candidate.id === input.sessionId);
      return [sessionCreatedEvent(input.sessionId, session?.cwd)];
    },
    streamEvents: async function* (input: { signal?: AbortSignal } = {}) {
      await waitForAbort(input.signal);
    },
    listModels: async () => [],
    getModelConfig: async (input: { sessionId: SessionId }) => runtimeModelConfig(input.sessionId, "model"),
    getDelegationConfig: async (input: { sessionId: SessionId }) => ({
      sessionId: input.sessionId,
      policy: "explicit" as const,
      source: "default" as const,
    }),
    getPermissionConfig: async () => ({ profile: "default" as const, profiles: [] }),
    listCommands: async () => emptyCommandCatalog(),
    mcpStatus: async () => mcpStatusResponse(),
    ...overrides,
  } as unknown as HttpRuntimeClient;
}

function sessionSummary(id: SessionId, cwd = "/workspace"): RuntimeSessionSummary {
  return {
    id,
    cwd,
    source: "interactive",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  };
}

function sessionCreatedEvent(sessionId: SessionId, cwd = "/workspace"): ChiliEvent {
  return {
    id: `event_created_${sessionId}`,
    type: "session.created",
    time: 1 as TimestampMs,
    sessionId,
    payload: { sessionId, cwd },
  };
}

function runtimeModelConfig(sessionId: SessionId, model: string): RuntimeModelConfig {
  return {
    sessionId,
    models: [{ provider: "test", model }],
    availableReasoningLevels: ["off", "medium"],
    modelSelection: { provider: "test", model },
  };
}

function mcpStatusResponse(server?: string): RuntimeMcpStatusResponse {
  const servers = server
    ? [{ name: server, status: "running" as const, enabled: true }]
    : [];
  return {
    servers,
    summary: {
      total: servers.length,
      running: servers.length,
      disabled: 0,
      authRequired: 0,
      errored: 0,
    },
  };
}

function mcpServerDescriptor(name: string): RuntimeMcpServerDescriptor {
  return { name, status: "running", enabled: true };
}

function emptyCommandCatalog(): RuntimeCommandCatalog {
  return { roots: [], diagnostics: [] };
}

function commandCatalog(id: string): RuntimeCommandCatalog {
  return {
    roots: [{
      id,
      name: id,
      path: `/${id}`,
      title: id,
      description: id,
      group: "test",
      source: "project",
      argumentMode: "none",
      argumentHint: "",
      selectionMode: "execute",
      concurrency: "allow",
      hidden: false,
      enabled: true,
      executionTarget: "prompt",
      children: [],
    }],
    diagnostics: [],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitForRuntime(
  app: Awaited<ReturnType<typeof testRender>>,
  predicate: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await Bun.sleep(5);
      await app.renderOnce();
    });
  }
  throw new Error(`Timed out waiting for runtime state. Last frame:\n${app.captureCharFrame()}`);
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
