import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { ChiliEvent } from "@chili/protocol";
import type { RuntimeSessionSummary } from "@chili/sdk";
import type { DesktopEvent, DesktopProject, DesktopRequest, DesktopResponse, DesktopState } from "../shared/contracts.js";
import type { DesktopControlService } from "./control-service.js";
import type { SidecarManager } from "./sidecar-manager.js";
import { DesktopProjectSettings, type SavedDesktopProject } from "./project-settings.js";
import { projectRendererRuntimeEvent } from "./renderer-event-projection.js";

export interface DesktopProjectRuntime {
  sidecar: Pick<SidecarManager, "state" | "switchWorkspace" | "stop">;
  control: Pick<DesktopControlService, "invoke" | "beginShutdown" | "containMainProcesses" | "forceContainGitProcessGroups">;
}

interface ProjectEntry {
  saved: SavedDesktopProject;
  runtime?: DesktopProjectRuntime;
  tasks: DesktopProject["recentTasks"];
  tasksLoaded: boolean;
  running: Set<string>;
  inputs: Map<string, string>;
  refresh?: ReturnType<typeof setTimeout>;
  refreshing: boolean;
  refreshAgain: boolean;
}

export class DesktopProjectManager {
  private readonly entries = new Map<string, ProjectEntry>();
  private activeId: string | undefined;
  private selection: Promise<void> = Promise.resolve();
  private selecting = 0;
  private closing = false;

  constructor(private readonly options: {
    settings: DesktopProjectSettings;
    createRuntime(project: SavedDesktopProject): DesktopProjectRuntime;
    chooseDirectory(): Promise<string | undefined>;
    beforeActivate(): Promise<void>;
    activated(runtime: DesktopProjectRuntime): void;
    publish(event: DesktopEvent): void;
    resync(): void;
  }) {}

  async initialize(): Promise<void> {
    const saved = await this.options.settings.read();
    if (this.closing) return;
    for (const project of saved.projects) {
      const path = await realpath(project.path).catch(() => project.path);
      if (this.closing) return;
      const existing = [...this.entries.values()].find((entry) => entry.saved.path === path);
      if (!existing) this.entries.set(project.id, this.entry({ ...project, path }));
      if (project.id === saved.activeProjectId) this.activeId = existing?.saved.id ?? project.id;
    }
  }

  activeProjectId(): string | undefined { return this.activeId; }
  isSelecting(): boolean { return this.selecting > 0; }

  state(): DesktopState {
    const active = this.activeId ? this.entries.get(this.activeId) : undefined;
    const state = active?.runtime?.sidecar.state() ?? { sidecar: { phase: "idle" as const, attempt: 0 }, queuedBySession: {} };
    return {
      ...state,
      ...(active ? { projectId: active.saved.id, workspace: active.saved.path } : {}),
      projects: [...this.entries.values()].map((entry) => ({
        id: entry.saved.id, path: entry.saved.path, phase: entry.runtime?.sidecar.state().sidecar.phase ?? "idle",
        runningCount: entry.running.size, attentionCount: new Set(entry.inputs.values()).size,
        tasksLoaded: entry.tasksLoaded, recentTasks: entry.tasks,
      })),
    };
  }

  async invoke<Request extends DesktopRequest>(request: Request): Promise<DesktopResponse<Request>> {
    if (this.closing) throw new Error("Desktop is closing");
    if (request.type === "app.state") return this.state() as DesktopResponse<Request>;
    if (request.type === "workspace.select") {
      return this.serializeSelection(async () => {
        await this.options.beforeActivate();
        this.assertOpen();
        const directory = await this.options.chooseDirectory();
        this.assertOpen();
        return directory ? this.addInside(directory) : this.state();
      }) as Promise<DesktopResponse<Request>>;
    }
    if (request.type === "workspace.activate") return this.activate(request.id) as Promise<DesktopResponse<Request>>;
    const id = request.projectId ?? this.activeId;
    const runtime = id ? this.entries.get(id)?.runtime : undefined;
    if (!runtime) throw new Error("Open the project before using its tasks");
    // Capture the owner before awaiting; a later UI selection cannot redirect this request.
    const result = await runtime.control.invoke(request);
    if (request.type === "sessions.list") this.updateTasks(id!, result as RuntimeSessionSummary[]);
    return result;
  }

  add(directory: string): Promise<DesktopState> {
    return this.serializeSelection(() => this.addInside(directory));
  }

  activate(id: string): Promise<DesktopState> {
    return this.serializeSelection(() => this.activateInside(id));
  }

  observeState(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || this.closing) return;
    if (entry.runtime?.sidecar.state().sidecar.phase === "healthy") this.scheduleTasks(id);
    else { entry.running.clear(); entry.inputs.clear(); }
    this.publishState();
  }

  observeEvent(id: string, event: ChiliEvent): void {
    const entry = this.entries.get(id);
    if (!entry || this.closing) return;
    if (id === this.activeId) {
      // The sidecar has already advanced its durable cursor. Filter before the
      // renderer outbox allocates a sequence number, so ACKs stay contiguous.
      const projected = projectRendererRuntimeEvent(event);
      if (projected) this.options.publish({ type: "runtime.event", projectId: id, event: projected });
    }
    if (event.sessionId && event.type === "session.status_changed") {
      const sessionId = String(event.sessionId);
      if (["running", "waiting_for_approval", "cancelling"].includes(event.payload.status)) entry.running.add(sessionId);
      else entry.running.delete(sessionId);
      this.publishState();
    }
    if (event.sessionId && event.type === "user_input.requested") {
      entry.inputs.set(String(event.payload.inputId), String(event.sessionId));
      this.publishState();
    }
    if (event.sessionId && (event.type === "user_input.resolved" || event.type === "user_input.cancelled")) {
      entry.inputs.delete(String(event.payload.inputId));
      this.publishState();
    }
    if (event.type.startsWith("session.") || event.type === "turn.completed") this.scheduleTasks(id);
  }

  observeQueue(id: string, sessionId: string, count: number): void {
    if (!this.closing && id === this.activeId) this.options.publish({ type: "queue.changed", projectId: id, sessionId, count });
  }

  beginShutdown(): void {
    this.closing = true;
    for (const entry of this.entries.values()) {
      if (entry.refresh) clearTimeout(entry.refresh);
      entry.runtime?.control.beginShutdown();
    }
  }

  async stop(): Promise<void> {
    this.beginShutdown();
    // Start every containment owner together, including background projects.
    const results = await Promise.allSettled([...this.entries.values()].flatMap(({ runtime }) => runtime
      ? [runtime.sidecar.stop(), runtime.control.containMainProcesses()] : []));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Project process containment failed");
  }

  forceContainGitProcessGroups(): void {
    for (const entry of this.entries.values()) entry.runtime?.control.forceContainGitProcessGroups();
  }

  private async addInside(directory: string): Promise<DesktopState> {
    const path = await realpath(directory);
    if (!(await stat(path)).isDirectory()) throw new Error("Choose a project directory");
    this.assertOpen();
    let entry = [...this.entries.values()].find((entry) => entry.saved.path === path);
    const newlyAdded = !entry;
    if (!entry) {
      if (this.entries.size >= 64) throw new Error("Up to 64 projects can be saved");
      entry = this.entry({ id: randomUUID(), path });
      this.entries.set(entry.saved.id, entry);
    }
    try {
      return await this.activateInside(entry.saved.id);
    } catch (error) {
      // A failed settings write must not leave an unsaved, unusable project.
      if (newlyAdded && !entry.runtime && this.activeId !== entry.saved.id) this.entries.delete(entry.saved.id);
      throw error;
    }
  }

  private async activateInside(id: string): Promise<DesktopState> {
    this.assertOpen();
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Project is no longer available");
    if (id === this.activeId && entry.runtime?.sidecar.state().sidecar.phase === "healthy") return this.state();
    await this.options.beforeActivate();
    this.assertOpen();
    await this.options.settings.write({ projects: [...this.entries.values()].map((entry) => entry.saved), activeProjectId: id });
    this.assertOpen();
    entry.runtime ??= this.options.createRuntime(entry.saved);
    this.activeId = id;
    this.options.activated(entry.runtime);
    this.publishState();
    try {
      // Each SidecarManager only ever owns this one directory. Re-selecting a
      // healthy project reuses its process and queues without stopping either.
      await entry.runtime.sidecar.switchWorkspace(entry.saved.path);
    } finally {
      if (!this.closing) {
        this.publishState();
        this.options.resync();
        this.scheduleTasks(id);
      }
    }
    return this.state();
  }

  private serializeSelection<T>(operation: () => Promise<T>): Promise<T> {
    this.selecting += 1;
    const next = this.selection.then(() => { this.assertOpen(); return operation(); });
    this.selection = next.then(() => undefined, () => undefined);
    return next.finally(() => { this.selecting -= 1; });
  }

  private assertOpen(): void { if (this.closing) throw new Error("Desktop is closing"); }
  private entry(saved: SavedDesktopProject): ProjectEntry {
    return { saved, tasks: [], tasksLoaded: false, running: new Set(), inputs: new Map(), refreshing: false, refreshAgain: false };
  }
  private publishState(): void { if (!this.closing) this.options.publish({ type: "state.changed", state: this.state() }); }

  private scheduleTasks(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || this.closing || entry.refresh) return;
    if (entry.refreshing) { entry.refreshAgain = true; return; }
    entry.refresh = setTimeout(() => {
      delete entry.refresh;
      if (!entry.runtime || this.closing || entry.runtime.sidecar.state().sidecar.phase !== "healthy") return;
      entry.refreshing = true;
      void entry.runtime.control.invoke({ type: "sessions.list", status: "all" })
        .then((sessions) => this.updateTasks(id, sessions))
        .catch(() => undefined)
        .finally(() => {
          entry.refreshing = false;
          if (entry.refreshAgain) { entry.refreshAgain = false; this.scheduleTasks(id); }
        });
    }, 150);
  }

  private updateTasks(id: string, sessions: RuntimeSessionSummary[]): void {
    const entry = this.entries.get(id);
    if (!entry || this.closing) return;
    const tasks = sessions.filter((session) => !session.agent)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
      .map((session) => ({ id: String(session.id), title: (session.title || session.preview || "Untitled task").slice(0, 160),
        status: session.status, updatedAt: session.updatedAt }));
    if (entry.tasksLoaded && JSON.stringify(tasks) === JSON.stringify(entry.tasks)) return;
    entry.tasks = tasks;
    entry.tasksLoaded = true;
    this.publishState();
  }
}
