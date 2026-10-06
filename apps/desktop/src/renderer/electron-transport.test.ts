import { expect, test } from "bun:test";
import type {
  ChiliDesktopApi,
  DesktopRequest,
  DesktopResponse,
  DesktopState,
} from "../shared/contracts.js";
import { createElectronTransport } from "./electron-transport.js";

test("Agent transport preserves input receipts and binds controls to the parent project", async () => {
  const calls: DesktopRequest[] = [];
  const api = {
    invoke: async (request: DesktopRequest) => {
      calls.push(request);
      return { agentId: "child", ...(request.type === "agent.stop" ? {} : { inputId: "receipt" }) };
    },
    subscribe: () => () => undefined,
  } as ChiliDesktopApi;
  const transport = createElectronTransport(api, "project-a");
  expect(await transport.sendAgent("parent", "child", "Review", "steer")).toEqual({ agentId: "child", inputId: "receipt" });
  expect(await transport.stopAgent("parent", "child")).toEqual({ agentId: "child" });
  expect(await transport.resumeAgent("parent", "child")).toEqual({ agentId: "child", inputId: "receipt" });
  expect(calls).toEqual([
    { type: "agent.send", projectId: "project-a", sessionId: "parent", agentId: "child", text: "Review", mode: "steer" },
    { type: "agent.stop", projectId: "project-a", sessionId: "parent", agentId: "child" },
    { type: "agent.resume", projectId: "project-a", sessionId: "parent", agentId: "child" },
  ]);
});

test("binds every task operation to its project even after another transport activates a project", async () => {
  const calls: DesktopRequest[] = [];
  const api = { invoke: async (request: DesktopRequest) => { calls.push(request); return {}; }, subscribe: () => () => undefined } as ChiliDesktopApi;
  const host = createElectronTransport(api);
  const a = host.forProject!("project-a");
  const b = host.forProject!("project-b");
  await a.send("same-id", "A", "queue");
  await b.activateProject!("project-b");
  await a.setReasoning("same-id", "high");
  await b.stop("same-id");
  expect(calls.map((request) => request.projectId)).toEqual(["project-a", "project-b", "project-a", "project-b"]);
});

test("projection reads wait until workspace selection fully settles", async () => {
  const selection = deferred<DesktopState>();
  const calls: DesktopRequest[] = [];
  const state: DesktopState = {
    workspace: "/new",
    sidecar: { phase: "healthy", attempt: 0 },
    queuedBySession: {},
  };
  const api = {
    invoke: async <Request extends DesktopRequest>(request: Request): Promise<DesktopResponse<Request>> => {
      calls.push(request);
      if (request.type === "workspace.select") {
        return selection.promise as Promise<DesktopResponse<Request>>;
      }
      return responseFor(request, state) as DesktopResponse<Request>;
    },
    subscribe: () => () => undefined,
  } satisfies ChiliDesktopApi;
  const transport = createElectronTransport(api);

  const selecting = transport.selectWorkspace();
  const stateRead = transport.state();
  const sessionsRead = transport.listSessions();
  const snapshotRead = transport.snapshot("session_old");
  const diffRead = transport.diff("workspace", "session_old");
  await Promise.resolve();

  expect(await stateRead).toEqual(state);
  expect(calls.map((request) => request.type)).toEqual(["workspace.select", "app.state"]);

  selection.resolve(state);
  await selecting;
  await Promise.all([sessionsRead, snapshotRead, diffRead]);
  expect(calls.map((request) => request.type)).toEqual([
    "workspace.select",
    "app.state",
    "sessions.list",
    "session.snapshot",
    "diff.get",
  ]);
});

test("a failed workspace selection releases deferred projection reads", async () => {
  const selection = deferred<DesktopState>();
  const calls: DesktopRequest["type"][] = [];
  const state: DesktopState = {
    workspace: "/current",
    sidecar: { phase: "healthy", attempt: 0 },
    queuedBySession: {},
  };
  const api = {
    invoke: async <Request extends DesktopRequest>(request: Request): Promise<DesktopResponse<Request>> => {
      calls.push(request.type);
      if (request.type === "workspace.select") {
        return selection.promise as Promise<DesktopResponse<Request>>;
      }
      return responseFor(request, state) as DesktopResponse<Request>;
    },
    subscribe: () => () => undefined,
  } satisfies ChiliDesktopApi;
  const transport = createElectronTransport(api);

  const selecting = transport.selectWorkspace().catch((error: unknown) => error);
  const sessionsRead = transport.listSessions();
  selection.reject(new Error("picker failed"));

  expect(await selecting).toBeInstanceOf(Error);
  await expect(sessionsRead).resolves.toEqual([]);
  expect(calls).toEqual(["workspace.select", "sessions.list"]);
});

test("maps daily-driver task controls to explicit validated IPC requests", async () => {
  const calls: DesktopRequest[] = [];
  const api = {
    invoke: async <Request extends DesktopRequest>(request: Request): Promise<DesktopResponse<Request>> => {
      calls.push(request);
      return undefined as unknown as DesktopResponse<Request>;
    },
    subscribe: () => () => undefined,
  } satisfies ChiliDesktopApi;
  const transport = createElectronTransport(api);

  await transport.listSessions({ query: "overnight", status: "archived" });
  await transport.createSession({
    title: "Nightly console",
    prompt: "Finish the console",
    modelSelection: { provider: "openai-codex", model: "gpt-5.6-sol" },
    reasoningLevel: "high",
    serviceTier: "fast",
    permissionProfile: "auto-review",
    delegationPolicy: "proactive",
    goal: { objective: "Finish the console", tokenBudget: 75_000 },
  });
  await transport.resumeSession("session_goal");
  await transport.renameSession("session_goal", "Renamed");
  await transport.archiveSession("session_goal");
  await transport.setGoal("session_goal", "Keep going", 50_000);
  await transport.updateGoal("session_goal", { tokenBudget: 80_000, status: "active" });
  await transport.reloadMcp("session_goal");

  expect(calls).toEqual([
    { type: "sessions.list", query: "overnight", status: "archived" },
    {
      type: "sessions.create",
      title: "Nightly console",
      prompt: "Finish the console",
      modelSelection: { provider: "openai-codex", model: "gpt-5.6-sol" },
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionProfile: "auto-review",
      delegationPolicy: "proactive",
      goal: { objective: "Finish the console", tokenBudget: 75_000 },
    },
    { type: "session.resume", sessionId: "session_goal" },
    { type: "session.rename", sessionId: "session_goal", title: "Renamed" },
    { type: "session.archive", sessionId: "session_goal" },
    { type: "session.goal.set", sessionId: "session_goal", objective: "Keep going", tokenBudget: 50_000 },
    { type: "session.goal.update", sessionId: "session_goal", tokenBudget: 80_000, status: "active" },
    { type: "mcp.reload", sessionId: "session_goal" },
  ]);
});

function responseFor(request: DesktopRequest, state: DesktopState): unknown {
  if (request.type === "app.state") return state;
  if (request.type === "sessions.list") return [];
  if (request.type === "session.snapshot") {
    return {
      sessionId: request.sessionId,
      events: [],
      agents: [],
      pendingApprovals: [],
      pendingInputs: [],
    };
  }
  if (request.type === "diff.get") {
    return { scope: request.scope, text: "", truncated: false };
  }
  throw new Error(`Unexpected request: ${request.type}`);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("uncertain delivery retains submission ID across transport views until acknowledged", async () => {
  const calls: Extract<DesktopRequest, { type: "session.send" }>[] = [];
  const api = {
    invoke: async (request: DesktopRequest) => {
      if (request.type !== "session.send") throw new Error("Unexpected request");
      calls.push(request);
      if (calls.length === 1) throw new Error("Connection lost after commit");
      return { status: "accepted" };
    },
    subscribe: () => () => undefined,
  } as ChiliDesktopApi;
  const first = createElectronTransport(api, "stable-project");
  await expect(first.send("stable-session", "same content", "queue")).rejects.toThrow("Connection lost");
  const retry = createElectronTransport(api).forProject!("stable-project");
  await retry.send("stable-session", "same content", "queue");
  await retry.send("stable-session", "same content", "queue");
  expect(calls[0]!.submissionId).toBeTruthy();
  expect(calls[1]!.submissionId).toBe(calls[0]!.submissionId);
  expect(calls[2]!.submissionId).not.toBe(calls[0]!.submissionId);
});
