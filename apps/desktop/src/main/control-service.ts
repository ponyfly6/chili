import type { ChiliEvent, SessionId } from "@chili/protocol";
import { reduceRuntimeEvents, ReplayableRuntimeEventWindowAccumulator } from "@chili/sdk";
import type {
  RuntimeAgentMailboxRecord,
  RuntimeAgentRunRecord,
  RuntimeAgentTaskRecord,
  RuntimeAgentTreeNode,
  RuntimeAgentTreeSnapshot,
  RuntimeClient,
  RuntimePendingApprovalRequest,
} from "@chili/sdk";
import type { DesktopRequest, DesktopResponse, DesktopState, SendMode } from "../shared/contracts.js";
import { DetachedProcessGroupRegistry } from "./detached-process-group-registry.js";
import { desktopDiff } from "./git-diff.js";
import type { SidecarManager } from "./sidecar-manager.js";

interface QueuedPrompt {
  text: string;
  mode: SendMode;
  bytes: number;
}

interface BusySessionState {
  controlEpoch: number;
  sidecarGeneration: number;
  awaitingTurnStart: boolean;
  baselineEventIds: Set<string>;
}

interface ClientLease {
  client: RuntimeClient;
  controlEpoch: number;
  sidecarGeneration: number;
  signal: AbortSignal;
}

export interface DesktopControlServiceOptions {
  sidecar: SidecarManager;
  selectWorkspace(): Promise<string | undefined>;
  persistWorkspace(workspace: string): Promise<void>;
  emitQueue(sessionId: string, count: number): void;
  onError(error: Error): void;
  processGroups?: DetachedProcessGroupRegistry;
}

const MAX_PENDING_SENDS_PER_SESSION = 8;
const MAX_PENDING_SENDS_GLOBAL = 64;
const MAX_PENDING_STOPS_PER_SESSION = 2;
const MAX_PENDING_STOPS_GLOBAL = 16;
const MAX_QUEUED_PROMPTS_PER_SESSION = 64;
const MAX_QUEUED_PROMPTS_GLOBAL = 256;
const MAX_QUEUED_PROMPT_BYTES_PER_SESSION = 2_000_000;
const MAX_QUEUED_PROMPT_BYTES_GLOBAL = 8_000_000;

type SessionActorAdmission = "internal" | "send" | "stop";

export class DesktopControlService {
  private readonly queues = new Map<string, QueuedPrompt[]>();
  private readonly queuedBytesBySession = new Map<string, number>();
  private readonly busySessions = new Map<string, BusySessionState>();
  private readonly flushingSessions = new Map<string, ClientLease>();
  private readonly sessionActors = new Map<string, Promise<void>>();
  private workspaceActor: Promise<void> = Promise.resolve();
  private readonly observedEventIds = new Map<string, Set<string>>();
  private controlEpoch = 0;
  private controlEpochController = new AbortController();
  private switchingWorkspace = false;
  private workspaceSelectionsPending = 0;
  private closing = false;
  private queuedPromptCount = 0;
  private queuedPromptBytes = 0;
  private pendingSendOperations = 0;
  private pendingStopOperations = 0;
  private readonly pendingSendsBySession = new Map<string, number>();
  private readonly pendingStopsBySession = new Map<string, number>();
  private readonly mainProcessGroups: DetachedProcessGroupRegistry;
  private mainProcessContainment: Promise<void> | undefined;

  constructor(private readonly options: DesktopControlServiceOptions) {
    this.mainProcessGroups = options.processGroups ?? new DetachedProcessGroupRegistry();
  }

  async invoke<Request extends DesktopRequest>(request: Request): Promise<DesktopResponse<Request>> {
    if (this.closing) {
      const fallback = this.closingResponse(request);
      if (fallback !== undefined) return fallback as DesktopResponse<Request>;
      throw new Error("Desktop is closing");
    }
    try {
      const response = await this.dispatch(request);
      return response as DesktopResponse<Request>;
    } catch (error) {
      const fallback = this.closingResponse(request);
      if (fallback !== undefined) return fallback as DesktopResponse<Request>;
      throw error;
    }
  }

  beginShutdown(): void {
    if (this.closing) return;
    this.closing = true;
    this.controlEpochController.abort(new Error("Desktop is closing"));
    this.mainProcessContainment = this.mainProcessGroups.close();
    void this.mainProcessContainment.catch(() => undefined);
  }

  containMainProcesses(): Promise<void> {
    this.beginShutdown();
    return this.mainProcessContainment ?? this.mainProcessGroups.close();
  }

  close(): Promise<void> {
    return this.containMainProcesses();
  }

  forceContainGitProcessGroups(): void {
    this.beginShutdown();
    this.mainProcessGroups.forceKillAll();
  }

  activeGitProcessGroupIdsForSmoke(): readonly number[] {
    return this.mainProcessGroups.activeProcessGroupIds();
  }

  observeEvent(event: ChiliEvent, sidecarGeneration: number): void {
    if (this.closing) return;
    const sessionId = event.sessionId;
    if (!sessionId) return;
    const controlEpoch = this.controlEpoch;
    void this.withSessionActor(sessionId, async () => {
      if (!this.isCurrentEpoch(controlEpoch, sidecarGeneration)) return;
      this.recordObservedEvent(sessionId, event.id);
      const current = this.busySessions.get(sessionId);
      if (event.type === "turn.started") {
        if (!current || !current.baselineEventIds.has(event.id)) {
          this.busySessions.set(sessionId, {
            controlEpoch,
            sidecarGeneration,
            awaitingTurnStart: false,
            baselineEventIds: new Set(this.observedEventIds.get(sessionId)),
          });
        }
        return;
      }
      if (event.type !== "session.status_changed") return;
      if (
        event.payload.status === "running"
        || event.payload.status === "waiting_for_approval"
        || event.payload.status === "cancelling"
      ) {
        if (!current) {
          this.busySessions.set(sessionId, {
            controlEpoch,
            sidecarGeneration,
            awaitingTurnStart: false,
            baselineEventIds: new Set(this.observedEventIds.get(sessionId)),
          });
        }
        return;
      }
      if (current?.awaitingTurnStart && current.baselineEventIds.has(event.id)) return;
      this.busySessions.delete(sessionId);
      const lease = this.tryCaptureClientLease(controlEpoch, sidecarGeneration);
      if (lease) await this.flushInsideActor(sessionId, lease);
    });
  }

  observeState(state: DesktopState, sidecarGeneration: number): void {
    if (this.closing || state.sidecar.phase !== "healthy") return;
    const controlEpoch = this.controlEpoch;
    for (const sessionId of this.queues.keys()) {
      void this.withSessionActor(sessionId, async () => {
        const lease = this.tryCaptureClientLease(controlEpoch, sidecarGeneration);
        if (lease) await this.flushInsideActor(sessionId, lease);
      });
    }
  }

  clearQueues(): void {
    for (const sessionId of this.queues.keys()) this.updateQueueCount(sessionId, 0);
    this.queues.clear();
    this.queuedBytesBySession.clear();
    this.queuedPromptCount = 0;
    this.queuedPromptBytes = 0;
    this.busySessions.clear();
    this.flushingSessions.clear();
    this.observedEventIds.clear();
  }

  private closingResponse(request: DesktopRequest): unknown {
    if (!this.closing) return undefined;
    if (request.type === "app.state") return this.options.sidecar.state();
    if (request.type === "sessions.list") return [];
    if (request.type === "session.snapshot") {
      return {
        sessionId: request.sessionId,
        events: [],
        agentTree: { nodes: [], agents: [], tasks: [], mailbox: [] },
        tasks: [],
        pendingApprovals: [],
        pendingInputs: [],
        truncated: true,
        warning: "Desktop is closing; the live snapshot was released.",
      };
    }
    if (request.type === "diff.get") {
      return { scope: request.scope, text: "Desktop is closing.", truncated: false };
    }
    return undefined;
  }

  private async dispatch(request: DesktopRequest): Promise<unknown> {
    if (request.type === "app.state") return this.options.sidecar.state();
    if (request.type === "workspace.select") {
      this.workspaceSelectionsPending += 1;
      try {
        return await this.withWorkspaceActor(() => this.selectWorkspace());
      } finally {
        this.workspaceSelectionsPending -= 1;
      }
    }

    if (this.workspaceSelectionsPending > 0) throw new Error("Workspace selection is in progress");

    if (request.type === "sessions.list") {
      const lease = this.captureClientLease();
      const sessions = await lease.client.listSessions();
      this.assertClientLease(lease);
      return sessions.filter((session) => session.source !== "subagent");
    }
    if (request.type === "sessions.create") {
      const lease = this.captureClientLease();
      const cwd = this.requireWorkspace();
      const created = await lease.client.createSession({ cwd, signal: lease.signal });
      this.assertClientLease(lease);
      return created;
    }
    if (request.type === "session.snapshot") {
      return this.sessionSnapshot(request.sessionId as SessionId, this.captureClientLease());
    }
    if (request.type === "session.send") {
      const lease = this.captureClientLease();
      return this.withSessionActor(
        request.sessionId,
        () => this.send(request.sessionId, request.text, request.mode, lease),
        "send",
      );
    }
    if (request.type === "session.stop") {
      const lease = this.captureClientLease();
      return this.withSessionActor(request.sessionId, async () => {
        this.assertClientLease(lease);
        const previous = this.busySessions.get(request.sessionId);
        if (!previous) {
          this.busySessions.set(request.sessionId, {
            controlEpoch: lease.controlEpoch,
            sidecarGeneration: lease.sidecarGeneration,
            awaitingTurnStart: false,
            baselineEventIds: new Set(this.observedEventIds.get(request.sessionId)),
          });
        }
        try {
          const result = await lease.client.interruptSession({
            sessionId: request.sessionId as SessionId,
            reason: "desktop_stop",
            signal: lease.signal,
          });
          this.assertClientLease(lease);
          if (!result.interrupted) {
            this.busySessions.delete(request.sessionId);
            this.scheduleFlush(request.sessionId);
          }
          return result;
        } catch (error) {
          if (!previous) this.deleteBusyIfOwned(request.sessionId, lease);
          throw error;
        }
      }, "stop");
    }
    if (request.type === "approval.resolve") {
      const lease = this.captureClientLease();
      const result = await lease.client.resolveApproval({
        approvalId: request.approvalId as never,
        decision: request.decision,
        ...(request.feedback !== undefined ? { feedback: request.feedback } : {}),
        signal: lease.signal,
      });
      this.assertClientLease(lease);
      return result;
    }
    if (request.type === "user-input.resolve") {
      const lease = this.captureClientLease();
      const result = await lease.client.resolveUserInput({
        inputId: request.inputId as never,
        answers: request.answers,
        signal: lease.signal,
      });
      this.assertClientLease(lease);
      return result;
    }
    if (request.type === "diff.get") {
      const lease = this.captureClientLease();
      const result = await desktopDiff({
        scope: request.scope,
        workspace: this.requireWorkspace(),
        sessionId: request.sessionId,
        ...(request.turnId ? { turnId: request.turnId } : {}),
        client: lease.client,
        signal: lease.signal,
        processGroups: this.mainProcessGroups,
      });
      this.assertClientLease(lease);
      return result;
    }
    throw new Error("Unsupported desktop request");
  }

  private async selectWorkspace(): Promise<DesktopState> {
    const selectionEpoch = this.controlEpoch;
    const selectionSignal = this.controlEpochController.signal;
    if (this.closing || selectionSignal.aborted) throw new Error("Desktop is closing");
    const workspace = await this.options.selectWorkspace();
    if (this.closing) throw new Error("Desktop is closing");
    if (selectionSignal.aborted || selectionEpoch !== this.controlEpoch) {
      throw new Error("Workspace changed while the selection dialog was open");
    }
    if (!workspace) return this.options.sidecar.state();
    this.switchingWorkspace = true;
    try {
      await this.options.sidecar.switchWorkspace(workspace, async () => {
        this.controlEpochController.abort(new Error("Workspace changed"));
        this.controlEpoch += 1;
        this.controlEpochController = new AbortController();
        if (!await this.drainSessionActorsWithin(2_000)) {
          this.options.onError(new Error("Timed out draining requests from the previous workspace"));
        }
        this.clearQueues();
      });
      if (this.closing) throw new Error("Desktop is closing");
      const selected = this.options.sidecar.currentWorkspace();
      if (selected) await this.options.persistWorkspace(selected);
      return this.options.sidecar.state();
    } finally {
      this.switchingWorkspace = false;
    }
  }

  private async sessionSnapshot(sessionId: SessionId, lease: ClientLease): Promise<{
    sessionId: string;
    events: ChiliEvent[];
    agentTree: RuntimeAgentTreeSnapshot;
    tasks: RuntimeAgentTaskRecord[];
    pendingApprovals: RuntimePendingApprovalRequest[];
    pendingInputs: SessionControlSnapshot["inputs"];
    truncated?: boolean;
    warning?: string;
  }> {
    const pendingSessionIds: SessionId[] = [sessionId];
    const discoveredSessionIds = new Set<string>([sessionId]);
    const sessionOrder = new Map<string, number>([[sessionId, 0]]);
    let nextSessionOrder = 1;
    const limiter = createAsyncLimiter(SNAPSHOT_FETCH_CONCURRENCY);
    const retainedAgentTrees: RuntimeAgentTreeSnapshot[] = [];
    const tasks = new BoundedUniqueRows<RuntimeAgentTaskRecord>(SNAPSHOT_TASK_LIMIT, SNAPSHOT_TASK_BYTES);
    const inputs = new BoundedUniqueRows<SessionControlSnapshot["inputs"][number]>(
      SNAPSHOT_INPUT_LIMIT,
      SNAPSHOT_INPUT_BYTES,
    );
    const approvals = new BoundedUniqueRows<RuntimePendingApprovalRequest>(
      SNAPSHOT_APPROVAL_LIMIT,
      SNAPSHOT_APPROVAL_BYTES,
    );
    const warnings = new Set<string>();
    let agentTreeRows = 0;
    let agentTreeBytes = 0;
    const events = new ReplayableRuntimeEventWindowAccumulator({
      maxEvents: SNAPSHOT_EVENT_LIMIT,
      maxBytes: SNAPSHOT_EVENT_BYTES,
      maxSources: MAX_DESCENDANT_SESSIONS,
    });

    while (pendingSessionIds.length > 0) {
      const batch = pendingSessionIds.splice(0, SNAPSHOT_SESSION_BATCH);
      const snapshots = await Promise.all(batch.map(async (candidate): Promise<SessionControlSnapshot> => {
        const [eventWindow, agentTree, sessionTasks, pendingInputs] = await Promise.all([
          limiter(async () => {
            if (lease.client.sessionEventWindow) {
              return lease.client.sessionEventWindow({
                sessionId: candidate,
                limit: 5_000,
                signal: lease.signal,
              });
            }
            const sessionEvents = await lease.client.sessionEvents({
              sessionId: candidate,
              limit: 5_000,
              signal: lease.signal,
            });
            const approvalWindow = lease.client.pendingApprovalWindow
              ? await lease.client.pendingApprovalWindow({ sessionId: candidate, signal: lease.signal })
              : typeof lease.client.listPendingApprovals === "function"
                ? {
                    approvals: await lease.client.listPendingApprovals({ sessionId: candidate, signal: lease.signal }),
                    truncated: false,
                  }
                : { approvals: [], truncated: false };
            return {
              events: sessionEvents,
              pendingApprovals: approvalWindow.approvals,
              truncated: false,
              bytes: jsonByteLength(sessionEvents),
              pinnedEventIds: [],
              approvalsTruncated: approvalWindow.truncated,
            };
          }),
          limiter(() => lease.client.agentTree({
            sessionId: candidate,
            includeConsumedMailbox: false,
            limit: 2_000,
          })),
          limiter(() => lease.client.listTasks({ parentSessionId: candidate, limit: 2_000 })),
          limiter(() => lease.client.listUserInputs({ sessionId: candidate, signal: lease.signal })),
        ]);
        return {
          sessionId: candidate,
          events: eventWindow.events,
          eventPinnedIds: eventWindow.pinnedEventIds,
          eventsTruncated: eventWindow.truncated,
          pendingApprovals: eventWindow.pendingApprovals,
          approvalsTruncated: "approvalsTruncated" in eventWindow && eventWindow.approvalsTruncated === true,
          agentTree,
          tasks: sessionTasks,
          inputs: pendingInputs,
        };
      }));
      this.assertClientLease(lease);

      for (const snapshot of snapshots) {
        for (const childSessionId of descendantSessionIds(snapshot)) {
          if (discoveredSessionIds.has(childSessionId)) continue;
          if (discoveredSessionIds.size >= MAX_DESCENDANT_SESSIONS) {
            warnings.add(`session traversal reached the ${MAX_DESCENDANT_SESSIONS} descendant limit`);
            continue;
          }
          discoveredSessionIds.add(childSessionId);
          sessionOrder.set(childSessionId, nextSessionOrder);
          nextSessionOrder += 1;
          pendingSessionIds.push(childSessionId as SessionId);
        }

        const sourceOrder = sessionOrder.get(String(snapshot.sessionId));
        if (sourceOrder === undefined) throw new Error(`Missing snapshot source order for ${String(snapshot.sessionId)}`);
        events.addSource(snapshot.events, {
          sourceOrder,
          pinnedEventIds: snapshot.eventPinnedIds,
        });
        if (snapshot.eventsTruncated) warnings.add("timeline events exceeded their desktop snapshot budget");
        const treeRows = agentTreeRowCount(snapshot.agentTree);
        const treeBytes = jsonByteLength(snapshot.agentTree);
        if (
          treeRows > SNAPSHOT_AGENT_TREE_ROWS - agentTreeRows
          || treeBytes > SNAPSHOT_AGENT_TREE_BYTES - agentTreeBytes
        ) {
          warnings.add("agent tree exceeded its desktop snapshot budget");
        } else {
          retainedAgentTrees.push(snapshot.agentTree);
          agentTreeRows += treeRows;
          agentTreeBytes += treeBytes;
        }
        if (tasks.add(snapshot.tasks)) warnings.add("task rows exceeded their desktop snapshot budget");
        if (approvals.add(snapshot.pendingApprovals)) {
          warnings.add("pending approvals exceeded their desktop snapshot budget");
        }
        if (snapshot.approvalsTruncated) warnings.add("pending approvals were truncated by the sidecar");
        if (inputs.add(snapshot.inputs)) warnings.add("input rows exceeded their desktop snapshot budget");
      }

    }

    this.assertClientLease(lease);
    const retainedEvents = events.result();
    if (retainedEvents.truncated) warnings.add("timeline events exceeded their desktop snapshot budget");
    const result = {
      sessionId: String(sessionId),
      events: retainedEvents.events,
      agentTree: mergeAgentTrees(retainedAgentTrees),
      tasks: tasks.values(),
      pendingApprovals: approvals.values()
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
      pendingInputs: inputs.values()
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    };
    if (warnings.size === 0) return result;
    return {
      ...result,
      truncated: true,
      warning: `Large session snapshot truncated: ${[...warnings].join("; ")}.`,
    };
  }

  private async send(
    sessionId: string,
    text: string,
    mode: SendMode,
    lease: ClientLease,
  ): Promise<{ status: "accepted" | "queued"; position?: number }> {
    this.assertClientLease(lease);
    const busy = await this.isBusy(sessionId, lease);
    let queue = this.queues.get(sessionId) ?? [];
    if (!busy && queue.length === 0) {
      this.markOptimisticBusy(sessionId, lease);
      try {
        this.assertClientLease(lease);
        await lease.client.submitPromptAsync({ sessionId: sessionId as SessionId, text, signal: lease.signal });
        this.assertClientLease(lease);
        return { status: "accepted" };
      } catch (error) {
        this.deleteBusyIfOwned(sessionId, lease);
        throw error;
      }
    }

    const prompt: QueuedPrompt = { text, mode, bytes: Buffer.byteLength(text, "utf8") };
    this.enqueuePrompt(sessionId, prompt, mode === "steer");
    queue = this.queues.get(sessionId) ?? [];
    this.updateQueueCount(sessionId, queue.length);
    if (mode === "steer") {
      try {
        this.assertClientLease(lease);
        const result = await lease.client.interruptSession({
          sessionId: sessionId as SessionId,
          reason: "desktop_steer",
          signal: lease.signal,
        });
        this.assertClientLease(lease);
        if (!result.interrupted) {
          this.busySessions.delete(sessionId);
          this.scheduleFlush(sessionId);
        }
      } catch (error) {
        if (!this.isClientLeaseCurrent(lease)) throw error;
        const queuedIndex = queue.indexOf(prompt);
        if (queuedIndex >= 0) {
          queue.splice(queuedIndex, 1);
          this.releaseQueuedPrompt(sessionId, prompt);
        }
        if (queue.length === 0) this.queues.delete(sessionId);
        this.updateQueueCount(sessionId, queue.length);
        throw error;
      }
    }
    if (!busy) this.scheduleFlush(sessionId);
    return { status: "queued", position: mode === "steer" ? 1 : queue.length };
  }

  private async isBusy(sessionId: string, lease: ClientLease): Promise<boolean> {
    const known = this.busySessions.get(sessionId);
    if (
      known
      && known.controlEpoch === lease.controlEpoch
      && known.sidecarGeneration === lease.sidecarGeneration
    ) return true;
    const events = await lease.client.sessionEvents({
      sessionId: sessionId as SessionId,
      limit: 5_000,
      signal: lease.signal,
    });
    this.assertClientLease(lease);
    for (const event of events) this.recordObservedEvent(sessionId, event.id);
    const session = reduceRuntimeEvents(events).sessions[sessionId];
    const busy = session?.status === "running" || session?.status === "waiting_for_approval" || session?.status === "cancelling";
    if (busy) {
      this.busySessions.set(sessionId, {
        controlEpoch: lease.controlEpoch,
        sidecarGeneration: lease.sidecarGeneration,
        awaitingTurnStart: false,
        baselineEventIds: new Set(this.observedEventIds.get(sessionId)),
      });
    }
    return busy;
  }

  private async flush(sessionId: string): Promise<void> {
    if (this.closing || this.switchingWorkspace) return;
    let lease: ClientLease;
    try {
      lease = this.captureClientLease();
    } catch (error) {
      if (this.closing || this.switchingWorkspace) return;
      throw error;
    }
    try {
      await this.withSessionActor(sessionId, () => this.flushInsideActor(sessionId, lease));
    } catch (error) {
      if (!this.isClientLeaseCurrent(lease)) return;
      throw error;
    }
  }

  private scheduleFlush(sessionId: string): void {
    void this.flush(sessionId).catch((error) => {
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async flushInsideActor(sessionId: string, lease: ClientLease): Promise<void> {
    this.assertClientLease(lease);
    const busy = this.busySessions.get(sessionId);
    if (busy && (
      busy.controlEpoch !== lease.controlEpoch
      || busy.sidecarGeneration !== lease.sidecarGeneration
    )) this.busySessions.delete(sessionId);
    if (this.flushingSessions.has(sessionId) || this.busySessions.has(sessionId)) return;
    const queue = this.queues.get(sessionId);
    const next = queue?.shift();
    if (!queue || !next) {
      this.queues.delete(sessionId);
      this.updateQueueCount(sessionId, 0);
      return;
    }
    this.releaseQueuedPrompt(sessionId, next);
    this.flushingSessions.set(sessionId, lease);
    this.updateQueueCount(sessionId, queue.length);
    try {
      this.markOptimisticBusy(sessionId, lease);
      await lease.client.submitPromptAsync({
        sessionId: sessionId as SessionId,
        text: next.text,
        signal: lease.signal,
      });
      this.assertClientLease(lease);
    } catch (error) {
      if (this.isClientLeaseCurrent(lease)) {
        this.deleteBusyIfOwned(sessionId, lease);
        queue.unshift(next);
        this.accountQueuedPrompt(sessionId, next);
        this.updateQueueCount(sessionId, queue.length);
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (this.flushingSessions.get(sessionId) === lease) this.flushingSessions.delete(sessionId);
    }
  }

  private withSessionActor<T>(
    sessionId: string,
    operation: () => Promise<T>,
    admission: SessionActorAdmission = "internal",
  ): Promise<T> {
    const releaseAdmission = this.admitSessionOperation(sessionId, admission);
    const previous = this.sessionActors.get(sessionId) ?? Promise.resolve();
    const operationRun = previous.catch(() => undefined).then(operation);
    const run = releaseAdmission ? operationRun.finally(releaseAdmission) : operationRun;
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.sessionActors.set(sessionId, tail);
    void tail.finally(() => {
      if (this.sessionActors.get(sessionId) === tail) this.sessionActors.delete(sessionId);
    });
    return run;
  }

  private admitSessionOperation(sessionId: string, admission: SessionActorAdmission): (() => void) | undefined {
    if (admission === "internal") return undefined;
    const perSession = admission === "send" ? this.pendingSendsBySession : this.pendingStopsBySession;
    const current = perSession.get(sessionId) ?? 0;
    const perSessionLimit = admission === "send" ? MAX_PENDING_SENDS_PER_SESSION : MAX_PENDING_STOPS_PER_SESSION;
    const global = admission === "send" ? this.pendingSendOperations : this.pendingStopOperations;
    const globalLimit = admission === "send" ? MAX_PENDING_SENDS_GLOBAL : MAX_PENDING_STOPS_GLOBAL;
    if (current >= perSessionLimit || global >= globalLimit) {
      throw new Error(`Too many pending desktop ${admission} operations`);
    }
    perSession.set(sessionId, current + 1);
    if (admission === "send") this.pendingSendOperations += 1;
    else this.pendingStopOperations += 1;
    return () => {
      const remaining = (perSession.get(sessionId) ?? 1) - 1;
      if (remaining > 0) perSession.set(sessionId, remaining);
      else perSession.delete(sessionId);
      if (admission === "send") this.pendingSendOperations -= 1;
      else this.pendingStopOperations -= 1;
    };
  }

  private enqueuePrompt(sessionId: string, prompt: QueuedPrompt, front: boolean): void {
    const queue = this.queues.get(sessionId) ?? [];
    const sessionBytes = this.queuedBytesBySession.get(sessionId) ?? 0;
    if (
      queue.length >= MAX_QUEUED_PROMPTS_PER_SESSION
      || this.queuedPromptCount >= MAX_QUEUED_PROMPTS_GLOBAL
      || sessionBytes + prompt.bytes > MAX_QUEUED_PROMPT_BYTES_PER_SESSION
      || this.queuedPromptBytes + prompt.bytes > MAX_QUEUED_PROMPT_BYTES_GLOBAL
    ) {
      throw new Error("Desktop prompt queue capacity exceeded");
    }
    if (front) queue.unshift(prompt);
    else queue.push(prompt);
    this.queues.set(sessionId, queue);
    this.accountQueuedPrompt(sessionId, prompt);
  }

  private accountQueuedPrompt(sessionId: string, prompt: QueuedPrompt): void {
    this.queuedPromptCount += 1;
    this.queuedPromptBytes += prompt.bytes;
    this.queuedBytesBySession.set(
      sessionId,
      (this.queuedBytesBySession.get(sessionId) ?? 0) + prompt.bytes,
    );
  }

  private releaseQueuedPrompt(sessionId: string, prompt: QueuedPrompt): void {
    this.queuedPromptCount = Math.max(0, this.queuedPromptCount - 1);
    this.queuedPromptBytes = Math.max(0, this.queuedPromptBytes - prompt.bytes);
    const remaining = Math.max(0, (this.queuedBytesBySession.get(sessionId) ?? 0) - prompt.bytes);
    if (remaining > 0) this.queuedBytesBySession.set(sessionId, remaining);
    else this.queuedBytesBySession.delete(sessionId);
  }

  private withWorkspaceActor<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.workspaceActor.catch(() => undefined).then(operation);
    this.workspaceActor = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private captureClientLease(): ClientLease {
    if (this.closing) throw new Error("Desktop is closing");
    const context = this.options.sidecar.getClientContext();
    return {
      client: context.client,
      sidecarGeneration: context.generation,
      controlEpoch: this.controlEpoch,
      signal: this.controlEpochController.signal,
    };
  }

  private tryCaptureClientLease(controlEpoch: number, sidecarGeneration: number): ClientLease | undefined {
    if (this.closing || !this.isCurrentEpoch(controlEpoch, sidecarGeneration) || this.switchingWorkspace) return undefined;
    try {
      const lease = this.captureClientLease();
      return lease.controlEpoch === controlEpoch && lease.sidecarGeneration === sidecarGeneration
        ? lease
        : undefined;
    } catch {
      return undefined;
    }
  }

  private assertClientLease(lease: ClientLease): void {
    if (!this.isClientLeaseCurrent(lease)) throw new Error("Workspace changed while the request was in progress");
    const current = this.options.sidecar.getClientContext();
    if (current.generation !== lease.sidecarGeneration || current.client !== lease.client) {
      throw new Error("Chili sidecar changed while the request was in progress");
    }
  }

  private isClientLeaseCurrent(lease: ClientLease): boolean {
    return !this.closing
      && !this.switchingWorkspace
      && !lease.signal.aborted
      && lease.controlEpoch === this.controlEpoch
      && lease.sidecarGeneration === this.options.sidecar.currentGeneration();
  }

  private isCurrentEpoch(controlEpoch: number, sidecarGeneration: number): boolean {
    return !this.closing
      && controlEpoch === this.controlEpoch
      && sidecarGeneration === this.options.sidecar.currentGeneration();
  }

  private markOptimisticBusy(sessionId: string, lease: ClientLease): void {
    this.busySessions.set(sessionId, {
      controlEpoch: lease.controlEpoch,
      sidecarGeneration: lease.sidecarGeneration,
      awaitingTurnStart: true,
      baselineEventIds: new Set(this.observedEventIds.get(sessionId)),
    });
  }

  private deleteBusyIfOwned(sessionId: string, lease: ClientLease): void {
    const current = this.busySessions.get(sessionId);
    if (
      current?.controlEpoch === lease.controlEpoch
      && current.sidecarGeneration === lease.sidecarGeneration
    ) this.busySessions.delete(sessionId);
  }

  private async drainSessionActorsWithin(timeoutMs: number): Promise<boolean> {
    const drain = async (): Promise<void> => {
      while (this.sessionActors.size > 0) await Promise.all([...this.sessionActors.values()]);
    };
    return Promise.race([
      drain().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  private recordObservedEvent(sessionId: string, eventId: string): void {
    const observed = this.observedEventIds.get(sessionId) ?? new Set<string>();
    observed.add(eventId);
    while (observed.size > 5_000) {
      const oldest = observed.values().next().value;
      if (oldest === undefined) break;
      observed.delete(oldest);
    }
    this.observedEventIds.set(sessionId, observed);
  }

  private updateQueueCount(sessionId: string, count: number): void {
    this.options.sidecar.setQueuedCount(sessionId, count);
    this.options.emitQueue(sessionId, count);
  }

  private requireWorkspace(): string {
    const workspace = this.options.sidecar.currentWorkspace();
    if (!workspace) throw new Error("Select a workspace before using Chili");
    return workspace;
  }
}

const MAX_DESCENDANT_SESSIONS = 512;
const SNAPSHOT_FETCH_CONCURRENCY = 6;
const SNAPSHOT_SESSION_BATCH = 6;
const SNAPSHOT_EVENT_LIMIT = 20_000;
const SNAPSHOT_EVENT_BYTES = 4_000_000;
const SNAPSHOT_AGENT_TREE_ROWS = 5_000;
const SNAPSHOT_AGENT_TREE_BYTES = 2_000_000;
const SNAPSHOT_TASK_LIMIT = 2_000;
const SNAPSHOT_TASK_BYTES = 1_000_000;
const SNAPSHOT_APPROVAL_LIMIT = 2_000;
const SNAPSHOT_APPROVAL_BYTES = 1_000_000;
const SNAPSHOT_INPUT_LIMIT = 2_000;
const SNAPSHOT_INPUT_BYTES = 1_000_000;

interface SessionControlSnapshot {
  sessionId: SessionId;
  events: ChiliEvent[];
  eventPinnedIds: string[];
  eventsTruncated: boolean;
  pendingApprovals: RuntimePendingApprovalRequest[];
  approvalsTruncated: boolean;
  agentTree: RuntimeAgentTreeSnapshot;
  tasks: RuntimeAgentTaskRecord[];
  inputs: Awaited<ReturnType<import("@chili/sdk").RuntimeClient["listUserInputs"]>>;
}

function descendantSessionIds(snapshot: SessionControlSnapshot): Set<string> {
  const sessionIds = new Set<string>();
  for (const agent of snapshot.agentTree.agents) {
    if (agent.childSessionId && agent.childSessionId !== snapshot.sessionId) sessionIds.add(agent.childSessionId);
  }
  for (const task of [...snapshot.agentTree.tasks, ...snapshot.tasks]) {
    if (task.childSessionId && task.childSessionId !== snapshot.sessionId) sessionIds.add(task.childSessionId);
  }
  return sessionIds;
}

class BoundedUniqueRows<T extends { id: string }> {
  private readonly rows = new Map<string, { value: T; bytes: number }>();
  private bytes = 2;

  constructor(
    private readonly maxRows: number,
    private readonly maxBytes: number,
  ) {}

  add(values: readonly T[]): boolean {
    let truncated = false;
    for (const value of values) {
      const rowBytes = jsonByteLength(value);
      const existing = this.rows.get(value.id);
      const separatorBytes = !existing && this.rows.size > 0 ? 1 : 0;
      const nextBytes = this.bytes - (existing?.bytes ?? 0) + rowBytes + separatorBytes;
      if ((!existing && this.rows.size >= this.maxRows) || nextBytes > this.maxBytes) {
        truncated = true;
        continue;
      }
      this.rows.set(value.id, { value, bytes: rowBytes });
      this.bytes = nextBytes;
    }
    return truncated;
  }

  values(): T[] {
    return [...this.rows.values()].map((row) => row.value);
  }
}

function agentTreeRowCount(tree: RuntimeAgentTreeSnapshot): number {
  let nodes = 0;
  const pending = [...tree.nodes];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    nodes += 1;
    pending.push(...node.children);
  }
  return nodes + tree.agents.length + tree.tasks.length + tree.mailbox.length;
}

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

type AsyncLimiter = <T>(operation: () => Promise<T>) => Promise<T>;

function createAsyncLimiter(maxConcurrency: number): AsyncLimiter {
  let active = 0;
  const queued: Array<() => void> = [];
  const advance = (): void => {
    while (active < maxConcurrency) {
      const next = queued.shift();
      if (!next) return;
      active += 1;
      next();
    }
  };
  return <T>(operation: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    queued.push(() => {
      void Promise.resolve()
        .then(operation)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          advance();
        });
    });
    advance();
  });
}

function mergeAgentTrees(snapshots: RuntimeAgentTreeSnapshot[]): RuntimeAgentTreeSnapshot {
  const agents = uniqueById(snapshots.flatMap((snapshot) => snapshot.agents));
  const tasks = uniqueById(snapshots.flatMap((snapshot) => snapshot.tasks));
  const mailbox = uniqueById(snapshots.flatMap((snapshot) => snapshot.mailbox));
  const nodeVersions = new Map<string, RuntimeAgentTreeNode[]>();
  for (const snapshot of snapshots) {
    visitAgentTreeNodes(snapshot.nodes, (node) => {
      const versions = nodeVersions.get(node.path) ?? [];
      versions.push(node);
      nodeVersions.set(node.path, versions);
    });
  }

  const nodes = new Map<string, RuntimeAgentTreeNode>();
  for (const [path, versions] of nodeVersions) {
    const newest = [...versions].sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!newest) continue;
    const nodeAgents = agents.filter((agent) => agent.path === path);
    nodes.set(path, {
      path: newest.path,
      ...(newest.parentPath ? { parentPath: newest.parentPath } : {}),
      taskName: newest.taskName,
      status: newest.status,
      runIds: nodeAgents.map((agent) => agent.id),
      runs: nodeAgents,
      tasks: tasks.filter((task) => task.path === path),
      mailbox: mailbox.filter((message) => message.path === path),
      children: [],
      createdAt: Math.min(...versions.map((node) => node.createdAt)),
      updatedAt: Math.max(...versions.map((node) => node.updatedAt)),
    });
  }
  const roots: RuntimeAgentTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentPath ? nodes.get(node.parentPath) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (items: RuntimeAgentTreeNode[]): RuntimeAgentTreeNode[] => {
    items.sort((left, right) => left.createdAt - right.createdAt || left.path.localeCompare(right.path));
    for (const item of items) sortNodes(item.children);
    return items;
  };
  return { nodes: sortNodes(roots), agents, tasks, mailbox };
}

function visitAgentTreeNodes(nodes: RuntimeAgentTreeNode[], visit: (node: RuntimeAgentTreeNode) => void): void {
  for (const node of nodes) {
    visit(node);
    visitAgentTreeNodes(node.children, visit);
  }
}

function uniqueById<T extends RuntimeAgentRunRecord | RuntimeAgentTaskRecord | RuntimeAgentMailboxRecord>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
