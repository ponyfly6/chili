import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChiliEvent } from "@chili/protocol";
import type {
  ChatMessagePart,
  ChatTranscriptItem,
  RuntimeAgentTreeNode,
  RuntimeApprovalView,
  RuntimeSessionSummary,
} from "@chili/sdk";
import type {
  DesktopEvent,
  DesktopState,
  DiffScope,
  RuntimeSnapshot,
  UserInputRequest,
} from "../shared/contracts.js";
import type { ControlTransport } from "./transport.js";
import {
  RecoveryInProgressError,
  ResyncRetryLimitError,
  SupersededProjectionRequestError,
  ResyncCoordinator,
  type CoordinatedProjection,
  type ResyncBarrier,
  type SequencedProjectionFrame,
} from "./resync-coordinator.js";
import { createLatestRequestGate } from "./latest-request.js";
import {
  canEditComposer,
  canOpenSession,
  canSwitchWorkspace,
  draftScopeChanged,
  nextBoundedRetryAttempt,
  preferredSessionAfterRecovery,
  RENDERER_CREDENTIAL_BOUNDARY_COPY,
  selectWorkspaceEscapingPausedResync,
  shouldFollowTimeline,
  sidecarRecoveryGuidance,
  workspaceSelectionChangesScope,
} from "./interaction-model.js";
import { IndependentRefreshScheduler } from "./refresh-scheduler.js";
import { buildUserInputAnswers } from "./user-input-model.js";
import { appendRuntimeEvent, presentSession, runtimeEventRelated, visibleToolLiveOutput } from "./view-model.js";

type DesktopProjection = CoordinatedProjection<DesktopState, RuntimeSessionSummary, RuntimeSnapshot>;
const MAX_OUTER_RESYNC_RETRIES = 4;
const OUTER_RESYNC_RETRY_DELAY_MS = 500;

export function App({ transport }: { transport: ControlTransport }) {
  const [projection, setProjection] = useState<DesktopProjection>({
    epoch: 0,
    diffRevision: 0,
    state: {
      sidecar: { phase: "idle", attempt: 0 },
      queuedBySession: {},
    },
    sessions: [],
  });
  const [composer, setComposer] = useState("");
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [diffScope, setDiffScope] = useState<DiffScope>("turn");
  const [diffText, setDiffText] = useState("Select a session to inspect changes.");
  const [diffLoading, setDiffLoading] = useState(false);
  const [resyncRetryAvailable, setResyncRetryAvailable] = useState(false);
  const selectedRef = useRef<string | undefined>(undefined);
  const projectionRef = useRef(projection);
  const projectionRefreshes = useMemo(() => new IndependentRefreshScheduler(), []);
  const diffRefreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resyncRetryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resyncRetryAttempts = useRef(0);
  const manualResyncRetry = useRef<() => void>(() => undefined);
  const selectWorkspaceWithRecoveryEscape = useRef<(select: () => Promise<DesktopState>) => Promise<DesktopState>>(
    (select) => select(),
  );
  const actionInFlightRef = useRef(false);
  const diffRequestGate = useRef(createLatestRequestGate());
  const workspaceRef = useRef<string | undefined>(undefined);
  const sidecarPhaseRef = useRef<DesktopState["sidecar"]["phase"]>("idle");
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const followedSessionRef = useRef<string | undefined>(undefined);
  const followTimelineRef = useRef(true);

  const desktop = projection.state;
  const sessions = projection.sessions;
  const selectedId = projection.selectedId;
  const snapshot = projection.snapshot;
  const diffRevision = projection.diffRevision;
  selectedRef.current = selectedId;
  projectionRef.current = projection;
  const setDesktop = useCallback((next: DesktopState | ((current: DesktopState) => DesktopState)) => {
    setProjection((current) => ({
      ...current,
      state: typeof next === "function" ? next(current.state) : next,
    }));
  }, []);
  const setSessions = useCallback((sessionsNext: RuntimeSessionSummary[]) => {
    setProjection((current) => ({ ...current, sessions: sessionsNext }));
  }, []);
  const setSelectedId = useCallback((selectedNext: string | undefined) => {
    setProjection((current) => {
      const { selectedId: _selectedId, ...withoutSelection } = current;
      return selectedNext ? { ...withoutSelection, selectedId: selectedNext } : withoutSelection;
    });
  }, []);
  const setSnapshot = useCallback((next: RuntimeSnapshot | undefined | ((current: RuntimeSnapshot | undefined) => RuntimeSnapshot | undefined)) => {
    setProjection((current) => {
      const snapshotNext = typeof next === "function" ? next(current.snapshot) : next;
      const { snapshot: _snapshot, ...withoutSnapshot } = current;
      return snapshotNext ? { ...withoutSnapshot, snapshot: snapshotNext } : withoutSnapshot;
    });
  }, []);
  const setDiffRevision = useCallback((next: (current: number) => number) => {
    setProjection((current) => ({ ...current, diffRevision: next(current.diffRevision) }));
  }, []);
  const coordinator = useMemo(() => new ResyncCoordinator<DesktopState, RuntimeSessionSummary, RuntimeSnapshot, DesktopEvent>({
    loadState: () => transport.state(),
    listSessions: () => transport.listSessions(),
    loadSnapshot: (sessionId) => transport.snapshot(sessionId),
    canListSessions: (state) => Boolean(state.workspace) && state.sidecar.phase === "healthy",
    authorityKey: (state) => state.workspace,
    sessionId: (session) => String(session.id),
    isSessionActive: (session) => session.status === "active",
    snapshotSessionId: (value) => value.sessionId,
    snapshotEventIds: (value) => value.events.map((event) => event.id),
    frameEventId: (frame) => frame.type === "runtime.event" ? frame.event.id : undefined,
    frameRequiresRehydrate: requiresSnapshotRehydrate,
    frameRelatedToSnapshot: (frame, value) => frame.type === "runtime.event" && runtimeEventRelated(value, frame.event),
    applyFrameToSnapshot: (value, frame) => frame.type === "runtime.event"
      ? appendRuntimeEvent(value, frame.event)
      : value,
    applyFrames: applyDesktopFrames,
    publish: (next) => {
      const published = {
        ...next,
        diffRevision: Math.max(next.diffRevision, projectionRef.current.diffRevision + 1),
      };
      if (draftScopeChanged(
        { workspace: workspaceRef.current, sessionId: selectedRef.current },
        { workspace: published.state.workspace, sessionId: published.selectedId },
      )) setComposer("");
      workspaceRef.current = published.state.workspace;
      sidecarPhaseRef.current = published.state.sidecar.phase;
      selectedRef.current = published.selectedId;
      projectionRef.current = published;
      setProjection(published);
      setLoadingSession(false);
      setDiffLoading(false);
    },
    complete: async ({ barrierId }) => barrierId
      ? transport.completeResync(barrierId)
      : { status: "completed" },
    statusChanged: (status) => setResyncing(status.actionsDisabled),
  }), [transport]);
  const presentation = useMemo(
    () => snapshot && snapshot.sessionId === selectedId ? presentSession(snapshot) : undefined,
    [selectedId, snapshot],
  );
  const sessionBusy = presentation?.chat.status === "running"
    || presentation?.chat.status === "waiting_for_approval"
    || presentation?.chat.status === "cancelling";
  const healthy = desktop.sidecar.phase === "healthy";
  const actionsDisabled = working || resyncing || loadingSession;
  const runtimeActionsDisabled = actionsDisabled || !healthy;
  const composerEditable = canEditComposer({ selectedId, healthy, resyncing, loadingSession, working });
  const workspaceSwitchEnabled = canSwitchWorkspace({ working, loadingSession, resyncing, resyncRetryAvailable });
  const sidecarGuidance = sidecarRecoveryGuidance(desktop.sidecar);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    if (followedSessionRef.current !== selectedId) {
      followedSessionRef.current = selectedId;
      followTimelineRef.current = true;
    }
    if (followTimelineRef.current) timeline.scrollTop = timeline.scrollHeight;
  }, [selectedId, snapshot]);

  const openSession = useCallback(async (
    sessionId: string,
    options: { background?: boolean } = {},
  ) => {
    if (!canOpenSession({
      healthy: sidecarPhaseRef.current === "healthy",
      resyncing: coordinator.status().syncing,
    })) return;
    if (draftScopeChanged(
      { workspace: workspaceRef.current, sessionId: selectedRef.current },
      { workspace: workspaceRef.current, sessionId },
    )) setComposer("");
    selectedRef.current = sessionId;
    setSelectedId(sessionId);
    if (!options.background) {
      setSnapshot(undefined);
      setLoadingSession(true);
    }
    diffRequestGate.current.invalidate();
    setDiffLoading(false);
    setDiffText("Loading changes…");
    setError(undefined);
    try {
      const next = await coordinator.refreshSessionSnapshot(sessionId);
      if (selectedRef.current === sessionId) setSnapshot(next);
    } catch (cause) {
      if (!(cause instanceof SupersededProjectionRequestError) && !(cause instanceof RecoveryInProgressError)) {
        setError(messageFor(cause));
      }
    } finally {
      if (!options.background && selectedRef.current === sessionId && !coordinator.status().syncing) {
        setLoadingSession(false);
      }
    }
  }, [coordinator, setSelectedId, setSnapshot]);

  const refreshSessions = useCallback(async (preferredId?: string) => {
    let token;
    try {
      token = coordinator.beginRequest("sessions");
      const next = (await transport.listSessions())
        .filter((session) => session.status === "active")
        .sort((left, right) => right.updatedAt - left.updatedAt);
      coordinator.acceptResponse(token);
      setSessions(next);
      const current = selectedRef.current;
      const target = preferredId && next.some((session) => session.id === preferredId)
        ? preferredId
        : current && next.some((session) => session.id === current)
          ? current
          : next[0]?.id;
      if (!target) {
        setComposer("");
        selectedRef.current = undefined;
        setSelectedId(undefined);
        setSnapshot(undefined);
      } else if (target !== current || preferredId) {
        await openSession(target);
      }
    } catch (cause) {
      if (!(cause instanceof SupersededProjectionRequestError) && !(cause instanceof RecoveryInProgressError)) {
        setError(messageFor(cause));
      }
    }
  }, [coordinator, openSession, setSelectedId, setSessions, setSnapshot, transport]);

  const reloadSelected = useCallback(async () => {
    const current = selectedRef.current;
    if (current) await openSession(current, { background: true });
  }, [openSession]);

  useEffect(() => {
    let disposed = false;
    let recoveryGeneration = 0;
    let automaticRetriesPaused = false;
    let activeResyncBarrier: ResyncBarrier | undefined;
    const clearResyncRetryTimer = (): void => {
      if (resyncRetryTimer.current) clearTimeout(resyncRetryTimer.current);
      resyncRetryTimer.current = undefined;
    };
    const finishResync = (generation: number, outcome: "completed" | "superseded"): void => {
      if (disposed || generation !== recoveryGeneration || outcome !== "completed") return;
      automaticRetriesPaused = false;
      activeResyncBarrier = undefined;
      resyncRetryAttempts.current = 0;
      setResyncRetryAvailable(false);
      setError(undefined);
    };
    const pauseResync = (generation: number, cause: unknown): void => {
      if (disposed || generation !== recoveryGeneration || !coordinator.status().syncing) return;
      automaticRetriesPaused = true;
      setLoadingSession(false);
      setResyncRetryAvailable(true);
      setError(`Unable to resync: ${messageFor(cause)} Automatic retries paused; retry sync or switch workspace.`);
    };
    const scheduleResyncRetry = (generation: number, cause: unknown): void => {
      if (disposed || generation !== recoveryGeneration || !coordinator.status().syncing) return;
      if (cause instanceof ResyncRetryLimitError) {
        pauseResync(generation, cause);
        return;
      }
      const attempt = nextBoundedRetryAttempt(resyncRetryAttempts.current, MAX_OUTER_RESYNC_RETRIES);
      if (attempt === undefined) {
        pauseResync(generation, cause);
        return;
      }
      automaticRetriesPaused = false;
      resyncRetryAttempts.current = attempt;
      setError(`Unable to resync: ${messageFor(cause)} Retrying ${attempt}/${MAX_OUTER_RESYNC_RETRIES}…`);
      resyncRetryTimer.current = setTimeout(
        () => retryResync(generation, false),
        OUTER_RESYNC_RETRY_DELAY_MS,
      );
    };
    const retryResync = (generation: number, resetCompletionBudget: boolean): void => {
      if (disposed || generation !== recoveryGeneration || !coordinator.status().syncing) return;
      void Promise.resolve()
        .then(() => coordinator.retry(resetCompletionBudget ? { resetCompletionBudget: true } : {}))
        .then((outcome) => {
          finishResync(generation, outcome);
        })
        .catch((cause) => {
          scheduleResyncRetry(generation, cause);
        });
    };
    const startResync = (barrier: ResyncBarrier): void => {
      if (disposed) return;
      const generation = ++recoveryGeneration;
      automaticRetriesPaused = false;
      activeResyncBarrier = barrier;
      clearResyncRetryTimer();
      resyncRetryAttempts.current = 0;
      setResyncRetryAvailable(false);
      projectionRefreshes.cancel();
      if (diffRefreshTimer.current) clearTimeout(diffRefreshTimer.current);
      diffRefreshTimer.current = undefined;
      diffRequestGate.current.invalidate();
      setLoadingSession(Boolean(selectedRef.current));
      setDiffLoading(false);
      setDiffText(selectedRef.current ? "Resyncing changes…" : "Select a session to inspect changes.");
      setError(undefined);
      void coordinator.barrier(barrier).then((outcome) => {
        finishResync(generation, outcome);
      }).catch((cause) => {
        scheduleResyncRetry(generation, cause);
      });
    };
    manualResyncRetry.current = () => {
      if (disposed || !coordinator.status().syncing) return;
      clearResyncRetryTimer();
      automaticRetriesPaused = false;
      resyncRetryAttempts.current = 0;
      setLoadingSession(Boolean(selectedRef.current));
      setResyncRetryAvailable(false);
      setError("Retrying projection sync…");
      retryResync(recoveryGeneration, true);
    };
    selectWorkspaceWithRecoveryEscape.current = (selectWorkspace) => selectWorkspaceEscapingPausedResync({
      syncing: coordinator.status().syncing,
      retryPaused: automaticRetriesPaused,
      barrier: activeResyncBarrier,
      cancelRetryTimer: clearResyncRetryTimer,
      cancelBarrier: () => {
        recoveryGeneration += 1;
        automaticRetriesPaused = false;
        activeResyncBarrier = undefined;
        resyncRetryAttempts.current = 0;
        setResyncRetryAvailable(false);
        projectionRefreshes.cancel();
        if (diffRefreshTimer.current) clearTimeout(diffRefreshTimer.current);
        diffRefreshTimer.current = undefined;
        diffRequestGate.current.invalidate();
        coordinator.cancel();
      },
      selectWorkspace,
      resumeBarrier: startResync,
    });
    const unsubscribe = transport.subscribe((envelope) => {
      coordinator.recordFrame({ sequence: envelope.sequence, frame: envelope.event });
      const event = envelope.event;
      if (event.type === "runtime.resync") {
        startResync({
          sequence: envelope.sequence,
          barrierId: event.barrierId,
          ...(selectedRef.current ? { preferredSessionId: selectedRef.current } : {}),
        });
        return;
      }
      if (coordinator.status().syncing) return;
      if (event.type === "state.changed") {
        const previousHealthy = sidecarPhaseRef.current === "healthy";
        sidecarPhaseRef.current = event.state.sidecar.phase;
        const workspaceChanged = workspaceRef.current !== event.state.workspace;
        coordinator.invalidateRequests("state");
        if (event.state.sidecar.phase !== "healthy") {
          coordinator.invalidateRequests("sessions", "snapshot", "diff");
          diffRequestGate.current.invalidate();
          setDiffLoading(false);
          if (selectedRef.current) setDiffText("Runtime unavailable; changes will refresh after recovery.");
        }
        if (workspaceChanged) {
          setComposer("");
          workspaceRef.current = event.state.workspace;
          coordinator.invalidateRequests("sessions", "snapshot", "diff");
          diffRequestGate.current.invalidate();
          selectedRef.current = undefined;
          setProjection((current) => ({
            epoch: current.epoch,
            diffRevision: current.diffRevision + 1,
            state: event.state,
            sessions: [],
          }));
          setLoadingSession(false);
          setDiffLoading(false);
          setDiffText("Select a session to inspect changes.");
        } else {
          setDesktop(event.state);
        }
        if (event.state.sidecar.phase === "healthy"
          && (workspaceChanged || !previousHealthy)) {
          const preferred = workspaceChanged
            ? undefined
            : preferredSessionAfterRecovery(
                previousHealthy,
                true,
                selectedRef.current,
              );
          void refreshSessions(preferred);
        }
        return;
      }
      if (event.type === "queue.changed") {
        coordinator.invalidateRequests("state");
        setDesktop((current) => ({
          ...current,
          queuedBySession: {
            ...current.queuedBySession,
            [event.sessionId]: event.count,
          },
        }));
        return;
      }
      setSnapshot((current) => {
        if (!current || !runtimeEventRelated(current, event.event)) return current;
        return appendRuntimeEvent(current, event.event);
      });
      if (refreshesDiff(event.event)) {
        if (diffRefreshTimer.current) clearTimeout(diffRefreshTimer.current);
        diffRefreshTimer.current = setTimeout(() => setDiffRevision((current) => current + 1), 100);
      }
      if (event.event.type.startsWith("session.")) {
        projectionRefreshes.sessions(() => void refreshSessions());
      } else if (event.event.type.startsWith("agent.") || event.event.type.startsWith("task.")
        || event.event.type === "user_input.requested" || event.event.type === "user_input.resolved"
        || event.event.type === "user_input.cancelled") {
        projectionRefreshes.snapshot(() => void reloadSelected());
      }
    });
    let stateToken;
    try {
      stateToken = coordinator.beginRequest("state");
    } catch {
      stateToken = undefined;
    }
    if (stateToken) {
      void transport.state().then((state) => {
        if (disposed || !stateToken) return;
        coordinator.acceptResponse(stateToken);
        workspaceRef.current = state.workspace;
        sidecarPhaseRef.current = state.sidecar.phase;
        setDesktop(state);
        if (state.sidecar.phase === "healthy") void refreshSessions();
      }).catch((cause) => {
        if (!disposed && !(cause instanceof SupersededProjectionRequestError)) setError(messageFor(cause));
      });
    }
    return () => {
      disposed = true;
      recoveryGeneration += 1;
      automaticRetriesPaused = false;
      activeResyncBarrier = undefined;
      manualResyncRetry.current = () => undefined;
      selectWorkspaceWithRecoveryEscape.current = (select) => select();
      unsubscribe();
      projectionRefreshes.cancel();
      if (diffRefreshTimer.current) clearTimeout(diffRefreshTimer.current);
      diffRefreshTimer.current = undefined;
      clearResyncRetryTimer();
      diffRequestGate.current.invalidate();
      coordinator.cancel();
    };
  }, [coordinator, projectionRefreshes, refreshSessions, reloadSelected, setDesktop, setSnapshot, transport]);

  useEffect(() => {
    const isCurrent = diffRequestGate.current.begin();
    if (!selectedId || !healthy || resyncing || loadingSession || snapshot?.sessionId !== selectedId) {
      setDiffLoading(false);
      if (!selectedId) setDiffText("Select a session to inspect changes.");
      return () => diffRequestGate.current.invalidate();
    }
    let requestToken;
    try {
      requestToken = coordinator.beginRequest("diff");
    } catch {
      setDiffLoading(false);
      return () => diffRequestGate.current.invalidate();
    }
    setDiffLoading(true);
    void transport.diff(diffScope, selectedId, presentation?.latestTurnId)
      .then((result) => {
        if (isCurrent() && requestToken && coordinator.isRequestCurrent(requestToken)) setDiffText(result.text);
      })
      .catch((cause) => {
        if (isCurrent() && requestToken && coordinator.isRequestCurrent(requestToken)) {
          setDiffText(`Unable to load diff: ${messageFor(cause)}`);
        }
      })
      .finally(() => {
        if (isCurrent() && requestToken && coordinator.isRequestCurrent(requestToken)) setDiffLoading(false);
      });
    return () => diffRequestGate.current.invalidate();
  }, [coordinator, diffRevision, diffScope, healthy, loadingSession, presentation?.latestTurnId, resyncing, selectedId, snapshot?.sessionId, transport]);

  const chooseWorkspace = async () => runAction(async () => {
    diffRequestGate.current.invalidate();
    coordinator.invalidateRequests();
    const previousWorkspace = workspaceRef.current;
    let stateToken;
    const state = await selectWorkspaceWithRecoveryEscape.current(async () => {
      stateToken = coordinator.beginRequest("state");
      return transport.selectWorkspace();
    });
    if (!stateToken || !coordinator.isRequestCurrent(stateToken)) return;
    const workspaceChanged = workspaceSelectionChangesScope(previousWorkspace, state.workspace);
    workspaceRef.current = state.workspace;
    sidecarPhaseRef.current = state.sidecar.phase;
    if (workspaceChanged) {
      setComposer("");
      selectedRef.current = undefined;
      setProjection((current) => ({
        epoch: current.epoch,
        diffRevision: current.diffRevision + 1,
        state,
        sessions: [],
      }));
      setLoadingSession(false);
      setDiffLoading(false);
      setDiffText("Select a session to inspect changes.");
    } else {
      setDesktop(state);
    }
    if (state.sidecar.phase === "healthy") await refreshSessions();
  });

  const createSession = async () => runAction(async () => {
    const created = await transport.createSession();
    await refreshSessions(created.sessionId);
  });

  const submit = async (mode: "queue" | "steer") => {
    const text = composer.trim();
    if (!selectedId || !text || !composerEditable || actionInFlightRef.current) return;
    await runAction(async () => {
      await transport.send(selectedId, text, mode);
      setComposer("");
    });
  };

  const stop = async () => {
    if (!selectedId) return;
    await runAction(async () => {
      await transport.stop(selectedId);
    });
  };

  const resolveApproval = async (
    approvalId: string,
    decision: "allow_once" | "allow_session" | "allow_always" | "deny",
  ) => runAction(async () => {
    await transport.resolveApproval(approvalId, decision);
    await reloadSelected();
  });

  async function runAction(action: () => Promise<void>): Promise<void> {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setWorking(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      actionInFlightRef.current = false;
      setWorking(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">C</span>
          <span>Chili Control</span>
        </div>
        <div className={`runtime-pill phase-${desktop.sidecar.phase}`}>
          <span className="status-dot" aria-hidden="true" />
          {desktop.sidecar.phase}
          {desktop.sidecar.attempt > 0 ? ` · retry ${desktop.sidecar.attempt}` : ""}
        </div>
      </header>

      <div className="status-stack">
        {error || resyncRetryAvailable ? (
          <div className="error-banner" role="alert">
            <span>{error ?? "Projection sync is paused. Retry when the runtime is ready."}</span>
            <div className="banner-actions">
              {resyncRetryAvailable && resyncing ? (
                <>
                  <button onClick={() => manualResyncRetry.current()}>Retry sync</button>
                  <button className="secondary" disabled={!workspaceSwitchEnabled} onClick={() => void chooseWorkspace()}>
                    Switch workspace…
                  </button>
                </>
              ) : null}
              {error ? <button onClick={() => setError(undefined)}>Dismiss</button> : null}
            </div>
          </div>
        ) : null}

        {sidecarGuidance ? (
          <div className="runtime-guidance" role={desktop.sidecar.phase === "error" ? "alert" : "status"}>
            <span>{sidecarGuidance.message}</span>
            <button className="secondary" disabled={!workspaceSwitchEnabled} onClick={() => void chooseWorkspace()}>
              {sidecarGuidance.actionLabel}
            </button>
          </div>
        ) : null}
      </div>

      <main className="workspace-grid">
        <aside className="sidebar panel">
          <section className="workspace-picker">
            <p className="eyebrow">Workspace</p>
            <p className="workspace-path" title={desktop.workspace}>{desktop.workspace ?? "No project selected"}</p>
            <button className="secondary full" disabled={!workspaceSwitchEnabled} onClick={() => void chooseWorkspace()}>
              {desktop.workspace ? "Switch project…" : "Choose project…"}
            </button>
          </section>

          <section className="session-section">
            <div className="section-heading">
              <div><p className="eyebrow">Sessions</p><span>{sessions.length} active</span></div>
              <button className="icon-button" title="New session" aria-label="New session" disabled={!healthy || actionsDisabled} onClick={() => void createSession()}>+</button>
            </div>
            <div className="session-list">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  className={`session-row ${selectedId === session.id ? "selected" : ""}`}
                  disabled={!canOpenSession({ healthy, resyncing })}
                  onClick={() => void openSession(session.id)}
                >
                  <span className="session-title">{session.title || session.preview || "Untitled session"}</span>
                  <span className="session-meta">
                    {shortId(session.id)}
                    {(desktop.queuedBySession[session.id] ?? 0) > 0 ? ` · ${desktop.queuedBySession[session.id]} queued` : ""}
                  </span>
                </button>
              ))}
              {healthy && sessions.length === 0 ? <p className="empty-copy">Create a session to start a local task.</p> : null}
              {!healthy ? <p className="empty-copy">Choose a project and wait for the local runtime.</p> : null}
            </div>
          </section>
        </aside>

        <section className="conversation panel">
          <div className="conversation-heading">
            <div>
              <p className="eyebrow">Timeline</p>
              <h1>{selectedId ? sessions.find((session) => session.id === selectedId)?.title || "Development session" : "Ready when you are"}</h1>
            </div>
            {presentation ? <span className={`session-status status-${presentation.chat.status}`}>{presentation.chat.status.replaceAll("_", " ")}</span> : null}
          </div>

          <div
            className="timeline"
            aria-live="polite"
            ref={timelineRef}
            onScroll={(event) => {
              const timeline = event.currentTarget;
              followTimelineRef.current = shouldFollowTimeline({
                scrollTop: timeline.scrollTop,
                scrollHeight: timeline.scrollHeight,
                clientHeight: timeline.clientHeight,
              });
            }}
          >
            {loadingSession ? <p className="empty-copy centered">Restoring timeline…</p> : null}
            {!loadingSession && presentation?.chat.items.map((item) => <TimelineItem key={`${item.kind}:${item.id}`} item={item} />)}
            {!loadingSession && selectedId && presentation?.chat.items.length === 0 ? <p className="empty-copy centered">Send a message to begin this session.</p> : null}
            {!selectedId ? (
              <div className="welcome-card">
                <span className="welcome-mark">⌘</span>
                <h2>Local runtime, desktop control.</h2>
                <p>Choose a workspace, create a session, and steer Chili while it works. {RENDERER_CREDENTIAL_BOUNDARY_COPY}</p>
              </div>
            ) : null}
          </div>

          {presentation && presentation.pendingApprovals.length > 0 ? (
            <div className="blocking-dock">
              {presentation.pendingApprovals.map((approval) => (
                <ApprovalCard key={approval.id} approval={approval} disabled={runtimeActionsDisabled} resolve={resolveApproval} />
              ))}
            </div>
          ) : null}

          {presentation && presentation.pendingInputs.length > 0 ? (
            <div className="blocking-dock">
              {presentation.pendingInputs.map((input) => (
                <UserInputCard
                  key={input.id}
                  request={input}
                  disabled={runtimeActionsDisabled}
                  submit={(answers) => runAction(async () => {
                    await transport.resolveUserInput(input.id, answers);
                    await reloadSelected();
                  })}
                />
              ))}
            </div>
          ) : null}

          <div className="composer">
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (composerEditable && (event.metaKey || event.ctrlKey) && event.key === "Enter") void submit("queue");
              }}
              placeholder={selectedId ? "Message Chili…  ⌘↵ to send" : "Create or select a session first"}
              disabled={!composerEditable}
              rows={3}
            />
            <div className="composer-actions">
              <span>{desktop.queuedBySession[selectedId ?? ""] ?? 0} queued</span>
              <div>
                <button className="danger" disabled={!selectedId || !sessionBusy || runtimeActionsDisabled} onClick={() => void stop()}>Stop</button>
                <button className="secondary" disabled={!composer.trim() || !selectedId || runtimeActionsDisabled} onClick={() => void submit("steer")}>Steer</button>
                <button className="primary" disabled={!composer.trim() || !selectedId || runtimeActionsDisabled} onClick={() => void submit("queue")}>{sessionBusy ? "Queue" : "Send"}</button>
              </div>
            </div>
          </div>
        </section>

        <aside className="inspector panel">
          {snapshot?.truncated ? (
            <p className="empty-copy">{snapshot.warning ?? "This large session snapshot was truncated for desktop safety."}</p>
          ) : null}
          <section className="inspector-section">
            <div className="section-heading compact"><p className="eyebrow">Agents</p><span>{snapshot?.agentTree.agents.length ?? 0}</span></div>
            <div className="agent-tree">
              {snapshot?.agentTree.nodes.flatMap((node) => renderAgentNode(node))}
              {snapshot && snapshot.agentTree.nodes.length === 0 ? <p className="empty-copy">No delegated agents.</p> : null}
            </div>
          </section>

          <section className="inspector-section task-section">
            <div className="section-heading compact"><p className="eyebrow">Tasks</p><span>{snapshot?.tasks.length ?? 0}</span></div>
            <div className="task-list">
              {snapshot?.tasks.map((task) => (
                <div className="task-row" key={task.id}>
                  <span className={`task-state task-${task.status}`} />
                  <div><strong>{task.taskName}</strong><span>{task.status}{task.summary ? ` · ${task.summary}` : ""}</span></div>
                </div>
              ))}
              {snapshot && snapshot.tasks.length === 0 ? <p className="empty-copy">No tasks recorded.</p> : null}
            </div>
          </section>

          <section className="inspector-section diff-section">
            <div className="section-heading compact">
              <p className="eyebrow">Changes</p>
              <div className="segmented">
                <button className={diffScope === "turn" ? "active" : ""} onClick={() => setDiffScope("turn")}>Turn</button>
                <button className={diffScope === "workspace" ? "active" : ""} onClick={() => setDiffScope("workspace")}>Workspace</button>
              </div>
            </div>
            <pre className="diff-view">{diffLoading ? "Loading changes…" : diffText}</pre>
          </section>
        </aside>
      </main>
    </div>
  );
}

function TimelineItem({ item }: { item: ChatTranscriptItem }) {
  if (item.kind === "message") {
    return (
      <article className={`timeline-item message message-${item.role}`}>
        <header><strong>{item.role === "assistant" ? "Chili" : item.role === "user" ? "You" : item.role}</strong><time>{formatTime(item.createdAt)}</time></header>
        <div className="message-body">{item.parts.map((part) => <MessagePart key={part.id} part={part} />)}</div>
      </article>
    );
  }
  if (item.kind === "tool") {
    const liveOutput = visibleToolLiveOutput(item.output, item.liveOutput);
    return (
      <article className="timeline-item tool-card">
        <header><strong>{item.inputSummary.title || item.toolName}</strong><span className={`tool-status tool-${item.displayStatus}`}>{item.displayStatus.replaceAll("_", " ")}</span></header>
        {item.inputSummary.detail ? <p>{item.inputSummary.detail}</p> : null}
        {liveOutput ? <pre className="tool-live-output" aria-live="polite">{liveOutput}</pre> : null}
        {item.output ? <pre>{item.output}</pre> : null}
        {item.error ? <pre className="tool-error">{item.error}</pre> : null}
      </article>
    );
  }
  return (
    <article className="timeline-item approval-history">
      <header><strong>Approval · {item.permission}</strong><span>{item.status}</span></header>
      <p>{item.patterns.join(", ") || "No pattern details"}</p>
    </article>
  );
}

function MessagePart({ part }: { part: ChatMessagePart }) {
  if (part.type === "text") return <p>{part.text}</p>;
  if (part.type === "reasoning") return <details><summary>Reasoning</summary><p>{part.text}</p></details>;
  if (part.type === "summary") return <p className="summary-part">{part.text}</p>;
  if (part.type === "image") return <p className="attachment">Image · {part.filename ?? part.mimeType}</p>;
  if (part.type === "tool_call") return <p className="inline-tool">{part.toolName} · {part.displayStatus ?? part.status}</p>;
  return <pre className={part.error ? "tool-error" : ""}>{part.error ?? part.output}</pre>;
}

function ApprovalCard({
  approval,
  disabled,
  resolve: resolveRequest,
}: {
  approval: RuntimeApprovalView;
  disabled: boolean;
  resolve: (id: string, decision: "allow_once" | "allow_session" | "allow_always" | "deny") => Promise<void>;
}) {
  const allowSession = approval.maxApprovalScope === "session" || approval.maxApprovalScope === "persistent";
  const allowAlways = approval.maxApprovalScope === "persistent";
  return (
    <section className="request-card approval-card">
      <div><p className="eyebrow">Approval required · {shortId(approval.sessionId ?? "")}</p><h3>{approval.permission}</h3><p>{approval.patterns.join(", ") || "This action needs permission."}</p></div>
      <div className="request-actions">
        <button className="danger" disabled={disabled} onClick={() => void resolveRequest(approval.id, "deny")}>Deny</button>
        <button className="secondary" disabled={disabled} onClick={() => void resolveRequest(approval.id, "allow_once")}>Allow once</button>
        {allowSession ? <button className="secondary" disabled={disabled} onClick={() => void resolveRequest(approval.id, "allow_session")}>Allow session</button> : null}
        {allowAlways ? <button className="primary" disabled={disabled} onClick={() => void resolveRequest(approval.id, "allow_always")}>Always allow</button> : null}
      </div>
    </section>
  );
}

function UserInputCard({
  request,
  disabled,
  submit,
}: {
  request: UserInputRequest;
  disabled: boolean;
  submit: (answers: Record<string, string[]>) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const answers = buildUserInputAnswers(request, selected, custom);
  const complete = Object.values(answers).every((values) => values.length > 0);

  return (
    <section className="request-card input-card">
      <p className="eyebrow">Input requested · {shortId(request.sessionId)}</p>
      {request.questions.map((question) => (
        <fieldset key={question.id}>
          <legend><span>{question.header}</span>{question.question}</legend>
          <div className="choice-list">
            {question.options.map((option) => {
              const active = selected[question.id]?.includes(option.label) ?? false;
              return (
                <button
                  type="button"
                  key={option.label}
                  className={active ? "choice active" : "choice"}
                  aria-pressed={active}
                  onClick={() => {
                    setSelected((current) => ({
                      ...current,
                      [question.id]: question.multiple
                        ? active
                          ? (current[question.id] ?? []).filter((label) => label !== option.label)
                          : [...(current[question.id] ?? []), option.label]
                        : [option.label],
                    }));
                    if (!question.multiple) setCustom((current) => ({ ...current, [question.id]: "" }));
                  }}
                >
                  <strong>{option.label}</strong>{option.description ? <span>{option.description}</span> : null}
                </button>
              );
            })}
          </div>
          <input
            value={custom[question.id] ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              setCustom((current) => ({ ...current, [question.id]: value }));
              if (!question.multiple && value.trim()) {
                setSelected((current) => ({ ...current, [question.id]: [] }));
              }
            }}
            placeholder="Or type an answer…"
          />
        </fieldset>
      ))}
      <div className="request-actions"><button className="primary" disabled={disabled || !complete} onClick={() => void submit(answers)}>Submit answer</button></div>
    </section>
  );
}

function renderAgentNode(node: RuntimeAgentTreeNode, depth = 0): ReactNode[] {
  return [
    <div className="agent-row" key={node.path}>
      <span className="tree-prefix" aria-hidden="true">{`${"· ".repeat(depth)}${depth ? "↳" : "●"}`}</span>
      <div><strong>{node.taskName || node.path}</strong><span>{node.status} · {node.path}</span></div>
    </div>,
    ...node.children.flatMap((child) => renderAgentNode(child, depth + 1)),
  ];
}

function shortId(value: string): string {
  if (!value) return "root";
  return value.length <= 12 ? value : value.slice(-10);
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function refreshesDiff(event: ChiliEvent): boolean {
  return event.type === "tool.call_finished"
    || event.type === "snapshot.reverted"
    || event.type === "turn.completed"
    || event.type === "turn.compaction_completed"
    || event.type === "turn.compaction_failed"
    || event.type === "session.status_changed";
}

function applyDesktopFrames(
  projection: DesktopProjection,
  frames: readonly SequencedProjectionFrame<DesktopEvent>[],
): DesktopProjection {
  return frames.reduce((current, input) => {
    const frame = input.frame;
    if (frame.type === "state.changed") return { ...current, state: frame.state };
    if (frame.type === "queue.changed") {
      return {
        ...current,
        state: {
          ...current.state,
          queuedBySession: {
            ...current.state.queuedBySession,
            [frame.sessionId]: frame.count,
          },
        },
      };
    }
    if (frame.type !== "runtime.event" || !current.snapshot
      || !runtimeEventRelated(current.snapshot, frame.event)) return current;
    return { ...current, snapshot: appendRuntimeEvent(current.snapshot, frame.event) };
  }, projection);
}

function requiresSnapshotRehydrate(frame: DesktopEvent): boolean {
  if (frame.type !== "runtime.event") return false;
  return frame.event.type.startsWith("session.")
    || frame.event.type.startsWith("agent.")
    || frame.event.type.startsWith("task.")
    || frame.event.type === "user_input.requested"
    || frame.event.type === "user_input.resolved"
    || frame.event.type === "user_input.cancelled";
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
