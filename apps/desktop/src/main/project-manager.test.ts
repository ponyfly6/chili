import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseChiliEvent, type ChiliEvent } from "@chili/protocol";
import type { DesktopEvent, DesktopRequest, DesktopResponse, DesktopState } from "../shared/contracts.js";
import { DesktopProjectManager, type DesktopProjectRuntime } from "./project-manager.js";
import { DesktopProjectSettings } from "./project-settings.js";

test("keeps both project runtimes alive and routes captured requests to their owner", async () => {
  const f = await fixture();
  try {
    const a = await f.manager.add(f.a);
    const aRuntime = f.runtimes.get(a.projectId!)!;
    const pending = aRuntime.holdNextRequest();
    const send = f.manager.invoke({ type: "session.send", projectId: a.projectId!, sessionId: "same-id", text: "A only", mode: "queue" });
    const b = await f.manager.add(f.b);
    expect(aRuntime.stops).toBe(0);
    pending.resolve();
    await send;
    await f.manager.invoke({ type: "session.send", projectId: b.projectId!, sessionId: "same-id", text: "B only", mode: "queue" });
    expect(aRuntime.calls.filter((request) => request.type === "session.send")).toHaveLength(1);
    expect(f.runtimes.get(b.projectId!)!.calls.filter((request) => request.type === "session.send")).toHaveLength(1);
    await f.manager.activate(a.projectId!);
    expect(f.runtimes.size).toBe(2);
    expect(aRuntime.starts).toBe(1);
    expect(f.runtimes.get(b.projectId!)!.stops).toBe(0);
    await expect(f.manager.invoke({ type: "sessions.list", projectId: "unknown" })).rejects.toThrow("Open the project");
  } finally { await f.close(); }
});

test("background status appears in the project list without entering the active timeline", async () => {
  const f = await fixture();
  try {
    const a = await f.manager.add(f.a);
    const b = await f.manager.add(f.b);
    f.events.length = 0;
    f.manager.observeEvent(a.projectId!, statusEvent("session-a", "running"));
    f.manager.observeEvent(a.projectId!, statusEvent("session-a", "waiting_for_approval"));
    expect(f.manager.state().projectId).toBe(b.projectId);
    expect(f.manager.state().projects?.find((project) => project.id === a.projectId)).toMatchObject({ runningCount: 1, attentionCount: 0 });
    expect(f.events.filter((event) => event.type === "runtime.event")).toHaveLength(0);
    f.manager.observeEvent(b.projectId!, statusEvent("session-b", "running"));
    expect(f.events.filter((event) => event.type === "runtime.event")).toMatchObject([{ projectId: b.projectId }]);
    f.manager.observeEvent(a.projectId!, statusEvent("session-a", "idle"));
    expect(f.manager.state().projects?.find((project) => project.id === a.projectId)).toMatchObject({ runningCount: 0, attentionCount: 0 });
  } finally { await f.close(); }
});

test("publishes display-safe Agent creation and subsequent status without execution identity events", async () => {
  const f = await fixture();
  try {
    const project = await f.manager.add(f.a);
    const identity = {
      profileId: "profile_fixture",
      profilePath: "/private/chili-profile-canary",
      authPath: "/private/chili-profile-canary/auth.json",
      projectId: "project_fixture",
      projectRoot: "/private/source-checkout-canary",
      workspaceId: "workspace_fixture",
      workspaceRoot: f.a,
    };
    const agent = { parentSessionId: "session_root", name: "reader", path: "/root/reader", policy: {} };
    const created = parseChiliEvent({
      id: "event_agent_created", type: "session.created", sessionId: "session_agent", time: 1,
      payload: { sessionId: "session_agent", cwd: f.a, identity, agent },
    });
    const bound = parseChiliEvent({
      id: "event_identity_bound", type: "session.identity_bound", sessionId: "session_agent", time: 2,
      payload: { sessionId: "session_agent", identity },
    });
    const status = parseChiliEvent({
      id: "event_agent_running", type: "session.status_changed", sessionId: "session_agent", time: 3,
      payload: { sessionId: "session_agent", status: "running" },
    });
    const originalCreated = structuredClone(created);
    const originalBound = structuredClone(bound);
    f.events.length = 0;

    f.manager.observeEvent(project.projectId!, created);
    f.manager.observeEvent(project.projectId!, bound);
    f.manager.observeEvent(project.projectId!, status);

    const published = f.events.filter((event) => event.type === "runtime.event");
    expect<unknown>(published).toEqual([
      {
        type: "runtime.event", projectId: project.projectId!,
        event: { ...created, payload: { sessionId: "session_agent", cwd: f.a, agent } },
      },
      { type: "runtime.event", projectId: project.projectId!, event: status },
    ]);
    expect(published[0]?.event.payload).not.toHaveProperty("identity");
    const rendererEvents = JSON.stringify(f.events);
    expect(rendererEvents).not.toContain(identity.profilePath);
    expect(rendererEvents).not.toContain(identity.authPath);
    expect(rendererEvents).not.toContain(identity.projectRoot);
    expect(created).toEqual(originalCreated);
    expect(bound).toEqual(originalBound);
    expect(created.payload).toHaveProperty("identity", identity);
  } finally { await f.close(); }
});

test("saves multiple projects and selection, reuses canonical paths, and restores lazily", async () => {
  const f = await fixture();
  try {
    const a = await f.manager.add(f.a);
    const alias = join(f.directory, "alias-a");
    await symlink(f.a, alias);
    expect((await f.manager.add(alias)).projectId).toBe(a.projectId);
    const b = await f.manager.add(f.b);
    const saved = await f.settings.read();
    expect(saved.projects).toHaveLength(2);
    expect(saved.activeProjectId).toBe(b.projectId);
    expect(JSON.parse(await readFile(f.settingsPath, "utf8")).workspace).toBe(f.b);
    const restored = f.makeManager();
    await restored.initialize();
    expect(restored.state().projects).toHaveLength(2);
    expect(restored.state().projectId).toBe(b.projectId);
    expect(restored.state().projects?.every((project) => project.phase === "idle")).toBe(true);
    await restored.stop();
  } finally { await f.close(); }
});

test("migrates the previous single-workspace settings without losing its directory", async () => {
  const f = await fixture();
  try {
    await writeFile(f.settingsPath, JSON.stringify({ workspace: f.a }));
    const restored = f.makeManager();
    await restored.initialize();
    const id = restored.activeProjectId()!;
    expect(restored.state().workspace).toBe(f.a);
    await restored.activate(id);
    await restored.add(f.b);
    expect((await f.settings.read()).projects.map((project) => project.path)).toEqual([f.a, f.b]);
    await restored.stop();
  } finally { await f.close(); }
});

test("a failed project launch does not stop an existing project", async () => {
  const f = await fixture();
  try {
    const a = await f.manager.add(f.a);
    f.failPath = f.b;
    await expect(f.manager.add(f.b)).rejects.toThrow("fixture launch failure");
    expect(f.runtimes.get(a.projectId!)!.stops).toBe(0);
    expect(f.manager.state().sidecar.phase).toBe("error");
    await f.manager.activate(a.projectId!);
    expect(f.manager.state().sidecar.phase).toBe("healthy");
    expect(f.runtimes.get(a.projectId!)!.starts).toBe(1);
  } finally { await f.close(); }
});

test("a failed settings write keeps the existing project selected without a phantom new project", async () => {
  const f = await fixture();
  try {
    const a = await f.manager.add(f.a);
    f.settings.write = async () => { throw new Error("fixture disk failure"); };
    await expect(f.manager.add(f.b)).rejects.toThrow("fixture disk failure");
    expect(f.manager.state().projectId).toBe(a.projectId);
    expect(f.manager.state().projects).toHaveLength(1);
    expect(f.runtimes.size).toBe(1);
    expect(f.runtimes.get(a.projectId!)!.stops).toBe(0);
  } finally { await f.close(); }
});

test("resolving one background input keeps other inputs visible without requesting legacy approval", async () => {
  const f = await fixture();
  try {
    const a = await f.manager.add(f.a);
    await f.manager.add(f.b);
    const input = (type: string, inputId: string) => ({ id: `${type}-${inputId}`, type, sessionId: "session-a",
      time: 1, payload: { inputId } }) as ChiliEvent;
    f.manager.observeEvent(a.projectId!, input("user_input.requested", "one"));
    f.manager.observeEvent(a.projectId!, input("user_input.requested", "two"));
    f.manager.observeEvent(a.projectId!, input("user_input.resolved", "one"));
    const count = () => f.manager.state().projects?.find((project) => project.id === a.projectId)?.attentionCount;
    expect(count()).toBe(1);
    f.manager.observeEvent(a.projectId!, statusEvent("session-a", "waiting_for_approval"));
    f.manager.observeEvent(a.projectId!, input("user_input.cancelled", "two"));
    expect(count()).toBe(0);
    f.manager.observeEvent(a.projectId!, statusEvent("session-a", "idle"));
    expect(count()).toBe(0);
  } finally { await f.close(); }
});

test("shutdown contains all projects and refuses a directory picker that returns late", async () => {
  const f = await fixture();
  try {
    await f.manager.add(f.a);
    await f.manager.add(f.b);
    const picker = deferred<string | undefined>();
    f.choose = () => picker.promise;
    const selecting = f.manager.invoke({ type: "workspace.select" });
    await Promise.resolve();
    await f.manager.stop();
    picker.resolve(f.a);
    await expect(selecting).rejects.toThrow("Desktop is closing");
    for (const runtime of f.runtimes.values()) {
      expect(runtime.stops).toBeGreaterThan(0);
      expect(runtime.containments).toBeGreaterThan(0);
    }
    await expect(f.manager.add(f.a)).rejects.toThrow("Desktop is closing");
  } finally { await f.close(); }
});

test("rapid selections serialize and canceling the picker preserves the active project", async () => {
  const f = await fixture();
  try {
    const a = await f.manager.add(f.a);
    const b = await f.manager.add(f.b);
    await Promise.all([f.manager.activate(a.projectId!), f.manager.activate(b.projectId!)]);
    expect(f.manager.activeProjectId()).toBe(b.projectId);
    f.choose = async () => undefined;
    expect((await f.manager.invoke({ type: "workspace.select" })).projectId).toBe(b.projectId);
    expect(f.manager.isSelecting()).toBe(false);
  } finally { await f.close(); }
});

class FakeRuntime implements DesktopProjectRuntime {
  starts = 0;
  stops = 0;
  containments = 0;
  calls: DesktopRequest[] = [];
  private state: DesktopState = { sidecar: { phase: "idle", attempt: 0 }, queuedBySession: {} };
  private held: Promise<void> | undefined;
  constructor(private readonly fail: boolean) {}
  holdNextRequest() { const held = deferred<void>(); this.held = held.promise; return held; }
  sidecar = {
    state: () => this.state,
    switchWorkspace: async (path: string) => {
      if (this.state.workspace === path && this.state.sidecar.phase === "healthy") return;
      this.starts += 1;
      this.state = { workspace: path, sidecar: { phase: this.fail ? "error" : "healthy", attempt: 0 }, queuedBySession: {} };
      if (this.fail) throw new Error("fixture launch failure");
    },
    stop: async () => { this.stops += 1; },
  };
  control = {
    invoke: async <Request extends DesktopRequest>(request: Request): Promise<DesktopResponse<Request>> => {
      this.calls.push(request);
      if (this.held) { const held = this.held; this.held = undefined; await held; }
      return (request.type === "sessions.list" ? [] : { status: "accepted" }) as DesktopResponse<Request>;
    },
    beginShutdown: () => undefined,
    containMainProcesses: async () => { this.containments += 1; },
    forceContainGitProcessGroups: () => undefined,
  };
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "chili-projects-")));
  const a = join(directory, "project-a");
  const b = join(directory, "project-b");
  await Promise.all([mkdir(a), mkdir(b)]);
  const settingsPath = join(directory, "desktop-state.json");
  const settings = new DesktopProjectSettings(settingsPath);
  const events: DesktopEvent[] = [];
  const runtimes = new Map<string, FakeRuntime>();
  const config = { failPath: "", choose: async (): Promise<string | undefined> => undefined };
  const makeManager = () => new DesktopProjectManager({
    settings, chooseDirectory: () => config.choose(), beforeActivate: async () => undefined,
    activated: () => undefined, publish: (event) => events.push(event), resync: () => undefined,
    createRuntime: (project) => {
      const runtime = new FakeRuntime(project.path === config.failPath);
      runtimes.set(project.id, runtime);
      return runtime;
    },
  });
  const manager = makeManager();
  await manager.initialize();
  return {
    directory, a, b, manager, runtimes, settings, settingsPath, events, makeManager,
    set failPath(value: string) { config.failPath = value; },
    set choose(value: () => Promise<string | undefined>) { config.choose = value; },
    close: async () => { await manager.stop(); await rm(directory, { recursive: true, force: true }); },
  };
}

function statusEvent(sessionId: string, status: string): ChiliEvent {
  return { id: `${sessionId}-${status}`, type: "session.status_changed", sessionId, time: Date.now(), payload: { status } } as ChiliEvent;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
