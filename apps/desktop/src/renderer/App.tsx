import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { RemoteControlPanel } from "./RemoteControlPanel.js";
import { ProjectSidebar } from "./ProjectSidebar.js";
import { AgentDetailsPanel } from "./AgentDetailsPanel.js";
import { DiffViewer } from "./DiffViewer.js";
import { TimelineViewport } from "./TimelineViewport.js";
import { eventMatchesProject, ProjectViewMemory } from "./project-view-state.js";
import { desktopThemeOptions, type DesktopTheme } from "./theme.js";
import { useDesktopTheme } from "./useDesktopTheme.js";
import { getDesktopBuildInfo } from "../shared/build-info.js";
import { SESSION_TITLE_MAX_CHARS } from "@chili/protocol";
import type {
  ChiliEvent,
  DelegationPolicy,
  ReasoningLevel,
  RuntimeModelDescriptor,
  RuntimePermissionConfig,
  RuntimePermissionProfileId,
  SessionGoal,
  SessionGoalStatus,
} from "@chili/protocol";
import type {
  ChatMessagePart,
  ChatTranscriptItem,
  RuntimeApprovalView,
  RuntimeSessionSummary,
} from "@chili/sdk";
import type {
  DesktopCreateSessionResult,
  DesktopEvent,
  DesktopSessionConfig,
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
import { isMenuNavigationKey, menuNavigationTarget, trappedTabTarget } from "./keyboard-navigation.js";
import {
  sessionConfigAfterSelectionChange,
  sessionConfigResponseForSelection,
} from "./session-config-state.js";
import {
  canEditComposer,
  canOpenSession,
  canSwitchWorkspace,
  draftScopeChanged,
  nextBoundedRetryAttempt,
  preferredSessionAfterRecovery,
  RENDERER_CREDENTIAL_BOUNDARY_COPY,
  selectWorkspaceEscapingPausedResync,
  sidecarRecoveryGuidance,
  workspaceSelectionChangesScope,
} from "./interaction-model.js";
import { IndependentRefreshScheduler } from "./refresh-scheduler.js";
import { buildUserInputAnswers } from "./user-input-model.js";
import {
  appendRuntimeEvent,
  desktopTimelineItems,
  presentSession,
  runtimeEventRelated,
  visibleToolLiveOutput,
  type DesktopTimelineItem,
  type DesktopWorkItem,
} from "./view-model.js";
import {
  availableReasoningLevels,
  availableServiceTiers,
  canExposeTaskActions,
  canReloadSessionMcp,
  canResumeTask,
  canSelectProviderDefault,
  createNewTaskDraft,
  createSessionModelSettingsDraft,
  filterSessions,
  goalResumeBudgetMinimum,
  goalProgress,
  hydrateNewTaskChoices,
  modelFromKey,
  modelKey,
  newTaskSubmission,
  reconcileNewTaskModel,
  reconcileSessionModelSettingsModel,
  sessionModelSettingsMutations,
  validateNewTaskDraft,
  validateSessionModelSettingsDraft,
  type NewTaskDraft,
  type ReasoningSelection,
  type ServiceTierSelection,
  type SessionModelSettingsDraft,
  type SessionListStatus,
} from "./task-console-model.js";

type DesktopProjection = CoordinatedProjection<DesktopState, RuntimeSessionSummary, RuntimeSnapshot>;
const MAX_OUTER_RESYNC_RETRIES = 4;
const OUTER_RESYNC_RETRY_DELAY_MS = 500;

interface SessionSettingsValues extends SessionModelSettingsDraft {
  permissionProfile: RuntimePermissionProfileId;
  delegationPolicy: DelegationPolicy;
}

export function App({ transport: hostTransport }: { transport: ControlTransport }) {
  const buildInfo = getDesktopBuildInfo();
  const { theme, changeTheme, saveFailed: themeSaveFailed, saving: themeSaving } = useDesktopTheme();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
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
  const transport = useMemo(() => projection.state.projectId && hostTransport.forProject
    ? hostTransport.forProject(projection.state.projectId) : hostTransport, [hostTransport, projection.state.projectId]);
  const projectViews = useRef(new ProjectViewMemory());
  const requestedProjectSession = useRef<{ projectId: string; sessionId: string } | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [diffScope, setDiffScope] = useState<DiffScope>("turn");
  const [diffView, setDiffView] = useState<{ text: string; truncated: boolean; scope?: string }>({
    text: "Select a session to inspect changes.", truncated: false,
  });
  const setDiffText = useCallback((text: string) => setDiffView({ text, truncated: false }), []);
  const [diffLoading, setDiffLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 640);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 1080);
  const [inspectorTab, setInspectorTab] = useState<"activity" | "changes">("activity");
  const [resyncRetryAvailable, setResyncRetryAvailable] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionListStatus, setSessionListStatus] = useState<SessionListStatus>("active");
  const [taskMenuId, setTaskMenuId] = useState<string>();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskChoicesLoading, setNewTaskChoicesLoading] = useState(false);
  const [newTaskChoicesReady, setNewTaskChoicesReady] = useState(false);
  const [newTaskDraft, setNewTaskDraft] = useState<NewTaskDraft>(() => createNewTaskDraft());
  const [models, setModels] = useState<RuntimeModelDescriptor[]>([]);
  const [newTaskPermissionConfig, setNewTaskPermissionConfig] = useState<RuntimePermissionConfig>();
  const [sessionConfigState, setSessionConfig] = useState<DesktopSessionConfig>();
  const [configLoading, setConfigLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RuntimeSessionSummary>();
  const [archiveTarget, setArchiveTarget] = useState<RuntimeSessionSummary>();
  const [goalSetupOpen, setGoalSetupOpen] = useState(false);
  const [goalBudgetOpen, setGoalBudgetOpen] = useState(false);
  const taskMenuButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const taskMenuRef = useRef<HTMLDivElement | null>(null);
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const selectedRef = useRef<string | undefined>(undefined);
  const projectionRef = useRef(projection);
  const projectionRefreshes = useMemo(() => new IndependentRefreshScheduler(), []);
  const diffRefreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const configRefreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resyncRetryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resyncRetryAttempts = useRef(0);
  const manualResyncRetry = useRef<() => void>(() => undefined);
  const selectWorkspaceWithRecoveryEscape = useRef<(select: () => Promise<DesktopState>) => Promise<DesktopState>>(
    (select) => select(),
  );
  const actionInFlightRef = useRef(false);
  const diffRequestGate = useRef(createLatestRequestGate());
  const configRequestGate = useRef(createLatestRequestGate());
  const newTaskChoicesGate = useRef(createLatestRequestGate());
  const workspaceRef = useRef<string | undefined>(undefined);
  const sidecarPhaseRef = useRef<DesktopState["sidecar"]["phase"]>("idle");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const closeSidebar = useCallback(() => {
    if (sidebarRef.current?.contains(document.activeElement)) sidebarToggleRef.current?.focus({ preventScroll: true });
    setSidebarOpen(false);
  }, []);
  const closeInspector = useCallback(() => {
    if (inspectorRef.current?.contains(document.activeElement)) inspectorToggleRef.current?.focus({ preventScroll: true });
    setInspectorOpen(false);
  }, []);

  const desktop = projection.state;
  const sessions = projection.sessions;
  const selectedId = projection.selectedId;
  const snapshot = projection.snapshot;
  useEffect(() => {
    projectViews.current.remember(desktop.workspace, selectedId, composer);
  }, [desktop.workspace, selectedId, composer]);
  const diffRevision = projection.diffRevision;
  const sessionConfig = sessionConfigState
    ? sessionConfigResponseForSelection(selectedId, sessionConfigState)
    : undefined;
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
    const selectedPrevious = selectedRef.current;
    selectedRef.current = selectedNext;
    setSessionConfig((current) => sessionConfigAfterSelectionChange(selectedPrevious, selectedNext, current));
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
  const projectTransport = useCallback((state = projectionRef.current.state) => state.projectId && hostTransport.forProject
    ? hostTransport.forProject(state.projectId) : hostTransport, [hostTransport]);
  const coordinator = useMemo(() => new ResyncCoordinator<DesktopState, RuntimeSessionSummary, RuntimeSnapshot, DesktopEvent>({
    loadState: () => hostTransport.state(),
    listSessions: (state) => projectTransport(state).listSessions(),
    loadSnapshot: (sessionId, state) => projectTransport(state).snapshot(sessionId),
    preferredSessionId: (state) => {
      const requested = requestedProjectSession.current;
      return requested?.projectId === state.projectId ? requested?.sessionId
        : state.workspace === workspaceRef.current ? selectedRef.current ?? projectViews.current.read(state.workspace)?.sessionId
          : projectViews.current.read(state.workspace)?.sessionId;
    },
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
      )) {
        const saved = projectViews.current.read(published.state.workspace);
        setComposer(saved && saved.sessionId === published.selectedId ? saved.draft : "");
      }
      const projectChanged = workspaceRef.current !== published.state.workspace;
      workspaceRef.current = published.state.workspace;
      sidecarPhaseRef.current = published.state.sidecar.phase;
      const previousSelectedId = selectedRef.current;
      selectedRef.current = published.selectedId;
      setSessionConfig((current) => projectChanged ? undefined : sessionConfigAfterSelectionChange(
        previousSelectedId,
        published.selectedId,
        current,
      ));
      projectionRef.current = published;
      setProjection(published);
      setLoadingSession(false);
      setDiffLoading(false);
    },
    complete: async ({ barrierId }) => barrierId
      ? hostTransport.completeResync(barrierId)
      : { status: "completed" },
    statusChanged: (status) => setResyncing(status.actionsDisabled),
  }), [hostTransport, projectTransport]);
  const presentation = useMemo(
    () => snapshot && snapshot.sessionId === selectedId ? presentSession(snapshot) : undefined,
    [selectedId, snapshot],
  );
  const timelineItems = useMemo(
    () => presentation ? desktopTimelineItems(presentation.chat, presentation.runtime) : [],
    [presentation],
  );
  const sessionBusy = presentation?.chat.status === "running"
    || presentation?.chat.status === "waiting_for_approval"
    || presentation?.chat.status === "cancelling";
  const selectedSession = sessions.find((session) => session.id === selectedId);
  const selectedArchived = selectedSession?.status === "archived";
  const healthy = desktop.sidecar.phase === "healthy";
  const actionsDisabled = working || resyncing || loadingSession;
  const runtimeActionsDisabled = actionsDisabled || !healthy;
  const composerEditable = !selectedArchived
    && canEditComposer({ selectedId, healthy, resyncing, loadingSession, working });
  const workspaceSwitchEnabled = canSwitchWorkspace({ working, loadingSession, resyncing, resyncRetryAvailable });
  const sidecarGuidance = sidecarRecoveryGuidance(desktop.sidecar);
  const selectedTitle = selectedSession?.title || selectedSession?.preview || "Development session";
  const projectLabel = workspaceLabel(desktop.workspace);
  const visibleSessions = useMemo(
    () => filterSessions(sessions, sessionQuery, sessionListStatus),
    [sessionListStatus, sessionQuery, sessions],
  );
  const selectedModel = sessionConfig?.model.modelSelection;
  const selectedGoal = sessionConfig?.goal ?? undefined;
  const canResumeSession = canResumeTask(presentation?.chat.status, selectedGoal?.status, Boolean(selectedArchived));
  const mcpReloadEnabled = canReloadSessionMcp(selectedId, Boolean(selectedArchived), runtimeActionsDisabled);

  useEffect(() => {
    if (!composer && composerRef.current) composerRef.current.style.height = "";
  }, [composer]);

  useEffect(() => {
    let previousWidth = window.innerWidth;
    const handleResize = (): void => {
      const width = window.innerWidth;
      if (previousWidth > 1080 && width <= 1080) closeInspector();
      if (previousWidth > 640 && width <= 640) closeSidebar();
      previousWidth = width;
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [closeInspector, closeSidebar]);

  useEffect(() => {
    if (!taskMenuId) return;
    const menu = taskMenuRef.current;
    const trigger = taskMenuButtonRefs.current.get(taskMenuId);
    if (!menu || !trigger) {
      setTaskMenuId(undefined);
      return;
    }
    const focusFrame = window.requestAnimationFrame(() => menuItems(menu)[0]?.focus());
    const closeAndRestore = (): void => {
      setTaskMenuId(undefined);
      window.requestAnimationFrame(() => {
        if (canRestoreFocus(trigger)) trigger.focus();
      });
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || menu.contains(event.target) || trigger.contains(event.target)) return;
      setTaskMenuId(undefined);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestore();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [taskMenuId]);

  const reloadSessionConfig = useCallback(async (sessionId = selectedRef.current) => {
    if (!sessionId || sidecarPhaseRef.current !== "healthy") return;
    const isCurrent = configRequestGate.current.begin();
    const owner = projectionRef.current.state.projectId;
    setConfigLoading(true);
    try {
      const next = await projectTransport().sessionConfig(sessionId);
      if (isCurrent() && selectedRef.current === sessionId && projectionRef.current.state.projectId === owner) {
        const accepted = sessionConfigResponseForSelection(selectedRef.current, next);
        if (accepted) {
          setSessionConfig(accepted);
          setModels(accepted.model.models);
        }
      }
    } catch (cause) {
      if (isCurrent()) setError(messageFor(cause));
    } finally {
      if (isCurrent()) setConfigLoading(false);
    }
  }, [projectTransport]);

  useEffect(() => {
    if (!selectedId || !healthy || resyncing) {
      configRequestGate.current.invalidate();
      setSessionConfig(undefined);
      setConfigLoading(false);
      return;
    }
    void reloadSessionConfig(selectedId);
    return () => configRequestGate.current.invalidate();
  }, [healthy, reloadSessionConfig, resyncing, selectedId]);

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
    )) {
      const saved = projectViews.current.read(workspaceRef.current);
      setComposer(saved?.sessionId === sessionId ? saved.draft : "");
    }
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
    if (sidecarPhaseRef.current !== "healthy") return;
    let token;
    try {
      token = coordinator.beginRequest("sessions");
      const next = (await projectTransport().listSessions({ status: "all" }))
        .sort((left, right) => right.updatedAt - left.updatedAt);
      coordinator.acceptResponse(token);
      setSessions(next);
      const current = selectedRef.current;
      const requested = requestedProjectSession.current;
      preferredId ??= requested && requested.projectId === projectionRef.current.state.projectId
        ? requested.sessionId : !current ? projectViews.current.read(workspaceRef.current)?.sessionId : undefined;
      if (requested && requested.projectId === projectionRef.current.state.projectId) requestedProjectSession.current = undefined;
      const target = preferredId && next.some((session) => session.id === preferredId)
        ? preferredId
        : current && next.some((session) => session.id === current)
          ? current
          : next.find((session) => session.status === "active")?.id ?? next[0]?.id;
      if (!target) {
        setComposer("");
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
  }, [coordinator, openSession, setSelectedId, setSessions, setSnapshot, projectTransport]);

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
    const unsubscribe = hostTransport.subscribe((envelope) => {
      if (!eventMatchesProject(envelope.event, projectionRef.current.state.projectId)) return;
      coordinator.recordFrame({ sequence: envelope.sequence, frame: envelope.event });
      const event = envelope.event;
      if (event.type === "runtime.resync") {
        const requested = requestedProjectSession.current;
        const preferred = (requested?.projectId === projectionRef.current.state.projectId ? requested?.sessionId : undefined)
          ?? selectedRef.current ?? projectViews.current.read(workspaceRef.current)?.sessionId;
        startResync({
          sequence: envelope.sequence,
          barrierId: event.barrierId,
          ...(preferred ? { preferredSessionId: preferred } : {}),
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
          projectionRefreshes.cancel();
          coordinator.invalidateRequests("sessions", "snapshot", "diff");
          diffRequestGate.current.invalidate();
          setDiffLoading(false);
          if (selectedRef.current) setDiffText("Runtime unavailable; changes will refresh after recovery.");
        }
        if (workspaceChanged) {
          projectionRefreshes.cancel();
          setComposer("");
          setNewTaskOpen(false);
          setSettingsOpen(false);
          setRenameTarget(undefined);
          setArchiveTarget(undefined);
          setGoalSetupOpen(false);
          setGoalBudgetOpen(false);
          setTaskMenuId(undefined);
          workspaceRef.current = event.state.workspace;
          coordinator.invalidateRequests("sessions", "snapshot", "diff");
          diffRequestGate.current.invalidate();
          const previousSelectedId = selectedRef.current;
          selectedRef.current = undefined;
          setSessionConfig((current) => sessionConfigAfterSelectionChange(
            previousSelectedId,
            undefined,
            current,
          ));
          const next = { epoch: projectionRef.current.epoch, diffRevision: projectionRef.current.diffRevision + 1,
            state: event.state, sessions: [] };
          projectionRef.current = next;
          setProjection(next);
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
      if (refreshesSessionConfig(event.event)) {
        if (configRefreshTimer.current) clearTimeout(configRefreshTimer.current);
        configRefreshTimer.current = setTimeout(() => void reloadSessionConfig(), 120);
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
      void hostTransport.state().then((state) => {
        if (disposed || !stateToken) return;
        coordinator.acceptResponse(stateToken);
        workspaceRef.current = state.workspace;
        sidecarPhaseRef.current = state.sidecar.phase;
        projectionRef.current = { ...projectionRef.current, state };
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
      if (configRefreshTimer.current) clearTimeout(configRefreshTimer.current);
      configRefreshTimer.current = undefined;
      clearResyncRetryTimer();
      diffRequestGate.current.invalidate();
      coordinator.cancel();
    };
  }, [coordinator, projectionRefreshes, refreshSessions, reloadSelected, reloadSessionConfig, setDesktop, setSnapshot, hostTransport]);

  const diffViewScope = JSON.stringify([desktop.projectId, desktop.workspace, selectedId, diffScope,
    diffScope === "turn" ? presentation?.latestTurnId : undefined]);
  const diffBelongsToScope = diffView.scope === undefined || diffView.scope === diffViewScope;

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
        if (isCurrent() && requestToken && coordinator.isRequestCurrent(requestToken)) {
          setDiffView({ text: result.text, truncated: result.truncated, scope: diffViewScope });
        }
      })
      .catch((cause) => {
        if (isCurrent() && requestToken && coordinator.isRequestCurrent(requestToken)) {
          setDiffView({ text: `Unable to load diff: ${messageFor(cause)}`, truncated: false, scope: diffViewScope });
        }
      })
      .finally(() => {
        if (isCurrent() && requestToken && coordinator.isRequestCurrent(requestToken)) setDiffLoading(false);
      });
    return () => diffRequestGate.current.invalidate();
  }, [coordinator, diffRevision, diffScope, diffViewScope, healthy, loadingSession, presentation?.latestTurnId, resyncing, selectedId, snapshot?.sessionId, transport]);

  const chooseWorkspace = async (projectId?: string, sessionId?: string) => runAction(async () => {
    requestedProjectSession.current = projectId && sessionId ? { projectId, sessionId } : undefined;
    diffRequestGate.current.invalidate();
    coordinator.invalidateRequests();
    const previousWorkspace = workspaceRef.current;
    let stateToken;
    const state = await selectWorkspaceWithRecoveryEscape.current(async () => {
      stateToken = coordinator.beginRequest("state");
      if (projectId) {
        if (!transport.activateProject) throw new Error("Project switching is unavailable");
        return transport.activateProject(projectId);
      }
      return transport.selectWorkspace();
    });
    if (!stateToken || !coordinator.isRequestCurrent(stateToken)) return;
    const workspaceChanged = workspaceSelectionChangesScope(previousWorkspace, state.workspace);
    workspaceRef.current = state.workspace;
    sidecarPhaseRef.current = state.sidecar.phase;
    if (workspaceChanged) {
      setComposer("");
      const previousSelectedId = selectedRef.current;
      selectedRef.current = undefined;
      setSessionConfig((current) => sessionConfigAfterSelectionChange(
        previousSelectedId,
        undefined,
        current,
      ));
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

  const openNewTask = useCallback(() => {
    setTaskMenuId(undefined);
    setNewTaskDraft(() => {
      const draft = createNewTaskDraft(models);
      const permission = sessionConfig?.permission.profile;
      return permission ? { ...draft, permissionProfile: permission } : draft;
    });
    setNewTaskOpen(true);
    setNewTaskPermissionConfig(sessionConfig?.permission);
    setNewTaskChoicesLoading(true);
    setNewTaskChoicesReady(false);
    const choicesCurrent = newTaskChoicesGate.current.begin();
    void Promise.all([
      models.length > 0 ? Promise.resolve(models) : transport.listModels(),
      sessionConfig?.permission ? Promise.resolve(sessionConfig.permission) : transport.permissionConfig(),
    ]).then(([catalog, permission]) => {
      if (!choicesCurrent()) return;
      setModels(catalog);
      setNewTaskPermissionConfig(permission);
      setNewTaskDraft((current) => hydrateNewTaskChoices(current, catalog, permission.profile));
      setNewTaskChoicesReady(true);
    }).catch((cause) => {
      if (choicesCurrent()) setError(`Unable to load runtime choices: ${messageFor(cause)}`);
    }).finally(() => {
      if (choicesCurrent()) setNewTaskChoicesLoading(false);
    });
  }, [models, sessionConfig?.permission, transport]);

  const closeNewTask = useCallback(() => {
    if (actionInFlightRef.current) return;
    newTaskChoicesGate.current.invalidate();
    setNewTaskChoicesLoading(false);
    setNewTaskOpen(false);
  }, []);

  const createSession = async () => {
    if (newTaskChoicesLoading || !newTaskChoicesReady) return;
    const validation = validateNewTaskDraft(newTaskDraft, models);
    if (!validation.valid) return;
    await runAction(async () => {
      const created = await transport.createSession(newTaskSubmission(newTaskDraft, models));
      newTaskChoicesGate.current.invalidate();
      setNewTaskOpen(false);
      setSessionListStatus("active");
      await refreshSessions(created.sessionId);
      if (created.failure) throw new Error(createFailureMessage(created));
    });
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (healthy && !actionsDisabled) openNewTask();
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [actionsDisabled, healthy, openNewTask]);

  const renameSession = async (session: RuntimeSessionSummary, title: string) => {
    const normalized = title.trim();
    if (!normalized) return;
    await runAction(async () => {
      await transport.renameSession(String(session.id), normalized);
      setRenameTarget(undefined);
      await refreshSessions(String(session.id));
    });
  };

  const archiveSession = async (session: RuntimeSessionSummary) => {
    await runAction(async () => {
      await transport.archiveSession(String(session.id));
      setArchiveTarget(undefined);
      setSessionListStatus("archived");
      await refreshSessions(String(session.id));
    });
  };

  const resumeSession = async () => {
    if (!selectedId || selectedArchived) return;
    await runAction(async () => {
      const next = await coordinator.refreshSessionSnapshot(
        selectedId,
        () => transport.resumeSession(selectedId),
      );
      setSnapshot(next);
      await reloadSessionConfig(selectedId);
      requestAnimationFrame(() => composerRef.current?.focus());
    });
  };

  const saveSessionSettings = async (values: SessionSettingsValues) => {
    if (!selectedId || !sessionConfig || selectedArchived) return;
    await runAction(async () => {
      const catalog = models.length > 0 ? models : sessionConfig.model.models;
      const validation = validateSessionModelSettingsDraft(values, catalog, sessionConfig.model);
      if (!validation.valid) {
        throw new TypeError(Object.values(validation.errors)[0] ?? "Invalid task runtime settings.");
      }
      const model = modelFromKey(catalog, values.modelKey)!;
      if (modelKey(model) !== (sessionConfig.model.modelSelection ? modelKey(sessionConfig.model.modelSelection) : "")) {
        await transport.setModel(selectedId, { provider: model.provider, model: model.model });
      }
      const mutations = sessionModelSettingsMutations(values, sessionConfig.model);
      if (mutations.reasoningLevel) {
        await transport.setReasoning(selectedId, mutations.reasoningLevel);
      }
      if (mutations.serviceTier) {
        await transport.setServiceTier(selectedId, mutations.serviceTier);
      }
      if (values.permissionProfile !== sessionConfig.permission.profile) {
        await transport.setPermission(values.permissionProfile);
      }
      if (values.delegationPolicy !== sessionConfig.delegation.policy) {
        await transport.setDelegation(selectedId, values.delegationPolicy);
      }
      setSettingsOpen(false);
      await reloadSessionConfig(selectedId);
    });
  };

  const changeGoalStatus = async (status: SessionGoalStatus) => {
    if (!selectedId || selectedArchived) return;
    await runAction(async () => {
      await transport.updateGoal(selectedId, { status });
      await reloadSessionConfig(selectedId);
    });
  };

  const resumeBudgetLimitedGoal = async (tokenBudget: number) => {
    if (!selectedId || !selectedGoal || selectedGoal.status !== "budgetLimited" || selectedArchived) return;
    await runAction(async () => {
      await transport.updateGoal(selectedId, { tokenBudget, status: "active" });
      setGoalBudgetOpen(false);
      await reloadSessionConfig(selectedId);
    });
  };

  const addGoal = async (objective: string, tokenBudget?: number) => {
    if (!selectedId || selectedArchived) return;
    await runAction(async () => {
      await transport.setGoal(selectedId, objective, tokenBudget);
      setGoalSetupOpen(false);
      await reloadSessionConfig(selectedId);
    });
  };

  const clearGoal = async () => {
    if (!selectedId || selectedArchived) return;
    await runAction(async () => {
      await transport.clearGoal(selectedId);
      await reloadSessionConfig(selectedId);
    });
  };

  const reloadMcp = async () => {
    if (!selectedId || selectedArchived) return;
    await runAction(async () => {
      await transport.reloadMcp(selectedId);
      await reloadSessionConfig(selectedId);
    });
  };

  const submit = async (mode: "queue" | "steer") => {
    const text = composer.trim();
    if (!selectedId || !text || !composerEditable || actionInFlightRef.current) return;
    await runAction(async () => {
      await transport.send(selectedId, text, mode);
      projectViews.current.remember(desktop.workspace, selectedId, "");
      if (projectionRef.current.state.workspace === desktop.workspace && selectedRef.current === selectedId) setComposer("");
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
        <div className="titlebar-leading">
          <button
            ref={sidebarToggleRef}
            className="chrome-button"
            type="button"
            data-dialog-fallback-focus="true"
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            aria-pressed={sidebarOpen}
            onClick={() => setSidebarOpen((current) => !current)}
          >
            <Icon name="sidebar" />
          </button>
          <div className="brand" aria-label="Chili">
            <ChiliMark />
            <span>Chili</span>
            {buildInfo.channel === "preview" ? <small className="desktop-build-label" data-testid="desktop-build-label" title={buildInfo.label}>{buildInfo.label}</small> : null}
          </div>
          <span className="title-divider" aria-hidden="true" />
          <div className="title-context">
            <strong>{projectLabel}</strong>
            <span>/</span>
            <span>{selectedId ? selectedTitle : "New task"}</span>
          </div>
        </div>
        <div className="titlebar-actions">
          <button
            className="chrome-button"
            type="button"
            aria-label="Appearance settings"
            title="Appearance"
            aria-haspopup="dialog"
            onClick={() => setAppearanceOpen(true)}
          >
            <Icon name="appearance" />
          </button>
          <RemoteControlPanel />
          <div className={`runtime-pill phase-${desktop.sidecar.phase}`} title="Local runtime status">
            <span className="status-dot" aria-hidden="true" />
            <span>Local</span>
            <strong>{desktop.sidecar.phase}</strong>
            {desktop.sidecar.attempt > 0 ? <em>retry {desktop.sidecar.attempt}</em> : null}
          </div>
          <button
            ref={inspectorToggleRef}
            className={`chrome-button workbench-toggle ${inspectorOpen ? "active" : ""}`}
            type="button"
            aria-label={inspectorOpen ? "Hide workbench" : "Show workbench"}
            aria-pressed={inspectorOpen}
            onClick={() => setInspectorOpen((current) => !current)}
          >
            <Icon name="activity" />
            <span>Work</span>
          </button>
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

      <main className={`workspace-grid ${sidebarOpen ? "" : "sidebar-collapsed"} ${inspectorOpen ? "" : "inspector-collapsed"}`}>
        <aside ref={sidebarRef} className="sidebar panel" aria-hidden={!sidebarOpen} inert={!sidebarOpen}>
          <div className="sidebar-actions">
            <button className="new-task-button" aria-label="New task" disabled={!healthy || actionsDisabled} onClick={openNewTask}>
              <span><Icon name="plus" />New task</span>
              <kbd aria-hidden="true">⌘ N</kbd>
            </button>
            <label className="session-search">
              <span className="sr-only">Search tasks</span>
              <Icon name="search" />
              <input
                type="search"
                aria-label="Search tasks"
                value={sessionQuery}
                onChange={(event) => { setTaskMenuId(undefined); setSessionQuery(event.target.value); }}
                placeholder="Search tasks"
              />
            </label>
            <div className="session-filters" role="tablist" aria-label="Task status">
              <button
                type="button"
                role="tab"
                aria-selected={sessionListStatus === "active"}
                className={sessionListStatus === "active" ? "active" : ""}
                onClick={() => { setTaskMenuId(undefined); setSessionListStatus("active"); }}
              >
                Active tasks <span>{sessions.filter((session) => session.status === "active").length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sessionListStatus === "archived"}
                className={sessionListStatus === "archived" ? "active" : ""}
                onClick={() => { setTaskMenuId(undefined); setSessionListStatus("archived"); }}
              >
                Archived tasks <span>{sessions.filter((session) => session.status === "archived").length}</span>
              </button>
            </div>
          </div>
          <ProjectSidebar projects={desktop.projects ?? []} activeId={desktop.projectId} disabled={!workspaceSwitchEnabled}
            onActivate={(id, sessionId) => void chooseWorkspace(id, sessionId)}>
          <section className="session-section">
            <div className="section-heading">
              <p className="eyebrow">{sessionListStatus === "active" ? "Recent tasks" : "Archived tasks"}</p>
              <span>{visibleSessions.length}</span>
            </div>
            <div className="session-list">
              {visibleSessions.map((session) => (
                <div className={`session-entry ${taskMenuId === session.id ? "menu-open" : ""}`} key={session.id}>
                  <button
                    className={`session-row ${selectedId === session.id ? "selected" : ""}`}
                    disabled={actionsDisabled || !canOpenSession({ healthy, resyncing })}
                    onClick={() => {
                      setTaskMenuId(undefined);
                      void openSession(session.id);
                      if (window.innerWidth <= 640) closeSidebar();
                    }}
                  >
                    <span className="session-glyph" aria-hidden="true"><Icon name={session.status === "archived" ? "archive" : "message"} /></span>
                    <span className="session-copy">
                      <span className="session-title">{session.title || session.preview || "Untitled task"}</span>
                      <span className="session-meta">
                        {formatRelativeTime(session.updatedAt)}
                        {(desktop.queuedBySession[session.id] ?? 0) > 0 ? ` · ${desktop.queuedBySession[session.id]} queued` : ""}
                      </span>
                    </span>
                    {selectedId === session.id ? <span className="session-active-mark" aria-hidden="true" /> : null}
                  </button>
                  {canExposeTaskActions(session.status) ? (
                    <>
                      <button
                        ref={(node) => {
                          const id = String(session.id);
                          if (node) taskMenuButtonRefs.current.set(id, node);
                          else taskMenuButtonRefs.current.delete(id);
                        }}
                        className="session-menu-button"
                        type="button"
                        aria-label={`Task actions for ${session.title || session.preview || "Untitled task"}`}
                        aria-haspopup="menu"
                        aria-expanded={taskMenuId === session.id}
                        disabled={actionsDisabled}
                        onClick={() => setTaskMenuId((current) => current === String(session.id) ? undefined : String(session.id))}
                      >
                        <Icon name="more" />
                      </button>
                      {taskMenuId === session.id ? (
                        <div
                          ref={taskMenuRef}
                          className="session-menu"
                          role="menu"
                          aria-label={`Task actions for ${session.title || session.preview || "Untitled task"}`}
                          onKeyDown={(event) => {
                            if (!isMenuNavigationKey(event.key)) return;
                            const items = menuItems(event.currentTarget);
                            const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
                            const nextIndex = menuNavigationTarget(event.key, currentIndex, items.length);
                            if (nextIndex === undefined) return;
                            event.preventDefault();
                            items[nextIndex]?.focus();
                          }}
                        >
                          <button role="menuitem" onClick={() => {
                            dialogReturnFocusRef.current = taskMenuButtonRefs.current.get(String(session.id)) ?? null;
                            setRenameTarget(session);
                            setTaskMenuId(undefined);
                          }}>Rename task</button>
                          <button className="danger-menu-item" role="menuitem" onClick={() => {
                            dialogReturnFocusRef.current = taskMenuButtonRefs.current.get(String(session.id)) ?? null;
                            setArchiveTarget(session);
                            setTaskMenuId(undefined);
                          }}>Archive task</button>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ))}
              {healthy && sessions.length === 0 ? <p className="empty-copy sidebar-empty">Your recent work will live here.</p> : null}
              {healthy && sessions.length > 0 && visibleSessions.length === 0 ? (
                <p className="empty-copy sidebar-empty">No {sessionListStatus} tasks match this search.</p>
              ) : null}
              {!healthy ? <p className="empty-copy sidebar-empty">Choose a project and let the local runtime warm up.</p> : null}
            </div>
          </section>
          </ProjectSidebar>
          <footer className="workspace-picker">
            <button className="workspace-card" aria-label="Add project" disabled={!workspaceSwitchEnabled} onClick={() => void chooseWorkspace()}>
              <span className="workspace-icon" aria-hidden="true"><Icon name="folder" /></span>
              <span className="workspace-copy">
                <strong>Add project</strong>
                <span>Keep projects running side by side</span>
              </span>
              <Icon name="chevron" />
            </button>
            <p><span className={`mini-status phase-${desktop.sidecar.phase}`} /> Runs on this Mac</p>
          </footer>
        </aside>

        <section className="conversation panel">
          <div className="conversation-heading">
            <div className="conversation-title">
              <h1>{selectedId ? selectedTitle : "A calmer place to ship code"}</h1>
              <p>{selectedId ? `${projectLabel} · ${shortId(selectedId)}${selectedArchived ? " · archived" : ""}` : "Local-first · permission-aware · yours"}</p>
              {selectedId && sessionConfig ? (
                <div className="session-config-strip" aria-label="Task runtime configuration">
                  <span title={selectedModel ? `${selectedModel.provider}/${selectedModel.model}` : "Runtime default model"}>
                    {selectedModel?.model ?? "Default model"}
                  </span>
                  <span>{sessionConfig.model.reasoningLevel ?? "default"} reasoning</span>
                  <span>{sessionConfig.model.serviceTier ?? "provider default"} tier</span>
                  <span>{sessionConfig.permission.profile} permissions</span>
                  <span>{sessionConfig.delegation.policy} delegation</span>
                  {selectedGoal ? <span className={`goal-chip goal-${selectedGoal.status}`}>Goal {goalStatusLabel(selectedGoal.status)}</span> : null}
                </div>
              ) : selectedId && configLoading ? <p className="config-loading">Loading runtime configuration…</p> : null}
            </div>
            <div className="conversation-heading-actions">
              {canResumeSession ? (
                <button className="secondary compact-action" disabled={runtimeActionsDisabled} onClick={() => void resumeSession()}>
                  <Icon name="resume" />Resume task
                </button>
              ) : null}
              {selectedId && !selectedArchived ? (
                <button
                  className="icon-button session-settings-button"
                  type="button"
                  aria-label="Task runtime settings"
                  disabled={runtimeActionsDisabled || !sessionConfig}
                  onClick={() => setSettingsOpen(true)}
                >
                  <Icon name="settings" />
                </button>
              ) : null}
              {presentation ? (
                <span className={`session-status status-${presentation.chat.status}`}>
                  <span aria-hidden="true" />{presentation.chat.status.replaceAll("_", " ")}
                </span>
              ) : null}
            </div>
          </div>

          {selectedArchived ? (
            <div className="read-only-banner" role="status">
              <Icon name="archive" />
              <span>This task is archived and read-only. Archived tasks cannot be restored in this milestone.</span>
            </div>
          ) : null}

          <TimelineViewport scopeKey={JSON.stringify([desktop.projectId, desktop.workspace, selectedId])}>
            {loadingSession ? <p className="empty-copy centered">Restoring timeline…</p> : null}
            {!loadingSession && timelineItems.map((item) => <TimelineItem key={`${item.kind}:${item.id}`} item={item} />)}
            {!loadingSession && selectedId && timelineItems.length === 0 ? (
              <div className="task-empty-state">
                <ChiliMark />
                <h2>What should we build?</h2>
                <p>Describe the outcome. Chili will inspect the repo, work through the task, and keep the evidence here.</p>
              </div>
            ) : null}
            {!selectedId ? (
              <div className="welcome-card">
                <div className="welcome-mark"><ChiliMark /></div>
                <p className="eyebrow">Chili desktop</p>
                <h2>Turn a repository into finished work.</h2>
                <p>Start with the result you want. Chili reads the project, edits with visible permissions, and keeps agents, tasks, and changes in one place.</p>
                <div className="welcome-actions">
                  {healthy ? (
                    <button className="primary" disabled={actionsDisabled} onClick={openNewTask}>
                      <Icon name="plus" />Start a task
                    </button>
                  ) : (
                    <button className="primary" disabled={!workspaceSwitchEnabled} onClick={() => void chooseWorkspace()}>
                      <Icon name="folder" />Choose a project
                    </button>
                  )}
                  <span>{RENDERER_CREDENTIAL_BOUNDARY_COPY}</span>
                </div>
              </div>
            ) : null}
          </TimelineViewport>

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

          <div className="composer-wrap">
            <div className="composer">
              <textarea
                ref={composerRef}
                aria-label="Message composer"
                value={composer}
                onChange={(event) => {
                  setComposer(event.target.value);
                  event.target.style.height = "auto";
                  event.target.style.height = `${Math.min(event.target.scrollHeight, 190)}px`;
                }}
                onKeyDown={(event) => {
                  if (composerEditable && (event.metaKey || event.ctrlKey) && event.key === "Enter") void submit("queue");
                }}
                placeholder={selectedArchived
                  ? "Archived tasks are read-only"
                  : selectedId
                    ? canResumeSession
                      ? "Resume with a follow-up…"
                      : "Ask Chili to change, investigate, or ship something…"
                    : "Create or select a task first"}
                disabled={!composerEditable}
                rows={2}
              />
              <div className="composer-actions">
                <div className="composer-context">
                  <span className={`composer-local phase-${desktop.sidecar.phase}`}><span />Local</span>
                  {selectedGoal ? <span className={`composer-goal goal-${selectedGoal.status}`}>Goal · {goalStatusLabel(selectedGoal.status)}</span> : null}
                  {(desktop.queuedBySession[selectedId ?? ""] ?? 0) > 0 ? <span>{desktop.queuedBySession[selectedId ?? ""]} queued</span> : null}
                  <span className="shortcut-hint">⌘ ↵ send</span>
                </div>
                <div className="composer-buttons">
                  {sessionBusy ? (
                    <button
                      className="composer-stop"
                      title={selectedGoal?.status === "active" ? "Stop current turn and pause Goal" : "Stop current turn"}
                      aria-label={selectedGoal?.status === "active" ? "Stop current turn and pause Goal" : "Stop current turn"}
                      disabled={!selectedId || runtimeActionsDisabled}
                      onClick={() => void stop()}
                    >
                      <Icon name="stop" />
                    </button>
                  ) : null}
                  {sessionBusy ? (
                    <button className="steer-button" disabled={!composer.trim() || !selectedId || runtimeActionsDisabled} onClick={() => void submit("steer")}>
                      <Icon name="steer" />Steer
                    </button>
                  ) : null}
                  <button className="send-button" title={sessionBusy ? "Queue message" : "Send message"} aria-label={sessionBusy ? "Queue message" : "Send message"} disabled={!composer.trim() || !selectedId || runtimeActionsDisabled} onClick={() => void submit("queue")}>
                    <Icon name={sessionBusy ? "queue" : "send"} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside ref={inspectorRef} className="inspector panel" aria-hidden={!inspectorOpen} inert={!inspectorOpen}>
          <div className="inspector-heading">
            <div><p className="eyebrow">Workbench</p><strong>Live work</strong></div>
            <button className="icon-button" type="button" aria-label="Close workbench" onClick={closeInspector}><Icon name="close" /></button>
          </div>
          <div className="inspector-tabs" role="tablist" aria-label="Workbench views">
            <button role="tab" aria-selected={inspectorTab === "activity"} className={inspectorTab === "activity" ? "active" : ""} onClick={() => setInspectorTab("activity")}>
              Activity <span>{(snapshot?.agentTree.agents.length ?? 0) + (snapshot?.tasks.length ?? 0)}</span>
            </button>
            <button role="tab" aria-selected={inspectorTab === "changes"} className={inspectorTab === "changes" ? "active" : ""} onClick={() => setInspectorTab("changes")}>
              Changes
            </button>
          </div>

          {inspectorTab === "activity" ? (
            <div className="inspector-scroll">
              {snapshot?.truncated ? <p className="inspector-warning">{snapshot.warning ?? "This large session was trimmed for desktop safety."}</p> : null}
              <section className="root-agent-card">
                <span className="root-agent-mark"><ChiliMark /></span>
                <div><strong>Chili</strong><span>{presentation?.chat.status.replaceAll("_", " ") ?? (healthy ? "ready" : "offline")}</span></div>
                <span className={`agent-signal ${sessionBusy ? "working" : ""}`} aria-hidden="true" />
              </section>
              <section className="inspector-section goal-section">
                <div className="section-heading compact"><p className="eyebrow">Goal</p>{selectedGoal ? <span className={`goal-status goal-${selectedGoal.status}`}>{goalStatusLabel(selectedGoal.status)}</span> : null}</div>
                {selectedGoal ? (
                  <GoalCard
                    goal={selectedGoal}
                    disabled={runtimeActionsDisabled || selectedArchived}
                    busy={Boolean(sessionBusy)}
                    onStatus={(status) => void changeGoalStatus(status)}
                    onRaiseBudget={() => setGoalBudgetOpen(true)}
                    onClear={() => void clearGoal()}
                  />
                ) : (
                  <div className="compact-empty-action">
                    <p className="empty-copy">No autonomous Goal is attached to this task.</p>
                    {selectedId && !selectedArchived ? (
                      <button className="secondary" disabled={runtimeActionsDisabled} onClick={() => setGoalSetupOpen(true)}>Add Goal</button>
                    ) : null}
                  </div>
                )}
              </section>

              <section className="inspector-section runtime-config-section">
                <div className="section-heading compact"><p className="eyebrow">Runtime</p>{!selectedArchived && sessionConfig ? <button className="text-button" onClick={() => setSettingsOpen(true)}>Change</button> : null}</div>
                {sessionConfig ? (
                  <dl className="config-list">
                    <div><dt>Model</dt><dd>{selectedModel?.model ?? "Runtime default"}</dd></div>
                    <div><dt>Reasoning</dt><dd>{sessionConfig.model.reasoningLevel ?? "default"}</dd></div>
                    <div><dt>Service tier</dt><dd>{sessionConfig.model.serviceTier ?? "Provider default"}</dd></div>
                    <div><dt>Permission</dt><dd>{sessionConfig.permission.profile} <em>global</em></dd></div>
                    <div><dt>Delegation</dt><dd>{sessionConfig.delegation.policy}</dd></div>
                  </dl>
                ) : <p className="empty-copy">{selectedId ? "Loading runtime settings…" : "Select a task to inspect its runtime."}</p>}
              </section>

              <section className="inspector-section mcp-section">
                <div className="section-heading compact">
                  <p className="eyebrow">MCP connections</p>
                  <button className="text-button" disabled={!mcpReloadEnabled} onClick={() => void reloadMcp()}>Reload</button>
                </div>
                {sessionConfig ? (
                  <>
                    <p className="mcp-summary">
                      <strong>{sessionConfig.mcp.summary.running}/{sessionConfig.mcp.summary.total}</strong> running
                      {sessionConfig.mcp.summary.errored > 0 ? <span>{sessionConfig.mcp.summary.errored} errors</span> : null}
                      {sessionConfig.mcp.summary.authRequired > 0 ? <span>{sessionConfig.mcp.summary.authRequired} need auth</span> : null}
                    </p>
                    <div className="mcp-server-list">
                      {sessionConfig.mcp.servers.map((server) => (
                        <div className="mcp-server" key={server.name} title={server.error}>
                          <span className={`mcp-dot mcp-${server.status}`} aria-hidden="true" />
                          <strong>{server.name}</strong>
                          <span>{server.status.replaceAll("_", " ")}</span>
                        </div>
                      ))}
                      {sessionConfig.mcp.servers.length === 0 ? <p className="empty-copy">No MCP servers configured.</p> : null}
                    </div>
                  </>
                ) : <p className="empty-copy">MCP status follows the selected task.</p>}
              </section>
              <AgentDetailsPanel
                projectId={desktop.projectId}
                sessionId={selectedId}
                tree={snapshot?.sessionId === selectedId ? snapshot?.agentTree : undefined}
                tasks={snapshot?.sessionId === selectedId ? snapshot?.tasks ?? [] : []}
              />

              <section className="inspector-section task-section">
                <div className="section-heading compact"><p className="eyebrow">Task plan</p><span>{snapshot?.tasks.length ?? 0}</span></div>
                <div className="task-list">
                  {snapshot?.tasks.map((task) => (
                    <div className="task-row" key={task.id}>
                      <span className={`task-state task-${task.status}`} />
                      <div><strong>{task.taskName}</strong><span>{task.status}{task.summary ? ` · ${task.summary}` : ""}</span></div>
                    </div>
                  ))}
                  {!snapshot || snapshot.tasks.length === 0 ? <p className="empty-copy">The plan will appear as Chili breaks down the work.</p> : null}
                </div>
              </section>
            </div>
          ) : (
            <section className="diff-section">
              <div className="diff-toolbar">
                <div>
                  <strong>Repository changes</strong>
                  <span>{selectedId ? "Review what this task changed" : "Select a task to inspect changes"}</span>
                </div>
                <div className="segmented">
                  <button disabled={runtimeActionsDisabled || !selectedId} className={diffScope === "turn" ? "active" : ""} onClick={() => setDiffScope("turn")}>Turn</button>
                  <button disabled={runtimeActionsDisabled || !selectedId} className={diffScope === "workspace" ? "active" : ""} onClick={() => setDiffScope("workspace")}>All</button>
                </div>
              </div>
              <DiffViewer
                text={diffBelongsToScope ? diffView.text : ""}
                truncated={diffBelongsToScope && diffView.truncated}
                loading={diffLoading || !diffBelongsToScope}
                resetKey={diffViewScope}
              />
            </section>
          )}
        </aside>
      </main>

      {newTaskOpen ? (
        <NewTaskDialog
          draft={newTaskDraft}
          models={models}
          permissionConfig={newTaskPermissionConfig}
          disabled={working}
          choicesLoading={newTaskChoicesLoading}
          choicesReady={newTaskChoicesReady}
          onChange={setNewTaskDraft}
          onClose={closeNewTask}
          onSubmit={() => void createSession()}
        />
      ) : null}

      {renameTarget ? (
        <RenameTaskDialog
          session={renameTarget}
          disabled={working}
          returnFocus={dialogReturnFocusRef.current}
          onClose={() => !working && setRenameTarget(undefined)}
          onSubmit={(title) => void renameSession(renameTarget, title)}
        />
      ) : null}

      {archiveTarget ? (
        <ArchiveTaskDialog
          session={archiveTarget}
          disabled={working}
          archiveDisabled={String(archiveTarget.id) === selectedId && Boolean(sessionBusy)}
          returnFocus={dialogReturnFocusRef.current}
          onClose={() => !working && setArchiveTarget(undefined)}
          onArchive={() => void archiveSession(archiveTarget)}
        />
      ) : null}

      {appearanceOpen ? (
        <AppearanceDialog
          theme={theme}
          onChange={changeTheme}
          saveFailed={themeSaveFailed}
          saving={themeSaving}
          onClose={() => setAppearanceOpen(false)}
        />
      ) : null}

      {settingsOpen && sessionConfig ? (
        <SessionSettingsDialog
          config={sessionConfig}
          models={models}
          disabled={working}
          onClose={() => !working && setSettingsOpen(false)}
          onSubmit={(values) => void saveSessionSettings(values)}
        />
      ) : null}

      {goalSetupOpen ? (
        <GoalSetupDialog
          defaultObjective={composer.trim()}
          disabled={working}
          onClose={() => !working && setGoalSetupOpen(false)}
          onSubmit={(objective, tokenBudget) => void addGoal(objective, tokenBudget)}
        />
      ) : null}

      {goalBudgetOpen && selectedGoal?.status === "budgetLimited" ? (
        <GoalBudgetDialog
          goal={selectedGoal}
          disabled={working}
          onClose={() => !working && setGoalBudgetOpen(false)}
          onSubmit={(tokenBudget) => void resumeBudgetLimitedGoal(tokenBudget)}
        />
      ) : null}
    </div>
  );
}

function AppearanceDialog({ theme, onChange, saveFailed, saving, onClose }: {
  theme: DesktopTheme;
  onChange: (theme: DesktopTheme) => void;
  saveFailed: boolean;
  saving: boolean;
  onClose: () => void;
}) {
  useDialogEscape(onClose, saving);
  return (
    <ModalFrame labelId="appearance-title" className="appearance-dialog" onClose={onClose} closeDisabled={saving}>
      <header className="modal-heading">
        <div><p className="eyebrow">Personalize</p><h2 id="appearance-title">Appearance</h2><p>Make Chili feel at home.</p></div>
        <button className="icon-button" type="button" aria-label="Close appearance settings" disabled={saving} onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="modal-scroll">
        <fieldset className="theme-picker">
          <legend>Theme</legend>
          <div className="theme-options">
            {desktopThemeOptions.map((option) => (
              <label className="theme-option" key={option.id}>
                <span className={`theme-preview theme-preview-${option.id}`} aria-hidden="true">
                  <span className="theme-preview-sidebar"><i /><i /><i /></span>
                  <span className="theme-preview-content"><i /><i /><i /><b /></span>
                </span>
                <span className="theme-option-label">
                  <input type="radio" name="desktop-theme" value={option.id} checked={theme === option.id} onChange={() => onChange(option.id)} data-modal-initial-focus={theme === option.id ? "true" : undefined} />
                  <strong>{option.label}</strong>
                </span>
                <small>{option.description}</small>
              </label>
            ))}
          </div>
        </fieldset>
        {saveFailed ? <p className="field-error" role="alert">Theme applied, but it could not be saved. <button className="text-button" onClick={() => onChange(theme)}>Retry</button></p> : null}
      </div>
      <footer className="modal-actions"><span role="status">{saving ? "Saving theme…" : saveFailed ? "This change has not been saved." : "Applies to all tasks. Changes are saved automatically."}</span><button className="primary" type="button" disabled={saving} onClick={onClose}>Done</button></footer>
    </ModalFrame>
  );
}

function NewTaskDialog({
  draft,
  models,
  permissionConfig,
  disabled,
  choicesLoading,
  choicesReady,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: NewTaskDraft;
  models: readonly RuntimeModelDescriptor[];
  permissionConfig: RuntimePermissionConfig | undefined;
  disabled: boolean;
  choicesLoading: boolean;
  choicesReady: boolean;
  onChange: (draft: NewTaskDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  useDialogEscape(onClose, disabled);
  const validation = validateNewTaskDraft(draft, models);
  const reasoningLevels = availableReasoningLevels(models, draft.modelKey);
  const serviceTiers = availableServiceTiers(models, draft.modelKey);
  return (
    <ModalFrame labelId="new-task-title" className="new-task-dialog" onClose={onClose} closeDisabled={disabled}>
      <form onSubmit={(event) => { event.preventDefault(); if (validation.valid && !disabled) onSubmit(); }}>
        <header className="modal-heading">
          <div><p className="eyebrow">New task</p><h2 id="new-task-title">Create a new task</h2><p>Configure the runtime and launch work without opening a terminal.</p></div>
          <button className="icon-button" type="button" aria-label="Close new task" disabled={disabled} onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="setup-flow" aria-label="Task setup steps">
          <span><b>1</b> Outcome</span><span><b>2</b> Runtime</span><span><b>3</b> Goal</span>
        </div>
        <div className="modal-scroll">
          <section className="form-section">
            <div className="form-section-heading"><span>1</span><div><h3>Outcome</h3><p>Lead with the result Chili should own.</p></div></div>
            <label className="field-label">
              <span>Task title <em>optional</em></span>
              <input
                autoFocus
                data-modal-initial-focus="true"
                aria-label="Task title"
                value={draft.title}
                maxLength={SESSION_TITLE_MAX_CHARS}
                disabled={disabled}
                onChange={(event) => onChange({ ...draft, title: event.target.value })}
                placeholder="e.g. Harden the desktop control plane"
              />
            </label>
            <label className="field-label">
              <span>What should Chili accomplish?</span>
              <textarea
                aria-label="What should Chili accomplish?"
                aria-invalid={Boolean(validation.errors.prompt)}
                aria-describedby={validation.errors.prompt ? "new-task-prompt-error" : "new-task-prompt-help"}
                value={draft.prompt}
                disabled={disabled}
                onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
                placeholder="Describe a verifiable outcome, constraints, and what done means…"
                rows={5}
              />
              <small id="new-task-prompt-help">This becomes the first turn, or the autonomous Goal objective when Goal mode is on.</small>
              {validation.errors.prompt ? <small className="field-error" id="new-task-prompt-error">{validation.errors.prompt}</small> : null}
            </label>
          </section>

          <section className="form-section">
            <div className="form-section-heading"><span>2</span><div><h3>Runtime</h3><p>Choose how this task thinks, acts, and delegates.</p></div></div>
            <div className="form-grid">
              <label className="field-label field-wide">
                <span>Model</span>
                <select
                  aria-label="Model"
                  value={draft.modelKey}
                  disabled={disabled || choicesLoading || models.length === 0}
                  onChange={(event) => onChange(reconcileNewTaskModel(draft, models, event.target.value))}
                >
                  {models.length === 0 ? <option value="">Runtime default</option> : null}
                  {models.length > 0 && !models.some((model) => model.available !== false) ? <option value="">No available models</option> : null}
                  {models.map((model) => (
                    <option key={modelKey(model)} value={modelKey(model)} disabled={model.available === false}>
                      {model.displayName ?? model.model} · {model.providerDisplayName ?? model.provider}{model.available === false ? " (unavailable)" : ""}
                    </option>
                  ))}
                </select>
                {validation.errors.model ? <small className="field-error">{validation.errors.model}</small> : null}
              </label>
              <label className="field-label">
                <span>Reasoning</span>
                <select aria-label="Reasoning" value={draft.reasoningLevel} disabled={disabled || choicesLoading || reasoningLevels.length === 0} onChange={(event) => onChange({ ...draft, reasoningLevel: event.target.value as ReasoningSelection })}>
                  {reasoningLevels.length === 0 ? <option value="">Provider default</option> : null}
                  {reasoningLevels.map((level) => <option value={level} key={level}>{reasoningLabel(level)}</option>)}
                </select>
                {reasoningLevels.length === 0 ? <small>This provider does not expose configurable reasoning.</small> : null}
                {validation.errors.reasoningLevel ? <small className="field-error">{validation.errors.reasoningLevel}</small> : null}
              </label>
              <label className="field-label">
                <span>Service tier</span>
                <select aria-label="Service tier" value={draft.serviceTier} disabled={disabled || choicesLoading || serviceTiers.length === 0} onChange={(event) => onChange({ ...draft, serviceTier: event.target.value as ServiceTierSelection })}>
                  {serviceTiers.length === 0 ? <option value="">Provider default</option> : null}
                  {serviceTiers.map((tier) => <option value={tier} key={tier}>{humanizeStatus(tier)}</option>)}
                </select>
                {serviceTiers.length === 0 ? <small>This provider does not expose a configurable service tier.</small> : null}
                {validation.errors.serviceTier ? <small className="field-error">{validation.errors.serviceTier}</small> : null}
              </label>
              <label className="field-label">
                <span>Runtime permission profile</span>
                <select aria-label="Permission profile" value={draft.permissionProfile} disabled={disabled || choicesLoading} onChange={(event) => onChange({ ...draft, permissionProfile: event.target.value as RuntimePermissionProfileId })}>
                  {!permissionConfig ? <option value={draft.permissionProfile}>Loading runtime permission…</option> : null}
                  {(permissionConfig?.profiles ?? []).map((profile) => (
                    <option key={profile.id} value={profile.id} disabled={Boolean(profile.disabledReason)}>{profile.label} · {profile.description}</option>
                  ))}
                </select>
                <small className="scope-warning"><Icon name="shield" />Applies to every task until the local runtime restarts; restart returns to Default.</small>
              </label>
              <label className="field-label">
                <span>Delegation</span>
                <select aria-label="Delegation" value={draft.delegationPolicy} disabled={disabled || choicesLoading} onChange={(event) => onChange({ ...draft, delegationPolicy: event.target.value as DelegationPolicy })}>
                  <option value="proactive">Proactive · delegate freely</option>
                  <option value="explicit">Explicit · only when asked</option>
                  <option value="off">Off · root agent only</option>
                </select>
              </label>
            </div>
          </section>

          <section className={`form-section goal-setup-section ${draft.goalEnabled ? "enabled" : ""}`}>
            <div className="form-section-heading"><span>3</span><div><h3>Overnight Goal</h3><p>Keep pursuing the outcome across turns until complete, paused, or budget-limited.</p></div></div>
            <label className="goal-toggle">
              <input
                type="checkbox"
                aria-label="Run as an overnight Goal"
                checked={draft.goalEnabled}
                disabled={disabled}
                onChange={(event) => onChange({ ...draft, goalEnabled: event.target.checked })}
              />
              <span><strong>Run as an overnight Goal</strong><small>Starts autonomous continuation immediately after setup.</small></span>
            </label>
            {draft.goalEnabled ? (
              <label className="field-label goal-budget-field">
                <span>Token budget <em>optional</em></span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  aria-label="Token budget"
                  aria-invalid={Boolean(validation.errors.tokenBudget)}
                  value={draft.tokenBudget}
                  disabled={disabled}
                  onChange={(event) => onChange({ ...draft, tokenBudget: event.target.value })}
                  placeholder="Default · 50,000"
                />
                <small>Leave blank to use the runtime default (50,000 tokens).</small>
                {validation.errors.tokenBudget ? <small className="field-error">{validation.errors.tokenBudget}</small> : null}
              </label>
            ) : null}
          </section>
        </div>
        <footer className="modal-actions">
          <span>{choicesLoading ? "Loading model and runtime permission choices…" : !choicesReady ? "Runtime choices could not be loaded. Close and try again." : draft.goalEnabled ? "Chili will continue autonomously." : "One task starts with one turn."}</span>
          <div><button className="secondary" type="button" disabled={disabled} onClick={onClose}>Cancel</button><button className="primary create-run-button" type="submit" disabled={disabled || choicesLoading || !choicesReady || !validation.valid}>{draft.goalEnabled ? "Create & start Goal" : "Create & run"}</button></div>
        </footer>
      </form>
    </ModalFrame>
  );
}

function RenameTaskDialog({
  session,
  disabled,
  returnFocus,
  onClose,
  onSubmit,
}: {
  session: RuntimeSessionSummary;
  disabled: boolean;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onSubmit: (title: string) => void;
}) {
  const [title, setTitle] = useState(session.title ?? session.preview ?? "");
  useDialogEscape(onClose, disabled);
  return (
    <ModalFrame labelId="rename-task-title" className="compact-dialog" onClose={onClose} closeDisabled={disabled} returnFocus={returnFocus}>
      <form onSubmit={(event) => { event.preventDefault(); if (title.trim() && !disabled) onSubmit(title); }}>
        <header className="modal-heading"><div><p className="eyebrow">Task</p><h2 id="rename-task-title">Rename task</h2><p>Use a name that makes this work easy to find later.</p></div></header>
        <div className="compact-dialog-body"><label className="field-label"><span>Task title</span><input autoFocus data-modal-initial-focus="true" aria-label="New task title" value={title} maxLength={SESSION_TITLE_MAX_CHARS} disabled={disabled} onChange={(event) => setTitle(event.target.value)} /></label></div>
        <footer className="modal-actions"><span /><div><button className="secondary" type="button" disabled={disabled} onClick={onClose}>Cancel</button><button className="primary" type="submit" disabled={disabled || !title.trim()}>Save name</button></div></footer>
      </form>
    </ModalFrame>
  );
}

function ArchiveTaskDialog({
  session,
  disabled,
  archiveDisabled,
  returnFocus,
  onClose,
  onArchive,
}: {
  session: RuntimeSessionSummary;
  disabled: boolean;
  archiveDisabled: boolean;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onArchive: () => void;
}) {
  useDialogEscape(onClose, disabled);
  return (
    <ModalFrame labelId="archive-task-title" className="compact-dialog" onClose={onClose} closeDisabled={disabled} returnFocus={returnFocus}>
      <div>
        <header className="modal-heading"><div><p className="eyebrow">Archive</p><h2 id="archive-task-title">Archive task?</h2><p>{session.title || session.preview || "Untitled task"}</p></div></header>
        <div className="compact-dialog-body archive-warning"><Icon name="archive" /><p>This removes the task from Active tasks. Archived tasks remain inspectable but are read-only and cannot be restored in this milestone.</p>{archiveDisabled ? <small>Stop the running task before archiving it.</small> : null}</div>
        <footer className="modal-actions"><span /><div><button autoFocus data-modal-initial-focus="true" className="secondary" type="button" disabled={disabled} onClick={onClose}>Cancel</button><button className="danger" type="button" disabled={disabled || archiveDisabled} onClick={onArchive}>Archive task</button></div></footer>
      </div>
    </ModalFrame>
  );
}

function SessionSettingsDialog({
  config,
  models,
  disabled,
  onClose,
  onSubmit,
}: {
  config: DesktopSessionConfig;
  models: readonly RuntimeModelDescriptor[];
  disabled: boolean;
  onClose: () => void;
  onSubmit: (values: SessionSettingsValues) => void;
}) {
  const catalog = models.length > 0 ? models : config.model.models;
  const initialModelSettings = createSessionModelSettingsDraft(catalog, config.model);
  const [values, setValues] = useState<SessionSettingsValues>({
    ...initialModelSettings,
    permissionProfile: config.permission.profile,
    delegationPolicy: config.delegation.policy,
  });
  useDialogEscape(onClose, disabled);
  const reasoningLevels = availableReasoningLevels(catalog, values.modelKey);
  const serviceTiers = availableServiceTiers(catalog, values.modelKey);
  const reasoningProviderDefaultSelectable = canSelectProviderDefault(config.model.reasoningLevel);
  const serviceTierProviderDefaultSelectable = canSelectProviderDefault(config.model.serviceTier);
  const settingsValidation = validateSessionModelSettingsDraft(values, catalog, config.model);
  const settingsValid = settingsValidation.valid;
  return (
    <ModalFrame labelId="session-settings-title" className="settings-dialog" onClose={onClose} closeDisabled={disabled}>
      <form onSubmit={(event) => { event.preventDefault(); if (!disabled && settingsValid) onSubmit(values); }}>
        <header className="modal-heading"><div><p className="eyebrow">Runtime</p><h2 id="session-settings-title">Task runtime settings</h2><p>Changes apply to the next turn. Permission profile is shared by the runtime.</p></div><button className="icon-button" type="button" aria-label="Close task runtime settings" disabled={disabled} onClick={onClose}><Icon name="close" /></button></header>
        <div className="modal-scroll settings-grid">
          <label className="field-label field-wide"><span>Model</span><select autoFocus data-modal-initial-focus="true" aria-label="Task model" value={values.modelKey} disabled={disabled} onChange={(event) => {
            const nextKey = event.target.value;
            setValues((current) => ({
              ...current,
              ...reconcileSessionModelSettingsModel(current, catalog, nextKey),
            }));
          }}>{catalog.map((model) => <option key={modelKey(model)} value={modelKey(model)} disabled={model.available === false}>{model.displayName ?? model.model} · {model.providerDisplayName ?? model.provider}</option>)}</select></label>
          <label className="field-label"><span>Reasoning</span><select aria-label="Task reasoning" value={values.reasoningLevel} disabled={disabled || reasoningLevels.length === 0} onChange={(event) => setValues({ ...values, reasoningLevel: event.target.value as ReasoningSelection })}><option value="" disabled={!reasoningProviderDefaultSelectable}>Provider default</option>{reasoningLevels.map((level) => <option key={level} value={level}>{reasoningLabel(level)}</option>)}</select>{reasoningLevels.length === 0 ? <small>This provider does not expose configurable reasoning.</small> : null}{settingsValidation.errors.reasoningLevel ? <small className="field-error">{settingsValidation.errors.reasoningLevel}</small> : null}</label>
          <label className="field-label"><span>Service tier</span><select aria-label="Task service tier" value={values.serviceTier} disabled={disabled || serviceTiers.length === 0} onChange={(event) => setValues({ ...values, serviceTier: event.target.value as ServiceTierSelection })}><option value="" disabled={!serviceTierProviderDefaultSelectable}>Provider default</option>{serviceTiers.map((tier) => <option key={tier} value={tier}>{humanizeStatus(tier)}</option>)}</select>{serviceTiers.length === 0 ? <small>This provider does not expose a configurable service tier.</small> : null}{settingsValidation.errors.serviceTier ? <small className="field-error">{settingsValidation.errors.serviceTier}</small> : null}</label>
          <label className="field-label"><span>Runtime permission profile</span><select aria-label="Task permission profile" value={values.permissionProfile} disabled={disabled} onChange={(event) => setValues({ ...values, permissionProfile: event.target.value as RuntimePermissionProfileId })}>{config.permission.profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={Boolean(profile.disabledReason)}>{profile.label}</option>)}</select><small className="scope-warning"><Icon name="shield" />Applies to every task until restart; restart returns to Default.</small></label>
          <label className="field-label"><span>Delegation</span><select aria-label="Task delegation" value={values.delegationPolicy} disabled={disabled} onChange={(event) => setValues({ ...values, delegationPolicy: event.target.value as DelegationPolicy })}><option value="proactive">Proactive</option><option value="explicit">Explicit only</option><option value="off">Off</option></select></label>
        </div>
        <footer className="modal-actions"><span>{settingsValid ? "Settings are validated before crossing the renderer boundary." : "Choose an available model before saving."}</span><div><button className="secondary" type="button" disabled={disabled} onClick={onClose}>Cancel</button><button className="primary" type="submit" disabled={disabled || !settingsValid}>Save settings</button></div></footer>
      </form>
    </ModalFrame>
  );
}

function GoalSetupDialog({
  defaultObjective,
  disabled,
  onClose,
  onSubmit,
}: {
  defaultObjective: string;
  disabled: boolean;
  onClose: () => void;
  onSubmit: (objective: string, tokenBudget?: number) => void;
}) {
  const [objective, setObjective] = useState(defaultObjective);
  const [budget, setBudget] = useState("");
  useDialogEscape(onClose, disabled);
  const budgetValid = !budget || (/^\d+$/.test(budget) && Number(budget) > 0 && Number.isSafeInteger(Number(budget)));
  return (
    <ModalFrame labelId="add-goal-title" className="compact-dialog goal-dialog" onClose={onClose} closeDisabled={disabled}>
      <form onSubmit={(event) => { event.preventDefault(); if (objective.trim() && budgetValid && !disabled) onSubmit(objective.trim(), budget ? Number(budget) : undefined); }}>
        <header className="modal-heading"><div><p className="eyebrow">Autonomous work</p><h2 id="add-goal-title">Add Goal</h2><p>The Goal starts immediately and continues across turns.</p></div></header>
        <div className="compact-dialog-body"><label className="field-label"><span>Goal objective</span><textarea autoFocus data-modal-initial-focus="true" aria-label="Goal objective" rows={4} value={objective} disabled={disabled} onChange={(event) => setObjective(event.target.value)} /></label><label className="field-label"><span>Token budget <em>optional</em></span><input type="number" min="1" step="1" aria-label="Goal token budget" aria-invalid={!budgetValid} value={budget} disabled={disabled} onChange={(event) => setBudget(event.target.value)} placeholder="Default · 50,000" />{!budgetValid ? <small className="field-error">Token budget must be a positive whole number.</small> : <small>Leave blank to use the runtime default (50,000 tokens).</small>}</label></div>
        <footer className="modal-actions"><span>Monitor or pause it from the Workbench.</span><div><button className="secondary" type="button" disabled={disabled} onClick={onClose}>Cancel</button><button className="primary" type="submit" disabled={disabled || !objective.trim() || !budgetValid}>Start Goal</button></div></footer>
      </form>
    </ModalFrame>
  );
}

function GoalBudgetDialog({
  goal,
  disabled,
  onClose,
  onSubmit,
}: {
  goal: SessionGoal;
  disabled: boolean;
  onClose: () => void;
  onSubmit: (tokenBudget: number) => void;
}) {
  const minimum = goalResumeBudgetMinimum(goal);
  const [budget, setBudget] = useState(String(Math.max(minimum, Math.ceil(minimum * 1.25))));
  const parsed = Number(budget);
  const valid = /^\d+$/.test(budget) && Number.isSafeInteger(parsed) && parsed >= minimum;
  useDialogEscape(onClose, disabled);
  return (
    <ModalFrame labelId="raise-goal-budget-title" className="compact-dialog goal-dialog" onClose={onClose} closeDisabled={disabled}>
      <form onSubmit={(event) => { event.preventDefault(); if (valid && !disabled) onSubmit(parsed); }}>
        <header className="modal-heading"><div><p className="eyebrow">Budget limited</p><h2 id="raise-goal-budget-title">Raise budget to resume</h2><p>This Goal used {formatTokenCount(goal.tokensUsed)} tokens. Its budget must increase before it can continue.</p></div></header>
        <div className="compact-dialog-body"><label className="field-label"><span>New token budget</span><input autoFocus data-modal-initial-focus="true" type="number" min={minimum} step="1" aria-label="New Goal token budget" aria-invalid={!valid} value={budget} disabled={disabled} onChange={(event) => setBudget(event.target.value)} />{valid ? <small>Minimum {formatTokenCount(minimum)} tokens.</small> : <small className="field-error">Enter at least {formatTokenCount(minimum)} tokens.</small>}</label></div>
        <footer className="modal-actions"><span>The Goal resumes only after the new budget is accepted.</span><div><button className="secondary" type="button" disabled={disabled} onClick={onClose}>Cancel</button><button className="primary" type="submit" disabled={disabled || !valid}>Update & resume Goal</button></div></footer>
      </form>
    </ModalFrame>
  );
}

function ModalFrame({
  labelId,
  className,
  onClose,
  closeDisabled,
  returnFocus,
  children,
}: {
  labelId: string;
  className: string;
  onClose: () => void;
  closeDisabled: boolean;
  returnFocus?: HTMLElement | null;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    returnFocus ?? (typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null),
  );

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = modalFocusables(dialog);
    const initialFocus = dialog.querySelector<HTMLElement>("[data-modal-initial-focus]") ?? focusables[0] ?? dialog;
    if (!dialog.contains(document.activeElement)) initialFocus.focus();

    const appShell = document.querySelector<HTMLElement>(".app-shell");
    const previousInert = appShell?.inert ?? false;
    const previousAriaHidden = appShell ? appShell.getAttribute("aria-hidden") : null;
    if (appShell) {
      appShell.inert = true;
      appShell.setAttribute("aria-hidden", "true");
    }

    return () => {
      if (appShell) {
        appShell.inert = previousInert;
        if (previousAriaHidden === null) appShell.removeAttribute("aria-hidden");
        else appShell.setAttribute("aria-hidden", previousAriaHidden);
      }
      const preferred = returnFocusRef.current;
      window.requestAnimationFrame(() => {
        if (preferred && canRestoreFocus(preferred)) {
          preferred.focus();
          return;
        }
        document.querySelector<HTMLElement>("[data-dialog-fallback-focus]")?.focus();
      });
    };
  }, []);

  const modal = (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => { if (!closeDisabled && event.target === event.currentTarget) onClose(); }}>
      <section
        ref={dialogRef}
        className={`modal-card ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const dialog = event.currentTarget;
          const focusables = modalFocusables(dialog);
          const currentIndex = focusables.indexOf(document.activeElement as HTMLElement);
          const targetIndex = trappedTabTarget(currentIndex, focusables.length, event.shiftKey);
          if (targetIndex === undefined) return;
          event.preventDefault();
          (focusables[targetIndex] ?? dialog).focus();
        }}
      >{children}</section>
    </div>
  );
  return createPortal(modal, document.body);
}

const MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function modalFocusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR))
    .filter((element) => canRestoreFocus(element));
}

function menuItems(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'));
}

function canRestoreFocus(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(":disabled") || element.closest("[inert]")) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function GoalCard({
  goal,
  disabled,
  busy,
  onStatus,
  onRaiseBudget,
  onClear,
}: {
  goal: SessionGoal;
  disabled: boolean;
  busy: boolean;
  onStatus: (status: SessionGoalStatus) => void;
  onRaiseBudget: () => void;
  onClear: () => void;
}) {
  const progress = goalProgress(goal.tokensUsed, goal.tokenBudget);
  return (
    <div className="goal-card">
      <p>{goal.objective}</p>
      <div className="goal-metrics"><span>{formatTokenCount(goal.tokensUsed)} tokens</span><span>{formatGoalTime(goal.timeUsedSeconds)}</span></div>
      {progress !== undefined ? (
        <div className="goal-progress-row"><div className="goal-progress" role="progressbar" aria-label="Goal token budget used" aria-valuemin={0} aria-valuemax={goal.tokenBudget} aria-valuenow={goal.tokensUsed}><span style={{ width: `${progress * 100}%` }} /></div><small>{Math.round(progress * 100)}%</small></div>
      ) : <small className="goal-unlimited">Runtime default budget · 50,000 tokens</small>}
      <div className="goal-actions">
        {goal.status === "active" ? <button className="secondary" disabled={disabled} onClick={() => onStatus("paused")}><Icon name="pause" />Pause Goal</button> : null}
        {goal.status === "paused" ? <button className="primary" disabled={disabled || busy} onClick={() => onStatus("active")}><Icon name="resume" />Resume Goal</button> : null}
        {goal.status === "budgetLimited" ? <button className="primary" disabled={disabled || busy} onClick={onRaiseBudget}><Icon name="budget" />Raise budget to resume</button> : null}
        <button className="text-button danger-text" disabled={disabled || busy} onClick={onClear}>Clear Goal</button>
      </div>
    </div>
  );
}

function useDialogEscape(close: () => void, disabled: boolean): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || disabled) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close, disabled]);
}

function TimelineItem({ item }: { item: DesktopTimelineItem }) {
  if (item.kind === "work") return <WorkSummary item={item} />;
  return (
    <article className={`timeline-item message message-${item.role}`}>
      <div className="message-content">
        <div className="message-body">{item.parts.map((part) => <MessagePart key={part.id} part={part} />)}</div>
      </div>
    </article>
  );
}

function WorkSummary({ item }: { item: DesktopWorkItem }) {
  const [open, setOpen] = useState(item.active);
  const wasActive = useRef(item.active);

  useEffect(() => {
    if (item.active) setOpen(true);
    else if (wasActive.current) setOpen(false);
    wasActive.current = item.active;
  }, [item.active]);

  const elapsed = Math.max(0, item.updatedAt - item.startedAt);
  const label = item.active
    ? "Working"
    : elapsed >= 1_000
      ? `Worked for ${formatWorkDuration(elapsed)}`
      : "Worked";

  return (
    <details
      className={`timeline-item work-summary ${item.active ? "active" : ""} ${item.failureCount > 0 ? "has-failure" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="work-indicator" aria-hidden="true" />
        <span aria-live={item.active ? "polite" : undefined}>{label}</span>
        {item.failureCount > 0 ? <span className="work-failure">{item.failureCount} issue{item.failureCount === 1 ? "" : "s"}</span> : null}
      </summary>
      <div className="work-details">
        {item.items.map((detail, index) => (
          <WorkDetail key={`${detail.kind}:${detail.id}:${index}`} item={detail} />
        ))}
      </div>
    </details>
  );
}

function WorkDetail({ item }: { item: ChatTranscriptItem }) {
  if (item.kind === "message") {
    return (
      <div className="work-note">
        {item.parts.map((part) => <MessagePart key={part.id} part={part} compact />)}
      </div>
    );
  }

  if (item.kind === "tool") {
    const liveOutput = visibleToolLiveOutput(item.output, item.liveOutput);
    const hasOutput = Boolean(liveOutput || item.output || item.error);
    const showStatus = item.displayStatus !== "succeeded";
    return (
      <div className={`work-tool-row tool-${item.displayStatus}`}>
        <span className="work-tool-dot" aria-hidden="true" />
        <div className="work-tool-copy">
          <strong>{humanizeToolTitle(item.inputSummary.title || item.toolName)}</strong>
          {item.inputSummary.detail ? <span title={item.inputSummary.detail}>{item.inputSummary.detail}</span> : null}
        </div>
        {showStatus ? <span className="work-tool-status">{humanizeStatus(item.displayStatus)}</span> : null}
        {hasOutput ? (
          <details className="tool-details">
            <summary>{item.error ? "View error" : liveOutput ? "Live output" : "View result"}</summary>
            {liveOutput ? <pre className="tool-live-output">{liveOutput}</pre> : null}
            {item.output ? <pre>{item.output}</pre> : null}
            {item.error ? <pre className="tool-error">{item.error}</pre> : null}
          </details>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`work-tool-row work-approval-row approval-${item.status}`}>
      <span className="work-tool-dot" aria-hidden="true" />
      <div className="work-tool-copy">
        <strong>{item.status === "pending" ? "Requested approval" : "Approval"}</strong>
        <span>{item.patterns.join(", ") || item.permission}</span>
      </div>
      {item.status === "pending" ? <span className="work-tool-status">Waiting</span> : null}
      {item.status === "resolved" && item.decision === "deny" ? <span className="work-tool-status">Denied</span> : null}
    </div>
  );
}

export function MessagePart({ part, compact = false }: { part: ChatMessagePart; compact?: boolean }) {
  if (part.type === "text") return <MarkdownText text={part.text} compact={compact} />;
  if (part.type === "reasoning") return <details><summary>Reasoning</summary><MarkdownText text={part.text} compact /></details>;
  if (part.type === "summary") return <div className="summary-part"><MarkdownText text={part.text} compact /></div>;
  if (part.type === "image") return <p className="attachment">Image · {part.filename ?? part.mimeType}</p>;
  if (part.type === "tool_call") {
    const status = part.displayStatus ?? part.status;
    return <p className="inline-tool">{humanizeToolTitle(part.toolName)}{status === "succeeded" || status === "completed" ? "" : ` · ${humanizeStatus(status)}`}</p>;
  }
  const result = part.error ?? part.output;
  if (!result.trim()) return null;
  return (
    <details className="tool-details inline-tool-result">
      <summary>{part.error ? "Tool error" : "Tool result"}</summary>
      <pre className={part.error ? "tool-error" : ""}>{result}</pre>
    </details>
  );
}

export function MarkdownText({ text, compact = false }: { text: string; compact?: boolean }) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const language = fence[1]?.trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <div className="markdown-code" key={`code:${index}`}>
          {language ? <span>{language}</span> : null}
          <pre><code>{body.join("\n")}</code></pre>
        </div>,
      );
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]?.length ?? 3;
      const content = inlineMarkdown(heading[2] ?? "", `heading:${index}`);
      blocks.push(level === 1
        ? <h2 key={`heading:${index}`}>{content}</h2>
        : level === 2
          ? <h3 key={`heading:${index}`}>{content}</h3>
          : <h4 key={`heading:${index}`}>{content}</h4>);
      index += 1;
      continue;
    }

    if (/^\s*[-*_](?:\s*[-*_]){2,}\s*$/.test(line)) {
      blocks.push(<hr key={`rule:${index}`} />);
      index += 1;
      continue;
    }

    if (isMarkdownTable(lines, index)) {
      const headers = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        rows.push(tableCells(lines[index] ?? ""));
        index += 1;
      }
      blocks.push(
        <div className="markdown-table-wrap" key={`table:${index}`}>
          <table>
            <thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{inlineMarkdown(cell, `th:${index}:${cellIndex}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inlineMarkdown(row[cellIndex] ?? "", `td:${index}:${rowIndex}:${cellIndex}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^\s*[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(item[1] ?? "");
        index += 1;
      }
      blocks.push(<ul key={`list:${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, `li:${index}:${itemIndex}`)}</li>)}</ul>);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^\s*\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(item[1] ?? "");
        index += 1;
      }
      blocks.push(<ol key={`list:${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, `li:${index}:${itemIndex}`)}</li>)}</ol>);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(<blockquote key={`quote:${index}`}>{inlineMarkdownLines(quote, `quote:${index}`)}</blockquote>);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() && !isMarkdownBlockStart(lines, index)) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(<p key={`paragraph:${index}`}>{inlineMarkdownLines(paragraph, `paragraph:${index}`)}</p>);
  }

  return <div className={compact ? "markdown markdown-compact" : "markdown"}>{blocks}</div>;
}

function isMarkdownBlockStart(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  return /^\s*```/.test(line)
    || /^\s*#{1,6}\s+/.test(line)
    || /^\s*[-*+]\s+/.test(line)
    || /^\s*\d+[.)]\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*[-*_](?:\s*[-*_]){2,}\s*$/.test(line)
    || isMarkdownTable(lines, index);
}

function isMarkdownTable(lines: readonly string[], index: number): boolean {
  const header = lines[index] ?? "";
  const divider = lines[index + 1] ?? "";
  return header.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(divider);
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function inlineMarkdownLines(lines: readonly string[], keyPrefix: string): ReactNode[] {
  return lines.flatMap((line, index) => [
    ...(index > 0 ? [<br key={`${keyPrefix}:br:${index}`} />] : []),
    ...inlineMarkdown(line, `${keyPrefix}:${index}`),
  ]);
}

function inlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}:${match.index}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
      nodes.push(link
        ? <a key={key} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>
        : token);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
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
            aria-label={`Custom answer for ${question.header}`}
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

type IconName = "activity" | "archive" | "budget" | "chevron" | "close" | "folder" | "message" | "more"
  | "appearance" | "pause" | "plus" | "queue" | "resume" | "search" | "send" | "settings" | "shield" | "sidebar"
  | "steer" | "stop" | "terminal";

function ChiliMark() {
  return (
    <svg className="chili-mark" viewBox="0 0 32 32" aria-hidden="true">
      <path className="chili-stem" d="M20.4 9.2c.1-2.6 1.7-4.6 4-5.1 1-.2 1.7.9.9 1.7-1.5 1.5-1.8 3.2-.9 5-1.5.1-2.8-.5-4-1.6Z" />
      <path className="chili-body" d="M21.2 8c4.1 1.2 6 5.1 4.4 9.5-2.3 6.5-9.3 10.9-18.3 10.2-1.7-.1-2.1-1.5-.6-2.4 5.2-3 6.6-8 8.4-11.9 1.5-3.4 3.5-5.3 6.1-5.4Z" />
      <path className="chili-shade" d="M24.5 14.1c-.5 3-2.7 6-5.9 8.2-2.9 2.1-6.7 3.4-10.8 3.6 7.7.5 13.7-3.1 16.2-8.4.6-1.1.8-2.3.5-3.4Z" />
      <path className="chili-leaf" d="M17.9 9.1c1.9 1.7 4.3 2.1 6.8 1.2-.9 2-3 3.2-5.3 2.8-1-.2-1.8-.7-2.4-1.3.3-1.1.6-2 .9-2.7Z" />
    </svg>
  );
}

function Icon({ name }: { name: IconName }) {
  const path = (() => {
    switch (name) {
      case "sidebar": return <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 3v18" /></>;
      case "activity": return <><path d="M4 12h3l2-5 4 10 2-5h5" /><path d="M4 4v16h16" /></>;
      case "archive": return <><path d="M4 7h16v13H4V7Zm-1-3h18v4H3V4Z" /><path d="M9 12h6" /></>;
      case "budget": return <><circle cx="12" cy="12" r="8" /><path d="M12 7v10M9 9.5c0-1.2 1.2-2 3-2s3 .8 3 2-1.2 2-3 2-3 .8-3 2 1.2 2 3 2 3-.8 3-2" /></>;
      case "plus": return <path d="M12 5v14M5 12h14" />;
      case "message": return <path d="M5 5h14v10H9l-4 4V5Z" />;
      case "more": return <><circle cx="6" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1" fill="currentColor" stroke="none" /></>;
      case "folder": return <path d="M3.5 7.5h7l2-2h8v13h-17v-11Z" />;
      case "chevron": return <path d="m9 6 6 6-6 6" />;
      case "close": return <path d="m7 7 10 10M17 7 7 17" />;
      case "stop": return <rect x="7" y="7" width="10" height="10" rx="2" />;
      case "pause": return <><path d="M9 7v10M15 7v10" /></>;
      case "resume": return <><path d="M7 5v14l11-7-11-7Z" /></>;
      case "search": return <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 4 4" /></>;
      case "appearance": return <><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" /></>;
      case "settings": return <><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>;
      case "steer": return <path d="M5 18c0-4 2-6 6-6h8M15 8l4 4-4 4M5 6v4" />;
      case "queue": return <><path d="M5 7h14M5 12h9M5 17h6" /><path d="m16 15 3 3-3 3" /></>;
      case "send": return <path d="m5 12 14-7-4 14-3-6-7-1Zm7 1 7-8" />;
      case "terminal": return <><path d="m5 7 4 4-4 4M11 17h7" /><rect x="3" y="4" width="18" height="16" rx="3" /></>;
      case "shield": return <path d="M12 3 5 6v5c0 4.8 2.6 8 7 10 4.4-2 7-5.2 7-10V6l-7-3Zm-3 9 2 2 4-5" />;
    }
  })();
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{path}</svg>;
}

function shortId(value: string): string {
  if (!value) return "root";
  return value.length <= 12 ? value : value.slice(-10);
}

function workspaceLabel(value: string | undefined): string {
  if (!value) return "No project";
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function formatRelativeTime(value: number): string {
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

function formatWorkDuration(value: number): string {
  const seconds = Math.max(1, Math.round(value / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatGoalTime(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s active`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m active`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h${remainder ? ` ${remainder}m` : ""} active`;
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function goalStatusLabel(status: SessionGoalStatus): string {
  return status === "budgetLimited" ? "budget limited" : status;
}

function reasoningLabel(level: ReasoningLevel): string {
  return level === "off" ? "Off" : `${humanizeStatus(level)}${level === "high" ? " · recommended" : ""}`;
}

function createFailureMessage(result: DesktopCreateSessionResult): string {
  const failure = result.failure;
  if (!failure) return "Task setup did not complete.";
  if (result.startState === "unknown") {
    return `Task creation reached ${failure.stage.replaceAll("_", " ")}, but Chili could not confirm whether launch committed: ${failure.message}. Inspect the retained task before retrying to avoid a duplicate start.`;
  }
  const recovery = failure.permissionRestored
    ? " The runtime permission profile was restored."
    : result.startState === "not_started"
      ? " The task was retained but did not start."
      : " The created task was kept so you can recover it.";
  return `Task setup stopped at ${failure.stage.replaceAll("_", " ")}: ${failure.message}.${recovery}`;
}

function humanizeToolTitle(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "read" || normalized === "read_file") return "Read";
  if (normalized === "write" || normalized === "write_file") return "Wrote file";
  if (normalized === "edit" || normalized === "replace") return "Edited file";
  if (normalized === "apply_patch") return "Edited files";
  if (normalized === "bash" || normalized === "run_shell_command" || normalized === "exec_command") return "Ran command";
  if (normalized === "grep" || normalized === "glob" || normalized === "search") return "Searched";
  if (normalized === "web_search" || normalized === "search_query") return "Searched the web";
  const readable = value.trim().replace(/^mcp__[^_]+__/, "").replaceAll(/[_./:-]+/g, " ").replaceAll(/\s+/g, " ");
  return readable ? `${readable[0]?.toUpperCase() ?? ""}${readable.slice(1)}` : "Used tool";
}

function humanizeStatus(value: string): string {
  const readable = value.replaceAll("_", " ");
  return `${readable[0]?.toUpperCase() ?? ""}${readable.slice(1)}`;
}

function refreshesDiff(event: ChiliEvent): boolean {
  return event.type === "tool.call_finished"
    || event.type === "snapshot.reverted"
    || event.type === "turn.completed"
    || event.type === "turn.compaction_completed"
    || event.type === "turn.compaction_failed"
    || event.type === "session.status_changed";
}

function refreshesSessionConfig(event: ChiliEvent): boolean {
  return event.type === "session.model_changed"
    || event.type === "session.reasoning_changed"
    || event.type === "session.service_tier_changed"
    || event.type === "session.delegation_changed"
    || event.type === "goal.updated"
    || event.type === "goal.cleared"
    || event.type.startsWith("mcp.");
}

function applyDesktopFrames(
  projection: DesktopProjection,
  frames: readonly SequencedProjectionFrame<DesktopEvent>[],
): DesktopProjection {
  return frames.reduce((current, input) => {
    const frame = input.frame;
    if (!eventMatchesProject(frame, current.state.projectId)) return current;
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
