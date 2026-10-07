import type { ChiliEvent, RuntimeInputQueue, RuntimeSessionStatus } from "@chili/protocol";
import type { RuntimeSnapshot } from "../shared/contracts.js";
import type { SessionActivityInput } from "./sidebar-status.js";

interface SessionActivityRecord {
  status?: RuntimeSessionStatus;
  statusEventId?: string;
  archived: boolean;
  queue?: Pick<RuntimeInputQueue, "revision" | "paused" | "pendingCount">;
  pendingInputs: Set<string>;
  settledInputs: Set<string>;
  seenEvents: Set<string>;
}

/** A compact activity projection; message bodies, tool arguments and input text are never retained. */
export class SidebarActivityMemory {
  private readonly projects = new Map<string, Map<string, SessionActivityRecord>>();

  ingest(projectKey: string | undefined, event: ChiliEvent): void {
    if (!projectKey || !event.sessionId || !isActivityEvent(event)) return;
    if ("sessionId" in event.payload && event.payload.sessionId !== event.sessionId) return;
    const state = this.session(projectKey, event.sessionId);
    if (state.seenEvents.has(event.id)) return;
    state.seenEvents.add(event.id);
    switch (event.type) {
      case "session.created":
        state.status ??= "idle";
        break;
      case "session.status_changed":
        if (state.archived) break;
        // The event stream carries durable ordering; wall-clock timestamps can move backwards.
        updateStatus(state, event);
        break;
      case "session.archived":
        state.archived = true;
        clearPendingInputs(state);
        break;
      case "session.input_queue_changed":
        updateQueue(state, event.payload);
        break;
      case "user_input.requested":
        if (!state.archived && !state.settledInputs.has(event.payload.inputId)) {
          state.pendingInputs.add(event.payload.inputId);
        }
        break;
      case "user_input.resolved":
      case "user_input.cancelled":
        state.pendingInputs.delete(event.payload.inputId);
        state.settledInputs.add(event.payload.inputId);
        break;
    }
  }

  /** Call with the accepted snapshot, whose pending-input list replaces historical requests. */
  seed(projectKey: string | undefined, snapshot: RuntimeSnapshot): void {
    if (!projectKey) return;
    const scope = new Set([snapshot.sessionId, ...snapshot.agents.map((agent) => agent.agentId)]);
    const statuses = new Map<string, { latest: StatusEvent; ids: Set<string> }>();
    for (const event of snapshot.events) {
      if (event.sessionId) scope.add(event.sessionId);
      if (event.type === "session.status_changed") {
        if (!event.sessionId || event.payload.sessionId !== event.sessionId) continue;
        const history = statuses.get(event.sessionId) ?? { latest: event, ids: new Set<string>() };
        history.latest = event;
        history.ids.add(event.id);
        statuses.set(event.sessionId, history);
        this.session(projectKey, event.sessionId).seenEvents.add(event.id);
        continue;
      }
      this.ingest(projectKey, event);
    }
    for (const [sessionId, history] of statuses) {
      const state = this.session(projectKey, sessionId);
      // Apply the final durable status once. A live status absent from this
      // snapshot arrived after its capture and must survive hydration.
      if (!state.archived && (!state.statusEventId || history.ids.has(state.statusEventId))) {
        updateStatus(state, history.latest);
      }
    }
    if (snapshot.inputQueue?.sessionId === snapshot.sessionId) {
      updateQueue(this.session(projectKey, snapshot.sessionId), snapshot.inputQueue);
    }
    for (const input of snapshot.pendingInputs) scope.add(input.sessionId);
    for (const sessionId of scope) this.session(projectKey, sessionId).pendingInputs.clear();
    for (const input of snapshot.pendingInputs) {
      const state = this.session(projectKey, input.sessionId);
      if (!state.archived && !state.settledInputs.has(input.id)) state.pendingInputs.add(input.id);
    }
  }

  read(projectKey: string | undefined, sessionId: string): SessionActivityInput {
    const state = projectKey ? this.projects.get(projectKey)?.get(sessionId) : undefined;
    if (!state) return {};
    return {
      ...(state.status ? { status: state.status } : {}),
      ...(state.queue ? { paused: state.queue.paused, queuedCount: state.queue.pendingCount } : {}),
      archived: state.archived,
      pendingInput: state.pendingInputs.size > 0,
    };
  }

  private session(projectKey: string, sessionId: string): SessionActivityRecord {
    let project = this.projects.get(projectKey);
    if (!project) {
      project = new Map();
      this.projects.set(projectKey, project);
    }
    let state = project.get(sessionId);
    if (!state) {
      state = { archived: false, pendingInputs: new Set(), settledInputs: new Set(), seenEvents: new Set() };
      project.set(sessionId, state);
    }
    return state;
  }
}

type ActivityEvent = Extract<ChiliEvent, {
  type: "session.created" | "session.status_changed" | "session.archived" | "session.input_queue_changed"
    | "user_input.requested" | "user_input.resolved" | "user_input.cancelled";
}>;
type StatusEvent = Extract<ChiliEvent, { type: "session.status_changed" }>;

function isActivityEvent(event: ChiliEvent): event is ActivityEvent {
  return event.type === "session.created" || event.type === "session.status_changed"
    || event.type === "session.archived" || event.type === "session.input_queue_changed"
    || event.type === "user_input.requested" || event.type === "user_input.resolved" || event.type === "user_input.cancelled";
}

function updateQueue(state: SessionActivityRecord, queue: RuntimeInputQueue): void {
  if (state.queue && queue.revision <= state.queue.revision) return;
  state.queue = { revision: queue.revision, paused: queue.paused, pendingCount: queue.pendingCount };
}

function updateStatus(state: SessionActivityRecord, event: StatusEvent): void {
  state.status = event.payload.status;
  state.statusEventId = event.id;
  if (isTerminalStatus(state.status)) clearPendingInputs(state);
}

function isTerminalStatus(status: RuntimeSessionStatus): boolean {
  return status === "idle" || status === "cancelled" || status === "failed";
}

function clearPendingInputs(state: SessionActivityRecord): void {
  for (const inputId of state.pendingInputs) state.settledInputs.add(inputId);
  state.pendingInputs.clear();
}
