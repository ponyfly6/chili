import { expect, test } from "bun:test";
import type {
  ChiliDesktopApi,
  DesktopRequest,
  DesktopResponse,
  DesktopState,
} from "../shared/contracts.js";
import { createElectronTransport } from "./electron-transport.js";

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

function responseFor(request: DesktopRequest, state: DesktopState): unknown {
  if (request.type === "app.state") return state;
  if (request.type === "sessions.list") return [];
  if (request.type === "session.snapshot") {
    return {
      sessionId: request.sessionId,
      events: [],
      agentTree: { nodes: [], agents: [], tasks: [], mailbox: [] },
      tasks: [],
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
