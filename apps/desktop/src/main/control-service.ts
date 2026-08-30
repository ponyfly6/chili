import { normalizeSessionTitle, type ChiliEvent, type SessionId } from "@chili/protocol";
import { resolve } from "node:path";
import { reduceRuntimeEvents, ReplayableRuntimeEventWindowAccumulator } from "@chili/sdk";
import type {
  RuntimeAgentMailboxRecord,
  RuntimeAgentRunRecord,
  RuntimeAgentTaskRecord,
  RuntimeAgentTreeNode,
  RuntimeAgentTreeSnapshot,
  RuntimeClient,
  RuntimePendingApprovalRequest,
  RuntimeSessionSummary,
} from "@chili/sdk";
import type {
  DesktopCreateSessionResult,
  DesktopCreateSessionStage,
  DesktopRequest,
  DesktopResponse,
  DesktopSessionConfig,
  DesktopState,
  SendMode,
} from "../shared/contracts.js";
import { safeDesktopErrorMessage } from "../shared/safe-error.js";
import { DetachedProcessGroupRegistry } from "./detached-process-group-registry.js";
import { desktopDiff } from "./git-diff.js";
import type { SidecarManager } from "./sidecar-manager.js";

interface QueuedPrompt {
  text: string;
  mode: SendMode;
  bytes: number;
  origin: "local" | "remote";
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
  readTimeoutMs: number;
}

interface GoalResumeMarker {
  controlEpoch: number;
  sidecarGeneration: number;
}

export interface DesktopControlServiceOptions {
  sidecar: SidecarManager;
  selectWorkspace(): Promise<string | undefined>;
  persistWorkspace(workspace: string): Promise<void>;
  emitQueue(sessionId: string, count: number): void;
  onError(error: Error): void;
  processGroups?: DetachedProcessGroupRegistry;
  /** Test/embedding override may shorten, but never extend, the five-second read bound. */
  controlReadTimeoutMs?: number;
}

/** Main-process-only scope; its client lease is deliberately not exposed. */
export interface DesktopRemoteControlScope {
  readonly workspace: string;
  readonly signal: AbortSignal;
}

export type DesktopRemoteControlRequest = Extract<DesktopRequest, {
  type: "sessions.list" | "session.snapshot" | "session.send" | "session.stop";
}>;

/** Internal input to the separate remote whitelist projector, never a wire response. */
export interface DesktopRemoteRootSnapshot {
  session: RuntimeSessionSummary;
  events: ChiliEvent[];
  queuedCount: number;
  deliveryUnknown: boolean;
  needsDesktop: { approval: boolean; input: boolean };
  truncated: boolean;
}

export type DesktopRemoteControlResponse<Request extends DesktopRemoteControlRequest> =
  Request extends { type: "session.snapshot" } ? DesktopRemoteRootSnapshot : DesktopResponse<Request>;

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
  private readonly resumeGoalsAfterDrain = new Map<string, GoalResumeMarker>();
  private readonly remoteDeliveryUnknown = new Set<string>();
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
  private readonly controlReadTimeoutMs: number;
  private readonly remoteScopes = new WeakMap<DesktopRemoteControlScope, {
    lease: ClientLease;
    controller: AbortController;
  }>();

  constructor(private readonly options: DesktopControlServiceOptions) {
    this.mainProcessGroups = options.processGroups ?? new DetachedProcessGroupRegistry();
    this.controlReadTimeoutMs = options.controlReadTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.controlReadTimeoutMs) || this.controlReadTimeoutMs < 1 || this.controlReadTimeoutMs > 5_000) {
      throw new TypeError("Control read timeout must be between 1 and 5000 milliseconds");
    }
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

  captureRemoteControlScope(): DesktopRemoteControlScope {
    if (this.switchingWorkspace || this.workspaceSelectionsPending > 0) {
      throw new Error("Workspace selection is in progress");
    }
    const lease = this.captureClientLease();
    this.assertClientLease(lease);
    const controller = new AbortController();
    const signal = AbortSignal.any([lease.signal, controller.signal]);
    const scope = Object.freeze({ workspace: this.requireWorkspace(), signal });
    this.remoteScopes.set(scope, { lease: { ...lease, signal }, controller });
    return scope;
  }

  assertRemoteControlScope(scope: DesktopRemoteControlScope): void {
    const lease = this.remoteScopes.get(scope)?.lease;
    if (!lease || this.workspaceSelectionsPending > 0 || this.requireWorkspace() !== scope.workspace) {
      throw new Error("Remote control workspace is no longer available; pair again on desktop");
    }
    this.assertClientLease(lease);
  }

  revokeRemoteControlScope(scope: DesktopRemoteControlScope): void {
    this.remoteScopes.get(scope)?.controller.abort(new Error("Remote control was disabled"));
    this.remoteScopes.delete(scope);
  }

  /**
   * Every remote operation resolves membership using the original workspace lease.
   * Sends and stops still use the local window's service actors and prompt queue.
   * Snapshot reads never enter those actors or fetch subagent session contents.
   */
  async invokeRemoteControl<Request extends DesktopRemoteControlRequest>(
    request: Request,
    scope: DesktopRemoteControlScope,
    signal?: AbortSignal,
  ): Promise<DesktopRemoteControlResponse<Request>> {
    this.assertRemoteControlScope(scope);
    const scopedLease = this.remoteScopes.get(scope)!.lease;
    const lease = signal ? { ...scopedLease, signal: AbortSignal.any([scopedLease.signal, signal]) } : scopedLease;
    this.assertClientLease(lease);
    const sessions = (await boundedControlRead(lease, (signal) => lease.client.listSessions({ signal }))).filter((session) =>
      session.source !== "subagent" && resolve(session.cwd) === resolve(scope.workspace));
    this.assertRemoteControlScope(scope);
    this.assertClientLease(lease);
    if (request.type === "sessions.list") {
      const query = request.query?.trim().toLowerCase();
      return sessions.filter((session) => {
        if (request.status && request.status !== "all" && request.status !== session.status) return false;
        return !query || [String(session.id), session.title]
          .some((value) => value?.toLowerCase().includes(query));
      }) as DesktopRemoteControlResponse<Request>;
    }
    const session = sessions.find((candidate) => String(candidate.id) === request.sessionId);
    if (!session) throw new Error("Task is not available for remote control in this workspace");
    if (request.type === "session.snapshot") {
      const result = await this.remoteRootSnapshot(session, lease);
      this.assertRemoteControlScope(scope);
      this.assertClientLease(lease);
      return result as DesktopRemoteControlResponse<Request>;
    }
    if (request.type !== "session.send" && request.type !== "session.stop") {
      throw new Error("Operation is not available for remote control");
    }
    if (session.status !== "active") throw new Error("Archived tasks cannot be controlled remotely");
    this.assertRemoteControlScope(scope);
    const result = request.type === "session.send"
      ? await this.withSessionActor(request.sessionId, () => {
          this.assertRemoteControlScope(scope);
          return this.send(request.sessionId, request.text, request.mode, lease, "remote");
        }, "send")
      : await this.withSessionActor(request.sessionId, () => {
          this.assertRemoteControlScope(scope);
          return this.stop(request.sessionId, lease);
        }, "stop");
    this.assertRemoteControlScope(scope);
    this.assertClientLease(lease);
    return result as DesktopRemoteControlResponse<Request>;
  }

  private async remoteRootSnapshot(
    session: RuntimeSessionSummary,
    lease: ClientLease,
  ): Promise<DesktopRemoteRootSnapshot> {
    const sessionId = session.id;
    const [eventWindow, inputs] = await boundedControlRead(lease, (signal) => Promise.all([
      (async () => {
        if (lease.client.sessionEventWindow) {
          return lease.client.sessionEventWindow({ sessionId, limit: 5_000, signal });
        }
        if (!lease.client.listPendingApprovals) throw new Error("Runtime does not support safe remote snapshots");
        const [events, approvals] = await Promise.all([
          lease.client.sessionEvents({ sessionId, limit: 5_000, signal }),
          lease.client.listPendingApprovals({ sessionId, signal }),
        ]);
        return { events, pendingApprovals: approvals, truncated: false, approvalsTruncated: false };
      })(),
      lease.client.listUserInputs({ sessionId, signal }),
    ]));
    this.assertClientLease(lease);
    return {
      session,
      events: eventWindow.events,
      queuedCount: this.queues.get(String(sessionId))?.length ?? 0,
      deliveryUnknown: this.remoteDeliveryUnknown.has(String(sessionId)),
      needsDesktop: {
        approval: eventWindow.pendingApprovals.length > 0
          || ("approvalsTruncated" in eventWindow && eventWindow.approvalsTruncated === true),
        input: inputs.length > 0,
      },
      truncated: eventWindow.truncated,
    };
  }

  beginShutdown(): void {
    if (this.closing) return;
    this.closing = true;
    this.resumeGoalsAfterDrain.clear();
    this.remoteDeliveryUnknown.clear();
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
    this.resumeGoalsAfterDrain.clear();
    this.remoteDeliveryUnknown.clear();
  }

  private clearSessionQueue(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (queue) {
      for (const prompt of queue) this.releaseQueuedPrompt(sessionId, prompt);
    }
    this.queues.delete(sessionId);
    this.queuedBytesBySession.delete(sessionId);
    this.resumeGoalsAfterDrain.delete(sessionId);
    this.updateQueueCount(sessionId, 0);
  }

  private closingResponse(request: DesktopRequest): unknown {
    if (!this.closing) return undefined;
    if (request.type === "app.state") return this.options.sidecar.state();
    if (request.type === "sessions.list") return [];
    if (request.type === "session.snapshot" || request.type === "session.resume") {
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
      const query = request.query?.trim().toLowerCase();
      return sessions.filter((session) => {
        if (session.source === "subagent") return false;
        if (request.status && request.status !== "all" && session.status !== request.status) return false;
        if (!query) return true;
        return [String(session.id), session.title, session.preview, session.cwd]
          .some((candidate) => candidate?.toLowerCase().includes(query));
      });
    }
    if (request.type === "sessions.create") {
      return this.withWorkspaceActor(() => this.createConfiguredSession(request));
    }
    if (request.type === "models.list") {
      const lease = this.captureClientLease();
      const models = await lease.client.listModels(request.provider ? { provider: request.provider } : {});
      this.assertClientLease(lease);
      return models;
    }
    if (request.type === "session.snapshot") {
      return this.sessionSnapshot(request.sessionId as SessionId, this.captureClientLease());
    }
    if (request.type === "session.resume") {
      const lease = this.captureClientLease();
      return this.withSessionActor(request.sessionId, async () => {
        const sessions = await lease.client.listSessions();
        this.assertClientLease(lease);
        const session = sessions.find((candidate) => String(candidate.id) === request.sessionId);
        if (!session) throw new Error(`Saved task not found: ${request.sessionId}`);
        if (session.source === "subagent") throw new Error("Subagent tasks cannot be resumed directly");
        if (session.status !== "active") throw new Error("Archived tasks cannot be resumed");
        const sessionId = request.sessionId as SessionId;
        const goal = await lease.client.getGoal({ sessionId, signal: lease.signal });
        this.assertClientLease(lease);
        if (goal?.status === "budgetLimited") {
          throw new Error("Increase the Goal token budget before resuming this task");
        }
        if (goal?.status === "active" || goal?.status === "paused") {
          if (await this.isBusy(request.sessionId, lease)) {
            throw new Error("Wait for the current run to stop before resuming this Goal");
          }
          await lease.client.updateGoal({ sessionId, status: "active", signal: lease.signal });
          this.assertClientLease(lease);
          this.markOptimisticBusy(request.sessionId, lease);
        }
        return this.sessionSnapshot(sessionId, lease);
      });
    }
    if (request.type === "session.rename") {
      const lease = this.captureClientLease();
      return this.withSessionActor(request.sessionId, async () => {
        const renamed = await lease.client.renameSession({
          sessionId: request.sessionId as SessionId,
          title: normalizeSessionTitle(request.title),
          signal: lease.signal,
        });
        this.assertClientLease(lease);
        return renamed;
      });
    }
    if (request.type === "session.archive") {
      const lease = this.captureClientLease();
      return this.withSessionActor(request.sessionId, async () => {
        if (await this.isBusy(request.sessionId, lease)) {
          throw new Error("Stop the current run before archiving this task");
        }
        const sessionId = request.sessionId as SessionId;
        const goal = await lease.client.getGoal({ sessionId, signal: lease.signal });
        this.assertClientLease(lease);
        if (goal?.status === "active") {
          await lease.client.updateGoal({ sessionId, status: "paused", signal: lease.signal });
          this.assertClientLease(lease);
        }
        await lease.client.archiveSession(sessionId);
        this.assertClientLease(lease);
        this.clearSessionQueue(request.sessionId);
        this.busySessions.delete(request.sessionId);
        return { archived: true };
      });
    }
    if (request.type === "session.config.get") {
      const lease = this.captureClientLease();
      const sessionId = request.sessionId as SessionId;
      const [model, permission, delegation, goal, mcp] = await Promise.all([
        lease.client.getModelConfig({ sessionId, signal: lease.signal }),
        lease.client.getPermissionConfig({ signal: lease.signal }),
        lease.client.getDelegationConfig({ sessionId, signal: lease.signal }),
        lease.client.getGoal({ sessionId, signal: lease.signal }),
        lease.client.mcpStatus({ sessionId, signal: lease.signal }),
      ]);
      this.assertClientLease(lease);
      return { model, permission, delegation, goal: goal ?? null, mcp } satisfies DesktopSessionConfig;
    }
    if (request.type === "session.model.set") {
      const lease = this.captureClientLease();
      return this.withSessionActor(request.sessionId, async () => {
        const config = await lease.client.setModel({
          sessionId: request.sessionId as SessionId,
          modelSelection: request.modelSelection,
          signal: lease.signal,
        });
        this.assertClientLease(lease);
        return config;
      });
    }
    if (request.type === "session.reasoning.set") {
      const lease = this.captureClientLease();
      return this.withSessionActor(request.sessionId, async () => {
        const config = await lease.client.setReasoning({
          sessionId: request.sessionId as SessionId,
          reasoningLevel: request.reasoningLevel,
          signal: lease.signal,
        });
        this.assertClientLease(lease);
        return config;
      });
    }
    if (request.type === "session.service-tier.set") {
      const lease = this.captureClientLease();
      return this.withSessionActor(request.sessionId, async () => {
        const config = await lease.client.setServiceTier({
          sessionId: request.sessionId as SessionId,
          serviceTier: request.serviceTier,
          signal: lease.signal,
        });
        this.assertClientLease(lease);
        return config;
      });
    }
    if (request.type === "permissions.get") {
      const lease = this.captureClientLease();
      const config = await lease.client.getPermissionConfig({ signal: lease.signal });
      this.assertClientLease(lease);
      return config;
    }
    if (request.type === "permissions.set") {
      return this.withWorkspaceActor(async () => {
        const lease = this.captureClientLease();
        const config = await lease.client.setPermissionProfile({ profile: request.profile, signal: lease.signal });
        this.assertClientLease(lease);
        return config;
      });
    }
    if (request.type === "session.delegation.get") {
      const lease = this.captureClientLease();
      const config = await lease.client.getDelegationConfig({
        sessionId: request.sessionId as SessionId,
        signal: lease.signal,
      });
      this.assertClientLease(lease);
      return config;
    }
    if (request.type === "session.delegation.set") {
      const lease = this.captureClientLease();
      return this.withSessionActor(request.sessionId, async () => {
        const config = await lease.client.setDelegationPolicy({
          sessionId: request.sessionId as SessionId,
          policy: request.policy,
          signal: lease.signal,
        });
        this.assertClientLease(lease);
        return config;
      });
    }
    if (request.type === "session.goal.get") {
      const lease = this.captureClientLease();
      const goal = await lease.client.getGoal({ sessionId: request.sessionId as SessionId, signal: lease.signal });
      this.assertClientLease(lease);
      return { goal: goal ?? null };
    }
    if (request.type === "session.goal.set") {
      const lease = this.captureClientLease();
      return this.withSessionActor(request.sessionId, async () => {
        this.resumeGoalsAfterDrain.delete(request.sessionId);
        const goal = await lease.client.setGoal({
          sessionId: request.sessionId as SessionId,
          objective: request.objective,
          ...(request.tokenBudget !== undefined ? { tokenBudget: request.tokenBudget } : {}),
          ...(request.replace !== undefined ? { replace: request.replace } : {}),
          signal: lease.signal,
        });
        this.assertClientLease(lease);
        return goal;
      });
    }
    if (request.type === "session.goal.update") {
      const lease = this.captureClientLease();
      return this.withSessionActor(request.sessionId, async () => {
        if (request.status === "active" && await this.isBusy(request.sessionId, lease)) {
          throw new Error("Wait for the current run to stop before resuming this Goal");
        }
        if (request.status !== undefined && request.status !== "active") {
          this.resumeGoalsAfterDrain.delete(request.sessionId);
        }
        const goal = await lease.client.updateGoal({
          sessionId: request.sessionId as SessionId,
          ...(request.status !== undefined ? { status: request.status } : {}),
          ...(request.objective !== undefined ? { objective: request.objective } : {}),
          ...(request.tokenBudget !== undefined ? { tokenBudget: request.tokenBudget } : {}),
          signal: lease.signal,
        });
        this.assertClientLease(lease);
        return goal;
      });
    }
    if (request.type === "session.goal.clear") {
      const lease = this.captureClientLease();
      return this.withSessionActor(request.sessionId, async () => {
        this.resumeGoalsAfterDrain.delete(request.sessionId);
        const result = await lease.client.clearGoal({
          sessionId: request.sessionId as SessionId,
          signal: lease.signal,
        });
        this.assertClientLease(lease);
        return result;
      });
    }
    if (request.type === "mcp.status") {
      const lease = this.captureClientLease();
      const status = await lease.client.mcpStatus({
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId as SessionId } : {}),
        signal: lease.signal,
      });
      this.assertClientLease(lease);
      return status;
    }
    if (request.type === "mcp.reload") {
      const run = async () => {
        const lease = this.captureClientLease();
        const result = await lease.client.reloadMcp({
          ...(request.sessionId !== undefined ? { sessionId: request.sessionId as SessionId } : {}),
          signal: lease.signal,
        });
        this.assertClientLease(lease);
        return result;
      };
      return request.sessionId ? this.withSessionActor(request.sessionId, run) : this.withWorkspaceActor(run);
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
      return this.withSessionActor(request.sessionId, () => this.stop(request.sessionId, lease), "stop");
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

  private async createConfiguredSession(
    request: Extract<DesktopRequest, { type: "sessions.create" }>,
  ): Promise<DesktopCreateSessionResult> {
    if (request.goal && (
      request.prompt === undefined
      || request.prompt.trim() !== request.goal.objective.trim()
    )) {
      throw new TypeError("Goal objective must match the task prompt");
    }
    const normalizedTitle = request.title === undefined
      ? undefined
      : normalizeSessionTitle(request.title);
    const lease = this.captureClientLease();
    const cwd = this.requireWorkspace();
    const created = await lease.client.createSession({ cwd, signal: lease.signal });
    this.assertClientLease(lease);
    const sessionId = created.sessionId;
    let stage: DesktopCreateSessionStage = "rename";
    let previousPermission: Awaited<ReturnType<RuntimeClient["getPermissionConfig"]>> | undefined;
    let permissionMutationAttempted = false;

    const partial = async (
      error: unknown,
      launchMayHaveCommitted = false,
    ): Promise<DesktopCreateSessionResult> => {
      const permissionRestored = launchMayHaveCommitted
        ? undefined
        : await this.restoreCreatePermission({
            lease,
            ...(previousPermission ? { previous: previousPermission } : {}),
            ...(request.permissionProfile ? { requested: request.permissionProfile } : {}),
            mutationAttempted: permissionMutationAttempted,
          });
      return {
        sessionId: String(sessionId),
        status: "partial",
        startState: launchMayHaveCommitted ? "unknown" : "not_started",
        started: false,
        failure: {
          stage,
          message: safeDesktopErrorMessage(error),
          ...(permissionRestored !== undefined ? { permissionRestored } : {}),
          ...(launchMayHaveCommitted ? { launchMayHaveCommitted: true } : {}),
        },
      };
    };

    try {
      if (normalizedTitle !== undefined) {
        stage = "rename";
        await lease.client.renameSession({ sessionId, title: normalizedTitle, signal: lease.signal });
        this.assertClientLease(lease);
      }
      if (request.modelSelection !== undefined) {
        stage = "model";
        await lease.client.setModel({ sessionId, modelSelection: request.modelSelection, signal: lease.signal });
        this.assertClientLease(lease);
      }
      if (request.reasoningLevel !== undefined) {
        stage = "reasoning";
        await lease.client.setReasoning({ sessionId, reasoningLevel: request.reasoningLevel, signal: lease.signal });
        this.assertClientLease(lease);
      }
      if (request.serviceTier !== undefined) {
        stage = "service_tier";
        await lease.client.setServiceTier({ sessionId, serviceTier: request.serviceTier, signal: lease.signal });
        this.assertClientLease(lease);
      }
      if (request.delegationPolicy !== undefined) {
        stage = "delegation";
        await lease.client.setDelegationPolicy({ sessionId, policy: request.delegationPolicy, signal: lease.signal });
        this.assertClientLease(lease);
      }
      if (request.permissionProfile !== undefined) {
        stage = "permission";
        previousPermission = await lease.client.getPermissionConfig({ signal: lease.signal });
        this.assertClientLease(lease);
        if (previousPermission.profile !== request.permissionProfile) {
          permissionMutationAttempted = true;
          await lease.client.setPermissionProfile({ profile: request.permissionProfile, signal: lease.signal });
          this.assertClientLease(lease);
        }
      }
    } catch (error) {
      return partial(error);
    }

    if (request.goal) {
      stage = "goal";
      try {
        const goal = await lease.client.setGoal({
          sessionId,
          objective: request.goal.objective,
          ...(request.goal.tokenBudget !== undefined ? { tokenBudget: request.goal.tokenBudget } : {}),
          signal: lease.signal,
        });
        this.assertClientLease(lease);
        this.markOptimisticBusy(String(sessionId), lease);
        return { sessionId: String(sessionId), status: "started", startState: "started", started: true, goal };
      } catch (error) {
        return partial(error, true);
      }
    }

    if (request.prompt !== undefined) {
      stage = "prompt";
      try {
        await lease.client.submitPromptAsync({ sessionId, text: request.prompt, signal: lease.signal });
        this.assertClientLease(lease);
        this.markOptimisticBusy(String(sessionId), lease);
        return { sessionId: String(sessionId), status: "started", startState: "started", started: true };
      } catch (error) {
        return partial(error, true);
      }
    }

    return { sessionId: String(sessionId), status: "created", startState: "not_started", started: false };
  }

  private async restoreCreatePermission(input: {
    lease: ClientLease;
    previous?: Awaited<ReturnType<RuntimeClient["getPermissionConfig"]>>;
    requested?: Extract<DesktopRequest, { type: "permissions.set" }>["profile"];
    mutationAttempted: boolean;
  }): Promise<boolean | undefined> {
    if (!input.mutationAttempted || !input.previous || !input.requested) return undefined;
    try {
      const current = await input.lease.client.getPermissionConfig({ signal: input.lease.signal });
      this.assertClientLease(input.lease);
      if (current.profile !== input.requested) return false;
      await input.lease.client.setPermissionProfile({
        profile: input.previous.profile,
        signal: input.lease.signal,
      });
      this.assertClientLease(input.lease);
      return true;
    } catch (rollbackError) {
      this.options.onError(new Error(`Failed to restore the runtime permission profile: ${safeDesktopErrorMessage(rollbackError)}`));
      return false;
    }
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

  private async stop(sessionId: string, lease: ClientLease): Promise<{ interrupted: boolean }> {
    this.assertClientLease(lease);
    this.resumeGoalsAfterDrain.delete(sessionId);
    const previous = this.busySessions.get(sessionId);
    if (!previous) {
      this.busySessions.set(sessionId, {
        controlEpoch: lease.controlEpoch,
        sidecarGeneration: lease.sidecarGeneration,
        awaitingTurnStart: false,
        baselineEventIds: new Set(this.observedEventIds.get(sessionId)),
      });
    }
    try {
      const result = await lease.client.interruptSession({
        sessionId: sessionId as SessionId,
        reason: "desktop_stop",
        signal: lease.signal,
      });
      this.assertClientLease(lease);
      if (!result.interrupted) {
        this.busySessions.delete(sessionId);
        this.scheduleFlush(sessionId);
      }
      return result;
    } catch (error) {
      if (!previous) this.deleteBusyIfOwned(sessionId, lease);
      throw error;
    }
  }

  private async send(
    sessionId: string,
    text: string,
    mode: SendMode,
    lease: ClientLease,
    origin: QueuedPrompt["origin"] = "local",
  ): Promise<{ status: "accepted" | "queued"; position?: number }> {
    this.assertClientLease(lease);
    // One deadline covers all preflight reads, so two slow reads cannot each
    // consume a full deadline ahead of Stop. Mutations use the original lease.
    const { busy, resumeGoalAfterDrain } = await boundedControlRead(lease, async (signal) => {
      const readLease = { ...lease, signal };
      const busy = await this.isBusy(sessionId, readLease);
      // Even the optimistic in-memory busy fast path yields at this await.
      this.assertClientLease(readLease);
      const goal = mode === "steer"
        ? await lease.client.getGoal({ sessionId: sessionId as SessionId, signal })
        : undefined;
      this.assertClientLease(readLease);
      return { busy, resumeGoalAfterDrain: goal?.status === "active" };
    });
    this.assertClientLease(lease);
    let queue = this.queues.get(sessionId) ?? [];
    if (!busy && !resumeGoalAfterDrain && queue.length === 0) {
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

    const prompt: QueuedPrompt = { text, mode, bytes: Buffer.byteLength(text, "utf8"), origin };
    this.enqueuePrompt(sessionId, prompt, mode === "steer");
    queue = this.queues.get(sessionId) ?? [];
    this.updateQueueCount(sessionId, queue.length);
    if (mode === "steer") {
      if (resumeGoalAfterDrain) {
        this.resumeGoalsAfterDrain.set(sessionId, {
          controlEpoch: lease.controlEpoch,
          sidecarGeneration: lease.sidecarGeneration,
        });
      }
      try {
        this.assertClientLease(lease);
        const result = await lease.client.interruptSession({
          sessionId: sessionId as SessionId,
          reason: "desktop_steer",
          signal: lease.signal,
        });
        this.assertClientLease(lease);
        if (!result.interrupted) {
          if (resumeGoalAfterDrain) {
            await lease.client.updateGoal({
              sessionId: sessionId as SessionId,
              status: "paused",
              signal: lease.signal,
            });
            this.assertClientLease(lease);
          }
          this.busySessions.delete(sessionId);
          this.scheduleFlush(sessionId);
        }
      } catch (error) {
        if (resumeGoalAfterDrain) this.resumeGoalsAfterDrain.delete(sessionId);
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
    const events = await boundedControlRead(lease, (signal) => lease.client.sessionEvents({
      sessionId: sessionId as SessionId,
      limit: 5_000,
      signal,
    }));
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
      await this.resumeGoalAfterQueueDrain(sessionId, lease);
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
      if (next.origin === "remote" && !this.closing && !this.switchingWorkspace && lease.controlEpoch === this.controlEpoch) {
        this.remoteDeliveryUnknown.add(sessionId);
      }
      if (this.isClientLeaseCurrent(lease)) {
        if (next.origin === "remote") {
          // The runtime may have committed the prompt before its HTTP response
          // was lost. Never convert that uncertainty into a second execution.
          if (queue.length === 0) this.queues.delete(sessionId);
          // Keep optimistic busy until a runtime event or explicit Stop settles
          // the original run, so remaining queued prompts do not race it.
        } else {
          this.deleteBusyIfOwned(sessionId, lease);
          queue.unshift(next);
          this.accountQueuedPrompt(sessionId, next);
        }
        this.updateQueueCount(sessionId, queue.length);
        this.options.onError(next.origin === "remote"
          ? new Error("Remote queued message result is unknown; it may have started. Check the task before sending it again.")
          : error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (this.flushingSessions.get(sessionId) === lease) this.flushingSessions.delete(sessionId);
    }
  }

  private async resumeGoalAfterQueueDrain(sessionId: string, lease: ClientLease): Promise<void> {
    const marker = this.resumeGoalsAfterDrain.get(sessionId);
    if (
      !marker
      || marker.controlEpoch !== lease.controlEpoch
      || marker.sidecarGeneration !== lease.sidecarGeneration
    ) return;
    this.resumeGoalsAfterDrain.delete(sessionId);
    try {
      this.assertClientLease(lease);
      const goal = await boundedControlRead(lease, (signal) => lease.client.getGoal({ sessionId: sessionId as SessionId, signal }));
      this.assertClientLease(lease);
      if (goal?.status !== "paused") return;
      await lease.client.updateGoal({
        sessionId: sessionId as SessionId,
        status: "active",
        signal: lease.signal,
      });
      this.assertClientLease(lease);
      this.markOptimisticBusy(sessionId, lease);
    } catch (error) {
      if (this.isClientLeaseCurrent(lease)) {
        this.resumeGoalsAfterDrain.set(sessionId, marker);
        // Keep an empty queue key so a later healthy sidecar state retries the
        // deferred Goal resume without resubmitting the steer prompt.
        this.queues.set(sessionId, []);
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
      }
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
      readTimeoutMs: this.controlReadTimeoutMs,
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

/** Slow reads release the actor and cancel HTTP without timing out any mutation. */
function boundedControlRead<Value>(lease: ClientLease, read: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
  const unavailable = (): Error => new Error(
    lease.signal.reason instanceof Error && lease.signal.reason.message === "Workspace changed"
      ? "Workspace changed while the request was in progress"
      : "Desktop control is no longer available",
  );
  if (lease.signal.aborted) return Promise.reject(unavailable());
  const deadline = new AbortController();
  const signal = AbortSignal.any([lease.signal, deadline.signal]);
  return new Promise((resolveRead, rejectRead) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      finish();
      rejectRead(deadline.signal.aborted
        ? new Error("Control read timed out; retry or return to desktop")
        : unavailable());
    };
    const timer = setTimeout(() => {
      deadline.abort();
    }, lease.readTimeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw unavailable();
      return read(signal);
    }).then((value) => {
      finish();
      resolveRead(value);
    }, (error: unknown) => {
      finish();
      // Promise.all may reject while sibling HTTP reads remain pending. Cancel
      // them after removing our own listener, preserving the original failure.
      deadline.abort();
      rejectRead(error);
    });
  });
}

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
